export type CachedMedia = { src: string; blob: Blob };
type Entry = {
  promise: Promise<CachedMedia>;
  value?: CachedMedia;
  abort: AbortController;
  refs: number;
  used: number;
  cancel?: ReturnType<typeof setTimeout>;
};

/** Session-owned URLs: consumers release leases, never each other's URLs. */
export class MediaCache {
  private entries = new Map<string, Entry>();
  private closed = false;
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    private budget = 256 * 1024 ** 2,
    private ttl = 10 * 60_000,
    private urls = {
      create: (blob: Blob) => URL.createObjectURL(blob),
      revoke: (src: string) => URL.revokeObjectURL(src),
    },
  ) {
    this.sweep = setInterval(() => this.trim(), Math.min(ttl, 60_000));
  }
  peek(key: string) {
    return this.entries.get(key)?.value;
  }
  acquire(key: string, load: (signal: AbortSignal) => Promise<Blob>) {
    if (this.closed) throw new Error("媒体会话已关闭");
    let entry = this.entries.get(key);
    if (!entry) {
      const abort = new AbortController();
      const fresh: Entry = {
        abort,
        refs: 0,
        used: Date.now(),
        promise: undefined!,
      };
      this.entries.set(key, fresh);
      fresh.promise = Promise.resolve()
        .then(() => load(abort.signal))
        .then((blob) => {
          abort.signal.throwIfAborted();
          if (this.closed || this.entries.get(key) !== fresh)
            throw new DOMException("媒体读取已取消", "AbortError");
          const value = { src: this.urls.create(blob), blob };
          fresh.value = value;
          fresh.used = Date.now();
          this.trim();
          return value;
        })
        .catch((error) => {
          if (this.entries.get(key) === fresh) this.drop(key, fresh);
          throw error;
        });
      // A consumer may close before a queued/aborted read settles.
      void fresh.promise.catch(() => {});
      entry = fresh;
    }
    clearTimeout(entry.cancel);
    entry.refs++;
    entry.used = Date.now();
    const retained = entry;
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        retained.refs--;
        if (this.closed || this.entries.get(key) !== retained) return;
        retained.used = Date.now();
        if (!retained.refs && !retained.value) {
          retained.cancel = setTimeout(() => {
            if (!retained.refs && this.entries.get(key) === retained)
              this.drop(key, retained);
          }, 1000);
        }
        this.trim();
      },
    };
  }
  seed(key: string, blob: Blob) {
    if (this.closed || this.entries.has(key)) return;
    const value = { src: this.urls.create(blob), blob };
    this.entries.set(key, {
      abort: new AbortController(),
      refs: 0,
      used: Date.now(),
      value,
      promise: Promise.resolve(value),
    });
    this.trim();
  }
  private drop(key: string, entry: Entry) {
    clearTimeout(entry.cancel);
    entry.abort.abort();
    if (entry.value) this.urls.revoke(entry.value.src);
    this.entries.delete(key);
  }
  private trim() {
    const idle = [...this.entries]
      .filter(([, entry]) => !entry.refs && entry.value)
      .sort((a, b) => a[1].used - b[1].used);
    let bytes = idle.reduce(
      (sum, [, entry]) => sum + entry.value!.blob.size,
      0,
    );
    let count = idle.length;
    for (const [key, entry] of idle) {
      if (
        bytes <= this.budget &&
        count <= 96 &&
        Date.now() - entry.used < this.ttl
      )
        break;
      bytes -= entry.value!.blob.size;
      count--;
      this.drop(key, entry);
    }
  }
  dispose() {
    this.closed = true;
    clearInterval(this.sweep);
    for (const [key, entry] of this.entries) this.drop(key, entry);
  }
}

/** Bound expensive file reads across the whole session, not per thumbnail. */
export class MediaReadQueue {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit = 3) {}
  async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const next = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.waiting = this.waiting.filter((item) => item !== next);
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        this.waiting.push(next);
      });
    }
    // A queue slot is reserved by the completing reader before waking us.
    else this.active++;
    try {
      signal.throwIfAborted();
      return await read();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
