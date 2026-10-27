import type { CreativeNode } from "../shared/contracts.ts";
import type { Request } from "../shared/contracts.ts";
import { MediaCache, MediaReadQueue } from "./media-cache.ts";
import { MediaDownloads } from "./media-download.ts";

type Source = CreativeNode["data"];
const sessions = new WeakMap<
  Request,
  { cache: MediaCache; queue: MediaReadQueue; downloads: MediaDownloads }
>();
export function mediaSession(request: Request) {
  let session = sessions.get(request);
  if (!session) {
    session = {
      cache: new MediaCache(),
      queue: new MediaReadQueue(),
      downloads: new MediaDownloads(),
    };
    sessions.set(request, session);
  }
  return session;
}
export function disposeMediaSession(request: Request) {
  sessions.get(request)?.downloads.dispose();
  sessions.get(request)?.cache.dispose();
  sessions.delete(request);
}
export function downloadMedia(
  request: Request,
  projectId: string,
  data: Source,
) {
  const { cache, queue, downloads } = mediaSession(request);
  const key = mediaKey(projectId, data, false);
  return downloads.prepare(
    key,
    (data.media ?? data.asset)?.name ?? data.label,
    () =>
      cache.acquire(key, (signal) =>
        queue.run(signal, () =>
          readMediaBlob(request, projectId, data, false, signal),
        ),
      ),
  );
}
export function mediaKey(projectId: string, data: Source, preview: boolean) {
  return JSON.stringify(
    data.media
      ? ["media", projectId, data.media.id, data.media.size, data.media.mime]
      : [
          "asset",
          data.asset?.libraryId,
          data.asset?.id,
          data.asset?.size,
          data.asset?.mime,
          preview ? "preview" : "original",
        ],
  );
}
export function seedMedia(
  request: Request,
  projectId: string,
  data: Source,
  file: Blob,
) {
  mediaSession(request).cache.seed(mediaKey(projectId, data, false), file);
}

export async function readMediaBlob(
  request: Request,
  projectId: string,
  data: Source,
  preview: boolean,
  signal: AbortSignal,
): Promise<Blob> {
  const read = async (offset: number) => {
    signal.throwIfAborted();
    const result = data.media
      ? await request(
          "media",
          { projectId, mediaId: data.media.id, offset },
          signal,
        )
      : data.asset
        ? await request(
            "assetMedia",
            {
              libraryId: data.asset.libraryId,
              id: data.asset.id,
              preview,
              offset,
            },
            signal,
          )
        : undefined;
    signal.throwIfAborted();
    if (!result) throw new Error("没有媒体文件");
    if (
      !Number.isSafeInteger(result.size) ||
      result.size <= 0 ||
      result.size > 256 * 1024 ** 2
    )
      throw new Error("文件大小超出预览限制");
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    if (
      !bytes.length ||
      result.nextOffset !== offset + bytes.length ||
      result.nextOffset > result.size
    )
      throw new Error("素材读取不完整");
    return { ...result, bytes };
  };
  const first = await read(0);
  const parts: Uint8Array[] = [first.bytes];
  const stride = first.nextOffset;
  let nextOffset = stride;
  // The first chunk establishes the service's chunk size; remaining chunks
  // use bounded concurrency and are assembled in file order, not arrival order.
  const worker = async () => {
    while (nextOffset < first.size) {
      const offset = nextOffset;
      nextOffset += stride;
      const chunk = await read(offset);
      if (
        chunk.size !== first.size ||
        chunk.mime !== first.mime ||
        chunk.nextOffset !== Math.min(offset + stride, first.size)
      )
        throw new Error("素材已变化，请重新打开");
      parts[offset / stride] = chunk.bytes;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(4, Math.ceil(first.size / stride) - 1) },
      worker,
    ),
  );
  signal.throwIfAborted();
  return new Blob(parts as BlobPart[], { type: first.mime });
}
