# Simulation Performance

How much CPU one battle-royale match costs on the server, what was cut,
and what the snapshot costs on the wire.

## The benchmark

`server/bench/simTick.ts` steps one battle-royale match through the real
`tickAll` / `tickMatch` as fast as the CPU allows:

- 20 ships (the maximum), 48 asteroids, 28 hearts and 22 ammo packets.
- Bots fly to random waypoints and fire at another ship on every tick
  their cooldown allows. That is about 150 live bullets at any time.
- Before each tick the harness tops every ship up to full health and ammo
  and keeps the spawn timers due. The load stays at its peak for the whole
  run, and nobody is eliminated.
- Emitted payloads are encoded inside the tick with the server's
  socket.io parser (msgpack), once per room broadcast, as socket.io does.
  Writing to the sockets is not simulated. (The results below were
  measured when the server still sent JSON.)
- `Date.now` is a virtual clock and `Math.random` is seeded, so a run is
  repeatable. The state checksum at the end must stay the same when a
  change only makes the code faster.

```bash
pnpm --filter @simple-asteroid-game/server bench:sim
```

Options: `--ticks 7200` (measured ticks), `--warmup 1200`, `--seed 1`,
`--json` (one line of JSON for scripts).

The script compiles with `tsc` and runs the CommonJS output, the code
production runs. Under `tsx` every export becomes a getter and the tick
takes about twice as long, so do not measure through `tsx`.

`server/test/netcodeHarness.ts` is a different tool: it plays matches in
virtual time to check netcode behaviour and measures no CPU time.

## Results

Apple M5, Node 26.8.1, 7200 measured ticks (two minutes of match time).
Baseline and final ran alternately, five times each, with the same
harness. Other work was running on the machine, so expect the spread
below.

| | Baseline | Final |
|---|---|---|
| Tick p50 | 465–550 µs | 63–98 µs |
| Tick p99 | 713–1177 µs | 118–245 µs |
| Tick max | 1.6–2.6 ms | 0.36–1.5 ms |
| GC time per tick | 11.9–16.3 µs | 0.7–1.1 µs |
| Scavenges per run | 1710 | 32 |
| Allocated per tick | 5,350 KiB | 54 KiB |
| State checksum | `b799844f` | `b799844f` |

At p50 the final tick uses 0.4–0.6% of the 16.7 ms tick budget of one
core. About 25–35 µs of it is the JSON encoding of the snapshot.

What each change did (3 runs each; the exact numbers are in the commit
messages):

| Change | Tick p50 | Allocated per tick |
|---|---|---|
| Baseline | 445–465 µs | 5,360 KiB |
| One reused ship collider per participant | 114–131 µs | 160 KiB |
| Spatial hash with number keys, no per-query sets or arrays | 94–105 µs | 64 KiB |
| Bullets tested against colliders gathered once per tick | 63–68 µs | 64 KiB |

The first change carries most of the gain. Every bullet built a new
transformed polygon for every ship it was tested against: about 2,900
polygons per tick at peak load. The duel service got the same changes.

### What is left

Allocation sampling of the final tick found 54 KiB per tick:

- 27 KiB is the snapshot, built and encoded every second tick: 14 KiB
  of JSON string and 13 KiB of payload objects, mostly the bullet copies.
- 6 KiB is the harness: the bot inputs.
- 20 KiB is the simulation, in small pieces. The largest:
  - 4.8 KiB in the bullet pass. This is most likely the bullet position
    boxed on its way into `getNearbyAsteroids`, once per bullet.
  - 3.4 KiB of spatial query result arrays. V8 drops an array's storage
    when its length is set to 0, so a reused result array allocates again
    after a query that found nothing. Writing by index instead did not
    measurably help.
  - 2.4 KiB of input arrays in `playerStepsForTick` and
    `takeInputsForTick`.
  - 2.1 KiB in `stepPlayerState`.
  - 1.4 KiB for the player position list that `updateWorldSpawns` builds
    on every tick, even when nothing spawns.

At one scavenge every few seconds and about 1 µs of GC per tick, further
work here has little to gain.

## Snapshot size on the wire

A battle-royale snapshot (`br:snapshot`) goes to every player in the
match 30 times a second. Two changes brought it from 28 KB to under 4 KB.
Measured with the benchmark (20 ships, 152 bullets, mean of 240
snapshots):

| | Snapshot | Per player, snapshots + world events |
|---|---|---|
| JSON, bullets in every snapshot | 28,334 B | 832 KiB/s |
| JSON, bullets as spawn and removal events | 5,666 B | 166 + 33 = 199 KiB/s |
| msgpack from the server (current) | 3,796 B | 111 + 24 = 135 KiB/s |

At 20 players a full match at peak load now sends about 2.7 MB/s, down
from about 17 MB/s. Real matches have fewer bullets, because ammo is
limited.

- **Bullets out of the snapshot.** Bullets were 80% of it: 149 bytes each
  in JSON, sent again in every snapshot while the bullet flew. A bullet
  flies in a straight line at a fixed speed, so the server now sends a
  `bullet-spawned` world event when it is fired and a `bullet-removed`
  event, with the cause, when it ends. The client moves it in between
  (see the netcode guide). The simulation did not change: the state
  checksum stayed `b799844f`.
- **msgpack from the server.** `socket.io-msgpack-parser` saves about a
  third of what is left. notepack.io writes every non-integer as a 64-bit
  float, so values arrive exactly as the server has them. Encoding takes
  about three times as long as `JSON.stringify` (25 µs against 7 µs per
  snapshot), once per broadcast. Clients still send JSON: notepack.io
  allocates and fills whatever length a frame declares, so a 6-byte frame
  could make the server allocate and zero 4 GB. The server never decodes
  msgpack.

Options measured but not taken:

- **32-bit floats** need an encoder that supports them, such as
  `@msgpack/msgpack` with `forceFloat32`. With bullets in the snapshot
  they saved another 16% over msgpack. Positions then change by up to
  about 0.0001 px. The server keeps the exact values, so client
  reconciliation would see tiny corrections.
- **permessage-deflate** compresses the JSON snapshot to a third (1,850 B
  now), but ws compresses every message once per socket. With bullets in
  the snapshot, a room broadcast to 20 players cost 9–16 ms of CPU per
  snapshot, or 270–480 ms per second per match. Not usable for snapshots.
- **Fixed binary layout** is a sketch: an 8-byte header and 29 bytes per
  player (slot index, x/y/vx/vy/angle as float32, health, ammo, recovery
  ticks, last input sequence, thrusting), about 590 B for 20 players. It
  needs a hand-written encoder and decoder on both sides, a stable player
  index instead of string IDs, and 32-bit floats.
- **Static fields.** Every snapshot repeats each player's `shipVariant`
  and `slot`, which never change during a match: about 47 bytes of JSON
  per player.
