import type { MediaComposerState } from "./media-contracts.ts";
type NodeInfo = {
  id: string;
  data: {
    kind: string;
    media?: unknown;
    asset?: unknown;
    generationResult?: boolean;
  };
};
const referenced = (c: MediaComposerState) => [
  ...new Set([
    ...c.referenceIds,
    ...c.prompt.flatMap((p) => (p.type === "reference" ? [p.nodeId] : [])),
  ]),
];
export function isGenerationNode(node: NodeInfo) {
  return (
    node.data.kind === "text" ||
    node.data.generationResult ||
    (!node.data.media && !node.data.asset)
  );
}
export function continuationComposer(
  node: NodeInfo,
  composer: MediaComposerState,
): MediaComposerState {
  return {
    ...structuredClone(composer),
    referenceIds: [
      ...new Set([
        ...(node.data.kind === "image" && (node.data.media || node.data.asset)
          ? [node.id]
          : []),
        ...composer.referenceIds,
      ]),
    ],
  };
}
export function framesOf(c: MediaComposerState, nodes: NodeInfo[]) {
  if (c.frames) return c.frames;
  const images = referenced(c).filter((id) =>
    nodes.some((n) => n.id === id && n.data.kind === "image"),
  );
  return { first: images[0], last: images[1] };
}
export function mediaReferenceIds(c: MediaComposerState, nodes: NodeInfo[]) {
  if (c.parameters.mode !== "frames") return referenced(c);
  const frames = framesOf(c, nodes);
  return [
    ...new Set([
      ...[frames.first, frames.last].filter((id): id is string => !!id),
      ...referenced(c).filter((id) =>
        nodes.some((n) => n.id === id && n.data.kind === "text"),
      ),
    ]),
  ];
}
export function changeFrame(
  c: MediaComposerState,
  nodes: NodeInfo[],
  slot: "first" | "last",
  id?: string,
) {
  const frames = { ...framesOf(c, nodes), [slot]: id };
  const ids = new Set([frames.first, frames.last]);
  return {
    ...c,
    frames,
    referenceIds: [
      ...referenced(c).filter((id) =>
        nodes.some((n) => n.id === id && n.data.kind === "text"),
      ),
      ...ids,
    ].filter((id): id is string => !!id),
    prompt: c.prompt.filter(
      (p) =>
        p.type !== "reference" ||
        ids.has(p.nodeId) ||
        nodes.some((n) => n.id === p.nodeId && n.data.kind === "text"),
    ),
  };
}
