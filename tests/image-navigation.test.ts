import test from "node:test";
import assert from "node:assert/strict";
import {
  imageWheelAction,
  imageZoomOffset,
} from "../src/asset-library/client/image-navigation.ts";

test("trackpad pinch zooms while two-finger motion pans both axes", () => {
  const event = {
    deltaX: 35,
    deltaY: 24,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
  };
  assert.deepEqual(imageWheelAction(event, 600), { kind: "pan", x: 35, y: 24 });
  assert.deepEqual(imageWheelAction({ ...event, deltaMode: 1 }, 600), {
    kind: "pan",
    x: 560,
    y: 384,
  });
  const inward = imageWheelAction({ ...event, ctrlKey: true }, 600);
  const outward = imageWheelAction(
    { ...event, ctrlKey: true, deltaY: -24 },
    600,
  );
  assert.equal(inward.kind, "zoom");
  assert.equal(outward.kind, "zoom");
  if (inward.kind === "zoom" && outward.kind === "zoom") {
    assert.ok(inward.factor < 1 && outward.factor > 1);
    assert.ok(Math.abs(inward.factor * outward.factor - 1) < 1e-10);
  }
});

test("zoom keeps the cursor on the same image point after a prior pan", () => {
  const view = {
    width: 600,
    height: 400,
    imageWidth: 1600,
    imageHeight: 1200,
    left: 100,
    top: 80,
    scale: 0.5,
  };
  const point = { x: 140, y: 200 };
  const next = imageZoomOffset(view, 1, point);
  assert.equal(next.left + point.x, (view.left + point.x) / view.scale);
  assert.equal(next.top + point.y, (view.top + point.y) / view.scale);
  assert.deepEqual(
    imageZoomOffset({ ...view, ...next, scale: 1 }, 0.5, point),
    { left: view.left, top: view.top },
  );
});

test("zoom respects centered letterboxing and clamps at image edges", () => {
  const view = {
    width: 800,
    height: 600,
    imageWidth: 1000,
    imageHeight: 2000,
    left: 0,
    top: 0,
    scale: 0.3,
  };
  assert.deepEqual(imageZoomOffset(view, 1, { x: 400, y: 300 }), {
    left: 100,
    top: 700,
  });
  assert.deepEqual(imageZoomOffset(view, 1, { x: 0, y: 0 }), {
    left: 0,
    top: 0,
  });
  assert.deepEqual(imageZoomOffset(view, 0.1, { x: 400, y: 300 }), {
    left: 0,
    top: 0,
  });
});
