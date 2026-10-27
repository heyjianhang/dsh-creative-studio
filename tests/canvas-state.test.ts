import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileNodes, reconcileEdges } from "../src/client/canvas-state.ts";
import { minimapScene, minimapBounds } from "../src/client/minimap-geometry.ts";
import type { CreativeNode } from "../src/shared/contracts.ts";
import type { Node } from "@xyflow/react";

const node: CreativeNode = {
  id: "image",
  type: "creative",
  position: { x: 10, y: 20 },
  data: { kind: "image", text: "", label: "image.png" },
};
test("save acknowledgement preserves measured size, selection, identity and minimap scene", () => {
  const old: Node<CreativeNode["data"]>[] = [
    { ...node, measured: { width: 270, height: 220 }, selected: true },
  ];
  const scene = minimapScene(old);
  const merged = reconcileNodes(old, structuredClone([node]));
  assert.equal(merged, old);
  assert.equal(merged[0].measured, old[0].measured);
  assert.equal(merged[0].selected, true);
  assert.deepEqual(minimapScene(merged), scene);
  assert.deepEqual(
    minimapBounds(minimapScene(merged).content, { width: 965, height: 704 }),
    minimapBounds(scene.content, { width: 965, height: 704 }),
  );
});

test("graph reconciliation applies real edits and removals without resetting untouched media", () => {
  const second = { ...node, id: "second", position: { x: 400, y: 0 } };
  const old = [
    { ...node, measured: { width: 270, height: 220 }, selected: true },
    { ...second, selected: false },
  ];
  const changed = { ...second, data: { ...second.data, label: "renamed" } };
  const merged = reconcileNodes(old, [structuredClone(node), changed]);
  assert.equal(merged[0], old[0]);
  assert.equal(merged[1].data.label, "renamed");
  assert.equal(reconcileNodes(merged, [changed]).length, 1);
  const edges = [
    { id: "e", source: node.id, target: second.id, selected: true },
  ];
  assert.equal(reconcileEdges(edges, structuredClone(edges)), edges);
  assert.equal(reconcileEdges(edges, []).length, 0);
});

test("minimap uses the same finite rectangles for measured and not-yet-loaded media", () => {
  const scene = minimapScene([{ ...node, measured: { width: 0, height: 0 } }]);
  assert.equal(scene.rects[0].width, 270);
  assert.equal(scene.rects[0].height, 152);
  assert.deepEqual(scene.content, { x: 10, y: 20, width: 270, height: 152 });
});

test("color pins preserve dragging, measurements and selection; legacy position locks no longer apply", () => {
  const previous = [
    {
      ...node,
      measured: { width: 270, height: 152 },
      selected: true,
      draggable: true,
    },
  ];
  const pinned = reconcileNodes(previous, [
    {
      ...node,
      data: { ...node.data, pinned: true, colorPins: ["red", "blue"] },
    },
  ]);
  assert.equal(pinned[0].draggable, true);
  assert.deepEqual(pinned[0].data.colorPins, ["red", "blue"]);
  assert.equal(pinned[0].selected, true);
  assert.equal(pinned[0].measured, previous[0].measured);
  assert.equal(reconcileNodes(pinned, [node])[0].draggable, true);
  assert.equal(
    reconcileNodes([{ ...pinned[0], draggable: false }], [pinned[0]])[0]
      .draggable,
    true,
  );
});
