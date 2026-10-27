import { mediaComposerOf } from "./media-contracts.ts";
import type {
  CreativeNode,
  Project,
  Generation,
  TextComposerState,
  PromptPart,
} from "./contracts.ts";

export function composerOf(node: CreativeNode): TextComposerState {
  return (
    (node.data.kind !== "text"
      ? mediaComposerOf(node)
      : node.data.composer) ?? { prompt: [], referenceIds: [], count: 1 }
  );
}
export function referenceIds(config: TextComposerState): string[] {
  return [
    ...new Set([
      ...config.referenceIds,
      ...config.prompt.flatMap((p) =>
        p.type === "reference" ? [p.nodeId] : [],
      ),
    ]),
  ];
}
export function referenceProblem(
  project: Pick<Project, "nodes" | "edges">,
  target: string,
  source: string,
  images: "yes" | "no" | "unknown" = "unknown",
) {
  if (source === target) return "referenceSelf";
  const n = project.nodes.find((n) => n.id === source);
  if (!n) return "referenceMissing";
  if (n.data.kind === "video") return "referenceVideo";
  if (
    (n.data.kind === "text" && !n.data.text.trim()) ||
    (n.data.kind === "image" && !n.data.media && !n.data.asset)
  )
    return "referenceEmpty";
  if (n.data.kind === "image" && images === "no") return "referenceNoImages";
  const visit = [target],
    seen = new Set<string>();
  while (visit.length) {
    const id = visit.pop()!;
    if (id === source) return "cycle";
    if (seen.has(id)) continue;
    seen.add(id);
    visit.push(
      ...project.edges.filter((e) => e.source === id).map((e) => e.target),
    );
  }
  return undefined;
}
export function referencePickProblem(
  project: Pick<Project, "nodes" | "edges">,
  target: string,
  source: string,
  images: "yes" | "no" | "unknown" = "unknown",
) {
  const problem = referenceProblem(project, target, source, images);
  if (problem) return problem;
  const node = project.nodes.find((n) => n.id === target);
  if (!node) return "referenceMissing";
  const ids = referenceIds(composerOf(node));
  if (
    ids.includes(source) ||
    project.edges.some((e) => e.source === source && e.target === target)
  )
    return "referenceAdded";
  if (ids.length >= 12) return "textReferenceLimit";
  return undefined;
}
export function framePickProblem(
  project: Pick<Project, "nodes" | "edges">,
  target: string,
  source: string,
) {
  const problem = referenceProblem(project, target, source, "yes");
  if (problem) return problem;
  if (!project.nodes.some((n) => n.id === target)) return "referenceMissing";
  if (project.nodes.find((n) => n.id === source)?.data.kind !== "image")
    return "frameNeedsImage";
  return undefined;
}
export function connectedReferences(
  project: Pick<Project, "nodes" | "edges">,
  target: string,
  images: "yes" | "no" | "unknown" = "unknown",
) {
  const incoming = new Set(
    project.edges.filter((e) => e.target === target).map((e) => e.source),
  );
  return project.nodes.filter(
    (n) =>
      incoming.has(n.id) && !referenceProblem(project, target, n.id, images),
  );
}
export function instructionText(prompt: PromptPart[], ids: string[]) {
  return prompt
    .map((p) =>
      p.type === "text" ? p.text : `【参考 ${ids.indexOf(p.nodeId) + 1}】`,
    )
    .join("");
}
export function applyTextResult(project: Project, job: Generation): Project {
  if (
    job.projectId !== project.id ||
    job.status !== "completed" ||
    !job.text.trim()
  )
    return project;
  if (project.nodes.some((n) => n.data.appliedGenerationIds?.includes(job.id)))
    return project;
  const original = project.nodes.find((n) => n.id === job.nodeId);
  const canReplace =
    job.index === 0 &&
    original?.data.kind === "text" &&
    original.data.text === job.snapshot.baseText;
  if (canReplace && original) {
    return {
      ...project,
      nodes: project.nodes.map((n) =>
        n.id !== original.id
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                text: job.text,
                textVersions: [
                  ...(n.data.textVersions ?? []),
                  ...(n.data.text
                    ? [{ text: n.data.text, createdAt: job.createdAt }]
                    : []),
                ].slice(-20),
                appliedGenerationIds: [
                  ...(n.data.appliedGenerationIds ?? []),
                  job.id,
                ].slice(-100),
              },
            },
      ),
    };
  }
  if (project.nodes.length >= 1500)
    throw new Error("画布节点已达上限，生成结果已保留，请移除一些节点后重试");
  const node: CreativeNode = {
    id: job.id,
    type: "creative",
    position: {
      x: (original?.position.x ?? job.snapshot.position.x) + 360,
      y: (original?.position.y ?? job.snapshot.position.y) + job.index * 260,
    },
    data: {
      kind: "text",
      label: `${(job.snapshot.label || "文本").slice(0, 245)} · ${job.index + 1}`,
      text: job.text,
      appliedGenerationIds: [job.id],
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
    edges:
      original && project.edges.length < 5000
        ? [
            ...project.edges,
            { id: `result:${job.id}`, source: original.id, target: node.id },
          ]
        : project.edges,
  };
}
