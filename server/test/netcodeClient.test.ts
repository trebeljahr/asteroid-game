import assert from "node:assert/strict";
import { test } from "node:test";

import { type Pose, RenderSmoother } from "../../client/src/netcode/renderSmoother";
import { ServerTimeline } from "../../client/src/netcode/serverTimeline";
import { FixedStepClock, TICK_INTERVAL_MS } from "../../shared/src";

const assertPose = (actual: Pose | null, expected: Pose) => {
  assert.ok(actual !== null);
  for (const key of ["angle", "x", "y"] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 1e-9,
      `${key}: ${actual[key]} is not ${expected[key]}`,
    );
  }
};

test("the step clock keeps the tick rate however unevenly it is called", () => {
  // Browsers round a 16.67 ms interval down to 16 ms, Node rounds it up.
  for (const callbackMs of [4, 8, 16, 17, 23.3, 41]) {
    const clock = new FixedStepClock(TICK_INTERVAL_MS, 8);
    clock.reset(0);
    let steps = 0;
    for (let now = callbackMs; now <= 60_000; now += callbackMs) {
      steps += clock.advance(now);
    }
    assert.ok(Math.abs(steps - 3600) <= 3, `${callbackMs} ms callbacks gave ${steps} steps`);
  }
});

test("the step clock drops time it cannot catch up on", () => {
  const clock = new FixedStepClock(TICK_INTERVAL_MS, 6);
  clock.reset(0);
  assert.equal(clock.advance(2000), 6);
  assert.equal(clock.advance(2000 + TICK_INTERVAL_MS + 0.01), 1);
});

test("the step clock reports how far the next step is", () => {
  const clock = new FixedStepClock(10, 8);
  clock.reset(0);
  assert.equal(clock.advance(25), 2);
  assert.equal(clock.alphaAt(25), 0.5);
  assert.equal(clock.alphaAt(27.5), 0.75);
  assert.equal(clock.msUntilNextStep(27.5), 2.5);
});

test("the drawn ship moves evenly between ticks", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: 0, x: 0, y: 0 });
  smoother.advance({ angle: 0.1, x: 10, y: -4 });

  assertPose(smoother.poseAt(0, 0), { angle: 0, x: 0, y: 0 });
  assertPose(smoother.poseAt(0.5, 0), { angle: 0.05, x: 5, y: -2 });
  assertPose(smoother.poseAt(1, 0), { angle: 0.1, x: 10, y: -4 });
});

test("a correction that confirms the prediction leaves the drawn ship alone", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: 0, x: 0, y: 0 });
  smoother.advance({ angle: 0, x: 8, y: 0 });
  const before = smoother.poseAt(0.4, 100)!;

  smoother.rebase({ angle: 0, x: 0, y: 0 }, { angle: 0, x: 8, y: 0 }, 0.4, 100);
  assertPose(smoother.poseAt(0.4, 100), before);
  assertPose(smoother.poseAt(0.4, 5000), before);
});

test("a real correction does not move the drawn ship at once and fades out", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: 0, x: 0, y: 0 });
  smoother.advance({ angle: 0, x: 8, y: 0 });
  const before = smoother.poseAt(0.5, 100)!;

  // The server says the ship is 30 px further right and turned.
  smoother.rebase({ angle: 0.3, x: 30, y: 0 }, { angle: 0.3, x: 38, y: 0 }, 0.5, 100);
  const after = smoother.poseAt(0.5, 100)!;
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.angle - before.angle) < 1e-9);

  const later = smoother.poseAt(0.5, 400)!;
  assert.ok(Math.abs(later.x - 34) < 1.5, "close to the corrected position after 300 ms");
  const settled = smoother.poseAt(0.5, 2000)!;
  assert.ok(Math.abs(settled.x - 34) < 1e-6);
  assert.ok(Math.abs(settled.angle - 0.3) < 1e-6);
});

test("a correction without a replayed tick keeps the last tick's movement", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: 0, x: 0, y: 0 });
  smoother.advance({ angle: 0, x: 8, y: 0 });

  // On a fast connection every input is confirmed already: nothing to replay.
  smoother.rebase(null, { angle: 0, x: 8, y: 0 }, 0.25, 100);
  assertPose(smoother.poseAt(0.25, 100), { angle: 0, x: 2, y: 0 });
  assertPose(smoother.poseAt(0.75, 100), { angle: 0, x: 6, y: 0 });
});

test("a teleport is shown as a teleport", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: 0, x: 0, y: 0 });
  smoother.rebase(null, { angle: 0, x: 900, y: 0 }, 1, 100);
  assertPose(smoother.poseAt(1, 100), { angle: 0, x: 900, y: 0 });
});

test("the drawn ship turns the short way across the angle wrap", () => {
  const smoother = new RenderSmoother();
  smoother.advance({ angle: Math.PI - 0.1, x: 0, y: 0 });
  smoother.advance({ angle: -Math.PI + 0.1, x: 0, y: 0 });
  const middle = smoother.poseAt(0.5, 0)!;
  assert.ok(Math.abs(Math.abs(middle.angle) - Math.PI) < 1e-9);
});

/** A ship flying right at 8 px per tick, as snapshots every second tick. */
const shipAt = (tick: number) => ({ tick, x: tick * 8 });

const drawnX = (timeline: ServerTimeline<{ tick: number; x: number }>, now: number) => {
  const view = timeline.view(now);
  assert.ok(view !== null);
  return view.to === null
    ? view.from.x + view.ahead * 8
    : view.from.x + (view.to.x - view.from.x) * view.mix;
};

test("a remote ship is drawn at a steady pace although its packets arrive unevenly", () => {
  const timeline = new ServerTimeline<{ tick: number; x: number }>();
  let random = 7;
  const jitter = () => {
    random = (random * 1664525 + 1013904223) >>> 0;
    return (random / 4294967296) * 25;
  };

  const arrivals: Array<{ at: number; tick: number }> = [];
  let lastArrival = 0;
  for (let tick = 2; tick <= 1200; tick += 2) {
    const at = Math.max(lastArrival, tick * TICK_INTERVAL_MS + 40 + jitter());
    arrivals.push({ at, tick });
    lastArrival = at;
  }

  const frameMs = 1000 / 60;
  let next = 0;
  let previousX: number | null = null;
  let worstHitch = 0;
  let backward = 0;
  let interpolated = 0;
  let frames = 0;
  for (let now = 200; now < 19_000; now += frameMs) {
    while (next < arrivals.length && arrivals[next].at <= now) {
      timeline.observe(arrivals[next].tick, shipAt(arrivals[next].tick), arrivals[next].at);
      next++;
    }
    const x = drawnX(timeline, now);
    if (now > 2000 && previousX !== null) {
      frames++;
      const moved = x - previousX;
      if (moved < 0) backward++;
      worstHitch = Math.max(worstHitch, Math.abs(moved - 8));
      if (timeline.view(now)?.to !== null) interpolated++;
    }
    previousX = x;
  }

  assert.equal(backward, 0, "the ship never moves backward");
  assert.ok(worstHitch < 1, `worst frame was ${worstHitch.toFixed(2)} px off`);
  assert.ok(interpolated / frames > 0.9, "the drawn moment lies between two snapshots");
  assert.ok(timeline.interpolationDelayMs < 110);
});

test("on a steady connection remote ships are drawn one snapshot interval behind", () => {
  const timeline = new ServerTimeline<{ tick: number; x: number }>();
  for (let tick = 2; tick <= 600; tick += 2) {
    timeline.observe(tick, shipAt(tick), tick * TICK_INTERVAL_MS + 30);
    timeline.view(tick * TICK_INTERVAL_MS + 30);
  }
  assert.ok(Math.abs(timeline.interpolationDelayMs - 2 * TICK_INTERVAL_MS) < 1);
});

test("when snapshots stop, a remote ship carries on briefly and then holds", () => {
  const timeline = new ServerTimeline<{ tick: number; x: number }>();
  for (let tick = 2; tick <= 120; tick += 2) {
    timeline.observe(tick, shipAt(tick), tick * TICK_INTERVAL_MS + 30);
  }
  const lastArrival = 120 * TICK_INTERVAL_MS + 30;
  const soon = timeline.view(lastArrival + 60)!;
  assert.equal(soon.to, null);
  assert.ok(soon.ahead > 0 && soon.ahead < 3);

  const stalled = timeline.view(lastArrival + 3000)!;
  assert.equal(stalled.ahead, 8);
});
