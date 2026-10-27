import {
  capabilities,
  modelKind,
  normalizeParameters,
  mediaSettingsSchema,
  mediaSettingsInputSchema,
  type StoredMediaSettings,
  type MediaSettingsInput,
} from "../shared/media-contracts.ts";
import { validateProviderRoute } from "../shared/media-providers.ts";
export interface SettingsTable {
  get(id: string): StoredMediaSettings | undefined;
  put(id: string, value: StoredMediaSettings): Promise<unknown>;
}
export class MediaSettings {
  private tail = Promise.resolve();
  constructor(private table: SettingsTable) {}
  stored(): StoredMediaSettings {
    return structuredClone(
      this.table.get("settings") ?? {
        ...mediaSettingsSchema.parse({ revision: 0, connections: [] }),
        connections: [],
      },
    );
  }
  view() {
    const config = this.stored();
    return {
      ...config,
      connections: config.connections.map(({ apiKey, ...c }) => ({
        ...c,
        hasKey: !!apiKey,
      })),
    };
  }
  catalog() {
    const config = this.stored();
    const models = config.connections
      .filter((c) => c.enabled && c.apiKey)
      .flatMap((c) =>
        c.models
          .filter((m) => m.enabled)
          .map((m) => ({
            ...m,
            connectionId: c.id,
            connectionName: c.name,
            mode: c.mode,
            kind: modelKind(m),
          })),
      );
    return {
      models,
      defaultImage: models.some((m) => m.id === config.defaultImage)
        ? config.defaultImage
        : models.find((m) => m.kind === "image")?.id,
      defaultVideo: models.some((m) => m.id === config.defaultVideo)
        ? config.defaultVideo
        : models.find((m) => m.kind === "video")?.id,
    };
  }
  connection(id: string) {
    const c = this.stored().connections.find((c) => c.id === id);
    if (!c?.enabled || !c.apiKey)
      throw new Error("请在 DSH 设置 → 创作中启用连接并填写密钥");
    return c;
  }
  save(raw: unknown) {
    const work = this.tail.then(async () => {
      const input = mediaSettingsInputSchema.parse(raw),
        old = this.stored();
      if (old.revision !== input.revision)
        throw new Error("配置已更新，请重新载入后再修改");
      const ids = new Set<string>();
      for (const c of input.connections) {
        const previous = old.connections.find((v) => v.id === c.id);
        if (previous && previous.mode !== c.mode && c.models.length)
          throw new Error("切换接入方式请先清空模型，或新建连接");
        if (ids.has(c.id)) throw new Error("连接 ID 重复");
        ids.add(c.id);
        const url = new URL(c.baseUrl);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("API 地址必须是 HTTP(S) 地址，且不含密钥或查询参数");
        c.baseUrl = c.baseUrl.replace(/\/+$/, "");
        validateProviderRoute(c.mode, c.baseUrl);
        const modelNames = new Set<string>();
        for (const m of c.models) {
          if (ids.has(m.id)) throw new Error("模型 ID 重复");
          ids.add(m.id);
          if (modelNames.has(m.model))
            throw new Error("这个连接已经添加了相同模型");
          modelNames.add(m.model);
          m.defaults = normalizeParameters(m);
          const cap = capabilities(m);
          if (!cap.resolutions.length) throw new Error("模型能力无效");
        }
      }
      const all = input.connections.flatMap((c) => c.models);
      for (const [key, kind] of [
        ["defaultImage", "image"],
        ["defaultVideo", "video"],
      ] as const) {
        if (
          input[key] &&
          !all.some(
            (m) => m.id === input[key] && modelKind(m) === kind && m.enabled,
          )
        )
          throw new Error("默认模型不存在或未启用");
      }
      const next: StoredMediaSettings = {
        ...input,
        revision: old.revision + 1,
        connections: input.connections.map(({ clearKey, apiKey, ...c }) => ({
          ...c,
          apiKey: clearKey
            ? ""
            : apiKey?.trim() ||
              old.connections.find((o) => o.id === c.id)?.apiKey ||
              "",
        })),
      };
      await this.table.put("settings", next);
      return this.view();
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }
}
