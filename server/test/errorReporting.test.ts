import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ErrorEvent } from "@sentry/node";

import { scrubServerEvent } from "../src/errorScrub";
import { errorReportingEnabled, releaseName, reportTrpcError } from "../src/instrument";

describe("server error reporting", () => {
  it("is off without SENTRY_DSN", () => {
    assert.equal(process.env.SENTRY_DSN ?? "", "");
    assert.equal(errorReportingEnabled, false);
    // A no-op, not a throw, while off.
    reportTrpcError({
      error: { code: "INTERNAL_SERVER_ERROR" },
      path: "user.bootstrap",
      type: "mutation",
    });
  });

  it("names the release like the client does", () => {
    assert.equal(releaseName("1.0.0", "0123456789abcdef0123"), "asteroid-game@1.0.0+0123456789ab");
    assert.equal(releaseName("1.0.0", ""), "asteroid-game@1.0.0");
  });

  it("drops the person, the request but its method and bare URL, and secret values in messages", () => {
    const token = "3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b";
    const event: ErrorEvent = {
      type: undefined,
      user: { id: "u1" },
      extra: { input: { displayName: "Jane" } },
      breadcrumbs: [{ category: "console", message: token }],
      request: {
        method: "POST",
        url: "https://asteroids.trebeljahr.com/trpc/user.bootstrap?batch=1",
        headers: { "x-device-token": token },
        data: '{"displayName":"Jane"}',
      },
      exception: {
        values: [
          {
            type: "DrizzleQueryError",
            value: `Failed query: select * from "users" where "device_token" = $1\nparams: ${token}`,
            stacktrace: { frames: [{ filename: "/app/server/dist/x.js", vars: { token } }] },
          },
        ],
      },
    };
    const scrubbed = scrubServerEvent(event);
    assert.deepEqual(scrubbed.request, {
      method: "POST",
      url: "https://asteroids.trebeljahr.com/trpc/user.bootstrap",
    });
    const serialized = JSON.stringify(scrubbed);
    for (const leak of [token, "Jane", "u1"]) {
      assert.ok(!serialized.includes(leak), `${leak} survived: ${serialized}`);
    }
    assert.match(serialized, /params: \[redacted\]/);
  });
});
