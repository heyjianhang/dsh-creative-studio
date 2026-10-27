import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  VolcCatalog,
  parseVolcDocuments,
  volcSources,
} from "../src/host/volc-catalog.ts";
import {
  modelFromDiscovery,
  normalizeParameters,
  capabilities,
  mediaJobSchema,
  mediaSettingsSchema,
  type StoredMediaSettings,
} from "../src/shared/media-contracts.ts";
import { MediaSettings } from "../src/host/media-settings.ts";
import { buildMediaPayload } from "../src/host/media-provider.ts";

const table = (rows: string[][]) =>
  `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
function documents(
  version = "261027",
  resolutions = "480p 720p 1080p",
  duration = "4~30 秒",
) {
  return {
    native: table([
      [
        `<a href="https://ark.volcengine.com/model?Id=doubao-seedream-5-0-pro">doubao-seedream-5-0-pro-${version}</a>`,
        "文生图 多参考图生图",
      ],
      [
        `<a href="https://ark.volcengine.com/model?Id=doubao-seedance-2-5">doubao-seedance-2-5-${version}</a>`,
        "文生视频 首尾帧生视频",
        `${resolutions} 时长: ${duration}`,
      ],
      [
        `<a href="https://ark.volcengine.com/model?Id=doubao-seedance-future">doubao-seedance-future-${version}</a>`,
        "文生视频",
        "720p 时长: 4~12 秒",
      ],
      ["doubao-text-model", "文本生成 视觉理解"],
    ]),
    plan:
      table([
        ["模型", "", "doubao-seedream-5-0-pro"],
        ["模型参数", "分辨率", "1K, 1.5K, 2K"],
      ]) +
      table([
        ["模型", "", "doubao-seedance-2.5【New】"],
        ["输出视频规格", "输出分辨率", resolutions],
        ["", "输出时长", duration],
      ]),
    image:
      "<p>images/generations image string Seedream 5.0 pro / Seedream 5.0 flash 最多支持传入 10 张参考图；size string Seedream 5.0 pro / Seedream 5.0 flash 可选值：1K、1.5K、2K</p>",
    video:
      "<p>contents/generations/tasks Seedance 2.5 全模态参考生视频：1-30 张 ratio string 可选值：16:9、4:3、1:1、3:4、9:16、21:9、adaptive *注意</p>",
  };
}
const stamp = "2026-10-27T00:00:00.000Z";
const rootFixture = async (fn: (path: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "creative-catalog-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
const bundled = new URL("../resources/volc-catalog.json", import.meta.url);

test("discovers exact native and Plan IDs with different aliases, actual ranges and unadapted models", () => {
  const data = parseVolcDocuments(documents(), stamp);
  assert.equal(data.native.models.length, 3);
  assert.equal(data.plan.models.length, 2);
  assert.equal(data.native.models[0]!.model, "doubao-seedream-5-0-pro-261027");
  assert.equal(data.plan.models[1]!.model, "doubao-seedance-2.5");
  assert.deepEqual(data.native.models[0]!.capabilities!.resolutions, [
    "1K",
    "1.5K",
    "2K",
  ]);
  assert.equal(data.native.models[1]!.capabilities!.durations.at(-1), 30);
  assert.equal(data.native.models[2]!.capabilities, undefined);
  assert.throws(() => modelFromDiscovery(data.native.models[2]!), /尚未适配/);
});

test("refresh picks up new IDs and changed official parameters without fixed model records", () => {
  const old = parseVolcDocuments(documents(), stamp);
  const next = parseVolcDocuments(
    documents("270101", "480p 720p", "4~18 秒"),
    stamp,
  );
  assert.notEqual(next.native.models[1]!.model, old.native.models[1]!.model);
  assert.deepEqual(next.plan.models[1]!.capabilities!.resolutions, [
    "480p",
    "720p",
  ]);
  assert.equal(next.plan.models[1]!.capabilities!.durations.at(-1), 18);
  assert.notEqual(
    next.plan.models[1]!.capabilities!.version,
    old.plan.models[1]!.capabilities!.version,
  );
  assert.equal(old.native.models[1]!.capabilities!.durations.at(-1), 30);
  assert.throws(
    () =>
      parseVolcDocuments({ ...documents(), native: "<html>sign in</html>" }),
    /未识别/,
  );
});

test("capability snapshots drive provider payloads without presets, and normalize first-frame aspect ratio", () => {
  const catalog = parseVolcDocuments(documents(), stamp);
  const video = modelFromDiscovery(catalog.native.models[1]!);
  const params = normalizeParameters(
    video,
    { mode: "frames", ratio: "16:9", duration: 30 },
    1,
  );
  assert.equal(video.preset, undefined);
  assert.equal(params.ratio, "adaptive");
  assert.equal(params.duration, 30);
  assert.equal(capabilities(video).maxImages, 12);
  const job = mediaJobSchema.parse({
    id: crypto.randomUUID(),
    batchId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    nodeId: "n",
    index: 0,
    count: 1,
    kind: "image",
    status: "queued",
    stage: "",
    createdAt: stamp,
    updatedAt: stamp,
    snapshot: {
      connectionId: crypto.randomUUID(),
      connectionName: "Ark",
      baseUrl: "https://mock.test",
      model: modelFromDiscovery(catalog.native.models[0]!),
      prompt: "test",
      parameters: {},
      references: [],
      label: "test",
      position: { x: 0, y: 0 },
    },
  });
  const body = buildMediaPayload(job, []);
  assert.equal((body as any).output_format, "png");
  assert.ok(!("sequential_image_generation" in body));
});

test("online catalog requests are public, caches survive restart, failed refresh keeps valid data", async () =>
  rootFixture(async (root) => {
    const docs = documents();
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      const key = Object.keys(volcSources).find(
        (k) => volcSources[k as keyof typeof volcSources] === String(input),
      )! as keyof typeof docs;
      assert.ok(key);
      return new Response(docs[key]);
    };
    const first = new VolcCatalog(root, fetcher, bundled);
    const response = await first.get(
      "native",
      true,
      new AbortController().signal,
    );
    assert.equal(response.source, "official");
    assert.equal(calls, 4);
    const stored = JSON.parse(
      await readFile(join(root, "volc-models.json"), "utf8"),
    );
    assert.equal(stored.plan.models[1].model, "doubao-seedance-2.5");
    await first.close();
    const offline = new VolcCatalog(
      root,
      async () => {
        throw new Error("offline");
      },
      bundled,
    );
    const cached = await offline.get(
      "plan",
      true,
      new AbortController().signal,
    );
    assert.equal(cached.source, "cache");
    assert.equal(cached.warning, "refreshFailed");
    assert.equal(cached.models[1]!.model, "doubao-seedance-2.5");
    await offline.close();
  }));

test("first offline start labels bundled data and malformed fresh documents cannot replace cache", async () =>
  rootFixture(async (root) => {
    const service = new VolcCatalog(
      root,
      async () => new Response("<html>temporarily unavailable</html>"),
      bundled,
    );
    const data = await service.get(
      "native",
      true,
      new AbortController().signal,
    );
    assert.equal(data.source, "bundled");
    assert.equal(data.warning, "refreshFailed");
    assert.ok(data.models.length > 0);
    await assert.rejects(readFile(join(root, "volc-models.json")), /ENOENT/);
    await service.close();
  }));

test("closing one caller cancels its wait; lifecycle close aborts the shared directory fetch", async () =>
  rootFixture(async (root) => {
    let requests = 0;
    const service = new VolcCatalog(
      root,
      async (_, init) => {
        requests++;
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("stopped")),
            { once: true },
          ),
        );
      },
      bundled,
    );
    const controller = new AbortController();
    const result = service.get("native", true, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(result);
    assert.equal(requests, 4);
    await service.close();
  }));

test("saving discovered models preserves secret, supports multiple models, and rejects duplicates", async () => {
  const data = parseVolcDocuments(documents(), stamp),
    state = new Map<string, StoredMediaSettings>();
  const settings = new MediaSettings({
    get: (id) => state.get(id),
    put: async (id, value) => {
      state.set(id, structuredClone(value));
    },
  });
  const connectionId = crypto.randomUUID(),
    image = modelFromDiscovery(data.native.models[0]!),
    video = modelFromDiscovery(data.native.models[1]!);
  const saved = await settings.save({
    ...mediaSettingsSchema.parse({ revision: 0, connections: [] }),
    connections: [
      {
        id: connectionId,
        name: "Volc",
        mode: "native",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        apiKey: "test-secret",
        enabled: true,
        models: [image, video],
      },
    ],
    defaultImage: image.id,
    defaultVideo: video.id,
  });
  assert.equal(saved.connections[0]!.hasKey, true);
  assert.ok(!JSON.stringify(saved).includes("test-secret"));
  const again = await settings.save(saved);
  assert.equal(settings.catalog().models.length, 2);
  assert.equal(settings.connection(connectionId).apiKey, "test-secret");
  await assert.rejects(
    settings.save({
      ...again,
      connections: [
        {
          ...again.connections[0],
          models: [image, { ...image, id: crypto.randomUUID() }],
        },
      ],
    }),
    /相同模型/,
  );
});

test("router JSON Markdown response is parsed without executing scripts, including escaped model IDs", () => {
  const payload = (MDContent: string) =>
    `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { page: { curDoc: { MDContent } } } }).replaceAll("<", "\\u003C")};</script></html>`;
  const html = documents();
  const docs = {
    native: payload(
      "|模型|能力|规格|\n|---|---|---|\n|[doubao-seedream-5-0-pro-261027](https://ark.volcengine.com/model?Id=doubao-seedream-5-0-pro)|文生图||\n|[doubao-seedance-2-5-261027](https://ark.volcengine.com/model?Id=doubao-seedance-2-5)|文生视频|480p 720p 时长: 4~30 秒|",
    ),
    plan: payload(
      "|模型||doubao\\-seedream\\-5\\-0\\-pro|\n|---|---|---|\n|模型参数|分辨率|1K, 1.5K, 2K|\n\n|模型||doubao\\-seedance\\-2.5|\n|---|---|---|\n|输出视频规格|输出分辨率|480p 720p|\n||输出时长|4~30 秒|",
    ),
    image: payload(html.image.replaceAll("<p>", "").replaceAll("</p>", "")),
    video: payload(html.video.replaceAll("<p>", "").replaceAll("</p>", "")),
  };
  const data = parseVolcDocuments(docs, stamp);
  assert.equal(data.plan.models[0]!.model, "doubao-seedream-5-0-pro");
  assert.equal(data.plan.models[1]!.model, "doubao-seedance-2.5");
  assert.equal(data.plan.models[1]!.capabilities!.durations.at(-1), 30);
  assert.equal(data.native.models[0]!.capabilities!.maxImages, 10);
});
