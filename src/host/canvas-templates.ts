import { randomUUID } from "node:crypto";
import {
  canvasTemplateContentSchema,
  canvasTemplateSchema,
  type CanvasTemplate,
  type CanvasTemplateContent,
  type CanvasTemplateSummary,
  type CreativeNode,
  type Input,
} from "../shared/contracts.ts";
import { validateGraph, type Projects } from "./projects.ts";

/** Persist template snapshots independently of projects and model jobs. */
export class CanvasTemplates {
  constructor(
    private table: {
      get(id: string): CanvasTemplate | undefined;
      entries(): Iterable<readonly [string, CanvasTemplate]>;
      put(id: string, value: CanvasTemplate): Promise<unknown>;
      delete(id: string): Promise<unknown>;
    },
    private projects: Projects,
    private checkResources: (
      nodes: CreativeNode[],
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  list() {
    return [...this.table.entries()]
      .map(([, template]) => summary(template))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Resolve only the local image displayed as this template's cover. */
  coverMediaId(id: string) {
    return coverOf(this.get(id))?.media?.id;
  }

  async save(input: Input<"saveCanvasTemplate">, signal: AbortSignal) {
    const project = this.projects.get(input.projectId);
    if (project.revision !== input.revision)
      throw new Error("画布已更新，请重新打开后保存模板");
    if (!project.nodes.length) throw new Error("空画布不能保存为模板");
    const template = canvasTemplateSchema.parse({
      ...project,
      nodes: project.nodes.map(({ data, ...node }) => ({
        ...node,
        data: {
          ...data,
          appliedGenerationIds: undefined,
          textVersions: undefined,
        },
      })),
      id: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
    });
    validateGraph(template);
    await this.checkResources(template.nodes, signal);
    signal.throwIfAborted();
    await this.table.put(template.id, template);
    return summary(template);
  }

  async createProject(id: string, signal: AbortSignal) {
    const template = this.get(id);
    const content = instantiate(template);
    await this.checkResources(content.nodes, signal);
    signal.throwIfAborted();
    return this.projects.create(template.name, undefined, content);
  }

  /** Remove the saved snapshot. Its projects and media have separate storage. */
  async remove(id: string) {
    await this.table.delete(id);
    return { ok: true as const };
  }

  async fragment(input: Input<"canvasTemplateFragment">, signal: AbortSignal) {
    const content = instantiate(this.get(input.id), input.origin);
    await this.checkResources(content.nodes, signal);
    signal.throwIfAborted();
    return content;
  }

  private get(id: string) {
    const template = this.table.get(id);
    if (!template) throw new Error("画布模板不存在");
    return template;
  }
}

function summary({
  id,
  name,
  createdAt,
  nodes,
}: CanvasTemplate): CanvasTemplateSummary {
  return { id, name, createdAt, nodeCount: nodes.length, cover: coverOf({ nodes }) };
}

function coverOf({ nodes }: Pick<CanvasTemplate, "nodes">) {
  const data = nodes.find((n) => n.data.kind === "image" && (n.data.media || n.data.asset))?.data;
  return data && { kind: data.kind, label: data.label, text: "", media: data.media, asset: data.asset };
}

function instantiate(
  template: CanvasTemplate,
  origin?: { x: number; y: number },
): CanvasTemplateContent {
  const content = canvasTemplateContentSchema.parse(template);
  const ids = new Map(content.nodes.map((n) => [n.id, randomUUID()]));
  const dx = origin
    ? origin.x - Math.min(...content.nodes.map((n) => n.position.x))
    : 0;
  const dy = origin
    ? origin.y - Math.min(...content.nodes.map((n) => n.position.y))
    : 0;
  for (const node of content.nodes) {
    node.id = ids.get(node.id)!;
    node.position = { x: node.position.x + dx, y: node.position.y + dy };
    for (const composer of [node.data.composer, node.data.mediaComposer]) {
      if (!composer) continue;
      composer.referenceIds = composer.referenceIds.flatMap((id) => {
        const target = ids.get(id);
        return target ? [target] : [];
      });
      composer.prompt = composer.prompt.map((part): typeof part => {
        if (part.type === "text") return part;
        const nodeId = ids.get(part.nodeId);
        return nodeId
          ? { ...part, nodeId }
          : { type: "text", text: part.label };
      });
    }
    const frames = node.data.mediaComposer?.frames;
    if (frames) {
      frames.first = frames.first ? ids.get(frames.first) : undefined;
      frames.last = frames.last ? ids.get(frames.last) : undefined;
    }
  }
  for (const edge of content.edges) {
    edge.id = randomUUID();
    edge.source = ids.get(edge.source)!;
    edge.target = ids.get(edge.target)!;
  }
  return content;
}
