import { test } from "node:test";
import assert from "node:assert/strict";
import {
  minimapBounds,
  minimapPoint,
  minimapSize,
  minimapViewport,
} from "../src/client/minimap-geometry.ts";

test("panning beyond scene bounds preserves minimap scale and viewport dimensions", () => {
  const canvas = { width: 1440, height: 900 };
  const scene = { x: -100, y: -50, width: 2400, height: 1600 };
  const bounds = minimapBounds(scene, canvas);
  const before = minimapViewport({ x: 100, y: 200, zoom: 0.5 }, canvas);
  const after = minimapViewport({ x: -5000, y: 9000, zoom: 0.5 }, canvas);
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  assert.equal(after.x - before.x, 10200);
  assert.equal(after.y - before.y, -17600);
  assert.deepEqual(minimapBounds(scene, canvas), bounds);
  const zoomed = minimapViewport({ x: -5000, y: 9000, zoom: 1 }, canvas);
  assert.equal(zoomed.width, after.width / 2);
  assert.equal(zoomed.height, after.height / 2);
});

test("minimap fits scene without distortion and maps screen points back to canvas coordinates", () => {
  for (const scene of [
    { x: 0, y: 0, width: 0, height: 0 },
    { x: -8000, y: -400, width: 12000, height: 200 },
    { x: -20, y: 800, width: 200, height: 9000 },
  ]) {
    const bounds = minimapBounds(scene, { width: 965, height: 704 });
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(
      Math.abs(
        bounds.width / bounds.height - minimapSize.width / minimapSize.height,
      ) < 1e-10,
    );
    assert.ok(bounds.x <= scene.x && bounds.y <= scene.y);
    assert.ok(bounds.x + bounds.width >= scene.x + scene.width);
    assert.ok(bounds.y + bounds.height >= scene.y + scene.height);
    assert.deepEqual(
      minimapPoint({ x: 120, y: 98 }, { x: 20, y: 30, ...minimapSize }, bounds),
      {
        x: scene.x + scene.width / 2,
        y: scene.y + scene.height / 2,
      },
    );
  }
});
