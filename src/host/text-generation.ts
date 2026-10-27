import { randomUUID } from "node:crypto";
import type {
  Generation,
  ModelSelection,
  TextSnapshot,
} from "../shared/contracts.ts";

export interface GenerationTable {
  entries(): Iterable<readonly [string, Generation]>;
  put(id: string, value: Generation): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}
export interface PreparedText {
  selection: ModelSelection;
  snapshot: TextSnapshot;
  count: number;
}
export type TextRunner = (
  job: Generation,
  signal: AbortSignal,
  delta: (text: string) => void,
) => Promise<void>;
export class TextGenerations {
  private rows = new Map<string, Generation>();
  private aborts = new Map<string, AbortController>();
  private active = new Set<Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private preparations = new Map<
    string,
    {
      projectId: string;
      nodeId: string;
      abort: AbortController;
      promise: Promise<Generation[]>;
    }
  >();
  constructor(
    private table: GenerationTable,
    private run: TextRunner,
    private timeoutMs = 180000,
  ) {}
  private serial<T>(fn: () => Promise<T>) {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => {});
    return p;
  }
  async restore() {
    for (const [id, raw] of this.table.entries()) {
      const job = structuredClone(raw);
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.error = "宿主已重启，生成已中断，可重试";
        await this.table.put(id, job);
      }
      this.rows.set(id, job);
    }
  }
  list(projectId: string) {
    return structuredClone(
      [...this.rows.values()]
        .filter((j) => j.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }
  start(
    projectId: string,
    nodeId: string,
    batchId: string,
    prepare: (signal: AbortSignal) => Promise<PreparedText>,
  ): Promise<Generation[]> {
    if (this.closed) return Promise.reject(new Error("文本服务正在停止"));
    const pending = this.preparations.get(batchId);
    if (pending)
      return pending.projectId === projectId && pending.nodeId === nodeId
        ? pending.promise
        : Promise.reject(new Error("生成请求不匹配"));
    const previous = [...this.rows.values()].filter(
      (j) => j.batchId === batchId,
    );
    if (previous.length)
      return previous.every(
        (j) => j.projectId === projectId && j.nodeId === nodeId,
      )
        ? Promise.resolve(structuredClone(previous))
        : Promise.reject(new Error("生成请求不匹配"));
    if (
      [...this.rows.values()].some(
        (j) =>
          j.projectId === projectId &&
          j.nodeId === nodeId &&
          ["queued", "running"].includes(j.status),
      ) ||
      [...this.preparations.values()].some(
        (j) => j.projectId === projectId && j.nodeId === nodeId,
      )
    )
      return Promise.reject(new Error("当前节点仍在生成"));
    if (this.pendingCount() + 4 > 16)
      return Promise.reject(new Error("生成队列已满，请稍后再试"));
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]);
    const promise = withSignal(signal, () => prepare(signal))
      .then((data) =>
        this.serial(async () => {
          if (this.closed) throw new Error("文本服务正在停止");
          signal.throwIfAborted();
          if (![1, 2, 3, 4].includes(data.count))
            throw new Error("生成数量无效");
          const jobs: Generation[] = Array.from(
            { length: data.count },
            (_, index) => ({
              id: randomUUID(),
              batchId,
              projectId,
              nodeId,
              index,
              count: data.count,
              selection: structuredClone(data.selection),
              snapshot: structuredClone(data.snapshot),
              status: "queued",
              text: "",
              applied: false,
              createdAt: new Date().toISOString(),
            }),
          );
          try {
            for (const j of jobs) await this.table.put(j.id, j);
          } catch (error) {
            await Promise.allSettled(jobs.map((j) => this.table.delete(j.id)));
            throw error;
          }
          for (const j of jobs) this.rows.set(j.id, j);
          this.pump();
          return structuredClone(jobs);
        }),
      )
      .finally(() => this.preparations.delete(batchId));
    this.preparations.set(batchId, { projectId, nodeId, abort, promise });
    return promise;
  }
  private pendingCount() {
    return (
      [...this.rows.values()].filter((j) =>
        ["queued", "running"].includes(j.status),
      ).length +
      this.preparations.size * 4
    );
  }
  action(id: string, action: "cancel" | "retry" | "acknowledge") {
    return this.serial(async () => {
      if (this.closed) throw new Error("文本服务正在停止");
      const job = this.rows.get(id);
      if (!job) throw new Error("生成记录不存在");
      if (action === "cancel" && ["queued", "running"].includes(job.status)) {
        job.status = "cancelled";
        this.aborts.get(id)?.abort();
      }
      if (action === "acknowledge") {
        if (job.status !== "completed") throw new Error("生成尚未完成");
        const next = { ...job, applied: true };
        await this.table.put(id, structuredClone(next));
        job.applied = true;
        return structuredClone(next);
      }
      if (action === "retry") {
        if (!["failed", "cancelled"].includes(job.status))
          throw new Error("此结果无需重试");
        if (
          [...this.rows.values()].some(
            (j) =>
              j.projectId === job.projectId &&
              j.nodeId === job.nodeId &&
              j.batchId !== job.batchId &&
              ["queued", "running"].includes(j.status),
          ) ||
          [...this.preparations.values()].some(
            (j) => j.projectId === job.projectId && j.nodeId === job.nodeId,
          )
        )
          throw new Error("当前节点仍在生成");
        if (
          [...this.rows.values()].some(
            (j) =>
              j.batchId === job.batchId &&
              j.index === job.index &&
              ["queued", "running"].includes(j.status),
          )
        )
          throw new Error("正在重试此结果");
        if (this.pendingCount() >= 16) throw new Error("生成队列已满");
        const next: Generation = {
          ...structuredClone(job),
          id: randomUUID(),
          status: "queued",
          text: "",
          error: undefined,
          applied: false,
          createdAt: new Date().toISOString(),
        };
        await this.table.put(next.id, next);
        this.rows.set(next.id, next);
        this.pump();
        return structuredClone(next);
      }
      await this.table.put(job.id, structuredClone(job));
      return structuredClone(job);
    });
  }
  private pump() {
    if (this.closed) return;
    for (const job of this.rows.values()) {
      if (this.active.size >= 2) break;
      if (job.status !== "queued") continue;
      job.status = "running";
      const promise = this.execute(job).finally(() => {
        this.active.delete(promise);
        this.pump();
      });
      this.active.add(promise);
    }
  }
  private async execute(job: Generation) {
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    let lastWrite = 0;
    try {
      await this.serial(() => this.table.put(job.id, structuredClone(job)));
      abort.signal.throwIfAborted();
      await withSignal(abort.signal, () =>
        this.run(structuredClone(job), abort.signal, (text) => {
          if (abort.signal.aborted || job.status !== "running") return;
          if (job.text.length + text.length > 30000)
            throw new Error("OUTPUT_LIMIT");
          job.text += text;
          if (Date.now() - lastWrite > 800) {
            lastWrite = Date.now();
            void this.serial(() =>
              this.table.put(job.id, structuredClone(job)),
            ).catch(() => {
              job.error = "生成记录保存失败";
              abort.abort();
            });
          }
        }),
      );
      abort.signal.throwIfAborted();
      if (!job.text.trim()) throw new Error("EMPTY_OUTPUT");
      job.status = "completed";
    } catch (e) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.error = job.error ?? (timedOut ? "生成超时，可重试" : textError(e));
      }
    } finally {
      clearTimeout(timer);
      this.aborts.delete(job.id);
      try {
        await this.serial(() => this.table.put(job.id, structuredClone(job)));
      } catch {
        job.status = "failed";
        job.error = "生成记录保存失败，请检查磁盘后重试";
      }
    }
  }
  async close() {
    this.closed = true;
    for (const item of this.preparations.values()) item.abort.abort();
    await Promise.allSettled(
      [...this.preparations.values()].map((item) => item.promise),
    );
    const writes: Promise<unknown>[] = [];
    for (const job of this.rows.values()) {
      if (["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.error = "文本服务已停止，可重试";
        this.aborts.get(job.id)?.abort();
        writes.push(
          this.serial(() => this.table.put(job.id, structuredClone(job))),
        );
      }
    }
    await Promise.allSettled(this.active);
    await Promise.allSettled(writes);
    await this.tail;
  }
}
export function textError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/OUTPUT_LIMIT|max.?tokens|length|截断/i.test(message))
    return "输出超出长度限制，已保留部分文字，请缩短要求后重试";
  if (/EMPTY_OUTPUT/.test(message)) return "模型没有返回正文，可重试";
  if (/401|403|API.?key|credential|authentication/i.test(message))
    return "模型认证失败，请在 DSH 设置中检查配置";
  if (/429|rate.?limit/i.test(message)) return "模型请求过于频繁，请稍后重试";
  if (/image|图片|attachment|vision/i.test(message))
    return "图片参考处理失败，请检查图片大小和模型的图片支持";
  if (/404|model.*not|not.*model/i.test(message))
    return "模型不可用，请重新选择模型";
  return "生成中断，请检查 DSH 模型配置或网络后重试";
}

export async function withSignal<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void;
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    signal.removeEventListener("abort", listener!);
  }
}
