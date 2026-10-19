import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

import { ERROR_TUNNEL_PATH } from "../../shared/src/errorTunnel";
import {
  createErrorTunnel,
  envelopeKey,
  MAX_ENVELOPE_BYTES,
  MAX_IN_FLIGHT,
  parseDsn,
} from "../src/errorTunnel";

const DSN = "https://0123456789abcdef0123456789abcdef@glitchtip.example.com/25";
const allowed = parseDsn(DSN);
assert.ok(allowed);

const envelope = (header: unknown, items = '{"type":"event"}\n{"message":"boom"}\n') =>
  Buffer.from(`${typeof header === "string" ? header : JSON.stringify(header)}\n${items}`);

describe("parseDsn", () => {
  it("takes a DSN apart", () => {
    assert.deepEqual(parseDsn(DSN), {
      publicKey: "0123456789abcdef0123456789abcdef",
      origin: "https://glitchtip.example.com",
      pathPrefix: "",
      projectId: "25",
    });
    assert.equal(parseDsn("https://k@example.com:8443/errors/7")?.pathPrefix, "/errors");
    assert.equal(
      parseDsn("https://k@example.com:8443/errors/7")?.origin,
      "https://example.com:8443",
    );
  });

  it("refuses anything that is not a plain DSN", () => {
    for (const bad of [
      "",
      "not a url",
      "ftp://k@example.com/1",
      "https://example.com/1",
      "https://k:secret@example.com/1",
      "https://k@example.com/project",
      "https://k@example.com/1?x=1",
      "https://k%0d%0aX-Evil:1@example.com/1",
    ]) {
      assert.equal(parseDsn(bad), null, bad);
    }
  });
});

describe("envelopeKey", () => {
  it("accepts the allowed host and project, with any public key", () => {
    assert.equal(envelopeKey(envelope({ dsn: DSN }), allowed), "0123456789abcdef0123456789abcdef");
    assert.equal(
      envelopeKey(envelope({ dsn: "https://otherkey@glitchtip.example.com/25" }), allowed),
      "otherkey",
    );
    // A header with no items after it.
    assert.equal(
      envelopeKey(Buffer.from(JSON.stringify({ dsn: DSN })), allowed),
      allowed.publicKey,
    );
  });

  it("refuses another host, project, port or scheme, and envelopes without a DSN", () => {
    for (const header of [
      { dsn: "https://k@evil.example.com/25" },
      { dsn: "https://k@glitchtip.example.com.evil.com/25" },
      { dsn: "https://k@glitchtip.example.com/26" },
      { dsn: "https://k@glitchtip.example.com/api/25" },
      { dsn: "https://k@glitchtip.example.com:8443/25" },
      { dsn: "http://k@glitchtip.example.com/25" },
      { dsn: 25 },
      { event_id: "abc" },
      null,
      "not json",
    ]) {
      assert.equal(envelopeKey(envelope(header), allowed), null, JSON.stringify(header));
    }
  });
});

describe("createErrorTunnel", () => {
  it("is off without a valid DSN", () => {
    assert.equal(createErrorTunnel(""), null);
    assert.equal(createErrorTunnel("https://glitchtip.example.com/25"), null);
  });
});

describe("the tunnel route", () => {
  interface Forwarded {
    url: string;
    headers: Record<string, string>;
    body: Buffer;
  }
  const forwarded: Forwarded[] = [];
  let answer: () => Promise<Response> = async () =>
    new Response('{"id":"abc"}', {
      status: 200,
      headers: { "content-type": "application/json", "x-sentry-rate-limits": "60:error:key" },
    });
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    forwarded.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: Buffer.from(init?.body as Uint8Array),
    });
    return answer();
  }) as typeof fetch;

  let base = "";
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  before(async () => {
    const app = express();
    const tunnel = createErrorTunnel(DSN, fakeFetch);
    assert.ok(tunnel);
    app.use(tunnel);
    app.use(express.json());
    app.use((_request, response) => {
      response.status(404).end();
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
  });

  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    fetch(`${base}${ERROR_TUNNEL_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body,
    });

  it("passes the envelope on unchanged, with none of the browser's headers", async () => {
    forwarded.length = 0;
    const body = envelope({ dsn: DSN, event_id: "e1" });
    const response = await post(new Uint8Array(body), {
      cookie: "session=secret",
      "user-agent": "Mozilla/5.0 (player)",
      "x-forwarded-for": "203.0.113.7",
      "x-device-token": "3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"id":"abc"}');
    assert.equal(response.headers.get("x-sentry-rate-limits"), "60:error:key");

    assert.equal(forwarded.length, 1);
    const [sent] = forwarded;
    assert.equal(sent?.url, "https://glitchtip.example.com/api/25/envelope/");
    assert.deepEqual(sent?.headers, {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": "Sentry sentry_version=7, sentry_key=0123456789abcdef0123456789abcdef",
    });
    assert.ok(sent?.body.equals(body));
  });

  it("refuses an envelope for any other DSN without forwarding it", async () => {
    forwarded.length = 0;
    const response = await post(new Uint8Array(envelope({ dsn: "https://k@evil.example.com/25" })));
    assert.equal(response.status, 400);
    assert.equal((await post("")).status, 400);
    assert.equal(forwarded.length, 0);
  });

  it("refuses a body over the cap", async () => {
    forwarded.length = 0;
    const big = Buffer.concat([envelope({ dsn: DSN }), Buffer.alloc(MAX_ENVELOPE_BYTES, 0x61)]);
    const response = await post(new Uint8Array(big));
    assert.equal(response.status, 413);
    assert.equal(forwarded.length, 0);
  });

  it("answers 502 when GlitchTip is unreachable, and logs no body", async () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    answer = async () => {
      throw new TypeError("fetch failed");
    };
    try {
      const response = await post(
        new Uint8Array(envelope({ dsn: DSN }, '{"type":"event"}\n{"m":"SECRET"}\n')),
      );
      assert.equal(response.status, 502);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1);
    assert.ok(!JSON.stringify(warnings).includes("SECRET"));
  });

  it("answers 429 beyond the forwards in flight, then frees the slots", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = async () => {
      await gate;
      return new Response("{}", { status: 200 });
    };
    forwarded.length = 0;
    const body = new Uint8Array(envelope({ dsn: DSN }));
    const waiting = Array.from({ length: MAX_IN_FLIGHT }, () => post(body));
    // Every request at the gate before the one over the limit.
    for (let tries = 0; forwarded.length < MAX_IN_FLIGHT && tries < 400; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(forwarded.length, MAX_IN_FLIGHT);
    const over = await post(body);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), "60");

    release();
    for (const response of await Promise.all(waiting)) assert.equal(response.status, 200);
    assert.equal((await post(body)).status, 200);
  });
});
