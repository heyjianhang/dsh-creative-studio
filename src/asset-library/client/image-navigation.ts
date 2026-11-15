/** Inputs measured from the image viewport, in CSS pixels. */
export interface ImageViewport {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  left: number;
  top: number;
  scale: number;
}

/**
 * Keep the image point beneath the cursor fixed while scaling.
 * @param view Current image and scrolling measurements.
 * @param scale New scale relative to the original image.
 * @param point Cursor position within the viewport.
 * @returns Bounded scroll offsets for the scaled image.
 */
export function imageZoomOffset(
  view: ImageViewport,
  scale: number,
  point: { x: number; y: number },
) {
  const axis = (
    size: number,
    image: number,
    scroll: number,
    cursor: number,
  ) => {
    const imagePoint =
      (scroll + cursor - Math.max(0, (size - image * view.scale) / 2)) /
      view.scale;
    return Math.max(
      0,
      Math.min(
        Math.max(0, image * scale - size),
        imagePoint * scale + Math.max(0, (size - image * scale) / 2) - cursor,
      ),
    );
  };
  return {
    left: axis(view.width, view.imageWidth, view.left, point.x),
    top: axis(view.height, view.imageHeight, view.top, point.y),
  };
}

/**
 * Translate browser wheel input into image navigation.
 * @param event Wheel deltas, unit and modifiers from the preview only.
 * @param height Viewport height for page-unit wheel deltas.
 * @returns Pinch zoom factor or two-axis pan distances.
 */
export function imageWheelAction(
  event: Pick<
    WheelEvent,
    "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey"
  >,
  height: number,
) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  return event.ctrlKey || event.metaKey
    ? { kind: "zoom" as const, factor: Math.exp(-event.deltaY * unit * 0.01) }
    : { kind: "pan" as const, x: event.deltaX * unit, y: event.deltaY * unit };
}
