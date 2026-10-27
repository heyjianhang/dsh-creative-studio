import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Projects,
  validateGraph,
  type ProjectTable,
} from "../src/host/projects.ts";
import { Uploads } from "../src/host/uploads.ts";
import { Editor } from "../src/client/editor.ts";
import { nodeSchema, type Project } from "../src/shared/contracts.ts";

function memory() {
  const rows = new Map<string, Project>();
  let fail = false;
  const table: ProjectTable = {
    get: (id) => rows.get(id),
    entries: () => rows.entries(),
    put: async (id, p) => {
      if (fail) throw new Error("disk full");
      rows.set(id, structuredClone(p));
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
  return {
    table,
    fail: () => {
      fail = true;
    },
  };
}

test("resized Markdown nodes persist without changing generation inputs", async () => {
  const { table } = memory(), svc = new Projects(table), p = await svc.create("Text");
  const legacy = nodeSchema.parse({ id: "text", type: "creative", position: { x: 10, y: 20 }, data: { kind: "text", label: "正文", text: "旧正文", composer: { prompt: [{ type: "text", text: "写一个故事" }], referenceIds: [], count: 2 } } });
  assert.equal(legacy.width, undefined);
  const next = { ...legacy, width: 480, height: 360, position: { x: 10, y: -200 }, data: { ...legacy.data, text: "## 新标题\n\n**正文**" } };
  await svc.save({ ...p, nodes: [next] });
  assert.deepEqual(new Projects(table).get(p.id).nodes[0], next);
  assert.equal(nodeSchema.safeParse({ ...next, width: -1 }).success, false);
});

test("concurrent editors cannot overwrite a newer revision", async () => {
  const { table } = memory(),
    svc = new Projects(table),
    p = await svc.create("Test");
  const results = await Promise.allSettled([
    svc.save({ ...p, name: "First" }),
    svc.save({ ...p, name: "Second" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(new Projects(table).get(p.id).name, "First");
  assert.equal(svc.get(p.id).revision, 1);
});

test("failed storage writes preserve the previous project", async () => {
  const m = memory(),
    svc = new Projects(m.table),
    p = await svc.create("Before");
  m.fail();
  await assert.rejects(svc.save({ ...p, name: "After" }), /disk full/);
  assert.equal(svc.get(p.id).name, "Before");
});

test("session binding survives an edit made from an older snapshot", async () => {
  const { table } = memory(),
    svc = new Projects(table),
    p = await svc.create("Project");
  await svc.bindSession(p.id, "session-one");
  const updated = await svc.save({ ...p, name: "Renamed" });
  assert.equal(updated.sessionId, "session-one");
  await assert.rejects(svc.bindSession(p.id, "session-two"), /已有/);
});

test("graph validation rejects cycles and dangling connections", () => {
  const nodes = ["a", "b"].map((id) => ({
    id,
    type: "creative" as const,
    position: { x: 0, y: 0 },
    data: { kind: "text" as const, label: "", text: "" },
  }));
  const graph = {
    nodes,
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [{ id: "ab", source: "a", target: "b" }],
  };
  validateGraph(graph);
  assert.throws(
    () =>
      validateGraph({
        ...graph,
        edges: [...graph.edges, { id: "ba", source: "b", target: "a" }],
      }),
    /循环/,
  );
  assert.throws(
    () =>
      validateGraph({
        ...graph,
        edges: [{ id: "ax", source: "a", target: "x" }],
      }),
    /无效/,
  );
});

test("edits arriving during a save are serialized and receive the new revision", async () => {
  const { table } = memory(),
    svc = new Projects(table),
    p = await svc.create("Start");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    writes: Project[] = [];
  const editor = new Editor(
    async (value) => {
      writes.push(structuredClone(value));
      if (writes.length === 1) await gate;
      return svc.save(value);
    },
    () => {},
    () => {},
  );
  editor.load(p);
  editor.change({ ...p, name: "One" });
  const saving = editor.flush();
  editor.change({ ...editor.current!, name: "Two" });
  release();
  await saving;
  assert.deepEqual(
    writes.map((p) => [p.name, p.revision]),
    [
      ["One", 0],
      ["Two", 1],
    ],
  );
  assert.equal(editor.dirty, false);
  assert.equal(editor.current!.name, "Two");
  editor.dispose();
});

test("save failure keeps a recoverable draft; retry and undo remain usable", async () => {
  const { table } = memory(),
    svc = new Projects(table),
    p = await svc.create("Start");
  let fail = true,
    draft: Project | undefined;
  const editor = new Editor(
    async (p) => {
      if (fail) throw new Error("offline");
      return svc.save(p);
    },
    () => {},
    (p) => {
      draft = p;
    },
  );
  editor.load(p);
  editor.change({ ...p, name: "Edited" });
  await assert.rejects(editor.flush(), /offline/);
  assert.equal(editor.status, "error");
  assert.equal(draft?.name, "Edited");
  assert.equal(editor.dirty, true);
  fail = false;
  await editor.flush();
  assert.equal(draft, undefined);
  editor.undo();
  await editor.flush();
  assert.equal(svc.get(p.id).name, "Start");
  editor.redo();
  await editor.flush();
  assert.equal(svc.get(p.id).name, "Edited");
  editor.dispose();
});

test("chunk upload checks boundaries, round-trips bytes and cleans cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-upload-"));
  const saved = new Map<string, unknown>();
  const uploads = new Uploads(root, async (id, m) => {
    saved.set(id, m);
  });
  try {
    const bytes = Buffer.from("real byte payload"),
      { id } = await uploads.begin(
        "project",
        "image.png",
        "image/png",
        bytes.length,
      );
    await assert.rejects(
      uploads.chunk(id, 1, bytes.toString("base64")),
      /位置/,
    );
    await assert.rejects(uploads.finish(id), /完整/);
    await uploads.chunk(id, 0, bytes.toString("base64"));
    await uploads.finish(id);
    const result = await uploads.read(id, "image/png", 0);
    assert.deepEqual(Buffer.from(result.data, "base64"), bytes);
    assert.ok(saved.has(id));
    const pending = await uploads.begin("project", "x.png", "image/png", 10);
    await uploads.cancel(pending.id);
    assert.equal((await readdir(root)).includes(pending.id + ".part"), false);
    await assert.rejects(
      uploads.begin("project", "bad.html", "text/html", 10),
      /支持/,
    );
  } finally {
    await uploads.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
