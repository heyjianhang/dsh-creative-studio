import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  TextGenerations,
  textError,
  type GenerationTable,
  type PreparedText,
} from "../src/host/text-generation.ts";
import { textMessages, TextRuntime } from "../src/host/text-runtime.ts";
import {
  applyTextResult,
  instructionText,
  referenceIds,
  referenceProblem,
  referencePickProblem,
} from "../src/shared/text-generation.ts";
import {
  projectSchema,
  generationSchema,
  type Project,
  type Generation,
  type CreativeNode,
} from "../src/shared/contracts.ts";

const textNode = (id: string, text = "正文"): CreativeNode => ({
  id,
  type: "creative",
  position: { x: 0, y: 0 },
  data: { kind: "text", label: id, text },
});
const project = (): Project =>
  projectSchema.parse({
    id: randomUUID(),
    name: "测试画布",
    revision: 0,
    createdAt: "2026-10-26",
    updatedAt: "2026-10-26",
    nodes: [textNode("target")],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
const prepared = (count = 1): PreparedText => ({
  selection: { provider: "configured-provider", model: "configured-model" },
  count,
  snapshot: {
    prompt: [{ type: "text", text: "写一句文案" }],
    instruction: "写一句文案",
    baseText: "正文",
    label: "文本",
    position: { x: 10, y: 20 },
    references: [],
  },
});
const result = (p: Project, partial: Partial<Generation> = {}): Generation => ({
  id: randomUUID(),
  batchId: randomUUID(),
  projectId: p.id,
  nodeId: "target",
  index: 0,
  ...prepared(),
  status: "completed",
  applied: false,
  text: "新正文",
  createdAt: new Date().toISOString(),
  ...partial,
});
function memory() {
  const rows = new Map<string, Generation>();
  let fail = false;
  const table: GenerationTable = {
    entries: () => rows.entries(),
    put: async (id, value) => {
      if (fail) throw new Error("disk full");
      rows.set(id, generationSchema.parse(structuredClone(value)));
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
  return {
    table,
    rows,
    setFailure: (value: boolean) => {
      fail = value;
    },
  };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition timeout");
    await sleep(5);
  }
}
function gate<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("references are deduplicated by ID, unmentioned references remain context and mentions resolve by ordinal", () => {
  const config = {
    count: 1 as const,
    referenceIds: ["a", "b"],
    prompt: [
      { type: "text" as const, text: "根据" },
      { type: "reference" as const, nodeId: "b", label: "同名" },
      { type: "reference" as const, nodeId: "b", label: "同名" },
    ],
  };
  assert.deepEqual(referenceIds(config), ["a", "b"]);
  assert.equal(
    instructionText(config.prompt, referenceIds(config)),
    "根据【参考 2】【参考 2】",
  );
  const snapshot = prepared().snapshot;
  snapshot.instruction = instructionText(config.prompt, referenceIds(config));
  snapshot.references = [
    { nodeId: "a", label: "同名", text: "第一项正文" },
    {
      nodeId: "b",
      label: "同名",
      image: {
        attachmentId: "stored-image",
        bytes: 100,
        width: 20,
        height: 30,
        mediaType: "image/png",
      },
    },
  ];
  const messages = textMessages(snapshot, 1, 2);
  assert.equal(messages.length, 1);
  assert.ok(JSON.stringify(messages).includes("第一项正文"));
  assert.equal(messages[0].content.filter((c) => c.type === "image").length, 1);
  assert.match(JSON.stringify(messages), /stored-image/);
  assert.match(JSON.stringify(messages), /第 2 个/);
});

test("reference selection rejects empty, missing, self, cyclic and incompatible inputs", () => {
  const p = project();
  p.nodes.push(
    textNode("ref"),
    textNode("empty", ""),
    { ...textNode("video"), data: { kind: "video", label: "clip", text: "" } },
    {
      ...textNode("image"),
      data: {
        kind: "image",
        label: "ref",
        text: "",
        media: {
          id: randomUUID(),
          name: "ref.png",
          mime: "image/png",
          size: 100,
        },
      },
    },
  );
  assert.equal(referenceProblem(p, "target", "target"), "referenceSelf");
  assert.equal(referenceProblem(p, "target", "deleted"), "referenceMissing");
  assert.equal(referenceProblem(p, "target", "empty"), "referenceEmpty");
  assert.equal(referenceProblem(p, "target", "video"), "referenceVideo");
  assert.equal(
    referenceProblem(p, "target", "image", "no"),
    "referenceNoImages",
  );
  assert.equal(referenceProblem(p, "target", "image", "unknown"), undefined);
  p.edges = [{ id: "outgoing", source: "target", target: "ref" }];
  assert.equal(referenceProblem(p, "target", "ref"), "cycle");
});

test("reference picking disables connected, attached and mentioned nodes without invalidating generation context", () => {
  const p = project();
  p.nodes.push(
    ...["connected", "attached", "mentioned", "available"].map((id) =>
      textNode(id),
    ),
  );
  p.edges.push({
    id: "existing-connection",
    source: "connected",
    target: "target",
  });
  p.nodes[0].data.composer = {
    count: 1,
    referenceIds: ["attached"],
    prompt: [{ type: "reference", nodeId: "mentioned", label: "参考" }],
  };
  for (const id of ["connected", "attached", "mentioned"]) {
    assert.equal(referencePickProblem(p, "target", id), "referenceAdded");
    assert.equal(referenceProblem(p, "target", id), undefined);
  }
  assert.equal(referencePickProblem(p, "target", "available"), undefined);
  p.nodes[0].data.composer.referenceIds.push("available");
  assert.equal(
    referencePickProblem(p, "target", "available"),
    "referenceAdded",
  );
  p.nodes[0].data.composer.referenceIds.pop();
  assert.equal(referencePickProblem(p, "target", "available"), undefined);
});

test("completed results preserve edits, prior versions, extra variations and deduplicate after save/reload", () => {
  const p = project(),
    first = result(p);
  const applied = applyTextResult(p, first);
  assert.equal(applied.nodes[0].data.text, "新正文");
  assert.equal(applied.nodes[0].data.textVersions?.[0].text, "正文");
  assert.deepEqual(projectSchema.parse(applied), applied);
  assert.strictEqual(applyTextResult(applied, first), applied);
  const edited = structuredClone(p);
  edited.nodes[0].data.text = "用户刚写的";
  const protectedResult = applyTextResult(edited, first);
  assert.equal(protectedResult.nodes[0].data.text, "用户刚写的");
  assert.equal(protectedResult.nodes[1].data.text, "新正文");
  const variant = applyTextResult(applied, result(p, { index: 1, count: 2 }));
  assert.equal(variant.nodes.length, 2);
  assert.equal(variant.edges[0].source, "target");
  const deleted = applyTextResult({ ...p, nodes: [] }, first);
  assert.equal(deleted.nodes.length, 1);
  assert.equal(deleted.edges.length, 0);
  assert.strictEqual(applyTextResult(p, result(p, { status: "failed" })), p);
});

test("queue runs two at a time, deduplicates a submission and persists outputs and acknowledgment", async () => {
  const m = memory(),
    p = project(),
    releases = new Map<string, () => void>();
  let running = 0,
    max = 0,
    calls = 0;
  const queue = new TextGenerations(m.table, async (job, _, delta) => {
    calls++;
    running++;
    max = Math.max(max, running);
    delta(`结果 ${job.index}`);
    await new Promise<void>((resolve) => releases.set(job.id, resolve));
    running--;
  });
  const batchId = randomUUID();
  try {
    const batch = await queue.start(p.id, "target", batchId, async () =>
      prepared(4),
    );
    await until(() => releases.size === 2);
    assert.deepEqual(
      (
        await queue.start(p.id, "target", batchId, async () => {
          throw new Error("must not prepare twice");
        })
      ).map((j) => j.id),
      batch.map((j) => j.id),
    );
    releases.get(batch[0].id)!();
    releases.get(batch[1].id)!();
    await until(() => releases.size === 4);
    releases.get(batch[2].id)!();
    releases.get(batch[3].id)!();
    await until(() => queue.list(p.id).every((j) => j.status === "completed"));
    await queue.action(batch[0].id, "acknowledge");
    assert.equal(m.rows.get(batch[0].id)?.applied, true);
    assert.equal(max, 2);
    assert.equal(calls, 4);
  } finally {
    releases.forEach((r) => r());
    await queue.close();
  }
});

test("slow reference preparation does not block cancel and duplicate prepare is shared", async () => {
  const m = memory(),
    p = project(),
    preparation = gate<PreparedText>();
  const queue = new TextGenerations(m.table, async () => {
    await new Promise(() => {});
  });
  try {
    const [running] = await queue.start(p.id, "one", randomUUID(), async () =>
      prepared(),
    );
    const batch = randomUUID();
    const pending = queue.start(p.id, "two", batch, () => preparation.promise);
    const duplicate = queue.start(p.id, "two", batch, async () => {
      throw new Error("duplicate prepare");
    });
    assert.strictEqual(pending, duplicate);
    await queue.action(running.id, "cancel");
    assert.equal(queue.list(p.id)[0].status, "cancelled");
    preparation.resolve(prepared());
    await pending;
  } finally {
    preparation.resolve(prepared());
    await queue.close();
  }
});

test("cancel stops non-cooperative providers, queued jobs never execute and retry creates a fresh attempt", async () => {
  const m = memory(),
    p = project();
  let calls = 0;
  const queue = new TextGenerations(m.table, async (_, __, delta) => {
    calls++;
    delta("部分输出");
    await new Promise(() => {});
  });
  try {
    const jobs = await queue.start(p.id, "target", randomUUID(), async () =>
      prepared(4),
    );
    await until(() => calls === 2);
    await queue.action(jobs[2].id, "cancel");
    await queue.action(jobs[3].id, "cancel");
    await queue.action(jobs[0].id, "cancel");
    await queue.action(jobs[1].id, "cancel");
    assert.equal(calls, 2);
    const retry = await queue.action(jobs[0].id, "retry");
    assert.notEqual(retry.id, jobs[0].id);
    assert.equal(retry.batchId, jobs[0].batchId);
    await until(() => calls === 3);
    await assert.rejects(queue.action(jobs[0].id, "retry"), /重试/);
    await queue.action(retry.id, "cancel");
    assert.equal(queue.list(p.id)[0].text, "部分输出");
  } finally {
    await queue.close();
  }
});

test("restart interrupts unfinished jobs without calling a provider; failed acknowledgment can retry", async () => {
  const m = memory(),
    p = project();
  const old = result(p, { status: "running", text: "部分输出" });
  m.rows.set(old.id, old);
  const complete = result(p);
  m.rows.set(complete.id, complete);
  let calls = 0;
  const queue = new TextGenerations(m.table, async () => {
    calls++;
  });
  try {
    await queue.restore();
    assert.equal(
      queue.list(p.id).find((j) => j.id === old.id)?.status,
      "failed",
    );
    assert.equal(calls, 0);
    m.setFailure(true);
    await assert.rejects(queue.action(complete.id, "acknowledge"));
    assert.equal(
      queue.list(p.id).find((j) => j.id === complete.id)?.applied,
      false,
    );
    m.setFailure(false);
    await queue.action(complete.id, "acknowledge");
    assert.equal(m.rows.get(complete.id)?.applied, true);
  } finally {
    m.setFailure(false);
    await queue.close();
  }
});

test("timeout and empty output fail cleanly; credentials never escape error messages", async () => {
  const p = project(),
    m = memory();
  const queue = new TextGenerations(
    m.table,
    async () => {
      await new Promise(() => {});
    },
    20,
  );
  try {
    await queue.start(p.id, "target", randomUUID(), async () => prepared());
    await until(() => queue.list(p.id)[0]?.status === "failed");
    assert.match(queue.list(p.id)[0].error!, /超时/);
    assert.doesNotMatch(
      textError(new Error("401 sk-private-secret-123")),
      /private-secret/,
    );
  } finally {
    await queue.close();
  }
  const empty = new TextGenerations(memory().table, async () => {});
  try {
    await empty.start(p.id, "target", randomUUID(), async () => prepared());
    await until(() => empty.list(p.id)[0]?.status === "failed");
    assert.match(empty.list(p.id)[0].error!, /没有返回/);
  } finally {
    await empty.close();
  }
});

test("DSH adapter resolves the selected model and passes real image attachments without changing global model", async () => {
  const p = project();
  const image: CreativeNode = {
    ...textNode("image"),
    data: {
      kind: "image",
      text: "",
      label: "参考图片",
      media: { id: randomUUID(), name: "a.png", mime: "image/png", size: 3 },
    },
  };
  p.nodes.push(image);
  p.nodes[0].data.composer = {
    count: 2,
    referenceIds: ["image"],
    prompt: [{ type: "text", text: "写一段文案" }],
    selection: { provider: "native", model: "vision" },
  };
  const calls: unknown[] = [];
  const context = {
    inject: (_: string[], fn: (ctx: unknown) => unknown) => fn(context),
    agentDefaultModel: {
      currentSelection: () => ({ provider: "native", model: "default" }),
    },
    llm: {
      listProviders: () => [{ id: "native", name: "DSH provider" }],
      listModels: async () => [
        { id: "vision", name: "Vision", inputModalities: ["text", "image"] },
      ],
      resolveModelInfo: async (_: string, id: string) => ({
        id,
        name: id,
        inputModalities: ["text", "image"],
      }),
      stream: async function* (input: unknown) {
        calls.push(input);
        yield { type: "text-delta", text: "正文" };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
    attachments: {
      imageLimits: { maxImageBytes: 10000, maxMessageImageBytes: 20000 },
      saveImages: async (items: { data: Buffer }[]) => {
        assert.deepEqual(items[0].data, Buffer.from("png"));
        return [
          {
            attachmentId: "native-attachment",
            mediaType: "image/png",
            bytes: 3,
            width: 1,
            height: 1,
          },
        ];
      },
    },
  };
  const runtime = new TextRuntime(context as never, async () => ({
    data: Buffer.from("png").toString("base64"),
    mime: "image/png",
    size: 3,
    nextOffset: 3,
  }));
  const catalog = await runtime.catalog();
  assert.equal(catalog.default?.model, "default");
  const data = await runtime.prepare(p, "target", new AbortController().signal);
  assert.equal(data.selection.model, "vision");
  assert.equal(
    data.snapshot.references[0].image?.attachmentId,
    "native-attachment",
  );
  const job = result(p, data);
  let output = "";
  await runtime.run(job, new AbortController().signal, (text) => {
    output += text;
  });
  assert.equal(output, "正文");
  assert.match(JSON.stringify(calls), /native-attachment/);
  assert.match(JSON.stringify(calls), /"model":"vision"/);
  assert.equal(context.agentDefaultModel.currentSelection().model, "default");
});
