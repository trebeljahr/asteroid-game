import { ERROR_TUNNEL_PATH } from "../../../shared/src/errorTunnel";
import { createErrorReporter } from "./reporter";
import type * as Sdk from "./sdk";

/**
 * Opt-in per build: `VITE_SENTRY_DSN` is inlined at build time
 * (vite.config.mts defines it as "" when unset, and CI passes the
 * repository variable of that name).
 *
 * The SDK import sits behind a condition on the inlined DSN in the same
 * expression. Without a DSN the condition is the literal "", the bundler
 * folds it to its false branch, and the SDK chunk is never built.
 */
const loadSentry = (): Promise<typeof Sdk> =>
  import.meta.env.VITE_SENTRY_DSN
    ? import("./sdk")
    : Promise.reject(new Error("error reporting is not configured"));

/** Starts reporting if this build has a DSN. Call once, before the game starts. */
export const startErrorReporting = createErrorReporter({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  tunnel: `${window.location.origin}${ERROR_TUNNEL_PATH}`,
  load: loadSentry,
  release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
  environment: import.meta.env.MODE,
  target: window,
});
