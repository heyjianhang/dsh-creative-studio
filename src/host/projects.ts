import { randomUUID } from "node:crypto";
import {
  projectSchema,
  type Project,
  type Graph,
} from "../shared/contracts.ts";
export interface ProjectTable {
  get(id: string): Project | undefined;
  entries(): Iterable<readonly [string, Project]>;
  put(id: string, p: Project): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}
export function validateGraph(g: Graph) {
  const ids = new Set(g.nodes.map((n) => n.id));
  if (ids.size !== g.nodes.length) throw new Error("节点 ID 重复");
  const edges = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (
      edges.has(e.id) ||
      !ids.has(e.source) ||
      !ids.has(e.target) ||
      e.source === e.target
    )
      throw new Error("连线无效");
    edges.add(e.id);
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const done = new Set<string>(),
    path = new Set<string>();
  function visit(n: string) {
    if (path.has(n)) throw new Error("不能创建循环引用");
    if (done.has(n)) return;
    path.add(n);
    for (const target of adj.get(n) ?? []) visit(target);
    path.delete(n);
    done.add(n);
  }
  for (const n of ids) visit(n);
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
  create(name: string) {
    return this.serial(async () => {
      const now = new Date().toISOString();
      const p = projectSchema.parse({
        id: randomUUID(),
        name,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      await this.table.put(p.id, p);
      return p;
    });
  }
  save(input: Project) {
    return this.serial(async () => {
      const p = projectSchema.parse(input);
      const old = this.get(p.id);
      if (old.revision !== p.revision)
        throw new Error(
          "项目已在其他位置更新。请保留草稿后重新载入，避免覆盖修改。",
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
