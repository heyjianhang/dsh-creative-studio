import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Media } from "../shared/contracts.ts";
const MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
export class Uploads {
  private pending = new Map<
    string,
    {
      projectId: string;
      name: string;
      mime: string;
      size: number;
      offset: number;
      tail: Promise<unknown>;
    }
  >();
  constructor(
    private root: string,
    private save: (
      id: string,
      m: Media & { projectId: string },
    ) => Promise<unknown>,
  ) {}
  async generated(
    projectId: string,
    name: string,
    expected: "image" | "video",
    response: Response,
    signal: AbortSignal,
  ): Promise<Media> {
    if (!response.ok || !response.body)
      throw new Error("生成结果下载失败，请重试获取结果");
    const mime =
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (
      mime &&
      mime !== "application/octet-stream" &&
      !mime.startsWith(expected + "/")
    )
      throw new Error("生成结果格式不正确");
    if (Number(response.headers.get("content-length")) > 256 * 1024 ** 2)
      throw new Error("生成结果超过 256 MB");
    await mkdir(this.root, { recursive: true });
    const id = randomUUID(),
      temporary = join(this.root, id + ".part"),
      destination = join(this.root, id);
    const file = await open(temporary, "wx"),
      reader = response.body.getReader();
    let size = 0,
      head = Buffer.alloc(0),
      closed = false;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024 ** 2) throw new Error("生成结果超过 256 MB");
        if (head.length < 32)
          head = Buffer.concat([
            head,
            Buffer.from(value).subarray(0, 32 - head.length),
          ]);
        let offset = 0;
        while (offset < value.length) {
          const written = await file.write(
            value,
            offset,
            value.length - offset,
          );
          if (!written.bytesWritten) throw new Error("写入生成结果失败");
          offset += written.bytesWritten;
        }
      }
      signal.throwIfAborted();
      const detected = head
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : head[0] === 255 && head[1] === 216
          ? "image/jpeg"
          : head.toString("ascii", 0, 4) === "RIFF" &&
              head.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : head.toString("ascii", 0, 3) === "GIF"
              ? "image/gif"
              : head.toString("ascii", 4, 8) === "ftyp"
                ? "video/mp4"
                : head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
                  ? "video/webm"
                  : undefined;
      if (!size || !detected?.startsWith(expected + "/"))
        throw new Error("生成结果不是有效的图片或视频");
      await file.close();
      closed = true;
      await rename(temporary, destination);
      const result = {
        id,
        name:
          name +
          (detected === "image/jpeg"
            ? ".jpg"
            : detected === "image/png"
              ? ".png"
              : detected === "image/webp"
                ? ".webp"
                : detected === "image/gif"
                  ? ".gif"
                  : detected === "video/webm"
                    ? ".webm"
                    : ".mp4"),
        mime: detected,
        size,
      };
      await this.save(id, { ...result, projectId });
      return result;
    } catch (e) {
      if (!closed) await file.close();
      await rm(temporary, { force: true });
      await rm(destination, { force: true });
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async begin(projectId: string, name: string, mime: string, size: number) {
    if (!MIME.has(mime))
      throw new Error("支持 PNG、JPG、WebP、GIF、MP4、WebM 和 MOV");
    if (this.pending.size >= 8) throw new Error("上传任务较多，请稍后重试");
    if (size <= 0 || size > 256 * 1024 ** 2)
      throw new Error("文件需小于 256 MB");
    await mkdir(this.root, { recursive: true });
    const id = randomUUID();
    await (await open(join(this.root, id + ".part"), "wx")).close();
    this.pending.set(id, {
      projectId,
      name,
      mime,
      size,
      offset: 0,
      tail: Promise.resolve(),
    });
    return { id };
  }
  async chunk(id: string, offset: number, data: string) {
    const p = this.pending.get(id);
    if (!p) throw new Error("上传已过期，请重试");
    const work = p.tail.then(async () => {
      if (offset !== p.offset) throw new Error("上传位置不一致");
      const bytes = Buffer.from(data, "base64");
      if (
        !bytes.length ||
        bytes.length > 512 * 1024 ||
        offset + bytes.length > p.size
      )
        throw new Error("上传数据大小不正确");
      const f = await open(join(this.root, id + ".part"), "r+");
      try {
        let written = 0;
        while (written < bytes.length) {
          const r = await f.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!r.bytesWritten) throw new Error("文件写入失败");
          written += r.bytesWritten;
        }
      } finally {
        await f.close();
      }
      p.offset += bytes.length;
      return { offset: p.offset };
    });
    p.tail = work.catch(() => {});
    return work;
  }
  async finish(id: string) {
    const p = this.pending.get(id);
    if (!p) throw new Error("上传已过期");
    await p.tail;
    if (p.offset !== p.size) throw new Error("文件未上传完整");
    const media = { id, name: p.name, mime: p.mime, size: p.size };
    await rename(join(this.root, id + ".part"), join(this.root, id));
    try {
      await this.save(id, { ...media, projectId: p.projectId });
      this.pending.delete(id);
      return media;
    } catch (e) {
      await rename(join(this.root, id), join(this.root, id + ".part"));
      throw e;
    }
  }
  async read(id: string, mime: string, offset: number) {
    const file = join(this.root, id),
      info = await stat(file);
    const f = await open(file, "r");
    try {
      const b = Buffer.alloc(
        Math.min(512 * 1024, Math.max(0, info.size - offset)),
      );
      const { bytesRead } = await f.read(b, 0, b.length, offset);
      return {
        data: b.subarray(0, bytesRead).toString("base64"),
        mime,
        size: info.size,
        nextOffset: offset + bytesRead,
      };
    } finally {
      await f.close();
    }
  }
  async cancel(id: string) {
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      await p.tail;
      await rm(join(this.root, id + ".part"), { force: true });
    }
    return { ok: true as const };
  }
  async dispose() {
    for (const [id, p] of this.pending) {
      await p.tail;
      await rm(join(this.root, id + ".part"), { force: true });
    }
    this.pending.clear();
  }
}
