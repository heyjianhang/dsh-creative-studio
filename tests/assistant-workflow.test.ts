import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type {
  ToolDefinition,
  ToolExecutionToken,
  ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { Projects } from "../src/host/projects.ts";
import { CanvasOperations } from "../src/host/canvas-operations.ts";
import { creativeTools, registerCreativeTools } from "../src/host/assistant.ts";
import {
  endpoints,
  type Project,
  type Request,
  type Output,
} from "../src/shared/contracts.ts";
import { TextGenerations } from "../src/host/text-generation.ts";
import { applyTextResult } from "../src/shared/text-generation.ts";
import type { Generation } from "../src/shared/contracts.ts";

function fixture() {
  const rows = new Map<string, Project>();
  let diskFailure = false;
  const projects = new Projects({
    get: (id) => rows.get(id),
    entries: () => rows.entries(),
    put: async (id, project) => {
      if (diskFailure) throw new Error("disk full");
      rows.set(id, structuredClone(project));
    },
    delete: async (id) => {
      rows.delete(id);
    },
  });
  const canvas = new CanvasOperations(
    projects,
    async (libraryId, assetId, signal) => {
      signal.throwIfAborted();
      if (libraryId !== "library" || assetId !== "coffee")
        throw new Error("素材不存在");
      return {
        kind: "image",
        asset: {
          libraryId,
          id: assetId,
          name: "咖啡.png",
          mime: "image/png",
          size: 100,
        },
      };
    },
  );
  const request: Request = async (method, _input) => {
    const value =
      method === "generations" || method === "mediaJobs"
        ? []
        : method === "textModels"
          ? { models: [], failures: ["未配置模型"], imagesAvailable: false }
          : method === "mediaModels"
            ? { models: [] }
            : undefined;
    if (value === undefined) throw new Error("此测试没有配置生成供应商");
    return endpoints[method].output.parse(value) as Output<typeof method>;
  };
  const opened: string[] = [];
  const services = {
    projects,
    canvas,
    request,
    open: async (p: Project) => {
      opened.push(p.id);
      return { status: "confirmed", project_id: p.id };
    },
  };
  const call = async (
    definitions: ToolDefinition[],
    name: string,
    args: object,
  ) => {
    const tool = definitions.find((t) => t.name === name)!;
    assert.ok(tool, name);
    const ctx: ToolRunContext = {
      callId: ToolCallId("test"),
      rootCallId: ToolCallId("test"),
      token: Symbol("tool") as ToolExecutionToken,
      name,
      arguments: args,
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
    };
    const result = await tool.execute(args, ctx);
    assert.equal(typeof result, "string");
    return JSON.parse(String(result));
  };
  return {
    projects,
    canvas,
    services,
    call,
    opened,
    fail: () => {
      diskFailure = true;
    },
  };
}

test("tool workflow creates one project, resolves materials, edits a graph and opens the saved result", async () => {
  const f = fixture(),
    tools = creativeTools(f.services, null),
    requestId = randomUUID();
  const created = await f.call(tools, "creative_project_create", {
    name: "咖啡太空广告",
    request_id: requestId,
  });
  const repeated = await f.call(tools, "creative_project_create", {
    name: "咖啡太空广告",
    request_id: requestId,
  });
  assert.equal(repeated.id, created.id);
  assert.equal(f.projects.list().length, 1);
  const edited = await f.call(tools, "creative_canvas_edit", {
    project_id: created.id,
    revision: 0,
    changes: {
      nodes: [
        {
          id: "ref",
          kind: "image",
          asset: { library_id: "library", asset_id: "coffee" },
          position: { x: 80, y: 120 },
        },
        {
          id: "concept",
          kind: "text",
          label: "创意 A",
          text: "咖啡星球",
          position: { x: 460, y: 120 },
        },
        {
          id: "output",
          kind: "image",
          prompt: "咖啡豆化作行星",
          reference_ids: ["ref", "concept"],
        },
      ],
    },
  });
  assert.equal(edited.nodes[0].data.asset.name, "咖啡.png");
  assert.equal(edited.edges.length, 2);
  assert.equal(edited.revision, 1);
  await f.call(tools, "creative_project_open", { project_id: created.id });
  assert.deepEqual(f.opened, [created.id]);
  const moved = await f.call(tools, "creative_canvas_edit", {
    project_id: created.id,
    revision: 1,
    changes: {
      nodes: [{ id: "concept", position: { x: 500, y: 180 } }],
      remove_nodes: ["ref"],
    },
  });
  assert.equal(
    moved.nodes.find((n: { id: string }) => n.id === "concept").data.text,
    "咖啡星球",
  );
  assert.deepEqual(
    moved.nodes.find((n: { id: string }) => n.id === "output").data
      .mediaComposer.referenceIds,
    ["concept"],
  );
  assert.equal(moved.edges.length, 1);
});

test("invalid, stale, cancelled and unresolved edits leave the whole graph untouched", async () => {
  const f = fixture(),
    project = await f.projects.create("图");
  const signal = new AbortController().signal;
  for (const changes of [
    {
      nodes: [{ id: "a", kind: "text", text: "A" }],
      connect: [{ source: "a", target: "missing" }],
    },
    {
      nodes: [
        {
          id: "a",
          kind: "image",
          asset: { library_id: "wrong", asset_id: "x" },
        },
      ],
    },
    {
      nodes: [
        { id: "a", kind: "text" },
        { id: "b", kind: "text" },
      ],
      connect: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    },
    { nodes: [{ id: "a", kind: "text", media: { id: randomUUID() } }] },
  ]) {
    await assert.rejects(f.canvas.edit(project.id, 0, changes, signal));
    assert.deepEqual(f.projects.get(project.id), project);
  }
  await assert.rejects(
    f.canvas.edit(project.id, 9, { name: "旧写入" }, signal),
    /更新/,
  );
  await assert.rejects(
    f.canvas.edit(project.id, 0, { name: "取消" }, AbortSignal.abort()),
  );
  f.fail();
  await assert.rejects(
    f.canvas.edit(project.id, 0, { name: "失败" }, signal),
    /disk/,
  );
  assert.deepEqual(f.projects.get(project.id), project);
});

test("fixed-project tools reject writes, opens and generation job actions outside the conversation target", async () => {
  const f = fixture(),
    first = await f.projects.create("A"),
    second = await f.projects.create("B");
  const tools = creativeTools(f.services, first.id);
  for (const [name, args] of [
    ["creative_project_open", { project_id: second.id }],
    [
      "creative_canvas_edit",
      { project_id: second.id, revision: 0, changes: { name: "覆盖" } },
    ],
    [
      "creative_generation_jobs",
      { project_id: second.id, action: "cancel", job_id: randomUUID() },
    ],
    ["creative_project_create", { name: "新图", request_id: randomUUID() }],
  ] as const)
    await assert.rejects(f.call(tools, name, args), /关联|绑定/);
  assert.equal(f.projects.get(second.id).name, "B");
  assert.equal(f.projects.list().length, 2);
  assert.equal((await f.call(tools, "creative_projects", {})).id, first.id);
});

test("conversation disposal releases every creative tool registration", async () => {
  const f = fixture(),
    ctx = new Context(),
    mounted = new Map<string, ToolDefinition>();
  ctx.reflect.provide("tools", {
    register: (tool: ToolDefinition) => {
      mounted.set(tool.name, tool);
      return () => {
        mounted.delete(tool.name);
      };
    },
  });
  const scope = await ctx.plugin({
    apply: (child) => registerCreativeTools(child, f.services, null),
  });
  assert.ok(mounted.has("creative_canvas_edit"));
  assert.ok(mounted.has("creative_generate"));
  await scope.dispose();
  assert.equal(mounted.size, 0);
  await ctx.fiber.dispose();
});

test("completed text lands on a closed canvas, merges concurrent edits, and applies once after acknowledgement failure", async () => {
  const f = fixture();
  const created = await f.projects.create("文案");
  const project = await f.canvas.edit(
    created.id,
    0,
    { nodes: [{ id: "copy", kind: "text", text: "旧文案" }] },
    new AbortController().signal,
  );
  const jobs = new Map<string, Generation>();
  let failAck = false;
  const table = {
    entries: () => jobs.entries(),
    delete: async (id: string) => {
      jobs.delete(id);
    },
    put: async (id: string, value: Generation) => {
      if (failAck && value.applied) throw new Error("ack disk full");
      jobs.set(id, structuredClone(value));
    },
  };
  const apply = async (job: Generation) => {
    await f.projects.transform(job.projectId, (p) => applyTextResult(p, job));
  };
  const service = new TextGenerations(
    table,
    async (_job, _signal, delta) => {
      await f.canvas.edit(
        project.id,
        project.revision,
        { nodes: [{ id: "copy", text: "用户同时写入的文案" }] },
        new AbortController().signal,
      );
      failAck = true;
      delta("新生成的文案");
    },
    10000,
    apply,
  );
  try {
    await service.restore();
    const batchId = randomUUID();
    await service.start(project.id, "copy", batchId, async () => ({
      selection: { provider: "mock", model: "mock" },
      count: 1,
      snapshot: {
        prompt: [],
        instruction: "广告",
        baseText: "旧文案",
        label: "文案",
        position: { x: 0, y: 0 },
        references: [],
      },
    }));
    for (
      let i = 0;
      i < 100 &&
      !service
        .list(project.id)
        .some((j) => j.status === "completed" && !j.applied && j.error);
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const saved = f.projects.get(project.id);
    assert.equal(saved.nodes[0].data.text, "用户同时写入的文案");
    assert.equal(
      saved.nodes.filter((n) => n.data.text === "新生成的文案").length,
      1,
    );
    failAck = false;
    await service.applyResults(project.id);
    await service.applyResults(project.id);
    assert.equal(f.projects.get(project.id).nodes.length, 2);
    assert.equal(service.list(project.id)[0].applied, true);
    assert.equal(service.list(project.id)[0].error, undefined);
  } finally {
    await service.close();
  }
});

test("creative tools configure, submit, follow and read a generated result without exposing provider credentials", async () => {
  const f = fixture(),
    jobs = new Map<string, Generation>();
  let calls = 0;
  const queue = new TextGenerations(
    {
      entries: () => jobs.entries(),
      put: async (id, j) => {
        jobs.set(id, structuredClone(j));
      },
      delete: async (id) => {
        jobs.delete(id);
      },
    },
    async (job, _signal, delta) => {
      calls++;
      assert.equal(job.snapshot.instruction, "写一句咖啡广告");
      delta("一口，探索新的星球。");
    },
    10000,
    async (job) => {
      await f.projects.transform(job.projectId, (p) => applyTextResult(p, job));
    },
  );
  f.services.request = async (
    method,
    input,
    signal = new AbortController().signal,
  ) => {
    signal.throwIfAborted();
    let result: unknown;
    if (method === "generateText") {
      const r = endpoints.generateText.input.parse(input);
      result = await queue.start(
        r.projectId,
        r.nodeId,
        r.requestId,
        async () => {
          const p = f.projects.get(r.projectId),
            node = p.nodes.find((n) => n.id === r.nodeId)!;
          if (p.revision !== r.revision) throw new Error("画布已更新");
          return {
            selection: node.data.composer!.selection!,
            count: 1,
            snapshot: {
              prompt: node.data.composer!.prompt,
              instruction: "写一句咖啡广告",
              baseText: node.data.text,
              label: node.data.label,
              position: node.position,
              references: [],
            },
          };
        },
      );
    } else if (method === "generations") {
      const r = endpoints.generations.input.parse(input);
      await queue.applyResults(r.projectId);
      result = queue.list(r.projectId);
    } else if (method === "mediaJobs") result = [];
    else throw new Error("Unexpected test route");
    return endpoints[method].output.parse(result) as Output<typeof method>;
  };
  const tools = creativeTools(f.services, null);
  try {
    const p = await f.call(tools, "creative_project_create", {
      name: "文案方案",
      request_id: randomUUID(),
    });
    const edited = await f.call(tools, "creative_canvas_edit", {
      project_id: p.id,
      revision: 0,
      changes: {
        nodes: [
          {
            id: "copy",
            kind: "text",
            prompt: "写一句咖啡广告",
            text_model: { provider: "mock", model: "mock" },
          },
        ],
      },
    });
    const batchId = randomUUID(),
      args = {
        project_id: p.id,
        node_id: "copy",
        revision: edited.revision,
        request_id: batchId,
      };
    const submitted = await f.call(tools, "creative_generate", args);
    assert.equal(submitted.jobs.length, 1);
    for (let i = 0; i < 100 && !queue.list(p.id)[0]?.applied; i++)
      await new Promise((r) => setTimeout(r, 5));
    const status = await f.call(tools, "creative_generation_jobs", {
      project_id: p.id,
    });
    assert.equal(status.jobs[0].status, "completed");
    assert.equal(status.jobs[0].applied, true);
    const saved = await f.call(tools, "creative_projects", {
      project_id: p.id,
    });
    assert.equal(saved.nodes[0].data.text, "一口，探索新的星球。");
    assert.ok(saved.revision > args.revision);
    const repeated = await f.call(tools, "creative_generate", args);
    assert.equal(repeated.jobs[0].id, submitted.jobs[0].id);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(status).includes("apiKey"));
  } finally {
    await queue.close();
  }
});


test("partial model edits preserve unmentioned parameters and explicit reference removal clears old prompt markers", async () => {
  const f=fixture(),p=await f.projects.create("参数"),signal=new AbortController().signal;
  const initial=await f.canvas.edit(p.id,0,{nodes:[{id:"ref",kind:"text",text:"创意"},{id:"video",kind:"video",parameters:{ratio:"16:9",resolution:"1080p",duration:10,audio:true,seed:9}}]},signal);
  initial.nodes[1]!.data.mediaComposer!.prompt=[{type:"reference",nodeId:"ref",label:"创意"},{type:"text",text:"继续"}];
  initial.nodes[1]!.data.mediaComposer!.referenceIds=["ref"];
  const saved=await f.projects.save(initial);
  const edited=await f.canvas.edit(p.id,saved.revision,{nodes:[{id:"video",parameters:{duration:8},reference_ids:[]}]},signal);
  assert.deepEqual(edited.nodes[1]!.data.mediaComposer!.parameters,{ratio:"16:9",resolution:"1080p",duration:8,mode:"reference",audio:true,seed:9});
  assert.deepEqual(edited.nodes[1]!.data.mediaComposer!.prompt,[{type:"text",text:"继续"}]);
});
