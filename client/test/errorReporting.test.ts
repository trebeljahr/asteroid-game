import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ErrorEvent } from "@sentry/browser";

import { scrubText, stripUrl } from "../../shared/src/errorScrub";
import { createErrorReporter } from "../src/errorReporting/reporter";
import { scrubEvent } from "../src/errorReporting/scrub";
import type * as Sdk from "../src/errorReporting/sdk";

describe("stripUrl", () => {
  it("drops the query string, the fragment and credentials", () => {
    assert.equal(
      stripUrl("https://asteroids.trebeljahr.com/socket.io/?EIO=4&transport=polling&sid=abc"),
      "https://asteroids.trebeljahr.com/socket.io/",
    );
    assert.equal(stripUrl("/trpc/user.bootstrap?batch=1#x"), "/trpc/user.bootstrap");
    assert.equal(stripUrl("https://user:secret@example.com/a"), "https://example.com/a");
  });
});

describe("scrubText", () => {
  it("strips queries from URLs and paths inside a message", () => {
    assert.equal(
      scrubText(
        'fetch failed: https://asteroids.trebeljahr.com/trpc/user.rename?input={"name":"x"} (500)',
      ),
      "fetch failed: https://asteroids.trebeljahr.com/trpc/user.rename (500)",
    );
    assert.equal(scrubText("redirect to /play?token=abc failed"), "redirect to /play failed");
  });

  it("replaces emails, bearer tokens and id-like tokens", () => {
    assert.equal(scrubText("no account for jane@example.com"), "no account for [email]");
    assert.equal(
      scrubText("Authorization: Bearer abc.DEF-123"),
      "Authorization: Bearer [redacted]",
    );
    assert.equal(
      scrubText("device 3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b not found"),
      "device [token] not found",
    );
    assert.equal(scrubText("user 0123456789abcdef0123456789abcdef"), "user [token]");
    assert.equal(scrubText("resume Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg"), "resume [token]");
  });

  it("removes the values of a failed drizzle query", () => {
    assert.equal(
      scrubText(
        'Failed query: select "id" from "users" where "device_token" = $1\nparams: s3cr3t-token',
      ),
      'Failed query: select "id" from "users" where "device_token" = $1\nparams: [redacted]',
    );
  });

  it("leaves ordinary messages alone", () => {
    const message = "Cannot read properties of undefined (reading 'position')";
    assert.equal(scrubText(message), message);
    assert.equal(
      scrubText("Failed to load /_assets/index-DkF3a9xY.js"),
      "Failed to load /_assets/index-DkF3a9xY.js",
    );
  });
});

const baseEvent = (): ErrorEvent => ({
  type: undefined,
  event_id: "e",
  message: "join failed for jane@example.com",
  user: { id: "u1", ip_address: "203.0.113.9" },
  extra: { body: "anything" },
  server_name: "host",
  request: {
    url: "https://asteroids.trebeljahr.com/?ref=secret#frag",
    query_string: "ref=secret",
    cookies: { session: "tok" },
    data: { displayName: "Jane" },
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://example.com/?ref=secret",
      "x-device-token": "3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b",
    },
  },
  contexts: { trace: { trace_id: "t", span_id: "s" }, culture: { locale: "de-DE" } },
  exception: {
    values: [
      {
        type: "TRPCClientError",
        value: "boom at https://asteroids.trebeljahr.com/trpc/x?input=secret",
        stacktrace: {
          frames: [
            {
              filename: "https://asteroids.trebeljahr.com/_assets/index-abc.js?v=secret",
              abs_path: "https://asteroids.trebeljahr.com/_assets/index-abc.js?v=secret",
              vars: { name: "Jane" },
            },
          ],
        },
      },
    ],
  },
  breadcrumbs: [{ category: "console", message: "jane@example.com" }],
});

describe("scrubEvent", () => {
  it("keeps the error, the stack and the page URL without its query, and nothing else", () => {
    const event = scrubEvent(baseEvent());
    assert.equal(event.user, undefined);
    assert.equal(event.extra, undefined);
    assert.equal(event.server_name, undefined);
    assert.equal(event.breadcrumbs, undefined);
    assert.deepEqual(event.request, { url: "https://asteroids.trebeljahr.com/" });
    assert.deepEqual(Object.keys(event.contexts ?? {}), ["trace"]);
    assert.equal(event.message, "join failed for [email]");
    const exception = event.exception?.values?.[0];
    assert.equal(exception?.value, "boom at https://asteroids.trebeljahr.com/trpc/x");
    assert.deepEqual(exception?.stacktrace?.frames?.[0], {
      filename: "https://asteroids.trebeljahr.com/_assets/index-abc.js",
      abs_path: "https://asteroids.trebeljahr.com/_assets/index-abc.js",
    });
  });

  it("leaves no secret value anywhere in the event", () => {
    const serialized = JSON.stringify(scrubEvent(baseEvent()));
    for (const leak of ["jane@example.com", "secret", "tok", "Jane", "203.0.113.9", "Mozilla"]) {
      assert.ok(!serialized.includes(leak), `${leak} survived: ${serialized}`);
    }
    assert.ok(!serialized.includes("3f2b8c1e"), "device token survived");
  });
});

type Sentry = typeof Sdk;

const fakeSdk = () => {
  const inits: Array<Record<string, unknown>> = [];
  const captures: unknown[][] = [];
  const integration = (name: string) => () => ({ name });
  const sdk = {
    init: (options: Record<string, unknown>) => {
      inits.push(options);
    },
    captureException: (...args: unknown[]) => {
      captures.push(args);
    },
    eventFiltersIntegration: integration("EventFilters"),
    functionToStringIntegration: integration("FunctionToString"),
    browserApiErrorsIntegration: integration("BrowserApiErrors"),
    globalHandlersIntegration: integration("GlobalHandlers"),
    linkedErrorsIntegration: integration("LinkedErrors"),
    dedupeIntegration: integration("Dedupe"),
    httpContextIntegration: integration("HttpContext"),
  } as unknown as Sentry;
  return { sdk, inits, captures };
};

const errorEvent = (error: unknown) => Object.assign(new Event("error"), { error });

describe("createErrorReporter", () => {
  it("does nothing without a DSN, and never loads the SDK", async () => {
    let loads = 0;
    const target = new EventTarget();
    const start = createErrorReporter({
      dsn: "",
      load: async () => {
        loads += 1;
        return fakeSdk().sdk;
      },
      release: "asteroid-game@1.0.0+abc",
      environment: "production",
      target,
    });
    assert.equal(await start(), false);
    assert.equal(loads, 0);
  });

  it("loads once and starts without tracing, sessions, breadcrumbs or default integrations", async () => {
    const { sdk, inits } = fakeSdk();
    let loads = 0;
    const start = createErrorReporter({
      dsn: "https://key@glitchtip.example.com/1",
      load: async () => {
        loads += 1;
        return sdk;
      },
      release: "asteroid-game@1.0.0+abc",
      environment: "production",
      target: new EventTarget(),
    });
    assert.deepEqual(await Promise.all([start(), start()]), [true, true]);
    assert.equal(loads, 1);
    assert.equal(inits.length, 1);
    const config = inits[0] ?? {};
    assert.equal(config.sendDefaultPii, false);
    assert.equal(config.defaultIntegrations, false);
    assert.equal(config.maxBreadcrumbs, 0);
    assert.equal(config.release, "asteroid-game@1.0.0+abc");
    assert.deepEqual(config.initialScope, { tags: { platform: "web" } });
    assert.ok(!("tracesSampleRate" in config));
    const names = (config.integrations as Array<{ name: string }>).map((i) => i.name);
    for (const absent of ["BrowserSession", "BrowserTracing", "Replay", "Breadcrumbs"]) {
      assert.ok(!names.includes(absent), `${absent} is on`);
    }
  });

  it("reports the errors thrown while the SDK loads, then leaves it to the SDK", async () => {
    const { sdk, captures } = fakeSdk();
    let resolve: (value: Sentry) => void = () => undefined;
    const target = new EventTarget();
    const start = createErrorReporter({
      dsn: "https://k@h/1",
      load: () => new Promise((r) => (resolve = r)),
      release: undefined,
      environment: "production",
      target,
    });
    const started = start();
    const early = new Error("setup failed");
    target.dispatchEvent(errorEvent(early));
    const rejection = Object.assign(new Event("unhandledrejection"), { reason: "nope" });
    target.dispatchEvent(rejection);
    assert.equal(captures.length, 0);

    resolve(sdk);
    await started;
    assert.deepEqual(captures, [
      [early, { tags: { source: "before-sdk" } }],
      ["nope", { tags: { source: "before-sdk" } }],
    ]);

    target.dispatchEvent(errorEvent(new Error("later")));
    assert.equal(captures.length, 2);
  });

  it("gives up quietly when the SDK chunk cannot load", async () => {
    const start = createErrorReporter({
      dsn: "https://k@h/1",
      load: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
      release: undefined,
      environment: "production",
      target: new EventTarget(),
    });
    assert.equal(await start(), false);
  });
});
