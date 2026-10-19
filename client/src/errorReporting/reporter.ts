import { scrubEvent } from "./scrub";
import type * as Sdk from "./sdk";

/**
 * Error reports from the game in the browser, to a Sentry-protocol endpoint
 * (GlitchTip), the same one the server reports to with `SENTRY_DSN`. This
 * file is the reporter itself; `start.ts` builds the one the game uses from
 * the build's env.
 *
 * Without a DSN it never loads the SDK. With one, it loads the SDK as its
 * own chunk and holds the errors thrown while it loads, so a crash in p5's
 * first `setup` is still reported.
 *
 * What a report may carry is `scrub.ts`. What this file adds is only the
 * release and `platform: web`. No tracing (which would add headers to every
 * tRPC request), no session pings, no session replay, no breadcrumbs: the
 * SDK sends something only when an error happens.
 */

type Sentry = typeof Sdk;

export interface ErrorReporterOptions {
  dsn: string;
  /** Imports the SDK. Never called when `dsn` is empty. */
  load: () => Promise<Sentry>;
  release: string | undefined;
  environment: string;
  /** Where uncaught errors arrive before the SDK installs its own handlers: `window`. */
  target: EventTarget;
}

/** Errors held while the SDK loads. */
const MAX_PENDING = 20;

/** Starts reporting once. Resolves false without a DSN, or when the SDK failed to load. */
export function createErrorReporter(options: ErrorReporterOptions): () => Promise<boolean> {
  let started: Promise<boolean> | null = null;

  return () => {
    if (!options.dsn) return Promise.resolve(false);
    if (started) return started;

    const pending: unknown[] = [];
    const hold = (error: unknown) => {
      if (pending.length < MAX_PENDING) pending.push(error);
    };
    const onError = (event: Event) => {
      const { error, message } = event as Event & { error?: unknown; message?: string };
      hold(error ?? message);
    };
    const onRejection = (event: Event) => hold((event as Event & { reason?: unknown }).reason);
    options.target.addEventListener("error", onError);
    options.target.addEventListener("unhandledrejection", onRejection);
    const stopHolding = () => {
      options.target.removeEventListener("error", onError);
      options.target.removeEventListener("unhandledrejection", onRejection);
    };

    started = options
      .load()
      .then((sdk) => {
        sdk.init({
          dsn: options.dsn,
          release: options.release,
          environment: options.environment,
          sendDefaultPii: false,
          sendClientReports: false,
          // No tracing: no tracesSampleRate and no browserTracingIntegration.
          // The list replaces the SDK defaults, leaving out the session
          // integration (a ping on every page load), the culture context
          // and every breadcrumb.
          defaultIntegrations: false,
          integrations: [
            sdk.eventFiltersIntegration(),
            sdk.functionToStringIntegration(),
            sdk.browserApiErrorsIntegration(),
            sdk.globalHandlersIntegration(),
            sdk.linkedErrorsIntegration(),
            sdk.dedupeIntegration(),
            sdk.httpContextIntegration(),
          ],
          maxBreadcrumbs: 0,
          beforeBreadcrumb: () => null,
          beforeSend: (event) => scrubEvent(event),
          initialScope: { tags: { platform: "web" } },
        });
        // The SDK's global handlers take over from here.
        stopHolding();
        for (const error of pending.splice(0)) {
          sdk.captureException(error, { tags: { source: "before-sdk" } });
        }
        return true;
      })
      .catch(() => {
        // The SDK chunk itself failed to load (offline, or a deploy removed
        // it). The game goes on without reporting.
        stopHolding();
        pending.length = 0;
        return false;
      });
    return started;
  };
}
