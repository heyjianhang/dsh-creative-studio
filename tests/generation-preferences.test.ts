import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectSchema,
  type CreativeNode,
  type Project,
} from "../src/shared/contracts.ts";
import { mediaComposerOf } from "../src/shared/media-contracts.ts";
import {
  generationDefaults,
  rememberGeneration,
} from "../src/shared/generation-preferences.ts";
import {
  connectedReferences,
  framePickProblem,
  referencePickProblem,
} from "../src/shared/text-generation.ts";
import { Projects } from "../src/host/projects.ts";

const node = (
  id: string,
  kind: CreativeNode["data"]["kind"],
  text = "",
): CreativeNode => ({
  id,
  type: "creative",
  position: { x: 0, y: 0 },
  data: { kind, label: id, text },
});

test("canvas preferences survive host save/reload and inherit only settings, never prompt or references", async () => {
  const table = new Map<string, Project>();
  const store = () =>
    new Projects({
      get: (id) => table.get(id),
      entries: () => table.entries(),
      put: async (id, p) => {
        table.set(id, structuredClone(p));
      },
      delete: async (id) => {
        table.delete(id);
      },
    });
  const projects = store(),
    p = await projects.create("canvas A");
  const image = node("image", "image");
  image.data.mediaComposer = {
    ...mediaComposerOf(image),
    modelId: "71d53d38-9280-4fbf-ad17-721d3cc85808",
    parameters: {
      ...mediaComposerOf(image).parameters,
      ratio: "16:9",
      resolution: "4K",
      seed: 42,
    },
    count: 3,
    referenceIds: ["private-ref"],
    prompt: [{ type: "text", text: "private prompt" }],
    frames: { first: "private-ref" },
  };
  const saved = await projects.save({
    ...p,
    generationPreferences: rememberGeneration(undefined, undefined, image.data),
    playbackPreferences: { muted: false },
  });
  const reopened = store().get(saved.id);
  assert.equal(reopened.playbackPreferences?.muted, false);
  assert.equal(
    (await projects.create("canvas C")).playbackPreferences,
    undefined,
  );
  const fresh = generationDefaults(reopened, "image").mediaComposer!;
  assert.equal(fresh.modelId, image.data.mediaComposer.modelId);
  assert.equal(fresh.parameters.ratio, "16:9");
  assert.equal(fresh.parameters.resolution, "4K");
  assert.equal(fresh.parameters.seed, -1);
  assert.equal(fresh.count, 3);
  assert.deepEqual(fresh.prompt, []);
  assert.deepEqual(fresh.referenceIds, []);
  assert.equal(fresh.frames, undefined);
  assert.deepEqual(generationDefaults(reopened, "video"), {});
  assert.deepEqual(
    generationDefaults(await projects.create("canvas B"), "image"),
    {},
  );
  assert.equal(projectSchema.parse(p).generationPreferences, undefined);
});

test("prompt edits on an older node do not overwrite the last model; uploads do not change preferences", () => {
  const first = node("first", "text");
  first.data.composer = {
    count: 2,
    referenceIds: [],
    prompt: [],
    selection: { provider: "one", model: "first-model" },
  };
  const second = node("second", "text");
  second.data.composer = {
    ...first.data.composer,
    selection: { provider: "two", model: "second-model" },
  };
  const preferences = rememberGeneration(undefined, undefined, second.data);
  const edited = {
    ...first.data,
    composer: {
      ...first.data.composer,
      prompt: [{ type: "text" as const, text: "edit" }],
    },
  };
  assert.equal(
    rememberGeneration(preferences, first.data, edited),
    preferences,
  );
  const image = node("upload", "image");
  image.data.media = {
    id: "2e154569-33ac-4876-bafa-57cde8be98bc",
    name: "upload.png",
    mime: "image/png",
    size: 1,
  };
  image.data.mediaComposer = mediaComposerOf(image);
  assert.equal(
    rememberGeneration(preferences, undefined, image.data),
    preferences,
  );
  const inherited = generationDefaults(
    { generationPreferences: preferences },
    "text",
  ).composer!;
  assert.equal(inherited.selection?.model, "second-model");
  assert.equal(inherited.count, 2);
});

test("mentions list compatible incoming connections only; unattached, outgoing, empty and video nodes are excluded", () => {
  const target = node("target", "text"),
    connected = node("connected", "text", "script"),
    unconnected = node("unconnected", "text", "unrelated"),
    outgoing = node("outgoing", "text", "result"),
    video = node("video", "video"),
    image = node("image", "image"),
    empty = node("empty", "text");
  image.data.media = {
    id: "2e154569-33ac-4876-bafa-57cde8be98bc",
    name: "image.png",
    mime: "image/png",
    size: 1,
  };
  const nodes = [target, connected, unconnected, outgoing, video, image, empty];
  const edges = [connected, video, image, empty].map((n) => ({
    id: n.id,
    source: n.id,
    target: target.id,
  }));
  edges.push({ id: "out", source: target.id, target: outgoing.id });
  assert.deepEqual(
    connectedReferences({ nodes, edges }, target.id, "yes").map((n) => n.id),
    ["connected", "image"],
  );
  assert.deepEqual(
    connectedReferences({ nodes, edges }, target.id, "no").map((n) => n.id),
    ["connected"],
  );
  assert.deepEqual(connectedReferences({ nodes, edges: [] }, target.id), []);
});

test("connected images can be assigned to a frame without bypassing cycle or media validation", () => {
  const target = node("target", "video"),
    image = node("image", "image"),
    empty = node("empty", "image"),
    text = node("text", "text", "script");
  image.data.media = {
    id: "2e154569-33ac-4876-bafa-57cde8be98bc",
    name: "image.png",
    mime: "image/png",
    size: 1,
  };
  target.data.mediaComposer = {
    ...mediaComposerOf(target),
    referenceIds: [image.id],
    frames: {},
  };
  const graph = {
    nodes: [target, image, empty, text],
    edges: [{ id: "incoming", source: image.id, target: target.id }],
  };
  assert.equal(
    referencePickProblem(graph, target.id, image.id),
    "referenceAdded",
  );
  assert.equal(framePickProblem(graph, target.id, image.id), undefined);
  assert.equal(framePickProblem(graph, target.id, text.id), "frameNeedsImage");
  assert.equal(framePickProblem(graph, target.id, empty.id), "referenceEmpty");
  assert.equal(framePickProblem(graph, target.id, target.id), "referenceSelf");
  assert.equal(
    framePickProblem(
      {
        ...graph,
        edges: [{ id: "outgoing", source: target.id, target: image.id }],
      },
      target.id,
      image.id,
    ),
    "cycle",
  );
});
