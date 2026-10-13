import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  BULLET_INHERITED_VELOCITY,
  BULLET_NOSE_OFFSET,
  BULLET_SIDE_OFFSET,
  BULLET_SPEED,
  createRuntimeBulletState,
  createRuntimePlayerState,
  getMuzzleOffset,
  resolveFireAngle,
  type ShipInputState,
  solveAimAngle,
} from "../../shared/src";
import { BattleRoyaleService } from "../src/battleRoyaleService";
import { MultiplayerService } from "../src/multiplayerService";
import { MatchDurability } from "../src/realtime/durability";
import type { HostContext, TypedServer } from "../src/realtime/matchHost";
import { MemoryCoordinationStore, type Ticket } from "../src/realtime/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const closeTo = (actual: number, expected: number, message: string, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

const input = (inputSeq: number, overrides: Partial<ShipInputState> = {}): ShipInputState => {
  return { fire: false, inputSeq, thrust: false, turnLeft: false, turnRight: false, ...overrides };
};

test("a shot without an aim angle leaves from the nose along the heading", () => {
  const player = createRuntimePlayerState("p1", "alpha");
  player.angle = 0.7;
  player.vx = 3;
  player.vy = -2;

  const fireAngle = resolveFireAngle(player, input(1, { fire: true }));
  assert.equal(fireAngle, player.angle);
  const bullet = createRuntimeBulletState(player, "b1", fireAngle);

  closeTo(bullet.x, player.x + Math.cos(0.7) * BULLET_NOSE_OFFSET, "spawn x");
  closeTo(bullet.y, player.y + Math.sin(0.7) * BULLET_NOSE_OFFSET, "spawn y");
  closeTo(bullet.vx, 3 * BULLET_INHERITED_VELOCITY + Math.cos(0.7) * BULLET_SPEED, "vx");
  closeTo(bullet.vy, -2 * BULLET_INHERITED_VELOCITY + Math.sin(0.7) * BULLET_SPEED, "vy");
  assert.deepEqual(createRuntimeBulletState(player, "b1"), bullet, "heading is the default");
});

test("unusable aim angles fall back to the heading", () => {
  const player = createRuntimePlayerState("p1", "beta");
  for (const aimAngle of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveFireAngle(player, { aimAngle }), player.angle);
  }
  assert.equal(resolveFireAngle(player, { aimAngle: 0 }), 0);
  assert.equal(resolveFireAngle(player, { aimAngle: -2.5 }), -2.5);
});

test("an aimed shot leaves from the hull edge in the aim direction", () => {
  const player = createRuntimePlayerState("p1", "alpha");
  player.angle = 0;

  closeTo(getMuzzleOffset(0, 0), BULLET_NOSE_OFFSET, "ahead");
  closeTo(getMuzzleOffset(0, Math.PI), BULLET_NOSE_OFFSET, "behind");
  closeTo(getMuzzleOffset(0, Math.PI / 2), BULLET_SIDE_OFFSET, "sideways");
  closeTo(getMuzzleOffset(1.3, 1.3 - Math.PI / 2), BULLET_SIDE_OFFSET, "relative to heading");

  const bullet = createRuntimeBulletState(player, "b1", Math.PI / 2);
  closeTo(bullet.x, player.x, "spawn x");
  closeTo(bullet.y, player.y + BULLET_SIDE_OFFSET, "spawn y");
  closeTo(bullet.vx, 0, "vx");
  closeTo(bullet.vy, BULLET_SPEED, "vy");
});

test("the solved aim angle sends the bullet at the target while the ship drifts", () => {
  const player = createRuntimePlayerState("p1", "alpha");
  const cases = [
    { target: [400, 0], velocity: [0, 8.8] },
    { target: [-300, 250], velocity: [6, -5] },
    { target: [10, -700], velocity: [-8.8, 0] },
    { target: [500, 500], velocity: [0, 0] },
  ];

  for (const { target, velocity } of cases) {
    player.vx = velocity[0];
    player.vy = velocity[1];
    const aimAngle = solveAimAngle(player, player.x + target[0], player.y + target[1]);
    assert.ok(aimAngle !== null);

    const bullet = createRuntimeBulletState(player, "b1", aimAngle);
    const speed = Math.hypot(bullet.vx, bullet.vy);
    const distance = Math.hypot(target[0], target[1]);
    closeTo(bullet.vx / speed, target[0] / distance, "travel direction x");
    closeTo(bullet.vy / speed, target[1] / distance, "travel direction y");
  }

  assert.equal(solveAimAngle(player, player.x, player.y), null, "no direction to aim in");
});

const durabilities: MatchDurability[] = [];
afterEach(() => {
  for (const durability of durabilities.splice(0)) durability.stop();
});

test("the duel server fires along the aim angle a client sends", async () => {
  const found = new Map<string, { matchId: string; playerId: string }>();
  const io = {
    in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
    to: (target: string) => ({
      emit: (event: string, payload: { matchId: string; playerId: string }) => {
        if (event === "match:found") found.set(target, payload);
      },
    }),
  } as unknown as TypedServer;
  const durability = new MatchDurability(new MemoryCoordinationStore(), "replica-a", true);
  durability.start();
  durabilities.push(durability);
  const context: HostContext = {
    durability,
    io,
    replicaId: "replica-a",
    routes: { bind: () => {}, unbind: () => {} },
  };
  const duel = new MultiplayerService(context);
  durability.register(duel);
  durability.register(new BattleRoyaleService(context));

  const ticket = (socketId: string): Ticket => {
    return {
      enqueuedAt: Date.now(),
      mode: "duel",
      replicaId: "replica-a",
      shipVariant: "orbit-dart",
      socketId,
      userId: null,
    };
  };
  await duel.createMatch([ticket("s1"), ticket("s2")]);
  const aimed = found.get("s1");
  const unaimed = found.get("s2");
  assert.ok(aimed && unaimed);

  await sleep(2700); // countdown
  // alpha heads right and aims straight down; beta heads left and does not aim.
  duel.handleInput(aimed.matchId, "s1", input(1, { aimAngle: Math.PI / 2, fire: true }));
  duel.handleInput(aimed.matchId, "s2", input(1, { fire: true }));
  await sleep(120);

  const snapshot = duel.snapshotFor(aimed.matchId);
  assert.ok(snapshot);
  const bullets = (
    snapshot.state as { bullets: Array<{ ownerId: string; vx: number; vy: number }> }
  ).bullets;
  const aimedBullet = bullets.find((bullet) => bullet.ownerId === aimed.playerId);
  const unaimedBullet = bullets.find((bullet) => bullet.ownerId === unaimed.playerId);
  assert.ok(aimedBullet && unaimedBullet);
  closeTo(aimedBullet.vx, 0, "aimed vx");
  closeTo(aimedBullet.vy, BULLET_SPEED, "aimed vy");
  closeTo(unaimedBullet.vx, -BULLET_SPEED, "unaimed vx");
  closeTo(unaimedBullet.vy, 0, "unaimed vy");
});
