import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CanvasTemplates } from "../src/host/canvas-templates.ts";
import { Projects } from "../src/host/projects.ts";
import {
  mediaComposerSchema,
  type CanvasTemplate,
  type Project,
} from "../src/shared/contracts.ts";

test("canvas templates outlive the source project and remap node references on every use", async () => {
  const projectRows = new Map<string, Project>();
  const templateRows = new Map<string, CanvasTemplate>();
  const projects = new Projects({
    get: (id) => projectRows.get(id),
    entries: () => projectRows.entries(),
    put: async (id, p) => projectRows.set(id, p),
    delete: async (id) => projectRows.delete(id),
  });
  let missing = false;
  const templates = new CanvasTemplates(
    {
      get: (id) => templateRows.get(id),
      entries: () => templateRows.entries(),
      put: async (id, value) => templateRows.set(id, value),
      delete: async (id) => templateRows.delete(id),
    },
    projects,
    async () => {
      if (missing) throw new Error("素材不可用");
    },
  );
  const signal = new AbortController().signal;
  const source = await projects.create("咖啡");
  await assert.rejects(
    templates.save(
      { projectId: source.id, revision: source.revision, name: "空" },
      signal,
    ),
    /空画布/,
  );
  const media = {
    id: randomUUID(),
    name: "coffee.png",
    mime: "image/png",
    size: 64,
  };
  const mediaComposer = mediaComposerSchema.parse({
    parameters: { mode: "frames" },
    referenceIds: ["image"],
    prompt: [{ type: "reference", label: "咖啡", nodeId: "image" }],
    frames: { first: "image" },
  });
  const saved = await projects.save({
    ...source,
    viewport: { x: 25, y: 35, zoom: 0.8 },
    playbackPreferences: { muted: false },
    nodes: [
      {
        id: "image",
        type: "creative",
        position: { x: 10, y: 20 },
        data: { kind: "image", label: "咖啡", text: "", media },
      },
      {
        id: "video",
        type: "creative",
        position: { x: 410, y: 80 },
        data: {
          kind: "video",
          label: "镜头",
          text: "原始镜头",
          mediaComposer,
          appliedGenerationIds: [randomUUID()],
        },
      },
    ],
    edges: [{ id: "reference", source: "image", target: "video" }],
  });
  await projects.bindSession(saved.id, "source-chat");
  await assert.rejects(
    templates.save({ projectId: saved.id, revision: 0, name: "过期" }, signal),
    /画布已更新/,
  );
  const entry = await templates.save(
    { projectId: saved.id, revision: saved.revision, name: "咖啡模板" },
    signal,
  );
  assert.deepEqual(templates.list(), [entry]);
  assert.equal(entry.nodeCount, 2);
  assert.deepEqual(entry.cover?.media, media);
  const duplicate = await templates.save(
    { projectId: saved.id, revision: saved.revision, name: entry.name },
    signal,
  );
  await templates.remove(duplicate.id);
  assert.deepEqual(templates.list(), [entry]);
  assert.deepEqual(projects.get(saved.id).nodes[0]?.data.media, media);
  await projects.save({ ...projects.get(saved.id), nodes: [], edges: [] });
  await projects.remove(saved.id, saved.revision + 1);
  assert.equal(templates.coverMediaId(entry.id), media.id);

  const result = await templates.createProject(entry.id, signal);
  assert.equal(result.name, "咖啡模板");
  assert.equal(result.sessionId, undefined);
  assert.deepEqual(result.viewport, saved.viewport);
  assert.deepEqual(result.playbackPreferences, saved.playbackPreferences);
  assert.deepEqual(result.nodes[0]?.data.media, media);
  assert.equal(result.nodes[1]?.data.appliedGenerationIds, undefined);
  assert.equal(result.nodes[1]?.data.text, "原始镜头");
  const origin = { x: 200, y: 300 };
  const fragment = await templates.fragment({ id: entry.id, origin }, signal);
  assert.deepEqual(
    fragment.nodes.map((n) => n.position),
    [origin, { x: 600, y: 360 }],
  );
  for (const copy of [result, fragment]) {
    const [image, video] = copy.nodes;
    assert.notEqual(image?.id, "image");
    assert.equal(copy.edges[0]?.source, image?.id);
    assert.equal(copy.edges[0]?.target, video?.id);
    assert.deepEqual(video?.data.mediaComposer?.referenceIds, [image?.id]);
    assert.equal(video?.data.mediaComposer?.frames?.first, image?.id);
    assert.deepEqual(video?.data.mediaComposer?.prompt, [
      { type: "reference", label: "咖啡", nodeId: image?.id },
    ]);
  }
  assert.equal(
    new Set([...result.nodes, ...fragment.nodes].map((n) => n.id)).size,
    4,
  );
  missing = true;
  await assert.rejects(templates.createProject(entry.id, signal), /素材不可用/);
  assert.equal(projects.list().length, 1);
  await templates.remove(entry.id);
  await templates.remove(entry.id);
  assert.deepEqual(templates.list(), []);
  await assert.rejects(templates.createProject(entry.id, signal), /模板不存在/);
  assert.deepEqual(projects.get(result.id).nodes[0]?.data.media, media);
});
