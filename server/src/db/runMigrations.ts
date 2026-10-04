/**
 * Standalone migration runner. Invoked via `pnpm db:migrate`
 * manually or by the server at startup before accepting connections.
 *
 * Migrations live alongside the source at `src/db/migrations` during
 * development. The build pipeline copies them into `dist/db/migrations`
 * so the compiled server can find them too.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATION_LOCK_KEY = 7_301_026;

export const runMigrations = async (connectionString?: string) => {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must be set to run migrations. Aborting migration run.");
  }

  const pool = new Pool({ connectionString: url, max: 2 });
  const migrationsFolder = resolveMigrationsFolder();

  // During a rolling deploy two replicas can start at the same time.
  // A session advisory lock makes them apply migrations one after the other.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    console.log(`[db] Running migrations from ${migrationsFolder}`);
    await migrate(drizzle(client), { migrationsFolder });
    console.log("[db] Migrations complete");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
};

const resolveMigrationsFolder = () => {
  // When running via tsx from src, __dirname is server/src/db.
  // When running the compiled JS from dist, it's dist/server/src/db
  // (because rootDir=".." in tsconfig) — same relative "migrations"
  // folder either way, provided the build pipeline copies it.
  const adjacent = path.join(__dirname, "migrations");
  if (existsSync(adjacent)) {
    return adjacent;
  }
  // Fallback for misconfigured environments — fall back to src.
  const sourceFallback = path.resolve(__dirname, "..", "..", "src", "db", "migrations");
  return sourceFallback;
};

const isDirectInvocation = () => {
  try {
    return require.main === module;
  } catch (_error) {
    return false;
  }
};

if (isDirectInvocation()) {
  runMigrations().catch((error) => {
    console.error("[db] Migration failed:", error);
    process.exit(1);
  });
}
