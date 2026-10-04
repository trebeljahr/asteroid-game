import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

import { achievementService, type MatchResultEntry } from "../src/achievementService";
import { closeDatabase, getDatabase, getPool, matchResults, userStats } from "../src/db";
import { PostgresCoordinationStore } from "../src/realtime/store";
import { getOrCreateUserByDeviceToken } from "../src/userService";
import { createTestDatabase } from "./testDatabase";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const skip = process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL not set";

let database: Awaited<ReturnType<typeof createTestDatabase>> = null;
before(async () => {
  if (!skip) database = await createTestDatabase();
});
after(async () => {
  await sleep(200); // let background unlock evaluation finish
  await closeDatabase();
  await database?.drop();
});

const duelResults = (winnerId: string, loserId: string): MatchResultEntry[] => [
  {
    delta: { multiplayerWins: 1, opponentsEliminated: 1 },
    event: { type: "mp.matchEnded", outcome: "win" },
    outcome: "win",
    userId: winnerId,
  },
  {
    delta: { multiplayerLosses: 1 },
    event: { type: "mp.matchEnded", outcome: "loss" },
    outcome: "loss",
    userId: loserId,
  },
];

const statsOf = async (userId: string) => {
  const rows = await getDatabase()!.select().from(userStats).where(eq(userStats.userId, userId));
  return { wins: rows[0].multiplayerWins, losses: rows[0].multiplayerLosses };
};

const receiptsFor = async (matchId: string) => {
  return getDatabase()!.select().from(matchResults).where(eq(matchResults.matchId, matchId));
};

test("replaying a match finish twice changes stats once", { skip }, async () => {
  const winner = (await getOrCreateUserByDeviceToken("device-winner-replay")).user.id;
  const loser = (await getOrCreateUserByDeviceToken("device-loser-replay")).user.id;
  const store = new PostgresCoordinationStore(getPool()!);
  const fence = await store.createLease("match-replay", "duel", "replica-a");

  assert.equal(
    await achievementService.applyMatchResults("match-replay", fence, duelResults(winner, loser)),
    "applied",
  );
  // Same owner retries (for example after a timeout it could not observe).
  assert.equal(
    await achievementService.applyMatchResults("match-replay", fence, duelResults(winner, loser)),
    "fenced",
  );
  // Unfenced replay (no lease involved): the receipts alone stop it.
  assert.equal(
    await achievementService.applyMatchResults("match-replay", null, duelResults(winner, loser)),
    "applied",
  );

  assert.deepEqual(await statsOf(winner), { wins: 1, losses: 0 });
  assert.deepEqual(await statsOf(loser), { wins: 0, losses: 1 });
  assert.equal((await receiptsFor("match-replay")).length, 2);
  assert.equal((await store.getLease("match-replay"))?.state, "finished");
});

test("a stale owner cannot record a result after a handoff", { skip }, async () => {
  const winner = (await getOrCreateUserByDeviceToken("device-winner-stale")).user.id;
  const loser = (await getOrCreateUserByDeviceToken("device-loser-stale")).user.id;
  const store = new PostgresCoordinationStore(getPool()!);
  const oldFence = await store.createLease("match-stale", "duel", "replica-a");
  await store.writeSnapshot(oldFence, 5, { tick: 5 }, { handoff: true });
  const newFence = await store.claimLease("match-stale", oldFence.epoch, "replica-b");
  assert.ok(newFence);

  assert.equal(
    await achievementService.applyMatchResults("match-stale", oldFence, duelResults(winner, loser)),
    "fenced",
  );
  assert.deepEqual(await statsOf(winner), { wins: 0, losses: 0 });
  assert.equal((await receiptsFor("match-stale")).length, 0);

  assert.equal(
    await achievementService.applyMatchResults("match-stale", newFence, duelResults(winner, loser)),
    "applied",
  );
  assert.deepEqual(await statsOf(winner), { wins: 1, losses: 0 });
  assert.deepEqual(await statsOf(loser), { wins: 0, losses: 1 });
});
