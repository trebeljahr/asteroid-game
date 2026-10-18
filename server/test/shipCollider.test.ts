import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSeededRandom,
  getShipCollider,
  MULTIPLAYER_SHIP_VARIANTS,
  updateShipCollider,
} from "../../shared/src";

test("a reused collider matches a freshly built one at every pose", () => {
  const random = createSeededRandom(7);
  const collider = getShipCollider(0, 0, 0, "orbit-dart");
  for (let step = 0; step < 500; step++) {
    const x = (random() - 0.5) * 5000;
    const y = (random() - 0.5) * 3000;
    const angle = (random() - 0.5) * 20;
    // Switch variants now and then: their outlines have different point counts.
    const variant =
      MULTIPLAYER_SHIP_VARIANTS[Math.floor(step / 50) % MULTIPLAYER_SHIP_VARIANTS.length];
    const updated = updateShipCollider(collider, x, y, angle, variant);
    assert.equal(updated, collider);
    assert.deepEqual(updated, getShipCollider(x, y, angle, variant));
  }
});

test("a collider whose ship has not moved is not rebuilt", () => {
  const collider = getShipCollider(10, 20, 1, "comet-lance");
  const firstPoint = collider.shape.loops[0][0];
  const before = { ...firstPoint };
  firstPoint.x = Number.NaN;
  updateShipCollider(collider, 10, 20, 1, "comet-lance");
  assert.ok(Number.isNaN(collider.shape.loops[0][0].x));
  updateShipCollider(collider, 10, 20, 1.5, "comet-lance");
  assert.notDeepEqual(collider.shape.loops[0][0], before);
  assert.ok(Number.isFinite(collider.shape.loops[0][0].x));
});
