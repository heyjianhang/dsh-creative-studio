import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  rename,
  unlink,
  open,
  writeFile,
  lstat,
  readdir,
  copyFile,
  rm,
} from "node:fs/promises";
import { join, extname, basename, isAbsolute } from "node:path";
import { LibraryDB, atomicJSON, safePath, now } from "./storage.ts";
import { embed, fingerprint, similarity, WorkError } from "./ark.ts";
import { mediaProviders } from "../../shared/media-providers.ts";
import { prepare, imageData, mediaTypes, run, type Segment } from "./media.ts";
import { Imports } from "./imports.ts";
import { z } from "zod";
import {
  Objects,
  connectionId,
  validateS3,
  type S3Credentials,
} from "./objects.ts";
import { Transfers } from "./transfers.ts";
import { exportArchive, importArchive } from "./archive.ts";
import {
  endpoints,
  settingsSchema,
  storedSettingsSchema,
  searchInput,
  type Settings,
  type Library,
  type Asset,
  type Task,
  type Input,
  type Output,
  type Method,
  type SearchHit,
  type Storage,
} from "../shared/contracts.ts";

export const defaults: Settings = {
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  model: "doubao-embedding-vision-251215",
  concurrency: 2,
  maxRetries: 3,
  segmentSeconds: 10,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  storageMode: "local",
  localDirectory: "",
  s3: {
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "asset-library",
    forcePathStyle: true,
    allowInsecureHttp: false,
  },
};
type Registry = {
  version: 1;
  libraries: { id: string; name: string; path: string }[];
  settings: Settings;
};
type Credentials = {
  readLegacyKey(): Promise<string | undefined>;
} & Partial<S3Credentials>;
/** Host-only credential for a selectable first-party Ark connection. */
export type EmbeddingConnection = {
  id: string;
  name: string;
  apiKey: string;
  models: { id: string; name: string; model: string }[];
};
type Upload = {
  id: string;
  name: string;
  size: number;
  offset: number;
  result: string | null;
  prepared: string | null;
};
export class LibraryService {
  /** Read authoritative file metadata without downloading media or building an index. */
  assetMetadata(libraryId: string, assetId: string) {
    return structuredClone(this.get(libraryId).asset(assetId));
  }
  private state: Registry = { version: 1, libraries: [], settings: defaults };
  private libraries = new Map<string, LibraryDB>();
  private errors = new Map<string, string>();
  private running = new Map<
    string,
    { abort: AbortController; promise: Promise<void>; libraryId: string }
  >();
  private locked = new Map<string, Promise<unknown>>();
  private closed = false;
  private faulted = new Set<string>();
  private exporting = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private queryCache = new Map<string, number[]>();
  private transfers: Transfers;
  readonly imports: Imports;
  constructor(
    readonly dataDir: string,
    readonly credentials: Credentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly embeddingConnections: () => EmbeddingConnection[] = () => [],
  ) {
    this.imports = new Imports(join(dataDir, "imports"), {
      excludedRoots: () => [
        this.dataDir,
        ...this.state.libraries.map((l) => l.path),
      ],
      validate: (id, ids) => {
        const lib = this.get(id);
        if (this.exporting.has(id))
          throw new WorkError("素材库正在导出，请完成后再导入");
        if (ids.some((id) => !lib.collections().some((c) => c.id === id)))
          throw new WorkError("收藏夹不存在或不属于当前素材库");
      },
      begin: async (libraryId, name, size) =>
        (await this.beginUpload({ libraryId, name, size })).id,
      ready: (libraryId, id) => {
        const row = this.get(libraryId)
          .db.prepare("SELECT * FROM uploads WHERE id=?")
          .get(id) as Upload | undefined;
        return !!(row?.result || row?.prepared);
      },
      chunk: async (libraryId, id, offset, data) =>
        (
          await this.uploadChunk({
            libraryId,
            id,
            offset,
            data: data.toString("base64"),
          })
        ).offset,
      finish: (libraryId, id, signal) =>
        this.finishUpload({ libraryId, id }, signal),
      decorate: async (libraryId, id, tags, collectionIds) => {
        if (tags.length || collectionIds.length)
          await this.editAsset({ libraryId, id, tags, collectionIds });
      },
    });
    this.transfers = new Transfers(
      join(dataDir, "transfers"),
      async (job, signal, report) => {
        if (job.kind === "export") {
          const lib = this.get(job.libraryId!);
          this.exporting.add(lib.id);
          try {
            await this.stopLibrary(lib.id);
            return await exportArchive(
              lib,
              this.objects(lib),
              job.path,
              join(dataDir, "transfer-" + job.id + "-" + randomUUID()),
              signal,
              report,
            );
          } finally {
            this.exporting.delete(lib.id);
            this.tick();
          }
        }
        await importArchive(
          this.transfers.archivePath(job.archiveId!),
          job.path,
          job.storage ?? { mode: "local" },
          signal,
          report,
          job.id,
        );
        const result = await this.library({ action: "open", path: job.path });
        return result.id!;
      },
    );
  }
  private objects(lib: LibraryDB) {
    return new Objects(
      lib.root,
      lib.id,
      lib.storage,
      this.credentials.readS3 ? (this.credentials as S3Credentials) : undefined,
    );
  }
  private async selectedStorage(mode: "local" | "s3"): Promise<Storage> {
    if (mode === "local") return { mode };
    const s3 = { ...this.state.settings.s3 };
    validateS3(s3);
    if (!(await this.credentials.readS3?.(connectionId(s3))))
      throw new WorkError("请先在创作设置 → 素材库中配置 S3 连接与密钥");
    return { mode, s3 };
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(
        await readFile(join(this.dataDir, "settings.json"), "utf8"),
      );
      if (this.state.version !== 1 || !Array.isArray(this.state.libraries))
        throw new Error("版本不受支持");
      this.state.settings = storedSettingsSchema.parse(this.state.settings);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("本机素材库配置无法读取，原文件已保留");
    }
    for (const row of this.state.libraries) {
      try {
        const lib = await LibraryDB.open(row.path);
        if (lib.id !== row.id) {
          await lib.close();
          throw new Error("文件夹中的库身份已改变");
        }
        this.libraries.set(lib.id, lib);
      } catch (e) {
        this.errors.set(row.id, message(e));
      }
    }
    await this.transfers.init();
    await this.imports.init();
    this.timer = setInterval(() => this.tick(), 800);
    this.timer.unref();
    this.tick();
  }
  private save() {
    return atomicJSON(join(this.dataDir, "settings.json"), this.state);
  }
  private get(id: string) {
    const lib = this.libraries.get(id);
    if (!lib) throw new WorkError("素材库未打开，请检查库的位置");
    return lib;
  }
  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locked.get(key) ?? Promise.resolve();
    const next = before.catch(() => {}).then(fn);
    this.locked.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locked.get(key) === next) this.locked.delete(key);
    }
  }
  async dispatch<K extends Method>(
    method: K,
    raw: Input<K>,
    signal: AbortSignal,
  ): Promise<Output<K>> {
    signal.throwIfAborted();
    if (this.closed) throw new WorkError("插件正在关闭");
    const request = endpoints[method].input.parse(raw);
    const fn = this[method] as (r: unknown, s: AbortSignal) => Promise<unknown>;
    return endpoints[method].output.parse(
      await fn.call(this, request, signal),
    ) as Output<K>;
  }
  async snapshot(): Promise<Output<"snapshot">> {
    const connections = this.embeddingConnections();
    const settings = this.state.settings;
    const source = this.embeddingSource(settings, connections);
    const keyConfigured = !!(await source.readKey());
    return {
      libraries: this.state.libraries.map(
        (row) =>
          (this.faulted.has(row.id)
            ? undefined
            : this.libraries.get(row.id)?.info()) ?? {
            ...row,
            available: false,
            count: 0,
            error: this.errors.get(row.id) ?? "库不可用",
            storage: { mode: "local" as const },
          },
      ),
      tasks: [...this.libraries.values()]
        .flatMap((l) => l.tasks())
        .concat(this.imports.tasks())
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 500),
      keyConfigured,
      embeddingModels: connections.flatMap((c) =>
        c.models.map(({ id, name }) => ({ id, name, connectionName: c.name })),
      ),
      legacyEmbeddingModel:
        !settings.embeddingModelId && keyConfigured
          ? settings.model
          : undefined,
      s3Configured: !!(await this.credentials.readS3?.(
        connectionId(this.state.settings.s3),
      )),
      transfers: structuredClone(this.transfers.rows),
      settings: settingsSchema.parse(settings),
      collections: [...this.libraries.values()].flatMap((l) => l.collections()),
      tags: [...this.libraries.values()].flatMap((l) => l.tags()),
      notices: [...this.libraries.values()]
        .flatMap(
          (l) =>
            l.db
              .prepare(
                "SELECT * FROM notices ORDER BY createdAt DESC LIMIT 100",
              )
              .all() as { id: string; text: string; createdAt: string }[],
        )
        .concat(
          this.transfers.rows
            .filter(
              (j) =>
                !j.acknowledged && ["completed", "failed"].includes(j.status),
            )
            .map((j) => ({
              id: "transfer-" + j.id,
              text: `${j.kind === "export" ? "导出" : "导入"}${j.status === "completed" ? "完成" : "失败"}：${j.name}${j.error ? "。" + j.error : ""}`,
              createdAt: j.updatedAt,
            })),
        )
        .concat(this.imports.notices()),
    };
  }
  async library(r: Input<"library">) {
    return this.exclusive("registry", async () => {
      if (r.action === "close") {
        if (!r.id) throw new WorkError("请选择素材库");
        if (this.imports.busy(r.id))
          throw new WorkError("请先暂停或取消文件导入任务再关闭素材库");
        if (
          this.transfers.rows.some(
            (j) =>
              j.libraryId === r.id && ["running", "queued"].includes(j.status),
          )
        )
          throw new WorkError("请等待导出完成或在任务中心取消后再关闭素材库");
        await this.exclusive("library:" + r.id, async () => {
          await this.stopLibrary(r.id!);
          const lib = this.libraries.get(r.id!);
          if (lib) await lib.close();
          this.libraries.delete(r.id!);
        });
        this.state.libraries = this.state.libraries.filter(
          (x) => x.id !== r.id,
        );
        await this.save();
        return { ok: true as const };
      }
      if (!r.path) throw new WorkError("请选择库文件夹");
      const existing = this.state.libraries.find(
        (x) => x.path === r.path && this.libraries.has(x.id),
      );
      if (existing) return { ok: true as const, id: existing.id };
      const lib = await LibraryDB.open(
        r.path,
        r.action === "create" ? (r.name ?? "素材库") : undefined,
        r.action === "create"
          ? await this.selectedStorage(
              r.storageMode ?? this.state.settings.storageMode,
            )
          : undefined,
      );
      if (this.libraries.has(lib.id)) {
        await lib.close();
        throw new WorkError("同一个库已打开，请先关闭旧位置再打开副本");
      }
      this.libraries.set(lib.id, lib);
      this.errors.delete(lib.id);
      this.faulted.delete(lib.id);
      this.state.libraries = this.state.libraries.filter(
        (x) => x.id !== lib.id,
      );
      this.state.libraries.push({ id: lib.id, name: lib.name, path: lib.root });
      await this.save();
      this.tick();
      return { ok: true as const, id: lib.id };
    });
  }
  async saveSettings(r: Input<"saveSettings">) {
    return this.exclusive("registry", async () => {
      const preferences = settingsSchema.parse(r);
      const current = this.state.settings;
      const embeddingModelId =
        preferences.embeddingModelId ?? current.embeddingModelId;
      const settings: Settings = {
        ...current,
        ...preferences,
        embeddingModelId,
        embeddingConnectionId: embeddingModelId
          ? undefined
          : current.embeddingConnectionId,
      };
      if (settings.localDirectory && !isAbsolute(settings.localDirectory))
        throw new WorkError("素材库默认位置需要绝对文件夹路径");
      if (
        embeddingModelId &&
        embeddingModelId !== current.embeddingModelId &&
        !this.embeddingConnections().some((c) =>
          c.models.some((m) => m.id === embeddingModelId),
        )
      )
        throw new WorkError("所选向量模型不可用，请重新选择");
      if (settings.s3.bucket) validateS3(settings.s3);
      if (r.clearS3)
        await this.credentials.clearS3?.(connectionId(settings.s3));
      else if (r.accessKeyId?.trim() || r.secretAccessKey?.trim()) {
        if (!r.accessKeyId?.trim() || !r.secretAccessKey?.trim())
          throw new WorkError("请同时填写 Access Key ID 和 Secret Access Key");
        validateS3(settings.s3);
        if (!this.credentials.writeS3)
          throw new WorkError("当前宿主不支持 S3 凭据存储");
        await this.credentials.writeS3(connectionId(settings.s3), {
          accessKeyId: r.accessKeyId.trim(),
          secretAccessKey: r.secretAccessKey.trim(),
          ...(r.sessionToken?.trim()
            ? { sessionToken: r.sessionToken.trim() }
            : {}),
        });
      }
      await atomicJSON(join(this.dataDir, "settings.json"), {
        ...this.state,
        settings,
      });
      this.state.settings = settings;
      this.queryCache.clear();
      return { ok: true as const };
    });
  }
  private embeddingSource(
    settings: Settings,
    connections = this.embeddingConnections(),
  ) {
    const { embeddingModelId, embeddingConnectionId } = settings;
    const shared = !!(embeddingModelId || embeddingConnectionId);
    const connection = embeddingModelId
      ? connections.find((c) => c.models.some((m) => m.id === embeddingModelId))
      : connections.find((c) => c.id === embeddingConnectionId);
    const model = connection?.models.find((m) => m.id === embeddingModelId);
    const readKey = () =>
      shared
        ? Promise.resolve(connection?.apiKey)
        : this.credentials.readLegacyKey();
    return {
      settings: {
        ...settings,
        baseUrl: shared ? mediaProviders.native.baseUrl : settings.baseUrl,
        model: model?.model ?? settings.model,
      },
      readKey,
      requireKey: async () => {
        const key = await readKey();
        if (key) return key;
        if (shared)
          throw new WorkError(
            "所选向量模型不可用，请在创作设置 → 素材库中重新选择",
          );
        throw new WorkError(
          "请在创作设置 → 模型连接添加向量模型，再到素材库选择",
        );
      },
    };
  }
  async testConnection(_r: Input<"testConnection">, signal: AbortSignal) {
    const source = this.embeddingSource(this.state.settings);
    const vector = await embed(
      source.settings,
      await source.requireKey(),
      { text: "素材库连接测试" },
      signal,
      this.fetcher,
    );
    return { dimensions: vector.length };
  }
  async testS3(_r: Input<"testS3">, signal: AbortSignal) {
    const storage = await this.selectedStorage("s3");
    await new Objects(
      this.dataDir,
      "connection-test",
      storage,
      this.credentials as S3Credentials,
    ).test(signal);
    return { ok: true as const };
  }
  archiveUpload(r: Input<"archiveUpload">) {
    return this.transfers.upload(r);
  }
  transfer(r: Input<"transfer">) {
    return this.transfers.control(r);
  }
  async startTransfer(r: Input<"startTransfer">) {
    if (r.kind === "export") {
      if (!r.libraryId) throw new WorkError("请选择导出的素材库");
      if (this.imports.busy(r.libraryId))
        throw new WorkError("请先暂停文件导入任务再导出素材库");
      const lib = this.get(r.libraryId);
      return this.transfers.add({
        kind: "export",
        libraryId: lib.id,
        path: r.path,
        name: lib.name,
      });
    }
    if (!r.archiveId) throw new WorkError("请选择已上传的 ZIP");
    await this.transfers.ready(r.archiveId);
    return this.transfers.add({
      kind: "import",
      archiveId: r.archiveId,
      path: r.path,
      name: basename(r.path),
      storage: await this.selectedStorage(r.storageMode ?? "local"),
    });
  }
  async updateAsset(r: Input<"updateAsset">) {
    await this.editAsset(r);
    return { ok: true as const };
  }
  async editAsset(raw: Input<"editAsset">) {
    const r = endpoints.editAsset.input.parse(raw);
    return this.exclusive("library:" + r.libraryId, async () => {
      const lib = this.get(r.libraryId);
      return lib.transaction(() => this.applyEdit(lib, r));
    });
  }
  private applyEdit(lib: LibraryDB, r: Input<"editAsset">) {
    const asset = lib.asset(r.id);
    let ids = r.collectionIds ? [...new Set(r.collectionIds)] : undefined;
    if (!ids && r.favorite !== undefined)
      ids = r.favorite
        ? asset.collectionIds.length
          ? asset.collectionIds
          : [lib.ensureDefaultCollection()]
        : [];
    if (r.addCollections)
      ids = [
        ...new Set([...(ids ?? asset.collectionIds), ...r.addCollections]),
      ];
    if (ids && ids.length > 100)
      throw new WorkError("素材最多加入 100 个文件夹");
    if (ids && ids.some((id) => !lib.collections().some((c) => c.id === id)))
      throw new WorkError("收藏夹不存在或不属于当前素材库");
    lib.saveAsset({
      ...asset,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.tags !== undefined ? { tags: [...new Set(r.tags)] } : {}),
      ...(r.notes !== undefined ? { notes: r.notes } : {}),
      ...(ids !== undefined ? { favorite: ids.length > 0 } : {}),
    });
    if (ids) {
      lib.db
        .prepare("DELETE FROM collection_assets WHERE asset_id=?")
        .run(r.id);
      for (const id of ids)
        lib.db
          .prepare("INSERT INTO collection_assets VALUES(?,?)")
          .run(id, r.id);
    }
    return lib.asset(r.id);
  }
  async editBatch(raw: unknown, signal: AbortSignal) {
    const r = z
      .object({
        libraryId: z.string(),
        changes: z
          .array(
            z
              .object({
                id: z.string(),
                name: z.string().trim().min(1).max(255).optional(),
                notes: z.string().max(10000).optional(),
                addTags: z
                  .array(z.string().trim().min(1).max(80))
                  .max(50)
                  .default([]),
                removeTags: z.array(z.string()).max(50).default([]),
                addCollections: z.array(z.string()).max(100).default([]),
                removeCollections: z.array(z.string()).max(100).default([]),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .parse(raw);
    return this.exclusive("library:" + r.libraryId, async () => {
      signal.throwIfAborted();
      const lib = this.get(r.libraryId);
      if (new Set(r.changes.map((c) => c.id)).size !== r.changes.length)
        throw new WorkError("同一批次请勿重复修改同一素材");
      const patches = r.changes.map((c) => {
        const asset = lib.asset(c.id);
        return endpoints.editAsset.input.parse({
          libraryId: r.libraryId,
          id: c.id,
          ...(c.name !== undefined ? { name: c.name } : {}),
          ...(c.notes !== undefined ? { notes: c.notes } : {}),
          tags: [
            ...new Set([
              ...asset.tags.filter((t) => !c.removeTags.includes(t)),
              ...c.addTags,
            ]),
          ],
          collectionIds: [
            ...new Set([
              ...asset.collectionIds.filter(
                (id) => !c.removeCollections.includes(id),
              ),
              ...c.addCollections,
            ]),
          ],
        });
      });
      const ids = new Set(lib.collections().map((c) => c.id));
      for (const p of patches)
        if (p.collectionIds!.some((id) => !ids.has(id)))
          throw new WorkError("收藏夹不存在或不属于当前素材库");
      // One transaction: an invalid batch cannot leave half the assets changed.
      return lib.transaction(() => patches.map((p) => this.applyEdit(lib, p)));
    });
  }
  async inspectAsset(raw: unknown, signal: AbortSignal) {
    const r = z
      .object({
        libraryId: z.string(),
        id: z.string(),
        frames: z.array(z.number().min(0).max(86400)).max(4).default([0]),
      })
      .strict()
      .parse(raw);
    return this.exclusive("library:" + r.libraryId, async () => {
      signal.throwIfAborted();
      const lib = this.get(r.libraryId),
        asset = lib.asset(r.id);
      const directory = join(this.dataDir, "inspection", lib.id, asset.id);
      await mkdir(directory, { recursive: true });
      const source = safePath(lib.root, asset.relativePath);
      await this.objects(lib).hydrate(asset.relativePath, signal);
      const metadata = JSON.parse(
        await run(
          this.state.settings.ffprobePath,
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            source,
          ],
          signal,
        ),
      );
      const video = metadata.streams?.find(
        (s: { codec_type: string }) => s.codec_type === "video",
      );
      const duration = Number(metadata.format?.duration) || asset.duration;
      const times =
        asset.kind === "image"
          ? [0]
          : [...new Set(r.frames.length ? r.frames : [0])];
      if (duration && times.some((t) => t >= duration))
        throw new WorkError("抽帧时间超出视频时长");
      const frames = [];
      for (const time of times) {
        signal.throwIfAborted();
        const path = join(directory, `${time}.jpg`);
        if (!(await stat(path).catch(() => null))?.size) {
          const temp = path + "." + randomUUID() + ".jpg";
          try {
            await run(
              this.state.settings.ffmpegPath,
              [
                "-nostdin",
                "-v",
                "error",
                "-y",
                ...(asset.kind === "video" ? ["-ss", String(time)] : []),
                "-i",
                source,
                "-frames:v",
                "1",
                "-vf",
                "scale=1024:1024:force_original_aspect_ratio=decrease",
                temp,
              ],
              signal,
            );
            signal.throwIfAborted();
            await rename(temp, path);
          } finally {
            await unlink(temp).catch(() => {});
          }
        }
        frames.push({ time, path });
      }
      return {
        asset,
        width: video?.width ?? null,
        height: video?.height ?? null,
        duration: duration ?? null,
        frames,
      };
    });
  }
  async indexAssets(libraryId: string, ids: string[], signal: AbortSignal) {
    const input = z.array(z.string()).min(1).max(100).parse(ids);
    const lib = this.get(libraryId);
    for (const id of input) lib.asset(id);
    const tasks = [];
    for (const id of new Set(input)) {
      signal.throwIfAborted();
      const task = lib.tasks().find((t) => t.assetId === id);
      if (task) {
        if (!["queued", "running", "retrying"].includes(task.status))
          await this.task({ libraryId, id: task.id, action: "retry" });
        tasks.push(task.id);
      }
    }
    return { taskIds: tasks };
  }
  async collection(r: Input<"collection">) {
    const lib = this.get(r.libraryId);
    const collections = lib.collections();
    const current = collections.find((c) => c.id === r.id);
    if (r.action !== "create" && !current)
      throw new WorkError("收藏夹不存在或不属于当前素材库");
    if (current?.isDefault) throw new WorkError("默认收藏夹不能修改");
    if (r.action === "delete") {
      lib.transaction(() => {
        lib.db
          .prepare("DELETE FROM collection_assets WHERE collection_id=?")
          .run(r.id!);
        lib.db.prepare("DELETE FROM collections WHERE id=?").run(r.id!);
      });
      return { ok: true as const };
    }
    const name = r.name?.trim();
    if (!name) throw new WorkError("请输入收藏夹名称");
    if (collections.some((c) => c.name === name && c.id !== r.id))
      throw new WorkError("已经有同名收藏夹");
    if (r.action === "create") {
      if (collections.length >= 1000) throw new WorkError("收藏夹数量已达上限");
      lib.db
        .prepare("INSERT INTO collections(id,name,created_at) VALUES(?,?,?)")
        .run(randomUUID(), name, now());
    } else {
      lib.db
        .prepare("UPDATE collections SET name=? WHERE id=?")
        .run(name, r.id!);
    }
    return { ok: true as const };
  }
  async setCollections(r: Input<"setCollections">) {
    await this.editAsset(r);
    return { ok: true as const };
  }
  async beginUpload(r: Input<"beginUpload">) {
    return this.exclusive("library:" + r.libraryId, async () => {
      const lib = this.get(r.libraryId);
      return this.stageUpload(lib, r);
    });
  }
  private async stageUpload(lib: LibraryDB, r: Pick<Input<"beginUpload">, "name" | "size">) {
    const name = basename(r.name.replace(/\\/g, "/"));
    if (!mediaTypes[extname(name).toLowerCase()])
      throw new WorkError("支持 JPG、PNG、WebP、GIF、MP4、MOV、MKV 和 WebM");
    const id = randomUUID();
    await writeFile(join(lib.root, "staging", id), new Uint8Array(), {
      flag: "wx",
      mode: 0o600,
    });
    lib.db
      .prepare("INSERT INTO uploads(id,name,size) VALUES(?,?,?)")
      .run(id, name, r.size);
    return { id, offset: 0 };
  }
  async uploadChunk(r: Input<"uploadChunk">) {
    return this.exclusive("library:" + r.libraryId, async () => {
      const lib = this.get(r.libraryId),
        row = lib.db.prepare("SELECT * FROM uploads WHERE id=?").get(r.id) as
          Upload | undefined;
      if (!row || row.result) throw new WorkError("导入已完成或不存在");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data))
        throw new WorkError("上传数据格式不正确");
      const data = Buffer.from(r.data, "base64");
      if (!data.length || data.length > 1024 * 1024)
        throw new WorkError("上传分块大小不正确");
      const path = join(lib.root, "staging", row.id);
      const offset = (await stat(path)).size;
      if (r.offset < offset) {
        const file = await open(path, "r");
        try {
          const previous = Buffer.alloc(data.length);
          await file.read(previous, 0, data.length, r.offset);
          if (!previous.equals(data)) throw new WorkError("重复分块内容不一致");
          return { offset };
        } finally {
          await file.close();
        }
      }
      if (r.offset !== offset || offset + data.length > row.size)
        throw new WorkError("上传偏移不一致，请重新导入");
      const file = await open(path, "a");
      try {
        await file.write(data);
        await file.sync();
      } finally {
        await file.close();
      }
      lib.db
        .prepare("UPDATE uploads SET offset=? WHERE id=?")
        .run(offset + data.length, row.id);
      return { offset: offset + data.length };
    });
  }
  async finishUpload(r: Input<"finishUpload">, signal: AbortSignal) {
    return this.exclusive("library:" + r.libraryId, async () => {
      const lib = this.get(r.libraryId),
        row = lib.db.prepare("SELECT * FROM uploads WHERE id=?").get(r.id) as
          Upload | undefined;
      if (!row) throw new WorkError("导入不存在");
      return this.completeUpload(lib, row, signal);
    });
  }
  /** Import a Host-owned file using the same deduplication as library uploads. */
  async importCanvasFile(
    r: { libraryId: string; path: string; name: string; size: number; mime: string; collectionId?: string },
    signal: AbortSignal,
  ) {
    return this.exclusive("library:" + r.libraryId, async () => {
      signal.throwIfAborted();
      const lib = this.get(r.libraryId);
      if (r.collectionId && !lib.collections().some((c) => c.id === r.collectionId))
        throw new WorkError("收藏夹不存在或不属于当前素材库");
      const suffix = extname(r.name);
      const extension = Object.keys(mediaTypes).find((ext) => mediaTypes[ext]?.mime === r.mime);
      if (!extension) throw new WorkError("素材格式不受支持");
      const name = mediaTypes[suffix.toLowerCase()]?.mime === r.mime
        ? r.name
        : basename(r.name, suffix) + extension;
      const { id } = await this.stageUpload(lib, { name, size: r.size });
      const temp = join(lib.root, "staging", id);
      try {
        await copyFile(r.path, temp);
        const row = lib.db.prepare("SELECT * FROM uploads WHERE id=?").get(id) as Upload;
        return await this.completeUpload(lib, row, signal, r.collectionId);
      } finally {
        await rm(temp, { force: true });
        lib.db.prepare("DELETE FROM uploads WHERE id=?").run(id);
      }
    });
  }
  private async completeUpload(
    lib: LibraryDB,
    row: Upload,
    signal: AbortSignal,
    collectionId?: string,
  ): Promise<Output<"finishUpload">> {
    signal.throwIfAborted();
    if (row.result) return JSON.parse(row.result) as Output<"finishUpload">;
    const temp = join(lib.root, "staging", row.id);
    let planned: {
      digest: string;
      id: string;
      ext: string;
      relativePath: string;
    };
    if (row.prepared) planned = JSON.parse(row.prepared);
    else {
      if ((await stat(temp)).size !== row.size)
        throw new WorkError("文件尚未上传完整");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(temp, { signal }))
        hash.update(chunk);
      signal.throwIfAborted();
      const digest = hash.digest("hex"),
        ext = extname(row.name).toLowerCase();
      planned = {
        digest,
        id: randomUUID(),
        ext,
        relativePath: `originals/${digest}${ext}`,
      };
      lib.db
        .prepare("UPDATE uploads SET prepared=? WHERE id=?")
        .run(JSON.stringify(planned), row.id);
    }
    const { digest, id, ext, relativePath } = planned,
      duplicate = lib.hash(digest);
    if (duplicate) {
      const result = { assetId: duplicate.id, duplicate: true };
      lib.transaction(() => {
        if (collectionId)
          this.applyEdit(lib, { libraryId: lib.id, id: duplicate.id, addCollections: [collectionId] });
        lib.db
          .prepare("UPDATE uploads SET result=? WHERE id=?")
          .run(JSON.stringify(result), row.id);
      });
      await unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      return result;
    }
    const destination = safePath(lib.root, relativePath),
      type = mediaTypes[ext];
    try {
      await rename(temp, destination);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" ||
        (await stat(destination)).size !== row.size
      )
        throw e;
    }
    const asset: Asset = {
      id,
      libraryId: lib.id,
      name: row.name,
      ...type,
      size: row.size,
      relativePath,
      tags: [],
      notes: "",
      favorite: false,
      createdAt: now(),
      status: "pending",
      duration: null,
      thumbnail: type.kind === "image" ? relativePath : null,
      collectionIds: [],
    };
    const task: Task = {
      id: randomUUID(),
      libraryId: lib.id,
      assetId: id,
      name: row.name,
      stage: "preview",
      status: "queued",
      progress: 0,
      attempts: 0,
      error: null,
      nextRunAt: 0,
      updatedAt: now(),
    };
    const result = { assetId: id, duplicate: false };
    lib.transaction(() => {
      lib.saveAsset(asset, digest);
      if (collectionId)
        this.applyEdit(lib, { libraryId: lib.id, id, addCollections: [collectionId] });
      lib.saveTask(task);
      lib.db
        .prepare("UPDATE uploads SET result=? WHERE id=?")
        .run(JSON.stringify(result), row.id);
    });
    this.tick();
    return result;
  }
  async media(
    r: Input<"media">,
    signal: AbortSignal = AbortSignal.timeout(120000),
  ) {
    const lib = this.get(r.libraryId),
      asset = lib.asset(r.id),
      path = safePath(
        lib.root,
        r.preview
          ? (asset.thumbnail ?? asset.relativePath)
          : asset.relativePath,
      );
    const local = await lstat(path).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!local && lib.storage.mode === "s3") {
      const relative = r.preview
        ? (asset.thumbnail ?? asset.relativePath)
        : asset.relativePath;
      const offset = r.offset ?? 0;
      const { stream, size } = await this.objects(lib).stream(
        relative,
        signal,
        `bytes=${offset}-${offset + 1024 ** 2 - 1}`,
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 1024 ** 2) {
          stream.destroy();
          throw new WorkError("S3 服务没有正确响应分块读取");
        }
        chunks.push(Buffer.from(chunk));
      }
      return {
        data: Buffer.concat(chunks).toString("base64"),
        mime:
          r.preview && asset.thumbnail?.endsWith(".jpg")
            ? "image/jpeg"
            : asset.mime,
        size,
        nextOffset: offset + bytes,
      };
    }
    if (local?.isSymbolicLink()) throw new WorkError("素材文件不能是符号链接");
    const size = (await stat(path)).size;
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(
        Math.min(1024 * 1024, Math.max(0, size - (r.offset ?? 0))),
      );
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        r.offset ?? 0,
      );
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        mime:
          r.preview && asset.thumbnail?.endsWith(".jpg")
            ? "image/jpeg"
            : asset.mime,
        size,
        nextOffset: (r.offset ?? 0) + bytesRead,
      };
    } finally {
      await file.close();
    }
  }
  async acknowledge(r: Input<"acknowledge">) {
    await this.imports.acknowledge(r.ids);
    await this.transfers.acknowledge(r.ids);
    for (const lib of this.libraries.values())
      for (const id of r.ids)
        lib.db.prepare("DELETE FROM notices WHERE id=?").run(id);
    return { ok: true as const };
  }
  async task(r: Input<"task">) {
    if (this.imports.has(r.id)) {
      await this.imports.control(r.id, r.action, r.libraryId);
      return { ok: true as const };
    }
    const lib = this.get(r.libraryId),
      task = lib.tasks().find((t) => t.id === r.id);
    if (!task) throw new WorkError("任务不存在");
    const active = this.running.get(task.id);
    if (r.action === "pause" || r.action === "cancel") {
      task.status = r.action === "pause" ? "paused" : "cancelled";
      lib.saveTask(task);
      active?.abort.abort();
      await active?.promise;
    } else {
      if (active) throw new WorkError("任务仍在停止，请稍后重试");
      task.status = "queued";
      task.error = null;
      task.attempts = 0;
      task.nextRunAt = 0;
      if (r.action === "retry" || task.stage === "done") task.stage = "preview";
      lib.saveTask(task);
      this.tick();
    }
    return { ok: true as const };
  }
  async search(
    raw: Input<"search">,
    signal: AbortSignal,
  ): Promise<Output<"search">> {
    const r = searchInput.parse(raw),
      libs = r.libraryId
        ? [this.get(r.libraryId)]
        : [...this.libraries.values()];
    const source = this.embeddingSource(this.state.settings);
    const terms = r.query
        .toLocaleLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      fp = fingerprint(source.settings);
    let vector: number[] | undefined;
    if (r.ai && r.query.trim()) {
      const key = await source.requireKey();
      const cacheKey = fp + "|" + r.query.trim();
      vector = this.queryCache.get(cacheKey);
      if (!vector) {
        vector = await embed(
          source.settings,
          key,
          { text: r.query.trim() },
          signal,
          this.fetcher,
        );
        signal.throwIfAborted();
        this.queryCache.set(cacheKey, vector);
        if (this.queryCache.size > 100)
          this.queryCache.delete(this.queryCache.keys().next().value!);
      }
    }
    const hits: SearchHit[] = [];
    let unindexed = 0;
    for (const lib of libs) {
      for (const asset of lib.assets()) {
        signal.throwIfAborted();
        if (
          (r.kind !== "all" && asset.kind !== r.kind) ||
          (r.favorite && !asset.favorite) ||
          (r.recent &&
            Date.now() - Date.parse(asset.createdAt) > 7 * 86400000) ||
          (r.collectionId && !asset.collectionIds.includes(r.collectionId)) ||
          (r.collectionIds.length > 0 &&
            !r.collectionIds.some((id) => asset.collectionIds.includes(id))) ||
          (r.withinDays > 0 &&
            Date.now() - Date.parse(asset.createdAt) >
              r.withinDays * 86400000) ||
          !r.tags.every((tag) =>
            asset.tags.some(
              (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
            ),
          )
        )
          continue;
        const haystack = [asset.name, ...asset.tags, asset.notes]
          .join(" ")
          .toLocaleLowerCase();
        const keyword = terms.length
          ? terms.every((t) => haystack.includes(t))
          : true;
        const vectors = lib.db
          .prepare(
            "SELECT start,end,vector FROM vectors WHERE asset_id=? AND fingerprint=?",
          )
          .all(asset.id, fp) as {
          start: number | null;
          end: number | null;
          vector: string;
        }[];
        if (
          (r.indexState === "indexed" && !vectors.length) ||
          (r.indexState === "unindexed" && vectors.length)
        )
          continue;
        if (!vectors.length) unindexed++;
        if (!vector) {
          if (keyword)
            hits.push({
              ...asset,
              score: terms.reduce((score, term) => {
                const name = asset.name.toLocaleLowerCase();
                return (
                  score +
                  (name === term
                    ? 5
                    : name.startsWith(term)
                      ? 4
                      : name.includes(term)
                        ? 3
                        : asset.tags.some((tag) =>
                              tag.toLocaleLowerCase().includes(term),
                            )
                          ? 2
                          : 1)
                );
              }, 0),
              start: null,
              end: null,
            });
          continue;
        }
        let best = -1,
          start: number | null = null,
          end: number | null = null;
        for (const row of vectors) {
          const score = similarity(vector, JSON.parse(row.vector));
          if (score > best) {
            best = score;
            start = row.start;
            end = row.end;
          }
        }
        if (best >= 0 || keyword)
          hits.push({
            ...asset,
            score: (best < 0 ? 0 : best) + (keyword ? 0.12 : 0),
            start,
            end,
          });
      }
    }
    hits.sort((a, b) => {
      let difference = 0;
      if (r.sort === "name")
        difference = a.name.localeCompare(b.name, undefined, { numeric: true });
      else if (r.sort === "size") difference = b.size - a.size;
      else if (r.sort === "oldest")
        difference = a.createdAt.localeCompare(b.createdAt);
      else if (r.sort === "default" && terms.length)
        difference =
          b.score - a.score || b.createdAt.localeCompare(a.createdAt);
      else difference = b.createdAt.localeCompare(a.createdAt);
      return difference || a.id.localeCompare(b.id);
    });
    return {
      hits: hits.slice(r.offset, r.offset + r.limit),
      total: hits.length,
      unindexed,
    };
  }
  private tick() {
    if (this.closed) return;
    for (const lib of this.libraries.values()) {
      if (this.faulted.has(lib.id) || this.exporting.has(lib.id)) continue;
      try {
        for (const task of lib.tasks()) {
          if (this.running.size >= this.state.settings.concurrency) return;
          if (
            this.running.has(task.id) ||
            !["queued", "retrying"].includes(task.status) ||
            task.nextRunAt > Date.now()
          )
            continue;
          const abort = new AbortController();
          task.status = "running";
          lib.saveTask(task);
          const promise = Promise.resolve()
            .then(() => this.process(lib, task, abort.signal))
            .catch((e) => {
              this.errors.set(lib.id, message(e));
              this.faulted.add(lib.id);
            })
            .finally(() => this.running.delete(task.id));
          this.running.set(task.id, { abort, promise, libraryId: lib.id });
        }
      } catch (e) {
        this.errors.set(lib.id, message(e));
        this.faulted.add(lib.id);
      }
    }
  }
  private async process(lib: LibraryDB, task: Task, signal: AbortSignal) {
    try {
      let asset = lib.asset(task.assetId);
      const source = this.embeddingSource(this.state.settings);
      const { settings } = source;
      const segmentsPath = join(
        lib.root,
        "previews",
        asset.id,
        "segments.json",
      );
      const fp = fingerprint(settings);
      let segments: Segment[] = [];
      if (task.stage !== "preview") {
        try {
          const cached = JSON.parse(await readFile(segmentsPath, "utf8"));
          if (cached.fingerprint === fp && Array.isArray(cached.segments))
            segments = cached.segments;
          else task.stage = "preview";
        } catch {
          task.stage = "preview";
        }
      }
      if (task.stage === "preview") {
        await this.objects(lib).hydrate(asset.relativePath, signal);
        const result = await prepare(lib.root, asset, settings, signal);
        signal.throwIfAborted();
        segments = result.segments;
        await atomicJSON(segmentsPath, { fingerprint: fp, segments });
        asset = {
          ...lib.asset(asset.id),
          thumbnail: result.thumbnail,
          duration: result.duration,
        };
        lib.saveAsset(asset);
        task.stage = lib.storage.mode === "s3" ? "upload" : "embed";
        task.progress = 20;
        lib.saveTask(task);
      }
      if (task.stage === "upload") {
        const objects = this.objects(lib);
        const paths = [
          asset.relativePath,
          ...new Set(
            segments.map((s) => s.path).filter((p) => p !== asset.relativePath),
          ),
          `previews/${asset.id}/segments.json`,
        ];
        let savedAt = 0;
        for (let i = 0; i < paths.length; i++) {
          await objects.upload(paths[i], signal, (loaded, total) => {
            task.progress =
              20 +
              Math.round(
                ((i + loaded / Math.max(1, total)) / paths.length) * 20,
              );
            if (Date.now() - savedAt > 500 && !signal.aborted) {
              lib.saveTask(task);
              savedAt = Date.now();
            }
          });
        }
        task.stage = "embed";
        lib.saveTask(task);
        if (lib.storage.mode === "s3")
          await unlink(safePath(lib.root, asset.relativePath)).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
      }
      const key = await source.requireKey();
      let completed = 0;
      for (const segment of segments) {
        signal.throwIfAborted();
        if (
          !lib.db
            .prepare(
              "SELECT 1 FROM vectors WHERE asset_id=? AND segment=? AND fingerprint=?",
            )
            .get(asset.id, segment.index, fp)
        ) {
          await this.objects(lib).hydrate(segment.path, signal);
          const vector = await embed(
            settings,
            key,
            { image: await imageData(lib.root, segment) },
            signal,
            this.fetcher,
          );
          signal.throwIfAborted();
          lib.db
            .prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)")
            .run(
              asset.id,
              segment.index,
              fp,
              segment.start,
              segment.end,
              JSON.stringify(vector),
            );
        }
        task.progress = 20 + Math.round((++completed / segments.length) * 80);
        lib.saveTask(task);
      }
      signal.throwIfAborted();
      task.status = "completed";
      task.stage = "done";
      task.error = null;
      task.progress = 100;
      lib.transaction(() => {
        lib.saveTask(task);
        lib.saveAsset({ ...lib.asset(asset.id), status: "ready" });
        lib.notice(`已完成：${task.name}`);
      });
    } catch (e) {
      const current = lib.tasks().find((t) => t.id === task.id);
      if (!current) return;
      if (signal.aborted) {
        if (current.status === "running") {
          current.status = "queued";
          lib.saveTask(current);
        }
        return;
      }
      current.attempts++;
      current.error = message(e);
      if (
        e instanceof WorkError &&
        e.retryable &&
        current.attempts <= this.state.settings.maxRetries
      ) {
        current.status = "retrying";
        current.nextRunAt =
          Date.now() +
          Math.max(
            e.retryAfter,
            Math.min(60000, 1000 * 2 ** current.attempts) + Math.random() * 500,
          );
      } else {
        current.status = "failed";
        lib.notice(`处理失败：${task.name}。${current.error}`);
      }
      lib.saveTask(current);
      lib.saveAsset({ ...lib.asset(task.assetId), status: "pending" });
    }
  }
  private async stopLibrary(id: string) {
    const jobs = [...this.running.values()].filter((x) => x.libraryId === id);
    for (const job of jobs) job.abort.abort();
    await Promise.all(jobs.map((j) => j.promise));
  }
  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    await this.imports.dispose();
    await this.transfers.dispose();
    for (const job of this.running.values()) job.abort.abort();
    await Promise.allSettled([...this.running.values()].map((x) => x.promise));
    await Promise.allSettled([...this.locked.values()]);
    for (const lib of this.libraries.values()) await lib.close();
    this.libraries.clear();
  }
}
export function message(e: unknown) {
  if (e instanceof WorkError) return e.message;
  if (e instanceof Error) {
    if ((e as NodeJS.ErrnoException).code === "ENOSPC")
      return "磁盘空间不足，请清理空间后重试";
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return "文件不存在，请检查库位置和原始素材";
    if (
      (e as NodeJS.ErrnoException).code === "EACCES" ||
      (e as NodeJS.ErrnoException).code === "EPERM"
    )
      return "没有文件访问权限，请检查文件夹权限";
    return e.message.replace(/(Bearer\s+)[^\s]+/gi, "$1[已隐藏]").slice(0, 300);
  }
  return "处理失败，请重试";
}
