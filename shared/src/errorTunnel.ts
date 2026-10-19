/**
 * Where the browser posts its error reports: the game server, which passes
 * them on to GlitchTip (server/src/errorTunnel.ts). Content blockers drop a
 * request to GlitchTip itself for the `sentry_key=` in its URL.
 *
 * Under /trpc/ because that prefix already reaches the game server: the
 * Cloudflare route, the Vite dev proxy and client/server.mjs all send it
 * there, and everything else goes to the static Worker. No "sentry" in the
 * name: EasyPrivacy blocks paths like /api/sentry/tunnel.
 */
export const ERROR_TUNNEL_PATH = "/trpc/client-errors";
