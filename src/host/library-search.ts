import { z } from "zod";
import {
  librarySearchSchema,
  librarySearchResultSchema,
  type Input,
} from "../shared/contracts.ts";

export interface AssetService {
  snapshot(input: object, signal: AbortSignal): Promise<unknown>;
  search(input: object, signal: AbortSignal): Promise<unknown>;
  media(input: object, signal: AbortSignal): Promise<unknown>;
}
const snapshotSchema = z.object({
  keyConfigured: z.boolean(),
  libraries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      available: z.boolean(),
      count: z.number(),
    }),
  ),
});
export class LibrarySearch {
  constructor(private service: () => AssetService | undefined) {}
  async info(signal: AbortSignal) {
    const source = this.service();
    if (!source) return { available: false, aiReady: false, libraries: [] };
    const info = snapshotSchema.parse(await source.snapshot({}, signal));
    return {
      available: true,
      aiReady: info.keyConfigured,
      libraries: info.libraries,
    };
  }
  async search(raw: Input<"searchLibrary">, signal: AbortSignal) {
    const source = this.service();
    if (!source) throw new Error("请先启用素材库插件");
    const input = librarySearchSchema.parse(raw);
    const ai = input.ai && !!input.query.trim();
    const call = async (useAI: boolean, fallback: boolean) => {
      const result = await source.search(
        { ...input, ai: useAI, sort: "default" },
        useAI ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : signal,
      );
      signal.throwIfAborted();
      return librarySearchResultSchema.parse({
        ...(result as object),
        mode: useAI ? "ai" : "keyword",
        fallback,
      });
    };
    try {
      return await call(ai, false);
    } catch (e) {
      signal.throwIfAborted();
      if (!ai) throw e;
      return call(false, true);
    }
  }
}
