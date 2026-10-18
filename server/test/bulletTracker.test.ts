import assert from "node:assert/strict";
import { test } from "node:test";

import { BulletTracker } from "../../client/src/netcode/bulletTracker";
import {
  advanceRuntimeBulletState,
  createBattleRoyalePlayerState,
  createRuntimeBulletState,
  type MatchBulletSnapshot,
  snapshotBulletState,
} from "../../shared/src";

const closeTo = (actual: MatchBulletSnapshot | undefined, expected: MatchBulletSnapshot) => {
  assert.ok(actual !== undefined, `${expected.id} is missing`);
  assert.equal(actual.id, expected.id);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x: ${actual.x} is not ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y: ${actual.y} is not ${expected.y}`);
};

const firedBullet = (id: string) => {
  const ship = createBattleRoyalePlayerState("p-1", 3, 7);
  ship.vx = 2.5;
  ship.vy = -1.25;
  return createRuntimeBulletState(ship, id, 0.4);
};

test("a spawned bullet is where the server moves it, tick by tick", () => {
  const server = firedBullet("b-1");
  const tracker = new BulletTracker();
  // Fired on tick 100: the server moves it once on that same tick.
  tracker.spawn(snapshotBulletState(server), 100);

  for (let tick = 100; tick < 160; tick++) {
    advanceRuntimeBulletState(server);
    closeTo(tracker.sample(tick)[0], server);
  }
});

test("a removed bullet reports where it ended and is gone", () => {
  const server = firedBullet("b-1");
  const tracker = new BulletTracker();
  tracker.spawn(snapshotBulletState(server), 10);
  tracker.spawn(snapshotBulletState(firedBullet("b-2")), 12);
  for (let tick = 10; tick <= 30; tick++) advanceRuntimeBulletState(server);

  closeTo(tracker.remove("b-1", 30) ?? undefined, server);
  assert.deepEqual(
    tracker.sample(31).map((bullet) => bullet.id),
    ["b-2"],
  );
  assert.equal(tracker.remove("b-1", 31), null, "removing twice finds nothing");
});

test("held bullets stay put during a countdown, then fly on", () => {
  const server = firedBullet("b-1");
  advanceRuntimeBulletState(server);
  const tracker = new BulletTracker();
  // A resumed match: the bullets as they were on tick 500.
  tracker.load([snapshotBulletState(server)], 500);
  // The countdown runs ticks 501 to 560; the server does not move bullets.
  for (let tick = 501; tick <= 560; tick++) tracker.hold(tick);
  closeTo(tracker.sample(560)[0], server);

  advanceRuntimeBulletState(server);
  closeTo(tracker.sample(561)[0], server);
});

test("load replaces every bullet", () => {
  const tracker = new BulletTracker();
  tracker.spawn(snapshotBulletState(firedBullet("b-1")), 10);
  tracker.load([snapshotBulletState(firedBullet("b-2"))], 20);
  assert.deepEqual(
    tracker.sample(20).map((bullet) => bullet.id),
    ["b-2"],
  );
  tracker.reset();
  assert.equal(tracker.size, 0);
});
