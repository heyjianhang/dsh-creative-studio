import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { Icon, type IconName } from "../../client/icons.tsx";
import type { Asset } from "../shared/contracts.ts";
import type { SharedProps } from "./props.ts";
import { imageWheelAction, imageZoomOffset } from "./image-navigation.ts";
import css from "./library.module.css";

/** Original-media viewer; zoom and panning affect only this preview. */
export function MediaViewer({
  url,
  asset,
  t,
  autoPlay,
  suspended,
  start,
  onExpand,
}: {
  url: string;
  asset: Asset;
  t: SharedProps["t"];
  autoPlay?: boolean;
  suspended?: boolean;
  start?: number | null;
  onExpand?(): void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number }>();
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const requestedScale = useRef(1);
  const pendingScroll = useRef<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () =>
      setBounds({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = video.current;
    if (suspended) el?.pause();
    return () => el?.pause();
  }, [suspended]);
  const ready = natural.width > 0 && bounds.width > 0 && bounds.height > 0;
  const fit = ready
    ? Math.min(1, bounds.width / natural.width, bounds.height / natural.height)
    : 1;
  const scale = zoom ?? fit;
  const zoomTo = (next: number, point?: { x: number; y: number }) => {
    const el = stage.current;
    if (!el || !ready) return;
    const target = Math.max(Math.min(0.05, fit), Math.min(8, next));
    if (target === requestedScale.current) return;
    const scroll = pendingScroll.current ?? {
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    pendingScroll.current = imageZoomOffset(
      {
        ...bounds,
        imageWidth: natural.width,
        imageHeight: natural.height,
        ...scroll,
        scale: requestedScale.current,
      },
      target,
      point ?? { x: bounds.width / 2, y: bounds.height / 2 },
    );
    requestedScale.current = target;
    setZoom(target);
  };
  const reset = () => {
    pendingScroll.current = undefined;
    setZoom(null);
  };
  useLayoutEffect(() => {
    const el = stage.current;
    if (el) {
      const position = pendingScroll.current;
      el.scrollLeft = position?.left ?? (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = position?.top ?? (el.scrollHeight - el.clientHeight) / 2;
    }
    requestedScale.current = scale;
    pendingScroll.current = undefined;
  }, [scale, url]);
  useEffect(() => {
    const el = stage.current;
    if (!el || asset.kind !== "image" || !ready || suspended) return;
    const point = (x: number, y: number) => {
      const rect = el.getBoundingClientRect();
      return { x: x - rect.left, y: y - rect.top };
    };
    let gestureScale: number | undefined;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const action = imageWheelAction(e, el.clientHeight);
      if (action.kind === "zoom") {
        if (gestureScale === undefined)
          zoomTo(
            requestedScale.current * action.factor,
            point(e.clientX, e.clientY),
          );
      } else {
        el.scrollLeft += action.x;
        el.scrollTop += action.y;
      }
    };
    // WebKit delivers native trackpad pinches as gesture events instead of Ctrl+wheel.
    const gestureStart = (e: Event) => {
      e.preventDefault();
      gestureScale = requestedScale.current;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      if (
        gestureScale === undefined ||
        !("scale" in e) ||
        typeof e.scale !== "number" ||
        !Number.isFinite(e.scale) ||
        e.scale <= 0
      )
        return;
      const cursor =
        "clientX" in e &&
        typeof e.clientX === "number" &&
        "clientY" in e &&
        typeof e.clientY === "number"
          ? point(e.clientX, e.clientY)
          : undefined;
      zoomTo(gestureScale * e.scale, cursor);
    };
    const gestureEnd = (e: Event) => {
      e.preventDefault();
      gestureScale = undefined;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gestureStart, { passive: false });
    el.addEventListener("gesturechange", gestureChange, { passive: false });
    el.addEventListener("gestureend", gestureEnd, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gestureStart);
      el.removeEventListener("gesturechange", gestureChange);
      el.removeEventListener("gestureend", gestureEnd);
    };
  }, [
    asset.kind,
    ready,
    suspended,
    fit,
    bounds.width,
    bounds.height,
    natural.width,
    natural.height,
  ]);
  const action = (
    label: string,
    icon: IconName,
    run: () => void,
    disabled = false,
  ) => (
    <Tooltip label={label} portal>
      <Button size="sm" aria-label={label} disabled={disabled} onClick={run}>
        <Icon name={icon} size={17} />
      </Button>
    </Tooltip>
  );
  return (
    <div className={css.mediaViewer}>
      <div
        ref={stage}
        className={css.viewerStage}
        data-pannable={(asset.kind === "image" && scale > fit) || undefined}
        onDoubleClick={(e) => {
          if (asset.kind !== "image" || !ready) return;
          if (zoom !== null) reset();
          else {
            const rect = e.currentTarget.getBoundingClientRect();
            zoomTo(1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
          }
        }}
        onPointerDown={(e) => {
          if (asset.kind !== "image" || scale <= fit || e.button !== 0) return;
          const el = e.currentTarget;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: el.scrollLeft,
            top: el.scrollTop,
          };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            e.currentTarget.scrollLeft =
              drag.current.left + drag.current.x - e.clientX;
            e.currentTarget.scrollTop =
              drag.current.top + drag.current.y - e.clientY;
          }
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        {asset.kind === "video" ? (
          <video
            ref={video}
            src={url}
            controls
            playsInline
            autoPlay={autoPlay}
            className={css.viewerVideo}
            aria-label={asset.name}
            onLoadedMetadata={(e) => {
              if (start) e.currentTarget.currentTime = start;
            }}
          />
        ) : (
          <div className={css.viewerImageSpace}>
            <img
              src={url}
              alt={asset.name}
              draggable={false}
              onLoad={(e) =>
                setNatural({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              style={{
                width: natural.width ? natural.width * scale : undefined,
                height: natural.height ? natural.height * scale : undefined,
                visibility: ready ? undefined : "hidden",
              }}
            />
          </div>
        )}
      </div>
      <nav className={css.viewerToolbar} aria-label={t("quickPreview")}>
        {asset.kind === "image" && (
          <>
            {action(
              t("zoomOut"),
              "minus",
              () => zoomTo(scale / 1.25),
              !ready || scale <= Math.min(0.05, fit),
            )}
            <Tooltip label={t("actualPixels")} portal>
              <Button
                size="sm"
                className={css.viewerZoom}
                onClick={() => zoomTo(1)}
                disabled={!ready}
                aria-label={t("actualPixels")}
              >
                {ready
                  ? `${Math.max(0.1, Math.round(scale * 1000) / 10)}%`
                  : "—"}
              </Button>
            </Tooltip>
            {action(
              t("zoomIn"),
              "plus",
              () => zoomTo(scale * 1.25),
              !ready || scale >= 8,
            )}
            {action(t("fitImage"), "fit", reset, !ready)}
            <span className={css.viewerDivider} />
          </>
        )}
        {onExpand && action(t("expandPreview"), "image", onExpand)}
        {action(t("downloadOriginal"), "download", () => {
          const link = document.createElement("a");
          link.href = url;
          link.download = asset.name;
          link.click();
        })}
      </nav>
    </div>
  );
}
