import type { Project } from "../shared/contracts.ts";
import { isProjectConflict, mergeProject } from "../shared/project-merge.ts";
export class Editor {
  current: Project | undefined;
  status: "saved" | "saving" | "error" = "saved";
  error = "";
  conflict = false;
  reloadCount = 0;
  private saved: Project | undefined;
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
    private read?: (id: string) => Promise<Project>,
  ) {}
  load(p: Project) {
    clearTimeout(this.timer);
    this.saved = p;
    this.current = structuredClone(p);
    this.version = 0;
    this.savedVersion = 0;
    this.past = [];
    this.future = [];
    this.error = "";
    this.conflict = false;
    this.status = "saved";
    this.publish();
  }
  change(next: Project, history = true) {
    if (this.current?.id !== next.id) return;
    if (history) {
      this.past.push(structuredClone(this.current));
      this.past = this.past.slice(-50);
      this.future = [];
    }
    this.current = { ...next, revision: this.current.revision };
    this.version++;
    this.persist(this.current);
    clearTimeout(this.timer);
    if (!this.conflict) {
      this.status = "saving";
      this.error = "";
    }
    this.publish();
    if (this.conflict) return;
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 500);
  }
  restoreDraft(draft: Project) {
    if (!this.current || this.current.id !== draft.id) return;
    if (this.current.revision === draft.revision) {
      this.change(draft);
      return;
    }
    this.current = draft;
    this.saved = undefined;
    this.version++;
    this.conflict = true;
    this.status = "error";
    this.publish();
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
        const { project, rebased } = await this.save(submitted);
        const current = this.current;
        if (current?.id !== project.id) return;
        if (rebased) {
          const updateHistory = (entries: Project[]) => entries.flatMap((entry) => {
            const merged = mergeProject(submitted, entry, project);
            return merged ? [merged] : [];
          });
          this.past = updateHistory(this.past);
          this.future = updateHistory(this.future);
          const updated = this.version === version ? project : mergeProject(submitted, current, project);
          if (!updated) {
            // A change made during the retry overlaps with the just-saved version.
            this.saved = submitted;
            this.conflict = true;
            throw new Error("A newer canvas overlaps with the current draft");
          }
          this.current = updated;
        } else {
          this.current = this.version === version ? project : {
            ...current,
            revision: project.revision,
            updatedAt: project.updatedAt,
          };
        }
        this.savedVersion = version;
        this.saved = project;
        this.conflict = false;
        if (!this.dirty) this.status = "saved";
        this.persist(this.dirty ? this.current : undefined);
        this.error = "";
      } catch (e) {
        this.status = "error";
        this.conflict ||= isProjectConflict(e);
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
  private async save(submitted: Project): Promise<{ project: Project; rebased: boolean }> {
    const base = this.saved;
    try {
      return { project: await this.write(submitted), rebased: false };
    } catch (error) {
      if (!isProjectConflict(error) || !base || !this.read) throw error;
      const latest = await this.read(submitted.id);
      const merged = mergeProject(base, submitted, latest);
      if (!merged) throw error;
      return { project: await this.write(merged), rebased: true };
    }
  }
  async reload(): Promise<void> {
    if (!this.current || !this.read) return;
    const draft = this.current;
    const latest = await this.read(draft.id);
    if (this.current === draft && !this.flight) {
      this.reloadCount++;
      this.load(latest);
      this.persist(undefined);
    }
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
