import type { Project } from "../shared/contracts.ts";
export class Editor {
  current: Project | undefined;
  status: "saved" | "saving" | "error" = "saved";
  error = "";
  private past: Project[] = [];
  private future: Project[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | undefined;
  private version = 0;
  private savedVersion = 0;
  constructor(
    private write: (p: Project) => Promise<Project>,
    private publish: () => void,
    private persist: (p: Project | undefined) => void,
  ) {}
  load(p: Project) {
    this.current = structuredClone(p);
    this.version = 0;
    this.savedVersion = 0;
    this.past = [];
    this.future = [];
    this.error = "";
    this.status = "saved";
    this.publish();
  }
  change(next: Project, history = true) {
    if (!this.current) return;
    if (history) {
      this.past.push(structuredClone(this.current));
      this.past = this.past.slice(-50);
      this.future = [];
    }
    this.current = { ...next, revision: this.current.revision };
    this.version++;
    this.status = "saving";
    this.error = "";
    this.persist(this.current);
    this.publish();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 500);
  }
  get dirty() {
    return this.version !== this.savedVersion;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  undo() {
    if (!this.current || !this.past.length) return;
    this.future.push(structuredClone(this.current));
    this.change(
      { ...this.past.pop()!, revision: this.current.revision },
      false,
    );
  }
  redo() {
    if (!this.current || !this.future.length) return;
    this.past.push(structuredClone(this.current));
    this.change(
      { ...this.future.pop()!, revision: this.current.revision },
      false,
    );
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.flight) {
      await this.flight;
      if (this.dirty) return this.flush();
      return;
    }
    if (!this.dirty || !this.current) return;
    const version = this.version,
      submitted = structuredClone(this.current);
    this.status = "saving";
    this.publish();
    this.flight = (async () => {
      try {
        const p = await this.write(submitted);
        this.savedVersion = version;
        if (this.current?.id === p.id) {
          this.current = {
            ...this.current,
            revision: p.revision,
            updatedAt: p.updatedAt,
          };
          if (!this.dirty) {
            this.status = "saved";
            this.persist(undefined);
          } else this.persist(this.current);
        }
        this.error = "";
      } catch (e) {
        this.status = "error";
        this.error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        this.flight = undefined;
        this.publish();
      }
    })();
    await this.flight;
    if (this.dirty) return this.flush();
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
