import {
  S3Client,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink, lstat, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import type { S3Config, Storage } from "../shared/contracts.ts";
import { safePath } from "./storage.ts";
import { WorkError } from "./ark.ts";

export type S3Secret = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export type S3Credentials = {
  readS3(id: string): Promise<S3Secret | undefined>;
  writeS3(id: string, value: S3Secret): Promise<void>;
  clearS3(id: string): Promise<void>;
};
export function connectionId(c: S3Config) {
  return createHash("sha256")
    .update(JSON.stringify([c.endpoint.replace(/\/$/, ""), c.region, c.bucket]))
    .digest("hex");
}
export function validateS3(c: S3Config) {
  if (!c.bucket || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,254}$/.test(c.bucket))
    throw new WorkError("请填写有效的 S3 Bucket");
  if (c.endpoint) {
    const u = new URL(c.endpoint);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["http:", "https:"].includes(u.protocol)
    )
      throw new WorkError(
        "S3 Endpoint 只能是 HTTP(S) 地址，不能包含凭据或查询参数",
      );
    if (
      u.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !c.allowInsecureHttp
    )
      throw new WorkError(
        "远程 S3 Endpoint 使用 HTTP，请开启“允许 HTTP（不加密）”或改用 HTTPS",
      );
  }
  if (
    c.prefix.split("/").some((x) => x === "." || x === "..") ||
    c.prefix.includes("\\")
  )
    throw new WorkError("S3 前缀不合法");
}
function remoteError(e: unknown): never {
  const code = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  if (code === 401 || code === 403)
    throw new WorkError("S3 访问被拒绝，请检查密钥和 Bucket 读写权限");
  if (code === 404)
    throw new WorkError("S3 中找不到素材或 Bucket，请检查存储配置");
  if (
    code === 429 ||
    (code && code >= 500) ||
    ["TimeoutError", "RequestTimeout", "NetworkingError"].includes(
      (e as Error).name,
    ) ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(
      (e as NodeJS.ErrnoException).code ?? "",
    )
  )
    throw new WorkError("S3 暂时不可用，稍后自动重试", true);
  if ((e as Error).name === "AbortError") throw e;
  throw new WorkError("S3 请求失败，请检查 Endpoint、区域与凭据");
}
export class Objects {
  constructor(
    readonly root: string,
    readonly id: string,
    readonly storage: Storage,
    readonly credentials?: S3Credentials,
  ) {}
  async client() {
    if (this.storage.mode !== "s3") throw new WorkError("此库使用本地存储");
    const c = this.storage.s3;
    validateS3(c);
    const secret = await this.credentials?.readS3(connectionId(c));
    if (!secret)
      throw new WorkError("尚未配置此 S3 连接的访问密钥，请在设置中配置");
    return new S3Client({
      region: c.region,
      ...(c.endpoint ? { endpoint: c.endpoint } : {}),
      forcePathStyle: c.forcePathStyle,
      credentials: secret,
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  key(path: string) {
    safePath(this.root, path);
    const prefix =
      this.storage.mode === "s3"
        ? this.storage.s3.prefix.replace(/^\/+|\/+$/g, "")
        : "";
    return [prefix, this.id, path].filter(Boolean).join("/");
  }
  async test(signal: AbortSignal) {
    const client = await this.client();
    try {
      await client.send(
        new HeadBucketCommand({
          Bucket: this.storage.mode === "s3" ? this.storage.s3.bucket : "",
        }),
        { abortSignal: signal },
      );
    } catch (e) {
      remoteError(e);
    } finally {
      client.destroy();
    }
  }
  async upload(
    path: string,
    signal: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ) {
    if (this.storage.mode !== "s3") return;
    const file = safePath(this.root, path);
    if (!(await lstat(file)).isFile())
      throw new WorkError("素材必须是普通文件");
    const size = (await stat(file)).size,
      client = await this.client();
    const body = createReadStream(file, { signal });
    const upload = new Upload({
      client,
      params: {
        Bucket: this.storage.s3.bucket,
        Key: this.key(path),
        Body: body,
        ContentLength: size,
      },
      queueSize: 2,
      partSize: 8 * 1024 ** 2,
      leavePartsOnError: false,
    });
    upload.on("httpUploadProgress", (e) => progress?.(e.loaded ?? 0, size));
    const abort = () => {
      void upload.abort().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await upload.done();
    } catch (e) {
      signal.throwIfAborted();
      remoteError(e);
    } finally {
      signal.removeEventListener("abort", abort);
      body.destroy();
      client.destroy();
    }
  }
  async stream(
    path: string,
    signal: AbortSignal,
    range?: string,
  ): Promise<{ stream: Readable; size: number }> {
    const file = safePath(this.root, path);
    // Local files in an S3 library are a disposable cache or an upload not yet committed.
    if (!range) {
      try {
        const info = await lstat(file);
        if (!info.isFile()) throw new WorkError("素材必须是普通文件");
        return { stream: createReadStream(file, { signal }), size: info.size };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (this.storage.mode !== "s3") throw new WorkError("素材文件不存在");
    const client = await this.client();
    try {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: this.storage.s3.bucket,
          Key: this.key(path),
          Range: range,
        }),
        { abortSignal: signal },
      );
      const stream = result.Body as Readable;
      if (!stream) throw new Error("empty body");
      stream.once("close", () => client.destroy());
      const size = result.ContentRange
        ? Number(result.ContentRange.split("/").pop())
        : (result.ContentLength ?? 0);
      return { stream, size };
    } catch (e) {
      client.destroy();
      signal.throwIfAborted();
      remoteError(e);
    }
  }
  async hydrate(path: string, signal: AbortSignal) {
    const target = safePath(this.root, path);
    try {
      if (!(await lstat(target)).isFile())
        throw new WorkError("素材必须是普通文件");
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const temp = target + "." + randomUUID() + ".part";
    await mkdir(dirname(target), { recursive: true });
    try {
      const { stream } = await this.stream(path, signal);
      await pipeline(
        stream,
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}
