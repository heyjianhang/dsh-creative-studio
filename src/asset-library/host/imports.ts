import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  readdir,
  realpath,
  mkdir,
  readFile,
  open,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { atomicJSON, now } from "./storage.ts";
import { mediaTypes } from "./media.ts";
import type { Task } from "../shared/contracts.ts";

const fileSchema = z.object({
  path: z.string(),
  size: z.number(),
  mtime: z.number(),
  status: z.enum(["pending", "added", "duplicate", "failed"]),
  uploadId: z.string().optional(),
  assetId: z.string().optional(),
  error: z.string().optional(),
});
const jobSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  name: z.string(),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  files: z.array(fileSchema),
  skipped: z.number(),
  tags: z.array(z.string()),
  collectionIds: z.array(z.string()),
  updatedAt: z.string(),
  error: z.string().nullable(),
  acknowledged: z.boolean().default(false),
});
type ImportJob = z.infer<typeof jobSchema>;
type ImportFile = z.infer<typeof fileSchema>;
type Runner = {
  excludedRoots(): string[];
  validate(libraryId: string, collectionIds: string[]): void;
  begin(libraryId: string, name: string, size: number): Promise<string>;
  ready(libraryId: string, id: string): boolean;
  chunk(
    libraryId: string,
    id: string,
    offset: number,
    data: Buffer,
  ): Promise<number>;
  finish(
    libraryId: string,
    id: string,
    signal: AbortSignal,
  ): Promise<{ assetId: string; duplicate: boolean }>;
  decorate(
    libraryId: string,
    id: string,
    tags: string[],
    collectionIds: string[],
  ): Promise<void>;
};
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Durable local file import; embedding and S3 work remain owned by LibraryService. */
export class Imports {
  private jobs: ImportJob[] = [];
  private active?: {
    id: string;
    abort: AbortController;
    promise: Promise<void>;
  };
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private runner: Runner,
  ) {}
  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.jobs = z
        .array(jobSchema)
        .parse(
          JSON.parse(await readFile(join(this.directory, "jobs.json"), "utf8")),
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("导入队列无法读取，原记录已保留");
    }
    for (const job of this.jobs)
      if (["running", "queued"].includes(job.status)) {
        job.status = "paused";
        job.error = "上次导入中断，恢复后继续；已导入文件不会重复添加";
      }
    await this.save();
  }
  private save() {
    const value = structuredClone(this.jobs);
    const next = this.writes
      .catch(() => {})
      .then(() => atomicJSON(join(this.directory, "jobs.json"), value));
    this.writes = next;
    return next;
  }
  tasks(): Task[] {
    return this.jobs.map((j) => ({
      id: j.id,
      libraryId: j.libraryId,
      assetId: "",
      name: j.name,
      stage: "import",
      status: j.status,
      progress: j.files.length
        ? Math.floor(
            (j.files.filter((f) => f.status !== "pending").length /
              j.files.length) *
              100,
          )
        : 0,
      attempts: 0,
      nextRunAt: 0,
      updatedAt: j.updatedAt,
      error: j.error,
    }));
  }
  notices() {
    return this.jobs
      .filter(
        (j) => !j.acknowledged && ["completed", "failed"].includes(j.status),
      )
      .map((j) => {
        const summary = this.summary(j);
        return {
          id: j.id,
          text: `导入${j.status === "completed" ? "完成" : "结束"}：新增 ${summary.added}，重复 ${summary.duplicates}，失败 ${summary.failed}`,
          createdAt: j.updatedAt,
        };
      });
  }
  async acknowledge(ids: string[]) {
    for (const j of this.jobs) if (ids.includes(j.id)) j.acknowledged = true;
    await this.save();
  }
  busy(libraryId: string) {
    return this.jobs.some(
      (j) =>
        j.libraryId === libraryId && ["running", "queued"].includes(j.status),
    );
  }
  has(id: string) {
    return this.jobs.some((j) => j.id === id);
  }
  private summary(j: ImportJob) {
    return {
      id: j.id,
      libraryId: j.libraryId,
      name: j.name,
      status: j.status,
      total: j.files.length,
      added: j.files.filter((f) => f.status === "added").length,
      duplicates: j.files.filter((f) => f.status === "duplicate").length,
      failed: j.files.filter((f) => f.status === "failed").length,
      pending: j.files.filter((f) => f.status === "pending").length,
      skipped: j.skipped,
      error: j.error,
      updatedAt: j.updatedAt,
    };
  }
  list(libraryId?: string) {
    return this.jobs
      .filter((j) => !libraryId || j.libraryId === libraryId)
      .map((j) => this.summary(j));
  }
  get(id: string, offset = 0, limit = 50) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error("导入任务不存在");
    return {
      ...this.summary(job),
      files: structuredClone(job.files.slice(offset, offset + limit)),
      offset,
    };
  }
  async scan(
    input: {
      libraryId: string;
      paths: string[];
      recursive: boolean;
      tags: string[];
      collectionIds: string[];
    },
    signal: AbortSignal,
  ) {
    this.runner.validate(input.libraryId, input.collectionIds);
    const excluded = await Promise.all(
      this.runner.excludedRoots().map((p) => realpath(p).catch(() => p)),
    );
    const files: ImportFile[] = [],
      seen = new Set<string>();
    let skipped = 0,
      visited = 0;
    const walk = async (path: string, descend: boolean) => {
      signal.throwIfAborted();
      if (++visited > 10000)
        throw new Error("单批扫描超过 10000 个目录条目，请按子文件夹分批导入");
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        skipped++;
        return;
      }
      const canonical = await realpath(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      if (excluded.some((root) => within(root, canonical))) {
        skipped++;
        return;
      }
      if (info.isDirectory()) {
        if (
          (
            await lstat(join(canonical, "library.json")).catch(() => null)
          )?.isFile()
        ) {
          skipped++;
          return;
        }
        const entries = await readdir(canonical, { withFileTypes: true });
        for (const entry of entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (entry.name.startsWith(".") || (!descend && entry.isDirectory())) {
            skipped++;
            continue;
          }
          await walk(join(canonical, entry.name), descend);
        }
      } else if (
        info.isFile() &&
        mediaTypes[extname(path).toLowerCase()] &&
        info.size > 0 &&
        info.size <= 100 * 1024 ** 3
      ) {
        files.push({
          path: canonical,
          size: info.size,
          mtime: info.mtimeMs,
          status: "pending",
        });
      } else skipped++;
    };
    for (const path of input.paths) {
      if (!isAbsolute(path)) throw new Error("导入源必须是本机绝对路径");
      await walk(path, input.recursive);
    }
    signal.throwIfAborted();
    const job: ImportJob = {
      id: "import-" + randomUUID(),
      libraryId: input.libraryId,
      name: `导入 · ${input.paths.length === 1 ? basename(input.paths[0]) : `${input.paths.length} 个来源`}`,
      files,
      skipped,
      tags: input.tags,
      collectionIds: input.collectionIds,
      status: files.length ? "paused" : "completed",
      updatedAt: now(),
      error: null,
      acknowledged: !files.length,
    };
    this.jobs.push(job);
    await this.save();
    return this.get(job.id);
  }
  async control(
    id: string,
    action: "pause" | "resume" | "retry" | "cancel",
    libraryId?: string,
  ) {
    const job = this.jobs.find(
      (j) => j.id === id && (!libraryId || j.libraryId === libraryId),
    );
    if (!job) throw new Error("导入任务不存在或不属于当前库");
    if (action === "pause" || action === "cancel") {
      job.status = action === "pause" ? "paused" : "cancelled";
      if (this.active?.id === id) {
        this.active.abort.abort();
        await this.active.promise;
      }
    } else {
      if (this.closed) throw new Error("插件正在关闭");
      if (this.active?.id === id) return this.get(id);
      this.runner.validate(job.libraryId, job.collectionIds);
      if (action === "retry")
        for (const file of job.files)
          if (file.status === "failed") {
            file.status = "pending";
            delete file.error;
          }
      if (!job.files.some((f) => f.status === "pending")) return this.get(id);
      job.status = "queued";
      job.error = null;
      job.acknowledged = false;
    }
    job.updatedAt = now();
    await this.save();
    this.tick();
    return this.get(id);
  }
  private tick() {
    if (this.closed || this.active) return;
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) return;
    const abort = new AbortController();
    const promise = this.run(job, abort.signal)
      .catch((e) => {
        job.status = "failed";
        job.error =
          e instanceof Error ? e.message.slice(0, 300) : "导入队列保存失败";
      })
      .finally(() => {
        this.active = undefined;
        this.tick();
      });
    this.active = { id: job.id, abort, promise };
  }
  private async run(job: ImportJob, signal: AbortSignal) {
    try {
      job.status = "running";
      await this.save();
      for (const file of job.files) {
        if (file.status !== "pending") continue;
        signal.throwIfAborted();
        try {
          if (
            !file.uploadId ||
            !this.runner.ready(job.libraryId, file.uploadId)
          ) {
            const handle = await open(
              file.path,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            try {
              const info = await handle.stat();
              if (
                !info.isFile() ||
                info.size !== file.size ||
                info.mtimeMs !== file.mtime
              )
                throw new Error("源文件已改变，请重新扫描此文件");
              if (!file.uploadId) {
                file.uploadId = await this.runner.begin(
                  job.libraryId,
                  basename(file.path),
                  file.size,
                );
                await this.save();
              }
              const buffer = Buffer.alloc(Math.min(1024 ** 2, file.size));
              let offset = 0;
              // Replaying a committed chunk is idempotent in the existing upload service.
              while (offset < file.size) {
                signal.throwIfAborted();
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, file.size - offset),
                  offset,
                );
                if (!bytesRead) throw new Error("源文件读取中断");
                offset = await this.runner.chunk(
                  job.libraryId,
                  file.uploadId,
                  offset,
                  buffer.subarray(0, bytesRead),
                );
              }
              const after = await handle.stat();
              if (after.size !== file.size || after.mtimeMs !== file.mtime)
                throw new Error("导入期间源文件改变，请重新扫描此文件");
            } finally {
              await handle.close();
            }
          }
          const result = await this.runner.finish(
            job.libraryId,
            file.uploadId!,
            signal,
          );
          file.assetId = result.assetId;
          if (!result.duplicate)
            await this.runner.decorate(
              job.libraryId,
              result.assetId,
              job.tags,
              job.collectionIds,
            );
          file.status = result.duplicate ? "duplicate" : "added";
        } catch (e) {
          signal.throwIfAborted();
          file.status = "failed";
          file.error =
            e instanceof Error ? e.message.slice(0, 300) : "导入失败";
        }
        job.updatedAt = now();
        await this.save();
      }
      job.status = job.files.some((f) => f.status === "failed")
        ? "failed"
        : "completed";
      job.error =
        job.status === "failed"
          ? "部分文件导入失败，可查看详情并重试失败项"
          : null;
    } catch (e) {
      if (signal.aborted) {
        if (job.status === "running") job.status = "paused";
      } else {
        job.status = "failed";
        job.error = e instanceof Error ? e.message.slice(0, 300) : "导入失败";
      }
    } finally {
      job.updatedAt = now();
      await this.save();
    }
  }
  async dispose() {
    this.closed = true;
    this.active?.abort.abort();
    await this.active?.promise;
    for (const job of this.jobs)
      if (job.status === "queued") job.status = "paused";
    await this.save();
  }
}
