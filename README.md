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

The project ships with Docker support and a GitHub Actions workflow that builds images to GHCR.

```bash
# Local Docker
docker compose up

# Production (pulls pre-built images from GHCR)
docker compose -f docker-compose-prod.yaml up
```

See `.github/workflows/build-and-deploy.yml` for the CI/CD pipeline. For Coolify, create a Docker Compose resource pointing at `docker-compose-prod.yaml` and set the `COOLIFY_WEBHOOK_URL` secret in GitHub.

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
