import type { Rect, Viewport, XYPosition } from "@xyflow/react";

export const minimapSize = { width: 200, height: 136 };

export function minimapScene(
  nodes: {
    id: string;
    position: XYPosition;
    measured?: { width?: number; height?: number };
    width?: number;
    height?: number;
  }[],
) {
  const rects = nodes.map((node) => ({
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.measured?.width || node.width || 270,
    height: node.measured?.height || node.height || 152,
  }));
  if (!rects.length)
    return { rects, content: { x: 0, y: 0, width: 0, height: 0 } };
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    rects,
    content: {
      x,
      y,
      width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
      height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
    },
  };
}

export function minimapBounds(
  content: Rect,
  canvas: { width: number; height: number },
): Rect {
  // Fit the scene, never the moving viewport: panning must not rescale the map.
  const scale = Math.max(
    Math.max(content.width * 1.4, canvas.width, 800) / minimapSize.width,
    Math.max(content.height * 1.4, canvas.height, 544) / minimapSize.height,
  );
  const width = scale * minimapSize.width;
  const height = scale * minimapSize.height;
  return {
    x: content.x + content.width / 2 - width / 2,
    y: content.y + content.height / 2 - height / 2,
    width,
    height,
  };
}

export function minimapViewport(
  viewport: Viewport,
  canvas: { width: number; height: number },
): Rect {
  return {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: canvas.width / viewport.zoom,
    height: canvas.height / viewport.zoom,
  };
}

export function minimapPoint(
  point: XYPosition,
  element: Rect,
  bounds: Rect,
): XYPosition {
  return {
    x: bounds.x + ((point.x - element.x) / element.width) * bounds.width,
    y: bounds.y + ((point.y - element.y) / element.height) * bounds.height,
  };
}
