import type { ErrorEvent } from "@sentry/browser";
import { scrubText, stripUrl } from "../../../shared/src/errorScrub";

/**
 * What a browser error report may carry, decided in one place. Every rule
 * removes something; nothing adds data. The privacy policy
 * (client/public/privacy.html, "Error reports") says the same in plain words:
 *
 *  - The error and its stack frames, with the query string and fragment
 *    cut from every frame's file URL.
 *  - The page URL without its query string or fragment.
 *  - The release and the platform, which the reporter adds.
 *
 * Never a user id, email, cookie, header (the browser identifier included)
 * or request body; no breadcrumbs (the reporter starts none); text rules
 * for the message in shared/src/errorScrub.ts.
 */

/** The only `contexts` keys a report keeps: the trace ids the SDK groups events with. */
const KEPT_CONTEXTS: ReadonlySet<string> = new Set(["trace"]);

/** An error event with everything outside the policy above removed. Mutates and returns it. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  delete event.extra;
  delete event.server_name;
  delete event.breadcrumbs;

  if (event.request) {
    event.request = event.request.url ? { url: stripUrl(event.request.url) } : {};
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (!KEPT_CONTEXTS.has(key)) delete event.contexts[key];
    }
  }

  if (typeof event.message === "string") event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  if (event.logentry) delete event.logentry.params;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path);
      delete frame.vars;
    }
  }

  return event;
}
