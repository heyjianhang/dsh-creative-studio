import type { CreativeNode, Project } from "./contracts.ts";
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
