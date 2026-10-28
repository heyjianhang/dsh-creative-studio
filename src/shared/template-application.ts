import type { CreativeNode, Project, Media, Graph } from "./contracts.ts";
import type { PromptTemplate } from "./template-contracts.ts";
import { generationDefaults } from "./generation-preferences.ts";
import { mediaComposerSchema } from "./media-contracts.ts";

export function templateNodeData(
  project: Project,
  template: PromptTemplate,
): CreativeNode["data"] {
  const defaults = generationDefaults(project, "image");
  return {
    kind: "image",
    label: template.title.slice(0, 255),
    text: "",
    mediaComposer: mediaComposerSchema.parse({
      parameters: {},
      ...defaults.mediaComposer,
      prompt: [{ type: "text", text: template.prompt }],
      referenceIds: [],
    }),
  };
}

export function templateReferenceGraph(target: CreativeNode, media: Media[]) {
  const references: CreativeNode[] = media.map((file, index) => ({
    id: crypto.randomUUID(),
    type: "creative",
    position: {
      x: target.position.x - 360,
      y: target.position.y + index * 220,
    },
    data: {
      kind: "image",
      label: file.name.slice(0, 255),
      text: "",
      media: file,
    },
  }));
  const node: CreativeNode = {
    ...target,
    data: {
      ...target.data,
      mediaComposer: mediaComposerSchema.parse({
        ...target.data.mediaComposer,
        referenceIds: references.map((reference) => reference.id),
      }),
    },
  };
  const edges: Graph["edges"] = references.map((reference) => ({
    id: `reference:${target.id}:${reference.id}`,
    source: reference.id,
    target: target.id,
  }));
  return { nodes: [...references, node], edges, nodeId: node.id };
}
