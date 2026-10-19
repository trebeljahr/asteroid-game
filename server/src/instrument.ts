/**
 * Error reports to a Sentry-protocol endpoint (GlitchTip). Imported first in
 * server.ts, before anything it watches is loaded.
 *
 * Off unless `SENTRY_DSN` is set (Coolify env of the server app). What it
 * sends: uncaught exceptions, unhandled rejections and tRPC errors that
 * answer 500 (`reportTrpcError`, from the tRPC middleware). No tracing, no
 * request data, no breadcrumbs: the integration list below replaces the
 * SDK defaults, which would add the HTTP and fetch instrumentation and the
 * console breadcrumbs. `scrubServerEvent` decides the rest.
 */

import * as Sentry from "@sentry/node";
import { version as APP_VERSION } from "../../package.json";
import { scrubServerEvent } from "./errorScrub";

const dsn = process.env.SENTRY_DSN?.trim() ?? "";

/** `asteroid-game@<version>+<commit>`, the same release name the client sends. */
export const releaseName = (version: string, commit: string): string => {
  const build = commit.trim().slice(0, 12);
  return build ? `asteroid-game@${version}+${build}` : `asteroid-game@${version}`;
};

if (dsn) {
  Sentry.init({
    dsn,
    release: releaseName(APP_VERSION, process.env.COMMIT_SHA ?? ""),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    sendDefaultPii: false,
    sendClientReports: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.contextLinesIntegration(),
      // Both keep Node's own outcome: the process exits after the report.
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubServerEvent(event),
  });
}

/** Whether a DSN is set and the SDK started. */
export const errorReportingEnabled = dsn !== "";

/**
 * A tRPC error worth a report: only an INTERNAL_SERVER_ERROR. A missing
 * device token or a bad input is the caller's error. The procedure path and
 * type go along as tags; the input never does.
 */
export const reportTrpcError = ({
  error,
  path,
  type,
}: {
  error: { code: string };
  path: string | undefined;
  type: string;
}): void => {
  if (!errorReportingEnabled || error.code !== "INTERNAL_SERVER_ERROR") return;
  Sentry.captureException(error, {
    tags: { source: "trpc", trpc_path: path ?? "unknown", trpc_type: type },
  });
};
