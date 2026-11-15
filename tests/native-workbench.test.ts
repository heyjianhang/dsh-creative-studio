import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import type {
  WorkbenchCustomProvider,
  WorkbenchRuntime,
  WorkbenchObjectId,
} from "@actvero/dsh-capability-ui";
import { registerCreativeWorkbench } from "../src/host/workbench.ts";
import { Projects } from "../src/host/projects.ts";
import type { Project } from "../src/shared/contracts.ts";

test("native provider resolves real projects and activates tools only for the fixed conversation object", async () => {
  const ctx = new Context();
  let registered: WorkbenchCustomProvider | undefined;
  ctx.provide("actveroWorkbenchRuntime", {
    register(provider: WorkbenchCustomProvider) {
      registered = provider;
      return () => {
        registered = undefined;
      };
    },
  } as WorkbenchRuntime);
  const rows = new Map<string, Project>();
  const projects = new Projects({
    get: (id) => rows.get(id),
    entries: () => rows.entries(),
    put: async (id, value) => {
      rows.set(id, value);
    },
    delete: async (id) => {
      rows.delete(id);
    },
  });
  const first = await projects.create("品牌短片");
  const second = await projects.create("产品探索");
  const targets: (string | null)[] = [];
  let materialActivations = 0;
  await ctx.plugin({
    apply: (scope) =>
      registerCreativeWorkbench(
        scope,
        projects,
        (_scope, target) => {
          targets.push(target);
        },
        async () => {
          materialActivations++;
        },
        new URL(
          "../skills/creative-studio-assistant/SKILL.md",
          import.meta.url,
        ),
      ),
  });
  const provider = registered!;
  assert.equal(provider.ai, true);
  assert.equal(materialActivations, 0);
  const environment = {
    id: provider.id,
    version: provider.version,
    instanceId:
      "test" as import("@actvero/dsh-capability-ui").WorkbenchInstanceId,
    dataDirectory: "/tmp/creative-test",
    resourcesDirectory: null,
    storage: "custom" as const,
    aiEnabled: true,
  };
  const signal = new AbortController().signal;
  assert.deepEqual(
    await provider.resolveObject!(
      first.id as WorkbenchObjectId,
      environment,
      signal,
    ),
    { label: first.name },
  );
  const activation = await provider.activate!(
    ctx,
    {
      ...environment,
      sessionId: "s" as import("@deepseek-ai/dsh-session/types").SessionId,
      object: { id: first.id as WorkbenchObjectId, label: first.name },
    },
    signal,
  );
  assert.deepEqual(targets, [first.id]);
  assert.equal(materialActivations, 1);
  assert.match(activation.expert!.instructions, new RegExp(first.id));
  assert.ok(!activation.expert!.instructions.includes(second.id));
  await projects.remove(first.id, first.revision);
  await assert.rejects(
    provider.resolveObject!(first.id as WorkbenchObjectId, environment, signal),
    /不存在/,
  );
  await ctx.fiber.dispose();
  assert.equal(registered, undefined);
});
