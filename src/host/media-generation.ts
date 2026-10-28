import { normalizeMediaUsage } from "../shared/media-usage.ts";
import { randomUUID } from "node:crypto";
import {
  capabilities,
  mediaComposerOf,
  normalizeParameters,
  modelKind,
  type MediaJob,
  type ModelDiscovery,
} from "../shared/media-contracts.ts";
import type { CreativeNode, Project, Media } from "../shared/contracts.ts";
import { MediaSettings } from "./media-settings.ts";
import { framesOf, mediaReferenceIds } from "../shared/media-reference.ts";
import {
  buildMediaPayload,
  providerJSON,
  providerFailure,
  ProviderError,
  validateMediaTarget,
} from "./media-provider.ts";
export interface MediaJobTable {
  entries(): Iterable<readonly [string, MediaJob]>;
  put(id: string, value: MediaJob): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}
type Reader = (
  node: Pick<CreativeNode, "id" | "data">,
  offset: number,
  signal: AbortSignal,
) => Promise<{ data: string; mime: string; size: number; nextOffset: number }>;
type Save = (
  projectId: string,
  name: string,
  kind: "image" | "video",
  response: Response,
  signal: AbortSignal,
) => Promise<Media>;
const active = (j: MediaJob) =>
  ["queued", "running", "downloading"].includes(j.status);
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("已停止"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
export class MediaGenerations {
  private rows = new Map<string, MediaJob>();
  private controllers = new Map<string, AbortController>();
  private tail = Promise.resolve();
  private closed = false;
  constructor(
    private table: MediaJobTable,
    private settings: MediaSettings,
    private read: Reader,
    private save: Save,
    private fetcher: typeof fetch = fetch,
    private pollMs = 5000,
    private directory?: (
      mode: "native" | "plan",
      signal: AbortSignal,
    ) => Promise<ModelDiscovery>,
  ) {}
  private serial<T>(fn: () => Promise<T>) {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async persist(j: MediaJob) {
    j.updatedAt = new Date().toISOString();
    await this.table.put(j.id, structuredClone(j));
  }
  async restore() {
    for (const [id, value] of this.table.entries()) {
      const j = structuredClone(value);
      if (active(j)) {
        j.status =
          j.remoteId || j.resultUrl || !j.submitted ? "queued" : "uncertain";
        j.stage = "";
        if (j.status === "uncertain")
          j.error =
            "上次提交结果无法确认，请先在供应商控制台核对，避免重复计费。";
        await this.persist(j);
      }
      this.rows.set(id, j);
    }
    this.pump();
  }
  list(projectId: string) {
    return [...this.rows.values()]
      .filter((j) => j.projectId === projectId)
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.index - b.index,
      )
      .map((j) => structuredClone(j));
  }
  async start(project: Project, nodeId: string, requestId: string) {
    return this.serial(async () => {
      if (this.closed) throw new Error("插件正在停止");
      const previous = this.list(project.id).filter(
        (j) => j.batchId === requestId,
      );
      if (previous.length) return previous;
      if (
        [...this.rows.values()].some(
          (j) => j.nodeId === nodeId && j.projectId === project.id && active(j),
        )
      )
        throw new Error("这个节点已有生成任务");
      if ([...this.rows.values()].filter(active).length >= 20)
        throw new Error("队列已满，请稍后再试");
      const node = project.nodes.find((n) => n.id === nodeId);
      if (!node || node.data.kind === "text")
        throw new Error("请选择图片或视频节点");
      const config = mediaComposerOf(node),
        catalog = this.settings.catalog();
      const model = catalog.models.find(
        (m) =>
          m.id ===
          (config.modelId ??
            (node.data.kind === "image"
              ? catalog.defaultImage
              : catalog.defaultVideo)),
      );
      if (!model || modelKind(model) !== node.data.kind)
        throw new Error("请先在 DSH 设置 → 创作中配置并启用对应的模型");
      const connection = this.settings.connection(model.connectionId),
        cap = capabilities(model);
      const ids = mediaReferenceIds(config, project.nodes);
      const frames = framesOf(config, project.nodes);
      if (
        node.data.kind === "video" &&
        config.parameters.mode === "frames" &&
        frames.last &&
        !frames.first
      )
        throw new Error("请先选择首帧，再添加尾帧");
      const references = ids.map((id) => {
        const n = project.nodes.find((n) => n.id === id);
        if (!n || id === node.id) throw new Error("参考素材不存在");
        if (n.data.kind === "video")
          throw new Error("当前接入仅支持图片与文本参考");
        if (n.data.kind === "image" && !n.data.media && !n.data.asset)
          throw new Error("参考图片尚未就绪");
        return {
          id: n.id,
          role:
            node.data.kind === "video" &&
            config.parameters.mode === "frames" &&
            n.data.kind === "image"
              ? id === frames.first
                ? ("first_frame" as const)
                : ("last_frame" as const)
              : undefined,
          data: {
            kind: n.data.kind,
            label: n.data.label,
            text: n.data.text,
            media: n.data.media,
            asset: n.data.asset,
          },
        };
      });
      const countImages = references.filter(
        (r) => r.data.kind === "image",
      ).length;
      const parameters = normalizeParameters(
        model,
        config.parameters,
        countImages,
      );
      if (
        countImages >
        (parameters.mode === "frames" && node.data.kind === "video"
          ? 2
          : cap.maxImages)
      )
        throw new Error("参考图片数量超过当前生成方式的限制");
      const prompt = config.prompt
        .map((p) =>
          p.type === "text" ? p.text : `【参考${ids.indexOf(p.nodeId) + 1}】`,
        )
        .join("")
        .trim();
      if (!prompt) throw new Error("请先输入提示词");
      const referenceText = references
        .map(
          (r, i) =>
            `参考${i + 1}：${r.data.label}${r.data.kind === "text" ? "\n" + r.data.text : ""}`,
        )
        .join("\n\n");
      if (prompt.length + referenceText.length > 30000)
        throw new Error("提示词与文本参考合计不能超过 30000 字符");
      const batch: MediaJob[] = Array.from(
        { length: config.count },
        (_, index) => ({
          id: randomUUID(),
          batchId: requestId,
          projectId: project.id,
          nodeId,
          index,
          count: config.count,
          kind: node.data.kind as "image" | "video",
          status: "queued",
          stage: "排队中",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          submitted: false,
          applied: false,
          snapshot: {
            connectionId: connection.id,
            connectionName: connection.name,
            baseUrl: connection.baseUrl,
            billingMode: connection.mode,
            model,
            prompt: prompt + (referenceText ? "\n\n" + referenceText : ""),
            parameters,
            references,
            label: node.data.label,
            position: { ...node.position },
            baseMediaId: node.data.media?.id ?? node.data.asset?.id,
            composer: structuredClone({
              ...config,
              modelId: model.id,
              parameters,
            }),
          },
        }),
      );
      if ([...this.rows.values()].filter(active).length + batch.length > 20)
        throw new Error("队列已满，请稍后再试");
      try {
        for (const j of batch) await this.persist(j);
      } catch (e) {
        await Promise.allSettled(batch.map((j) => this.table.delete(j.id)));
        throw e;
      }
      for (const j of batch) this.rows.set(j.id, j);
      this.pump();
      return structuredClone(batch);
    });
  }
  async action(id: string, action: "cancel" | "retry" | "acknowledge") {
    return this.serial(async () => {
      const j = this.rows.get(id);
      if (!j) throw new Error("任务不存在");
      if (action === "acknowledge") {
        if (j.status !== "completed") throw new Error("任务尚未完成");
        j.applied = true;
        await this.persist(j);
        return structuredClone(j);
      }
      if (action === "cancel") {
        if (!active(j) && j.status !== "uncertain") return structuredClone(j);
        j.status = "cancelled";
        j.stage = "已停止";
        this.controllers.get(id)?.abort();
        await this.persist(j);
        if (j.remoteId) {
          try {
            const c = this.settings.connection(j.snapshot.connectionId);
            if (c.baseUrl === j.snapshot.baseUrl)
              await providerJSON(
                c.baseUrl,
                "/contents/generations/tasks/" + encodeURIComponent(j.remoteId),
                c.apiKey,
                AbortSignal.timeout(10000),
                undefined,
                "DELETE",
                this.fetcher,
              );
          } catch {
            j.error =
              "本地已停止，远程任务可能仍在运行，请在供应商控制台确认。";
            await this.persist(j);
          }
        }
        return structuredClone(j);
      }
      if (this.closed) throw new Error("插件正在停止");
      if (active(j)) return structuredClone(j);
      if (j.status === "uncertain")
        throw new Error(
          "请先在供应商控制台核对这次提交；需要重新生成时，请使用新的生成请求。",
        );
      if (j.status === "completed") throw new Error("任务已完成");
      if (
        [...this.rows.values()].some(
          (other) =>
            other.id !== id &&
            other.nodeId === j.nodeId &&
            other.projectId === j.projectId &&
            active(other),
        )
      )
        throw new Error("这个节点已有任务正在运行");
      if (this.controllers.has(id)) throw new Error("任务正在停止，请稍后重试");
      if (j.remoteId || j.resultUrl) {
        j.status = "queued";
        j.error = undefined;
        j.failure = undefined;
        j.stage = "继续获取结果";
        await this.persist(j);
        this.pump();
        return structuredClone(j);
      }
      const model = this.settings
        .catalog()
        .models.find((m) => m.id === j.snapshot.model.id);
      if (!model || modelKind(model) !== j.kind)
        throw new Error("原模型已移除或停用，请在节点选择模型后重新生成");
      const connection = this.settings.connection(model.connectionId);
      const next: MediaJob = {
        ...structuredClone(j),
        id: randomUUID(),
        status: "queued",
        stage: "排队中",
        submitted: false,
        error: undefined,
        failure: undefined,
        usage: undefined,
        estimate: undefined,
        snapshot: {
          ...structuredClone(j.snapshot),
          connectionId: connection.id,
          connectionName: connection.name,
          baseUrl: connection.baseUrl,
          billingMode: connection.mode,
          model,
          parameters: normalizeParameters(
            model,
            j.snapshot.parameters,
            j.snapshot.references.filter((r) => r.data.kind === "image").length,
          ),
        },
        applied: false,
        createdAt: new Date().toISOString(),
      };
      await this.persist(next);
      this.rows.set(next.id, next);
      this.pump();
      return structuredClone(next);
    });
  }
  private pump() {
    if (this.closed) return;
    for (const j of this.rows.values()) {
      if (this.controllers.size >= 2) break;
      if (j.status !== "queued" || this.controllers.has(j.id)) continue;
      const c = new AbortController();
      this.controllers.set(j.id, c);
      void this.run(j, c.signal)
        .catch(() => {})
        .finally(() => {
          this.controllers.delete(j.id);
          this.pump();
        });
    }
  }
  private async images(j: MediaJob, signal: AbortSignal) {
    const images: string[] = [];
    let total = 0;
    for (const node of j.snapshot.references.filter(
      (r) => r.data.kind === "image",
    )) {
      let offset = 0;
      const buffers: Buffer[] = [];
      let mime = "";
      while (true) {
        signal.throwIfAborted();
        const part = await this.read(node, offset, signal);
        if (part.size > 10 * 1024 ** 2 || !part.mime.startsWith("image/"))
          throw new Error("参考图需小于 10 MB");
        const b = Buffer.from(part.data, "base64");
        total += b.length;
        if (total > 40 * 1024 ** 2) throw new Error("参考图片总大小超过 40 MB");
        buffers.push(b);
        mime = part.mime;
        if (part.nextOffset >= part.size) break;
        if (part.nextOffset <= offset) throw new Error("读取参考图失败");
        offset = part.nextOffset;
      }
      images.push(
        `data:${mime};base64,${Buffer.concat(buffers).toString("base64")}`,
      );
    }
    return images;
  }
  private async run(j: MediaJob, outer: AbortSignal) {
    const signal = AbortSignal.any([
      outer,
      AbortSignal.timeout(j.kind === "video" ? 45 * 60 * 1000 : 5 * 60 * 1000),
    ]);
    try {
      j.status = "running";
      j.stage = j.remoteId ? "获取视频进度" : "准备参考素材";
      await this.persist(j);
      const c = this.settings.connection(j.snapshot.connectionId);
      if (c.baseUrl !== j.snapshot.baseUrl)
        throw new Error("连接地址已修改，请恢复原地址后继续获取任务");
      if (!j.submitted) {
        const directory =
          new URL(c.baseUrl).hostname === "ark.cn-beijing.volces.com" &&
          !j.snapshot.model.model.startsWith("ep-")
            ? await this.directory?.(c.mode, signal)
            : undefined;
        validateMediaTarget(c.mode, c.baseUrl, j.snapshot.model, directory);
        const images = await this.images(j, signal);
        signal.throwIfAborted();
        j.stage = j.kind === "image" ? "生成图片中" : "提交视频任务";
        j.submitted = true;
        await this.persist(j);
        signal.throwIfAborted();
        const response = await providerJSON(
          c.baseUrl,
          j.kind === "image"
            ? "/images/generations"
            : "/contents/generations/tasks",
          c.apiKey,
          signal,
          buildMediaPayload(j, images),
          undefined,
          this.fetcher,
        );
        if (j.kind === "image") {
          const result = response.data?.[0];
          if (result?.error)
            throw providerFailure(c.baseUrl, c.apiKey, result.error.code);
          j.resultUrl = result?.url;
          j.usage = normalizeMediaUsage(response.usage);
          if (result?.b64_json) {
            j.stage = "保存图片";
            j.status = "downloading";
            await this.persist(j);
            const b = Buffer.from(result.b64_json, "base64");
            if (b.length > 256 * 1024 ** 2)
              throw new Error("生成结果超过 256 MB");
            j.result = await this.save(
              j.projectId,
              "生成图片-" + j.id.slice(0, 8),
              "image",
              new Response(b, {
                headers: { "content-type": "application/octet-stream" },
              }),
              signal,
            );
          } else if (!j.resultUrl)
            throw new ProviderError(
              "供应商未返回图片，请在控制台核对请求结果",
              true,
            );
        } else {
          if (typeof response.id !== "string" || !response.id)
            throw new ProviderError(
              "供应商未返回任务 ID，请在控制台核对",
              true,
            );
          j.remoteId = response.id;
        }
        await this.persist(j);
      }
      if (j.remoteId && !j.resultUrl) {
        while (true) {
          signal.throwIfAborted();
          const data = await providerJSON(
            c.baseUrl,
            "/contents/generations/tasks/" + encodeURIComponent(j.remoteId),
            c.apiKey,
            signal,
            undefined,
            "GET",
            this.fetcher,
          );
          j.usage = normalizeMediaUsage(data.usage) ?? j.usage;
          if (data.status === "succeeded") {
            j.resultUrl = data.content?.video_url;
            if (!j.resultUrl)
              throw new Error("视频已完成，但结果暂时不可用，请继续获取结果");
            await this.persist(j);
            break;
          }
          if (["failed", "cancelled", "expired"].includes(data.status)) {
            j.remoteId = undefined;
            j.submitted = false;
            if (data.error?.code)
              throw providerFailure(c.baseUrl, c.apiKey, data.error.code);
            throw new Error(
              data.status === "failed"
                ? "视频任务失败"
                : data.status === "expired"
                  ? "视频任务已过期"
                  : "视频任务已取消",
            );
          }
          j.stage = data.status === "queued" ? "供应商排队中" : "生成视频中";
          await this.persist(j);
          await wait(this.pollMs, signal);
        }
      }
      signal.throwIfAborted();
      if (!j.result && j.resultUrl) {
        j.status = "downloading";
        j.stage = "保存生成结果";
        await this.persist(j);
        const url = new URL(j.resultUrl);
        if (!["https:", "http:"].includes(url.protocol))
          throw new Error("生成结果地址无效");
        const result = await this.fetcher(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        });
        j.result = await this.save(
          j.projectId,
          (j.kind === "image" ? "生成图片-" : "生成视频-") + j.id.slice(0, 8),
          j.kind,
          result,
          signal,
        );
      }
      signal.throwIfAborted();
      if (!j.result) throw new Error("未获取到生成结果");
      j.status = "completed";
      j.stage = "已完成";
      j.error = undefined;
      j.failure = undefined;
    } catch (e) {
      if (j.status === "cancelled") return;
      if (this.closed) {
        j.status =
          j.remoteId || j.resultUrl || !j.submitted ? "queued" : "uncertain";
        j.stage = "等待恢复";
      } else {
        j.status =
          e instanceof ProviderError && e.uncertain ? "uncertain" : "failed";
        j.error = signal.aborted
          ? "等待超时，可以继续获取已有任务结果"
          : e instanceof Error
            ? e.message
            : "生成失败，请重试";
        j.failure = e instanceof ProviderError ? e.failure : undefined;
        j.stage = "";
      }
    } finally {
      await this.persist(j);
    }
  }
  async close() {
    this.closed = true;
    for (const c of this.controllers.values()) c.abort();
    while (this.controllers.size)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await this.tail;
  }
}
