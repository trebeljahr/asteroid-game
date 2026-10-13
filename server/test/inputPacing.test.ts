import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShipInputState } from "../../shared/src";
import {
  createInputPacing,
  INPUT_BUDGET_MAX,
  INPUT_BUDGET_PER_TICK,
  INPUT_QUEUE_HEADROOM,
  MAX_HELD_INPUTS,
  MAX_INPUTS_PER_TICK,
  STARVED_COAST_AFTER_TICKS,
  TRIM_WINDOW_TICKS,
  takeInputsForTick,
} from "../src/realtime/inputPacing";

const input = (inputSeq: number): ShipInputState => {
  return { fire: false, inputSeq, thrust: true, turnLeft: false, turnRight: false };
};

const seqs = (inputs: ShipInputState[]) => inputs.map((entry) => entry.inputSeq);

test("a steady stream applies one input per tick", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  for (let seq = 1; seq <= 200; seq++) {
    queue.push(input(seq));
    const due = takeInputsForTick(pacing, queue);
    assert.deepEqual(seqs(due.apply), [seq]);
    assert.equal(due.coast, false);
    assert.equal(due.discardedThroughSeq, null);
  }
});

test("a ship without input waits instead of repeating its last input", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [input(1)];
  assert.deepEqual(seqs(takeInputsForTick(pacing, queue).apply), [1]);

  const starved = takeInputsForTick(pacing, queue);
  assert.deepEqual(starved.apply, []);
  assert.equal(starved.coast, false);
});

test("one late packet costs a single pause, then the queue absorbs the jitter", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  // Arrivals per tick: the same late-then-double pattern, over and over.
  const arrivals = [1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2];
  const applied: number[] = [];
  let seq = 0;
  for (const count of arrivals) {
    for (let index = 0; index < count; index++) queue.push(input(++seq));
    applied.push(takeInputsForTick(pacing, queue).apply.length);
  }
  assert.deepEqual(applied, [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test("jitter larger than a tick stops disturbing the ship once the buffer has filled", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  let random = 99;
  const jitterTicks = () => {
    random = (random * 1664525 + 1013904223) >>> 0;
    return (random / 4294967296) * 1.8;
  };
  // Input k is sent on tick k and arrives up to 1.8 ticks late, in order.
  const arrivalTicks: number[] = [];
  for (let seq = 1; seq <= 2000; seq++) {
    arrivalTicks.push(Math.max(arrivalTicks[seq - 2] ?? 0, seq + jitterTicks()));
  }

  let next = 0;
  const applied: number[] = [];
  for (let tick = 1; tick <= 2000; tick++) {
    while (next < arrivalTicks.length && arrivalTicks[next] <= tick) {
      queue.push(input(++next));
    }
    applied.push(takeInputsForTick(pacing, queue).apply.length);
  }

  const settled = applied.slice(300);
  const uneven = settled.filter((count) => count !== 1).length;
  assert.ok(uneven <= 4, `${uneven} uneven ticks out of ${settled.length}`);
  assert.ok(queue.length <= MAX_HELD_INPUTS);
});

test("delay the connection no longer needs is shed", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [input(1), input(2), input(3), input(4)];
  let seq = 4;
  // A steady stream, with three inputs left over from an earlier burst.
  for (let tick = 0; tick < TRIM_WINDOW_TICKS * 2; tick++) {
    queue.push(input(++seq));
    takeInputsForTick(pacing, queue);
  }
  assert.equal(queue.length, INPUT_QUEUE_HEADROOM);
});

test("a backlog is worked off a few steps per tick, in order", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  for (let seq = 1; seq <= 12; seq++) queue.push(input(seq));

  const applied: number[] = [];
  let ticks = 0;
  while (queue.length > MAX_HELD_INPUTS) {
    const due = takeInputsForTick(pacing, queue);
    assert.ok(due.apply.length <= MAX_INPUTS_PER_TICK);
    assert.equal(due.discardedThroughSeq, null);
    applied.push(...seqs(due.apply));
    ticks++;
  }
  assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(ticks, 3);
});

test("inputs sent faster than real time are discarded and acknowledged", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  const ticks = 600;
  let seq = 0;
  let applied = 0;
  let lastDiscarded = 0;
  for (let tick = 0; tick < ticks; tick++) {
    // Twice the honest rate.
    queue.push(input(++seq), input(++seq));
    const due = takeInputsForTick(pacing, queue);
    applied += due.apply.length;
    if (due.discardedThroughSeq !== null) {
      assert.ok(due.discardedThroughSeq > lastDiscarded);
      lastDiscarded = due.discardedThroughSeq;
      // Everything applied afterwards is newer than what was discarded.
      for (const entry of due.apply) assert.ok(entry.inputSeq > lastDiscarded);
    }
  }
  assert.ok(applied <= ticks * INPUT_BUDGET_PER_TICK + INPUT_BUDGET_MAX);
  assert.ok(lastDiscarded > 0);
  assert.ok(
    queue.length <= MAX_HELD_INPUTS + 2,
    "the queue does not grow into permanent input delay",
  );
});

test("a long stall is caught up within the budget and the rest is dropped", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  // 50 inputs arrive at once: more than half a second of play.
  for (let seq = 1; seq <= 50; seq++) queue.push(input(seq));

  const first = takeInputsForTick(pacing, queue);
  assert.ok(first.discardedThroughSeq !== null);
  assert.equal(first.apply[0].inputSeq, first.discardedThroughSeq + 1);
  assert.ok(50 - first.discardedThroughSeq <= INPUT_BUDGET_MAX + MAX_HELD_INPUTS);
});

test("a ship that stays silent drifts after a while and steers again on new input", () => {
  const pacing = createInputPacing();
  const queue: ShipInputState[] = [];
  for (let tick = 0; tick < STARVED_COAST_AFTER_TICKS; tick++) {
    assert.equal(takeInputsForTick(pacing, queue).coast, false);
  }
  assert.equal(takeInputsForTick(pacing, queue).coast, true);

  queue.push(input(1));
  const resumed = takeInputsForTick(pacing, queue);
  assert.equal(resumed.coast, false);
  assert.deepEqual(seqs(resumed.apply), [1]);
});
