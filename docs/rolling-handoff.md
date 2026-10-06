# Rolling deploys and durable match handoff

Live duels and battle royales survive a rolling server replacement. One
replica owns each match. When it drains, it writes a final snapshot and
another replica resumes the match after a short countdown.

## Requirements

Durable handoff turns on only when the server has **both**:

| Env | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres. Holds `match_leases`, `match_snapshots`, `match_results` and the shared `matchmaking_tickets` queue. Migrations run at startup under an advisory lock. |
| `REDIS_URL` | Shared Redis. Socket.IO adapter (room fanout) and replica-to-replica messages. Never authoritative; no persistence needed. |

Without either, the server logs `single replica, in-memory matches`. Run
only one replica in that mode; a drain ends every match uncounted
(`server-restart`), as before.

Optional: `REPLICA_ID` prefixes the per-process replica ID (the process
ID and a random suffix are always added). `DRAIN_DELAY_MS` (default
20000) is the time between `SIGTERM` and closing Socket.IO.

The client container proxies `/socket.io` and `/trpc` to `BACKEND_URL`.
In Docker Compose that is `http://server:9777`. When the client runs as
its own image app, set `BACKEND_URL` to the server app's internal or
routed URL. With `NODE_ENV=production` the client refuses to start
without it. Alternatively, route `/socket.io` and `/trpc` straight to the
server app in the proxy.

Clients connect with the WebSocket transport only, so no sticky
sessions are needed. Image health checks run every 2 s (5 s timeout,
15 s start period, 5 retries), so the proxy drops a draining container
inside the 20 s drain.

## How it works

- **Matchmaking.** `queue:join` / `queue:leave` travel over the socket.
  Tickets live in Postgres. Any non-draining replica pairs duel tickets
  (`FOR UPDATE SKIP LOCKED`). The battle-royale lobby is run by the one
  replica that holds the `lobby:battle-royale` lease, so every lobby
  socket sees one countdown. Match IDs are random UUIDs.
- **Ownership.** `match_leases` has an `epoch` fencing token. The owner
  renews every 1 s (TTL 5 s) and stops simulating when its local
  deadline passes. Snapshot and result writes check epoch and owner in
  the same transaction; a replica that lost the lease drops the match.
- **Snapshots.** About 2 Hz, plus one final snapshot at drain. They hold
  the seed and generator state, spawn timers as remaining durations,
  ID counters, sequence and world version, players by stable player ID
  with health, ammo and cooldowns, bullets, asteroids, pickups and
  phase. Resume tokens are stored only as SHA-256 hashes.
- **Routing.** Players can sit on any replica. Inputs, leaves and
  resume requests go to the owner over Redis; the owner emits through
  the Socket.IO adapter by room or socket ID.
- **Drain (`SIGTERM`).** Health turns 503 and new sockets are refused.
  The replica freezes its matches, emits `match:migrating`, writes the
  final snapshot and sets the lease to `handoff`, then disconnects its
  sockets. Another replica claims the lease with `epoch + 1`, restores
  the match and waits for players. Clients reconnect and send
  `match:resume` with match ID and resume token. When every surviving
  player is back, a 3 s countdown starts. A player who does not return
  within 30 s forfeits. If nobody returns, or the snapshot is missing or
  invalid, the match ends uncounted (`server-restart`).
- **Crash.** If the owner dies without draining, its lease expires
  after 5 s and another replica resumes from the last periodic snapshot.
  Clients detect the silence after 3 s and resume.
- **Results.** `match_results(match_id, user_id)` receipts are inserted
  in the same transaction as the `user_stats` increments and the lease
  `finished` update. A replayed finish or a stale owner changes no
  stats.
- **Leaving and disconnects.** `queue:leave` (leaving the mode) forfeits
  at once. Any socket disconnect keeps the seat for the 30 s grace, so a
  dropped connection can resume.

## Proof

```bash
pnpm --filter @simple-asteroid-game/server test
```

Unit and Postgres tests. Set `TEST_DATABASE_URL` to a disposable
Postgres that allows `CREATE DATABASE` to include the Postgres cases.

```bash
pnpm build && PROOF_DATABASE_URL=postgres://… PROOF_REDIS_URL=redis://… pnpm proof:handoff
```

Two server processes, one Postgres, one Redis, a round-robin TCP proxy
without sticky sessions, and simulated WebSocket-only clients. Checks:
no cross-match delivery, shared queue, one lobby countdown, `SIGTERM`
handoff of a duel and a battle royale, stale-epoch fencing after
`SIGSTOP` past the TTL, `SIGKILL` resume from the periodic snapshot, and
an uncounted end when nobody returns. `pnpm proof:stack` starts the same
two-replica stack with the production client for browser testing.
