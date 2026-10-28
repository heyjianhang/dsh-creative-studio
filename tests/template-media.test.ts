import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateMedia } from "../src/host/template-media.ts";
import { Uploads } from "../src/host/uploads.ts";
import {
  graphSchema,
  nodeSchema,
  type Media,
  type PromptTemplate,
} from "../src/shared/contracts.ts";
import { templateReferenceGraph } from "../src/shared/template-application.ts";
import {
  templateDefaultReferences,
  templateImageSources,
} from "../src/shared/template-images.ts";

const cover = "https://cdn.jsdelivr.net/gh/example/templates/cover.png";
const reference =
  "https://raw.githubusercontent.com/example/templates/main/reference.png";
const template: PromptTemplate = {
  id: "test-source:0000000000000001",
  sourceId: "test-source",
  title: "Product reference",
  prompt: "Use the supplied product image",
  description: "",
  coverUrl: cover,
  referenceImageUrls: [reference],
  tags: [],
  author: "Example",
  sourceUrl: "https://github.com/example/templates",
  createdAt: "",
  imageMode: "edit",
  imageModel: "example-model",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VmcAAAAASUVORK5CYII=",
  "base64",
);
const media = (name: string): Media => ({
  id: randomUUID(),
  name,
  mime: "image/png",
  size: png.length,
});

test("templates with only an example image still bring a reference, while distinct input images take priority", () => {
  assert.deepEqual(
    templateDefaultReferences({ coverUrl: cover, referenceImageUrls: [cover] }),
    [cover],
  );
  assert.deepEqual(
    templateDefaultReferences({ coverUrl: cover, referenceImageUrls: [] }),
    [cover],
  );
  assert.deepEqual(
    templateDefaultReferences({
      coverUrl: cover,
      referenceImageUrls: [cover, reference, reference],
    }),
    [reference],
  );
  assert.deepEqual(
    templateDefaultReferences({ coverUrl: "", referenceImageUrls: [] }),
    [],
  );
});

test("selected references become validated local media, connected to the generation target and preserved after graph serialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-template-media-"));
  const stored: Media[] = [],
    calls: string[] = [];
  const projectId = randomUUID();
  const uploads = new Uploads(root, async (_id, value) => {
    stored.push(value);
  });
  const service = new TemplateMedia(
    (id, name, response, signal) =>
      uploads.generated(id, name, "image", response, signal),
    (async (url) => {
      calls.push(String(url));
      return new Response(png, { headers: { "content-type": "image/png" } });
    }) as typeof fetch,
  );
  try {
    const imported = await service.load(
      projectId,
      template,
      [reference, reference],
      new AbortController().signal,
    );
    assert.deepEqual(calls, [reference]);
    assert.equal(imported.length, 1);
    assert.deepEqual(await readFile(join(root, imported[0]!.id)), png);
    const modelId = randomUUID();
    const target = nodeSchema.parse({
      id: randomUUID(),
      type: "creative" as const,
      position: { x: 420, y: 140 },
      data: {
        kind: "image" as const,
        label: "Generate",
        text: "",
        mediaComposer: {
          modelId,
          prompt: [{ type: "text" as const, text: template.prompt }],
          referenceIds: [],
          count: 2 as const,
          parameters: { ratio: "16:9" },
        },
      },
    });
    const before = JSON.stringify(target);
    const graph = graphSchema.parse({
      ...templateReferenceGraph(target, imported),
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    assert.equal(graph.nodes.length, 2);
    const ref = graph.nodes[0]!,
      generation = graph.nodes[1]!;
    assert.equal(ref.data.media?.id, imported[0]!.id);
    assert.deepEqual(generation.data.mediaComposer?.referenceIds, [ref.id]);
    assert.deepEqual(
      graph.edges.map((e) => [e.source, e.target]),
      [[ref.id, target.id]],
    );
    assert.equal(generation.data.mediaComposer?.modelId, modelId);
    assert.equal(generation.data.media, undefined);
    assert.equal(generation.data.generationResult, undefined);
    assert.equal(JSON.stringify(target), before);
    assert.equal(stored.length, 1);
  } finally {
    await service.close();
    await uploads.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("reference imports reject URLs outside the selected template and unsafe redirect destinations before storing", async () => {
  let fetched = 0,
    saved = 0;
  const service = new TemplateMedia(
    async (_id, name) => {
      saved++;
      return media(name);
    },
    (async () => {
      fetched++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      });
    }) as typeof fetch,
  );
  const signal = new AbortController().signal;
  try {
    await assert.rejects(
      service.load(randomUUID(), template, [reference + "?other=1"], signal),
      /不属于/,
    );
    assert.equal(fetched, 0);
    await assert.rejects(
      service.load(
        randomUUID(),
        { ...template, referenceImageUrls: ["http://127.0.0.1/private"] },
        ["http://127.0.0.1/private"],
        signal,
      ),
      /尚不支持/,
    );
    assert.equal(fetched, 0);
    await assert.rejects(
      service.load(randomUUID(), template, [reference], signal),
      /尚不支持/,
    );
    assert.equal(fetched, 1);
    assert.equal(saved, 0);
  } finally {
    await service.close();
  }
});

test("invalid content and oversized responses cannot create a partially applied set of references", async () => {
  for (const invalid of [
    () =>
      new Response("<html>Not an image</html>", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response(png, {
        headers: {
          "content-type": "image/png",
          "content-length": String(13 * 1024 ** 2),
        },
      }),
    () =>
      new Response(new Uint8Array(12 * 1024 ** 2 + 1), {
        headers: { "content-type": "image/png" },
      }),
  ]) {
    let saved = 0;
    const service = new TemplateMedia(
      async (_id, name) => {
        saved++;
        return media(name);
      },
      (async (url) =>
        String(url) === reference
          ? new Response(png)
          : invalid()) as typeof fetch,
    );
    try {
      await assert.rejects(
        service.load(
          randomUUID(),
          template,
          [reference, cover],
          new AbortController().signal,
        ),
        /图片|大小|12 MB/,
      );
      assert.equal(saved, 0);
    } finally {
      await service.close();
    }
  }
});

test("unavailable jsDelivr images fall back only to the same repository file on GitHub", async () => {
  const url =
    "https://cdn.jsdelivr.net/gh/example/templates@main/images/input.png";
  const fallback =
    "https://raw.githubusercontent.com/example/templates/main/images/input.png";
  assert.deepEqual(templateImageSources(url), [url, fallback]);
  assert.deepEqual(templateImageSources(reference), [reference]);
  const calls: string[] = [];
  const service = new TemplateMedia(async (_id, name) => media(name), (async (
    input,
  ) => {
    calls.push(String(input));
    if (String(input) === url) throw new TypeError("network unavailable");
    return new Response(png, { headers: { "content-type": "image/png" } });
  }) as typeof fetch);
  try {
    const files = await service.load(
      randomUUID(),
      { ...template, referenceImageUrls: [url] },
      [url],
      new AbortController().signal,
    );
    assert.equal(files.length, 1);
    assert.deepEqual(calls, [url, fallback]);
  } finally {
    await service.close();
  }
});

test("unload and caller cancellation abort transfers; closed service refuses new work", async () => {
  let saved = 0,
    started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = new TemplateMedia(
    async (_id, name) => {
      saved++;
      return media(name);
    },
    (async (_url, options) => {
      started();
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        ),
      );
    }) as typeof fetch,
  );
  const caller = new AbortController();
  const first = service.load(
    randomUUID(),
    template,
    [reference],
    caller.signal,
  );
  const rejected = assert.rejects(first);
  await start;
  caller.abort();
  await rejected;
  const second = service.load(
    randomUUID(),
    template,
    [reference],
    new AbortController().signal,
  );
  const stopped = assert.rejects(second);
  await service.close();
  await stopped;
  await assert.rejects(
    service.load(
      randomUUID(),
      template,
      [reference],
      new AbortController().signal,
    ),
  );
  assert.equal(saved, 0);
});
