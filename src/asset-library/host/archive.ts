import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  lstat,
  link,
  unlink,
  rename,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile as Writer } from "yazl";
import { open as openZip, type ZipFile, type Entry } from "yauzl";
import { z } from "zod";
import { assetSchema, type Storage } from "../shared/contracts.ts";
import { flattenCollectionNames } from "./collections.ts";
import { LibraryDB, safePath, now } from "./storage.ts";
import { Objects } from "./objects.ts";
import { WorkError } from "./ark.ts";

type Progress = (percent: number, detail: string) => void;
const filePath = z
  .string()
  .regex(/^(originals|previews)\/[a-zA-Z0-9._/-]+$/)
  .refine((p) => !p.split("/").some((x) => !x || x === "." || x === ".."));
const identifier = z.string().uuid();
const metadataSchema = z.object({
  format: z.literal("dsh-asset-library-zip"),
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1).max(120),
  assets: z.array(
    z.object({
      asset: assetSchema.extend({
        id: identifier,
        relativePath: filePath,
        thumbnail: filePath.nullable(),
      }),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  collections: z.array(
    z.object({
      id: identifier,
      name: z.string().min(1).max(80),
      created_at: z.string(),
      is_default: z.number().int().min(0).max(1).default(0),
      parent_id: identifier.nullable().default(null),
    }),
  ),
  vectors: z.array(
    z.object({
      asset_id: identifier,
      segment: z.number().int().nonnegative(),
      fingerprint: z.string().max(2500),
      start: z.number().nullable(),
      end: z.number().nullable(),
      vector: z.array(z.number().finite()).min(2).max(65536),
    }),
  ),
  files: z.array(
    z.object({
      path: filePath,
      size: z
        .number()
        .int()
        .nonnegative()
        .max(100 * 1024 ** 3),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
async function digest(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path, { signal }))
    hash.update(data);
  return hash.digest("hex");
}
export async function exportArchive(
  lib: LibraryDB,
  objects: Objects,
  destination: string,
  scratch: string,
  signal: AbortSignal,
  report: Progress,
) {
  if (!isAbsolute(destination))
    throw new WorkError("请选择导出文件夹的绝对路径");
  if (!(await stat(destination)).isDirectory())
    throw new WorkError("导出位置必须是文件夹");
  const catalog = lib.transaction(() => ({
    format: "dsh-asset-library-zip" as const,
    version: 2 as const,
    name: lib.name,
    assets: lib.db
      .prepare("SELECT data,hash FROM assets")
      .all()
      .map((row) => ({
        asset: lib.asset(JSON.parse(String(row.data)).id),
        hash: String(row.hash),
      })),
    collections: lib.db.prepare("SELECT * FROM collections").all(),
    vectors: lib.db
      .prepare("SELECT * FROM vectors")
      .all()
      .map((row) => ({ ...row, vector: JSON.parse(String(row.vector)) })),
    files: [] as { path: string; size: number; sha256: string }[],
  }));
  const paths = new Set<string>();
  for (const { asset } of catalog.assets) {
    paths.add(asset.relativePath);
    if (asset.thumbnail) paths.add(asset.thumbnail);
  }
  // Embeddings are sufficient for migrated search; generated frame caches can be rebuilt.
  await mkdir(scratch, { recursive: true });
  let done = 0;
  const filename = `${lib.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.zip`;
  const result = join(destination, filename),
    partial = result + ".part";
  try {
    for (const path of paths) {
      signal.throwIfAborted();
      filePath.parse(path);
      const target = safePath(scratch, path),
        hash = createHash("sha256");
      await mkdir(dirname(target), { recursive: true });
      const source = await objects.stream(path, signal);
      let loaded = 0;
      const meter = new Transform({
        transform(chunk, _encoding, cb) {
          hash.update(chunk);
          loaded += chunk.length;
          report(
            Math.round(
              ((done + Math.min(1, loaded / Math.max(1, source.size))) /
                Math.max(1, paths.size)) *
                75,
            ),
            "正在收集素材",
          );
          cb(null, chunk);
        },
      });
      await pipeline(
        source.stream,
        meter,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      const sha256 = hash.digest("hex");
      const original = catalog.assets.find(
        (x) => x.asset.relativePath === path,
      );
      if (original && original.hash !== sha256)
        throw new WorkError(
          "原文件校验失败，导出已停止：" + original.asset.name,
        );
      catalog.files.push({ path, size: loaded, sha256 });
      done++;
    }
    const encoded = Buffer.from(JSON.stringify(metadataSchema.parse(catalog)));
    if (encoded.length > 64 * 1024 ** 2)
      throw new WorkError("库目录超过当前 ZIP 格式的 64 MB 上限");
    const zip = new Writer();
    zip.on("error", (error) =>
      (zip.outputStream as import("node:stream").Readable).destroy(error),
    );
    let zipped = 0;
    const expected = catalog.files.reduce((n, f) => n + f.size, encoded.length);
    const zipProgress = new Transform({
      transform(chunk, _encoding, cb) {
        zipped += chunk.length;
        report(
          80 + Math.min(19, Math.round((zipped / Math.max(1, expected)) * 19)),
          "正在写入 ZIP",
        );
        cb(null, chunk);
      },
    });
    const writing = pipeline(
      zip.outputStream,
      zipProgress,
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    writing.catch(() => {});
    for (const file of catalog.files)
      zip.addFile(safePath(scratch, file.path), file.path, { compress: false });
    zip.addBuffer(encoded, "catalog.json");
    report(80, "正在写入 ZIP");
    zip.end({ forceZip64Format: true, comment: "" });
    await writing;
    signal.throwIfAborted();
    await link(partial, result); // Atomic, never overwrites an existing export.
    await unlink(partial);
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await unlink(partial).catch(() => {});
  }
}
async function extract(
  source: string,
  target: string,
  signal: AbortSignal,
  report: Progress,
) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      source,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (e, zip) => (e ? reject(e) : resolve(zip!)),
    ),
  );
  const names = new Set<string>();
  let bytes = 0,
    count = 0;
  return new Promise<Set<string>>((resolve, reject) => {
    let settled = false,
      working: Promise<void> | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      signal.removeEventListener("abort", abort);
      void Promise.resolve(working)
        .catch(() => {})
        .then(() => reject(error));
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(names);
    });
    zip.on("entry", (entry: Entry) => {
      working = (async () => {
        signal.throwIfAborted();
        const name = entry.fileName,
          mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (
          (mode && mode !== 0x8000) ||
          entry.isEncrypted() ||
          (name !== "catalog.json" && !filePath.safeParse(name).success)
        )
          throw new WorkError("ZIP 包含不支持的文件路径或链接");
        if (names.has(name.toLocaleLowerCase()))
          throw new WorkError("ZIP 中有重复路径");
        names.add(name.toLocaleLowerCase());
        bytes += entry.uncompressedSize;
        if (
          ++count > 200000 ||
          bytes > 1024 ** 4 ||
          (name === "catalog.json" &&
            entry.uncompressedSize > 64 * 1024 ** 2) ||
          entry.uncompressedSize > 100 * 1024 ** 3
        )
          throw new WorkError("ZIP 超过支持的导入大小");
        const path = safePath(target, name);
        await mkdir(dirname(path), { recursive: true });
        signal.throwIfAborted();
        const input = await new Promise<import("node:stream").Readable>(
          (res, rej) =>
            zip.openReadStream(entry, (e, stream) =>
              e ? rej(e) : res(stream!),
            ),
        );
        await pipeline(
          input,
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        report(
          Math.round((count / Math.max(1, zip.entryCount)) * 65),
          "正在解压素材",
        );
        if (!settled) zip.readEntry();
      })();
      void working.catch(fail);
    });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
}
export async function importArchive(
  source: string,
  destination: string,
  storage: Storage,
  signal: AbortSignal,
  report: Progress,
  operationId?: string,
) {
  if (!isAbsolute(destination)) throw new WorkError("请选择新库的绝对路径");
  if (operationId) {
    try {
      const previous = JSON.parse(
        await readFile(join(destination, "library.json"), "utf8"),
      );
      if (
        previous.importOperation === operationId &&
        typeof previous.id === "string"
      )
        return previous.id as string;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  // Reserving an entirely new directory avoids replacing or merging an existing library.
  try {
    await lstat(destination);
    throw new WorkError("导入需要新的文件夹，请填写尚不存在的子文件夹");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(dirname(destination), { recursive: true });
  const scratch = join(dirname(destination), ".asset-import-" + randomUUID());
  await mkdir(scratch, { mode: 0o700 });
  let lib: LibraryDB | undefined;
  try {
    const names = await extract(source, scratch, signal, report);
    const catalog = metadataSchema.parse(
      JSON.parse(await readFile(join(scratch, "catalog.json"), "utf8")),
    );
    if (
      names.size !== catalog.files.length + 1 ||
      new Set(catalog.files.map((f) => f.path.toLowerCase())).size !==
        catalog.files.length
    )
      throw new WorkError("ZIP 文件清单不完整或重复");
    const files = new Map(catalog.files.map((f) => [f.path, f]));
    for (const [index, file] of catalog.files.entries()) {
      if (
        !names.has(file.path.toLowerCase()) ||
        (await stat(safePath(scratch, file.path))).size !== file.size ||
        (await digest(safePath(scratch, file.path), signal)) !== file.sha256
      )
        throw new WorkError("ZIP 素材校验失败");
      report(
        65 + Math.round(((index + 1) / Math.max(1, catalog.files.length)) * 25),
        "正在校验素材",
      );
    }
    const assets = new Set(catalog.assets.map((x) => x.asset.id));
    const collections = new Set(catalog.collections.map((x) => x.id));
    if (
      assets.size !== catalog.assets.length ||
      collections.size !== catalog.collections.length
    )
      throw new WorkError("ZIP 目录存在重复身份");
    for (const folder of catalog.collections) {
      const seen = new Set([folder.id]);
      let parent = folder.parent_id;
      while (parent) {
        if (seen.has(parent) || seen.size >= 6)
          throw new WorkError("ZIP 文件夹层级不合法");
        seen.add(parent);
        const ancestor = catalog.collections.find((c) => c.id === parent);
        if (!ancestor) throw new WorkError("ZIP 缺少上级文件夹");
        parent = ancestor.parent_id;
      }
    }
    for (const { asset, hash } of catalog.assets) {
      if (
        files.get(asset.relativePath)?.sha256 !== hash ||
        files.get(asset.relativePath)?.size !== asset.size ||
        (asset.thumbnail && !files.has(asset.thumbnail)) ||
        asset.collectionIds.some((id) => !collections.has(id))
      )
        throw new WorkError("ZIP 素材目录与文件不一致");
    }
    if (catalog.vectors.some((v) => !assets.has(v.asset_id)))
      throw new WorkError("ZIP 索引缺少对应素材");
    const id = randomUUID();
    await writeFile(
      join(scratch, "library.json"),
      JSON.stringify({
        format: "dsh-asset-library",
        version: storage.mode === "s3" ? 2 : 1,
        id,
        name: catalog.name,
        storage,
        importOperation: operationId,
      }),
      { mode: 0o600 },
    );
    lib = await LibraryDB.open(scratch);
    const db = lib;
    db.transaction(() => {
      db.db.exec("DELETE FROM collections");
      for (const c of flattenCollectionNames(
        [...catalog.collections].sort(
          (a, b) =>
            b.is_default - a.is_default ||
            Number(!!a.parent_id) - Number(!!b.parent_id),
        ),
      ))
        db.db
          .prepare(
            "INSERT INTO collections(id,name,created_at,is_default) VALUES(?,?,?,?)",
          )
          .run(c.id, c.name, c.created_at, c.is_default);
      for (const { asset, hash } of catalog.assets) {
        db.saveAsset({ ...asset, libraryId: id }, hash);
        for (const c of asset.collectionIds)
          db.db
            .prepare("INSERT INTO collection_assets VALUES(?,?)")
            .run(c, asset.id);
        if (storage.mode === "s3" || asset.status !== "ready")
          db.saveTask({
            id: randomUUID(),
            libraryId: id,
            assetId: asset.id,
            name: asset.name,
            stage: "preview",
            status: storage.mode === "s3" ? "queued" : "paused",
            progress: 0,
            attempts: 0,
            error: null,
            nextRunAt: 0,
            updatedAt: now(),
          });
      }
      db.ensureDefaultCollection(
        !catalog.collections.some((c) => c.is_default),
      );
      for (const v of catalog.vectors)
        db.db
          .prepare("INSERT INTO vectors VALUES(?,?,?,?,?,?)")
          .run(
            v.asset_id,
            v.segment,
            v.fingerprint,
            v.start,
            v.end,
            JSON.stringify(v.vector),
          );
    });
    await lib.close();
    lib = undefined;
    await unlink(join(scratch, "catalog.json"));
    signal.throwIfAborted();
    try {
      await lstat(destination);
      throw new WorkError("目标文件夹已经存在，请更换位置");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // Publish the complete directory in one rename. A crash cannot expose a partial library.
    await rename(scratch, destination);
    return id;
  } finally {
    if (lib) await lib.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
