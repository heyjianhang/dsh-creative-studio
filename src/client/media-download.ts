import type { CachedMedia } from "./media-cache.ts";

type Lease = { promise: Promise<CachedMedia>; release(): void };
export type DownloadTask = {
  id: number;
  key: string;
  name: string;
  status: "preparing" | "ready" | "saving" | "error";
  error?: string;
  file?: CachedMedia;
};
type Pending = {
  task: DownloadTask;
  lease: Lease;
  done(saved: boolean): void;
  promise: Promise<boolean>;
};

/** One queue owns the prepared file until the user saves or cancels it. */
export class MediaDownloads {
  private queue: Pending[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.queue[0]?.task;
  private publish() {
    this.listeners.forEach((listener) => listener());
  }
  prepare(key: string, name: string, load: () => Lease): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const existing = this.queue.find((entry) => entry.task.key === key);
    if (existing) return existing.promise;
    let done!: (saved: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      done = resolve;
    });
    const entry: Pending = {
      task: { id: ++this.sequence, key, name, status: "preparing" },
      lease: load(),
      done,
      promise,
    };
    this.queue.push(entry);
    this.publish();
    void entry.lease.promise.then(
      (file) => {
        if (!this.queue.includes(entry)) return;
        entry.task = { ...entry.task, file, status: "ready" };
        this.publish();
      },
      (error) => {
        if (!this.queue.includes(entry)) return;
        entry.task = {
          ...entry.task,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
        this.publish();
      },
    );
    return promise;
  }
  cancel(id: number) {
    const entry = this.queue.find((entry) => entry.task.id === id);
    if (entry && entry.task.status !== "saving") this.finish(entry, false);
  }
  async save(
    id: number,
    name: string,
    write: (file: CachedMedia, name: string) => Promise<"saved" | "browser">,
  ) {
    const entry = this.queue.find((entry) => entry.task.id === id);
    if (!entry?.task.file || entry.task.status !== "ready") return;
    const file = entry.task.file;
    entry.task = { ...entry.task, status: "saving", error: undefined };
    this.publish();
    try {
      const outcome = await write(file, name);
      if (!this.queue.includes(entry)) return;
      this.finish(entry, true);
      return outcome;
    } catch (error) {
      if (!this.queue.includes(entry)) return;
      entry.task = {
        ...entry.task,
        status: "ready",
        error:
          error instanceof Error && error.name === "AbortError"
            ? undefined
            : error instanceof Error
              ? error.message
              : String(error),
      };
      this.publish();
    }
  }
  private finish(entry: Pending, saved: boolean) {
    if (!this.queue.includes(entry)) return;
    this.queue = this.queue.filter((value) => value !== entry);
    entry.lease.release();
    entry.done(saved);
    this.publish();
  }
  clear() {
    for (const entry of [...this.queue]) this.finish(entry, false);
  }
  dispose() {
    this.closed = true;
    this.clear();
    this.listeners.clear();
  }
}

export type SaveFilePicker = (options: { suggestedName: string }) => Promise<{
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
}>;
export async function savePickedFile(
  picker: SaveFilePicker,
  file: CachedMedia,
  name: string,
): Promise<"saved"> {
  const handle = await picker({ suggestedName: name });
  const stream = await handle.createWritable();
  try {
    await stream.write(file.blob);
    await stream.close();
    return "saved";
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}
export function safeDownloadName(name: string) {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim()
      .slice(0, 240) || "download"
  );
}
