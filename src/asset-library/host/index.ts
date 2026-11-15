import { access } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import {
  bindTypertRemote,
  RemoteError,
} from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { registerAssistant } from "./assistant.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { contribution, endpoints, type Method } from "../shared/contracts.ts";
import { LibraryService, message, type EmbeddingConnection } from "./service.ts";
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "asset-library/operation-failed": { retryable: boolean };
  }
}
export const name = "asset-library";
export const inject = ["typert", "credentials"];
export async function apply(ctx: Context, config: {
  dataDir?: string;
  embeddingConnections?: () => EmbeddingConnection[];
} = {}) {
  const key = credentialKey("asset-library", "volcengine");
  const library = new LibraryService(
    config.dataDir ??
      join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "asset-library"),
    {
      readLegacyKey: async () => {
        const value = await ctx.credentials.readRecord(key);
        const payload = value?.kind === "grant" ? value.payload : undefined;
        return payload &&
          typeof payload === "object" &&
          "apiKey" in payload &&
          typeof payload.apiKey === "string"
          ? payload.apiKey
          : undefined;
      },
      readS3: async (id) => {
        const value = await ctx.credentials.readRecord(
          credentialKey("asset-library", "s3-" + id),
        );
        const p = value?.kind === "grant" ? value.payload : undefined;
        if (
          !p ||
          typeof p !== "object" ||
          !("accessKeyId" in p) ||
          !("secretAccessKey" in p) ||
          typeof p.accessKeyId !== "string" ||
          typeof p.secretAccessKey !== "string"
        )
          return undefined;
        return {
          accessKeyId: p.accessKeyId,
          secretAccessKey: p.secretAccessKey,
          ...("sessionToken" in p && typeof p.sessionToken === "string"
            ? { sessionToken: p.sessionToken }
            : {}),
        };
      },
      writeS3: async (id, payload) => {
        await ctx.credentials.modifyRecord(
          credentialKey("asset-library", "s3-" + id),
          async () => ({ kind: "grant", payload }),
        );
      },
      clearS3: (id) =>
        ctx.credentials.deleteRecord(
          credentialKey("asset-library", "s3-" + id),
        ),
    },
    fetch,
    config.embeddingConnections,
  );
  await library.init();
  ctx.effect(() => () => library.dispose());
  if (!(await library.snapshot()).libraries.length) {
    const path = join(library.dataDir, "personal");
    let existing = true;
    try { await access(join(path, "library.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existing = false; }
    await library.library({ action: existing ? "open" : "create", path, name: "个人素材", storageMode: "local" });
  }
  const service: Record<string, unknown> = { ctx, activateAssistant: (scope: Context) => registerAssistant(scope, library),
    importCanvasFile: library.importCanvasFile.bind(library),
    editBatch: library.editBatch.bind(library),
    resolveAsset: async (input: { libraryId: string; id: string }, signal: AbortSignal) => {
      signal.throwIfAborted();
      const asset = library.assetMetadata(input.libraryId, input.id);
      return { kind: asset.kind, asset: { libraryId: asset.libraryId, id: asset.id, name: asset.name, mime: asset.mime, size: asset.size } };
    },
  };
  for (const method of Object.keys(endpoints) as Method[])
    service[method] = async (request: never, signal: AbortSignal) => {
      try {
        return await library.dispatch(method, request, signal);
      } catch (e) {
        signal.throwIfAborted();
        throw new RemoteError("asset-library/operation-failed", message(e), {
          retryable: false,
        });
      }
    };
  service.typertRemote = bindTypertRemote(service, "assetLibrary");
  ctx.provide("assetLibrary", service);
  ctx.effect(() =>
    ctx.typert.register({
      package: contribution.package,
      face: "host",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    }),
  );

}
