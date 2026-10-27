import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CreativeNode } from "../shared/contracts.ts";
import type { Request } from "./props.ts";
import { MediaView } from "./media.tsx";
import css from "./studio.module.css";

export type ReferenceHover = {
  id: string;
  anchor: HTMLElement;
  showName: boolean;
};

export function ReferenceHoverPreview({
  hover,
  node,
  thumbnail,
  request,
  projectId,
}: {
  hover: ReferenceHover;
  node: CreativeNode;
  thumbnail?: string;
  request: Request;
  projectId: string;
}) {
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
    maxHeight: number;
  }>();
  useLayoutEffect(() => {
    const place = () => {
      if (!hover.anchor.isConnected) {
        setPosition(undefined);
        return;
      }
      const rect = hover.anchor.getBoundingClientRect();
      const width = Math.min(192, window.innerWidth - 24);
      setPosition({
        left: Math.max(
          12,
          Math.min(
            rect.left + rect.width / 2 - width / 2,
            window.innerWidth - width - 12,
          ),
        ),
        bottom: window.innerHeight - rect.top + 8,
        width,
        maxHeight: Math.max(0, Math.min(180, rect.top - 20)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [hover.anchor]);

  if (!position || position.maxHeight < 40) return null;
  return createPortal(
    <div
      className={css.composerReferencePreview}
      style={position}
      data-reference-preview={hover.showName ? "attachment" : "mention"}
      aria-hidden="true"
    >
      {node.data.kind === "image" ? (
        thumbnail ? (
          <img src={thumbnail} alt="" />
        ) : (
          <MediaView
            request={request}
            projectId={projectId}
            data={node.data}
            preview
          />
        )
      ) : (
        <p>{node.data.text.slice(0, 350)}</p>
      )}
      {hover.showName && <span>@{node.data.label}</span>}
    </div>,
    document.body,
  );
}
