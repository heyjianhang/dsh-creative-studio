import { z } from "zod";
import { composerSchema } from "./text-contracts.ts";
const uuid = z.string().uuid();
export const ratios = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
] as const;
export const mediaParametersSchema = z.object({
  ratio: z.string().default("1:1"),
  resolution: z.string().default("2K"),
  duration: z.number().int().min(2).max(60).default(5),
  mode: z.enum(["reference", "frames"]).default("reference"),
  audio: z.boolean().default(false),
  seed: z.number().int().min(-1).max(2147483647).default(-1),
});
export const modelCapabilitiesSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    adapter: z.enum(["ark-image", "ark-video"]),
    ratios: z
      .array(z.string().regex(/^(adaptive|\d{1,2}:\d{1,2})$/))
      .min(1)
      .max(16),
    resolutions: z
      .array(z.string().regex(/^(\d+(\.\d+)?K|\d+p|4k)$/))
      .min(1)
      .max(12),
    durations: z.array(z.number().int().min(2).max(60)).max(59),
    modes: z
      .array(z.enum(["reference", "frames"]))
      .min(1)
      .max(2),
    maxImages: z.number().int().min(0).max(30),
    audio: z.boolean(),
    framesAdaptive: z.boolean().default(false),
    imageOutput: z.enum(["png", "sequential"]).optional(),
    sources: z
      .array(
        z
          .url()
          .refine(
            (value) => new URL(value).protocol === "https:",
            "参数来源必须是 HTTPS 地址",
          ),
      )
      .min(1)
      .max(6),
    fetchedAt: z.iso.datetime(),
    version: z.string().min(1).max(80),
  })
  .refine(
    (c) =>
      c.kind === "image"
        ? c.adapter === "ark-image" &&
          !c.audio &&
          c.durations.length === 0 &&
          c.modes.includes("reference")
        : c.adapter === "ark-video" && c.durations.length > 0,
    "模型类型与参数定义不一致",
  );
export const mediaModelSchema = z
  .object({
    id: uuid,
    name: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    preset: z
      .enum([
        "seedream-5",
        "seedream-5-pro",
        "seedream-5-flash",
        "seedream-4.5",
        "seedance-1.5",
        "seedance-2",
      ])
      .optional(),
    capabilities: modelCapabilitiesSchema.optional(),
    capabilityModel: z.string().max(200).optional(),
    enabled: z.boolean().default(true),
    defaults: mediaParametersSchema,
    unitPrice: z.number().finite().min(0).optional(),
    currency: z.enum(["CNY", "USD"]).default("CNY"),
  })
  .refine((m) => !!m.preset || !!m.capabilities, "模型缺少参数定义");
export const discoveredModelSchema = z.object({
  model: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  kind: z.enum(["image", "video"]),
  capabilities: modelCapabilitiesSchema.optional(),
  retiring: z.boolean().default(false),
});
export const discoverySchema = z.object({
  mode: z.enum(["native", "plan"]),
  source: z.enum(["official", "cache", "bundled"]),
  fetchedAt: z.iso.datetime(),
  models: z.array(discoveredModelSchema).min(1).max(500),
  warning: z.string().optional(),
});
export const connectionSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(80),
  mode: z.enum(["native", "plan"]),
  baseUrl: z.url().max(500),
  enabled: z.boolean(),
  models: z.array(mediaModelSchema).max(50),
});
export const mediaSettingsSchema = z.object({
  revision: z.number().int().min(0),
  connections: z.array(connectionSchema).max(20),
  defaultImage: uuid.optional(),
  defaultVideo: uuid.optional(),
});
export const mediaSettingsViewSchema = mediaSettingsSchema.extend({
  connections: z.array(connectionSchema.extend({ hasKey: z.boolean() })),
});
export const mediaSettingsInputSchema = mediaSettingsSchema.extend({
  connections: z.array(
    connectionSchema.extend({
      apiKey: z.string().max(1000).optional(),
      clearKey: z.boolean().optional(),
    }),
  ),
});
export const storedMediaSettingsSchema = mediaSettingsSchema.extend({
  connections: z.array(connectionSchema.extend({ apiKey: z.string() })),
});
export const mediaComposerSchema = composerSchema
  .omit({ selection: true })
  .extend({
    modelId: uuid.optional(),
    parameters: mediaParametersSchema,
    frames: z
      .object({ first: z.string().optional(), last: z.string().optional() })
      .optional(),
  });
export const mediaFileSchema = z.object({
  id: uuid,
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});
const refSchema = z.object({
  id: z.string(),
  role: z.enum(["first_frame", "last_frame", "reference_image"]).optional(),
  data: z.object({
    kind: z.enum(["text", "image", "video"]),
    label: z.string(),
    text: z.string(),
    media: mediaFileSchema.optional(),
    asset: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        name: z.string(),
        mime: z.string(),
        size: z.number(),
      })
      .optional(),
  }),
});
export const mediaJobSchema = z.object({
  id: uuid,
  batchId: uuid,
  projectId: uuid,
  nodeId: z.string(),
  index: z.number().int(),
  count: z.number().int(),
  kind: z.enum(["image", "video"]),
  status: z.enum([
    "queued",
    "running",
    "downloading",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
  ]),
  stage: z.string(),
  error: z.string().optional(),
  failure: z
    .object({
      kind: z.enum([
        "authentication",
        "configuration",
        "permission",
        "rate-limit",
        "moderation",
        "provider",
      ]),
      code: z.string().max(100),
      status: z.number().int().optional(),
      requestId: z.string().max(160).optional(),
    })
    .optional(),
  applied: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  submitted: z.boolean().default(false),
  remoteId: z.string().optional(),
  resultUrl: z.string().optional(),
  result: mediaFileSchema.optional(),
  usage: z.record(z.string(), z.number()).optional(),
  estimate: z
    .object({
      amount: z.number(),
      currency: z.string(),
      subscription: z.boolean(),
    })
    .optional(),
  snapshot: z.object({
    connectionId: uuid,
    connectionName: z.string(),
    baseUrl: z.string(),
    billingMode: z.enum(["native", "plan"]).optional(),
    model: mediaModelSchema,
    prompt: z.string(),
    parameters: mediaParametersSchema,
    references: z.array(refSchema).max(12),
    label: z.string(),
    position: z.object({ x: z.number(), y: z.number() }),
    baseMediaId: z.string().optional(),
    composer: mediaComposerSchema.optional(),
  }),
});
export const mediaCatalogSchema = z.object({
  models: z.array(
    mediaModelSchema.safeExtend({
      connectionId: uuid,
      connectionName: z.string(),
      kind: z.enum(["image", "video"]),
      mode: z.enum(["native", "plan"]),
    }),
  ),
  defaultImage: uuid.optional(),
  defaultVideo: uuid.optional(),
});
export type MediaParameters = z.output<typeof mediaParametersSchema>;
export type ModelCapabilities = z.output<typeof modelCapabilitiesSchema>;
export type DiscoveredModel = z.output<typeof discoveredModelSchema>;
export type ModelDiscovery = z.output<typeof discoverySchema>;
export type MediaModel = z.output<typeof mediaModelSchema>;
export type MediaComposerState = z.output<typeof mediaComposerSchema>;
export type MediaJob = z.output<typeof mediaJobSchema>;
export type MediaCatalog = z.output<typeof mediaCatalogSchema>;
export type MediaSettingsView = z.output<typeof mediaSettingsViewSchema>;
export type MediaSettingsInput = z.output<typeof mediaSettingsInputSchema>;
export type StoredMediaSettings = z.output<typeof storedMediaSettingsSchema>;
export function modelKind(model: Pick<MediaModel, "preset" | "capabilities">) {
  if (model.capabilities) return model.capabilities.kind;
  return model.preset?.startsWith("seedream")
    ? ("image" as const)
    : ("video" as const);
}
export function capabilities(
  model: Pick<MediaModel, "preset" | "capabilities">,
) {
  if (model.capabilities) return model.capabilities;
  const image = modelKind(model) === "image";
  return {
    kind: image ? ("image" as const) : ("video" as const),
    ratios: image
      ? [...ratios]
      : ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    resolutions: image
      ? ["seedream-5-pro", "seedream-5-flash"].includes(model.preset ?? "")
        ? ["1K", "1.5K", "2K"]
        : model.preset === "seedream-5"
          ? ["2K", "3K", "4K"]
          : ["2K", "4K"]
      : ["480p", "720p"],
    durations:
      model.preset === "seedance-2"
        ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
        : [4, 5, 6, 7, 8, 9, 10, 11, 12],
    modes:
      model.preset === "seedance-2"
        ? (["frames", "reference"] as const)
        : (["frames"] as const),
    maxImages: image
      ? ["seedream-5-pro", "seedream-5-flash"].includes(model.preset ?? "")
        ? 10
        : 12
      : model.preset === "seedance-2"
        ? 9
        : 2,
    audio: !image,
    framesAdaptive: false,
    imageOutput: ["seedream-5-pro", "seedream-5-flash"].includes(
      model.preset ?? "",
    )
      ? ("png" as const)
      : ("sequential" as const),
  };
}
export function normalizeParameters(
  model: MediaModel,
  input: Partial<MediaParameters> = {},
  imageCount = 0,
): MediaParameters {
  const cap = capabilities(model),
    p = mediaParametersSchema.parse({ ...model.defaults, ...input });
  return {
    ...p,
    ratio:
      cap.framesAdaptive && p.mode === "frames" && imageCount > 0
        ? "adaptive"
        : cap.ratios.includes(p.ratio)
          ? p.ratio
          : cap.ratios[0]!,
    resolution: cap.resolutions.includes(p.resolution)
      ? p.resolution
      : cap.resolutions[0]!,
    duration: cap.durations.includes(p.duration)
      ? p.duration
      : (cap.durations[0] ?? 5),
    mode: cap.modes.includes(p.mode as never) ? p.mode : cap.modes[0]!,
    audio: cap.audio && p.audio,
  };
}
export function modelFromDiscovery(item: DiscoveredModel): MediaModel {
  if (!item.capabilities) throw new Error("这个模型的参数尚未适配");
  const m: MediaModel = {
    id: crypto.randomUUID(),
    name: item.name,
    model: item.model,
    capabilities: item.capabilities,
    capabilityModel: item.model,
    enabled: true,
    currency: "CNY",
    defaults: mediaParametersSchema.parse({
      ratio: item.kind === "image" ? "1:1" : "adaptive",
      resolution: item.kind === "image" ? "2K" : "720p",
      mode: item.kind === "image" ? "reference" : "frames",
    }),
  };
  m.defaults = normalizeParameters(m);
  return m;
}
export function mediaComposerOf(node: {
  data: { mediaComposer?: MediaComposerState };
}) {
  return mediaComposerSchema.parse(
    node.data.mediaComposer ?? { parameters: {} },
  );
}
