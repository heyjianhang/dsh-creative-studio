import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  open,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  transferSchema,
  type Transfer,
  type Input,
} from "../shared/contracts.ts";
import { atomicJSON, now } from "./storage.ts";
import { WorkError } from "./ark.ts";

/** Machine-owned durable jobs: they outlive any settings dialog and pause on restart. */
export class Transfers {
  rows: Transfer[] = [];
  private active?: {
    id: string;
    abort: AbortController;
    promise: Promise<void>;
  };
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private uploadLocks = new Map<string, Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly execute: (
      job: Transfer,
      signal: AbortSignal,
      progress: (n: number, detail: string) => void,
    ) => Promise<string>,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true });
    try {
      this.rows = transferSchema
        .array()
        .parse(
          JSON.parse(await readFile(join(this.root, "jobs.json"), "utf8")),
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new WorkError("传输任务记录无法读取，已保留原文件");
    }
    for (const row of this.rows)
      if (["running", "queued"].includes(row.status)) {
        row.status = "paused";
        row.error = "上次传输中断，点击重试继续";
      }
    await this.save();
  }
  private save() {
    const rows = structuredClone(this.rows);
    const next = this.writes
      .catch(() => {})
      .then(() => atomicJSON(join(this.root, "jobs.json"), rows));
    this.writes = next;
    return next;
  }
  async add(
    input: Omit<
      Transfer,
      "id" | "status" | "progress" | "detail" | "error" | "updatedAt"
    >,
  ) {
    if (
      this.rows.filter((x) => ["queued", "running"].includes(x.status))
        .length >= 20
    )
      throw new WorkError("等待中的迁移任务过多，请稍后再试");
    const row: Transfer = {
      ...input,
      id: randomUUID(),
      status: "queued",
      progress: 0,
      detail: "等待处理",
      error: null,
      updatedAt: now(),
    };
    this.rows.unshift(row);
    await this.save();
    this.tick();
    return { id: row.id };
  }
  async control(r: Input<"transfer">) {
    const row = this.rows.find((x) => x.id === r.id);
    if (!row) throw new WorkError("传输任务不存在");
    if (r.action === "cancel") {
      if (row.status === "completed") throw new WorkError("任务已经完成");
      row.status = "cancelled";
      if (this.active?.id === row.id) {
        this.active.abort.abort();
        await this.active.promise;
      }
    } else {
      if (["running", "queued", "completed"].includes(row.status))
        throw new WorkError("任务正在处理或已完成");
      row.status = "queued";
      row.error = null;
      row.progress = 0;
      row.acknowledged = false;
    }
    row.updatedAt = now();
    await this.save();
    this.tick();
    return { ok: true as const };
  }
  private tick() {
    if (this.active || this.closing) return;
    const row = this.rows.find((x) => x.status === "queued");
    if (!row) return;
    const abort = new AbortController();
    row.status = "running";
    const promise = (async () => {
      try {
        await this.save();
        const result = await this.execute(row, abort.signal, (n, detail) => {
          row.progress = Math.min(99, Math.max(0, n));
          row.detail = detail;
        });
        row.result = result;
        row.status = "completed";
        row.progress = 100;
        row.detail = "已完成";
        row.error = null;
      } catch (e) {
        if (abort.signal.aborted) {
          if (row.status !== "cancelled") row.status = "paused";
          row.error = row.status === "paused" ? "传输已暂停，可重试" : null;
        } else {
          row.status = "failed";
          const code = (e as NodeJS.ErrnoException).code;
          row.error =
            code === "ENOSPC"
              ? "磁盘空间不足，请清理空间后重试"
              : code === "ENOENT"
                ? "源文件或目标文件夹不存在，请检查路径"
                : ["EACCES", "EPERM"].includes(code ?? "")
                  ? "没有文件访问权限，请检查文件夹权限"
                  : (e as Error).name === "ZodError"
                    ? "ZIP 素材目录不符合当前格式，请检查导出包"
                    : e instanceof Error
                      ? e.message.slice(0, 300)
                      : "传输失败，请重试";
        }
      } finally {
        row.updatedAt = now();
        await this.save();
      }
    })()
      .catch(() => {
        row.status = "failed";
        row.error = "任务记录无法保存，请检查磁盘空间";
      })
      .finally(() => {
        this.active = undefined;
        this.tick();
      });
    this.active = { id: row.id, abort, promise };
  }
  async acknowledge(ids: string[]) {
    for (const row of this.rows)
      if (ids.includes("transfer-" + row.id)) row.acknowledged = true;
    await this.save();
  }
  archivePath(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new WorkError("ZIP 上传身份不合法");
    return join(this.root, id + ".zip");
  }
  async upload(r: Input<"archiveUpload">) {
    const id = r.id ?? randomUUID();
    const previous = this.uploadLocks.get(id) ?? Promise.resolve();
    const action = previous
      .catch(() => {})
      .then(async () => {
        const path = this.archivePath(id),
          info = path + ".json";
        if (r.action === "begin") {
          if (!r.size) throw new WorkError("请选择 ZIP 文件");
          await writeFile(path, "", { flag: "wx", mode: 0o600 });
          await atomicJSON(info, { size: r.size });
          return { id, offset: 0 };
        }
        if (this.rows.some((x) => x.archiveId === id))
          throw new WorkError("ZIP 已加入迁移队列");
        if (r.action === "cancel") {
          await unlink(path).catch(() => {});
          await unlink(info).catch(() => {});
          return { id, offset: 0 };
        }
        const { size } = JSON.parse(await readFile(info, "utf8"));
        if (!r.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data))
          throw new WorkError("ZIP 分块不合法");
        const data = Buffer.from(r.data, "base64"),
          offset = (await stat(path)).size;
        if (!data.length || data.length > 1024 ** 2 || r.offset === undefined)
          throw new WorkError("ZIP 分块不合法");
        const file = await open(path, "r+");
        try {
          if (r.offset < offset) {
            const buffer = Buffer.alloc(data.length);
            await file.read(buffer, 0, data.length, r.offset);
            if (!buffer.equals(data)) throw new WorkError("ZIP 重复分块不一致");
            return { id, offset };
          }
          if (r.offset !== offset || offset + data.length > size)
            throw new WorkError("ZIP 分块偏移不一致");
          await file.write(data, 0, data.length, offset);
          await file.sync();
          return { id, offset: offset + data.length };
        } finally {
          await file.close();
        }
      });
    this.uploadLocks.set(id, action);
    try {
      return await action;
    } finally {
      if (this.uploadLocks.get(id) === action) this.uploadLocks.delete(id);
    }
  }
  async ready(id: string) {
    const path = this.archivePath(id),
      { size } = JSON.parse(await readFile(path + ".json", "utf8"));
    if ((await stat(path)).size !== size)
      throw new WorkError("ZIP 尚未上传完整");
  }
  async dispose() {
    this.closing = true;
    this.active?.abort.abort();
    await this.active?.promise;
    await this.writes;
    await Promise.allSettled(this.uploadLocks.values());
  }
}
