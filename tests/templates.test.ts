import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateLibrary } from "../src/host/template-library.ts";
import {
  templatePurposes,
  templateSchema,
} from "../src/shared/template-contracts.ts";
import { templateNodeData } from "../src/shared/template-application.ts";
import { projectSchema } from "../src/shared/contracts.ts";

const item = templateSchema.parse({
  id: "test-source:0000000000000001",
  sourceId: "test-source",
  title: "产品展示海报",
  prompt: "A product on a desk",
  description: "",
  coverUrl: "https://example.test/cover.jpg",
  referenceImageUrls: [],
  tags: ["Products & E-commerce", "Poster"],
  author: "Example author",
  sourceUrl: "https://example.test/original",
  createdAt: "",
  imageMode: "generate",
  imageModel: "original-model",
});
const items = [
  item,
  {
    ...item,
    id: "test-source:0000000000000002",
    title: "城市建筑",
    tags: ["Architecture"],
    prompt: "City scene",
  },
];
function fixture() {
  const body = JSON.stringify(items);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-10-28T00:00:00+00:00",
    total: items.length,
    sources: [
      {
        id: "test-source",
        name: "Test source",
        count: items.length,
        path: "sources/test-source.json",
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ],
  };
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      String(url).endsWith("manifest.json") ? JSON.stringify(manifest) : body,
    );
  }) as typeof fetch;
  return { manifest, body, calls, fetcher };
}
async function temporary(run: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "creative-templates-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

test("validates source hashes, preserves attribution, filters categories and paginates", () =>
  temporary(async (path) => {
    const f = fixture(),
      service = new TemplateLibrary(path, f.fetcher);
    const first = await service.search({ limit: 1 });
    assert.equal(first.catalogTotal, 2);
    assert.equal(first.total, 2);
    assert.deepEqual(first.items, [item]);
    assert.deepEqual(templatePurposes(item), ["product", "poster"]);
    assert.equal(
      (await service.search({ offset: 1 })).items[0]?.title,
      "城市建筑",
    );
    assert.equal((await service.search({ category: "product" })).total, 1);
    assert.equal(
      (
        await service.search({
          query: "CITY",
          model: "original-model",
          source: "test-source",
        })
      ).total,
      1,
    );
    assert.equal((await service.search({ query: "missing" })).total, 0);
    assert.equal(f.calls.length, 2);
    await service.close();
  }));

test("hash mismatch and offline refresh keep the previous catalog and favorites after restart", () =>
  temporary(async (path) => {
    const f = fixture(),
      service = new TemplateLibrary(path, f.fetcher);
    await service.search({});
    await service.favorite(item.id, true);
    await service.close();
    const before = await readFile(join(path, "catalog.json"), "utf8");
    const bad = new TemplateLibrary(
      path,
      (async (url) =>
        new Response(
          String(url).endsWith("manifest.json")
            ? JSON.stringify(f.manifest)
            : "[]",
        )) as typeof fetch,
    );
    const result = await bad.search({ refresh: true, favoritesOnly: true });
    assert.equal(result.stale, true);
    assert.equal(result.total, 1);
    assert.deepEqual(result.favorites, [item.id]);
    assert.equal(await readFile(join(path, "catalog.json"), "utf8"), before);
    await bad.close();
    const offline = new TemplateLibrary(path, (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    assert.equal((await offline.search({})).stale, false);
    assert.equal((await offline.search({ refresh: true })).stale, true);
    await offline.close();
  }));

test("rejects unknown schemas, arbitrary source paths and incomplete catalogs without creating a cache", () =>
  temporary(async (path) => {
    for (const modify of [
      (m: ReturnType<typeof fixture>["manifest"]) => ({
        ...m,
        schemaVersion: 2,
      }),
      (m: ReturnType<typeof fixture>["manifest"]) => ({
        ...m,
        sources: [{ ...m.sources[0], path: "https://other.test/secret" }],
      }),
      (m: ReturnType<typeof fixture>["manifest"]) => ({ ...m, total: 99 }),
    ]) {
      const f = fixture(),
        changed = modify(f.manifest);
      const service = new TemplateLibrary(
        path,
        (async (url) =>
          new Response(
            String(url).endsWith("manifest.json")
              ? JSON.stringify(changed)
              : f.body,
          )) as typeof fetch,
      );
      await assert.rejects(service.search({}));
      await service.close();
      await assert.rejects(readFile(join(path, "catalog.json")));
    }
  }));

test("concurrent favorite writes persist together and removing one does not clear others", () =>
  temporary(async (path) => {
    const service = new TemplateLibrary(path, fixture().fetcher);
    await service.search({});
    await Promise.all(items.map((t) => service.favorite(t.id, true)));
    assert.equal((await service.search({ favoritesOnly: true })).total, 2);
    await service.favorite(item.id, false);
    await service.close();
    const restored = new TemplateLibrary(path, fixture().fetcher);
    assert.deepEqual((await restored.search({})).favorites, [items[1]!.id]);
    await restored.close();
  }));

test("one cancelled viewer does not cancel another viewer sharing a refresh; close cancels transfers", () =>
  temporary(async (path) => {
    const f = fixture();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      start = new Promise<void>((r) => {
        started = r;
      });
    const service = new TemplateLibrary(path, (async (url, options) => {
      started();
      await gate;
      options?.signal?.throwIfAborted();
      return f.fetcher(url, options);
    }) as typeof fetch);
    const abort = new AbortController();
    const first = service.search({}, abort.signal);
    await start;
    const second = service.search({});
    abort.abort();
    await assert.rejects(first);
    release();
    assert.equal((await second).total, 2);
    assert.equal(f.calls.length, 2);
    await service.close();
    const waiting = new TemplateLibrary(
      join(path, "waiting"),
      (async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
            { once: true },
          );
        })) as typeof fetch,
    );
    const pending = waiting.search({});
    const rejected = assert.rejects(pending);
    await new Promise((r) => setTimeout(r, 20));
    await waiting.close();
    await rejected;
  }));

test("template use fills only the prompt, retaining canvas preferences and never importing effect media", () => {
  const project = projectSchema.parse({
    id: randomUUID(),
    name: "Existing canvas",
    revision: 0,
    createdAt: "now",
    updatedAt: "now",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    generationPreferences: {
      image: {
        modelId: randomUUID(),
        count: 2,
        parameters: { ratio: "16:9", resolution: "2K" },
      },
    },
  });
  const before = JSON.stringify(project),
    data = templateNodeData(project, item);
  assert.deepEqual(data.mediaComposer?.prompt, [
    { type: "text", text: item.prompt },
  ]);
  assert.equal(
    data.mediaComposer?.modelId,
    project.generationPreferences?.image?.modelId,
  );
  assert.equal(data.mediaComposer?.parameters.ratio, "16:9");
  assert.equal(data.mediaComposer?.count, 2);
  assert.deepEqual(data.mediaComposer?.referenceIds, []);
  assert.equal(data.media, undefined);
  assert.equal(data.asset, undefined);
  assert.equal(data.generationResult, undefined);
  assert.equal(JSON.stringify(project), before);
  assert.equal(
    templateNodeData({ ...project, generationPreferences: undefined }, item)
      .mediaComposer?.parameters.resolution,
    "2K",
  );
});

test("expired catalogs render from disk immediately while the source refreshes in the background", () =>
  temporary(async (path) => {
    const original = new TemplateLibrary(path, fixture().fetcher);
    await original.search({});
    await original.close();
    const file = join(path, "catalog.json"),
      cache = JSON.parse(await readFile(file, "utf8"));
    cache.fetchedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(file, JSON.stringify(cache));
    const service = new TemplateLibrary(
      path,
      (async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
            { once: true },
          );
        })) as typeof fetch,
    );
    try {
      const cached = await Promise.race([
        service.search({}),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("cached catalog blocked by network")),
            1000,
          );
          timeout.unref();
        }),
      ]);
      assert.equal(cached.total, 2);
      assert.equal(cached.stale, true);
    } finally {
      await service.close();
    }
  }));

test("default browsing mixes sources before pagination instead of filling the first page with a single channel", () =>
  temporary(async (path) => {
    const groups = [
      items,
      items.map((t) => ({
        ...t,
        id: t.id.replace("test-source", "other-source"),
        sourceId: "other-source",
      })),
    ];
    const bodies = groups.map((g) => JSON.stringify(g));
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-10-28T00:00:00+00:00",
      total: 4,
      sources: groups.map((g, i) => ({
        id: g[0]!.sourceId,
        name: g[0]!.sourceId,
        count: g.length,
        path: `sources/${g[0]!.sourceId}.json`,
        sha256: createHash("sha256").update(bodies[i]!).digest("hex"),
      })),
    };
    const service = new TemplateLibrary(path, (async (url) => {
      const file = String(url);
      return new Response(
        file.endsWith("manifest.json")
          ? JSON.stringify(manifest)
          : bodies[file.endsWith("sources/test-source.json") ? 0 : 1],
      );
    }) as typeof fetch);
    const page = await service.search({ limit: 2 });
    assert.deepEqual(
      page.items.map((t) => t.sourceId),
      ["test-source", "other-source"],
    );
    const second = await service.search({ offset: 2, limit: 2 });
    assert.equal(second.items[0]!.id, items[1]!.id);
    await service.close();
  }));
