# Deployment and error reporting

How the live game at https://asteroids.trebeljahr.com is built, deployed and monitored. This text used to be part of the README.

## Production

Production splits by path on one hostname:

- The web client is a static Vite build (`client/dist`) served by the Cloudflare Worker `asteroid-game-client` on the route `asteroids.trebeljahr.com/*` (`wrangler.jsonc`, static assets only).
- `/trpc/*`, `/socket.io/*` and `/.well-known/acme-challenge/*` have Cloudflare routes with no Worker. They reach Traefik on the Coolify server, which sends `/trpc` and `/socket.io` to the server's Docker Image app.

`.github/workflows/build-and-deploy.yml` uploads a Worker version (not live), deploys the server, waits until `/trpc/health` reports the commit, then activates the Worker version. Each upload carries the last two releases' hashed files (`scripts/carry-static.mjs`), so tabs opened before a deploy keep loading theirs.

```bash
# The whole stack in local Docker
docker compose up
```

## Error reporting

Both halves report errors to the self-hosted GlitchTip project `asteroid-game` (Sentry protocol). Each is off while its DSN is empty.

- **Server:** `SENTRY_DSN` in the Coolify env of the server app (`server/src/instrument.ts`). It sends uncaught exceptions, unhandled rejections and tRPC errors that answer 500. The process still exits on an uncaught error, as before.
- **Client:** the repository variable `VITE_SENTRY_DSN`, inlined by the build-client job (`client/src/errorReporting`). A build without it ships no SDK. With it, the SDK loads as its own chunk after the game starts.
- **Tunnel:** the browser never posts to GlitchTip itself. Content blockers drop every request with `sentry_key=` in its URL, so the SDK's `tunnel` option posts each report to `/trpc/client-errors` on the game's own host, and the server passes it on (`server/src/errorTunnel.ts`). The path sits under `/trpc/` because the Cloudflare route, the Vite dev proxy and `client/server.mjs` already send that prefix to the server. The server forwards only to the host and project of its own `SENTRY_DSN`, refuses bodies over 128 KiB, sends none of the browser's headers or its IP address, and logs no report. A server without `SENTRY_DSN` has no tunnel, so client reports need both DSNs set.

```bash
gh variable set VITE_SENTRY_DSN --body '<public DSN of the asteroid-game project>'
```

A report carries the error, its stack, the page URL without its query string, the release (`asteroid-game@<version>+<commit>`) and the platform. Never a user id, device token, email, cookie, header or request body; no breadcrumbs, no tracing, no session replay. The rules are `shared/src/errorScrub.ts` plus one scrubber per half, with tests in `client/test` and `server/test`. The privacy policy (`client/public/privacy.html`, served at `/privacy` and linked from the main menu and Options) says the same to players: change the code and that page together. Set `SENTRY_ENVIRONMENT=wiring-check` (server) or build with `--mode wiring-check` (client) to send a test event apart from production.

