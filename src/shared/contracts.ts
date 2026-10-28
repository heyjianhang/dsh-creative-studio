import { z } from "zod";
import type {
  RemoteResult,
  TypertRemoteContribution,
} from "@deepseek-ai/dsh-typert-protocol";
import {
  composerSchema,
  modelCatalogSchema,
  modelSelectionSchema,
  textModelSchema,
  generationSchema,
} from "./text-contracts.ts";
export * from "./text-contracts.ts";
import {
  mediaComposerSchema,
  mediaJobSchema,
  mediaSettingsViewSchema,
  mediaSettingsInputSchema,
  mediaCatalogSchema,
  discoverySchema,
} from "./media-contracts.ts";
export * from "./media-contracts.ts";
import {
  templateQuerySchema,
  templateResultSchema,
  templateId,
} from "./template-contracts.ts";
export * from "./template-contracts.ts";
const id = z.string().uuid();
export const point = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export const mediaSchema = z.object({
  id,
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});
export const libraryAssetSchema = z.object({
  libraryId: z.string().min(1),
  id: z.string().min(1),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});
export const resourceSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    media: mediaSchema.optional(),
    asset: libraryAssetSchema.optional(),
  })
  .refine((r) => !!r.media !== !!r.asset, "参考素材必须且只能有一个文件来源");
export const categories = [
  "character",
  "scene",
  "prop",
  "style",
  "other",
] as const;
export const categorySchema = z.enum(categories);
export const creativeAssetDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: categorySchema,
  description: z.string().max(5000).default(""),
  references: z.array(resourceSchema).min(1).max(24),
  folderId: id.nullable().optional(),
  ownerProjectId: id.optional(),
});
export const creativeAssetSchema = creativeAssetDraftSchema.extend({
  id,
  revision: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const creativeFolderSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  parentId: id.nullable(),
  projectId: id.optional(),
  category: categorySchema.default("other"),
  legacyCategory: categorySchema.optional(),
  revision: z.number().int().min(0),
});
export const folderCatalogSchema = z.object({
  folders: z.array(creativeFolderSchema),
});
export type CreativeFolder = z.output<typeof creativeFolderSchema>;
export type FolderCatalog = z.output<typeof folderCatalogSchema>;
export const nodeSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.literal("creative"),
  position: point,
  width: z.number().finite().min(180).max(1200).optional(),
  height: z.number().finite().min(120).max(1600).optional(),
  data: z.object({
    kind: z.enum(["text", "image", "video"]),
    label: z.string().max(255),
    text: z.string().max(30000).default(""),
    composer: composerSchema.optional(),
    mediaComposer: mediaComposerSchema.optional(),
    generationResult: z.boolean().optional(),
    pinned: z.boolean().optional(),
    colorPins: z
      .array(z.enum(["red", "orange", "yellow", "green", "blue", "purple"]))
      .max(6)
      .optional(),
    textVersions: z
      .array(z.object({ text: z.string().max(30000), createdAt: z.string() }))
      .max(20)
      .optional(),
    appliedGenerationIds: z.array(id).max(100).optional(),
    creativeAssetId: id.optional(),
    media: mediaSchema.optional(),
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
export const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(1500),
  edges: z
    .array(
      z.object({
        id: z.string().max(200),
        source: z.string(),
        target: z.string(),
      }),
    )
    .max(5000),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().min(0.1).max(3),
  }),
});
export const projectSchema = graphSchema.extend({
  id,
  name: z.string().trim().min(1).max(120),
  revision: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().optional(),
  playbackPreferences: z.object({ muted: z.boolean() }).optional(),
  generationPreferences: z
    .object({
      text: composerSchema.pick({ selection: true, count: true }).optional(),
      image: mediaComposerSchema
        .pick({ modelId: true, parameters: true, count: true })
        .optional(),
      video: mediaComposerSchema
        .pick({ modelId: true, parameters: true, count: true })
        .optional(),
    })
    .optional(),
});
export const jobSchema = z.object({
  id,
  text: z.string(),
  status: z.enum(["running", "completed", "cancelled", "failed"]),
  error: z.string().optional(),
  model: z.string(),
});
const ok = z.object({ ok: z.literal(true) });
const assetSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  kind: z.enum(["image", "video"]),
  start: z.number().nullable().optional(),
  end: z.number().nullable().optional(),
  score: z.number().default(0),
});
export const librarySearchSchema = z.object({
  query: z.string().max(300).default(""),
  ai: z.boolean().default(true),
  kind: z.enum(["all", "image", "video"]).default("all"),
  libraryId: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(40),
});
export const librarySearchResultSchema = z.object({
  hits: z.array(assetSchema),
  total: z.number(),
  unindexed: z.number(),
  mode: z.enum(["ai", "keyword"]),
  fallback: z.boolean(),
});
const mediaResult = z.object({
  data: z.string(),
  mime: z.string(),
  size: z.number(),
  nextOffset: z.number(),
});
export const endpoints = {
  templates: { input: templateQuerySchema, output: templateResultSchema },
  favoriteTemplate: {
    input: z.object({ id: templateId, favorite: z.boolean() }),
    output: z.array(templateId).max(10000),
  },
  mediaSettings: { input: z.object({}), output: mediaSettingsViewSchema },
  saveMediaSettings: {
    input: mediaSettingsInputSchema,
    output: mediaSettingsViewSchema,
  },
  mediaModels: { input: z.object({}), output: mediaCatalogSchema },
  discoverMediaModels: {
    input: z.object({
      mode: z.enum(["native", "plan"]),
      refresh: z.boolean().default(false),
    }),
    output: discoverySchema,
  },
  generateMedia: {
    input: z.object({
      projectId: id,
      nodeId: z.string(),
      revision: z.number().int(),
      requestId: id,
    }),
    output: z.array(mediaJobSchema),
  },
  mediaJobs: {
    input: z.object({ projectId: id }),
    output: z.array(mediaJobSchema),
  },
  mediaJobAction: {
    input: z.object({ id, action: z.enum(["cancel", "retry", "acknowledge"]) }),
    output: mediaJobSchema,
  },
  textModels: { input: z.object({}), output: modelCatalogSchema },
  textModel: { input: modelSelectionSchema, output: textModelSchema },
  generateText: {
    input: z.object({
      projectId: id,
      nodeId: z.string(),
      revision: z.number().int(),
      requestId: id,
    }),
    output: z.array(generationSchema),
  },
  generations: {
    input: z.object({ projectId: id }),
    output: z.array(generationSchema),
  },
  generationAction: {
    input: z.object({ id, action: z.enum(["cancel", "retry", "acknowledge"]) }),
    output: generationSchema,
  },
  list: { input: z.object({}), output: z.array(projectSchema) },
  create: {
    input: z.object({ name: z.string().trim().min(1).max(120) }),
    output: projectSchema,
  },
  get: { input: z.object({ id }), output: projectSchema },
  save: { input: z.object({ project: projectSchema }), output: projectSchema },
  removeProject: { input: z.object({ id, revision: z.number() }), output: ok },
  capabilities: {
    input: z.object({}),
    output: z.object({
      assets: z.boolean(),
      model: z.string().optional(),
      dataDir: z.string(),
    }),
  },
  beginUpload: {
    input: z.object({
      projectId: id,
      name: z.string().min(1).max(255),
      mime: z.string(),
      size: z
        .number()
        .int()
        .positive()
        .max(256 * 1024 ** 2),
    }),
    output: z.object({ id }),
  },
  uploadChunk: {
    input: z.object({
      id,
      offset: z.number().int().min(0),
      data: z.string().max(750000),
    }),
    output: z.object({ offset: z.number() }),
  },
  cancelUpload: { input: z.object({ id }), output: ok },
  finishUpload: { input: z.object({ id }), output: mediaSchema },
  media: {
    input: z.object({
      projectId: id,
      mediaId: id,
      offset: z.number().int().min(0).default(0),
    }),
    output: mediaResult,
  },
  assets: {
    input: z.object({ query: z.string().max(300) }),
    output: z.array(assetSchema),
  },
  libraryInfo: {
    input: z.object({}),
    output: z.object({
      available: z.boolean(),
      aiReady: z.boolean(),
      libraries: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          available: z.boolean(),
          count: z.number(),
        }),
      ),
    }),
  },
  searchLibrary: {
    input: librarySearchSchema,
    output: librarySearchResultSchema,
  },
  creativeAssets: {
    input: librarySearchSchema.omit({ libraryId: true }).extend({
      category: z.union([categorySchema, z.literal("all")]).default("all"),
      projectId: id.optional(),
      collection: z.enum(["personal", "project"]).optional(),
      ownerProjectId: id.optional(),
      folderId: id.nullable().optional(),
    }),
    output: z.object({
      items: z.array(creativeAssetSchema),
      total: z.number(),
      mode: z.enum(["ai", "keyword"]),
      fallback: z.boolean(),
      partial: z.boolean(),
    }),
  },
  creativeFolders: {
    input: z.object({ projectId: id.optional() }),
    output: z.array(creativeFolderSchema),
  },
  createCreativeFolder: {
    input: z.object({
      name: z.string().trim().min(1).max(80),
      projectId: id.optional(),
      parentId: id.nullable().default(null),
    }),
    output: creativeFolderSchema,
  },
  renameCreativeFolder: {
    input: z.object({
      id,
      revision: z.number().int().min(0),
      name: z.string().trim().min(1).max(80),
    }),
    output: creativeFolderSchema,
  },
  removeCreativeFolder: {
    input: z.object({ id, revision: z.number().int().min(0) }),
    output: ok,
  },
  addCreativeResources: {
    input: z.object({
      resources: z.array(resourceSchema).min(1).max(100),
      folderId: id.nullable(),
      ownerProjectId: id.optional(),
    }),
    output: z.array(creativeAssetSchema),
  },
  createCreativeAsset: {
    input: creativeAssetDraftSchema,
    output: creativeAssetSchema,
  },
  getCreativeAsset: { input: z.object({ id }), output: creativeAssetSchema },
  updateCreativeAsset: {
    input: creativeAssetDraftSchema.extend({
      id,
      revision: z.number().int().min(0),
    }),
    output: creativeAssetSchema,
  },
  removeCreativeAsset: {
    input: z.object({ id, revision: z.number().int().min(0) }),
    output: ok,
  },
  assetMedia: {
    input: z.object({
      libraryId: z.string(),
      id: z.string(),
      preview: z.boolean().default(true),
      offset: z.number().int().min(0).default(0),
    }),
    output: mediaResult,
  },
  optimize: {
    input: z.object({
      projectId: id,
      text: z.string().trim().min(1).max(30000),
    }),
    output: jobSchema,
  },
  textJob: {
    input: z.object({ id, cancel: z.boolean().default(false) }),
    output: jobSchema,
  },
  session: {
    input: z.object({ projectId: id, sessionId: z.string().optional() }),
    output: z.object({ sessionId: z.string().optional(), cwd: z.string() }),
  },
};
export type Project = z.infer<typeof projectSchema>;
export type Graph = z.infer<typeof graphSchema>;
export type CreativeNode = z.infer<typeof nodeSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type TextJob = z.infer<typeof jobSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type CreativeAsset = z.infer<typeof creativeAssetSchema>;
export type CreativeAssetDraft = z.infer<typeof creativeAssetDraftSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Method = keyof typeof endpoints;
export type Input<K extends Method> = z.input<(typeof endpoints)[K]["input"]>;
export type Output<K extends Method> = z.output<
  (typeof endpoints)[K]["output"]
>;
export type RemoteAPI = {
  [K in Method]: (
    request: Input<K>,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<Output<K>>>;
};
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    creativeStudio: RemoteAPI;
  }
}
export const contribution: TypertRemoteContribution = {
  package: "dsh-creative-studio",
  descriptors: Object.entries(endpoints).map(([method, s]) => ({
    id: `dsh-creative-studio#creativeStudio/${method}`,
    service: "creativeStudio",
    namespace: "creativeStudio",
    method,
    invocation: { kind: "direct" },
    cancellation: { parameter: "signal" },
    parameters: [
      {
        name: "request",
        wire: "request",
        source: "json",
        codec: {
          mode: "strict",
          typeSymbol: `dsh-creative-studio#${method}Input`,
          create: () => s.input,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: `dsh-creative-studio#${method}Output`,
      create: () => s.output,
    },
  })),
};

export type Request = <K extends Method>(
  method: K,
  input: Input<K>,
  signal?: AbortSignal,
) => Promise<Output<K>>;
