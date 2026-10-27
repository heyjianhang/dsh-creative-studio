import { useEffect, useRef } from "react";
import {
  Panel,
  useNodes,
  useReactFlow,
  useStore,
  useViewport,
} from "@xyflow/react";
import {
  minimapBounds,
  minimapScene,
  minimapPoint,
  minimapSize,
  minimapViewport,
} from "./minimap-geometry.ts";
import css from "./studio.module.css";

export function CanvasMinimap({ label }: { label: string }) {
  const flow = useReactFlow();
  const nodes = useNodes().filter((node) => !node.hidden);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const viewport = useViewport();
  // Use one node snapshot for both the scene bounds and its rectangles.
  // Mixing useNodes with the mutable internal lookup can show different frames.
  const { content, rects } = minimapScene(nodes);
  const bounds = minimapBounds(content, { width, height });
  const view = minimapViewport(viewport, { width, height });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  }>();

  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1);
      void flow.zoomTo(
        flow.getZoom() * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [flow]);

  const pointAt = (x: number, y: number) =>
    minimapPoint({ x, y }, svg.current!.getBoundingClientRect(), bounds);
  return (
    <Panel position="bottom-left" className={css.minimap + " nopan nowheel"}>
      <svg
        ref={svg}
        width={minimapSize.width}
        height={minimapSize.height}
        viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
        aria-label={label}
        role="group"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointAt(event.clientX, event.clientY);
          const inside =
            point.x >= view.x &&
            point.x <= view.x + view.width &&
            point.y >= view.y &&
            point.y <= view.y + view.height;
          drag.current = {
            pointerId: event.pointerId,
            x: inside ? point.x - view.x - view.width / 2 : 0,
            y: inside ? point.y - view.y - view.height / 2 : 0,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          if (!inside)
            void flow.setCenter(point.x, point.y, { zoom: flow.getZoom() });
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          if (!drag.current.moved) {
            if (
              Math.hypot(
                event.clientX - drag.current.startX,
                event.clientY - drag.current.startY,
              ) < 3
            )
              return;
            drag.current.moved = true;
          }
          const point = pointAt(event.clientX, event.clientY);
          void flow.setCenter(
            point.x - drag.current.x,
            point.y - drag.current.y,
            { zoom: flow.getZoom() },
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          if (!drag.current.moved) {
            const point = pointAt(event.clientX, event.clientY);
            void flow.setCenter(point.x, point.y, { zoom: flow.getZoom() });
          }
          drag.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onKeyDown={(event) => {
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [80, 0],
            ArrowRight: [-80, 0],
            ArrowUp: [0, 80],
            ArrowDown: [0, -80],
          };
          const move = moves[event.key];
          if (!move) return;
          event.preventDefault();
          event.stopPropagation();
          const current = flow.getViewport();
          void flow.setViewport({
            ...current,
            x: current.x + move[0],
            y: current.y + move[1],
          });
        }}
      >
        {rects.map((rect, index) => (
          <rect
            key={rect.id}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={(bounds.width / minimapSize.width) * 2}
            fill={
              nodes[index].selected
                ? "var(--dsw-alias-label-primary)"
                : "var(--dsw-alias-label-tertiary)"
            }
          />
        ))}
        <path
          d={`M${bounds.x},${bounds.y}h${bounds.width}v${bounds.height}h${-bounds.width}z M${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z`}
          fill="color-mix(in srgb, var(--dsw-alias-bg-base) 65%, transparent)"
          fillRule="evenodd"
        />
        <rect
          {...view}
          data-minimap-viewport=""
          fill="none"
          stroke="var(--dsw-alias-label-tertiary)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </Panel>
  );
}
