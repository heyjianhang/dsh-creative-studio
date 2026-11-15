/** Model-facing canvas edits contain business fields, never file paths or credentials. */
import { z } from "zod";
import { point, projectSchema } from "./contracts.ts";
import { mediaParametersSchema } from "./media-contracts.ts";
const id = z.string().min(1).max(100);
export const assistantNodeSchema = z
  .object({
    id,
    kind: z.enum(["text", "image", "video"]).optional(),
    label: z.string().max(255).optional(),
    text: z.string().max(30000).optional(),
    position: point.optional(),
    asset: z
      .object({ library_id: z.string().min(1), asset_id: z.string().min(1) })
      .strict()
      .optional(),
    prompt: z.string().max(30000).optional(),
    reference_ids: z.array(id).max(12).optional(),
    model_id: z.string().uuid().optional(),
    text_model: z
      .object({ provider: z.string().min(1), model: z.string().min(1) })
      .strict()
      .optional(),
    parameters: z.object({
      ratio: mediaParametersSchema.shape.ratio.removeDefault().optional(),
      resolution: mediaParametersSchema.shape.resolution.removeDefault().optional(),
      duration: mediaParametersSchema.shape.duration.removeDefault().optional(),
      mode: mediaParametersSchema.shape.mode.removeDefault().optional(),
      audio: mediaParametersSchema.shape.audio.removeDefault().optional(),
      seed: mediaParametersSchema.shape.seed.removeDefault().optional(),
    }).strict().optional(),
    count: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
    frames: z
      .object({ first: id.optional(), last: id.optional() })
      .strict()
      .optional(),
    color_pins:
      projectSchema.shape.nodes.element.shape.data.shape.colorPins.optional(),
  })
  .strict();
export const canvasEditSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    nodes: z.array(assistantNodeSchema).max(100).default([]),
    remove_nodes: z.array(id).max(100).default([]),
    connect: z
      .array(z.object({ source: id, target: id }).strict())
      .max(200)
      .default([]),
    disconnect: z.array(id).max(200).default([]),
    viewport: projectSchema.shape.viewport.optional(),
  })
  .strict();
export type CanvasEdit = z.output<typeof canvasEditSchema>;
