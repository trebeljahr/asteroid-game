import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import type { AchievementService } from "../src/achievementService";
import { closeDatabase, getDatabase, users } from "../src/db";
import { createAppRouter } from "../src/trpc/router";
import { createTestDatabase } from "./testDatabase";

const skip = process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL not set";

// setDisplayName touches neither service.
const router = createAppRouter(
  { getRuntimeConfig: () => assert.fail("not used") },
  {} as AchievementService,
);
const callerFor = (deviceToken: string) => router.createCaller({ deviceToken });

const rejectsAsBadRequest = (promise: Promise<unknown>) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof TRPCError);
    assert.equal(error.code, "BAD_REQUEST");
    return true;
  });

describe("user.setDisplayName", () => {
  // Validation runs before the procedure reads the database, so these
  // need no Postgres.
  it("rejects a whitespace-only name as BAD_REQUEST", async () => {
    await rejectsAsBadRequest(callerFor("device-blank").user.setDisplayName({ displayName: " " }));
    await rejectsAsBadRequest(
      callerFor("device-blank").user.setDisplayName({ displayName: " \t\n " }),
    );
  });

  it("rejects a name over 32 characters as BAD_REQUEST", async () => {
    await rejectsAsBadRequest(
      callerFor("device-long").user.setDisplayName({ displayName: "x".repeat(33) }),
    );
  });

  describe("with a database", () => {
    let database: Awaited<ReturnType<typeof createTestDatabase>> = null;
    before(async () => {
      if (!skip) database = await createTestDatabase();
    });
    after(async () => {
      await closeDatabase();
      await database?.drop();
    });

    it("stores the name without surrounding whitespace", { skip }, async () => {
      const result = await callerFor("device-trim").user.setDisplayName({
        displayName: `  ${"y".repeat(32)}  `,
      });
      assert.deepEqual(result, { ok: true });
      const rows = await getDatabase()!
        .select()
        .from(users)
        .where(eq(users.deviceToken, "device-trim"));
      assert.equal(rows[0].displayName, "y".repeat(32));
    });
  });
});
