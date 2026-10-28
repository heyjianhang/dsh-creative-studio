import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaSettings } from "../src/host/media-settings.ts";
import {
  MediaGenerations,
  type MediaJobTable,
} from "../src/host/media-generation.ts";
import { Uploads } from "../src/host/uploads.ts";
import {
  buildMediaPayload,
  imageSize,
  providerJSON,
  providerFailure,
  ProviderError,
  validateMediaTarget,
} from "../src/host/media-provider.ts";
import {
  validateProviderRoute,
  mediaProviders,
} from "../src/shared/media-providers.ts";
import {
  projectSchema,
  type Project,
  type Media,
  type MediaJob,
  type StoredMediaSettings,
} from "../src/shared/contracts.ts";
import {
  mediaJobSchema,
  modelFromDiscovery,
  discoverySchema,
} from "../src/shared/media-contracts.ts";
import { applyMediaResult } from "../src/shared/media-results.ts";
async function fixture(kind: "image" | "video" = "image", count = 1) {
  const configs = new Map<string, StoredMediaSettings>();
  const settings = new MediaSettings({
    get: (id) => configs.get(id),
    put: async (id, value) => {
      configs.set(id, structuredClone(value));
    },
  });
  const connection = randomUUID(),
    model = randomUUID();
  await settings.save({
    revision: 0,
    connections: [
      {
        id: connection,
        name: "Mock provider",
        mode: "native",
        baseUrl: "https://mock.test/api/v3",
        apiKey: "private-test-secret",
        enabled: true,
        models: [
          {
            id: model,
            name: "Model",
            model: "explicit-model-id",
            preset: kind === "image" ? "seedream-5" : "seedance-2",
            enabled: true,
            currency: "CNY",
            unitPrice: 0.1,
            defaults: {
              ratio: kind === "image" ? "1:1" : "16:9",
              resolution: kind === "image" ? "2K" : "720p",
              duration: 5,
              mode: "reference",
              audio: true,
              seed: -1,
            },
          },
        ],
      },
    ],
    defaultImage: kind === "image" ? model : undefined,
    defaultVideo: kind === "video" ? model : undefined,
  });
  const project = projectSchema.parse({
    id: randomUUID(),
    name: "Generation test",
    revision: 0,
    createdAt: "2026-10-27",
    updatedAt: "2026-10-27",
    nodes: [
      {
        id: "node",
        type: "creative",
        position: { x: 0, y: 0 },
        data: {
          kind,
          label: kind,
          text: "",
          mediaComposer: {
            modelId: model,
            prompt: [{ type: "text", text: "Make a scene" }],
            count,
            parameters: {
              ratio: kind === "image" ? "1:1" : "16:9",
              resolution: kind === "image" ? "2K" : "720p",
              duration: 5,
              mode: "reference",
              audio: true,
              seed: -1,
            },
          },
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  const rows = new Map<string, MediaJob>();
  const table: MediaJobTable = {
    entries: () => rows.entries(),
    put: async (id, v) => {
      rows.set(id, mediaJobSchema.parse(structuredClone(v)));
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
  const saved: Media[] = [];
  const save = async (
    _projectId: string,
    name: string,
    _kind: string,
    _response: Response,
  ) => {
    const file = {
      id: randomUUID(),
      name,
      mime: kind === "image" ? "image/png" : "video/mp4",
      size: 10,
    };
    saved.push(file);
    return file;
  };
  return {
    settings,
    configs,
    project,
    rows,
    table,
    save,
    saved,
    connection,
    model,
  };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await sleep(5);
  }
}
const reader = async () => {
  throw new Error("No references expected");
};
const imageResponse = () =>
  Response.json({
    data: [{ url: "https://cdn.test/image.png" }],
    usage: { generated_images: 1, total_tokens: 21 },
  });

const directory = (mode: "native" | "plan") =>
  discoverySchema.parse({
    mode,
    source: "official",
    fetchedAt: "2026-10-27T00:00:00.000Z",
    models: [
      {
        model:
          mode === "plan"
            ? "doubao-seedream-5.0-flash"
            : "doubao-seedream-5-0-lite-260128",
        name: "Test image",
        kind: "image",
        capabilities: {
          kind: "image",
          adapter: "ark-image",
          ratios: ["1:1"],
          resolutions: ["2K"],
          durations: [],
          modes: ["reference"],
          maxImages: 10,
          audio: false,
          sources: [
            "https://docs.volcengine.com/docs/ark/image-generation-api",
          ],
          fetchedAt: "2026-10-27T00:00:00.000Z",
          version: "test",
        },
      },
    ],
  });

test("official routes and model directories distinguish Plan from native without guessing model aliases", async () => {
  for (const mode of ["native", "plan"] as const) {
    validateProviderRoute(mode, mediaProviders[mode].baseUrl);
    assert.throws(
      () =>
        validateProviderRoute(
          mode,
          mediaProviders[mode === "plan" ? "native" : "plan"].baseUrl,
        ),
      /不同的专属密钥/,
    );
    const d = directory(mode),
      model = modelFromDiscovery(d.models[0]!);
    validateMediaTarget(mode, mediaProviders[mode].baseUrl, model, d);
    assert.throws(
      () =>
        validateMediaTarget(
          mode,
          mediaProviders[mode].baseUrl,
          { ...model, model: "doubao-seedream-5.0-lite" },
          d,
        ),
      /重新选择/,
    );
    validateMediaTarget(mode, mediaProviders[mode].baseUrl, {
      ...model,
      model: "ep-custom-endpoint",
    });
  }
});

test("provider authentication errors identify the lane and retain only safe request diagnostics", async () => {
  const key = "private-test-secret";
  for (const mode of ["native", "plan"] as const) {
    await assert.rejects(
      () =>
        providerJSON(
          mediaProviders[mode].baseUrl,
          "/images/generations",
          key,
          new AbortController().signal,
          {},
          "POST",
          (async (_url, init) => {
            assert.equal(
              (init?.headers as Record<string, string>).Authorization,
              `Bearer ${key}`,
            );
            return Response.json(
              { error: { code: "AuthenticationError", message: key } },
              { status: 401, headers: { "x-request-id": "safe-request-123" } },
            );
          }) as typeof fetch,
        ),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.failure?.kind, "authentication");
        assert.equal(e.failure?.requestId, "safe-request-123");
        assert.match(
          e.message,
          mode === "plan" ? /Agent Plan 专属/ : /按量计费/,
        );
        assert.equal(e.message.includes(key), false);
        assert.equal(e.uncertain, false);
        return true;
      },
    );
  }
  await assert.rejects(
    () =>
      providerJSON(
        mediaProviders.native.baseUrl,
        "/images/generations",
        key,
        new AbortController().signal,
        {},
        "POST",
        (async () =>
          Response.json(
            { error: { code: "InvalidEndpointOrModel.NotFound" } },
            { status: 404 },
          )) as typeof fetch,
      ),
    /无权访问/,
  );
});

test("content moderation failures identify the rejected input or output without leaking provider messages", async () => {
  const key = "private-moderation-key";
  for (const mode of ["native", "plan"] as const) {
    for (const [code, label] of [
      ["OutputImageSensitiveContentDetected", "生成的图片"],
      ["InputImageSensitiveContentDetected", "输入的图片"],
      ["InputTextSensitiveContentDetected.PolicyViolation", "输入的文字"],
      ["OutputVideoSensitiveContentDetected", "生成的视频"],
      ["InputVideoRiskDetection", "输入的视频"],
    ]) {
      await assert.rejects(
        providerJSON(
          mediaProviders[mode].baseUrl,
          "/images/generations",
          key,
          new AbortController().signal,
          {},
          "POST",
          (async () =>
            Response.json(
              { error: { code, message: key } },
              {
                status: 400,
                headers: { "x-request-id": "moderation-request-123" },
              },
            )) as typeof fetch,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.match(error.message, new RegExp(label + "未通过"));
          assert.match(error.message, /内容审核/);
          assert.equal(error.message.includes(key), false);
          assert.equal(error.uncertain, false);
          assert.equal(error.failure?.kind, "moderation");
          assert.equal(error.failure?.requestId, "moderation-request-123");
          assert.equal(error.failure?.code, code);
          return true;
        },
      );
      const taskError = providerFailure(
        mediaProviders[mode].baseUrl,
        key,
        code,
      );
      assert.equal(taskError.failure?.kind, "moderation");
      assert.equal(taskError.uncertain, false);
    }
  }
});

test("invalid legacy IDs fail on the card before any paid request is submitted", async () => {
  const f = await fixture();
  const config = f.settings.view();
  await f.settings.save({
    ...config,
    connections: config.connections.map((c) => ({
      ...c,
      baseUrl: mediaProviders.native.baseUrl,
      models: c.models.map((m) => ({
        ...m,
        model: "doubao-seedream-5.0-lite",
      })),
    })),
  });
  let requests = 0;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async () => {
      requests++;
      return imageResponse();
    }) as typeof fetch,
    1,
    async (mode) => directory(mode),
  );
  await queue.restore();
  await queue.start(f.project, "node", randomUUID());
  await until(() => [...f.rows.values()].some((j) => j.status === "failed"));
  const job = [...f.rows.values()][0]!;
  assert.equal(requests, 0);
  assert.equal(job.submitted, false);
  assert.equal(job.failure?.kind, "configuration");
  assert.equal(job.failure?.code, "ModelProviderMismatch");
  await queue.close();
});

test("a new retry uses corrected model settings while the failed snapshot remains unchanged", async () => {
  const f = await fixture();
  const bodies: any[] = [],
    keys: string[] = [];
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        keys.push((init.headers as Record<string, string>).Authorization);
        if (bodies.length === 1)
          return Response.json(
            { error: { code: "AuthenticationError" } },
            { status: 401 },
          );
        return imageResponse();
      }
      return new Response("image");
    }) as typeof fetch,
    1,
  );
  await queue.restore();
  const [original] = await queue.start(f.project, "node", randomUUID());
  await until(() => f.rows.get(original!.id)?.status === "failed");
  const config = f.settings.view();
  await f.settings.save({
    ...config,
    connections: config.connections.map((c) => ({
      ...c,
      apiKey: "corrected-fake-key",
      models: c.models.map((m) => ({ ...m, model: "corrected-model-id" })),
    })),
  });
  const retry = await queue.action(original!.id, "retry");
  await until(() => f.rows.get(retry.id)?.status === "completed");
  assert.equal(bodies[1].model, "corrected-model-id");
  assert.equal(keys[1], "Bearer corrected-fake-key");
  assert.equal(
    f.rows.get(original!.id)?.snapshot.model.model,
    "explicit-model-id",
  );
  assert.equal(f.rows.get(retry.id)?.failure, undefined);
  await queue.close();
});

test("switching the provider with a fresh model selection preserves the saved key", async () => {
  const f = await fixture(),
    config = f.settings.view(),
    c = config.connections[0]!;
  await f.settings.save({
    ...config,
    defaultImage: undefined,
    connections: [
      { ...c, mode: "plan", baseUrl: mediaProviders.plan.baseUrl, models: [] },
    ],
  });
  assert.equal(f.settings.connection(c.id).apiKey, "private-test-secret");
  assert.equal(f.settings.view().connections[0]!.mode, "plan");
  assert.deepEqual(f.settings.catalog().models, []);
});

test("multiple connections/models retain keys privately, defaults and revisions", async () => {
  const f = await fixture();
  assert.equal(
    JSON.stringify(f.settings.view()).includes("private-test-secret"),
    false,
  );
  assert.equal(f.settings.view().connections[0]!.hasKey, true);
  const first = f.settings.view(),
    connection = first.connections[0]!;
  const added = {
    ...connection.models[0]!,
    id: randomUUID(),
    name: "Video model",
    preset: "seedance-2",
    model: "video-model",
  };
  await f.settings.save({
    ...first,
    connections: [{ ...connection, models: [...connection.models, added] }],
    defaultVideo: added.id,
  });
  assert.equal(f.settings.catalog().models.length, 2);
  assert.equal(
    f.settings.connection(connection.id).apiKey,
    "private-test-secret",
  );
  assert.equal(f.settings.catalog().models[1]!.kind, "video");
  await assert.rejects(f.settings.save(first), /配置已更新/);
  const current = f.settings.view();
  await f.settings.save({
    ...current,
    connections: current.connections.map((c) => ({ ...c, clearKey: true })),
  });
  assert.equal(f.settings.catalog().models.length, 0);
});

test("connection keys survive reopening and blank edits; failed writes preserve the saved key", async () => {
  let row: StoredMediaSettings | undefined;
  let fail = false;
  const table = {
    get: () => row && structuredClone(row),
    put: async (_id: string, next: StoredMediaSettings) => {
      if (fail) throw new Error("storage unavailable");
      row = structuredClone(next);
    },
  };
  const first = new MediaSettings(table);
  const id = randomUUID();
  await first.save({
    revision: 0,
    connections: [
      {
        id,
        name: "Credential persistence test",
        mode: "native",
        baseUrl: "https://mock.test/api/v3",
        enabled: true,
        models: [],
        apiKey: "  fake-persistence-key  ",
      },
    ],
  });
  const reopened = new MediaSettings(table);
  assert.equal(reopened.view().connections[0]!.hasKey, true);
  assert.equal(
    JSON.stringify(reopened.view()).includes("fake-persistence-key"),
    false,
  );
  const view = reopened.view();
  await reopened.save({
    ...view,
    connections: view.connections.map((c) => ({ ...c, apiKey: "" })),
  });
  assert.equal(
    new MediaSettings(table).connection(id).apiKey,
    "fake-persistence-key",
  );
  const savedRevision = reopened.view().revision;
  fail = true;
  await assert.rejects(
    reopened.save({
      ...reopened.view(),
      connections: reopened.view().connections.map((c) => ({
        ...c,
        apiKey: "replacement-that-must-not-be-saved",
      })),
    }),
    /storage unavailable/,
  );
  assert.equal(reopened.view().revision, savedRevision);
  assert.equal(reopened.connection(id).apiKey, "fake-persistence-key");
});

test("image generation batches persist, deduplicate submissions and apply each output once", async () => {
  const f = await fixture("image", 3);
  let posts = 0;
  const payloads: any[] = [];
  const fetcher = (async (url, init) => {
    if (init?.method === "POST") {
      posts++;
      payloads.push(JSON.parse(String(init.body)));
      return imageResponse();
    }
    assert.equal(init?.headers, undefined);
    return new Response("image");
  }) as typeof fetch;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    fetcher,
    1,
  );
  await queue.restore();
  const request = randomUUID();
  await queue.start(f.project, "node", request);
  await queue.start(f.project, "node", request);
  await until(
    () =>
      f.rows.size === 3 &&
      [...f.rows.values()].every((j) => j.status === "completed"),
  );
  assert.equal(posts, 3);
  assert.equal(payloads[0].model, "explicit-model-id");
  assert.equal(payloads[0].size, "2048x2048");
  assert.equal(payloads[0].sequential_image_generation, "disabled");
  let project = f.project;
  for (const job of queue.list(f.project.id)) {
    assert.equal(job.usage?.total_tokens, 21);
    assert.equal(job.estimate, undefined);
    assert.equal(job.snapshot.billingMode, "native");
    project = applyMediaResult(project, job);
    assert.equal(applyMediaResult(project, job), project);
  }
  assert.equal(project.nodes.length, 3);
  for (const result of project.nodes) {
    assert.deepEqual(
      result.data.mediaComposer?.prompt,
      f.project.nodes[0]!.data.mediaComposer!.prompt,
    );
    assert.equal(result.data.mediaComposer?.modelId, f.model);
    assert.equal(result.data.mediaComposer?.count, 3);
  }
  assert.equal(project.nodes[0]!.data.generationResult, true);
  await queue.close();
});

test("image references and @ markers are translated into provider content", async () => {
  const f = await fixture();
  const ref: Project["nodes"][number] = {
    id: "ref",
    type: "creative",
    position: { x: 0, y: 0 },
    data: {
      kind: "image",
      label: "Character",
      text: "",
      media: { id: randomUUID(), name: "ref.png", mime: "image/png", size: 4 },
    },
  };
  f.project.nodes.push(ref);
  f.project.nodes[0]!.data.mediaComposer!.referenceIds = [ref.id];
  f.project.nodes[0]!.data.mediaComposer!.prompt = [
    { type: "text", text: "Use " },
    { type: "reference", nodeId: ref.id, label: "Character" },
  ];
  let payload: any;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    async () => ({ data: "aW1n", mime: "image/png", size: 3, nextOffset: 3 }),
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        payload = JSON.parse(String(init.body));
        return imageResponse();
      }
      return new Response("image");
    }) as typeof fetch,
    1,
  );
  await queue.start(f.project, "node", randomUUID());
  await until(() => [...f.rows.values()][0]?.status === "completed");
  assert.equal(payload.image, "data:image/png;base64,aW1n");
  assert.match(payload.prompt, /【参考1】/);
  assert.match(payload.prompt, /Character/);
  await queue.close();
});

test("video task IDs are persisted before polling; restart resumes without another paid POST", async () => {
  const f = await fixture("video");
  let posts = 0,
    polls = 0;
  const first = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return Response.json({ id: "remote-task" });
      }
      polls++;
      return Response.json({ status: "running" });
    }) as typeof fetch,
    1000,
  );
  await first.start(f.project, "node", randomUUID());
  await until(() => polls > 0);
  assert.equal([...f.rows.values()][0]!.remoteId, "remote-task");
  await first.close();
  const second = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (url, init) => {
      assert.notEqual(init?.method, "POST");
      return String(url).includes("contents/generations/tasks")
        ? Response.json({
            status: "succeeded",
            content: { video_url: "https://cdn.test/video.mp4" },
            usage: { completion_tokens: 55 },
          })
        : new Response("video");
    }) as typeof fetch,
    1,
  );
  await second.restore();
  await until(() => [...f.rows.values()][0]?.status === "completed");
  assert.equal(posts, 1);
  assert.equal(f.saved.length, 1);
  assert.equal([...f.rows.values()][0]!.usage?.completion_tokens, 55);
  await second.close();
});

test("video terminal states without provider codes retain the correct failure reason", async () => {
  for (const [status, expected] of [
    ["failed", "视频任务失败"],
    ["expired", "视频任务已过期"],
    ["cancelled", "视频任务已取消"],
  ]) {
    const f = await fixture("video");
    let posts = 0;
    const jobs = new MediaGenerations(
      f.table,
      f.settings,
      reader,
      f.save,
      (async (_url, init) => {
        if (init?.method === "POST") {
          posts++;
          return Response.json({ id: "terminal-task" });
        }
        return Response.json({ status });
      }) as typeof fetch,
      1,
    );
    try {
      await jobs.start(f.project, "node", randomUUID());
      await until(() => [...f.rows.values()][0]?.status === "failed");
      assert.equal([...f.rows.values()][0]?.error, expected);
      assert.equal(posts, 1);
    } finally {
      await jobs.close();
    }
  }
});

test("ambiguous submissions are not automatically retried, including after restart", async () => {
  const f = await fixture();
  let posts = 0;
  const failing = (async () => {
    posts++;
    throw new TypeError("network lost");
  }) as typeof fetch;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    failing,
    1,
  );
  const [job] = await queue.start(f.project, "node", randomUUID());
  await until(() => f.rows.get(job!.id)?.status === "uncertain");
  await assert.rejects(queue.action(job!.id, "retry"), /控制台/);
  await queue.close();
  const resumed = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    failing,
    1,
  );
  await resumed.restore();
  await sleep(25);
  assert.equal(posts, 1);
  await resumed.close();
});

test("failed downloads retry an existing result URL without paying for generation again", async () => {
  const f = await fixture();
  let posts = 0,
    downloads = 0;
  const fetcher = (async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return imageResponse();
    }
    if (downloads++ === 0) throw new Error("offline");
    return new Response("image");
  }) as typeof fetch;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    fetcher,
    1,
  );
  const [j] = await queue.start(f.project, "node", randomUUID());
  await until(() => f.rows.get(j!.id)?.status === "failed");
  await until(() => true);
  await sleep(10);
  await queue.action(j!.id, "retry");
  await until(() => f.rows.get(j!.id)?.status === "completed");
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
  await queue.close();
});

test("queued cancellation does not create a remote request", async () => {
  const f = await fixture("video", 3);
  let posts = 0;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return Response.json({ id: "remote-" + posts });
      }
      return Response.json({ status: "running" });
    }) as typeof fetch,
    1000,
  );
  const batch = await queue.start(f.project, "node", randomUUID());
  await queue.action(batch[2]!.id, "cancel");
  await until(() => posts === 2);
  assert.equal(f.rows.get(batch[2]!.id)?.status, "cancelled");
  await queue.close();
  assert.equal(posts, 2);
});

test("batch storage failures never submit a partial paid batch", async () => {
  const f = await fixture("image", 2);
  let puts = 0,
    posts = 0;
  const broken: MediaJobTable = {
    ...f.table,
    put: async (id, v) => {
      if (++puts === 2) throw new Error("disk full");
      return f.table.put(id, v);
    },
  };
  const queue = new MediaGenerations(
    broken,
    f.settings,
    reader,
    f.save,
    (async () => {
      posts++;
      return imageResponse();
    }) as typeof fetch,
  );
  await assert.rejects(
    queue.start(f.project, "node", randomUUID()),
    /disk full/,
  );
  assert.equal(posts, 0);
  assert.equal(f.rows.size, 0);
  await queue.close();
});

test("result application preserves a user's replacement made while a job was running", async () => {
  const f = await fixture();
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (_url, init) =>
      init?.method === "POST"
        ? imageResponse()
        : new Response("image")) as typeof fetch,
    1,
  );
  await queue.start(f.project, "node", randomUUID());
  await until(() => [...f.rows.values()][0]?.status === "completed");
  const manual = {
    id: randomUUID(),
    mime: "image/png",
    name: "manual.png",
    size: 20,
  };
  f.project.nodes[0]!.data.media = manual;
  const next = applyMediaResult(f.project, [...f.rows.values()][0]!);
  assert.equal(next.nodes[0]!.data.media?.id, manual.id);
  assert.equal(next.nodes.length, 2);
  await queue.close();
});

test("generated downloads verify type, write locally and clean incomplete files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "creative-media-")),
    saved: Media[] = [];
  const uploads = new Uploads(dir, async (_id, file) => {
    saved.push(file);
  });
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7qkAAAAASUVORK5CYII=",
      "base64",
    );
    const media = await uploads.generated(
      randomUUID(),
      "Result",
      "image",
      new Response(png, { headers: { "content-type": "image/png" } }),
      new AbortController().signal,
    );
    assert.deepEqual(await readFile(join(dir, media.id)), png);
    assert.equal(media.mime, "image/png");
    await assert.rejects(
      uploads.generated(
        randomUUID(),
        "Bad",
        "image",
        new Response("<html>login required</html>", {
          headers: { "content-type": "application/octet-stream" },
        }),
        new AbortController().signal,
      ),
      /有效/,
    );
    assert.deepEqual(await readdir(dir), [media.id]);
    assert.equal(saved.length, 1);
  } finally {
    await uploads.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pro/Flash image presets do not send Lite-only batch parameters and normalize incompatible sizes", async () => {
  const f = await fixture();
  const config = f.settings.view(),
    m = config.connections[0]!.models[0]!;
  await f.settings.save({
    ...config,
    connections: [
      {
        ...config.connections[0]!,
        models: [
          {
            ...m,
            preset: "seedream-5-pro",
            defaults: { ...m.defaults, resolution: "4K" },
          },
        ],
      },
    ],
  });
  const registered = f.settings.catalog().models[0]!;
  assert.equal(registered.defaults.resolution, "1K");
  let payload: any;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    reader,
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        payload = JSON.parse(String(init.body));
        return imageResponse();
      }
      return new Response("image");
    }) as typeof fetch,
    1,
  );
  await queue.start(f.project, "node", randomUUID());
  await until(() => [...f.rows.values()][0]?.status === "completed");
  assert.equal(payload.sequential_image_generation, undefined);
  assert.equal(payload.output_format, "png");
  await queue.close();
});

test("frame slots survive swapping and send the correct first/last image roles", async () => {
  const { changeFrame, framesOf, mediaReferenceIds, isGenerationNode } =
    await import("../src/shared/media-reference.ts");
  const f = await fixture("video");
  const image = (id: string) => ({
    id,
    type: "creative" as const,
    position: { x: 0, y: 0 },
    data: {
      kind: "image" as const,
      label: id,
      text: "",
      media: { id: randomUUID(), name: id, mime: "image/png", size: 1 },
    },
  });
  const first = image("first"),
    last = image("last");
  f.project.nodes.push(first, last);
  const target = f.project.nodes[0]!;
  let composer: NonNullable<typeof target.data.mediaComposer> = {
    ...target.data.mediaComposer!,
    parameters: {
      ...target.data.mediaComposer!.parameters,
      mode: "frames" as const,
    },
  };
  composer = changeFrame(composer, f.project.nodes, "first", first.id);
  composer = changeFrame(composer, f.project.nodes, "last", last.id);
  const slots = framesOf(composer, f.project.nodes);
  composer.frames = { first: slots.last, last: slots.first };
  assert.deepEqual(mediaReferenceIds(composer, f.project.nodes), [
    "last",
    "first",
  ]);
  target.data.mediaComposer = composer;
  let posted: any;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    async (node) => ({
      data: Buffer.from(node.id === "first" ? "A" : "B").toString("base64"),
      mime: "image/png",
      size: 1,
      nextOffset: 1,
    }),
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Response.json({ id: "remote-video" });
      }
      return Response.json({ status: "failed", error: { code: "MockEnd" } });
    }) as typeof fetch,
    1,
  );
  await queue.restore();
  await queue.start(f.project, target.id, randomUUID());
  await until(() => !!posted);
  assert.equal(posted.content[1].role, "first_frame");
  assert.equal(posted.content[1].image_url.url, "data:image/png;base64,Qg==");
  assert.equal(posted.content[2].role, "last_frame");
  assert.equal(posted.content[2].image_url.url, "data:image/png;base64,QQ==");
  assert.equal(isGenerationNode(first), false);
  assert.equal(isGenerationNode(target), true);
  assert.equal(
    isGenerationNode({
      ...first,
      data: { ...first.data, generationResult: true },
    }),
    true,
  );
  await queue.close();
});

test("generating from an uploaded image keeps the original and attaches it to the new output", async () => {
  const { continuationComposer } =
    await import("../src/shared/media-reference.ts");
  const f = await fixture();
  const original = {
    ...structuredClone(f.project.nodes[0]!),
    id: "upload",
    data: {
      kind: "image" as const,
      label: "source.png",
      text: "",
      media: {
        id: randomUUID(),
        name: "source.png",
        mime: "image/png",
        size: 4,
      },
    },
  };
  const untouched = structuredClone(original);
  f.project.nodes[0]!.data.mediaComposer = continuationComposer(
    original,
    f.project.nodes[0]!.data.mediaComposer!,
  );
  f.project.nodes.push(original);
  let payload: any;
  const queue = new MediaGenerations(
    f.table,
    f.settings,
    async () => ({ data: "aW1n", mime: "image/png", size: 3, nextOffset: 3 }),
    f.save,
    (async (_url, init) => {
      if (init?.method === "POST") {
        payload = JSON.parse(String(init.body));
        return imageResponse();
      }
      return new Response("image");
    }) as typeof fetch,
    1,
  );
  await queue.start(f.project, "node", randomUUID());
  await until(() => [...f.rows.values()][0]?.status === "completed");
  const next = applyMediaResult(f.project, [...f.rows.values()][0]!);
  assert.deepEqual(
    next.nodes.find((n) => n.id === original.id),
    untouched,
  );
  assert.equal(
    next.nodes.find((n) => n.id === "node")!.data.generationResult,
    true,
  );
  assert.equal(payload.image, "data:image/png;base64,aW1n");
  await queue.close();
});
