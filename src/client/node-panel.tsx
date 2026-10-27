import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useViewport, type Node } from "@xyflow/react";
import type { CreativeNode } from "../shared/contracts.ts";
import css from "./studio.module.css";

/** Screen-sized controls stay anchored to their node, including offscreen. */
export function NodePanel({
  node,
  root,
  above = false,
  children,
}: {
  node: Node<CreativeNode["data"]>;
  root: RefObject<HTMLDivElement>;
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
    const el = panel.current,
      canvas = root.current;
    if (!el || !canvas) return;
    const measure = () => {
      const next = {
        width: el.offsetWidth,
        height: el.offsetHeight,
      };
      setSize((old) =>
        Object.keys(next).every(
          (k) => old[k as keyof typeof old] === next[k as keyof typeof next],
        )
          ? old
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
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
      style={{ left, top, visibility: size.width ? undefined : "hidden" }}
    >
      {children}
    </div>
  );
}
