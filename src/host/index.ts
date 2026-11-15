import { registerCreativeWorkbench } from "./workbench.ts";
import * as assetLibrary from "../asset-library/host/index.ts";
import type { Context } from "@deepseek-ai/cordis";
import {
  bindTypertRemote,
  RemoteError,
} from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { registerCreativeTools } from "./assistant.ts";
import { CanvasOperations } from "./canvas-operations.ts";
import { applyMediaResult } from "../shared/media-results.ts";
import { applyTextResult } from "../shared/text-generation.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  endpoints,
  contribution,
  projectSchema,
  canvasTemplateSchema,
  mediaSchema,
  creativeAssetSchema,
  folderCatalogSchema,
  type Method,
  type Input,
  type Media,
  type TextJob,
} from "../shared/contracts.ts";
import { MediaSettings } from "./media-settings.ts";
import { VolcCatalog } from "./volc-catalog.ts";
import { TemplateLibrary } from "./template-library.ts";
import { CanvasTemplates } from "./canvas-templates.ts";
import { TemplateMedia } from "./template-media.ts";
import { MediaGenerations } from "./media-generation.ts";
import {
  mediaJobSchema,
  storedMediaSettingsSchema,
} from "../shared/media-contracts.ts";
import { TextRuntime } from "./text-runtime.ts";
import { TextGenerations } from "./text-generation.ts";
import { generationSchema } from "../shared/text-contracts.ts";
import { Projects } from "./projects.ts";
import { isProjectConflict } from "../shared/project-merge.ts";
import { Uploads } from "./uploads.ts";
import { CreativeAssets } from "./creative-assets.ts";
import { LibrarySearch, type AssetService } from "./library-search.ts";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "creative-studio/error": { retryable: boolean };
  }
}
const spec = defineDomain({
  name: "creative_studio",
  version: 1,
  tables: {
    projects: domainTable(projectSchema),
    media: domainTable(mediaSchema.extend({ projectId: z.string() })),
  },
});
const creativeLibrarySpec = defineDomain({
  name: "creative_library",
  version: 1,
  tables: { assets: domainTable(creativeAssetSchema) },
});
const foldersSpec = defineDomain({
  name: "creative_folders",
  version: 1,
  tables: { catalogs: domainTable(folderCatalogSchema) },
});
const textSpec = defineDomain({
  name: "creative_text",
  version: 1,
  tables: { jobs: domainTable(generationSchema) },
});
const mediaGenerationSpec = defineDomain({
  name: "creative_media",
  version: 1,
  tables: {
    settings: domainTable(storedMediaSettingsSchema),
    jobs: domainTable(mediaJobSchema),
  },
});
const canvasTemplateSpec = defineDomain({
  name: "creative_canvas_templates",
  version: 1,
  tables: { templates: domainTable(canvasTemplateSchema) },
});
export const name = "creative-studio";
export const inject = [
  "typert",
  "storageDomain",
  "credentials",
  "actveroWorkbenchRuntime",
];
export async function apply(ctx: Context, config: { dataDir?: string } = {}) {
  const root =
    config.dataDir ??
    join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "creative-studio");
  await mkdir(root, { recursive: true });
  const domain = await ctx.storageDomain.open(spec),
    projects = new Projects(domain.table("projects"));
  const creativeDomain = await ctx.storageDomain
    .open(creativeLibrarySpec)
    .catch(async (e) => {
      await domain.close();
      throw e;
    });
  const folderDomain = await ctx.storageDomain
    .open(foldersSpec)
    .catch(async (e) => {
      await creativeDomain.close();
      await domain.close();
      throw e;
    });
  const uploads = new Uploads(join(root, "media"), (id, m) =>
    domain.table("media").put(id, m),
  );
  const jobs = new Map<string, { value: TextJob; abort: AbortController }>();
  let model:
    | ((text: string, job: TextJob, signal: AbortSignal) => Promise<void>)
    | undefined;
  let modelName: string | undefined;
  ctx.inject(["llm", "agentDefaultModel"], (ctx) => {
    modelName = ctx.agentDefaultModel.currentSelection().model;
    model = async (text, job, signal) => {
      const selection = ctx.agentDefaultModel.currentSelection();
      job.model = selection.model;
      for await (const chunk of ctx.llm.stream({
        ...selection,
        system:
          "你是视觉创作提示词编辑。保留用户意图，用原语言改写为具体、清晰的图片或视频提示词。只输出改写后的提示词，不解释，不声称已生成素材。",
        messages: [{ role: "user", content: [{ type: "text", text }] }],
        signal,
        maxTokens: 2048,
      })) {
        if (chunk.type === "text-delta") job.text += chunk.text;
        if (
          chunk.type === "finish" &&
          (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")
        )
          throw new Error(chunk.reason.failure.message);
      }
      if (!job.text.trim()) throw new Error("模型没有返回文本，请重试");
    };
    return () => {
      model = undefined;
      modelName = undefined;
      for (const j of jobs.values()) j.abort.abort();
    };
  });
  let assets: AssetService | undefined;
  ctx.inject(["assetLibrary"], (scope) => {
    assets = (scope as unknown as { assetLibrary: AssetService }).assetLibrary;
    return () => {
      assets = undefined;
    };
  });
  const library = new LibrarySearch(() => assets);
  const creativeAssets = new CreativeAssets(
    creativeDomain.table("assets"),
    library,
    (ref) => {
      if (!ref.media) return ref;
      const media = domain.table("media").get(ref.media.id);
      if (!media) throw new Error("上传文件不存在，请重新上传");
      return {
        kind: media.mime.startsWith("video/") ? "video" : "image",
        media: mediaSchema.parse(media),
      };
    },
    folderDomain.table("catalogs"),
  );
  const textDomain = await ctx.storageDomain.open(textSpec).catch(async (e) => {
    await folderDomain.close();
    await creativeDomain.close();
    await domain.close();
    throw e;
  });
  const textRuntime = new TextRuntime(ctx, async (node, offset, signal) => {
    if (node.data.media) {
      const m = domain.table("media").get(node.data.media.id);
      if (!m) throw new Error("图片不存在");
      return uploads.read(m.id, m.mime, offset);
    }
    if (!assets || !node.data.asset) throw new Error("素材库图片不可用");
    return assets.media(
      {
        libraryId: node.data.asset.libraryId,
        id: node.data.asset.id,
        preview: false,
        offset,
      },
      signal,
    );
  });
  const generations = new TextGenerations(
    textDomain.table("jobs"),
    (job, signal, delta) => textRuntime.run(job, signal, delta),
    undefined,
    async (job) => {
      await projects.transform(job.projectId, (project) =>
        applyTextResult(project, job),
      );
    },
  );
  await generations.restore();
  const mediaDomain = await ctx.storageDomain
    .open(mediaGenerationSpec)
    .catch(async (e) => {
      await generations.close();
      await textDomain.close();
      await folderDomain.close();
      await creativeDomain.close();
      await domain.close();
      throw e;
    });
  const generationSettings = new MediaSettings(mediaDomain.table("settings"));
  ctx.plugin(assetLibrary, {
    embeddingConnections: () => generationSettings.embeddingConnections(),
  });
  const volcCatalog = new VolcCatalog(join(root, "catalog"));
  const templates = new TemplateLibrary(join(root, "templates"));
  const templateMedia = new TemplateMedia((projectId, name, response, signal) =>
    uploads.generated(projectId, name, "image", response, signal),
  );
  const mediaGenerations = new MediaGenerations(
    mediaDomain.table("jobs"),
    generationSettings,
    async (node, offset, signal) => {
      if (node.data.media) {
        const m = domain.table("media").get(node.data.media.id);
        if (!m) throw new Error("参考素材已删除");
        return uploads.read(m.id, m.mime, offset);
      }
      if (!assets || !node.data.asset) throw new Error("素材库不可用");
      return (await assets.media(
        {
          libraryId: node.data.asset.libraryId,
          id: node.data.asset.id,
          preview: false,
          offset,
        },
        signal,
      )) as { data: string; mime: string; size: number; nextOffset: number };
    },
    (projectId, name, kind, response, signal) =>
      uploads.generated(projectId, name, kind, response, signal),
    fetch,
    5000,
    (mode, signal) => volcCatalog.get(mode, false, signal),
    async (job) => {
      await projects.transform(job.projectId, (project) =>
        applyMediaResult(project, job),
      );
    },
  );
  ctx.effect(() => async () => {
    for (const j of jobs.values()) j.abort.abort();
    await mediaGenerations.close();
    await volcCatalog.close();
    await templateMedia.close();
    await templates.close();
    await mediaDomain.close();
    await generations.close();
    await textDomain.close();
    await uploads.dispose();
    await creativeAssets.close();
    await folderDomain.close();
    await creativeDomain.close();
    await domain.close();
  });
  await mediaGenerations.restore();
  const canvasTemplateDomain = await ctx.storageDomain.open(canvasTemplateSpec);
  ctx.effect(() => () => canvasTemplateDomain.close());
  const canvasTemplates = new CanvasTemplates(
    canvasTemplateDomain.table("templates"),
    projects,
    async (nodes, signal) => {
      const checked = new Set<string>();
      for (const { data } of nodes) {
        signal.throwIfAborted();
        const key = data.media
          ? JSON.stringify(["media", data.media.id])
          : data.asset
            ? JSON.stringify(["asset", data.asset.libraryId, data.asset.id])
            : undefined;
        if (!key || checked.has(key)) continue;
        try {
          if (data.media) {
            if (!domain.table("media").get(data.media.id))
              throw new Error("文件记录不存在");
            await access(join(root, "media", data.media.id));
          } else if (data.asset) {
            if (!assets) throw new Error("素材库尚未就绪");
            await assets.resolveAsset(
              { libraryId: data.asset.libraryId, id: data.asset.id },
              signal,
            );
          }
        } catch (error) {
          signal.throwIfAborted();
          throw new Error(
            `画布素材「${data.label}」不可用，请检查原文件后重试`,
            { cause: error },
          );
        }
        checked.add(key);
      }
    },
  );
  async function dispatch<K extends Method>(
    method: K,
    raw: Input<K>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const input = endpoints[method].input.parse(raw);
    switch (method) {
      case "templates":
        return templates.search(input as Input<"templates">, signal);
      case "canvasTemplates":
        return canvasTemplates.list();
      case "saveCanvasTemplate":
        return canvasTemplates.save(
          input as Input<"saveCanvasTemplate">,
          signal,
        );
      case "createFromCanvasTemplate":
        return canvasTemplates.createProject(
          (input as Input<"createFromCanvasTemplate">).id,
          signal,
        );
      case "removeCanvasTemplate":
        return canvasTemplates.remove((input as Input<"removeCanvasTemplate">).id);
      case "canvasTemplateFragment":
        return canvasTemplates.fragment(
          input as Input<"canvasTemplateFragment">,
          signal,
        );
      case "favoriteTemplate": {
        const r = input as Input<"favoriteTemplate">;
        return templates.favorite(r.id, r.favorite);
      }
      case "templateMedia": {
        const r = input as Input<"templateMedia">;
        projects.get(r.projectId);
        const template = await templates.get(r.id, signal);
        return templateMedia.load(r.projectId, template, r.urls, signal);
      }
      case "mediaSettings":
        return generationSettings.view();
      case "saveMediaSettings":
        return generationSettings.save(input as Input<"saveMediaSettings">);
      case "mediaModels":
        return generationSettings.catalog();
      case "discoverMediaModels": {
        const r = input as Input<"discoverMediaModels">;
        return volcCatalog.get(r.mode, r.refresh ?? false, signal);
      }
      case "mediaJobs": {
        const id = (input as Input<"mediaJobs">).projectId;
        projects.get(id);
        await mediaGenerations.applyResults(id);
        return mediaGenerations.list(id);
      }
      case "mediaJobAction": {
        const r = input as Input<"mediaJobAction">;
        return mediaGenerations.action(r.id, r.action);
      }
      case "generateMedia": {
        const r = input as Input<"generateMedia">;
        const project = projects.get(r.projectId);
        const previous = mediaGenerations
          .list(project.id)
          .filter((job) => job.batchId === r.requestId);
        if (!previous.length && project.revision !== r.revision)
          throw new Error("画布已更新，请保存后重试");
        return mediaGenerations.start(project, r.nodeId, r.requestId);
      }
      case "textModels":
        return textRuntime.catalog();
      case "textModel":
        return textRuntime.info(input as Input<"textModel">);
      case "generations": {
        const id = (input as Input<"generations">).projectId;
        projects.get(id);
        await generations.applyResults(id);
        return generations.list(id);
      }
      case "generationAction": {
        const r = input as Input<"generationAction">;
        return generations.action(r.id, r.action);
      }
      case "generateText": {
        const r = input as Input<"generateText">;
        return generations.start(
          r.projectId,
          r.nodeId,
          r.requestId,
          async (preparationSignal) => {
            const project = projects.get(r.projectId);
            if (project.revision !== r.revision)
              throw new Error("画布已更新，请保存后重试");
            return textRuntime.prepare(
              project,
              r.nodeId,
              AbortSignal.any([signal, preparationSignal]),
            );
          },
        );
      }
      case "list":
        return projects.list();
      case "create":
        return projects.create((input as Input<"create">).name);
      case "get":
        return projects.get((input as Input<"get">).id);
      case "save":
        return projects.save(
          projectSchema.parse((input as Input<"save">).project),
        );
      case "removeProject": {
        const r = input as Input<"removeProject">;
        return projects.remove(r.id, r.revision);
      }
      case "capabilities":
        return { assets: !!assets, model: modelName, dataDir: root };
      case "beginUpload": {
        const r = input as Input<"beginUpload">;
        projects.get(r.projectId);
        return uploads.begin(r.projectId, r.name, r.mime, r.size);
      }
      case "uploadChunk": {
        const r = input as Input<"uploadChunk">;
        return uploads.chunk(r.id, r.offset, r.data);
      }
      case "cancelUpload":
        return uploads.cancel((input as Input<"cancelUpload">).id);
      case "finishUpload":
        return uploads.finish((input as Input<"finishUpload">).id);
      case "media": {
        const r = input as Input<"media">;
        const project = projects.get(r.projectId);
        const m = domain.table("media").get(r.mediaId);
        if (
          !m ||
          !(
            m.projectId === r.projectId ||
            creativeAssets.usesMedia(m.id) ||
            project.nodes.some((n) => n.data.media?.id === m.id)
          )
        )
          throw new Error("素材不存在");
        return uploads.read(m.id, m.mime, r.offset ?? 0);
      }
      case "canvasTemplateCover": {
        const r = input as Input<"canvasTemplateCover">;
        if (canvasTemplates.coverMediaId(r.templateId) !== r.mediaId)
          throw new Error("模板封面不存在");
        const m = domain.table("media").get(r.mediaId);
        if (!m) throw new Error("模板封面不存在");
        return uploads.read(m.id, m.mime, r.offset ?? 0);
      }
      case "libraryInfo":
        return library.info(signal);
      case "saveLibraryResources": {
        const r = input as Input<"saveLibraryResources">;
        if (!assets) throw new Error("请先启用素材库");
        const service = assets;
        const project = projects.get(r.projectId);
        const media = new Map<string, Media>();
        const assetIds = new Set<string>();
        for (const resource of r.resources) {
          if (resource.asset) {
            if (resource.asset.libraryId !== r.libraryId)
              throw new Error("请选择素材所在库的收藏夹");
            assetIds.add(resource.asset.id);
          } else if (resource.media) {
            const file = domain.table("media").get(resource.media.id);
            if (!file || (
              file.projectId !== project.id &&
              !project.nodes.some((node) => node.data.media?.id === file.id)
            )) throw new Error("当前项目中的素材不存在");
            media.set(file.id, file);
          }
        }
        for (const id of assetIds)
          await service.resolveAsset({ libraryId: r.libraryId, id }, signal);
        for (const file of media.values())
          await service.importCanvasFile({
            libraryId: r.libraryId,
            path: join(root, "media", file.id),
            name: file.name,
            mime: file.mime,
            size: file.size,
            collectionId: r.collectionId,
          }, signal);
        if (r.collectionId && assetIds.size)
          await service.editBatch({
            libraryId: r.libraryId,
            changes: [...assetIds].map((id) => ({ id, addCollections: [r.collectionId] })),
          }, signal);
        return { ok: true as const };
      }
      case "searchLibrary":
        return library.search(input as Input<"searchLibrary">, signal);
      case "creativeAssets": {
        const r = input as Input<"creativeAssets">;
        if (r.ownerProjectId) projects.get(r.ownerProjectId);
        return creativeAssets.search(
          r,
          signal,
          r.projectId ? projects.get(r.projectId) : undefined,
        );
      }
      case "creativeFolders": {
        const r = input as Input<"creativeFolders">;
        if (r.projectId) projects.get(r.projectId);
        return creativeAssets.folders(r.projectId);
      }
      case "createCreativeFolder": {
        const r = input as Input<"createCreativeFolder">;
        if (r.projectId) projects.get(r.projectId);
        return creativeAssets.createFolder(r);
      }
      case "renameCreativeFolder":
        return creativeAssets.renameFolder(
          input as Input<"renameCreativeFolder">,
        );
      case "removeCreativeFolder":
        return creativeAssets.removeFolder(
          input as Input<"removeCreativeFolder">,
        );
      case "addCreativeResources": {
        const r = input as Input<"addCreativeResources">;
        if (r.ownerProjectId) projects.get(r.ownerProjectId);
        return creativeAssets.addResources(r);
      }
      case "createCreativeAsset": {
        const r = input as Input<"createCreativeAsset">;
        if (r.ownerProjectId) projects.get(r.ownerProjectId);
        return creativeAssets.create(r);
      }
      case "updateCreativeAsset": {
        const r = input as Input<"updateCreativeAsset">;
        if (r.ownerProjectId) projects.get(r.ownerProjectId);
        return creativeAssets.update(r);
      }
      case "removeCreativeAsset":
        return creativeAssets.remove(input as Input<"removeCreativeAsset">);
      case "getCreativeAsset":
        return creativeAssets.get((input as Input<"getCreativeAsset">).id);
      case "assets": {
        if (!assets) throw new Error("请先启用素材库插件");
        const r = await assets.search(
          { query: (input as Input<"assets">).query, ai: false, limit: 60 },
          signal,
        );
        const list = Array.isArray(r) ? r : (r as { hits: unknown[] }).hits;
        return list.map((h: any) => h.asset ?? h);
      }
      case "assetMedia":
        if (!assets) throw new Error("素材库插件未启用");
        return assets.media(input, signal);
      case "optimize": {
        const r = input as Input<"optimize">;
        projects.get(r.projectId);
        if (!model)
          throw new Error("DSH 文本模型尚未就绪，请在原生设置中配置模型");
        if (
          [...jobs.values()].filter((j) => j.value.status === "running")
            .length >= 3
        )
          throw new Error("正在处理其他文本，请稍后重试");
        if (jobs.size >= 100) {
          for (const [id, j] of jobs) {
            if (j.value.status !== "running") {
              jobs.delete(id);
              break;
            }
          }
        }
        const value: TextJob = {
          id: randomUUID(),
          text: "",
          status: "running",
          model: modelName ?? "",
        };
        const abort = new AbortController();
        jobs.set(value.id, { value, abort });
        const timeout = setTimeout(() => abort.abort(), 120000);
        void model(r.text, value, abort.signal)
          .then(
            () => {
              value.status = abort.signal.aborted ? "cancelled" : "completed";
            },
            (e) => {
              value.status = abort.signal.aborted ? "cancelled" : "failed";
              const message = e instanceof Error ? e.message : String(e);
              value.error =
                /no API key|missing.*credential|not configured/i.test(message)
                  ? "请先在 DSH 设置 → 模型中配置 API 密钥"
                  : /429|rate.?limit/i.test(message)
                    ? "模型请求过于频繁，请稍后重试"
                    : /401|unauthorized/i.test(message)
                      ? "模型密钥无效，请在 DSH 设置中检查"
                      : /abort/i.test(message)
                        ? "请求已停止"
                        : "文本优化失败，请检查模型配置或网络后重试";
            },
          )
          .finally(() => clearTimeout(timeout));
        return { ...value };
      }
      case "textJob": {
        const r = input as Input<"textJob">;
        const job = jobs.get(r.id);
        if (!job) throw new Error("任务已结束或宿主已重启");
        if (r.cancel && job.value.status === "running") {
          job.abort.abort();
          job.value.status = "cancelled";
        }
        return { ...job.value };
      }
      case "session": {
        const r = input as Input<"session">;
        const p = projects.get(r.projectId);
        const cwd = join(root, "projects", p.id);
        await mkdir(cwd, { recursive: true });
        await writeFile(
          join(cwd, "AGENTS.md"),
          `# 创作项目助手

此目录属于 DSH 创作插件项目。项目 ID：${p.id}。

先读取 creative-studio-assistant Skill。用 creative_projects 读取最新项目与 revision；素材检索使用 asset_library_list/search/inspect，画布编辑使用 creative_canvas_edit，生成使用 creative_models、creative_generate 与 creative_generation_jobs。此对话固定操作该项目，每次交付前重新读取，不直接编辑存储文件；任务提交不等于生成完成。
`,
          { flag: "wx" },
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (r.sessionId) await projects.bindSession(p.id, r.sessionId);
        return { sessionId: r.sessionId ?? p.sessionId, cwd };
      }
    }
  }
  const service: Record<string, unknown> = { ctx };
  for (const method of Object.keys(endpoints) as Method[])
    service[method] = async (input: never, signal: AbortSignal) => {
      try {
        return await dispatch(method, input, signal);
      } catch (e) {
        signal.throwIfAborted();
        if (isProjectConflict(e)) throw e;
        throw new RemoteError(
          "creative-studio/error",
          e instanceof Error ? e.message : String(e),
          { retryable: false },
        );
      }
    };
  service.typertRemote = bindTypertRemote(service, "creativeStudio");
  ctx.provide("creativeStudio", service);
  ctx.effect(() =>
    ctx.typert.register({
      package: contribution.package,
      face: "host",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    }),
  );
  const canvas = new CanvasOperations(
    projects,
    async (libraryId, assetId, signal) => {
      if (!assets) throw new Error("素材库尚未就绪，请重试");
      return assets.resolveAsset({ libraryId, id: assetId }, signal);
    },
  );
  const request: import("../shared/contracts.ts").Request = async (
    method,
    input,
    signal = new AbortController().signal,
  ) =>
    endpoints[method].output.parse(
      await dispatch(method, input, signal),
    ) as import("../shared/contracts.ts").Output<typeof method>;
  const registerTools = (scope: Context, target: string | null) =>
    registerCreativeTools(
      scope,
      {
        projects,
        canvas,
        request,
        open: async (project, signal) =>
          ctx.actveroWorkbenchRuntime.present(
            {
              id: "dsh-creative-studio" as import("@actvero/dsh-capability-ui").WorkbenchId,
              mode: "business",
              sidebar: "focus",
              ai: "hide",
              objectId:
                project.id as import("@actvero/dsh-capability-ui").WorkbenchObjectId,
            },
            signal,
          ),
      },
      target,
    );
  registerCreativeWorkbench(ctx, projects, registerTools, async (scope) => {
    if (!assets) throw new Error("素材库尚未就绪，请重试");
    await assets.activateAssistant(scope);
  });
}
