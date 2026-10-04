import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";

import {
  type CoordinationStore,
  MemoryCoordinationStore,
  PostgresCoordinationStore,
} from "../src/realtime/store";
import { createTestDatabase } from "./testDatabase";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The lease TTL comes from MATCH_LEASE_TTL_MS; tests use a short one.
const TTL_MS = Number(process.env.MATCH_LEASE_TTL_MS);
assert.ok(TTL_MS > 0 && TTL_MS <= 1500, "run with MATCH_LEASE_TTL_MS<=1500 (see package.json)");

const ticket = (socketId: string, replicaId = "replica-a") => {
  return {
    mode: "duel" as const,
    replicaId,
    shipVariant: "orbit-dart" as const,
    socketId,
    userId: null,
  };
};

const storeSuite = (name: string, makeStore: () => CoordinationStore) => {
  describe(name, () => {
    let store: CoordinationStore;
    before(() => {
      store = makeStore();
    });

    test("tickets are taken in order, atomically, only when enough are queued", async () => {
      await store.putTicket(ticket(`${name}-s1`));
      assert.deepEqual(await store.takeTickets("duel", 2, 2), []);
      assert.equal(
        (await store.listTickets("duel")).length,
        1,
        "a short take leaves tickets queued",
      );
      await store.putTicket(ticket(`${name}-s2`, "replica-b"));
      await store.putTicket(ticket(`${name}-s3`));
      const [first, second] = await Promise.all([
        store.takeTickets("duel", 2, 2),
        store.takeTickets("duel", 2, 2),
      ]);
      const taken = [...first, ...second].map((entry) => entry.socketId);
      assert.deepEqual(taken, [`${name}-s1`, `${name}-s2`], "one taker wins the oldest pair");
      assert.deepEqual(
        (await store.listTickets("duel")).map((entry) => entry.socketId),
        [`${name}-s3`],
      );
      await store.deleteTicketsForReplica("replica-a");
      assert.equal((await store.listTickets("duel")).length, 0);
    });

    test("a stale-epoch snapshot write is rejected after another replica claims the lease", async () => {
      const matchId = `${name}-match-stale`;
      const oldFence = await store.createLease(matchId, "duel", "replica-a");
      assert.equal(await store.writeSnapshot(oldFence, 10, { tick: 10 }), true);

      // The owner pauses: no renewals past the TTL.
      await sleep(TTL_MS + 300);
      const claimable = await store.listClaimable(10);
      const lease = claimable.find((row) => row.matchId === matchId);
      assert.ok(lease, "an expired active lease is claimable");
      const newFence = await store.claimLease(matchId, lease.epoch, "replica-b");
      assert.ok(newFence);
      assert.equal(newFence.epoch, oldFence.epoch + 1);
      assert.equal(
        await store.claimLease(matchId, lease.epoch, "replica-c"),
        null,
        "only one claimer wins",
      );

      // The old owner wakes up and tries to write and renew.
      assert.equal(await store.writeSnapshot(oldFence, 11, { tick: 11, stale: true }), false);
      assert.equal((await store.renewLeases([oldFence])).size, 0);
      assert.equal(await store.finishLease(oldFence), false);
      const snapshot = await store.readSnapshot(matchId);
      assert.deepEqual(snapshot?.state, { tick: 10 }, "stale write left the snapshot untouched");

      assert.equal(await store.writeSnapshot(newFence, 12, { tick: 12 }), true);
      assert.equal((await store.readSnapshot(matchId))?.epoch, newFence.epoch);
    });

    test("handoff marks the lease claimable at once and the final snapshot wins", async () => {
      const matchId = `${name}-match-handoff`;
      const fence = await store.createLease(matchId, "battle-royale", "replica-a");
      assert.equal((await store.renewLeases([fence])).has(matchId), true);
      assert.equal(await store.writeSnapshot(fence, 40, { final: true }, { handoff: true }), true);
      assert.equal((await store.getLease(matchId))?.state, "handoff");
      assert.equal(
        await store.writeSnapshot(fence, 41, { late: true }),
        false,
        "no writes after handoff",
      );
      const row = (await store.listClaimable(10)).find((entry) => entry.matchId === matchId);
      assert.ok(row);
      const claimed = await store.claimLease(matchId, row.epoch, "replica-b");
      assert.ok(claimed);
      assert.deepEqual((await store.readSnapshot(matchId))?.state, { final: true });
      assert.equal(await store.finishLease(claimed), true);
      assert.equal(await store.readSnapshot(matchId), null);
      assert.equal(
        (await store.listClaimable(10)).some((entry) => entry.matchId === matchId),
        false,
      );
    });

    test("one replica at a time owns the battle-royale lobby", async () => {
      assert.equal(await store.acquireSingleton(`${name}-lobby`, "replica-a"), true);
      assert.equal(await store.acquireSingleton(`${name}-lobby`, "replica-b"), false);
      assert.equal(await store.acquireSingleton(`${name}-lobby`, "replica-a"), true, "renew");
      await store.releaseSingleton(`${name}-lobby`, "replica-a");
      assert.equal(await store.acquireSingleton(`${name}-lobby`, "replica-b"), true);
      await sleep(TTL_MS + 300);
      assert.equal(
        await store.acquireSingleton(`${name}-lobby`, "replica-a"),
        true,
        "an expired lobby lease can be taken over",
      );
      assert.equal(
        (await store.listClaimable(50)).some((row) => row.matchId === `${name}-lobby`),
        false,
        "the lobby lease is never claimed as a match",
      );
    });
  });
};

storeSuite("memory", () => new MemoryCoordinationStore());

if (!process.env.TEST_DATABASE_URL) {
  test("postgres store", { skip: "TEST_DATABASE_URL not set" }, () => {});
} else {
  describe("postgres", () => {
    let database: Awaited<ReturnType<typeof createTestDatabase>> = null;
    let pool: Pool;
    before(async () => {
      database = await createTestDatabase();
      pool = new Pool({ connectionString: database?.url, max: 4 });
    });
    after(async () => {
      await pool.end();
      await database?.drop();
    });
    storeSuite("postgres", () => new PostgresCoordinationStore(pool));
  });
}
