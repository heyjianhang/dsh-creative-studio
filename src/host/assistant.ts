/** Conversation-scoped tools for project planning, canvas edits and generation jobs. */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  projectSchema,
  endpoints,
  type Request,
  type Project,
} from "../shared/contracts.ts";
import { isGenerationNode } from "../shared/media-reference.ts";
import { Projects } from "./projects.ts";
import { CanvasOperations } from "./canvas-operations.ts";

const output = {
  schema: { type: "string" as const },
  render: (_args: object, value: string) => [
    { type: "text" as const, text: value },
  ],
};
const projectId = {
  type: "string" as const,
  required: true as const,
  description: "真实项目 UUID；先用 creative_projects 读取",
};
const revision = {
  type: "integer" as const,
  required: true as const,
  description: "最近读取的项目 revision；冲突后重新读取，不覆盖用户修改",
};
const requestId = {
  type: "string" as const,
  required: true as const,
  description: "此操作的 UUID 请求编号；结果未知时复用同一编号，不创建重复请求",
};
const json = (value: unknown) => JSON.stringify(value);

/** Services shared with the interactive canvas, without direct storage access. */
export interface CreativeAssistantServices {
  projects: Projects;
  canvas: CanvasOperations;
  request: Request;
  open(project: Project, signal: AbortSignal): Promise<unknown>;
}
/** Build tools for the current fixed project, or all projects in an instance-wide chat.
 * @param services Existing project, material and generation services.
 * @param target Fixed project ID; null grants instance-wide project selection.
 * @returns Definitions registered only for the associated conversation lifetime.
 */
export function creativeTools(
  services: CreativeAssistantServices,
  target: string | null,
) {
  const access = (id: string) => {
    projectSchema.shape.id.parse(id);
    if (target && id !== target)
      throw new Error(
        "此对话仅能操作关联项目；请在创作管理页打开 AI 来管理其他项目",
      );
    return id;
  };
  const current = (id: string) => services.projects.get(access(id));
  const title = (text: string) => () => ({
    card: "generic" as const,
    title: text,
    kind: "other" as const,
  });
  return [
    defineTool({
      name: "creative_projects",
      description:
        "读取创作项目及最新 revision、节点、提示词与连线。项目级对话仅返回关联项目；管理页对话省略 ID 列出摘要。",
      parameters: { project_id: { type: "string" } },
      output,
      execute: async (a, exec) => {
        exec.signal.throwIfAborted();
        return json(
          target || a.project_id
            ? current(target ?? a.project_id!)
            : services.projects.list().map(({ id, name, revision, nodes }) => ({
                id,
                name,
                revision,
                nodeCount: nodes.length,
              })),
        );
      },
      presentCall: title("读取创作项目"),
    }),
    defineTool({
      name: "creative_project_create",
      description:
        "创建空白项目/画布并持久保存。仅管理页的工作台级对话可创建；相同请求 UUID 重试返回原项目，不重复创建。随后用 creative_canvas_edit 放入内容，用 creative_project_open 展示。",
      parameters: {
        name: { type: "string", required: true },
        request_id: requestId,
      },
      output,
      execute: async (a, exec) => {
        exec.signal.throwIfAborted();
        if (target)
          throw new Error(
            "当前对话绑定已有项目，请从创作管理页打开 AI 后新建项目",
          );
        return json(await services.projects.create(a.name, a.request_id));
      },
      presentCall: title("创建创作画布"),
    }),
    defineTool({
      name: "creative_canvas_edit",
      description:
        "原子编辑画布并保存：可改项目名、增改删除节点、按坐标排版、添加/断开参考连线及配置生成。changes.nodes 为按 id 合并的节点数组；新节点必填 kind(text/image/video)。可填 label,text,position:{x,y},asset:{library_id,asset_id},prompt,reference_ids,model_id,text_model:{provider,model},parameters,count,frames:{first,last},color_pins。其余字段为 name,remove_nodes:[id],connect:[{source,target}],disconnect:[edge_id],viewport:{x,y,zoom}。媒体元数据自动读取，禁止提供路径。先读取 revision；失败不会部分保存。",
      parameters: {
        project_id: projectId,
        revision,
        changes: {
          type: "json",
          required: true,
          description: "画布编辑对象，详见工具描述及创作专家 Skill",
        },
      },
      output,
      execute: async (a, exec) =>
        json(
          await services.canvas.edit(
            access(a.project_id),
            a.revision,
            a.changes,
            exec.signal,
          ),
        ),
      presentCall: title("编辑创作画布"),
    }),
    defineTool({
      name: "creative_assets_search",
      description:
        "查询创作素材及组合；查找原始图片视频、文件夹与视觉内容请优先使用 asset_library_list/search/inspect。",
      parameters: {
        query: { type: "string" },
        project_id: { type: "string" },
      },
      output,
      execute: async (a, exec) =>
        json(
          await services.request(
            "creativeAssets",
            endpoints.creativeAssets.input.parse({
              query: a.query ?? "",
              projectId:
                target ?? (a.project_id ? access(a.project_id) : undefined),
              ai: false,
            }),
            exec.signal,
          ),
        ),
      presentCall: title("查找创作素材"),
    }),
    defineTool({
      name: "creative_add_text",
      description:
        "向指定项目添加文字节点。需要精确位置或多个节点时使用 creative_canvas_edit。",
      parameters: {
        project_id: projectId,
        text: { type: "string", required: true },
      },
      output,
      execute: async (a, exec) => {
        exec.signal.throwIfAborted();
        if (a.text.length > 30000) throw new Error("文本过长");
        return json(
          await services.projects.addText(access(a.project_id), a.text),
        );
      },
      presentCall: title("添加画布文字"),
    }),
    defineTool({
      name: "creative_project_open",
      description:
        "在用户界面展示已有项目；不改变当前对话绑定，不发送 AI 消息。没有连接的界面时仍保留已保存项目；只按返回的展示状态报告。",
      parameters: { project_id: projectId },
      output,
      execute: async (a, exec) =>
        json(await services.open(current(a.project_id), exec.signal)),
      presentCall: title("打开创作项目"),
    }),
    defineTool({
      name: "creative_models",
      description:
        "读取已配置且启用的文字、图片和视频生成模型及能力。没有模型时去外层创作设置配置；不返回密钥，不自动付费生成。",
      parameters: {},
      output,
      execute: async (_a, exec) =>
        json({
          text: await services.request("textModels", {}, exec.signal),
          media: await services.request("mediaModels", {}, exec.signal),
        }),
      presentCall: title("读取生成模型"),
    }),
    defineTool({
      name: "creative_generate",
      description:
        "按节点已保存的提示词、参考和模型提交文字/图片/视频任务，可能消耗模型额度。先用 creative_canvas_edit 配置节点。提交成功仅表示排队，使用 creative_generation_jobs 查询；完成结果由 Host 自动写入画布。为保留原件，不可对上传原件直接生成，请新建目标节点并引用原件。相同 request_id 用于安全恢复同一次提交。",
      parameters: {
        project_id: projectId,
        node_id: { type: "string", required: true },
        revision,
        request_id: requestId,
      },
      output,
      execute: async (a, exec) => {
        const project = current(a.project_id);
        endpoints.generateText.input.parse({ projectId: project.id, nodeId: a.node_id, revision: a.revision, requestId: a.request_id });
        const previous = [
          ...(await services.request(
            "generations",
            { projectId: project.id },
            exec.signal,
          )),
          ...(await services.request(
            "mediaJobs",
            { projectId: project.id },
            exec.signal,
          )),
        ].filter((job) => job.batchId === a.request_id);
        if (previous.some((job) => job.nodeId !== a.node_id))
          throw new Error("生成请求不匹配");
        const node = project.nodes.find((n) => n.id === a.node_id);
        if (previous.length)
          return json({
            project_id: project.id,
            jobs: previous.map((job) => ({
              id: job.id,
              batch_id: job.batchId,
              node_id: job.nodeId,
              status: job.status,
              applied: job.applied,
            })),
          });
        if (!node) throw new Error("生成节点不存在");
        if (!isGenerationNode(node))
          throw new Error(
            "请新建生成目标节点，并将原素材设为参考，保留上传原件",
          );
        const method =
          node.data.kind === "text" ? "generateText" : "generateMedia";
        const jobs = await services.request(
          method,
          {
            projectId: project.id,
            nodeId: node.id,
            revision: a.revision,
            requestId: a.request_id,
          },
          exec.signal,
        );
        return json({
          project_id: project.id,
          jobs: jobs.map((j) => ({
            id: j.id,
            batch_id: j.batchId,
            node_id: j.nodeId,
            status: j.status,
            applied: j.applied,
          })),
        });
      },
      presentCall: title("提交创作生成任务"),
    }),
    defineTool({
      name: "creative_generation_jobs",
      description:
        "同步完成结果并查询项目生成任务，或取消/重试指定任务。完成但 applied=false 表示尚未写入画布，错误修复后再次 list 会重试落盘，不重新计费生成。unknown/uncertain 提交需先核对供应商，不能盲目重试。",
      parameters: {
        project_id: projectId,
        action: { type: "string", enum: ["list", "cancel", "retry"] },
        job_id: { type: "string" },
      },
      output,
      execute: async (a, exec) => {
        const project = current(a.project_id);
        const text = await services.request(
          "generations",
          { projectId: project.id },
          exec.signal,
        );
        const media = await services.request(
          "mediaJobs",
          { projectId: project.id },
          exec.signal,
        );
        if (a.action && a.action !== "list") {
          if (!a.job_id) throw new Error("任务操作需要 job_id");
          const kind = text.some((j) => j.id === a.job_id)
            ? "text"
            : media.some((j) => j.id === a.job_id)
              ? "media"
              : null;
          if (!kind) throw new Error("任务不存在或不属于当前项目");
          await services.request(
            kind === "text" ? "generationAction" : "mediaJobAction",
            { id: a.job_id, action: a.action as "cancel" | "retry" },
            exec.signal,
          );
          return json({
            project_id: project.id,
            action: a.action,
            job_id: a.job_id,
          });
        }
        return json({
          project_id: project.id,
          revision: services.projects.get(project.id).revision,
          jobs: [
            ...text.map((j) => ({
              id: j.id,
              batch_id: j.batchId,
              node_id: j.nodeId,
              kind: "text",
              status: j.status,
              applied: j.applied,
              error: j.error,
              text: j.text,
            })),
            ...media.map((j) => ({
              id: j.id,
              batch_id: j.batchId,
              node_id: j.nodeId,
              kind: j.kind,
              status: j.status,
              stage: j.stage,
              applied: j.applied,
              error: j.error,
              result: j.result,
            })),
          ],
        });
      },
      presentCall: title("同步创作生成任务"),
    }),
  ];
}
/** Register tool contributions under their conversation scope.
 * @param ctx Conversation lifetime owner.
 * @param services Shared business operations.
 * @param target Fixed project, or null for instance-wide operations.
 */
export function registerCreativeTools(
  ctx: Context,
  services: CreativeAssistantServices,
  target: string | null,
) {
  for (const tool of creativeTools(services, target))
    ctx.effect(() => ctx.tools.register(tool));
}
