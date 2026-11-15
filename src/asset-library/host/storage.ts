import { flattenCollectionNames } from "./collections.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve, join, relative, isAbsolute } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  readdir,
  open,
  unlink,
  lstat,
} from "node:fs/promises";
import type { Asset, Task, Library } from "../shared/contracts.ts";
import { storageSchema, type Storage } from "../shared/contracts.ts";

export async function atomicJSON(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export function safePath(root: string, path: string) {
  const target = resolve(root, path),
    rel = relative(root, target);
  if (isAbsolute(path) || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("库内路径不合法");
  return target;
}
export const now = () => new Date().toISOString();
export class LibraryDB {
  readonly db: DatabaseSync;
  private constructor(
    readonly root: string,
    readonly id: string,
    readonly name: string,
    private readonly lockToken: string,
    readonly storage: Storage,
  ) {
    this.db = new DatabaseSync(join(root, "library.sqlite"));
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (version > 5) {
      this.db.close();
      throw new Error("素材库由更新版本创建，请升级插件");
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,result TEXT);
      CREATE TABLE IF NOT EXISTS vectors(asset_id TEXT NOT NULL,segment INTEGER NOT NULL,fingerprint TEXT NOT NULL,start REAL,end REAL,vector TEXT NOT NULL,PRIMARY KEY(asset_id,segment,fingerprint));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,text TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_assets(collection_id TEXT NOT NULL REFERENCES collections(id),asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(collection_id,asset_id));
      `);
    if (
      !this.db
        .prepare("PRAGMA table_info(uploads)")
        .all()
        .some((c) => c.name === "prepared")
    )
      this.db.exec("ALTER TABLE uploads ADD COLUMN prepared TEXT");
    if (version < 3) {
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE collections ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
        );
        this.ensureDefaultCollection(true);
        this.db.exec(
          "CREATE UNIQUE INDEX one_default_collection ON collections(is_default) WHERE is_default=1; PRAGMA user_version=3;",
        );
      });
    }
    if (version < 4) {
      // Rebuild the name constraint while preserving folder and asset identities.
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          this.db
            .exec(`CREATE TABLE collections_v4(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0,parent_id TEXT);
            INSERT INTO collections_v4(id,name,created_at,is_default) SELECT id,name,created_at,is_default FROM collections;
            DROP TABLE collections;
            ALTER TABLE collections_v4 RENAME TO collections;
            CREATE UNIQUE INDEX one_default_collection ON collections(is_default) WHERE is_default=1;
            CREATE UNIQUE INDEX sibling_folder_names ON collections(coalesce(parent_id,''),name);
            PRAGMA user_version=4;`);
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
    }
    if (version < 5) {
      // Flatten collections without changing identities or asset memberships.
      this.db.exec("PRAGMA foreign_keys=OFF");
      try {
        this.transaction(() => {
          const rows = this.db
            .prepare(
              "SELECT id,name,created_at,is_default FROM collections ORDER BY is_default DESC,parent_id IS NULL DESC,created_at,id",
            )
            .all();
          this.db.exec(
            "CREATE TABLE collections_v5(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,is_default INTEGER NOT NULL DEFAULT 0)",
          );
          const insert = this.db.prepare(
            "INSERT INTO collections_v5 VALUES(?,?,?,?)",
          );
          for (const row of flattenCollectionNames(
            rows.map((row) => ({
              id: row.id!,
              name: String(row.name),
              created_at: row.created_at!,
              is_default: row.is_default!,
            })),
          )) {
            insert.run(row.id!, row.name, row.created_at!, row.is_default!);
          }
          this.db.exec(`DROP TABLE collections;
            ALTER TABLE collections_v5 RENAME TO collections;
            CREATE UNIQUE INDEX one_default_collection ON collections(is_default) WHERE is_default=1;
            PRAGMA user_version=5;`);
        });
      } finally {
        this.db.exec("PRAGMA foreign_keys=ON");
      }
    }
    for (const task of this.tasks()) {
      if (task.status === "running") {
        task.status = "queued";
        task.error = "上次运行中断，已从保存的阶段恢复";
        this.saveTask(task);
      }
    }
  }
  static async open(
    path: string,
    createName?: string,
    storage: Storage = { mode: "local" },
  ) {
    if (!isAbsolute(path)) throw new Error("请选择绝对文件夹路径");
    if (createName) {
      await mkdir(path, { recursive: true });
      const entries = (await readdir(path)).filter((x) => x !== ".DS_Store");
      if (entries.length) throw new Error("新建库需要空文件夹，请选择其他位置");
      await atomicJSON(join(path, "library.json"), {
        format: "dsh-asset-library",
        version: storage.mode === "s3" ? 2 : 1,
        id: randomUUID(),
        name: createName,
        storage,
      });
    }
    const root = await realpath(path);
    const manifest = JSON.parse(
      await readFile(join(root, "library.json"), "utf8"),
    );
    if (
      manifest.format !== "dsh-asset-library" ||
      ![1, 2].includes(manifest.version) ||
      typeof manifest.id !== "string" ||
      typeof manifest.name !== "string"
    )
      throw new Error("无法打开：不是受支持的素材库");
    const lock = join(root, ".library-lock"),
      token = randomUUID();
    try {
      const old = JSON.parse(await readFile(lock, "utf8"));
      if (old.host !== hostname())
        throw new Error("此库未安全关闭，请在原电脑关闭后重新迁移");
      try {
        process.kill(old.pid, 0);
        throw new Error("素材库已被其他窗口或进程打开");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await unlink(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const file = await open(lock, "wx", 0o600);
    await file.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname(), token }),
    );
    await file.close();
    try {
      for (const dir of ["originals", "previews", "staging"]) {
        await mkdir(join(root, dir), { recursive: true });
        if ((await lstat(join(root, dir))).isSymbolicLink())
          throw new Error("素材库内部目录不能是符号链接");
      }
      return new LibraryDB(
        root,
        manifest.id,
        manifest.name,
        token,
        storageSchema.parse(manifest.storage ?? { mode: "local" }),
      );
    } catch (e) {
      await unlink(lock);
      throw e;
    }
  }
  info(): Library {
    return {
      id: this.id,
      name: this.name,
      path: this.root,
      available: true,
      storage: this.storage,
      count: Number(
        (
          this.db.prepare("SELECT count(*) n FROM assets").get() as {
            n: number;
          }
        ).n,
      ),
    };
  }
  assets(): Asset[] {
    return this.db
      .prepare("SELECT data FROM assets")
      .all()
      .map((r) => this.withCollections(JSON.parse(r.data as string)));
  }
  asset(id: string): Asset {
    const row = this.db.prepare("SELECT data FROM assets WHERE id=?").get(id);
    if (!row) throw new Error("素材不存在");
    return this.withCollections(JSON.parse(row.data as string));
  }
  private withCollections(asset: Asset): Asset {
    const collectionIds = this.db
      .prepare("SELECT collection_id FROM collection_assets WHERE asset_id=?")
      .all(asset.id)
      .map((r) => String(r.collection_id));
    return {
      ...asset,
      favorite: collectionIds.length > 0,
      collectionIds,
    };
  }
  ensureDefaultCollection(migrateFavorites = false) {
    let row = this.db
      .prepare("SELECT id FROM collections WHERE is_default=1")
      .get();
    if (!row) {
      row = this.db
        .prepare("SELECT id FROM collections WHERE name=?")
        .get("默认收藏夹");
      if (row)
        this.db
          .prepare("UPDATE collections SET is_default=1 WHERE id=?")
          .run(row.id);
      else {
        row = { id: randomUUID() };
        this.db
          .prepare(
            "INSERT INTO collections(id,name,created_at,is_default) VALUES(?,?,?,1)",
          )
          .run(row.id, "默认收藏夹", now());
      }
    }
    if (migrateFavorites)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO collection_assets SELECT ?,id FROM assets WHERE json_extract(data,'$.favorite')=1",
        )
        .run(row.id);
    return String(row.id);
  }
  tags() {
    return this.db
      .prepare(
        `
      SELECT tag.value name, count(DISTINCT assets.id) count
      FROM assets, json_each(assets.data, '$.tags') tag
      WHERE tag.type = 'text' AND length(trim(tag.value)) > 0
      GROUP BY tag.value ORDER BY count DESC, tag.value
    `,
      )
      .all()
      .map((row) => ({
        libraryId: this.id,
        name: String(row.name),
        count: Number(row.count),
      }));
  }
  collections() {
    return this.db
      .prepare(
        "SELECT c.id,c.name,c.is_default,count(ca.asset_id) count FROM collections c LEFT JOIN collection_assets ca ON c.id=ca.collection_id GROUP BY c.id ORDER BY c.is_default DESC,c.created_at",
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        libraryId: this.id,
        name: String(r.name),
        count: Number(r.count),
        isDefault: !!r.is_default,
      }));
  }
  hash(hash: string): Asset | undefined {
    const row = this.db
      .prepare("SELECT data FROM assets WHERE hash=?")
      .get(hash);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveAsset(asset: Asset, hash?: string) {
    if (hash)
      this.db
        .prepare("INSERT INTO assets VALUES(?,?,?)")
        .run(asset.id, hash, JSON.stringify(asset));
    else
      this.db
        .prepare("UPDATE assets SET data=? WHERE id=?")
        .run(JSON.stringify(asset), asset.id);
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks")
      .all()
      .map((r) => JSON.parse(r.data as string));
  }
  saveTask(task: Task) {
    task.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(task.id, JSON.stringify(task));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  notice(text: string) {
    this.db
      .prepare("INSERT INTO notices VALUES(?,?,?)")
      .run(randomUUID(), text, now());
  }
  async close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    const lock = join(this.root, ".library-lock");
    try {
      const stored = JSON.parse(await readFile(lock, "utf8"));
      if (stored.token === this.lockToken) await unlink(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
