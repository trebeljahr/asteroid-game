/**
 * Text rules for error reports, shared by the browser reporter
 * (client/src/errorReporting) and the server's (server/src/instrument.ts).
 * Every rule removes something; nothing here adds data.
 *
 * What survives in a message is the error itself. Removed:
 *
 *  - Query strings and fragments of every URL. The socket.io polling URL
 *    carries a session id there, and a tRPC GET its whole input.
 *  - Credentials in a URL's authority.
 *  - Email addresses and bearer tokens.
 *  - Long id-like tokens: device tokens (a UUID or 32 hex digits), user ids
 *    (UUIDs), match resume tokens (32 base64url characters). A device token
 *    is the player's account key.
 *  - The `params:` line drizzle adds to a failed query's message, which
 *    holds the query's values, the device token included.
 */

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
/**
 * A UUID, 32 hex digits, a base64url resume token: 32 or more id characters
 * in a row. The scan reaches a run at its first character, so the greedy
 * match is always the whole run.
 */
const LONG_TOKEN = /[\w-]{32,}/g;
/** drizzle's `Failed query: …\nparams: a,b,c`. */
const QUERY_PARAMS = /\bparams: [^\n]*/g;
/** `?` or `#` and everything after it, inside a longer text. Stops at whitespace and quotes. */
const QUERY_IN_TEXT = /[?#][^\s"'<>]*/g;
/**
 * An absolute URL inside a longer text. The path stops at a quote or
 * bracket; a query string or fragment, once begun, runs to the next
 * whitespace, so a tRPC `?input={"a":1}` is removed whole.
 */
const URL_IN_TEXT = /\b[a-z][\w+.-]*:\/\/[^\s"'<>?#]*(?:[?#]\S*)?/gi;
/**
 * A root-relative path, the same way, after a character that cannot end a
 * word or a host. No lookbehind: Safari before 16.4 rejects one when it
 * parses the file, and this file is in the game's first bundle.
 */
const PATH_IN_TEXT = /(^|[^\w.])(\/[^\s"'<>?#]*(?:[?#]\S*)?)/g;

/**
 * A URL with its query string, fragment and any `user:password@` removed.
 * Never parses, so a URL that would fail to parse is still stripped.
 */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const bare = cut === -1 ? url : url.slice(0, cut);
  return bare.replace(/^([a-z][\w+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** Free text (an error message) with every rule above applied. */
export function scrubText(text: string): string {
  // URLs first: stripping one removes any `user:password@` before the email
  // rule could half-match it, and any address that was only in its query.
  return text
    .replace(QUERY_PARAMS, "params: [redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(URL_IN_TEXT, (url) => stripUrl(url))
    .replace(PATH_IN_TEXT, (_match, before: string, path: string) => before + stripUrl(path))
    .replace(QUERY_IN_TEXT, (rest) => (rest.includes("=") ? "" : rest))
    .replace(EMAIL, "[email]")
    .replace(LONG_TOKEN, "[token]");
}
