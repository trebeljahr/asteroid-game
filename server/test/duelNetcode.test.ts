import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAYER_TURN_SPEED } from "../../shared/src";
import { MultiplayerService } from "../src/multiplayerService";
import { INPUT_BUDGET_MAX, INPUT_BUDGET_PER_TICK } from "../src/realtime/inputPacing";
import type { HostContext } from "../src/realtime/matchHost";
import { type Controls, idle, type LinkProfile, runDuel, summarize } from "./netcodeHarness";

// Each pilot circles near its own spawn point, with changing thrust and
// fire, so the ships never touch each other and every correction the
// server makes is a netcode error, not a collision.
const circle = (phaseMs: number, turn: "turnLeft" | "turnRight") => {
  return (elapsedMs: number): Controls => {
    const seconds = (elapsedMs + phaseMs) / 1000;
    return { ...idle, fire: seconds % 2 < 0.4, thrust: seconds % 3 < 2.2, [turn]: true };
  };
};

const fast: LinkProfile = { jitterMs: 2, latencyMs: 5 };
const typical: LinkProfile = { jitterMs: 15, latencyMs: 40 };
const slow: LinkProfile = { jitterMs: 30, latencyMs: 80 };
const stalling: LinkProfile = { jitterMs: 15, latencyMs: 40, stall: { everyMs: 2000, forMs: 250 } };

test("the server confirms the predicted ship instead of correcting it", async (t) => {
  for (const link of [fast, typical, slow]) {
    const report = await runDuel(t.mock.timers, {
      activeMs: 10_000,
      pilots: [
        { controls: circle(0, "turnLeft"), link },
        { controls: circle(900, "turnRight"), link },
      ],
    });
    t.mock.timers.reset();

    assert.equal(report.endedEarly, false);
    for (const pilot of Object.values(report.pilots)) {
      const corrections = summarize(pilot.corrections, 0.01);
      assert.ok(corrections.count > 250, "the match was played");
      assert.equal(corrections.over, 0, `${corrections.over} corrections, max ${corrections.max}`);
    }
  }
});

test("a ship steps evenly on the server although its inputs arrive unevenly", async (t) => {
  for (const link of [typical, slow]) {
    const report = await runDuel(t.mock.timers, {
      activeMs: 10_000,
      pilots: [
        { controls: circle(0, "turnLeft"), link },
        { controls: circle(900, "turnRight"), link },
      ],
    });
    t.mock.timers.reset();

    assert.equal(report.endedEarly, false);
    for (const pilot of Object.values(report.pilots)) {
      // Snapshots are two ticks apart: two steps each, once the input buffer has settled.
      const settled = pilot.appliedPerSnapshot.slice(60);
      assert.ok(settled.length > 200);
      const uneven = settled.filter((steps) => steps !== 2).length;
      assert.ok(uneven <= 2, `${uneven} of ${settled.length} snapshot intervals were uneven`);
    }
  }
});

test("the picture is smooth over a jittery connection", async (t) => {
  const report = await runDuel(t.mock.timers, {
    activeMs: 10_000,
    pilots: [
      { controls: circle(0, "turnLeft"), link: typical },
      { controls: circle(900, "turnRight"), link: typical },
    ],
  });
  t.mock.timers.reset();

  assert.equal(report.endedEarly, false);
  for (const pilot of Object.values(report.pilots)) {
    // The ships fly at about 4 px per tick. The code before this test
    // existed moved them off by 6 px and more, many times per second.
    const own = summarize(pilot.selfHitches, 0.5);
    assert.ok(own.count > 500);
    assert.equal(own.over, 0, `own ship hitched ${own.over} times, max ${own.max.toFixed(2)} px`);

    const opponent = summarize(pilot.opponentHitches, 1.5);
    assert.ok(opponent.count > 500);
    assert.equal(
      opponent.over,
      0,
      `opponent hitched ${opponent.over} times, max ${opponent.max.toFixed(2)} px`,
    );
    assert.equal(pilot.opponentBackwardFrames, 0, "the opponent never jumps backward");
  }
});

test("one player's stalling connection does not disturb the other player", async (t) => {
  const report = await runDuel(t.mock.timers, {
    activeMs: 10_000,
    pilots: [
      { controls: circle(0, "turnLeft"), link: typical },
      { controls: circle(900, "turnRight"), link: stalling },
    ],
  });
  t.mock.timers.reset();

  assert.equal(report.endedEarly, false);
  // The steady player's ship is never corrected, and it keeps stepping evenly.
  const uneven = report.pilots.s1.appliedPerSnapshot.slice(60).filter((steps) => steps !== 2);
  assert.ok(uneven.length <= 2, `${uneven.length} uneven snapshot intervals`);
  assert.equal(summarize(report.pilots.s1.corrections, 0.01).over, 0);
  // The stalling player's own inputs still arrive in order: no rubber-banding either.
  assert.equal(summarize(report.pilots.s2.corrections, 0.01).over, 0);

  // Bullets advance exactly one step per server tick, whatever the players' packets do.
  let checked = 0;
  for (let index = 1; index < report.serverSnapshots.length; index++) {
    const earlierTick = report.serverSnapshots[index - 1].sequence;
    const laterTick = report.serverSnapshots[index].sequence;
    const earlier = report.serverBullets.get(earlierTick) ?? [];
    for (const bullet of report.serverBullets.get(laterTick) ?? []) {
      const before = earlier.find((candidate) => candidate.id === bullet.id);
      if (before === undefined) continue;
      assert.ok(Math.abs(bullet.x - before.x - bullet.vx * (laterTick - earlierTick)) < 1e-6);
      assert.ok(Math.abs(bullet.y - before.y - bullet.vy * (laterTick - earlierTick)) < 1e-6);
      checked++;
    }
  }
  assert.ok(checked > 100, "bullets were in flight");
});

test("clients rebuild every bullet from spawn and removal events", async (t) => {
  for (const link of [fast, stalling]) {
    const report = await runDuel(t.mock.timers, {
      activeMs: 10_000,
      pilots: [
        { controls: circle(0, "turnLeft"), link },
        { controls: circle(900, "turnRight"), link: typical },
      ],
    });
    t.mock.timers.reset();

    assert.equal(report.endedEarly, false);
    for (const pilot of Object.values(report.pilots)) {
      // At every snapshot the client has exactly the server's bullets, where the server has them.
      const errors = summarize(pilot.bulletErrors, 1e-6);
      assert.ok(errors.count > 250, "the match was played");
      assert.equal(errors.over, 0, `${errors.over} snapshots off, worst ${errors.max} px`);
      assert.ok(pilot.bulletsCompared > 100, "bullets were in flight");
    }
  }
});

test("the simulation runs at 60 ticks per second", async (t) => {
  const activeMs = 5000;
  const report = await runDuel(t.mock.timers, {
    activeMs,
    pilots: [
      { controls: () => idle, link: typical },
      { controls: () => idle, link: typical },
    ],
  });
  t.mock.timers.reset();

  const active = report.serverSnapshots.filter((snapshot) => snapshot.phase === "active");
  const ticks = active[active.length - 1].sequence - active[0].sequence;
  assert.ok(Math.abs(ticks - (activeMs / 1000) * 60) <= 3, `${ticks} ticks in ${activeMs} ms`);
});

test("sending inputs faster does not make a ship faster", async (t) => {
  // Both pilots only turn, so the angle counts the steps the server applied.
  const turning = () => ({ ...idle, turnRight: true });
  const report = await runDuel(t.mock.timers, {
    activeMs: 6000,
    pilots: [
      { controls: turning, link: typical },
      { controls: turning, inputsPerTick: 2, link: typical },
    ],
  });
  t.mock.timers.reset();

  const steps = (socketId: string, startAngle: number) => {
    return (report.serverPlayers[socketId].angle - startAngle) / PLAYER_TURN_SPEED;
  };
  const honest = steps("s1", 0);
  const cheating = steps("s2", Math.PI);
  assert.ok(honest > 330, `the honest ship turned ${honest.toFixed(0)} steps`);
  assert.ok(
    cheating <= honest * INPUT_BUDGET_PER_TICK + INPUT_BUDGET_MAX + 5,
    `the fast sender got ${cheating.toFixed(0)} steps against ${honest.toFixed(0)}`,
  );
});

test("an input whose sequence number is not a counter value is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const io = {
    in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
    to: () => ({ emit: () => {} }),
  };
  const duel = new MultiplayerService({
    durability: {
      canHandOff: false,
      finish: async () => {},
      leaseLive: () => true,
      open: async (matchId: string) => ({ epoch: 1, matchId, owner: "replica-test" }),
    },
    io,
    now: () => Date.now(),
    replicaId: "replica-test",
    routes: { bind: () => {}, unbind: () => {} },
  } as unknown as HostContext);
  const ticket = (socketId: string) => {
    return {
      enqueuedAt: Date.now(),
      mode: "duel" as const,
      replicaId: "replica-test",
      shipVariant: "orbit-dart" as const,
      socketId,
      userId: null,
    };
  };
  await duel.createMatch([ticket("s1"), ticket("s2")]);
  const matchId = duel.fences()[0].matchId;
  t.mock.timers.tick(3000);

  for (const inputSeq of [Number.NaN, Number.POSITIVE_INFINITY, -4, 2.5]) {
    duel.handleInput(matchId, "s1", { ...idle, inputSeq, turnRight: true });
  }
  duel.handleInput(matchId, "s1", { ...idle, inputSeq: 7, turnRight: true });
  t.mock.timers.tick(200);

  const state = duel.snapshotFor(matchId)?.state as {
    players: Array<{ state: { angle: number; lastInputSeq: number } }>;
  };
  assert.equal(state.players[0].state.lastInputSeq, 7);
  assert.ok(Math.abs(state.players[0].state.angle - PLAYER_TURN_SPEED) < 1e-9, "one step applied");
});
