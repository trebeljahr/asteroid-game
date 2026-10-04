import assert from "node:assert/strict";
import { test } from "node:test";

import { createSeededRandom, createSeededRandomState, nextSeededRandom } from "../../shared/src";

test("stateful generator matches the closure generator and survives JSON", () => {
  for (const seed of [0, 1, 0x9e3779b9, 0xffffffff, 123456789]) {
    const reference = createSeededRandom(seed);
    let state = createSeededRandomState(seed);
    for (let index = 0; index < 20_000; index++) {
      if (index % 997 === 0) {
        // Persist and reload mid-sequence, as a snapshot handoff does.
        state = JSON.parse(JSON.stringify(state));
      }
      assert.equal(nextSeededRandom(state), reference(), `seed ${seed}, draw ${index}`);
    }
  }
});
