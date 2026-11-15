import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Settings } from "../shared/contracts.ts";
import { WorkError } from "./ark.ts";
import { safePath } from "./storage.ts";
export const mediaTypes: Record<
  string,
  { mime: string; kind: "image" | "video" }
> = {
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".png": { mime: "image/png", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
  ".mkv": { mime: "video/x-matroska", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
};
export async function run(binary: string, args: string[], signal: AbortSignal) {
  const bundled =
    binary === "ffmpeg"
      ? ffmpeg.path
      : binary === "ffprobe"
        ? ffprobe.path
        : undefined;
  if (bundled && process.platform !== "win32") {
    try {
      await access(bundled, 1);
    } catch {
      await chmod(bundled, (await stat(bundled)).mode | 0o100);
    }
  }
  return new Promise<string>((resolve, reject) => {
    const executable =
      binary === "ffmpeg"
        ? ffmpeg.path
        : binary === "ffprobe"
          ? ffprobe.path
          : binary;
    const child = spawn(executable, args, {
      windowsHide: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    child.on("error", (e) =>
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new WorkError(
              `找不到 ${binary}，请在设置中指定 FFmpeg / FFprobe 路径`,
            )
          : e,
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new WorkError("媒体无法处理：文件可能损坏、格式不受支持或处理超时"),
          ),
    );
  });
}
export type Segment = {
  index: number;
  start: number | null;
  end: number | null;
  path: string;
  mime: string;
};
export async function prepare(
  root: string,
  asset: Asset,
  settings: Settings,
  signal: AbortSignal,
): Promise<{
  segments: Segment[];
  duration: number | null;
  thumbnail: string;
}> {
  const original = safePath(root, asset.relativePath),
    folder = join(root, "previews", asset.id);
  await mkdir(folder, { recursive: true });
  if (asset.kind === "image") {
    const path = `previews/${asset.id}/cover.jpg`;
    try {
      await run(
        settings.ffmpegPath,
        [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-i",
          original,
          "-frames:v",
          "1",
          "-vf",
          "scale=1024:1024:force_original_aspect_ratio=decrease",
          safePath(root, path),
        ],
        signal,
      );
      return {
        segments: [
          { index: 0, start: null, end: null, path, mime: "image/jpeg" },
        ],
        duration: null,
        thumbnail: path,
      };
    } catch (e) {
      signal.throwIfAborted();
      if (
        e instanceof WorkError &&
        e.message.startsWith("找不到 ") &&
        (await stat(original)).size <= 10 * 1024 ** 2
      )
        return {
          segments: [
            {
              index: 0,
              start: null,
              end: null,
              path: asset.relativePath,
              mime: asset.mime,
            },
          ],
          duration: null,
          thumbnail: asset.relativePath,
        };
      throw e;
    }
  }
  const probe = JSON.parse(
    await run(
      settings.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        original,
      ],
      signal,
    ),
  );
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new WorkError("无法读取视频时长");
  if (Math.ceil(duration / settings.segmentSeconds) > 2000)
    throw new WorkError("视频片段超过 2000 个，请增大片段长度后重试");
  const segments: Segment[] = [];
  for (
    let start = 0, index = 0;
    start < duration;
    start += settings.segmentSeconds, index++
  ) {
    signal.throwIfAborted();
    const end = Math.min(duration, start + settings.segmentSeconds),
      path = `previews/${asset.id}/${index}.jpg`;
    await run(
      settings.ffmpegPath,
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        String((start + end) / 2),
        "-i",
        original,
        "-frames:v",
        "1",
        "-vf",
        "scale=1024:1024:force_original_aspect_ratio=decrease",
        safePath(root, path),
      ],
      signal,
    );
    segments.push({ index, start, end, path, mime: "image/jpeg" });
  }
  return { segments, duration, thumbnail: segments[0].path };
}
export async function imageData(root: string, s: Segment) {
  const b = await readFile(safePath(root, s.path));
  if (b.length > 10 * 1024 ** 2)
    throw new WorkError("图片超过 10 MB，请配置 FFmpeg 生成较小预览");
  return `data:${s.mime};base64,${b.toString("base64")}`;
}
