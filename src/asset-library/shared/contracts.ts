import { z } from "zod";
import type {
  TypertRemoteContribution,
  RemoteResult,
} from "@deepseek-ai/dsh-typert-protocol";
export const s3Schema = z.object({
  endpoint: z.string().max(2000).default(""),
  region: z.string().trim().min(1).max(100).default("us-east-1"),
  bucket: z.string().trim().max(255).default(""),
  prefix: z.string().trim().max(500).default("asset-library"),
  forcePathStyle: z.boolean().default(true),
  allowInsecureHttp: z.boolean().default(false),
});
export type S3Config = z.infer<typeof s3Schema>;
export const storageSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({ mode: z.literal("s3"), s3: s3Schema }),
]);
export type Storage = z.infer<typeof storageSchema>;
export const transferSchema = z.object({
  id: z.string(),
  kind: z.enum(["export", "import"]),
  name: z.string(),
  libraryId: z.string().optional(),
  path: z.string(),
  archiveId: z.string().optional(),
  storage: storageSchema.optional(),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  progress: z.number(),
  detail: z.string(),
  error: z.string().nullable(),
  result: z.string().optional(),
  acknowledged: z.boolean().optional(),
  updatedAt: z.string(),
});
export type Transfer = z.infer<typeof transferSchema>;
export const librarySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  available: z.boolean(),
  count: z.number(),
  error: z.string().optional(),
  storage: storageSchema.default({ mode: "local" }),
});
export const assetSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  name: z.string(),
  kind: z.enum(["image", "video"]),
  mime: z.string(),
  size: z.number(),
  relativePath: z.string(),
  tags: z.array(z.string()),
  notes: z.string(),
  favorite: z.boolean(),
  createdAt: z.string(),
  status: z.string(),
  duration: z.number().nullable(),
  thumbnail: z.string().nullable(),
  collectionIds: z.array(z.string()).default([]),
});
export const taskSchema = z.object({
  id: z.string(),
  libraryId: z.string(),
  assetId: z.string(),
  name: z.string(),
  stage: z.string(),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "retrying",
    "completed",
    "failed",
    "cancelled",
  ]),
  progress: z.number(),
  attempts: z.number(),
  error: z.string().nullable(),
  nextRunAt: z.number(),
  updatedAt: z.string(),
});
export const settingsSchema = z.object({
  embeddingModelId: z.uuid().optional(),
  concurrency: z.number().int().min(1).max(4),
  maxRetries: z.number().int().min(0).max(5),
  segmentSeconds: z.number().int().min(5).max(60),
  ffmpegPath: z.string().max(2000),
  ffprobePath: z.string().max(2000),
  storageMode: z.enum(["local", "s3"]).default("local"),
  localDirectory: z.string().max(4000).default(""),
  s3: s3Schema.default({
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "asset-library",
    forcePathStyle: true,
    allowInsecureHttp: false,
  }),
});
/** Local registry fields include the read-only connection used by older versions. */
export const storedSettingsSchema = settingsSchema.extend({
  baseUrl: z.string().url(),
  embeddingConnectionId: z.uuid().optional(),
  model: z.string().trim().min(1).max(200),
});
export const searchInput = z.object({
  query: z.string().max(2000),
  libraryId: z.string().optional(),
  kind: z.enum(["all", "image", "video"]).default("all"),
  ai: z.boolean().default(false),
  favorite: z.boolean().default(false),
  recent: z.boolean().default(false),
  collectionId: z.string().optional(),
  collectionIds: z.array(z.string()).max(100).default([]),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  withinDays: z.number().int().min(0).max(36500).default(0),
  indexState: z.enum(["all", "indexed", "unindexed"]).default("all"),
  sort: z
    .enum(["default", "newest", "oldest", "name", "size"])
    .default("default"),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});
export const hitSchema = assetSchema.extend({
  score: z.number(),
  start: z.number().nullable(),
  end: z.number().nullable(),
});
const empty = z.object({}).strict(),
  success = z.object({ ok: z.literal(true) });
export const endpoints = {
  snapshot: {
    input: empty,
    output: z.object({
      libraries: z.array(librarySchema),
      tasks: z.array(taskSchema),
      keyConfigured: z.boolean(),
      embeddingModels: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          connectionName: z.string(),
        }),
      ),
      legacyEmbeddingModel: z.string().optional(),
      s3Configured: z.boolean(),
      transfers: z.array(transferSchema),
      settings: settingsSchema,
      notices: z.array(
        z.object({ id: z.string(), text: z.string(), createdAt: z.string() }),
      ),
      tags: z.array(
        z.object({
          libraryId: z.string(),
          name: z.string(),
          count: z.number(),
        }),
      ),
      collections: z.array(
        z.object({
          id: z.string(),
          libraryId: z.string(),
          name: z.string(),
          count: z.number(),
          isDefault: z.boolean().default(false),
        }),
      ),
    }),
  },
  library: {
    input: z
      .object({
        action: z.enum(["create", "open", "close"]),
        path: z.string().max(4000).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        id: z.string().optional(),
        storageMode: z.enum(["local", "s3"]).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true), id: z.string().optional() }),
  },
  search: {
    input: searchInput,
    output: z.object({
      hits: z.array(hitSchema),
      total: z.number(),
      unindexed: z.number(),
    }),
  },
  updateAsset: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        tags: z.array(z.string().trim().min(1).max(80)).max(50),
        notes: z.string().max(10000),
        favorite: z.boolean(),
      })
      .strict(),
    output: success,
  },
  editAsset: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        name: z.string().trim().min(1).max(255).optional(),
        tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
        notes: z.string().max(10000).optional(),
        favorite: z.boolean().optional(),
        collectionIds: z.array(z.string()).max(100).optional(),
        addCollections: z.array(z.string()).max(100).optional(),
      })
      .strict(),
    output: assetSchema,
  },
  collection: {
    input: z
      .object({
        libraryId: z.string(),
        action: z.enum(["create", "rename", "delete"]),
        id: z.string().optional(),
        name: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
    output: success,
  },
  setCollections: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        collectionIds: z.array(z.string()).max(100),
      })
      .strict(),
    output: success,
  },
  task: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        action: z.enum(["pause", "resume", "retry", "cancel"]),
      })
      .strict(),
    output: success,
  },
  saveSettings: {
    input: settingsSchema
      .extend({
        accessKeyId: z.string().max(2048).optional(),
        secretAccessKey: z.string().max(4096).optional(),
        sessionToken: z.string().max(16384).optional(),
        clearS3: z.boolean().optional(),
      })
      .strict(),
    output: success,
  },
  testConnection: {
    input: empty,
    output: z.object({ dimensions: z.number() }),
  },
  testS3: { input: empty, output: success },
  archiveUpload: {
    input: z
      .object({
        action: z.enum(["begin", "chunk", "cancel"]),
        id: z.string().uuid().optional(),
        size: z
          .number()
          .int()
          .positive()
          .max(1024 ** 4)
          .optional(),
        offset: z.number().int().min(0).optional(),
        data: z.string().max(1500000).optional(),
      })
      .strict(),
    output: z.object({ id: z.string(), offset: z.number() }),
  },
  startTransfer: {
    input: z
      .object({
        kind: z.enum(["export", "import"]),
        libraryId: z.string().optional(),
        archiveId: z.string().uuid().optional(),
        path: z.string().min(1).max(4000),
        storageMode: z.enum(["local", "s3"]).default("local"),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  transfer: {
    input: z
      .object({ id: z.string(), action: z.enum(["retry", "cancel"]) })
      .strict(),
    output: success,
  },
  beginUpload: {
    input: z
      .object({
        libraryId: z.string(),
        name: z.string().min(1).max(255),
        size: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 ** 3),
      })
      .strict(),
    output: z.object({ id: z.string(), offset: z.number() }),
  },
  uploadChunk: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        offset: z.number().int().min(0),
        data: z.string().max(1500000),
      })
      .strict(),
    output: z.object({ offset: z.number() }),
  },
  finishUpload: {
    input: z.object({ libraryId: z.string(), id: z.string() }).strict(),
    output: z.object({ assetId: z.string(), duplicate: z.boolean() }),
  },
  media: {
    input: z
      .object({
        libraryId: z.string(),
        id: z.string(),
        preview: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    output: z.object({
      data: z.string(),
      mime: z.string(),
      size: z.number(),
      nextOffset: z.number(),
    }),
  },
  acknowledge: {
    input: z.object({ ids: z.array(z.string()).max(1000) }).strict(),
    output: success,
  },
} as const;
export type Method = keyof typeof endpoints;
export type Input<K extends Method> = z.input<(typeof endpoints)[K]["input"]>;
export type Output<K extends Method> = z.output<
  (typeof endpoints)[K]["output"]
>;
export type Library = z.infer<typeof librarySchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Settings = z.infer<typeof storedSettingsSchema>;
export type LibraryPreferences = z.infer<typeof settingsSchema>;
export type SearchHit = z.infer<typeof hitSchema>;
export type Snapshot = Output<"snapshot">;
export type RemoteAPI = {
  [K in Method]: (
    request: Input<K>,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<Output<K>>>;
};
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    assetLibrary: RemoteAPI;
  }
}
// Strict descriptors are derived from the single endpoint schema table for both faces.
export const contribution: TypertRemoteContribution = {
  package: "dsh-asset-library",
  descriptors: Object.entries(endpoints).map(([method, schema]) => ({
    id: `dsh-asset-library#assetLibrary/${method}`,
    service: "assetLibrary",
    namespace: "assetLibrary",
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
          typeSymbol: `dsh-asset-library#${method}Input`,
          create: () => schema.input,
        },
      },
    ],
    result: {
      mode: "strict",
      typeSymbol: `dsh-asset-library#${method}Output`,
      create: () => schema.output,
    },
  })),
};
