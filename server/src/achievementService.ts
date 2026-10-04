import { EventEmitter } from "node:events";
import { eq, sql } from "drizzle-orm";

import {
  ACHIEVEMENT_DEFINITIONS,
  type AchievementEvent,
  type AchievementStats,
  type PublicAchievement,
  toPublicAchievement,
} from "../../shared/src";
import {
  type Database,
  getDatabase,
  matchResults,
  type UserStats,
  userAchievements,
  userStats,
} from "./db";

const toAchievementStats = (row: UserStats): AchievementStats => {
  return {
    runAttempts: row.runAttempts,
    runCompletions: row.runCompletions,
    runBestTimeMs: row.runBestTimeMs ?? null,
    multiplayerWins: row.multiplayerWins,
    multiplayerLosses: row.multiplayerLosses,
    multiplayerDraws: row.multiplayerDraws,
    brMatches: row.brMatches,
    brWins: row.brWins,
    brTopThree: row.brTopThree,
    asteroidsDestroyed: row.asteroidsDestroyed,
    bulletsFired: row.bulletsFired,
    heartsCollected: row.heartsCollected,
    ammoCollected: row.ammoCollected,
    goalsCleared: row.goalsCleared,
    opponentsEliminated: row.opponentsEliminated,
  };
};

/**
 * Partial set of stat deltas to apply atomically. Only the keys the
 * caller wants to bump are provided; everything else is left alone.
 */
export type StatDelta = Partial<{
  runAttempts: number;
  runCompletions: number;
  runBestTimeMs: number | null; // overwrite if lower (handled by caller)
  multiplayerWins: number;
  multiplayerLosses: number;
  multiplayerDraws: number;
  brMatches: number;
  brWins: number;
  brTopThree: number;
  asteroidsDestroyed: number;
  bulletsFired: number;
  heartsCollected: number;
  ammoCollected: number;
  goalsCleared: number;
  opponentsEliminated: number;
}>;

/** One counted player in a finished match. */
export interface MatchResultEntry {
  delta: StatDelta;
  event: AchievementEvent;
  outcome: string;
  userId: string;
}

/** The lease a result write is fenced on. */
export interface ResultFence {
  epoch: number;
  matchId: string;
  owner: string;
}

export type MatchResultOutcome = "applied" | "fenced" | "no-database";

type Executor = Pick<Database, "execute" | "insert" | "update">;

export interface AchievementUnlockEvent {
  userId: string;
  achievementId: string;
  unlockedAt: Date;
}

/**
 * Per-user lock so concurrent events from the same user can't collide
 * in the evaluator (double unlock, lost stat update).
 */
class UserLock {
  private queues = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Store even failures so the chain doesn't break; clean up when done.
    const cleanup = next.finally(() => {
      if (this.queues.get(key) === cleanup) {
        this.queues.delete(key);
      }
    });
    this.queues.set(key, cleanup);
    return next;
  }
}

export class AchievementService extends EventEmitter {
  private locks = new UserLock();

  /**
   * Listen for achievement unlocks. Emitted once per new unlock.
   */
  onUnlock(listener: (event: AchievementUnlockEvent) => void) {
    this.on("unlock", listener);
    return () => {
      this.off("unlock", listener);
    };
  }

  /**
   * Primary entry point used by game code. Applies a set of stat
   * deltas and then re-evaluates every achievement against the new
   * stats. Optionally dispatches an event the achievement predicates
   * can inspect (e.g. "run.completed" carries durationMs).
   */
  async applyEvent(
    userId: string,
    delta: StatDelta,
    event?: AchievementEvent,
  ): Promise<AchievementUnlockEvent[]> {
    const db = getDatabase();
    if (db === null) {
      return [];
    }

    return this.locks.run(userId, async () => {
      const stats = await this.applyStatDelta(userId, delta);
      if (stats === null) {
        return [];
      }
      return this.evaluateUnlocks(userId, stats, event);
    });
  }

  /**
   * Record a finished match exactly once. In one transaction: check the
   * lease fence (current epoch and owner, not yet finished), insert one
   * `match_results` receipt per player, increment stats only for
   * receipts that were new, and mark the lease finished. Replaying the
   * same finish, or a stale owner writing after a handoff, changes no
   * stats.
   */
  async applyMatchResults(
    matchId: string,
    fence: ResultFence | null,
    results: MatchResultEntry[],
  ): Promise<MatchResultOutcome> {
    const db = getDatabase();
    if (db === null) {
      return "no-database";
    }

    const counted: Array<{ entry: MatchResultEntry; stats: AchievementStats }> = [];
    const fenced = await db.transaction(async (tx) => {
      if (fence !== null) {
        const lease = await tx.execute(sql`
          SELECT 1 FROM match_leases
          WHERE match_id = ${matchId} AND epoch = ${fence.epoch}
            AND owner_replica = ${fence.owner} AND state <> 'finished'
          FOR UPDATE`);
        if (lease.rows.length === 0) {
          return true;
        }
      }

      for (const entry of results) {
        const receipt = await tx
          .insert(matchResults)
          .values({ matchId, userId: entry.userId, outcome: entry.outcome })
          .onConflictDoNothing()
          .returning({ userId: matchResults.userId });
        if (receipt.length === 0) {
          continue;
        }
        const stats = await this.applyStatDelta(entry.userId, entry.delta, tx);
        if (stats !== null) {
          counted.push({ entry, stats });
        }
      }

      if (fence !== null) {
        await tx.execute(sql`
          UPDATE match_leases SET state = 'finished', updated_at = now()
          WHERE match_id = ${matchId} AND epoch = ${fence.epoch}`);
        await tx.execute(sql`DELETE FROM match_snapshots WHERE match_id = ${matchId}`);
      }
      return false;
    });

    if (fenced) {
      return "fenced";
    }

    for (const { entry, stats } of counted) {
      void this.locks
        .run(entry.userId, () => this.evaluateUnlocks(entry.userId, stats, entry.event))
        .catch((error) => {
          console.error("[achievements] unlock evaluation failed", error);
        });
    }
    return "applied";
  }

  /**
   * Fetch every achievement definition, enriched with the user's
   * unlock state and current progress.
   */
  async listForUser(
    userId: string,
  ): Promise<Array<PublicAchievement & { unlockedAt: Date | null; progressValue: number }>> {
    const db = getDatabase();
    if (db === null) {
      return ACHIEVEMENT_DEFINITIONS.map((definition) => ({
        ...toPublicAchievement(definition),
        unlockedAt: null,
        progressValue: 0,
      }));
    }

    const [statsRow, unlockRows] = await Promise.all([
      db.select().from(userStats).where(eq(userStats.userId, userId)).limit(1),
      db.select().from(userAchievements).where(eq(userAchievements.userId, userId)),
    ]);

    const stats = statsRow.length === 0 ? this.emptyStats() : toAchievementStats(statsRow[0]);
    const unlockedMap = new Map(unlockRows.map((row) => [row.achievementId, row.unlockedAt]));

    return ACHIEVEMENT_DEFINITIONS.map((definition) => {
      const unlockedAt = unlockedMap.get(definition.id) ?? null;
      let progressValue = 0;
      if (definition.progress !== undefined) {
        const value = stats[definition.progress.statKey];
        // Progress is always a number counter. If the stat happens to
        // be nullable (e.g. runBestTimeMs), treat null as 0.
        progressValue = typeof value === "number" ? value : 0;
      } else if (unlockedAt !== null) {
        progressValue = 1;
      }
      return {
        ...toPublicAchievement(definition),
        unlockedAt,
        progressValue,
      };
    });
  }

  private emptyStats(): AchievementStats {
    return {
      runAttempts: 0,
      runCompletions: 0,
      runBestTimeMs: null,
      multiplayerWins: 0,
      multiplayerLosses: 0,
      multiplayerDraws: 0,
      brMatches: 0,
      brWins: 0,
      brTopThree: 0,
      asteroidsDestroyed: 0,
      bulletsFired: 0,
      heartsCollected: 0,
      ammoCollected: 0,
      goalsCleared: 0,
      opponentsEliminated: 0,
    };
  }

  /**
   * Apply a set of stat deltas atomically. Integer fields are
   * incremented; runBestTimeMs is overwritten if the incoming value
   * is strictly lower than the existing one (or if no record exists).
   *
   * Returns the post-update AchievementStats view (or null if the
   * user has no stat row and can't be created, which shouldn't
   * happen in practice).
   */
  private async applyStatDelta(
    userId: string,
    delta: StatDelta,
    executor?: Executor,
  ): Promise<AchievementStats | null> {
    const db = executor ?? getDatabase();
    if (db === null) return null;

    const setClauses: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };

    const increments: Array<[keyof StatDelta, number]> = [];
    for (const [key, value] of Object.entries(delta) as Array<[keyof StatDelta, unknown]>) {
      if (key === "runBestTimeMs") continue;
      if (typeof value === "number" && value !== 0) {
        increments.push([key, value]);
      }
    }

    for (const [key, value] of increments) {
      setClauses[key] = sql`${userStats[key as keyof typeof userStats]} + ${value}`;
    }

    // runBestTimeMs uses "lowest wins" semantics — the incoming time
    // replaces the stored one only if it's lower or not yet set.
    if (
      delta.runBestTimeMs !== undefined &&
      delta.runBestTimeMs !== null &&
      Number.isFinite(delta.runBestTimeMs)
    ) {
      setClauses.runBestTimeMs = sql`CASE
        WHEN ${userStats.runBestTimeMs} IS NULL OR ${userStats.runBestTimeMs} > ${delta.runBestTimeMs}
          THEN ${delta.runBestTimeMs}
        ELSE ${userStats.runBestTimeMs}
      END`;
    }

    const updated = await db
      .update(userStats)
      .set(setClauses)
      .where(eq(userStats.userId, userId))
      .returning();

    if (updated.length === 0) {
      // No row yet (shouldn't happen post-bootstrap, but handle it).
      return null;
    }

    return toAchievementStats(updated[0]);
  }

  private async evaluateUnlocks(
    userId: string,
    stats: AchievementStats,
    event: AchievementEvent | undefined,
  ): Promise<AchievementUnlockEvent[]> {
    const db = getDatabase();
    if (db === null) return [];

    // Find which achievements are already unlocked for this user so
    // we don't re-insert and re-emit.
    const unlockedRows = await db
      .select({ achievementId: userAchievements.achievementId })
      .from(userAchievements)
      .where(eq(userAchievements.userId, userId));
    const alreadyUnlocked = new Set(unlockedRows.map((row) => row.achievementId));

    const newlyUnlocked: AchievementUnlockEvent[] = [];

    for (const definition of ACHIEVEMENT_DEFINITIONS) {
      if (alreadyUnlocked.has(definition.id)) continue;
      let unlocked = false;
      try {
        unlocked = definition.check(stats, event);
      } catch (error) {
        console.error(`[achievements] check threw for ${definition.id}`, error);
      }
      if (!unlocked) continue;

      const now = new Date();
      // ON CONFLICT DO NOTHING handles the rare collision where the
      // same unlock is attempted twice (different events arriving in
      // parallel) — even with our per-user lock it's a cheap guard.
      const inserted = await db
        .insert(userAchievements)
        .values({
          userId,
          achievementId: definition.id,
          unlockedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        continue;
      }
      newlyUnlocked.push({
        userId,
        achievementId: definition.id,
        unlockedAt: now,
      });
    }

    for (const unlock of newlyUnlocked) {
      this.emit("unlock", unlock);
    }
    return newlyUnlocked;
  }
}

// Singleton, wired into the server at startup.
export const achievementService = new AchievementService();
