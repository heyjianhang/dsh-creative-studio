import type { Media, PromptTemplate } from "../shared/contracts.ts";
import { templateImageSources } from "../shared/template-images.ts";

const hosts = new Set([
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "github.com",
  "user-images.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
  "pbs.twimg.com",
  "cdn.imgedify.com",
  "cms-assets.youmind.com",
]);

function publicImageUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.has(url.hostname)
  )
    throw new Error("该模板图片地址尚不支持导入，请自行上传参考图");
  return url;
}

export class TemplateMedia {
  private abort = new AbortController();
  private pending = new Set<Promise<Media[]>>();
  constructor(
    private save: (
      projectId: string,
      name: string,
      response: Response,
      signal: AbortSignal,
    ) => Promise<Media>,
    private fetcher: typeof fetch = fetch,
  ) {}

  load(
    projectId: string,
    template: PromptTemplate,
    urls: string[],
    caller: AbortSignal,
  ) {
    if (this.abort.signal.aborted)
      return Promise.reject(this.abort.signal.reason);
    if (this.pending.size >= 2)
      return Promise.reject(new Error("模板图片正在准备，请稍后重试"));
    const work = this.import(projectId, template, urls, caller);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }

  private async import(
    projectId: string,
    template: PromptTemplate,
    urls: string[],
    caller: AbortSignal,
  ) {
    const signal = AbortSignal.any([
      caller,
      this.abort.signal,
      AbortSignal.timeout(60000),
    ]);
    const allowed = new Set([
      ...template.referenceImageUrls,
      template.coverUrl,
    ]);
    const selected = [...new Set(urls)];
    if (selected.length > 24 || selected.some((url) => !allowed.has(url)))
      throw new Error("参考图不属于该模板，请重新打开模板");
    selected.forEach(publicImageUrl);
    let total = 0;
    const files: { bytes: Uint8Array; mime: string }[] = [];
    for (const value of selected) {
      signal.throwIfAborted();
      let response: Response | undefined;
      const sources = templateImageSources(value);
      for (const [attempt, source] of sources.entries()) {
        let url = publicImageUrl(source);
        try {
          for (let redirects = 0; redirects <= 4; redirects++) {
            response = await this.fetcher(url, { signal, redirect: "manual" });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirects === 4)
              throw new Error("模板参考图重定向失败");
            url = publicImageUrl(new URL(location, url).href);
          }
          if (response?.ok && response.body) break;
          await response?.body?.cancel();
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === sources.length - 1) {
            if (error instanceof TypeError)
              throw new Error(
                "模板参考图下载失败，请检查网络或取消选择该图片",
                { cause: error },
              );
            throw error;
          }
        }
      }
      if (!response?.ok || !response.body)
        throw new Error("模板参考图下载失败，请重试或取消选择该图片");
      const mime =
        response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (
        mime &&
        mime !== "application/octet-stream" &&
        !mime.startsWith("image/")
      ) {
        await response.body.cancel();
        throw new Error("模板参考文件不是图片");
      }
      if (Number(response.headers.get("content-length")) > 12 * 1024 ** 2) {
        await response.body.cancel();
        throw new Error("单张模板参考图需小于 12 MB");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          total += value.byteLength;
          if (size > 12 * 1024 ** 2 || total > 48 * 1024 ** 2)
            throw new Error("模板参考图超过大小限制");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      files.push({ bytes: Buffer.concat(chunks), mime });
    }
    const media: Media[] = [];
    for (const [index, file] of files.entries()) {
      signal.throwIfAborted();
      media.push(
        await this.save(
          projectId,
          `${template.title.slice(0, 200)}-${index + 1}`,
          new Response(new Uint8Array(file.bytes), {
            headers: {
              "content-type": file.mime || "application/octet-stream",
            },
          }),
          signal,
        ),
      );
    }
    return media;
  }

  async close() {
    this.abort.abort();
    await Promise.allSettled(this.pending);
  }
}
