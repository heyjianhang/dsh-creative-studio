import type {
  MediaJob,
  Project,
  CreativeNode,
  MediaComposerState,
} from "./contracts.ts";
export function resultComposer(job: MediaJob): MediaComposerState {
  return structuredClone(
    job.snapshot.composer ?? {
      modelId: job.snapshot.model.id,
      parameters: job.snapshot.parameters,
      prompt: [{ type: "text", text: job.snapshot.prompt }],
      referenceIds: job.snapshot.references.map((r) => r.id),
      count: Math.min(4, Math.max(1, job.count)) as 1 | 2 | 3 | 4,
    },
  );
}
export function applyMediaResult(project: Project, job: MediaJob): Project {
  if (
    project.id !== job.projectId ||
    job.status !== "completed" ||
    !job.result ||
    project.nodes.some((n) => n.data.appliedGenerationIds?.includes(job.id))
  )
    return project;
  const original = project.nodes.find((n) => n.id === job.nodeId);
  if (
    job.index === 0 &&
    original?.data.kind === job.kind &&
    (original.data.media?.id ?? original.data.asset?.id) ===
      job.snapshot.baseMediaId
  ) {
    return {
      ...project,
      nodes: project.nodes.map((n) =>
        n.id === original.id
          ? {
              ...n,
              data: {
                ...n.data,
                asset: undefined,
                media: job.result,
                generationResult: true,
                appliedGenerationIds: [
                  ...(n.data.appliedGenerationIds ?? []),
                  job.id,
                ].slice(-100),
              },
            }
          : n,
      ),
    };
  }
  if (project.nodes.length >= 1500)
    throw new Error("画布节点已达上限，生成结果已保留，请移除部分节点后重试");
  const node: CreativeNode = {
    id: job.id,
    type: "creative",
    position: {
      x: (original?.position.x ?? job.snapshot.position.x) + 360,
      y: (original?.position.y ?? job.snapshot.position.y) + job.index * 260,
    },
    data: {
      kind: job.kind,
      label: `${job.snapshot.label.slice(0, 240)} · ${job.index + 1}`,
      text: "",
      media: job.result,
      generationResult: true,
      appliedGenerationIds: [job.id],
      mediaComposer: resultComposer(job),
    },
  };
  while (
    project.nodes.some(
      (n) =>
        Math.abs(n.position.x - node.position.x) < 300 &&
        Math.abs(n.position.y - node.position.y) < 220,
    )
  )
    node.position.y += 260;
  return {
    ...project,
    nodes: [...project.nodes, node],
    edges: [
      ...project.edges,
      ...[
        ...new Set([
          ...(original ? [original.id] : []),
          ...job.snapshot.references.map((r) => r.id),
        ]),
      ]
        .filter((source) => project.nodes.some((n) => n.id === source))
        .slice(0, Math.max(0, 5000 - project.edges.length))
        .map((source) => ({
          id: `reference:${node.id}:${source}`,
          source,
          target: node.id,
        })),
    ],
  };
}
