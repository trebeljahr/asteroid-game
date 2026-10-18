import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import { deflateRawSync } from "node:zlib";

import {
  BATTLE_ROYALE_ARENA,
  BATTLE_ROYALE_MAX_PLAYERS,
  type BattleRoyaleSnapshotPayload,
  type MatchWorldEventsPayload,
  MULTIPLAYER_SHIP_VARIANTS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  type ShipInputState,
  solveAimAngle,
  TICK_INTERVAL_MS,
} from "../../shared/src";
import { BattleRoyaleService } from "../src/battleRoyaleService";
import type { HostContext } from "../src/realtime/matchHost";
import type { Ticket } from "../src/realtime/store";
import { wireParser } from "../src/realtime/wireParser";

/**
 * CPU benchmark of the battle-royale tick: one full match (20 ships, 48
 * asteroids, pickups, every ship firing as fast as it can) stepped through
 * the real `tickAll`/`tickMatch` back to back, as fast as the CPU allows.
 * Reports wall time per tick and what the garbage collector costs.
 *
 * test/netcodeHarness.ts plays matches in virtual time to check netcode
 * behaviour; this file measures how long the tick code itself takes.
 *
 * To keep the load at its peak for the whole run, the harness tops every
 * ship up to full health and ammo before each tick and keeps the spawn
 * timers due, so the world stays at its target counts. Date.now is a
 * virtual clock that advances one tick per step, and Math.random is
 * seeded, so a run is repeatable: the state checksum at the end must not
 * change when the simulation code is only made faster.
 *
 * Emitted payloads are encoded inside the tick with the server's
 * socket.io parser (msgpack, src/realtime/wireParser.ts), once per room
 * broadcast as socket.io does. Sending to sockets is not simulated.
 *
 * The script compiles with tsc and runs the CommonJS output, the same
 * code production runs. Under tsx every export becomes a getter, which
 * about doubles the tick time.
 *
 *   pnpm --filter @simple-asteroid-game/server bench:sim [--ticks 7200] [--warmup 1200] [--seed 1] [--json]
 */

const { values: args } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "7200" },
    warmup: { type: "string", default: "1200" },
  },
});
const MEASURED_TICKS = Number(args.ticks);
const WARMUP_TICKS = Number(args.warmup);
const SEED = Number(args.seed);
const SHIPS = BATTLE_ROYALE_MAX_PLAYERS;
/** One snapshot (and one world-events payload) in this many is kept for the encoding comparison. */
const SNAPSHOT_SAMPLE_EVERY = 15;

// Repeatable randomness for world seed, bot waypoints and anything else
// that reaches for Math.random.
let randomState = SEED >>> 0;
Math.random = () => {
  randomState = (randomState + 0x6d2b79f5) | 0;
  let result = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
  return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
};

let virtualMs = 1_000_000;
Date.now = () => Math.floor(virtualMs);

// The packet socket.io hands its parser for an event; nsp "/", type 2 (EVENT).
const eventPacket = (event: string, payload: unknown) => ({
  data: [event, payload],
  nsp: "/",
  type: 2,
});
// Socket.io's default JSON parser encodes an event as `2["event",payload]`
// and engine.io prefixes "4"; both are one ASCII byte.
const jsonWire = (event: string, payload: unknown) => `42${JSON.stringify([event, payload])}`;
const encoder = new wireParser.Encoder();
// The package's types say encode returns an ArrayBuffer; it returns [Buffer].
const msgpackWire = (event: string, payload: unknown) => {
  return (encoder.encode(eventPacket(event, payload)) as unknown as [Buffer])[0];
};
let encodeMs = 0;
let wireBytes = 0;
let emits = 0;
const snapshotSamples: BattleRoyaleSnapshotPayload[] = [];
let snapshotCount = 0;
// Bytes every player receives: each room broadcast reaches each of them once.
const roomBytes = { snapshots: 0, worldEvents: 0 };
const worldEventSamples: MatchWorldEventsPayload[] = [];
let worldEventCount = 0;
const io = {
  in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
  to: () => ({
    emit: (event: string, payload: unknown) => {
      const startedAt = performance.now();
      const wire = msgpackWire(event, payload);
      encodeMs += performance.now() - startedAt;
      wireBytes += wire.length;
      emits++;
      if (event === "br:snapshot") {
        roomBytes.snapshots += wire.length;
        if (snapshotCount++ % SNAPSHOT_SAMPLE_EVERY === 0) {
          snapshotSamples.push(payload as BattleRoyaleSnapshotPayload);
        }
      } else if (event === "br:world-events") {
        roomBytes.worldEvents += wire.length;
        if (worldEventCount++ % SNAPSHOT_SAMPLE_EVERY === 0) {
          worldEventSamples.push(payload as MatchWorldEventsPayload);
        }
      }
    },
  }),
};

const context = {
  durability: {
    canHandOff: false,
    finish: async () => {},
    leaseLive: () => true,
    open: async (matchId: string) => ({ epoch: 1, matchId, owner: "bench" }),
  },
  io,
  // A frozen clock keeps the service's own timer from ever stepping the
  // match; the benchmark calls tickAll itself.
  now: () => 0,
  replicaId: "bench",
  routes: { bind: () => {}, unbind: () => {} },
} as unknown as HostContext;

/** The private parts of the service the harness drives. */
interface BenchAccess {
  matches: Map<
    string,
    {
      bullets: unknown[];
      eliminationsSoFar: number;
      id: string;
      phase: string;
      players: Array<{
        socketId: string | null;
        state: {
          ammo: number;
          angle: number;
          health: number;
          id: string;
          vx: number;
          vy: number;
          x: number;
          y: number;
        };
      }>;
      spawnAt: { ammo: number; asteroid: number; heart: number };
      world: {
        ammunitionPackets: Map<string, { x: number; y: number }>;
        asteroids: Map<string, { hitPoints: number; x: number; y: number }>;
        hearts: Map<string, { x: number; y: number }>;
      };
    }
  >;
  tickAll(): void;
}

const service = new BattleRoyaleService(context);
const access = service as unknown as BenchAccess;

const tickets: Ticket[] = Array.from({ length: SHIPS }, (_, index) => ({
  enqueuedAt: Date.now(),
  mode: "battle-royale",
  replicaId: "bench",
  shipVariant: MULTIPLAYER_SHIP_VARIANTS[index % MULTIPLAYER_SHIP_VARIANTS.length],
  socketId: `bench-socket-${index}`,
  userId: null,
}));
const main = async () => {
  await service.createMatch(tickets);
  const match = Array.from(access.matches.values())[0];

  // Bots: each ship flies to a random waypoint, thrusting when it faces it,
  // and fires at another ship the whole time.
  const halfWidth = BATTLE_ROYALE_ARENA.width / 2 - 300;
  const halfHeight = BATTLE_ROYALE_ARENA.height / 2 - 300;
  const pickWaypoint = () => ({
    x: (Math.random() * 2 - 1) * halfWidth,
    y: (Math.random() * 2 - 1) * halfHeight,
  });
  const bots = match.players.map(() => ({
    inputSeq: 0,
    waypoint: pickWaypoint(),
    waypointTicks: 0,
  }));

  const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

  const sendInputs = (tick: number) => {
    for (let index = 0; index < match.players.length; index++) {
      const participant = match.players[index];
      const bot = bots[index];
      const { state } = participant;
      if (participant.socketId === null) continue;

      bot.waypointTicks++;
      if (
        bot.waypointTicks > 300 ||
        Math.hypot(bot.waypoint.x - state.x, bot.waypoint.y - state.y) < 200
      ) {
        bot.waypoint = pickWaypoint();
        bot.waypointTicks = 0;
      }
      const heading = wrapAngle(
        Math.atan2(bot.waypoint.y - state.y, bot.waypoint.x - state.x) - state.angle,
      );
      const target = match.players[(index + 1 + Math.floor(tick / 600)) % match.players.length];
      const input: ShipInputState = {
        aimAngle: solveAimAngle(state, target.state.x, target.state.y),
        fire: true,
        inputSeq: ++bot.inputSeq,
        thrust: Math.abs(heading) < 0.6 && Math.hypot(state.vx, state.vy) < 6,
        turnLeft: heading < -0.08,
        turnRight: heading > 0.08,
      };
      service.handleInput(match.id, participant.socketId, input);
    }
  };

  /** Hold the match at peak load: every ship alive and armed, every spawn due. */
  const keepLoadAtPeak = () => {
    for (const participant of match.players) {
      if (participant.state.health > 0) participant.state.health = PLAYER_MAX_HEALTH;
      participant.state.ammo = PLAYER_MAX_AMMO;
    }
    match.spawnAt.ammo = 0;
    match.spawnAt.asteroid = 0;
    match.spawnAt.heart = 0;
  };

  // FNV-1a over the bits of everything the simulation moves. Player and
  // bullet IDs are random per run, so they are left out. The hash is kept
  // in a local int32 while it runs: a captured variable holding a number
  // outside the small-integer range is boxed on every update, which would
  // add the harness's own garbage to the GC numbers.
  let checksumValues = new Float64Array(1024);
  let checksumWords = new Uint32Array(checksumValues.buffer);
  let checksum = 0x811c9dc5;
  const mixState = () => {
    const bullets = match.bullets as Array<{ x: number; y: number }>;
    const needed =
      match.players.length * 6 + bullets.length * 2 + match.world.asteroids.size * 2 + 3;
    if (checksumValues.length < needed) {
      checksumValues = new Float64Array(needed * 2);
      checksumWords = new Uint32Array(checksumValues.buffer);
    }
    const values = checksumValues;
    let count = 0;
    for (const { state } of match.players) {
      values[count++] = state.x;
      values[count++] = state.y;
      values[count++] = state.vx;
      values[count++] = state.vy;
      values[count++] = state.angle;
      values[count++] = state.health;
    }
    values[count++] = bullets.length;
    for (let index = 0; index < bullets.length; index++) {
      values[count++] = bullets[index].x;
      values[count++] = bullets[index].y;
    }
    for (const asteroid of match.world.asteroids.values()) {
      values[count++] = asteroid.x;
      values[count++] = asteroid.hitPoints;
    }
    values[count++] = match.world.hearts.size;
    values[count++] = match.world.ammunitionPackets.size;

    let hash = checksum | 0;
    for (let word = 0; word < count * 2; word++) {
      hash = Math.imul(hash ^ checksumWords[word], 0x01000193);
    }
    checksum = hash >>> 0;
  };

  const runTick = (tick: number) => {
    sendInputs(tick);
    keepLoadAtPeak();
    virtualMs += TICK_INTERVAL_MS;
    const startedAt = performance.now();
    access.tickAll();
    return performance.now() - startedAt;
  };

  // Countdown, then warm-up so the JIT has settled before measuring.
  let tick = 0;
  while (match.phase !== "active") runTick(tick++);
  for (let warm = 0; warm < WARMUP_TICKS; warm++) runTick(tick++);

  (globalThis as { gc?: () => void }).gc?.();
  encodeMs = 0;
  wireBytes = 0;
  emits = 0;
  snapshotSamples.length = 0;
  roomBytes.snapshots = 0;
  roomBytes.worldEvents = 0;
  worldEventSamples.length = 0;

  const tickMs = new Float64Array(MEASURED_TICKS);
  const world = { ammo: 0, asteroids: 0, bullets: 0, hearts: 0 };
  const gcProfiler = new v8.GCProfiler();
  const heapBefore = v8.getHeapStatistics().used_heap_size;
  gcProfiler.start();
  for (let measured = 0; measured < MEASURED_TICKS; measured++) {
    tickMs[measured] = runTick(tick++);
    world.ammo += match.world.ammunitionPackets.size;
    world.asteroids += match.world.asteroids.size;
    world.bullets += match.bullets.length;
    world.hearts += match.world.hearts.size;
    mixState();
  }
  const gcStats = gcProfiler.stop();
  const heapAfter = v8.getHeapStatistics().used_heap_size;

  if (!access.matches.has(match.id) || match.eliminationsSoFar > 0) {
    throw new Error("the match ended or lost a ship during the run; the load was not at its peak");
  }

  const sorted = Float64Array.from(tickMs).sort();
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const totalTickMs = tickMs.reduce((sum, value) => sum + value, 0);

  let gcMs = 0;
  let gcFreedBytes = 0;
  const gcCounts: Record<string, number> = {};
  for (const entry of gcStats?.statistics ?? []) {
    gcMs += entry.cost / 1000;
    gcFreedBytes +=
      entry.beforeGC.heapStatistics.usedHeapSize - entry.afterGC.heapStatistics.usedHeapSize;
    gcCounts[entry.gcType] = (gcCounts[entry.gcType] ?? 0) + 1;
  }
  const allocatedBytes = gcFreedBytes + (heapAfter - heapBefore);

  // Snapshot encodings: JSON (socket.io's default parser), msgpack (the
  // server's parser) and JSON with permessage-deflate.
  const encodings = { deflate: 0, json: 0, msgpack: 0 };
  const encodeUs = { deflate: 0, json: 0, msgpack: 0 };
  for (const payload of snapshotSamples) {
    let startedAt = performance.now();
    const json = jsonWire("br:snapshot", payload);
    encodeUs.json += (performance.now() - startedAt) * 1000;
    startedAt = performance.now();
    const msgpack = msgpackWire("br:snapshot", payload);
    encodeUs.msgpack += (performance.now() - startedAt) * 1000;
    startedAt = performance.now();
    const deflated = deflateRawSync(json);
    encodeUs.deflate += (performance.now() - startedAt) * 1000;
    encodings.json += json.length;
    encodings.msgpack += msgpack.length;
    encodings.deflate += deflated.length;
  }
  const samples = snapshotSamples.length;

  // What JSON would have sent instead, scaled from the samples.
  const worldEventEncodings = { json: 0, msgpack: 0 };
  for (const payload of worldEventSamples) {
    worldEventEncodings.json += jsonWire("br:world-events", payload).length;
    worldEventEncodings.msgpack += msgpackWire("br:world-events", payload).length;
  }
  const measuredSeconds = (MEASURED_TICKS * TICK_INTERVAL_MS) / 1000;
  const kbPerSecond = (bytes: number) => bytes / 1024 / measuredSeconds;
  const snapshotsKbPerSecond = kbPerSecond(roomBytes.snapshots);
  const worldEventsKbPerSecond = kbPerSecond(roomBytes.worldEvents);

  const result = {
    allocatedKbPerTick: allocatedBytes / 1024 / MEASURED_TICKS,
    checksum: checksum.toString(16).padStart(8, "0"),
    emitsPerTick: emits / MEASURED_TICKS,
    encodeUsPerTick: (encodeMs * 1000) / MEASURED_TICKS,
    gc: {
      counts: gcCounts,
      totalMs: gcMs,
      usPerTick: (gcMs * 1000) / MEASURED_TICKS,
    },
    wireKbPerSecond: kbPerSecond(wireBytes),
    measuredTicks: MEASURED_TICKS,
    seed: SEED,
    perPlayerKbPerSecond: {
      json: {
        snapshots: snapshotsKbPerSecond * (encodings.json / encodings.msgpack),
        worldEvents:
          worldEventsKbPerSecond *
          (worldEventEncodings.msgpack === 0
            ? 1
            : worldEventEncodings.json / worldEventEncodings.msgpack),
      },
      msgpack: {
        snapshots: snapshotsKbPerSecond,
        worldEvents: worldEventsKbPerSecond,
      },
    },
    snapshot: {
      bytes: {
        deflate: encodings.deflate / samples,
        json: encodings.json / samples,
        msgpack: encodings.msgpack / samples,
      },
      encodeUs: {
        deflate: (encodeUs.json + encodeUs.deflate) / samples,
        json: encodeUs.json / samples,
        msgpack: encodeUs.msgpack / samples,
      },
      samples,
    },
    tickUs: {
      max: percentile(1) * 1000,
      mean: (totalTickMs * 1000) / MEASURED_TICKS,
      p50: percentile(0.5) * 1000,
      p99: percentile(0.99) * 1000,
      p999: percentile(0.999) * 1000,
    },
    world: {
      ammo: world.ammo / MEASURED_TICKS,
      asteroids: world.asteroids / MEASURED_TICKS,
      bullets: world.bullets / MEASURED_TICKS,
      hearts: world.hearts / MEASURED_TICKS,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    const us = (value: number) => `${value.toFixed(0)} µs`;
    const budgetShare = (result.tickUs.p50 / 1000 / TICK_INTERVAL_MS) * 100;
    console.log(
      `battle-royale tick benchmark: ${SHIPS} ships, seed ${SEED}, ${MEASURED_TICKS} ticks after ${WARMUP_TICKS} warm-up (node ${process.version})`,
    );
    console.log(
      `world, mean      ${result.world.asteroids.toFixed(1)} asteroids, ${result.world.hearts.toFixed(1)} hearts, ${result.world.ammo.toFixed(1)} ammo packets, ${result.world.bullets.toFixed(1)} bullets`,
    );
    console.log(
      `tick             p50 ${us(result.tickUs.p50)}  p99 ${us(result.tickUs.p99)}  p99.9 ${us(result.tickUs.p999)}  max ${us(result.tickUs.max)}  mean ${us(result.tickUs.mean)}  (p50 = ${budgetShare.toFixed(1)}% of the ${TICK_INTERVAL_MS.toFixed(2)} ms tick)`,
    );
    console.log(
      `  encode         ${us(result.encodeUsPerTick)} per tick (${result.emitsPerTick.toFixed(2)} emits, msgpack ${result.wireKbPerSecond.toFixed(1)} KiB/s per match before fan-out)`,
    );
    console.log(
      `gc               ${result.gc.totalMs.toFixed(1)} ms total, ${result.gc.usPerTick.toFixed(1)} µs per tick  ${JSON.stringify(result.gc.counts)}`,
    );
    console.log(`allocated        ${result.allocatedKbPerTick.toFixed(1)} KiB per tick`);
    console.log(
      `snapshot bytes   json ${result.snapshot.bytes.json.toFixed(0)}  msgpack ${result.snapshot.bytes.msgpack.toFixed(0)}  json+deflate ${result.snapshot.bytes.deflate.toFixed(0)}  (mean of ${samples}; encode µs json ${result.snapshot.encodeUs.json.toFixed(1)}, msgpack ${result.snapshot.encodeUs.msgpack.toFixed(1)}, json+deflate ${result.snapshot.encodeUs.deflate.toFixed(1)})`,
    );
    const perPlayer = (encoding: "json" | "msgpack") => {
      const { snapshots, worldEvents } = result.perPlayerKbPerSecond[encoding];
      return `${encoding} ${snapshots.toFixed(1)} + ${worldEvents.toFixed(1)} = ${(snapshots + worldEvents).toFixed(1)}`;
    };
    console.log(
      `per player KiB/s ${perPlayer("json")}  ${perPlayer("msgpack")}  (snapshots + world events)`,
    );
    console.log(`state checksum   ${result.checksum}`);
  }
  process.exit(0);
};

void main();
