import test from "node:test";
import assert from "node:assert/strict";
import { mediaNodeSize } from "../src/client/media-geometry.ts";

test("portrait media narrows its node rather than adding empty side borders", () => {
  assert.deepEqual(mediaNodeSize(900, 1600), { width: 191.25, height: 340 });
});

test("landscape video and panoramic images preserve their full frame", () => {
  assert.deepEqual(mediaNodeSize(1920, 1080), { width: 270, height: 151.875 });
  assert.deepEqual(mediaNodeSize(3000, 300), { width: 270, height: 27 });
});

test("small media keeps its source dimensions", () => {
  assert.deepEqual(mediaNodeSize(80, 60), { width: 80, height: 60 });
});

test("unavailable media dimensions keep the loading size", () => {
  for (const [width, height] of [
    [0, 1080],
    [1920, 0],
    [NaN, 1080],
    [1920, Infinity],
  ])
    assert.equal(mediaNodeSize(width, height), null);
});
