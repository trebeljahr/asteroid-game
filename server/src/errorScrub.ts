import type { ErrorEvent } from "@sentry/node";
import { scrubText, stripUrl } from "../../shared/src/errorScrub";

/**
 * A server error event reduced to the error, its stack, the release and the
 * runtime. The SDK attaches no request here (no HTTP integration), but if
 * one ever arrives it keeps only the method and the URL without its query:
 * the `x-device-token` header is the player's account key.
 *
 * Mutates and returns the event.
 */
export function scrubServerEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;

  if (event.request) {
    event.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(event.request.url ? { url: stripUrl(event.request.url) } : {}),
    };
  }

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  if (event.logentry) delete event.logentry.params;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }

  return event;
}
