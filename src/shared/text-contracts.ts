import { z } from "zod";
const nodeId = z.string().min(1).max(100);
export const promptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(30000) }),
  z.object({
    type: z.literal("reference"),
    nodeId,
    label: z.string().max(255),
  }),
]);
export const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export const composerSchema = z.object({
  prompt: z.array(promptPartSchema).max(500).default([]),
  referenceIds: z.array(nodeId).max(12).default([]),
  selection: modelSelectionSchema.optional(),
  count: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .default(1),
});
export const textModelSchema = modelSelectionSchema.extend({
  name: z.string(),
  providerName: z.string(),
  images: z.enum(["yes", "no", "unknown"]),
});
export const modelCatalogSchema = z.object({
  models: z.array(textModelSchema),
  default: modelSelectionSchema.optional(),
  failures: z.array(z.string()),
  imagesAvailable: z.boolean(),
});
export const imageRefSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  name: z.string().optional(),
});
export const textSnapshotSchema = z.object({
  prompt: z.array(promptPartSchema),
  instruction: z.string(),
  baseText: z.string(),
  label: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  references: z.array(
    z.object({
      nodeId,
      label: z.string(),
      text: z.string().optional(),
      image: imageRefSchema.optional(),
    }),
  ),
});
export const generationSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  projectId: z.string().uuid(),
  nodeId,
  index: z.number().int(),
  count: z.number().int(),
  selection: modelSelectionSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  text: z.string(),
  error: z.string().optional(),
  applied: z.boolean().default(false),
  createdAt: z.string(),
  snapshot: textSnapshotSchema,
});
export type PromptPart = z.output<typeof promptPartSchema>;
export type TextComposerState = z.output<typeof composerSchema>;
export type TextModel = z.output<typeof textModelSchema>;
export type ModelCatalog = z.output<typeof modelCatalogSchema>;
export type ModelSelection = z.output<typeof modelSelectionSchema>;
export type Generation = z.output<typeof generationSchema>;
export type TextSnapshot = z.output<typeof textSnapshotSchema>;
