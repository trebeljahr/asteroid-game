/**
 * The browser's error reports, passed on to GlitchTip. The browser SDK posts
 * its envelopes to ERROR_TUNNEL_PATH on the game's own host (its `tunnel`
 * option) instead of to GlitchTip's `/api/<project>/envelope/?sentry_key=…`,
 * which content blockers drop for the `sentry_key=` in the URL.
 *
 * Never an open proxy. The target is the host and project of SENTRY_DSN,
 * built from that DSN alone; an envelope whose header names any other DSN
 * is refused. The body is capped and passed on as it came, never logged or
 * kept. None of the request's own headers go along, so GlitchTip never
 * sees the player's IP address, user agent or cookies.
 */

import express, { type ErrorRequestHandler, type RequestHandler, Router } from "express";
import { ERROR_TUNNEL_PATH } from "../../shared/src/errorTunnel";

/**
 * A scrubbed browser event is a few kB. The largest the SDK builds, five
 * linked errors of 50 frames each, stays well under this.
 */
export const MAX_ENVELOPE_BYTES = 128 * 1024;
/** Forwards waiting on GlitchTip at once. Beyond it, 429: the SDK backs off. */
export const MAX_IN_FLIGHT = 16;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** A Sentry public key: hex, or GlitchTip's dashless UUID. Nothing that could break a header. */
const PUBLIC_KEY = /^[\w-]{1,64}$/;
/** Of GlitchTip's answer, the headers the SDK reads to back off. */
const PASSED_BACK = ["x-sentry-rate-limits", "retry-after"] as const;

export interface Dsn {
  publicKey: string;
  /** `https://glitchtip.example.com`: scheme, host and port. */
  origin: string;
  /** Any path before the project id, without a trailing slash. Usually "". */
  pathPrefix: string;
  projectId: string;
}

/** The parts of `https://<key>@<host>[/<path>]/<project id>`, or null for anything else. */
export function parseDsn(dsn: string): Dsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.password || url.search || url.hash) return null;
  if (!PUBLIC_KEY.test(url.username)) return null;
  const segments = url.pathname.split("/");
  const projectId = segments.pop() ?? "";
  if (!/^\d+$/.test(projectId)) return null;
  return {
    publicKey: url.username,
    origin: url.origin,
    pathPrefix: segments.join("/"),
    projectId,
  };
}

/**
 * The public key of the DSN an envelope's header names, when that DSN is
 * `allowed`'s host and project. Null for anything else: no header line, no
 * `dsn`, another host or another project.
 */
export function envelopeKey(envelope: Buffer, allowed: Dsn): string | null {
  const newline = envelope.indexOf(0x0a);
  const headerLine = envelope.subarray(0, newline === -1 ? envelope.length : newline);
  let header: unknown;
  try {
    header = JSON.parse(headerLine.toString("utf8"));
  } catch {
    return null;
  }
  const dsn = (header as { dsn?: unknown } | null)?.dsn;
  if (typeof dsn !== "string") return null;
  const named = parseDsn(dsn);
  if (
    named === null ||
    named.origin !== allowed.origin ||
    named.pathPrefix !== allowed.pathPrefix ||
    named.projectId !== allowed.projectId
  ) {
    return null;
  }
  return named.publicKey;
}

/**
 * The tunnel route, for `app.use` ahead of the body parsers and tRPC. Null
 * without a valid DSN: then nothing answers ERROR_TUNNEL_PATH but tRPC's 404.
 */
export function createErrorTunnel(dsn: string, forward: typeof fetch = fetch): Router | null {
  const allowed = parseDsn(dsn);
  if (allowed === null) return null;
  const upstreamUrl = `${allowed.origin}${allowed.pathPrefix}/api/${allowed.projectId}/envelope/`;

  let inFlight = 0;
  const limitInFlight: RequestHandler = (_request, response, next) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      response.status(429).set("retry-after", "60").end();
      return;
    }
    inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };

  // Any content type: the SDK sends text/plain so the browser skips the
  // CORS preflight. Never inflated: the SDK does not compress, and the cap
  // must hold for what is read.
  const readBody = express.raw({ type: () => true, limit: MAX_ENVELOPE_BYTES, inflate: false });

  const pass: RequestHandler = async (request, response) => {
    const envelope: unknown = request.body;
    const key = Buffer.isBuffer(envelope) ? envelopeKey(envelope, allowed) : null;
    if (key === null) {
      response.status(400).end();
      return;
    }
    try {
      const upstream = await forward(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}`,
        },
        body: new Uint8Array(envelope as Buffer),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const answer = Buffer.from(await upstream.arrayBuffer());
      for (const name of PASSED_BACK) {
        const value = upstream.headers.get(name);
        if (value !== null) response.set(name, value);
      }
      response
        .status(upstream.status)
        .type(upstream.headers.get("content-type") ?? "text/plain")
        .send(answer);
    } catch (error) {
      // Only the error's name: its message could quote the request.
      console.warn(`[error-tunnel] GlitchTip unreachable (${(error as Error)?.name ?? "error"})`);
      if (!response.headersSent) response.status(502).end();
    }
  };

  // body-parser's errors (413 too large, 400 aborted) answer here, without
  // Express's default handler, which logs the stack.
  const refuse: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = (error as { status?: unknown })?.status;
    response.status(typeof status === "number" && status >= 400 && status < 500 ? status : 400);
    response.end();
  };

  const router = Router();
  router.post(ERROR_TUNNEL_PATH, limitInFlight, readBody, pass, refuse);
  return router;
}
