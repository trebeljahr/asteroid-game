# Asteroids

A real-time multiplayer asteroid game built with TypeScript, Socket.io, and p5.js. Fly your ship through asteroid fields, collect ammo and health pickups, and battle other players in head-to-head matches.

## Features

- **Singleplayer mode** - Navigate through an asteroid field and survive as long as you can
- **Multiplayer battles** - Real-time 1v1 matches with server-authoritative game state
- **Ship selection** - Choose from 6 unique ship variants, each with distinct collision shapes
- **Mobile support** - Touch controls with landscape orientation support
- **Physics-based gameplay** - Realistic thrust, rotation, and collision mechanics using Matter.js

## Tech Stack

- **Client** - React, Vite, p5.js (canvas rendering), Matter.js (physics)
- **Server** - Node.js, Express, Socket.io, tRPC
- **Shared** - TypeScript types and game logic shared between client and server
- **Infrastructure** - Docker, Redis (Socket.io adapter for horizontal scaling), GitHub Actions

## Development

```bash
pnpm install
pnpm dev          # Random ports
pnpm dev:fixed    # Client on 5173, server on 9777
pnpm dev:lan      # Fixed ports, accessible from LAN (mobile testing)
```

Debug tools (collision outlines, netcode overlay) only exist in dev builds. Open the dev URL with `?debug=1` to show their toggles in Options; the choice is remembered until `?debug=0`.

## Deployment

Production splits by path on one hostname:

- The web client is a static Vite build (`client/dist`) served by the Cloudflare Worker `asteroid-game-client` on the route `asteroids.trebeljahr.com/*` (`wrangler.jsonc`, static assets only).
- `/trpc/*`, `/socket.io/*` and `/.well-known/acme-challenge/*` have Cloudflare routes with no Worker. They reach Traefik on the Coolify server, which sends `/trpc` and `/socket.io` to the server's Docker Image app.

`.github/workflows/build-and-deploy.yml` uploads a Worker version (not live), deploys the server, waits until `/trpc/health` reports the commit, then activates the Worker version. Each upload carries the last two releases' hashed files (`scripts/carry-static.mjs`), so tabs opened before a deploy keep loading theirs.

```bash
# The whole stack in local Docker
docker compose up
```

### Error reporting

Both halves report errors to the self-hosted GlitchTip project `asteroid-game` (Sentry protocol). Each is off while its DSN is empty.

- **Server:** `SENTRY_DSN` in the Coolify env of the server app (`server/src/instrument.ts`). It sends uncaught exceptions, unhandled rejections and tRPC errors that answer 500. The process still exits on an uncaught error, as before.
- **Client:** the repository variable `VITE_SENTRY_DSN`, inlined by the build-client job (`client/src/errorReporting`). A build without it ships no SDK. With it, the SDK loads as its own chunk after the game starts.
- **Tunnel:** the browser never posts to GlitchTip itself. Content blockers drop every request with `sentry_key=` in its URL, so the SDK's `tunnel` option posts each report to `/trpc/client-errors` on the game's own host, and the server passes it on (`server/src/errorTunnel.ts`). The path sits under `/trpc/` because the Cloudflare route, the Vite dev proxy and `client/server.mjs` already send that prefix to the server. The server forwards only to the host and project of its own `SENTRY_DSN`, refuses bodies over 128 KiB, sends none of the browser's headers or its IP address, and logs no report. A server without `SENTRY_DSN` has no tunnel, so client reports need both DSNs set.

```bash
gh variable set VITE_SENTRY_DSN --body '<public DSN of the asteroid-game project>'
```

A report carries the error, its stack, the page URL without its query string, the release (`asteroid-game@<version>+<commit>`) and the platform. Never a user id, device token, email, cookie, header or request body; no breadcrumbs, no tracing, no session replay. The rules are `shared/src/errorScrub.ts` plus one scrubber per half, with tests in `client/test` and `server/test`. The privacy policy (`client/public/privacy.html`, served at `/privacy` and linked from the main menu and Options) says the same to players: change the code and that page together. Set `SENTRY_ENVIRONMENT=wiring-check` (server) or build with `--mode wiring-check` (client) to send a test event apart from production.

## Project Structure

```
client/          # React + Vite frontend
  src/           # Game logic, UI components, rendering
  server.mjs     # Production static file server with backend proxy
  Dockerfile     # Client container build
server/          # Express + Socket.io backend
  src/           # Multiplayer service, tRPC router, Redis
  Dockerfile     # Server container build
shared/          # TypeScript types and game logic shared between client/server
scripts/         # Dev tooling (dev.mjs)
```

## Credits

- Icons by [Freepik](https://www.flaticon.com/authors/freepik) and [Smashicons](https://www.flaticon.com/authors/smashicons) from [Flaticon](https://www.flaticon.com/)
