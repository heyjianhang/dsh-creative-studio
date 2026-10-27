import { useEffect, useState } from "react";
import type { CreativeNode } from "../shared/contracts.ts";
import type { Request } from "./props.ts";
import type { Key } from "./locales.ts";
import {
  mediaKey,
  mediaSession,
  readMediaBlob,
  seedMedia,
} from "./media-source.ts";
import { CanvasVideo } from "./canvas-video.tsx";
import css from "./studio.module.css";
export type MediaInfo = {
  src: string;
  width: number;
  height: number;
  duration?: number;
};
export function MediaView({
  request,
  projectId,
  data,
  preview = false,
  autoPlay = false,
  start,
  onReady,
  canvas,
  muted,
  onMutedChange,
  controls,
  loop = false,
}: {
  request: Request;
  projectId: string;
  data: CreativeNode["data"];
  preview?: boolean;
  autoPlay?: boolean;
  start?: number;
  onReady?(info: MediaInfo): void;
  canvas?: {
    t(key: Key): string;
    muted?: boolean;
    onMutedChange?(muted: boolean): void;
    onExpand?(position: number): void;
  };
  muted?: boolean;
  onMutedChange?(muted: boolean): void;
  controls?: boolean;
  loop?: boolean;
}) {
  const { cache, queue } = mediaSession(request);
  const key = mediaKey(projectId, data, preview);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(() => ({
    key,
    value: cache.peek(key),
    error: "",
  }));
  const value = loaded.key === key ? loaded.value : cache.peek(key);
  const src = value?.src ?? "";
  const error = loaded.key === key ? loaded.error : "";
  useEffect(() => {
    let active = true;
    const lease = cache.acquire(key, (signal) =>
      queue.run(signal, () =>
        readMediaBlob(request, projectId, data, preview, signal),
      ),
    );
    const cached = cache.peek(key);
    if (cached)
      setLoaded((previous) =>
        previous.key === key && previous.value === cached
          ? previous
          : { key, value: cached, error: "" },
      );
    void lease.promise
      .then((value) => {
        if (active)
          setLoaded((previous) =>
            previous.key === key && previous.value === value
              ? previous
              : { key, value, error: "" },
          );
      })
      .catch((error) => {
        if (active)
          setLoaded({
            key,
            value: undefined,
            error: String(error.message ?? error),
          });
      });
    return () => {
      active = false;
      lease.release();
    };
  }, [cache, queue, key, attempt]);
  if (error)
    return (
      <span className={css.mediaError} role="alert">
        {error}
        <button
          type="button"
          className={`${css.mediaRetry} nodrag nopan`}
          onClick={(event) => {
            event.stopPropagation();
            setLoaded({ key, value: undefined, error: "" });
            setAttempt((value) => value + 1);
          }}
        >
          {canvas?.t("retry") ?? "重试 / Retry"}
        </button>
      </span>
    );
  if (!src) return <div className={css.skeleton} aria-busy="true" />;
  if (data.kind === "video" && canvas && (!preview || !!data.media))
    return (
      <CanvasVideo
        src={src}
        t={canvas.t}
        muted={canvas.muted}
        onMutedChange={canvas.onMutedChange}
        onExpand={canvas.onExpand}
        onLoadedMetadata={(e) => {
          const video = e.currentTarget;
          onReady?.({
            src,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
          });
        }}
      />
    );
  return data.kind === "video" && (!preview || !!data.media) ? (
    <video
      src={src}
      controls={controls ?? !preview}
      loop={loop}
      muted={muted ?? preview}
      onVolumeChange={(e) => onMutedChange?.(e.currentTarget.muted)}
      autoPlay={autoPlay && !preview}
      preload="metadata"
      playsInline
      onDoubleClickCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onLoadedMetadata={(e) => {
        const video = e.currentTarget;
        onReady?.({
          src,
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
        });
        if (start !== undefined && Number.isFinite(start))
          e.currentTarget.currentTime = Math.min(
            Math.max(start, 0),
            e.currentTarget.duration || start,
          );
      }}
    />
  ) : (
    <img
      src={src}
      alt={data.label}
      draggable={false}
      onLoad={(e) =>
        onReady?.({
          src,
          width: e.currentTarget.naturalWidth,
          height: e.currentTarget.naturalHeight,
        })
      }
    />
  );
}
export async function upload(
  request: Request,
  projectId: string,
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
) {
  const r = await request("beginUpload", {
    projectId,
    name: file.name,
    mime: file.type || (/\.mov$/i.test(file.name) ? "video/quicktime" : ""),
    size: file.size,
  });
  let offset = 0;
  try {
    signal.throwIfAborted();
    while (offset < file.size) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(
        await file.slice(offset, offset + 512 * 1024).arrayBuffer(),
      );
      let binary = "";
      for (let n = 0; n < bytes.length; n += 8192)
        binary += String.fromCharCode(...bytes.subarray(n, n + 8192));
      const result = await request(
        "uploadChunk",
        { id: r.id, offset, data: btoa(binary) },
        signal,
      );
      offset = result.offset;
      onProgress(Math.round((offset / file.size) * 100));
    }
    signal.throwIfAborted();
    const media = await request("finishUpload", { id: r.id }, signal);
    seedMedia(
      request,
      projectId,
      {
        kind: media.mime.startsWith("video/") ? "video" : "image",
        label: media.name,
        text: "",
        media,
      },
      file,
    );
    return media;
  } catch (e) {
    await request("cancelUpload", { id: r.id }).catch(() => {});
    throw e;
  }
}
