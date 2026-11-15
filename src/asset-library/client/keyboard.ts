export type NavigationRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function createPointerIntent() {
  let previous: { x: number; y: number } | undefined;
  return (event: { clientX: number; clientY: number; pointerType: string }) => {
    if (event.pointerType === "touch") return false;
    const moved =
      !previous || previous.x !== event.clientX || previous.y !== event.clientY;
    previous = { x: event.clientX, y: event.clientY };
    return moved;
  };
}

export function nextGridIndex(
  rects: NavigationRect[],
  current: number,
  key: string,
) {
  if (!rects.length) return -1;
  if (current < 0) return 0;
  if (key === "ArrowLeft" || key === "ArrowRight")
    return Math.max(
      0,
      Math.min(rects.length - 1, current + (key === "ArrowLeft" ? -1 : 1)),
    );
  const origin = rects[current];
  if (!origin) return 0;
  const direction = key === "ArrowUp" ? -1 : 1;
  const rows = rects
    .map((rect, index) => ({ rect, index }))
    .filter(({ rect }) => (rect.top - origin.top) * direction > 4);
  if (!rows.length) return current;
  const distance = Math.min(
    ...rows.map(({ rect }) => Math.abs(rect.top - origin.top)),
  );
  return rows
    .filter(
      ({ rect }) => Math.abs(Math.abs(rect.top - origin.top) - distance) < 4,
    )
    .sort(
      (a, b) =>
        Math.abs(
          a.rect.left + a.rect.width / 2 - origin.left - origin.width / 2,
        ) -
        Math.abs(
          b.rect.left + b.rect.width / 2 - origin.left - origin.width / 2,
        ),
    )[0].index;
}
