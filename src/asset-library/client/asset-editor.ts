import type { Asset } from "../shared/contracts.ts";
export type AssetPatch = Partial<
  Pick<Asset, "tags" | "notes" | "favorite" | "collectionIds">
>;
export type EditTarget = Pick<Asset, "libraryId" | "id" | "name">;
export type EditState = {
  target: EditTarget;
  draft: AssetPatch;
  status: "waiting" | "saving" | "saved" | "error";
  error?: string;
};
export type EditorSnapshot = Record<string, EditState>;
export const editKey = (a: Pick<Asset, "libraryId" | "id">) =>
  a.libraryId + ":" + a.id;
type StoredEdit = { target: EditTarget; patch: AssetPatch };

/** One writer per asset. Owns pending edits independently of React selection. */
export class AssetEditor {
  private state: EditorSnapshot = {};
  private pending = new Map<string, AssetPatch>();
  private active = new Map<string, AssetPatch>();
  private running = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(
    private options: {
      write(target: EditTarget, patch: AssetPatch): Promise<unknown>;
      publish(state: EditorSnapshot): void;
      refresh(): Promise<void>;
      persist?(edits: StoredEdit[]): void;
      delay?: number;
    },
  ) {}
  restore(edits: StoredEdit[]) {
    for (const row of edits) {
      if (!row?.target?.id || !row.target.libraryId || !row.patch) continue;
      const key = editKey(row.target);
      this.pending.set(key, row.patch);
      this.state[key] = {
        target: row.target,
        draft: row.patch,
        status: "error",
        error: "上次修改尚未确认保存，请重试",
      };
    }
    this.publish();
  }
  stage(target: EditTarget, patch: AssetPatch, immediate = false) {
    if (this.stopped) return;
    const key = editKey(target);
    this.pending.set(key, { ...this.pending.get(key), ...patch });
    this.state[key] = {
      target,
      draft: { ...this.state[key]?.draft, ...patch },
      status: "waiting",
    };
    clearTimeout(this.timers.get(key));
    this.publish();
    if (immediate) void this.flush(key);
    else
      this.timers.set(
        key,
        setTimeout(() => {
          void this.flush(key);
        }, this.options.delay ?? 500),
      );
  }
  async flush(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (this.stopped) return;
    if (this.running.has(key)) return this.running.get(key);
    const promise = Promise.resolve()
      .then(async () => {
        while (!this.stopped && this.pending.has(key)) {
          const batch = this.pending.get(key)!;
          this.pending.delete(key);
          this.active.set(key, batch);
          this.state[key] = {
            ...this.state[key],
            status: "saving",
            error: undefined,
          };
          this.publish();
          try {
            await this.options.write(this.state[key].target, batch);
          } catch (e) {
            this.pending.set(key, { ...batch, ...this.pending.get(key) });
            this.active.delete(key);
            this.state[key] = {
              ...this.state[key],
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            };
            this.publish();
            return;
          }
          this.active.delete(key);
          this.state[key] = {
            ...this.state[key],
            status: this.pending.has(key) ? "waiting" : "saved",
          };
          this.publish();
          await this.options.refresh().catch(() => {});
        }
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }
  flushAll() {
    return Promise.all(
      [...new Set([...this.pending.keys(), ...this.running.keys()])].map(
        (key) => this.flush(key),
      ),
    );
  }
  hasPending() {
    return this.pending.size > 0 || this.active.size > 0;
  }
  dispose() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.publish();
  }
  private publish() {
    const keys = new Set([...this.pending.keys(), ...this.active.keys()]);
    try {
      this.options.persist?.(
        [...keys].map((key) => ({
          target: this.state[key].target,
          patch: { ...this.active.get(key), ...this.pending.get(key) },
        })),
      );
    } catch {
      /* Network saves remain authoritative if browser storage is unavailable. */
    }
    this.options.publish({ ...this.state });
  }
}
