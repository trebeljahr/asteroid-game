import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "node:test";

import type { ShipInputState } from "../../shared/src";
import { BattleRoyaleService } from "../src/battleRoyaleService";
import { MultiplayerService } from "../src/multiplayerService";
import { MatchDurability } from "../src/realtime/durability";
import type { HostContext, TypedServer } from "../src/realtime/matchHost";
import { MemoryCoordinationStore, type Ticket } from "../src/realtime/store";

// Run with MATCH_LEASE_TTL_MS=1000 MATCH_LEASE_RENEW_MS=200 MATCH_RESUME_GRACE_MS=1500.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Emit {
  event: string;
  payload: any;
  target: string;
}

const createFakeIo = () => {
  const emits: Emit[] = [];
  const io = {
    in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
    to: (target: string) => ({
      emit: (event: string, payload: unknown) => {
        emits.push({ event, payload, target });
      },
    }),
  };
  return { emits, io: io as unknown as TypedServer };
};

const durabilities: MatchDurability[] = [];
afterEach(() => {
  for (const durability of durabilities.splice(0)) durability.stop();
});

const createReplica = (store: MemoryCoordinationStore, replicaId: string) => {
  const { emits, io } = createFakeIo();
  const durability = new MatchDurability(store, replicaId, true);
  durability.start();
  durabilities.push(durability);
  const context: HostContext = {
    durability,
    io,
    replicaId,
    routes: { bind: () => {}, unbind: () => {} },
  };
  const duel = new MultiplayerService(context);
  const battleRoyale = new BattleRoyaleService(context);
  durability.register(duel);
  durability.register(battleRoyale);
  return { battleRoyale, duel, durability, emits };
};

const ticket = (socketId: string, mode: Ticket["mode"] = "duel"): Ticket => {
  return {
    enqueuedAt: Date.now(),
    mode,
    replicaId: "replica-a",
    shipVariant: "orbit-dart",
    socketId,
    userId: null,
  };
};

const input = (inputSeq: number, overrides: Partial<ShipInputState> = {}): ShipInputState => {
  return { fire: false, inputSeq, thrust: false, turnLeft: false, turnRight: false, ...overrides };
};

/** Claim every claimable match on `replica`, as the recovery loop does. */
const claimAll = async (
  store: MemoryCoordinationStore,
  replicaId: string,
  replica: ReturnType<typeof createReplica>,
) => {
  for (const lease of await store.listClaimable(10)) {
    const fence = await store.claimLease(lease.matchId, lease.epoch, replicaId);
    assert.ok(fence);
    replica.durability.adopt(fence, performance.now());
    const host = lease.mode === "duel" ? replica.duel : replica.battleRoyale;
    assert.equal(host.restore(fence, await store.readSnapshot(lease.matchId)), true);
  }
};

const foundPayloads = (emits: Emit[], event: string) => {
  return new Map(
    emits.filter((emit) => emit.event === event).map((emit) => [emit.target, emit.payload]),
  );
};

test("a drained duel resumes on another replica with identical state", async () => {
  const store = new MemoryCoordinationStore();
  const a = createReplica(store, "replica-a");
  await a.duel.createMatch([ticket("s1"), ticket("s2")]);
  const found = foundPayloads(a.emits, "match:found");
  const matchId: string = found.get("s1").matchId;

  await sleep(2700); // countdown
  for (let seq = 1; seq <= 30; seq++) {
    a.duel.handleInput(matchId, "s1", input(seq, { thrust: true, fire: seq === 1 }));
    a.duel.handleInput(matchId, "s2", input(seq, { turnLeft: true }));
  }
  await sleep(300);

  await a.duel.beginDrain();
  assert.equal(a.duel.matchCount, 0);
  assert.ok(a.emits.some((emit) => emit.event === "match:migrating"));
  const lease = await store.getLease(matchId);
  assert.equal(lease?.state, "handoff");
  const finalSnapshot = await store.readSnapshot(matchId);
  assert.ok(finalSnapshot);
  const finalState = finalSnapshot.state as any;
  assert.equal(finalState.phase, "active");
  assert.ok(finalState.players[0].state.x !== -1600 || finalState.players[0].state.vx !== 0);

  const b = createReplica(store, "replica-b");
  await claimAll(store, "replica-b", b);
  const restored = b.duel.snapshotFor(matchId);
  assert.ok(restored);
  const restoredState = restored.state as any;
  assert.equal(restored.fence.epoch, lease!.epoch + 1);
  assert.deepEqual(restoredState.players, finalState.players, "players restored exactly");
  assert.deepEqual(restoredState.world, finalState.world, "world restored exactly");
  assert.deepEqual(restoredState.bullets, finalState.bullets);
  assert.equal(restoredState.randomState, finalState.randomState);
  assert.deepEqual(restoredState.counters, finalState.counters);
  assert.deepEqual(restoredState.spawnDelaysMs, finalState.spawnDelaysMs);

  // Wrong token is refused; right tokens re-attach on new sockets.
  assert.equal(b.duel.attach(matchId, "not-a-token", "x", "replica-b").status, "unknown");
  assert.equal(
    b.duel.attach(matchId, found.get("s1").resumeToken, "s1b", "replica-b").status,
    "resumed",
  );
  await sleep(200);
  assert.equal((b.duel.snapshotFor(matchId)!.state as any).phase, "countdown", "waits for both");
  assert.equal(
    b.duel.attach(matchId, found.get("s2").resumeToken, "s2b", "replica-b").status,
    "resumed",
  );
  const resumed = b.emits.find((emit) => emit.event === "match:resumed" && emit.target === "s1b");
  assert.deepEqual(
    resumed?.payload.snapshot.players.map((player: any) => [
      player.x,
      player.y,
      player.health,
      player.ammo,
    ]),
    finalState.players.map((player: any) => [
      player.state.x,
      player.state.y,
      player.state.health,
      player.state.ammo,
    ]),
  );

  await sleep(3300); // resume countdown
  const live = b.duel.snapshotFor(matchId)!.state as any;
  assert.equal(live.phase, "active");
  b.duel.handleInput(matchId, "s1b", input(31, { thrust: true }));
  await sleep(100);
  const moved = b.duel.snapshotFor(matchId)!.state as any;
  assert.ok(moved.sequence > live.sequence, "the new owner simulates");
});

test("a player who does not come back forfeits after the grace period", async () => {
  const store = new MemoryCoordinationStore();
  const a = createReplica(store, "replica-a");
  await a.duel.createMatch([ticket("s1"), ticket("s2")]);
  const found = foundPayloads(a.emits, "match:found");
  const matchId: string = found.get("s1").matchId;
  await a.duel.beginDrain();

  const b = createReplica(store, "replica-b");
  await claimAll(store, "replica-b", b);
  b.duel.attach(matchId, found.get("s2").resumeToken, "s2b", "replica-b");
  await sleep(1800); // grace is 1.5 s in tests
  assert.equal(b.duel.hasMatch(matchId), false);
  const ended = b.emits.find((emit) => emit.event === "match:ended" && emit.target === "s2b");
  assert.equal(ended?.payload.reason, "opponent-left");
  assert.equal(ended?.payload.outcome, "win");
  assert.equal((await store.getLease(matchId))?.state, "finished");
});

test("nobody returning ends the match uncounted", async () => {
  const store = new MemoryCoordinationStore();
  const a = createReplica(store, "replica-a");
  await a.duel.createMatch([ticket("s1"), ticket("s2")]);
  const matchId: string = foundPayloads(a.emits, "match:found").get("s1").matchId;
  await a.duel.beginDrain();
  const b = createReplica(store, "replica-b");
  await claimAll(store, "replica-b", b);
  await sleep(1800);
  assert.equal(b.duel.hasMatch(matchId), false);
  assert.equal((await store.getLease(matchId))?.state, "finished");
});

test("a battle royale resumes with eliminations and placements intact", async () => {
  const store = new MemoryCoordinationStore();
  const a = createReplica(store, "replica-a");
  await a.battleRoyale.createMatch([
    ticket("b1", "battle-royale"),
    ticket("b2", "battle-royale"),
    ticket("b3", "battle-royale"),
  ]);
  const found = foundPayloads(a.emits, "br:match-found");
  const matchId: string = found.get("b1").matchId;
  // b3 leaves on purpose: eliminated in 3rd place.
  a.battleRoyale.handleDetach(matchId, "b3", true);
  await sleep(4300); // countdown
  a.battleRoyale.handleInput(matchId, "b1", input(1, { thrust: true }));
  await sleep(200);
  await a.battleRoyale.beginDrain();
  const finalState = (await store.readSnapshot(matchId))!.state as any;
  assert.equal(finalState.players[2].eliminated, true);
  assert.equal(finalState.players[2].eliminationPlacement, 3);

  const b = createReplica(store, "replica-b");
  await claimAll(store, "replica-b", b);
  const restoredState = b.battleRoyale.snapshotFor(matchId)!.state as any;
  assert.deepEqual(restoredState.players, finalState.players);
  assert.deepEqual(restoredState.world, finalState.world);
  assert.equal(restoredState.eliminationsSoFar, 1);
  b.battleRoyale.attach(matchId, found.get("b1").resumeToken, "b1b", "replica-b");
  b.battleRoyale.attach(matchId, found.get("b2").resumeToken, "b2b", "replica-b");
  await sleep(3300);
  assert.equal((b.battleRoyale.snapshotFor(matchId)!.state as any).phase, "active");
});

test("an invalid snapshot is refused", async () => {
  const store = new MemoryCoordinationStore();
  const b = createReplica(store, "replica-b");
  const fence = { epoch: 2, matchId: "match-broken", owner: "replica-b" };
  assert.equal(b.duel.restore(fence, null), false);
  assert.equal(
    b.duel.restore(fence, {
      epoch: 1,
      matchId: "match-broken",
      sequence: 1,
      state: { version: 1, players: "nope" },
      writtenAt: Date.now(),
    }),
    false,
  );
});
