import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LibraryService } from "../src/asset-library/host/service.ts";
import { LibraryDB } from "../src/asset-library/host/storage.ts";
import {
  exportArchive,
  importArchive,
} from "../src/asset-library/host/archive.ts";
import { Objects } from "../src/asset-library/host/objects.ts";
import {
  searchInput,
  endpoints,
  type Asset,
} from "../src/asset-library/shared/contracts.ts";

const credentials = {
  readLegacyKey: async () => undefined,
};

test("canvas files and library assets share the same collection memberships", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-save-media-"));
  const service = new LibraryService(join(root, "config"), credentials);
  try {
    await service.init();
    const { id } = await service.library({
      action: "create",
      path: join(root, "library"),
      name: "素材",
    });
    const libraryId = id!;
    await service.collection({ action: "create", libraryId, name: "封面" });
    const folder = (await service.snapshot()).collections.find((c) => c.name === "封面")!;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxoAAAAASUVORK5CYII=",
      "base64",
    );
    const path = join(root, "media");
    await writeFile(path, bytes);
    const file = { libraryId, path, name: "封面", size: bytes.length, mime: "image/png" };
    const signal = new AbortController().signal;
    await assert.rejects(
      service.importCanvasFile({ ...file, collectionId: "missing" }, signal),
      /收藏夹不存在/,
    );
    assert.equal((await service.snapshot()).libraries[0]?.count, 0);
    const saved = await service.importCanvasFile(file, signal);
    const duplicate = await service.importCanvasFile({ ...file, collectionId: folder.id }, signal);
    assert.deepEqual(duplicate, { assetId: saved.assetId, duplicate: true });
    const defaultFolder = (await service.snapshot()).collections.find((c) => c.isDefault)!;
    await service.editBatch({
      libraryId,
      changes: [{ id: saved.assetId, addCollections: [defaultFolder.id] }],
    }, signal);
    const asset = service.assetMetadata(libraryId, saved.assetId);
    assert.equal(asset.name, "封面.png");
    assert.deepEqual(new Set(asset.collectionIds), new Set([folder.id, defaultFolder.id]));
    assert.equal((await service.snapshot()).libraries[0]?.count, 1);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("flat collections retain v4 IDs, duplicate names, memberships and ZIP round trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-collections-"));
  const service = new LibraryService(join(root, "config"), credentials);
  try {
    await service.init();
    const path = join(root, "library");
    const { id } = await service.library({
      action: "create",
      path,
      name: "素材",
    });
    const libraryId = id!;
    await service.library({ action: "close", id: libraryId });
    const assetId = randomUUID();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxoAAAAASUVORK5CYII=",
      "base64",
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const relativePath = `originals/${hash}.png`;
    await writeFile(join(path, relativePath), bytes);
    const asset: Asset = {
      id: assetId,
      libraryId,
      name: "人物.png",
      kind: "image",
      mime: "image/png",
      size: bytes.length,
      relativePath,
      tags: ["人物"],
      notes: "保留备注",
      favorite: true,
      collectionIds: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
      createdAt: new Date().toISOString(),
      status: "ready",
      duration: null,
      thumbnail: null,
    };
    const raw = new DatabaseSync(join(path, "library.sqlite"));
    raw.exec(`PRAGMA foreign_keys=OFF;
      CREATE TABLE legacy(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,parent_id TEXT);
      INSERT INTO legacy SELECT id,name,created_at,is_default,NULL FROM collections;
      DROP TABLE collections; ALTER TABLE legacy RENAME TO collections;
      CREATE UNIQUE INDEX sibling_folder_names ON collections(coalesce(parent_id,''),name);
      CREATE UNIQUE INDEX one_default_collection ON collections(is_default) WHERE is_default=1;
      PRAGMA user_version=4;`);
    const insert = raw.prepare("INSERT INTO collections VALUES(?,?,?,0,?)");
    insert.run(
      "00000000-0000-4000-8000-000000000001",
      "角色",
      "2026-01-01",
      null,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000002",
      "参考",
      "2026-01-02",
      "00000000-0000-4000-8000-000000000001",
    );
    insert.run(
      "00000000-0000-4000-8000-000000000003",
      "参考",
      "2026-01-03",
      null,
    );
    insert.run(
      "00000000-0000-4000-8000-000000000004",
      "参考 (2)",
      "2026-01-04",
      null,
    );
    raw
      .prepare("INSERT INTO assets VALUES(?,?,?)")
      .run(assetId, hash, JSON.stringify(asset));
    for (const collectionId of asset.collectionIds)
      raw
        .prepare("INSERT INTO collection_assets VALUES(?,?)")
        .run(collectionId, assetId);
    raw.close();
    await service.library({ action: "open", path });
    const collections = (await service.snapshot()).collections;
    assert.equal(
      collections.find((c) => c.id === "00000000-0000-4000-8000-000000000003")
        ?.name,
      "参考",
    );
    assert.equal(
      collections.find((c) => c.id === "00000000-0000-4000-8000-000000000002")
        ?.name,
      "参考 (3)",
    );
    assert.ok(collections.every((c) => !("parentId" in c)));
    assert.deepEqual(
      new Set(service.assetMetadata(libraryId, assetId).collectionIds),
      new Set([
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]),
    );
    await assert.rejects(
      service.collection({ libraryId, action: "create", name: "参考" }),
      /同名/,
    );
    await service.collection({
      libraryId,
      action: "rename",
      id: "00000000-0000-4000-8000-000000000002",
      name: "人物参考",
    });
    await service.collection({ libraryId, action: "create", name: "场景" });
    const scene = (await service.snapshot()).collections.find(
      (c) => c.name === "场景",
    )!;
    await service.editAsset({
      libraryId,
      id: assetId,
      addCollections: [scene.id, scene.id],
    });
    await assert.rejects(
      service.editAsset({
        libraryId,
        id: assetId,
        notes: "不能写入",
        addCollections: ["missing"],
      }),
      /不存在/,
    );
    assert.equal(service.assetMetadata(libraryId, assetId).notes, "保留备注");
    await service.setCollections({
      libraryId,
      id: assetId,
      collectionIds: ["00000000-0000-4000-8000-000000000002"],
    });
    const search = (collectionId?: string) =>
      service.search(
        searchInput.parse({ libraryId, collectionId, query: "" }),
        AbortSignal.timeout(5000),
      );
    assert.equal(
      (await search("00000000-0000-4000-8000-000000000001")).total,
      0,
      "旧父级不再隐式包含子级",
    );
    assert.equal(
      (await search("00000000-0000-4000-8000-000000000002")).total,
      1,
    );
    assert.equal((await search("missing")).total, 0);
    assert.equal((await search()).total, 1);
    await service.setCollections({
      libraryId,
      id: assetId,
      collectionIds: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
    });
    await service.library({ action: "close", id: libraryId });
    const db = await LibraryDB.open(path);
    const exported = join(root, "exports");
    await mkdir(exported);
    let zip: string;
    try {
      assert.equal(db.db.prepare("PRAGMA user_version").get()?.user_version, 5);
      assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.ok(
        !db.db
          .prepare("PRAGMA table_info(collections)")
          .all()
          .some((c) => c.name === "parent_id"),
      );
      zip = await exportArchive(
        db,
        new Objects(db.root, db.id, db.storage),
        exported,
        join(root, "scratch"),
        AbortSignal.timeout(30000),
        () => {},
      );
    } finally {
      await db.close();
    }
    const imported = join(root, "imported");
    await importArchive(
      zip!,
      imported,
      { mode: "local" },
      AbortSignal.timeout(30000),
      () => {},
      "test-operation",
    );
    const restored = await LibraryDB.open(imported);
    try {
      assert.equal(
        restored
          .collections()
          .find((c) => c.id === "00000000-0000-4000-8000-000000000002")?.name,
        "人物参考",
      );
      assert.deepEqual(
        new Set(restored.asset(assetId).collectionIds),
        new Set([
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ]),
      );
      assert.equal(restored.asset(assetId).notes, "保留备注");
      assert.deepEqual(await readFile(join(imported, relativePath)), bytes);
    } finally {
      await restored.close();
    }
    await service.library({ action: "open", path });
    await service.collection({
      libraryId,
      id: "00000000-0000-4000-8000-000000000001",
      action: "delete",
    });
    assert.deepEqual(service.assetMetadata(libraryId, assetId).collectionIds, [
      "00000000-0000-4000-8000-000000000002",
    ]);
    assert.deepEqual(await readFile(join(path, relativePath)), bytes);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 collections upgrade directly to flat collections with IDs intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-collections-v3-"));
  try {
    const path = join(root, "library");
    const db = await LibraryDB.open(path, "素材");
    const original = db.collections();
    await db.close();
    const raw = new DatabaseSync(join(path, "library.sqlite"));
    raw.exec("PRAGMA user_version=3");
    raw.close();
    const migrated = await LibraryDB.open(path);
    try {
      assert.deepEqual(migrated.collections(), original);
      assert.equal(
        migrated.db.prepare("PRAGMA user_version").get()?.user_version,
        5,
      );
    } finally {
      await migrated.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collection RPC rejects hierarchy operations instead of silently ignoring them", () => {
  const input = endpoints.collection.input;
  assert.equal(
    input.safeParse({
      libraryId: "a",
      action: "create",
      name: "收藏",
      parentId: "parent",
    }).success,
    false,
  );
  assert.equal(
    input.safeParse({ libraryId: "a", action: "move", id: "b" }).success,
    false,
  );
});

test("old nested ZIP imports flatten duplicate names and preserve collection IDs", async () => {
  const { ZipFile } = await import("yazl");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const root = await mkdtemp(join(tmpdir(), "creative-zip-v2-"));
  try {
    const parent = randomUUID(),
      child = randomUUID(),
      sibling = randomUUID();
    const catalog = {
      format: "dsh-asset-library-zip",
      version: 2,
      name: "Legacy",
      assets: [],
      vectors: [],
      files: [],
      collections: [
        {
          id: parent,
          name: "References",
          created_at: "2026-01-01",
          is_default: 0,
          parent_id: null,
        },
        {
          id: child,
          name: "References",
          created_at: "2026-01-02",
          is_default: 0,
          parent_id: parent,
        },
        {
          id: sibling,
          name: "References (2)",
          created_at: "2026-01-03",
          is_default: 0,
          parent_id: null,
        },
      ],
    };
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(catalog)), "catalog.json");
    const source = join(root, "legacy.zip");
    const written = pipeline(zip.outputStream, createWriteStream(source));
    zip.end();
    await written;
    const target = join(root, "imported");
    await importArchive(
      source,
      target,
      { mode: "local" },
      AbortSignal.timeout(30000),
      () => {},
      "legacy-test",
    );
    const db = await LibraryDB.open(target);
    try {
      assert.equal(
        db.collections().find((c) => c.id === parent)?.name,
        "References",
      );
      assert.equal(
        db.collections().find((c) => c.id === child)?.name,
        "References (3)",
      );
      assert.equal(
        db.collections().find((c) => c.id === sibling)?.name,
        "References (2)",
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
