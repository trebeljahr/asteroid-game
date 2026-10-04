import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let database: Database | null = null;

/**
 * Lazy database accessor. Returns null if DATABASE_URL isn't set —
 * callers should treat the database as optional and degrade
 * gracefully (e.g. return empty achievement lists, skip stat writes).
 *
 * This lets the dev server run without postgres if someone just wants
 * to hack on the client.
 */
export const getDatabase = (): Database | null => {
  if (database !== null) {
    return database;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  pool = new Pool({
    connectionString,
    // Small pool is plenty for this workload — most writes come from
    // infrequent match-end events, not per-tick.
    max: 8,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (error) => {
    console.error("[db] idle client error", error);
  });

  database = drizzle(pool, { schema });
  console.log("[db] Postgres pool initialized");
  return database;
};

/**
 * Raw pool for coordination queries that need explicit row locks and
 * array parameters. Null when DATABASE_URL is unset.
 */
export const getPool = (): Pool | null => {
  getDatabase();
  return pool;
};

export const closeDatabase = async () => {
  if (pool !== null) {
    await pool.end();
    pool = null;
    database = null;
  }
};

export * from "./schema";
