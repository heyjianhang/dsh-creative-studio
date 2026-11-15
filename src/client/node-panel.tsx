import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useViewport, type Node } from "@xyflow/react";
import type { CreativeNode } from "../shared/contracts.ts";
import css from "./studio.module.css";

/** Controls stay anchored to their node; the viewport toolbar renders above them. */
export function NodePanel({
  node,
  above = false,
  children,
}: {
  node: Node<CreativeNode["data"]>;
  above?: boolean;
  children: ReactNode;
}) {
  const viewport = useViewport();
  const panel = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({
    width: 0,
    height: 0,
  });
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const measure = () => {
      const next = {
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
      setSize((old) =>
        old.width === next.width && old.height === next.height ? old : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const width = node.measured?.width ?? node.width ?? 270;
  const height = node.measured?.height ?? node.height ?? 152;
  const center = (node.position.x + width / 2) * viewport.zoom + viewport.x;
  const edge =
    (node.position.y + (above ? 0 : height)) * viewport.zoom + viewport.y;
  const left = center - size.width / 2;
  const top = edge + (above ? -size.height - 16 : 16);
  return (
    <div
      ref={panel}
      className={`${css.nodePanel} ${above ? css.nodePanelAbove : css.nodePanelBelow}`}
      data-node-panel={above ? "actions" : "composer"}
      data-node-id={node.id}
      style={{
        left,
        top,
        visibility: size.width ? undefined : "hidden",
      }}
    >
      {children}
    </div>
  );
}
