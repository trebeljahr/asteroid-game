import { performance } from "node:perf_hooks";
import type { Server } from "socket.io";
import { z } from "zod";

import {
  type ArenaConfig,
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  type ClientToServerEvents,
  createEmptyInputState,
  createEmptyMatchWorld,
  FixedStepClock,
  getShipCollider,
  type MatchMode,
  type MatchPhase,
  type MatchResumedPayload,
  type MatchResumeResult,
  type MatchWorldRuntime,
  MULTIPLAYER_SHIP_VARIANTS,
  type RuntimeBulletState,
  type RuntimePlayerState,
  type SeededRandomState,
  type ServerToClientEvents,
  type ShipCollider,
  type ShipInputState,
  TICK_INTERVAL_MS,
  updateShipCollider,
  type WorldEvent,
} from "../../../shared/src";
import type { SocketRoute } from "./bus";
import { RESUME_COUNTDOWN_MS, RESUME_GRACE_MS } from "./config";
import type { MatchDurability } from "./durability";
import { resumeTokenMatches } from "./ids";
import {
  createInputPacing,
  INPUT_QUEUE_LIMIT,
  type InputPacing,
  takeInputsForTick,
} from "./inputPacing";
import type { LeaseFence, StoredSnapshot } from "./store";

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface RouteRegistry {
  bind(socketId: string, replicaId: string, route: SocketRoute): void;
  unbind(socketId: string, replicaId: string, matchId: string): void;
}

export interface HostContext {
  durability: MatchDurability;
  io: TypedServer;
  /** Monotonic clock in milliseconds that paces the simulation. Tests replace it. */
  now?: () => number;
  replicaId: string;
  routes: RouteRegistry;
}

/**
 * One seat in a match. `playerId` is the stable identity that clients,
 * bullets and snapshots use. The socket can change: it is null while the
 * player is disconnected or after a handoff until they resume.
 */
export interface HostParticipant {
  /** Reused between ticks; read it through `shipCollider`. Never serialized. */
  collider: ShipCollider | null;
  detachedAt: number | null;
  input: ShipInputState;
  inputPacing: InputPacing;
  inputQueue: ShipInputState[];
  playerId: string;
  replicaId: string | null;
  resumeTokenHash: string;
  socketId: string | null;
  state: RuntimePlayerState;
  userId: string | null;
}

/** One step of one ship, due on the current tick. */
export interface PlayerStep<P extends HostParticipant> {
  input: ShipInputState;
  participant: P;
}

/**
 * Ticks run back to back after the event loop stalls, so the simulation
 * stays on real time. Beyond this many the missed time is dropped.
 */
const MAX_CATCH_UP_TICKS = 8;

export interface SpawnDelays {
  ammo: number;
  asteroid: number;
  heart: number;
}

export interface MatchCounters {
  ammo: number;
  asteroid: number;
  bullet: number;
  heart: number;
}

export interface HostMatch<P extends HostParticipant> {
  bullets: RuntimeBulletState[];
  /** Per-match, persisted with the snapshot, so IDs stay unique after a handoff. */
  counters: MatchCounters;
  /** Null while a restored match waits for its players to come back. */
  countdownEndsAt: number | null;
  fence: LeaseFence;
  /** Set during drain: the match no longer ticks or emits. */
  frozen: boolean;
  id: string;
  lastActivityAt: number;
  /** Spawn delays to apply when a restored match becomes active again. */
  pendingSpawnDelays: SpawnDelays | null;
  phase: MatchPhase;
  players: P[];
  random: SeededRandomState;
  roomId: string;
  sequence: number;
  spawnAt: SpawnDelays;
  world: MatchWorldRuntime;
  worldSeed: number;
  worldVersion: number;
}

const finite = z.number().refine(Number.isFinite);
const count = z.number().int().nonnegative();

const runtimePlayerSchema = z.object({
  angle: finite,
  ammo: count,
  damageRecoveryTicks: count,
  fireCooldownTicks: count,
  health: count,
  id: z.string().min(1),
  lastInputSeq: count,
  shipVariant: z.enum(MULTIPLAYER_SHIP_VARIANTS as unknown as [string, ...string[]]),
  slot: z.enum(["alpha", "beta"]),
  thrusting: z.boolean(),
  vx: finite,
  vy: finite,
  x: finite,
  y: finite,
});

const participantSchema = z.object({
  playerId: z.string().min(1),
  resumeTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: runtimePlayerSchema,
  userId: z.string().nullable(),
});

/** Fields every match snapshot carries, duel or battle royale. */
export const baseSnapshotSchema = z.object({
  bullets: z.array(
    z.object({
      id: z.string(),
      ownerId: z.string(),
      ttlTicks: z.number().int(),
      vx: finite,
      vy: finite,
      x: finite,
      y: finite,
    }),
  ),
  counters: z.object({ ammo: count, asteroid: count, bullet: count, heart: count }),
  matchId: z.string().min(1),
  phase: z.enum(["active", "countdown"]),
  randomState: z.number().int(),
  sequence: count,
  spawnDelaysMs: z.object({ ammo: count, asteroid: count, heart: count }),
  version: z.literal(1),
  world: z.object({
    ammo: z.array(z.object({ amount: count, id: z.string(), size: finite, x: finite, y: finite })),
    asteroids: z.array(
      z.object({
        baseRotation: finite,
        hitPoints: z.number().int(),
        id: z.string(),
        size: finite,
        spinSpeed: finite,
        variant: z.number().int(),
        x: finite,
        y: finite,
      }),
    ),
    hearts: z.array(z.object({ id: z.string(), size: finite, x: finite, y: finite })),
  }),
  worldSeed: z.number().int(),
  worldVersion: count,
});

export { participantSchema };

export type BaseSnapshot = z.infer<typeof baseSnapshotSchema>;
export type ParticipantSnapshot = z.infer<typeof participantSchema>;

const remaining = (at: number, now: number) => Math.max(0, Math.round(at - now));

/**
 * Seats, reconnects, grace periods and durable snapshots shared by the
 * duel and battle-royale services. Subclasses own the simulation.
 */
export abstract class MatchHostBase<P extends HostParticipant, M extends HostMatch<P>> {
  abstract readonly mode: MatchMode;
  protected abstract readonly arena: ArenaConfig;
  protected matches = new Map<string, M>();
  /** socket.id → seat, for sockets attached to a match this replica owns. */
  protected seats = new Map<string, { matchId: string; playerId: string }>();
  private readonly now: () => number;
  private tickClock = new FixedStepClock(TICK_INTERVAL_MS, MAX_CATCH_UP_TICKS);

  constructor(protected ctx: HostContext) {
    this.now = ctx.now ?? (() => performance.now());
    this.tickClock.reset(this.now());
    this.scheduleTicks();
  }

  /**
   * Run the simulation at exactly the tick rate on average. A plain
   * `setInterval(TICK_INTERVAL_MS)` fires late and drifts, which would
   * leave the server slower than the clients that predict against it.
   */
  private scheduleTicks() {
    const delayMs = Math.max(1, Math.ceil(this.tickClock.msUntilNextStep(this.now())));
    const timer = setTimeout(() => {
      try {
        const dueTicks = this.tickClock.advance(this.now());
        for (let tick = 0; tick < dueTicks; tick++) {
          this.tickAll();
        }
      } finally {
        this.scheduleTicks();
      }
    }, delayMs);
    timer.unref?.();
  }

  /** One simulation step of an active match. Returns true when the match finished. */
  protected abstract stepActive(match: M, worldEvents: WorldEvent[]): boolean;
  protected abstract emitWorldEvents(match: M, events: WorldEvent[]): void;
  protected abstract emitSnapshot(match: M): void;
  protected abstract forfeit(match: M, participant: P): void;
  /** End without counting results: the server could not continue the match. */
  protected abstract endUncounted(match: M): void;
  protected abstract buildResumedPayload(match: M, participant: P): MatchResumedPayload;
  protected abstract serializeMatch(match: M): BaseSnapshot & Record<string, unknown>;
  protected abstract restoreMatch(fence: LeaseFence, state: unknown, now: number): M | null;
  protected abstract emitMigrating(match: M): void;

  get matchCount() {
    return this.matches.size;
  }

  hasMatch(matchId: string) {
    return this.matches.has(matchId);
  }

  fences(): LeaseFence[] {
    return Array.from(this.matches.values(), (match) => match.fence);
  }

  handleInput(matchId: string, socketId: string, input: ShipInputState) {
    const participant = this.participantForSocket(matchId, socketId);
    if (participant === null) return;
    // The sequence number is echoed in snapshots and stored in durable
    // match state, so it must be a plain counter value.
    if (!Number.isSafeInteger(input.inputSeq) || input.inputSeq < 0) return;
    // Queue the input. The tick loop applies queued inputs in order, one
    // ship step each.
    participant.inputQueue.push(input);
    if (participant.inputQueue.length > INPUT_QUEUE_LIMIT) {
      participant.inputQueue.shift();
    }
  }

  /**
   * A socket left its seat. An explicit leave forfeits at once; a lost
   * connection keeps the seat for the resume grace period.
   */
  handleDetach(matchId: string, socketId: string, explicit: boolean) {
    const match = this.matches.get(matchId);
    const participant = this.participantForSocket(matchId, socketId);
    if (match === undefined || participant === null) return false;
    this.seats.delete(socketId);
    participant.socketId = null;
    participant.replicaId = null;
    participant.detachedAt = Date.now();
    participant.input = createEmptyInputState();
    participant.inputQueue = [];
    if (explicit) {
      this.forfeit(match, participant);
    }
    return true;
  }

  attach(matchId: string, resumeToken: string, socketId: string, replicaId: string) {
    const match = this.matches.get(matchId);
    // Missing or frozen: a handoff is in flight; the client retries.
    if (match === undefined || match.frozen)
      return { status: "pending" } satisfies MatchResumeResult;
    const participant = match.players.find((player) => {
      return resumeTokenMatches(resumeToken, player.resumeTokenHash);
    });
    if (participant === undefined) return { status: "unknown" } satisfies MatchResumeResult;

    if (participant.socketId !== null && participant.socketId !== socketId) {
      this.releaseSocket(match, participant);
    }
    participant.socketId = socketId;
    participant.replicaId = replicaId;
    participant.detachedAt = null;
    participant.input = createEmptyInputState();
    participant.inputPacing = createInputPacing();
    participant.inputQueue = [];
    this.seats.set(socketId, { matchId, playerId: participant.playerId });
    this.ctx.io.in(socketId).socketsJoin(match.roomId);
    this.ctx.io.to(socketId).emit("match:resumed", this.buildResumedPayload(match, participant));
    return { status: "resumed" } satisfies MatchResumeResult;
  }

  /** Load a claimed match from its snapshot. Returns false if the snapshot is unusable. */
  restore(fence: LeaseFence, snapshot: StoredSnapshot | null) {
    if (snapshot === null || snapshot.matchId !== fence.matchId || snapshot.epoch >= fence.epoch) {
      return false;
    }
    let match: M | null = null;
    try {
      match = this.restoreMatch(fence, snapshot.state, Date.now());
    } catch (error) {
      console.warn(`[handoff] snapshot for ${fence.matchId} failed to load`, error);
      return false;
    }
    if (match === null || match.id !== fence.matchId) return false;
    this.matches.set(match.id, match);
    // Clients still in the room (their socket stayed on a live replica)
    // learn about the new owner here and re-attach.
    this.emitMigrating(match);
    return true;
  }

  /** End a claimed match whose snapshot could not be used: uncounted, as a restart. */
  endUnrecoverable(fence: LeaseFence) {
    this.emitRestartEnded(fence.matchId);
    void this.ctx.durability.finish(fence, []);
  }

  protected abstract roomIdFor(matchId: string): string;
  protected abstract emitRestartEnded(matchId: string): void;

  /** The lease was lost: another replica owns this match now. Stop silently. */
  drop(matchId: string) {
    const match = this.matches.get(matchId);
    if (match === undefined) return;
    this.matches.delete(matchId);
    for (const participant of match.players) {
      if (participant.socketId !== null) this.seats.delete(participant.socketId);
    }
  }

  snapshotFor(matchId: string) {
    const match = this.matches.get(matchId);
    if (match === undefined || match.frozen) return null;
    return { fence: match.fence, sequence: match.sequence, state: this.serializeMatch(match) };
  }

  /**
   * Drain: stop ticking, tell clients to reconnect, write the final
   * snapshot and mark each lease `handoff`. A match that cannot be
   * handed off ends uncounted, as before durable handoff existed.
   */
  async beginDrain() {
    const matches = Array.from(this.matches.values());
    await Promise.all(
      matches.map(async (match) => {
        match.frozen = true;
        const state = this.serializeMatch(match);
        this.emitMigrating(match);
        const handedOff =
          this.ctx.durability.canHandOff &&
          (await this.ctx.durability.handoff(match.fence, match.sequence, state));
        if (handedOff) {
          this.forget(match);
          return;
        }
        match.frozen = false;
        this.endUncounted(match);
      }),
    );
  }

  /** Remove a match from this replica without notifying anyone. */
  protected forget(match: M) {
    this.matches.delete(match.id);
    for (const participant of match.players) {
      if (participant.socketId !== null) this.seats.delete(participant.socketId);
    }
  }

  /** Detach all sockets from a match that ended here and release the lease. */
  protected closeMatch(match: M) {
    this.matches.delete(match.id);
    for (const participant of match.players) {
      this.releaseSocket(match, participant);
      participant.input = createEmptyInputState();
    }
  }

  protected releaseSocket(match: M, participant: P) {
    if (participant.socketId === null) return;
    this.seats.delete(participant.socketId);
    this.ctx.io.in(participant.socketId).socketsLeave(match.roomId);
    if (participant.replicaId !== null) {
      this.ctx.routes.unbind(participant.socketId, participant.replicaId, match.id);
    }
  }

  /** Seat new players from matchmaking tickets: join room, route inputs here. */
  protected seatParticipant(match: M, participant: P) {
    if (participant.socketId === null || participant.replicaId === null) return;
    this.seats.set(participant.socketId, { matchId: match.id, playerId: participant.playerId });
    this.ctx.io.in(participant.socketId).socketsJoin(match.roomId);
    this.ctx.routes.bind(participant.socketId, participant.replicaId, {
      matchId: match.id,
      mode: this.mode,
      owner: this.ctx.replicaId,
    });
  }

  /**
   * The ship's collider at its current pose. Each participant keeps one
   * collider, rebuilt in place only after the ship moved or turned, so
   * collision checks against the same ship allocate nothing.
   */
  protected shipCollider(participant: P): ShipCollider {
    const { state } = participant;
    if (participant.collider === null) {
      participant.collider = getShipCollider(state.x, state.y, state.angle, state.shipVariant);
      return participant.collider;
    }
    return updateShipCollider(
      participant.collider,
      state.x,
      state.y,
      state.angle,
      state.shipVariant,
    );
  }

  protected participantForSocket(matchId: string, socketId: string) {
    const seat = this.seats.get(socketId);
    if (seat === undefined || seat.matchId !== matchId) return null;
    const match = this.matches.get(matchId);
    return match?.players.find((player) => player.playerId === seat.playerId) ?? null;
  }

  protected countdownRemainingMs(match: M, now = Date.now()) {
    if (match.phase !== "countdown") return 0;
    if (match.countdownEndsAt === null) return RESUME_COUNTDOWN_MS;
    return Math.max(0, match.countdownEndsAt - now);
  }

  protected serializeBase(match: M): BaseSnapshot {
    const now = Date.now();
    const delays = match.pendingSpawnDelays ?? {
      ammo: remaining(match.spawnAt.ammo, now),
      asteroid: remaining(match.spawnAt.asteroid, now),
      heart: remaining(match.spawnAt.heart, now),
    };
    return {
      bullets: match.bullets.map((bullet) => ({ ...bullet })),
      counters: { ...match.counters },
      matchId: match.id,
      phase: match.phase,
      randomState: match.random.state,
      sequence: match.sequence,
      spawnDelaysMs: delays,
      version: 1,
      world: {
        ammo: Array.from(match.world.ammunitionPackets.values(), (ammo) => ({ ...ammo })),
        asteroids: Array.from(match.world.asteroids.values(), (asteroid) => ({ ...asteroid })),
        hearts: Array.from(match.world.hearts.values(), (heart) => ({ ...heart })),
      },
      worldSeed: match.worldSeed,
      worldVersion: match.worldVersion,
    };
  }

  protected serializeParticipant(participant: P): ParticipantSnapshot {
    return {
      playerId: participant.playerId,
      resumeTokenHash: participant.resumeTokenHash,
      state: { ...participant.state },
      userId: participant.userId,
    };
  }

  /** Rebuild the shared part of a match. Players start detached until they resume. */
  protected restoreBase(
    fence: LeaseFence,
    snapshot: BaseSnapshot,
    now: number,
  ): Omit<HostMatch<P>, "players"> {
    const world = createEmptyMatchWorld();
    for (const asteroid of snapshot.world.asteroids)
      addAsteroidToWorld(world, asteroid, this.arena);
    for (const heart of snapshot.world.hearts) addHeartToWorld(world, heart, this.arena);
    for (const ammo of snapshot.world.ammo) addAmmoToWorld(world, ammo, this.arena);
    return {
      bullets: snapshot.bullets.map((bullet) => ({ ...bullet })),
      counters: { ...snapshot.counters },
      countdownEndsAt: null,
      fence,
      frozen: false,
      id: snapshot.matchId,
      lastActivityAt: now,
      pendingSpawnDelays: { ...snapshot.spawnDelaysMs },
      phase: "countdown",
      random: { state: snapshot.randomState },
      roomId: this.roomIdFor(snapshot.matchId),
      sequence: snapshot.sequence,
      spawnAt: { ammo: now, asteroid: now, heart: now },
      world,
      worldSeed: snapshot.worldSeed,
      worldVersion: snapshot.worldVersion,
    };
  }

  protected restoreParticipantBase(snapshot: ParticipantSnapshot, now: number): HostParticipant {
    return {
      collider: null,
      detachedAt: now,
      input: createEmptyInputState(),
      inputPacing: createInputPacing(),
      inputQueue: [],
      playerId: snapshot.playerId,
      replicaId: null,
      resumeTokenHash: snapshot.resumeTokenHash,
      socketId: null,
      state: {
        ...snapshot.state,
        shipVariant: snapshot.state.shipVariant as RuntimePlayerState["shipVariant"],
      },
      userId: snapshot.userId,
    };
  }

  protected worldLists(match: M): MatchResumedPayload["world"] {
    return {
      ammo: Array.from(match.world.ammunitionPackets.values()),
      asteroids: Array.from(match.world.asteroids.values()),
      hearts: Array.from(match.world.hearts.values()),
      worldVersion: match.worldVersion,
    };
  }

  /**
   * The ship steps due on this tick, in order. A ship steps once for each
   * input its player sent, so the server makes exactly the steps the
   * client predicted; a ship whose input has not arrived waits. A ship
   * nobody is steering (disconnected, or silent for a long time) drifts
   * with neutral controls instead.
   */
  protected playerStepsForTick(match: M): PlayerStep<P>[] {
    const steps: PlayerStep<P>[] = [];
    for (const participant of match.players) {
      if (participant.socketId === null) {
        steps.push({ input: createEmptyInputState(), participant });
        continue;
      }

      const due = takeInputsForTick(participant.inputPacing, participant.inputQueue);
      if (due.discardedThroughSeq !== null) {
        // Tell the client these inputs are gone, so it stops predicting them.
        participant.state.lastInputSeq = Math.max(
          participant.state.lastInputSeq,
          due.discardedThroughSeq,
        );
      }
      for (const input of due.apply) {
        steps.push({ input, participant });
      }
      if (due.coast) {
        steps.push({ input: createEmptyInputState(), participant });
      }
    }
    return steps;
  }

  private tickAll() {
    const now = Date.now();
    for (const match of Array.from(this.matches.values())) {
      if (!this.matches.has(match.id) || match.frozen) continue;
      // Fencing on the emit side: never simulate on a lease that may
      // already belong to another replica.
      if (!this.ctx.durability.leaseLive(match.id)) continue;
      this.tickMatch(match, now);
    }
  }

  private tickMatch(match: M, now: number) {
    match.sequence++;

    if (!this.expireDetached(match, now)) return;

    if (match.countdownEndsAt === null) {
      // Restored match: wait until every surviving player is back.
      const waiting = match.players.some((player) => {
        return player.state.health > 0 && player.socketId === null;
      });
      if (!waiting) {
        match.countdownEndsAt = now + RESUME_COUNTDOWN_MS;
      }
    }

    if (
      match.phase === "countdown" &&
      match.countdownEndsAt !== null &&
      now >= match.countdownEndsAt
    ) {
      match.phase = "active";
      match.lastActivityAt = now;
      if (match.pendingSpawnDelays !== null) {
        match.spawnAt = {
          ammo: now + match.pendingSpawnDelays.ammo,
          asteroid: now + match.pendingSpawnDelays.asteroid,
          heart: now + match.pendingSpawnDelays.heart,
        };
        match.pendingSpawnDelays = null;
      }
    }

    const worldEvents: WorldEvent[] = [];
    if (match.phase === "active" && this.stepActive(match, worldEvents)) {
      return;
    }

    this.emitWorldEvents(match, worldEvents);
    if (match.sequence % 2 === 0 || match.phase === "countdown") {
      this.emitSnapshot(match);
    }
  }

  /**
   * Forfeit players whose grace period ran out. If nobody is attached
   * any more, the match cannot continue fairly and ends uncounted.
   * Returns false if the match ended.
   */
  private expireDetached(match: M, now: number) {
    const anyAttached = match.players.some((player) => player.socketId !== null);
    const expired = match.players.filter((player) => {
      return (
        player.socketId === null &&
        player.detachedAt !== null &&
        player.state.health > 0 &&
        now - player.detachedAt >= RESUME_GRACE_MS
      );
    });
    if (expired.length === 0) return true;
    if (!anyAttached) {
      this.endUncounted(match);
      return false;
    }
    for (const participant of expired) {
      if (!this.matches.has(match.id)) return false;
      participant.detachedAt = null;
      this.forfeit(match, participant);
    }
    return this.matches.has(match.id);
  }
}
