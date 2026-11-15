/** Agent canvas operations reuse project transactions and authoritative asset metadata. */
import { randomUUID } from "node:crypto";
import { canvasEditSchema } from "../shared/assistant-contracts.ts";
import {
  projectSchema,
  type Project,
  type Resource,
  type CreativeNode,
} from "../shared/contracts.ts";
import { composerOf } from "../shared/text-generation.ts";
import { mediaComposerOf } from "../shared/media-contracts.ts";
import { validateGraph, Projects } from "./projects.ts";

/** Resolve existing library files; returned metadata belongs to the material service. */
export type ResolveAsset = (
  libraryId: string,
  assetId: string,
  signal: AbortSignal,
) => Promise<Resource>;
/** Versioned, all-or-nothing graph changes used by creative tools. */
export class CanvasOperations {
  constructor(
    private projects: Projects,
    private resolveAsset: ResolveAsset,
  ) {}
  /** Apply a bounded edit against the revision observed by the caller.
   * @param projectId Target project.
   * @param revision Previously read revision.
   * @param raw Untrusted tool JSON.
   * @param signal Cancellation before committing.
   * @returns Persisted project; invalid edits and stale revisions do not write.
   */
  async edit(
    projectId: string,
    revision: number,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<Project> {
    signal.throwIfAborted();
    const input = canvasEditSchema.parse(raw);
    const project = this.projects.get(projectId);
    if (project.revision !== revision)
      throw new Error("画布已更新，请重新读取项目后再编辑");
    if (new Set(input.nodes.map((n) => n.id)).size !== input.nodes.length)
      throw new Error("同一批次不能重复编辑同一个节点");
    const removed = new Set(input.remove_nodes);
    for (const id of removed)
      if (!project.nodes.some((n) => n.id === id))
        throw new Error("要移除的节点不存在");
    for (const id of input.disconnect)
      if (!project.edges.some((e) => e.id === id))
        throw new Error("要断开的连线不存在");
    for (const edit of input.nodes) {
      if (removed.has(edit.id)) throw new Error("不能同时编辑和移除同一个节点");
      const old = project.nodes.find((n) => n.id === edit.id);
      if (!old && !edit.kind) throw new Error("新节点必须指定 kind");
      if (old && edit.kind && edit.kind !== old.data.kind)
        throw new Error("不能改变已有节点类型，请新建节点");
      const node: CreativeNode = old ?? {
        id: edit.id,
        type: "creative",
        position: edit.position ?? {
          x: 120,
          y: 120 + project.nodes.length * 260,
        },
        data: { kind: edit.kind!, label: edit.label ?? "", text: "" },
      };
      if (edit.asset) {
        const resource = await this.resolveAsset(
          edit.asset.library_id,
          edit.asset.asset_id,
          signal,
        );
        if (resource.kind !== node.data.kind)
          throw new Error("素材类型与画布节点不一致");
        node.data.asset = resource.asset;
        node.data.media = undefined;
        node.data.generationResult = undefined;
        if (edit.label === undefined && !old)
          node.data.label = resource.asset?.name ?? "";
      }
      if (edit.position) node.position = edit.position;
      if (edit.label !== undefined) node.data.label = edit.label;
      if (edit.text !== undefined) node.data.text = edit.text;
      if (edit.color_pins) node.data.colorPins = edit.color_pins;
      const configured =
        edit.prompt !== undefined ||
        edit.reference_ids !== undefined ||
        edit.model_id !== undefined ||
        edit.text_model !== undefined ||
        edit.parameters !== undefined ||
        edit.count !== undefined ||
        edit.frames !== undefined;
      if (configured) {
        const config = structuredClone(
          node.data.kind === "text" ? composerOf(node) : mediaComposerOf(node),
        );
        if (edit.prompt !== undefined)
          config.prompt = [{ type: "text", text: edit.prompt }];
        if (edit.reference_ids) {
          config.referenceIds = edit.reference_ids;
          config.prompt = config.prompt.filter((part) => part.type !== "reference" || edit.reference_ids!.includes(part.nodeId));
        }
        if (edit.count) config.count = edit.count;
        if (node.data.kind === "text") {
          if (edit.model_id || edit.parameters || edit.frames)
            throw new Error("文本节点不接受图片视频模型参数");
          node.data.composer = {
            ...config,
            ...(edit.text_model ? { selection: edit.text_model } : {}),
          };
        } else {
          if (edit.text_model) throw new Error("媒体节点不接受文本模型");
          node.data.mediaComposer = {
            ...mediaComposerOf(node),
            ...config,
            ...(edit.model_id ? { modelId: edit.model_id } : {}),
            parameters: {
              ...mediaComposerOf(node).parameters,
              ...edit.parameters,
            },
            ...(edit.frames ? { frames: edit.frames } : {}),
          };
        }
      }
      if (!old) project.nodes.push(node);
    }
    project.nodes = project.nodes.filter((n) => !removed.has(n.id));
    const disconnected = project.edges.filter((e) =>
      input.disconnect.includes(e.id),
    );
    project.edges = project.edges.filter(
      (e) =>
        !removed.has(e.source) &&
        !removed.has(e.target) &&
        !input.disconnect.includes(e.id),
    );
    for (const link of input.connect) {
      if (
        !project.edges.some(
          (e) => e.source === link.source && e.target === link.target,
        )
      )
        project.edges.push({ id: randomUUID(), ...link });
    }
    for (const node of project.nodes) {
      const excluded = new Set([
        ...removed,
        ...disconnected
          .filter((e) => e.target === node.id)
          .map((e) => e.source),
      ]);
      for (const config of [node.data.composer, node.data.mediaComposer]) {
        if (!config) continue;
        config.referenceIds = config.referenceIds.filter(
          (id) => !excluded.has(id),
        );
        config.prompt = config.prompt.filter(
          (p) => p.type !== "reference" || !excluded.has(p.nodeId),
        );
      }
      const frames = node.data.mediaComposer?.frames;
      if (frames?.first && excluded.has(frames.first)) delete frames.first;
      if (frames?.last && excluded.has(frames.last)) delete frames.last;
      const config =
        node.data.kind === "text"
          ? node.data.composer
          : node.data.mediaComposer;
      if (config) {
        const ids = [
          ...config.referenceIds,
          ...config.prompt.flatMap((p) =>
            p.type === "reference" ? [p.nodeId] : [],
          ),
          ...[frames?.first, frames?.last].filter((id): id is string => !!id),
        ];
        for (const id of new Set(ids)) {
          if (id === node.id || !project.nodes.some((n) => n.id === id))
            throw new Error("提示词引用节点不存在或引用了自身");
          if (
            !project.edges.some((e) => e.source === id && e.target === node.id)
          )
            project.edges.push({
              id: randomUUID(),
              source: id,
              target: node.id,
            });
        }
      }
    }
    if (input.name !== undefined) project.name = input.name;
    if (input.viewport) project.viewport = input.viewport;
    const next = projectSchema.parse(project);
    validateGraph(next);
    signal.throwIfAborted();
    return this.projects.save(next);
  }
}
