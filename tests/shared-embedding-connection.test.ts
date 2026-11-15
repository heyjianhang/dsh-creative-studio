import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService, defaults } from "../src/asset-library/host/service.ts";
import { MediaSettings } from "../src/host/media-settings.ts";
import { mediaProviders } from "../src/shared/media-providers.ts";
import type { StoredMediaSettings } from "../src/shared/media-contracts.ts";
import {
  endpoints,
  searchInput,
} from "../src/asset-library/shared/contracts.ts";

test("asset settings select a configured model by ID and retain old configuration until selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "creative-embedding-"));
  const arkId = randomUUID();
  const planId = randomUUID();
  const proxyId = randomUUID();
  const connection = {
    id: arkId,
    name: "Ark",
    enabled: true,
    mode: "native" as const,
    baseUrl: mediaProviders.native.baseUrl,
    apiKey: "test-shared",
    models: [],
  };
  let config: StoredMediaSettings = {
    revision: 0,
    connections: [
      connection,
      {
        ...connection,
        id: planId,
        mode: "plan",
        baseUrl: mediaProviders.plan.baseUrl,
      },
      { ...connection, id: proxyId, baseUrl: "https://proxy.example/api/v3" },
    ],
  };
  const models = new MediaSettings({
    get: () => config,
    put: async (_, next) => {
      config = next;
    },
  });
  const calls: { url: string; auth: string | null; model: string }[] = [];
  const dedicatedUrl = "https://legacy.example/api/v3";
  const assets = new LibraryService(
    root,
    {
      readLegacyKey: async () => "test-dedicated",
    },
    async (url, init) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        model: JSON.parse(String(init?.body)).model,
      });
      return Response.json({ data: { embedding: [1, 0] } });
    },
    () => models.embeddingConnections(),
  );
  const signal = new AbortController().signal;
  const oldSettings = {
    ...defaults,
    baseUrl: dedicatedUrl,
    model: "embedding-endpoint",
  };
  const query = searchInput.parse({ ai: true, query: "coffee" });
  try {
    const registry = join(root, "settings.json");
    await writeFile(
      registry,
      JSON.stringify({ version: 1, libraries: [], settings: oldSettings }),
    );
    await assets.init();
    const snapshot = await assets.dispatch("snapshot", {}, signal);
    assert.equal(snapshot.legacyEmbeddingModel, oldSettings.model);
    assert.deepEqual(snapshot.embeddingModels, []);
    assert.equal("baseUrl" in snapshot.settings, false);
    assert.equal("embeddingConnectionId" in snapshot.settings, false);
    assert.equal(
      endpoints.saveSettings.input.safeParse({
        ...snapshot.settings,
        apiKey: "new-local-key",
      }).success,
      false,
    );
    await assets.saveSettings({ ...snapshot.settings, concurrency: 3 });
    await assets.testConnection({}, signal);
    assert.deepEqual(calls.at(-1), {
      url: dedicatedUrl + "/embeddings/multimodal",
      auth: "Bearer test-dedicated",
      model: oldSettings.model,
    });
    const embedding = {
      id: randomUUID(),
      name: "Vision",
      model: "doubao-embedding-vision-251215",
      enabled: true,
    };
    await models.save({
      ...models.view(),
      connections: models
        .view()
        .connections.map((c) =>
          c.id === arkId
            ? { ...c, apiKey: "test-rotated", embeddingModels: [embedding] }
            : c,
        ),
    });
    await assert.rejects(
      assets.saveSettings({
        ...snapshot.settings,
        embeddingModelId: randomUUID(),
      }),
      /向量模型不可用/,
    );
    await assets.saveSettings({
      ...snapshot.settings,
      embeddingModelId: embedding.id,
    });
    assert.equal(models.catalog().models.length, 0);
    assert.deepEqual((await assets.snapshot()).embeddingModels, [
      { id: embedding.id, name: embedding.name, connectionName: "Ark" },
    ]);
    assert.equal((await assets.snapshot()).legacyEmbeddingModel, undefined);
    assert.equal(
      JSON.parse(await readFile(registry, "utf8")).settings
        .embeddingConnectionId,
      undefined,
    );
    await assets.search(query, signal);
    assert.deepEqual(calls.at(-1), {
      url: mediaProviders.native.baseUrl + "/embeddings/multimodal",
      auth: "Bearer test-rotated",
      model: embedding.model,
    });
    await models.save({
      ...models.view(),
      connections: models
        .view()
        .connections.map((c) =>
          c.id === arkId
            ? { ...c, embeddingModels: [{ ...embedding, enabled: false }] }
            : c,
        ),
    });
    assert.equal((await assets.snapshot()).keyConfigured, false);
    await assert.rejects(assets.search(query, signal), /向量模型不可用/);
    await assets.saveSettings({ ...snapshot.settings, concurrency: 2 });
    await assert.rejects(assets.testConnection({}, signal), /向量模型不可用/);
    assert.equal(calls.length, 2);
  } finally {
    await assets.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
