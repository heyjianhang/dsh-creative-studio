import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverySchema,
  modelCapabilitiesSchema,
  ratios,
  type ModelCapabilities,
  type ModelDiscovery,
  type DiscoveredModel,
} from "../shared/media-contracts.ts";

export const volcSources = {
  native: "https://docs.volcengine.com/docs/ark/model-list?lang=zh",
  plan: "https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh",
  image: "https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
  video:
    "https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh",
};
type Documents = Record<keyof typeof volcSources, string>;
export type VolcSnapshot = Record<"native" | "plan", ModelDiscovery>;
const unique = <T>(items: T[]) => [...new Set(items)];
const canonical = (id: string) => id.toLowerCase().replace(/[._]/g, "-");
function documentBody(html: string) {
  if (/<tr\b/i.test(html)) return html;
  const script = html.match(
    /<script\b[^>]*>\s*window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!script) return html;
  // Some responses contain the document only in the router's JSON payload.
  const state = JSON.parse(script.trim().replace(/;$/, ""));
  const page = Object.values(state.loaderData ?? {}).find(
    (v: any) => typeof v?.curDoc?.MDContent === "string",
  ) as any;
  if (!page) throw new Error("官方文档缺少正文");
  const md = String(page.curDoc.MDContent)
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(/\\([\\*{}\[\]()#+\-.!_>])/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  let inTable = false;
  const output: string[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!inTable) {
        output.push("<table>");
        inTable = true;
      }
      const cells = trimmed.slice(1, -1).split(/(?<!\\)\|/);
      if (!cells.every((c) => /^\s*:?-+:?\s*$/.test(c)))
        output.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`);
    } else {
      if (inTable) {
        output.push("</table>");
        inTable = false;
      }
      output.push(line);
    }
  }
  if (inTable) output.push("</table>");
  return output.join("\n");
}
function text(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
      const value =
        n[0]?.toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    })
    .replace(
      /&nbsp;|&amp;|&lt;|&gt;|&quot;/g,
      (v) =>
        ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
        })[v]!,
    )
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function rows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (c) => c[1]!,
    ),
  );
}
const modelIds = (value: string) =>
  unique(text(value).match(/\bdoubao-[a-z\d][a-z\d.-]*/gi) ?? []);
function durationRange(value: string) {
  const match = value.match(/(?:时长[^\d]{0,12})?(\d+)\s*[~～–-]\s*(\d+)\s*秒/);
  if (!match) return [];
  const start = Number(match[1]),
    end = Number(match[2]);
  if (start < 2 || end > 60 || start > end) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
const resolutions = (value: string) =>
  unique(value.match(/\b(?:\d+(?:\.\d+)?K|\d+p|4k)\b/g) ?? []);
function nameOf(id: string) {
  return id
    .replace(/^doubao-/, "")
    .replace(/-\d{6}$/, "")
    .replace(/^seedream-5-0-?/, "Seedream 5.0 ")
    .replace(/^seedance-2-5/, "Seedance 2.5")
    .replace(/^seedance-2[.-]0/, "Seedance 2.0")
    .replace(/^seedream-4-5/, "Seedream 4.5")
    .replace(/^seedream-4-0/, "Seedream 4.0")
    .replace(/-/g, " ")
    .trim();
}

/** Parses public, server-rendered documentation; never evaluates page scripts. */
export function parseVolcDocuments(
  docs: Documents,
  fetchedAt = new Date().toISOString(),
): VolcSnapshot {
  docs = Object.fromEntries(
    Object.entries(docs).map(([key, html]) => [key, documentBody(html)]),
  ) as Documents;
  const version = createHash("sha256")
    .update(Object.values(docs).join("\n"))
    .digest("hex")
    .slice(0, 16);
  const imageText = text(docs.image),
    videoText = text(docs.video);
  if (
    !imageText.includes("images/generations") ||
    !videoText.includes("contents/generations/tasks")
  )
    throw new Error("官方参数文档格式发生变化");
  const native = new Map<
    string,
    DiscoveredModel & { family: string; summary: string }
  >();
  for (const row of rows(docs.native)) {
    const cells = row.map(text),
      summary = cells.slice(1).join(" ");
    const kind = /文生视频/.test(summary)
      ? "video"
      : /文生图/.test(summary)
        ? "image"
        : undefined;
    if (!kind) continue;
    const family = row[0]?.match(/[?&]Id=([a-z\d.-]+)/i)?.[1];
    if (!family) continue;
    for (const id of modelIds(row[0]!))
      native.set(id, {
        model: id,
        name: nameOf(id),
        kind,
        family: canonical(family),
        summary,
        retiring: /即将下线|已下线/.test(cells[0]!),
      });
  }
  if (!native.size) throw new Error("官方目录中未识别到图片或视频模型");

  const plan = new Map<
    string,
    { model: string; resolution: string; duration: string }
  >();
  for (const table of docs.plan.matchAll(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
  )) {
    const matrix = rows(table[1]!).map((row) => row.map(text));
    const header = matrix.find(
      (row) => row[0] === "模型" && row.some((c) => modelIds(c).length),
    );
    if (!header) continue;
    for (let i = 0; i < header.length; i++) {
      const id = modelIds(header[i]!)[0];
      if (!id) continue;
      const resolution =
        matrix.find((row) => /^(输出分辨率|分辨率)$/.test(row[1] ?? ""))?.[i] ??
        "";
      const duration = matrix.find((row) => row[1] === "输出时长")?.[i] ?? "";
      plan.set(id, { model: id, resolution, duration });
    }
  }
  if (!plan.size) throw new Error("Agent Plan 官方目录格式发生变化");

  function capability(
    family: string,
    kind: "image" | "video",
    summary: string,
    planInfo?: { resolution: string; duration: string },
  ): ModelCapabilities | undefined {
    const planMatch = [...plan.values()].find(
      (p) => canonical(p.model) === family,
    );
    if (kind === "image") {
      const modern = /^doubao-seedream-5-0-(pro|flash)$/.test(family);
      const legacy = /^doubao-seedream-(5-0(?:-lite)?|4-5|4-0)$/.test(family);
      if (!modern && !legacy) return;
      const label = modern
        ? "Seedream 5.0 pro / Seedream 5.0 flash"
        : family.includes("5-0")
          ? "Seedream 5.0 lite"
          : family.endsWith("4-5")
            ? "Seedream 4.5"
            : "Seedream 4.0";
      const sizeText = imageText.slice(imageText.indexOf("size string"));
      const labelIndex = sizeText.indexOf(label);
      const allowed =
        labelIndex >= 0
          ? sizeText
              .slice(labelIndex)
              .match(/可选值\s*[:：]\s*((?:\d+(?:\.\d+)?K[、,，\s]*)+)/)?.[1]
          : undefined;
      const options = resolutions(
        planInfo?.resolution || planMatch?.resolution || allowed || "",
      );
      const max = imageText.match(
        modern
          ? /flash\s*最多支持传入\s*(\d+)\s*张参考图/
          : /4\.0\s*最多支持传入\s*(\d+)\s*张参考图/,
      );
      if (!options.length || !max) return;
      return modelCapabilitiesSchema.parse({
        kind,
        adapter: "ark-image",
        ratios,
        resolutions: options,
        durations: [],
        modes: ["reference"],
        maxImages: Math.min(12, Number(max[1])),
        audio: false,
        imageOutput: modern ? "png" : "sequential",
        sources: [
          volcSources.image,
          ...(planInfo ? [volcSources.plan] : [volcSources.native]),
        ],
        fetchedAt,
        version,
      });
    }
    // These families share the implemented Ark video task protocol. New families remain unadapted.
    if (!/^doubao-seedance-(2-5|2-0(?:-fast|-mini)?)$/.test(family)) return;
    const label =
      family === "doubao-seedance-2-5" ? "Seedance 2.5" : "Seedance 2.0";
    const options = resolutions(planInfo?.resolution || summary);
    const durations = durationRange(planInfo?.duration || summary);
    const ratioText =
      videoText.match(/ratio string[\s\S]*?可选值\s*[:：]\s*([^*]+)/)?.[1] ??
      "";
    const ratioOptions = unique(
      ratioText.match(/\b\d{1,2}:\d{1,2}\b|\badaptive\b/g) ?? [],
    );
    const max = videoText.match(
      label === "Seedance 2.5"
        ? /Seedance 2\.5\s*全模态参考生视频\s*[:：]\s*1\s*[-–]\s*(\d+)\s*张/
        : /Seedance 2\.0\s*系列全模态参考生视频\s*[:：]\s*1\s*[-–]\s*(\d+)\s*张/,
    );
    if (
      !options.length ||
      !durations.length ||
      !ratioOptions.includes("adaptive") ||
      !max
    )
      return;
    return modelCapabilitiesSchema.parse({
      kind,
      adapter: "ark-video",
      ratios: ["adaptive", ...ratioOptions.filter((v) => v !== "adaptive")],
      resolutions: options,
      durations,
      modes: ["frames", "reference"],
      maxImages: Math.min(12, Number(max[1])),
      audio: true,
      framesAdaptive: true,
      sources: [
        volcSources.video,
        planInfo ? volcSources.plan : volcSources.native,
      ],
      fetchedAt,
      version,
    });
  }
  const nativeModels = [...native.values()].map(
    ({ family, summary, ...m }) => ({
      ...m,
      capabilities: capability(family, m.kind, summary),
    }),
  );
  const planModels: DiscoveredModel[] = [];
  for (const p of plan.values()) {
    const n = [...native.values()].find((n) => n.family === canonical(p.model));
    if (!n) continue;
    planModels.push({
      model: p.model,
      name: nameOf(p.model),
      kind: n.kind,
      retiring: n.retiring,
      capabilities: capability(n.family, n.kind, n.summary, p),
    });
  }
  const result = {
    native: discoverySchema.parse({
      mode: "native",
      source: "official",
      fetchedAt,
      models: nativeModels,
    }),
    plan: discoverySchema.parse({
      mode: "plan",
      source: "official",
      fetchedAt,
      models: planModels,
    }),
  };
  if (
    !result.native.models.some((m) => m.capabilities?.kind === "image") ||
    !result.native.models.some((m) => m.capabilities?.kind === "video") ||
    !result.plan.models.some((m) => m.capabilities)
  )
    throw new Error("未能识别官方参数，请继续使用上次的目录");
  return result;
}

function snapshot(raw: unknown): VolcSnapshot {
  const data = raw as VolcSnapshot;
  return {
    native: discoverySchema.parse(data.native),
    plan: discoverySchema.parse(data.plan),
  };
}
export class VolcCatalog {
  private closed = new AbortController();
  private cache?: VolcSnapshot;
  private pending?: Promise<VolcSnapshot>;
  constructor(
    private root: string,
    private fetcher: typeof fetch = fetch,
    private bundled = new URL("./volc-catalog.json", import.meta.url),
  ) {}
  private async read() {
    if (this.cache) return this.cache;
    try {
      this.cache = snapshot(
        JSON.parse(await readFile(join(this.root, "volc-models.json"), "utf8")),
      );
    } catch {
      /* Missing or invalid cache is replaced only after a valid refresh. */
    }
    return this.cache;
  }
  private async refresh() {
    const signal = AbortSignal.any([
      this.closed.signal,
      AbortSignal.timeout(20000),
    ]);
    const results = await Promise.allSettled(
      Object.entries(volcSources).map(async ([key, url]) => {
        const response = await this.fetcher(url, {
          signal,
          redirect: "error",
          headers: { Accept: "text/html" },
        });
        if (!response.ok || !response.body)
          throw new Error("官方目录暂时无法访问");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            await response.body.cancel().catch(() => {});
            throw new Error("官方目录内容异常");
          }
          chunks.push(chunk);
        }
        return [key, Buffer.concat(chunks).toString("utf8")] as const;
      }),
    );
    const values: [string, string][] = [];
    for (const r of results) {
      if (r.status === "rejected") throw new Error("官方目录暂时无法刷新");
      values.push([...r.value]);
    }
    const next = parseVolcDocuments(Object.fromEntries(values) as Documents);
    this.closed.signal.throwIfAborted();
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "volc-models.json");
    await writeFile(path + ".tmp", JSON.stringify(next), { mode: 0o600 });
    await rename(path + ".tmp", path);
    this.cache = next;
    return next;
  }
  async get(
    mode: "native" | "plan",
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<ModelDiscovery> {
    signal.throwIfAborted();
    this.closed.signal.throwIfAborted();
    const cached = await this.read();
    if (
      !refresh &&
      cached &&
      Date.now() - Date.parse(cached[mode].fetchedAt) < 3600000
    )
      return { ...structuredClone(cached[mode]), source: "cache" };
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    // A closing dialog stops its wait, without cancelling another caller's refresh.
    let stop: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          stop = () => reject(signal.reason);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        }),
      ]);
      signal.throwIfAborted();
      return structuredClone(result[mode]);
    } catch (e) {
      signal.throwIfAborted();
      this.closed.signal.throwIfAborted();
      if (cached)
        return {
          ...structuredClone(cached[mode]),
          source: "cache",
          warning: "refreshFailed",
        };
      try {
        const base = snapshot(JSON.parse(await readFile(this.bundled, "utf8")));
        return { ...base[mode], source: "bundled", warning: "refreshFailed" };
      } catch {
        throw new Error("模型目录加载失败，请稍后重试");
      }
    } finally {
      if (stop) signal.removeEventListener("abort", stop);
    }
  }
  async close() {
    this.closed.abort();
    await this.pending?.catch(() => {});
  }
}
