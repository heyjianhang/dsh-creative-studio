import type { Graph } from "./contracts.ts";

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
