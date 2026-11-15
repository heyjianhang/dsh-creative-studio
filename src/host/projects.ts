import { randomUUID } from "node:crypto";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { validateGraph } from "../shared/project-graph.ts";
import { projectConflictCode } from "../shared/project-merge.ts";

export { validateGraph } from "../shared/project-graph.ts";
import {
  projectSchema,
  type Project,
  type CanvasTemplateContent,
} from "../shared/contracts.ts";
export interface ProjectTable {
  get(id: string): Project | undefined;
  entries(): Iterable<readonly [string, Project]>;
  put(id: string, p: Project): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}
export class Projects {
  private tail = Promise.resolve();
  constructor(private table: ProjectTable) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.tail.then(fn);
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  list() {
    return [...this.table.entries()]
      .map(([, p]) => p)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string) {
    const p = this.table.get(id);
    if (!p) throw new Error("项目不存在或已删除");
    return structuredClone(p);
  }
  create(name: string, requestId?: string, content?: CanvasTemplateContent) {
    return this.serial(async () => {
      if (requestId) {
        projectSchema.shape.id.parse(requestId);
        const existing = this.table.get(requestId);
        if (existing) {
          if (existing.name !== name.trim())
            throw new Error("创建请求编号已用于另一个项目");
          return structuredClone(existing);
        }
      }
      const now = new Date().toISOString();
      const p = projectSchema.parse({
        id: requestId ?? randomUUID(),
        name,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        ...content,
      });
      if (content) validateGraph(p);
      await this.table.put(p.id, p);
      return p;
    });
  }
  /** Merge a generated result into the latest project under the same write queue.
   * @param id Existing target project.
   * @param change Pure transform; returning the original object performs no write.
   * @returns Latest persisted project, without overwriting concurrent user edits.
   */
  transform(id: string, change: (project: Project) => Project) {
    return this.serial(async () => {
      const previous = this.get(id);
      const changed = change(previous);
      if (changed === previous) return previous;
      const next = projectSchema.parse({
        ...changed,
        id,
        sessionId: previous.sessionId,
        createdAt: previous.createdAt,
        revision: previous.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      validateGraph(next);
      await this.table.put(id, next);
      return next;
    });
  }
  save(input: Project) {
    return this.serial(async () => {
      const p = projectSchema.parse(input);
      const old = this.get(p.id);
      if (old.revision !== p.revision)
        throw new RemoteError(
          projectConflictCode,
          "画布已有新版本，修改仍保留在草稿中",
          {},
        );
      validateGraph(p);
      const next = {
        ...p,
        sessionId: old.sessionId,
        createdAt: old.createdAt,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.table.put(p.id, next);
      return next;
    });
  }
  remove(id: string, revision: number) {
    return this.serial(async () => {
      if (this.get(id).revision !== revision)
        throw new Error("项目已更新，请刷新后重试");
      await this.table.delete(id);
      return { ok: true as const };
    });
  }
  bindSession(id: string, sessionId: string) {
    return this.serial(async () => {
      const p = this.get(id);
      if (p.sessionId && p.sessionId !== sessionId)
        throw new Error("项目已有助手会话");
      await this.table.put(id, { ...p, sessionId });
      return sessionId;
    });
  }
  async addText(id: string, text: string) {
    return this.serial(async () => {
      const p = this.get(id);
      const node = {
        id: randomUUID(),
        type: "creative" as const,
        position: {
          x: 120 + p.nodes.length * 40,
          y: 120 + p.nodes.length * 30,
        },
        data: { kind: "text" as const, label: "文本", text },
      };
      const next = {
        ...p,
        nodes: [...p.nodes, node],
        revision: p.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const validated = projectSchema.parse(next);
      validateGraph(validated);
      await this.table.put(id, validated);
      return node;
    });
  }
}
