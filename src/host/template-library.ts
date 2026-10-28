import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  templateSchema,
  templateId,
  templateSourceSchema,
  templateQuerySchema,
  templatePurposes,
  type TemplateQuery,
  type TemplateResult,
} from "../shared/template-contracts.ts";

export const templateRegistry =
  "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/";
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  total: z.number().int().min(1).max(10000),
  sources: z
    .array(
      templateSourceSchema.extend({
        path: z.string().regex(/^sources\/[a-z0-9-]+\.json$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(30),
});
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  fetchedAt: z.iso.datetime(),
  sources: z.array(templateSourceSchema).max(30),
  prompts: z.array(templateSchema).min(1).max(10000),
});
type Snapshot = z.output<typeof snapshotSchema>;
const favoriteSchema = z.array(templateId).max(10000);
const ttl = 24 * 60 * 60 * 1000;

function callerWait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export class TemplateLibrary {
  private snapshot?: Snapshot;
  private favorites = new Set<string>();
  private ready?: Promise<void>;
  private pending?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  private failedAt = 0;
  constructor(
    private root: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async initialize() {
    this.ready ??= (async () => {
      const cache = join(this.root, "catalog.json");
      try {
        if ((await stat(cache)).size <= 20 * 1024 * 1024)
          this.snapshot = snapshotSchema.parse(
            JSON.parse(await readFile(cache, "utf8")),
          );
      } catch {
        /* A missing or invalid cache is replaced only after a valid sync. */
      }
      try {
        const file = join(this.root, "favorites.json");
        if ((await stat(file)).size <= 2 * 1024 * 1024)
          this.favorites = new Set(
            favoriteSchema.parse(JSON.parse(await readFile(file, "utf8"))),
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("模板收藏记录无法读取，请保留数据并检查文件权限");
      }
    })();
    await this.ready;
    this.abort.signal.throwIfAborted();
  }

  private async bytes(path: string, signal: AbortSignal, max: number) {
    const response = await this.fetcher(templateRegistry + path, {
      signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error("模板源暂时不可用");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new Error("模板源超过大小限制");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  private async atomic(name: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, `${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      this.abort.signal.throwIfAborted();
      await rename(temporary, join(this.root, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async download() {
    const transfer = new AbortController();
    try {
      const signal = AbortSignal.any([
        transfer.signal,
        this.abort.signal,
        AbortSignal.timeout(45000),
      ]);
      const manifest = manifestSchema.parse(
        JSON.parse(
          (await this.bytes("manifest.json", signal, 128 * 1024)).toString(),
        ),
      );
      if (
        new Set(manifest.sources.map((s) => s.id)).size !==
        manifest.sources.length
      )
        throw new Error("模板源清单重复");
      let totalBytes = 0;
      const sources = await Promise.all(
        manifest.sources.map(async (source) => {
          const bytes = await this.bytes(source.path, signal, 6 * 1024 * 1024);
          totalBytes += bytes.byteLength;
          if (totalBytes > 20 * 1024 * 1024)
            throw new Error("模板目录超过大小限制");
          if (
            createHash("sha256").update(bytes).digest("hex") !== source.sha256
          )
            throw new Error("模板源校验失败，请稍后刷新");
          const prompts = z
            .array(templateSchema)
            .max(10000)
            .parse(JSON.parse(bytes.toString()));
          if (
            prompts.length !== source.count ||
            prompts.some(
              (t) =>
                t.sourceId !== source.id || !t.id.startsWith(source.id + ":"),
            )
          )
            throw new Error("模板源记录与清单不一致");
          return prompts;
        }),
      );
      const prompts = sources.flat();
      if (
        prompts.length !== manifest.total ||
        new Set(prompts.map((t) => t.id)).size !== prompts.length
      )
        throw new Error("模板目录记录不完整");
      const snapshot: Snapshot = {
        schemaVersion: 1,
        generatedAt: manifest.generatedAt,
        fetchedAt: new Date().toISOString(),
        sources: manifest.sources.map((s) => templateSourceSchema.parse(s)),
        prompts,
      };
      await this.atomic("catalog.json", snapshot);
      this.snapshot = snapshot;
      this.failedAt = 0;
    } finally {
      transfer.abort();
    }
  }

  async search(
    raw: TemplateQuery,
    signal?: AbortSignal,
  ): Promise<TemplateResult> {
    const q = templateQuerySchema.parse(raw);
    await callerWait(this.initialize(), signal);
    if (
      q.refresh ||
      !this.snapshot ||
      (Date.now() - Date.parse(this.snapshot.fetchedAt) > ttl &&
        Date.now() - this.failedAt > 60000)
    ) {
      this.pending ??= this.download()
        .catch((error) => {
          this.failedAt = Date.now();
          if (!this.snapshot) throw error;
        })
        .finally(() => {
          this.pending = undefined;
        });
      if (q.refresh || !this.snapshot) await callerWait(this.pending, signal);
    }
    this.abort.signal.throwIfAborted();
    signal?.throwIfAborted();
    const s = this.snapshot!;
    const terms = q.query
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const items = s.prompts.filter(
      (t) =>
        (!q.favoritesOnly || this.favorites.has(t.id)) &&
        (!q.category || templatePurposes(t).includes(q.category)) &&
        (!q.source || t.sourceId === q.source) &&
        (!q.model || t.imageModel === q.model) &&
        (!terms.length ||
          terms.every((term) =>
            [t.title, t.description, t.prompt, ...t.tags]
              .join(" ")
              .toLocaleLowerCase()
              .includes(term),
          )),
    );
    const groups = s.sources
      .map((source) => items.filter((t) => t.sourceId === source.id))
      .sort((a, b) => b.length - a.length);
    const ordered =
      groups[0]?.flatMap((_, index) =>
        groups.flatMap((group) => (group[index] ? [group[index]!] : [])),
      ) ?? [];
    return {
      items: ordered.slice(q.offset, q.offset + q.limit),
      total: items.length,
      catalogTotal: s.prompts.length,
      sources: s.sources,
      models: [
        ...new Set(s.prompts.map((t) => t.imageModel).filter(Boolean)),
      ].sort(),
      favorites: [...this.favorites],
      generatedAt: s.generatedAt,
      fetchedAt: s.fetchedAt,
      stale: !!this.failedAt || Date.now() - Date.parse(s.fetchedAt) > ttl,
    };
  }

  async get(id: string, signal?: AbortSignal) {
    templateId.parse(id);
    await this.initialize();
    if (!this.snapshot) await this.search({}, signal);
    signal?.throwIfAborted();
    const item = this.snapshot?.prompts.find((item) => item.id === id);
    if (!item) throw new Error("模板已更新或不存在，请刷新模板库");
    return item;
  }

  async favorite(id: string, favorite: boolean) {
    templateId.parse(id);
    await this.initialize();
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        this.abort.signal.throwIfAborted();
        const next = new Set(this.favorites);
        favorite ? next.add(id) : next.delete(id);
        const ids = favoriteSchema.parse([...next]);
        await this.atomic("favorites.json", ids);
        this.favorites = next;
        return ids;
      });
    this.writes = write;
    return write;
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([this.pending, this.writes, this.ready]);
  }
}
