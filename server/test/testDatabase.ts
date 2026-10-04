import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { runMigrations } from "../src/db/runMigrations";

/**
 * Creates a fresh, migrated database on the server named by
 * TEST_DATABASE_URL and points DATABASE_URL at it. Returns null when
 * TEST_DATABASE_URL is unset, so database tests can be skipped.
 */
export const createTestDatabase = async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return null;
  const name = `asteroid_test_${randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  process.env.DATABASE_URL = url.toString();
  return {
    url: url.toString(),
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
};
