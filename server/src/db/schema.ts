import { sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Every player gets a server-side account keyed by a persistent
 * device token stored in the client's localStorage. Email/password is
 * optional and only used later if/when a player "claims" the account
 * for cross-device sync. When the game ships on Steam, the Steam ID
 * can be recorded here alongside (or instead of) the device token.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceToken: text("device_token").notNull().unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(sql`now()`),
});

/**
 * Aggregate counters per user. These feed most cumulative
 * achievements ("destroy 100 asteroids") so the achievement engine
 * can check progress with a single row lookup.
 */
export const userStats = pgTable("user_stats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  runAttempts: integer("run_attempts").notNull().default(0),
  runCompletions: integer("run_completions").notNull().default(0),
  runBestTimeMs: integer("run_best_time_ms"),
  multiplayerWins: integer("multiplayer_wins").notNull().default(0),
  multiplayerLosses: integer("multiplayer_losses").notNull().default(0),
  multiplayerDraws: integer("multiplayer_draws").notNull().default(0),
  brMatches: integer("br_matches").notNull().default(0),
  brWins: integer("br_wins").notNull().default(0),
  brTopThree: integer("br_top_three").notNull().default(0),
  asteroidsDestroyed: integer("asteroids_destroyed").notNull().default(0),
  bulletsFired: integer("bullets_fired").notNull().default(0),
  heartsCollected: integer("hearts_collected").notNull().default(0),
  ammoCollected: integer("ammo_collected").notNull().default(0),
  goalsCleared: integer("goals_cleared").notNull().default(0),
  opponentsEliminated: integer("opponents_eliminated").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});

/**
 * Unlock records for one-shot achievements. For cumulative ones that
 * show progress, the progress is computed from userStats on demand.
 */
export const userAchievements = pgTable(
  "user_achievements",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    achievementId: text("achievement_id").notNull(),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.userId, table.achievementId] }),
    };
  },
);

/**
 * One receipt per counted player per match. The receipt is inserted in
 * the same transaction as the user_stats increments, so replaying a
 * match finish (retry, handoff, duplicate owner) changes stats once.
 */
export const matchResults = pgTable(
  "match_results",
  {
    matchId: text("match_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    outcome: text("outcome").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.matchId, table.userId] }),
    };
  },
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserStats = typeof userStats.$inferSelect;
export type UserAchievement = typeof userAchievements.$inferSelect;
