import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Resource } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { MediaView } from "./media.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

type HoverAsset = {
  id: string;
  resource: Resource;
  name: string;
  createdAt?: string;
  start?: number;
  applyLabel?: string;
  onApply(): void;
  onExpand(): void;
};
type Target = HoverAsset & { anchor: HTMLElement };

export function useAssetHover(enabled: boolean) {
  const [target, setTarget] = useState<Target>();
  const pending = useRef<Target>();
  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const dismiss = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    pending.current = undefined;
    setTarget(undefined);
  };
  useEffect(() => {
    if (!enabled) dismiss();
    return () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    };
  }, [enabled]);
  return {
    target: enabled ? target : undefined,
    dismiss,
    enter(anchor: HTMLElement, asset: HoverAsset) {
      if (!enabled) return;
      clearTimeout(closeTimer.current);
      if (pending.current?.id === asset.id) return;
      clearTimeout(openTimer.current);
      pending.current = { ...asset, anchor };
      // Switching rows never keeps the previous item's video playing.
      setTarget(undefined);
      openTimer.current = setTimeout(() => {
        setTarget(pending.current);
      }, 220);
    },
    leave() {
      clearTimeout(openTimer.current);
      if (!target) pending.current = undefined;
      closeTimer.current = setTimeout(dismiss, 220);
    },
    keep() {
      clearTimeout(closeTimer.current);
    },
  };
}

export function AssetHoverPreview({
  p,
  hover,
}: {
  p: CanvasProps;
  hover: ReturnType<typeof useAssetHover>;
}) {
  const projectId = p.useStudio((s) => s.current!.id);
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [ratio, setRatio] = useState(1);
  const target = hover.target;
  useLayoutEffect(() => {
    if (!target) return;
    const place = () => {
      if (!target.anchor.isConnected || !card.current) {
        hover.dismiss();
        return;
      }
      const rect = target.anchor.getBoundingClientRect();
      const width = card.current.offsetWidth,
        height = card.current.offsetHeight;
      const right = rect.right + 10;
      const left =
        right + width <= window.innerWidth - 12
          ? right
          : rect.left - width - 10 >= 12
            ? rect.left - width - 10
            : window.innerWidth - width - 12;
      setPosition({
        left: Math.max(12, left),
        top: Math.max(
          12,
          Math.min(rect.top - 16, window.innerHeight - height - 12),
        ),
      });
    };
    const close = () => hover.dismiss();
    const escape = (e: KeyboardEvent) => {
      if (
        ["Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(
          e.key,
        )
      )
        close();
    };
    const outside = (e: PointerEvent) => {
      const element = e.target as Node;
      if (!card.current?.contains(element) && !target.anchor.contains(element))
        close();
    };
    const observer = new ResizeObserver(place);
    if (card.current) observer.observe(card.current);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", outside, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [target]);
  useEffect(() => {
    setRatio(1);
  }, [target?.id]);
  if (!target) return null;
  const source = target.resource.media ?? target.resource.asset!;
  const date = target.createdAt ? new Date(target.createdAt) : undefined;
  const apply = () => {
    hover.dismiss();
    target.onApply();
  };
  return createPortal(
    <div
      ref={card}
      className={css.assetHoverCard}
      data-studio-assets
      data-asset-hover={target.id}
      role="region"
      aria-label={`${p.t("previewAsset")} · ${target.name}`}
      style={{ ...position, visibility: position ? "visible" : "hidden" }}
      onPointerEnter={hover.keep}
      onPointerLeave={hover.leave}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={css.assetHoverMedia} style={{ aspectRatio: ratio }}>
        <MediaView
          key={target.id}
          request={p.request}
          projectId={projectId}
          data={{ ...target.resource, label: target.name, text: "" }}
          preview={target.resource.kind === "image"}
          autoPlay
          muted
          loop
          controls={false}
          start={target.start}
          onReady={(info) => {
            if (info.width && info.height) setRatio(info.width / info.height);
          }}
        />
      </div>
      <div className={css.assetHoverInfo}>
        <div className={css.assetHoverTitle}>
          <strong title={target.name}>{target.name}</strong>
          <Button
            aria-label={p.t("previewAsset")}
            onClick={() => {
              hover.dismiss();
              target.onExpand();
            }}
          >
            <Icon name="fit" size={17} />
          </Button>
        </div>
        <span>
          {date && Number.isFinite(date.getTime())
            ? `${p.t("assetCreatedAt")} ${date.toLocaleString()}`
            : `${p.t(target.resource.kind)} · ${source.size >= 1024 ** 2 ? `${(source.size / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(source.size / 1024))} KB`}`}
        </span>
        <Button
          className={css.assetHoverApply}
          variant="outline"
          onClick={apply}
        >
          {target.applyLabel ?? p.t("applyToCanvas")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
