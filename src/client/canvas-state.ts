import type { Node, Edge } from "@xyflow/react";
import type { CreativeNode } from "../shared/contracts.ts";

/** Saved graphs omit React Flow measurements and selection. Keep that runtime
 * state when a save acknowledgement or another node's edit arrives. */
export function reconcileNodes<N extends Node<CreativeNode["data"]>>(
  previous: N[],
  incoming: CreativeNode[],
): N[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const next = incoming.map((node) => {
    const old = byId.get(node.id);
    if (!old) return { ...node, draggable: true } as N;
    const position =
      old.position.x === node.position.x && old.position.y === node.position.y
        ? old.position
        : node.position;
    const data =
      old.data === node.data ||
      JSON.stringify(old.data) === JSON.stringify(node.data)
        ? old.data
        : node.data;
    const sameSize = old.width === node.width && old.height === node.height;
    if (
      position === old.position &&
      data === old.data &&
      sameSize &&
      old.draggable !== false
    )
      return old;
    return {
      ...old,
      ...node,
      position,
      data,
      draggable: true,
      selected: old.selected,
    } as N;
  });
  return next.length === previous.length &&
    next.every((node, index) => node === previous[index])
    ? previous
    : next;
}
export function reconcileEdges<E extends Edge>(
  previous: E[],
  incoming: CreativeNodeEdge[],
): E[] {
  const byId = new Map(previous.map((edge) => [edge.id, edge]));
  const next = incoming.map((edge) => {
    const old = byId.get(edge.id);
    return old && old.source === edge.source && old.target === edge.target
      ? old
      : ({ ...old, ...edge } as E);
  });
  return next.length === previous.length &&
    next.every((edge, index) => edge === previous[index])
    ? previous
    : next;
}
type CreativeNodeEdge = { id: string; source: string; target: string };
