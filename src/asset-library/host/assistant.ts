import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-attachment";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import { LibraryService } from "./service.ts";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value) },
  ],
};
const string = { type: "string" as const };
const strings = { type: "array" as const, items: string };
const libraryId = {
  ...string,
  required: true as const,
  description: "素材库 ID，先用 asset_library_list 查询",
};

export async function registerAssistant(
  ctx: Context,
  library: LibraryService,
  skillURL = new URL(
    "../skills/asset-library-assistant/SKILL.md",
    import.meta.url,
  ),
) {
  const source = await readFile(skillURL, "utf8");
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!header) throw new Error("素材库助手 Skill 缺少元数据");
  const name = header[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = header[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error("素材库助手 Skill 元数据不完整");
  ctx.inject(["skills"], (ctx) => {
    ctx.skills.register({
      name,
      description,
      source: "bundled",
      provider: "dsh-asset-library",
      path: fileURLToPath(skillURL),
      resourceBase: {
        kind: "directory",
        path: dirname(fileURLToPath(skillURL)),
      },
      content: source.slice(header[0].length),
      invocation: { modelInvocable: true, userInvocable: true },
    });
  });
  ctx.inject(["tools"], (ctx) => {
    ctx.tools.register(
      defineTool({
        name: "asset_library_list",
        description:
          "列出本机素材库、收藏夹、标签及索引配置状态。不会返回密钥。先获取 library_id 再操作。",
        parameters: {},
        output: jsonOutput,
        execute: async (_args, exec) => {
          exec.signal.throwIfAborted();
          const s = await library.snapshot();
          return {
            libraries: s.libraries,
            collections: s.collections,
            tags: s.tags,
            aiConfigured: s.keyConfigured,
          };
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_manage",
        description:
          "创建空文件夹素材库、打开现有库或关闭库；不删除库和源文件。S3 使用设置中已有连接。",
        parameters: {
          action: {
            ...string,
            enum: ["create", "open", "close"],
            required: true,
          },
          path: {
            ...string,
            description: "宿主机器上的绝对文件夹路径；create/open 必填",
          },
          name: string,
          library_id: string,
          storage_mode: { ...string, enum: ["local", "s3"] },
        },
        output: jsonOutput,
        execute: (a, exec) =>
          library.dispatch(
            "library",
            {
              action: a.action as "create" | "open" | "close",
              path: a.path,
              name: a.name,
              id: a.library_id,
              storageMode: a.storage_mode as "local" | "s3" | undefined,
            },
            exec.signal,
          ),
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_import",
        description:
          "扫描本机文件/文件夹，返回持久导入计划 ID、数量和前50项。默认只扫描；execute=true 后台开始复制，保留源文件并按 SHA-256 去重。用 jobs 查看完整结果。",
        parameters: {
          library_id: libraryId,
          paths: { ...strings, required: true },
          recursive: { type: "boolean" },
          execute: {
            type: "boolean",
            description: "明确要导入时设 true；默认 false 只生成计划",
          },
          tags: strings,
          collection_ids: strings,
        },
        output: jsonOutput,
        execute: async (a, exec) => {
          const r = z
            .object({
              libraryId: z.string(),
              paths: z.array(z.string().min(1).max(4000)).min(1).max(100),
              recursive: z.boolean(),
              tags: z.array(z.string().trim().min(1).max(80)).max(50),
              collectionIds: z.array(z.string()).max(100),
            })
            .parse({
              libraryId: a.library_id,
              paths: a.paths,
              recursive: a.recursive ?? true,
              tags: a.tags ?? [],
              collectionIds: a.collection_ids ?? [],
            });
          const plan = await library.imports.scan(r, exec.signal);
          exec.signal.throwIfAborted();
          return a.execute
            ? library.imports.control(plan.id, "resume", a.library_id)
            : plan;
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_jobs",
        description:
          "查看导入任务与 AI 索引任务；按 ID 分页读取每文件结果，或暂停/恢复/重试/取消。取消保留已导入文件。导入完成不代表索引完成。",
        parameters: {
          library_id: string,
          id: string,
          action: {
            ...string,
            enum: ["list", "get", "pause", "resume", "retry", "cancel"],
          },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        output: jsonOutput,
        execute: async (a, exec) => {
          exec.signal.throwIfAborted();
          const action = a.action ?? "list";
          if (action === "list") {
            const s = await library.snapshot();
            return {
              imports: library.imports.list(a.library_id),
              indexTasks: s.tasks.filter(
                (t) =>
                  t.assetId && (!a.library_id || t.libraryId === a.library_id),
              ),
            };
          }
          if (!a.id) throw new Error("请指定任务 ID");
          if (library.imports.has(a.id)) {
            if (action === "get")
              return library.imports.get(
                a.id,
                z
                  .number()
                  .int()
                  .min(0)
                  .parse(a.offset ?? 0),
                z
                  .number()
                  .int()
                  .min(1)
                  .max(100)
                  .parse(a.limit ?? 50),
              );
            return library.imports.control(
              a.id,
              action as "pause" | "resume" | "retry" | "cancel",
              a.library_id,
            );
          }
          const task = (await library.snapshot()).tasks.find(
            (t) =>
              t.id === a.id && (!a.library_id || t.libraryId === a.library_id),
          );
          if (!task) throw new Error("任务不存在");
          return action === "get"
            ? task
            : library.dispatch(
                "task",
                {
                  libraryId: task.libraryId,
                  id: task.id,
                  action: action as "pause" | "resume" | "retry" | "cancel",
                },
                exec.signal,
              );
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_search",
        description:
          "查找图片/视频；query 可为空以浏览。ai=true 使用已有多模态索引找画面，默认 false 文件名/标签/备注搜索。返回真实素材 ID、视频命中秒数和未索引数量。",
        parameters: {
          query: { ...string, required: true },
          library_id: string,
          ai: { type: "boolean" },
          kind: { ...string, enum: ["all", "image", "video"] },
          tags: strings,
          collection_ids: strings,
          within_days: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        output: jsonOutput,
        execute: (a, exec) =>
          library.dispatch(
            "search",
            {
              query: a.query,
              libraryId: a.library_id,
              ai: a.ai ?? false,
              kind: a.kind as "all" | "image" | "video" | undefined,
              tags: a.tags,
              collectionIds: a.collection_ids,
              withinDays: a.within_days,
              limit: a.limit ?? 20,
              offset: a.offset,
            },
            exec.signal,
          ),
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_update",
        description:
          "批量重命名显示名称、编辑备注、增删标签或收藏夹归属。每批最多100项，同库事务提交；保留未涉及字段，不移动/删除原文件。",
        parameters: {
          library_id: libraryId,
          changes: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { ...string, required: true },
                name: string,
                notes: string,
                addTags: strings,
                removeTags: strings,
                addCollections: strings,
                removeCollections: strings,
              },
            },
          },
        },
        output: jsonOutput,
        execute: (a, exec) =>
          library.editBatch(
            { libraryId: a.library_id, changes: a.changes },
            exec.signal,
          ),
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_collections",
        description:
          "创建、重命名或删除一层收藏夹。同一素材库内名称唯一，素材可属于多个收藏夹。默认收藏夹不可修改；删除收藏夹保留素材。优先复用 list 返回的分类。",
        parameters: {
          library_id: libraryId,
          action: {
            ...string,
            enum: ["create", "rename", "delete"],
            required: true,
          },
          id: string,
          name: string,
        },
        output: jsonOutput,
        execute: async (a, exec) => {
          await library.dispatch(
            "collection",
            {
              libraryId: a.library_id,
              action: a.action as "create" | "rename" | "delete",
              id: a.id,
              name: a.name,
            },
            exec.signal,
          );
          return {
            collections: (await library.snapshot()).collections.filter(
              (c) => c.libraryId === a.library_id,
            ),
          };
        },
      }),
    );
    ctx.tools.register(
      defineTool({
        name: "asset_library_index",
        description:
          "为指定素材建立或重建 AI 索引，最多100个；使用素材库设置中的火山多模态嵌入模型，会发送画面并消耗调用额度。异步执行，用 jobs 查询。",
        parameters: {
          library_id: libraryId,
          asset_ids: { ...strings, required: true },
        },
        output: jsonOutput,
        execute: (a, exec) =>
          library.indexAssets(a.library_id, a.asset_ids, exec.signal),
      }),
    );
  });
  ctx.inject(["tools", "attachments"], (ctx) => {
    ctx.tools.register(
      defineTool({
        name: "asset_library_inspect",
        description:
          "读取素材元数据并展示图片或视频指定秒数的抽帧（最多4帧，默认首帧）。输出 DSH 原生图片附件，供支持图片的对话模型查看与分类，不执行 Embedding。",
        parameters: {
          library_id: libraryId,
          id: { ...string, required: true },
          frames: { type: "array", items: { type: "number" } },
        },
        output: {
          schema: { type: "json" },
          render: (_args, value) => {
            const result = value as unknown as {
              asset: unknown;
              width: number | null;
              height: number | null;
              duration: number | null;
              frames: {
                time: number;
                attachment: Awaited<
                  ReturnType<typeof ctx.attachments.saveImage>
                >;
              }[];
            };
            return [
              {
                type: "text",
                text: JSON.stringify({
                  ...result,
                  frames: result.frames.map((f) => ({ time: f.time })),
                }),
              },
              ...result.frames.flatMap((f) => [
                { type: "text" as const, text: `参考帧 ${f.time}s` },
                { type: "image" as const, attachment: f.attachment },
              ]),
            ];
          },
        },
        execute: async (a, exec) => {
          const result = await library.inspectAsset(
            { libraryId: a.library_id, id: a.id, frames: a.frames },
            exec.signal,
          );
          const frames = [];
          for (const frame of result.frames) {
            exec.signal.throwIfAborted();
            const data = await readFile(frame.path);
            if (data.length > 10 * 1024 ** 2)
              throw new Error("预览超过图片大小限制");
            const attachment = await ctx.attachments.saveImage({
              data,
              mediaType: "image/jpeg",
              name: `${result.asset.name} (${frame.time}s)`,
            });
            exec.signal.throwIfAborted();
            frames.push({ time: frame.time, attachment: { ...attachment } });
          }
          return { ...result, frames };
        },
      }),
    );
  });
}
