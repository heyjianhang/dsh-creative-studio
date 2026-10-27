import type { CreativeNode, Project } from "./contracts.ts";
import { mediaComposerOf } from "./media-contracts.ts";
import { composerOf } from "./text-generation.ts";
import { isGenerationNode } from "./media-reference.ts";

function settings(data: CreativeNode["data"]) {
  if (data.kind === "text") {
    const c = composerOf({
      id: "",
      type: "creative",
      position: { x: 0, y: 0 },
      data,
    });
    return { selection: c.selection, count: c.count };
  }
  const c = mediaComposerOf({ data });
  return {
    modelId: c.modelId,
    parameters: { ...c.parameters, seed: -1 },
    count: c.count,
  };
}

export function rememberGeneration(
  preferences: Project["generationPreferences"],
  before: CreativeNode["data"] | undefined,
  after: CreativeNode["data"],
): Project["generationPreferences"] {
  if (!before && !isGenerationNode({ id: "", data: after })) return preferences;
  if (after.kind === "text" ? !after.composer : !after.mediaComposer)
    return preferences;
  const next = settings(after);
  if (before && JSON.stringify(settings(before)) === JSON.stringify(next))
    return preferences;
  return { ...preferences, [after.kind]: next };
}

export function generationDefaults(
  project: Pick<Project, "generationPreferences">,
  kind: CreativeNode["data"]["kind"],
): Partial<CreativeNode["data"]> {
  if (kind === "text") {
    const saved = project.generationPreferences?.text;
    return saved
      ? { composer: { ...saved, prompt: [], referenceIds: [] } }
      : {};
  }
  const saved = project.generationPreferences?.[kind];
  return saved
    ? {
        mediaComposer: {
          ...saved,
          parameters: { ...saved.parameters, seed: -1 },
          prompt: [],
          referenceIds: [],
        },
      }
    : {};
}
