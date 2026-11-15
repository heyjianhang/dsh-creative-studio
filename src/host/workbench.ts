/** Native workbench identity and conversation-scoped creative tools. */
import type { Context } from "@deepseek-ai/cordis";
import type {
  WorkbenchId,
  WorkbenchRuntime,
  WorkbenchCustomProvider,
} from "@actvero/dsh-capability-ui";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type {} from "@deepseek-ai/dsh-skill";
import manifest from "../../package.json" with { type: "json" };
import metadata from "../../workbench.json" with { type: "json" };
import type { Projects } from "./projects.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    actveroWorkbenchRuntime: WorkbenchRuntime;
  }
}

/** Register native AI against the same project and material services as the UI.
 * @param ctx Owning Host scope.
 * @param projects Authoritative project repository, including existing user projects.
 * @param tools Creative tools mounted only in an associated conversation.
 * @param materials Material tools and bundled Skill mounted in the same scope.
 * @param skillURL Shipped creative Skill, resolved beside the bundled Host entry.
 */
export function registerCreativeWorkbench(
  ctx: Context,
  projects: Projects,
  tools: (scope: Context, projectId: string | null) => void,
  materials: (scope: Context) => Promise<void>,
  skillURL = new URL(
    "../skills/creative-studio-assistant/SKILL.md",
    import.meta.url,
  ),
): void {
  ctx.inject(["actveroWorkbenchRuntime"], (scope) => {
    const provider: WorkbenchCustomProvider = {
      id: manifest.name as WorkbenchId,
      name: metadata.name,
      version: manifest.version,
      protocol: { ...metadata.protocol, schemaVersion: 1 },
      ai: true,
      async resolveObject(id, _environment, signal) {
        signal.throwIfAborted();
        return { label: projects.get(id).name };
      },
      async activate(conversation, environment, signal) {
        signal.throwIfAborted();
        const source = await readFile(skillURL, "utf8");
        signal.throwIfAborted();
        const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
        const description = header?.[1]
          .match(/^description:\s*(.+)$/m)?.[1]
          ?.trim();
        if (!header || !description)
          throw new Error("创作专家 Skill 元数据不完整");
        const guidance = source.slice(header[0].length);
        conversation.inject(["skills"], (scope) =>
          scope.effect(() =>
            scope.skills.register({
              name: "creative-studio-assistant",
              description,
              source: "bundled",
              provider: manifest.name,
              path: fileURLToPath(skillURL),
              resourceBase: {
                kind: "directory",
                path: dirname(fileURLToPath(skillURL)),
              },
              content: guidance,
              invocation: { modelInvocable: true, userInvocable: true },
            }),
          ),
        );
        const projectId = environment.object?.id ?? null;
        if (projectId) projects.get(projectId);
        tools(conversation, projectId);
        await materials(conversation);
        signal.throwIfAborted();
        const instructions = `${projectId ? `当前对话固定关联项目 ID：${projectId}。项目工具只操作此项目，不随其他窗口的选择改变。` : "当前是工作台级对话；先读取项目，可以按需求创建独立项目。"}\n\n${guidance}`;
        return {
          digest: createHash("sha256")
            .update(manifest.version + instructions)
            .digest("hex"),
          expert: { name: "创作助手", version: manifest.version, instructions },
        };
      },
    };
    scope.effect(() => scope.actveroWorkbenchRuntime.register(provider));
  });
}
