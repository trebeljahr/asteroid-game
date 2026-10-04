import { z } from "zod";

import {
  AMMO_PACKET_SPAWN_INTERVAL_MS,
  ASTEROID_RESPAWN_INTERVAL_MS,
  ASTEROID_TARGET_COUNT,
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  advanceRuntimeBulletState,
  BULLET_DIAMETER,
  circleOverlapsShipCollider,
  circlesOverlap,
  createEmptyInputState,
  createInitialMatchWorld,
  createRuntimeBulletState,
  createRuntimePlayerState,
  createSeededRandomState,
  FIRE_COOLDOWN_TICKS,
  getNearbyAmmoPackets,
  getNearbyAsteroids,
  getNearbyHearts,
  getShipCollider,
  getShipCollisionBoundingDiameter,
  HEART_SPAWN_INTERVAL_MS,
  INACTIVE_MATCH_TIMEOUT_MS,
  isRuntimeBulletOutOfBounds,
  LOCAL_INPUT_PUSH_INTERVAL_MS,
  MATCH_COUNTDOWN_MS,
  MAX_AMMO_PACKET_COUNT,
  MAX_HEART_COUNT,
  type MatchEndedPayload,
  type MatchOutcome,
  type MatchPlayerSnapshot,
  type MatchResumedPayload,
  type MatchSnapshotPayload,
  type MatchWorldEventsPayload,
  MULTIPLAYER_ARENA,
  type MultiplayerRuntimeConfig,
  nextSeededRandom,
  PLAYER_DAMAGE_RECOVERY_TICKS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  removeAmmoFromWorld,
  removeAsteroidFromWorld,
  removeHeartFromWorld,
  resolvePlayerCollision,
  shipCollidersOverlap,
  snapshotPlayerState,
  spawnAmmoFromRandom,
  spawnAsteroidFromRandom,
  spawnHeartFromRandom,
  stepPlayerState,
  type WorldEvent,
} from "../../shared/src";
import type { MatchResultEntry } from "./achievementService";
import { hashResumeToken, newMatchId, newPlayerId, newResumeToken } from "./realtime/ids";
import {
  baseSnapshotSchema,
  type HostContext,
  type HostMatch,
  type HostParticipant,
  MatchHostBase,
  participantSchema,
} from "./realtime/matchHost";
import type { LeaseFence, Ticket } from "./realtime/store";

type DuelParticipant = HostParticipant;
type DuelMatch = HostMatch<DuelParticipant>;

const duelSnapshotSchema = baseSnapshotSchema.extend({
  mode: z.literal("duel"),
  players: z.array(participantSchema).length(2),
});

const getOutcomeForPlayer = (playerId: string, winnerId: string | null): MatchOutcome => {
  if (winnerId === null) {
    return "draw";
  }
  return playerId === winnerId ? "win" : "loss";
};

const roomIdFor = (matchId: string) => `multiplayer:${matchId}`;

export const getMultiplayerRuntimeConfig = (): MultiplayerRuntimeConfig => {
  return {
    inputPushIntervalMs: LOCAL_INPUT_PUSH_INTERVAL_MS,
    serverAuthorityMode: "authoritative",
    worldSyncMode: "seed-plus-events",
  };
};

/**
 * Authoritative 1v1 duels. Any replica may own a match; players can be
 * connected to other replicas, so every emit goes through the Socket.IO
 * adapter by socket ID or room, never through a local socket object.
 */
export class MultiplayerService extends MatchHostBase<DuelParticipant, DuelMatch> {
  readonly mode = "duel" as const;
  protected readonly arena = MULTIPLAYER_ARENA;

  constructor(ctx: HostContext) {
    super(ctx);
  }

  /**
   * Create a match from two matchmaking tickets. The tickets were
   * already removed from the shared queue by this replica.
   */
  async createMatch(tickets: Ticket[]) {
    const matchId = newMatchId("match");
    const fence = await this.ctx.durability.open(matchId, this.mode);
    const now = Date.now();
    const worldSeed = Math.floor(Math.random() * 0xffffffff);
    const tokens = tickets.map(() => newResumeToken());
    const players = tickets.slice(0, 2).map((ticket, index): DuelParticipant => {
      const playerId = newPlayerId();
      return {
        detachedAt: null,
        input: createEmptyInputState(),
        inputQueue: [],
        playerId,
        replicaId: ticket.replicaId,
        resumeTokenHash: hashResumeToken(tokens[index]),
        socketId: ticket.socketId,
        state: createRuntimePlayerState(
          playerId,
          index === 0 ? "alpha" : "beta",
          MULTIPLAYER_ARENA,
          ticket.shipVariant,
        ),
        userId: ticket.userId,
      };
    });

    const match: DuelMatch = {
      bullets: [],
      counters: { ammo: 0, asteroid: 0, bullet: 0, heart: 0 },
      countdownEndsAt: now + MATCH_COUNTDOWN_MS,
      fence,
      frozen: false,
      id: matchId,
      lastActivityAt: now,
      pendingSpawnDelays: null,
      phase: "countdown",
      players,
      random: createSeededRandomState((worldSeed ^ 0x9e3779b9) >>> 0),
      roomId: roomIdFor(matchId),
      sequence: 0,
      spawnAt: {
        ammo: now + AMMO_PACKET_SPAWN_INTERVAL_MS,
        asteroid: now + ASTEROID_RESPAWN_INTERVAL_MS,
        heart: now + HEART_SPAWN_INTERVAL_MS,
      },
      world: createInitialMatchWorld(worldSeed, MULTIPLAYER_ARENA),
      worldSeed,
      worldVersion: 0,
    };

    this.matches.set(matchId, match);

    for (let index = 0; index < players.length; index++) {
      const participant = players[index];
      const opponent = players[(index + 1) % players.length];
      this.seatParticipant(match, participant);
      if (participant.socketId === null) continue;
      this.ctx.io.to(participant.socketId).emit("match:found", {
        arena: MULTIPLAYER_ARENA,
        countdownMs: MATCH_COUNTDOWN_MS,
        matchId,
        maxHealth: PLAYER_MAX_HEALTH,
        opponentId: opponent.playerId,
        playerId: participant.playerId,
        resumeToken: tokens[index],
        slot: participant.state.slot,
        worldSeed,
      });
    }

    this.emitSnapshot(match);
  }

  protected roomIdFor(matchId: string) {
    return roomIdFor(matchId);
  }

  protected emitSnapshot(match: DuelMatch) {
    this.ctx.io.to(match.roomId).emit("match:snapshot", this.buildDynamicSnapshot(match));
  }

  protected emitMigrating(match: DuelMatch) {
    this.ctx.io.to(match.roomId).emit("match:migrating", { matchId: match.id });
  }

  protected emitRestartEnded(matchId: string) {
    this.ctx.io.to(roomIdFor(matchId)).emit("match:ended", {
      matchId,
      outcome: "draw",
      reason: "server-restart",
      winnerId: null,
    });
  }

  protected emitWorldEvents(match: DuelMatch, events: WorldEvent[]) {
    if (events.length === 0) {
      return;
    }

    match.worldVersion++;
    const payload: MatchWorldEventsPayload = {
      events,
      matchId: match.id,
      worldVersion: match.worldVersion,
    };
    this.ctx.io.to(match.roomId).emit("match:world-events", payload);
  }

  protected forfeit(match: DuelMatch, participant: DuelParticipant) {
    const opponent = match.players.find((player) => player !== participant);
    this.finishMatch(match, {
      excludedPlayerId: participant.playerId,
      reason: "opponent-left",
      winnerId: opponent?.playerId ?? null,
    });
  }

  protected endUncounted(match: DuelMatch) {
    this.finishMatch(match, { reason: "server-restart", winnerId: null });
  }

  protected buildResumedPayload(
    match: DuelMatch,
    participant: DuelParticipant,
  ): MatchResumedPayload {
    const opponent = match.players.find((player) => player !== participant) ?? null;
    return {
      arena: MULTIPLAYER_ARENA,
      matchId: match.id,
      maxHealth: PLAYER_MAX_HEALTH,
      mode: "duel",
      opponentId: opponent?.playerId ?? null,
      placement: null,
      playerId: participant.playerId,
      playerIds: match.players.map((player) => player.playerId),
      slot: participant.state.slot,
      snapshot: this.buildDynamicSnapshot(match),
      survivorsRemaining: match.players.filter((player) => player.state.health > 0).length,
      world: this.worldLists(match),
    };
  }

  protected serializeMatch(match: DuelMatch) {
    return {
      ...this.serializeBase(match),
      mode: "duel" as const,
      players: match.players.map((participant) => this.serializeParticipant(participant)),
    };
  }

  protected restoreMatch(fence: LeaseFence, state: unknown, now: number): DuelMatch | null {
    const parsed = duelSnapshotSchema.safeParse(state);
    if (!parsed.success) {
      console.warn(
        `[handoff] invalid duel snapshot for ${fence.matchId}`,
        parsed.error.issues[0]?.message,
      );
      return null;
    }
    return {
      ...this.restoreBase(fence, parsed.data, now),
      players: parsed.data.players.map((player) => this.restoreParticipantBase(player, now)),
    };
  }

  protected stepActive(match: DuelMatch, worldEvents: WorldEvent[]) {
    const previousStates = match.players.map((participant) => {
      return {
        angle: participant.state.angle,
        x: participant.state.x,
        y: participant.state.y,
      };
    });
    const previousBulletCount = match.bullets.length;
    const playerDamageById = new Map<string, number>();
    const healingByPlayerId = new Map<string, number>();
    const asteroidDamageById = new Map<string, number>();

    // World spawns are time-based — run once per real tick.
    this.updateWorldSpawns(match, worldEvents);

    // Run sub-steps to drain each player's input queue.  On a good
    // connection this is 1 step.  On high latency, inputs arrive in
    // bursts and we need to step the FULL simulation (players +
    // bullets + collisions) for each queued input so that collision
    // detection stays synchronised with intermediate positions.
    const subSteps = Math.max(
      1,
      match.players[0].inputQueue.length,
      match.players[1].inputQueue.length,
    );
    for (let subStep = 0; subStep < subSteps; subStep++) {
      this.stepPlayersOnce(match);
      this.handlePlayerShipCollision(match, playerDamageById);
      this.handlePlayerAsteroidCollisions(match, playerDamageById, worldEvents);
      this.handleBulletCollisions(match, playerDamageById, asteroidDamageById);
      this.applyAsteroidDamage(match, asteroidDamageById, worldEvents);
      this.applyHeartCollections(match, healingByPlayerId, worldEvents);
      this.applyAmmoCollections(match, worldEvents);
      this.applyPlayerDamageAndHealing(match, playerDamageById, healingByPlayerId);

      // Reset per-step accumulators for the next sub-step.
      playerDamageById.clear();
      healingByPlayerId.clear();
      asteroidDamageById.clear();
    }

    if (this.hasMeaningfulActivity(match, previousStates, previousBulletCount)) {
      match.lastActivityAt = Date.now();
    }

    if (this.finishIfMatchOver(match, worldEvents)) {
      return true;
    }

    const isDev = process.env.NODE_ENV === "development";
    if (!isDev && Date.now() - match.lastActivityAt >= INACTIVE_MATCH_TIMEOUT_MS) {
      this.finishMatch(match, {
        reason: "inactive",
        winnerId: null,
      });
      return true;
    }
    return false;
  }

  private applyAsteroidDamage(
    match: DuelMatch,
    asteroidDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    for (const [asteroidId, damage] of asteroidDamageById.entries()) {
      const asteroid = match.world.asteroids.get(asteroidId);
      if (asteroid === undefined) {
        continue;
      }

      asteroid.hitPoints -= damage;
      if (asteroid.hitPoints > 0) {
        continue;
      }

      if (removeAsteroidFromWorld(match.world, asteroidId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          asteroidId,
          type: "asteroid-removed",
        });
      }
    }
  }

  private applyHeartCollections(
    match: DuelMatch,
    healingByPlayerId: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    const collectedHeartIds = new Set<string>();

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      if (participant.state.health <= 0) {
        continue;
      }
      const shipCollider = getShipCollider(
        participant.state.x,
        participant.state.y,
        participant.state.angle,
        participant.state.shipVariant,
      );

      const nearbyHearts = getNearbyHearts(
        match.world,
        participant.state.x,
        participant.state.y,
        getShipCollisionBoundingDiameter(participant.state.shipVariant),
        MULTIPLAYER_ARENA,
      );

      for (let heartIndex = 0; heartIndex < nearbyHearts.length; heartIndex++) {
        const heart = nearbyHearts[heartIndex];
        if (collectedHeartIds.has(heart.id)) {
          continue;
        }

        if (circleOverlapsShipCollider(heart.x, heart.y, heart.size, shipCollider)) {
          collectedHeartIds.add(heart.id);
          if (participant.state.health < PLAYER_MAX_HEALTH) {
            healingByPlayerId.set(
              participant.state.id,
              (healingByPlayerId.get(participant.state.id) ?? 0) + 1,
            );
          }
          break;
        }
      }
    }

    collectedHeartIds.forEach((heartId) => {
      if (removeHeartFromWorld(match.world, heartId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          heartId,
          type: "heart-removed",
        });
      }
    });
  }

  private applyAmmoCollections(match: DuelMatch, worldEvents: WorldEvent[]) {
    const collectedAmmoIds = new Set<string>();

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      if (participant.state.health <= 0) {
        continue;
      }
      const shipCollider = getShipCollider(
        participant.state.x,
        participant.state.y,
        participant.state.angle,
        participant.state.shipVariant,
      );

      const nearbyAmmoPackets = getNearbyAmmoPackets(
        match.world,
        participant.state.x,
        participant.state.y,
        getShipCollisionBoundingDiameter(participant.state.shipVariant),
        MULTIPLAYER_ARENA,
      );

      for (let ammoPacketIndex = 0; ammoPacketIndex < nearbyAmmoPackets.length; ammoPacketIndex++) {
        const ammoPacket = nearbyAmmoPackets[ammoPacketIndex];
        if (collectedAmmoIds.has(ammoPacket.id)) {
          continue;
        }

        if (circleOverlapsShipCollider(ammoPacket.x, ammoPacket.y, ammoPacket.size, shipCollider)) {
          collectedAmmoIds.add(ammoPacket.id);
          participant.state.ammo = Math.min(
            PLAYER_MAX_AMMO,
            participant.state.ammo + ammoPacket.amount,
          );
          break;
        }
      }
    }

    collectedAmmoIds.forEach((ammoId) => {
      if (removeAmmoFromWorld(match.world, ammoId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          ammoId,
          type: "ammo-removed",
        });
      }
    });
  }

  private applyPlayerDamageAndHealing(
    match: DuelMatch,
    playerDamageById: Map<string, number>,
    healingByPlayerId: Map<string, number>,
  ) {
    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      const damage = playerDamageById.get(participant.state.id) ?? 0;
      const healing = healingByPlayerId.get(participant.state.id) ?? 0;

      if (damage > 0) {
        participant.state.health = Math.max(0, participant.state.health - damage);
        participant.state.damageRecoveryTicks = PLAYER_DAMAGE_RECOVERY_TICKS;
      }

      if (participant.state.health > 0 && healing > 0) {
        participant.state.health = Math.min(PLAYER_MAX_HEALTH, participant.state.health + healing);
      }
    }
  }

  private handleBulletCollisions(
    match: DuelMatch,
    playerDamageById: Map<string, number>,
    asteroidDamageById: Map<string, number>,
  ) {
    for (let bulletIndex = match.bullets.length - 1; bulletIndex >= 0; bulletIndex--) {
      const bullet = match.bullets[bulletIndex];
      advanceRuntimeBulletState(bullet);

      if (isRuntimeBulletOutOfBounds(bullet, MULTIPLAYER_ARENA)) {
        match.bullets.splice(bulletIndex, 1);
        continue;
      }

      let consumedBullet = false;
      const nearbyAsteroids = getNearbyAsteroids(
        match.world,
        bullet.x,
        bullet.y,
        BULLET_DIAMETER,
        MULTIPLAYER_ARENA,
      );

      for (let asteroidIndex = 0; asteroidIndex < nearbyAsteroids.length; asteroidIndex++) {
        const asteroid = nearbyAsteroids[asteroidIndex];
        if (
          circlesOverlap(bullet.x, bullet.y, BULLET_DIAMETER, asteroid.x, asteroid.y, asteroid.size)
        ) {
          asteroidDamageById.set(asteroid.id, (asteroidDamageById.get(asteroid.id) ?? 0) + 1);
          consumedBullet = true;
          break;
        }
      }

      if (consumedBullet) {
        match.bullets.splice(bulletIndex, 1);
        continue;
      }

      for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
        const participant = match.players[playerIndex];
        if (
          participant.state.id === bullet.ownerId ||
          participant.state.health <= 0 ||
          participant.state.damageRecoveryTicks > 0
        ) {
          continue;
        }

        if (
          circleOverlapsShipCollider(
            bullet.x,
            bullet.y,
            BULLET_DIAMETER,
            getShipCollider(
              participant.state.x,
              participant.state.y,
              participant.state.angle,
              participant.state.shipVariant,
            ),
          )
        ) {
          playerDamageById.set(
            participant.state.id,
            (playerDamageById.get(participant.state.id) ?? 0) + 1,
          );
          consumedBullet = true;
          break;
        }
      }

      if (consumedBullet) {
        match.bullets.splice(bulletIndex, 1);
      }
    }
  }

  private handlePlayerAsteroidCollisions(
    match: DuelMatch,
    playerDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    const destroyedAsteroidIds = new Set<string>();

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      if (participant.state.health <= 0 || participant.state.damageRecoveryTicks > 0) {
        continue;
      }
      const shipCollider = getShipCollider(
        participant.state.x,
        participant.state.y,
        participant.state.angle,
        participant.state.shipVariant,
      );

      const nearbyAsteroids = getNearbyAsteroids(
        match.world,
        participant.state.x,
        participant.state.y,
        getShipCollisionBoundingDiameter(participant.state.shipVariant),
        MULTIPLAYER_ARENA,
      );

      for (let asteroidIndex = 0; asteroidIndex < nearbyAsteroids.length; asteroidIndex++) {
        const asteroid = nearbyAsteroids[asteroidIndex];
        if (destroyedAsteroidIds.has(asteroid.id)) {
          continue;
        }

        if (circleOverlapsShipCollider(asteroid.x, asteroid.y, asteroid.size, shipCollider)) {
          playerDamageById.set(
            participant.state.id,
            (playerDamageById.get(participant.state.id) ?? 0) + 1,
          );
          destroyedAsteroidIds.add(asteroid.id);
          break;
        }
      }
    }

    destroyedAsteroidIds.forEach((asteroidId) => {
      if (removeAsteroidFromWorld(match.world, asteroidId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          asteroidId,
          type: "asteroid-removed",
        });
      }
    });
  }

  private handlePlayerShipCollision(match: DuelMatch, playerDamageById: Map<string, number>) {
    const alphaPlayer = match.players[0];
    const betaPlayer = match.players[1];

    if (alphaPlayer.state.health <= 0 || betaPlayer.state.health <= 0) {
      return;
    }

    if (
      !shipCollidersOverlap(
        getShipCollider(
          alphaPlayer.state.x,
          alphaPlayer.state.y,
          alphaPlayer.state.angle,
          alphaPlayer.state.shipVariant,
        ),
        getShipCollider(
          betaPlayer.state.x,
          betaPlayer.state.y,
          betaPlayer.state.angle,
          betaPlayer.state.shipVariant,
        ),
      )
    ) {
      return;
    }

    resolvePlayerCollision(alphaPlayer.state, betaPlayer.state, MULTIPLAYER_ARENA);

    if (alphaPlayer.state.damageRecoveryTicks === 0) {
      playerDamageById.set(
        alphaPlayer.state.id,
        (playerDamageById.get(alphaPlayer.state.id) ?? 0) + 1,
      );
    }

    if (betaPlayer.state.damageRecoveryTicks === 0) {
      playerDamageById.set(
        betaPlayer.state.id,
        (playerDamageById.get(betaPlayer.state.id) ?? 0) + 1,
      );
    }
  }

  private hasMeaningfulActivity(
    match: DuelMatch,
    previousStates: Array<{
      angle: number;
      x: number;
      y: number;
    }>,
    previousBulletCount: number,
  ) {
    if (match.bullets.length > 0 || previousBulletCount > 0) {
      return true;
    }

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      const previousState = previousStates[playerIndex];
      const positionDelta = Math.hypot(
        participant.state.x - previousState.x,
        participant.state.y - previousState.y,
      );
      const angleDelta = Math.abs(participant.state.angle - previousState.angle);
      const speed = Math.hypot(participant.state.vx, participant.state.vy);

      if (
        positionDelta > 0.08 ||
        angleDelta > 0.004 ||
        speed > 0.08 ||
        participant.input.thrust ||
        participant.input.turnLeft ||
        participant.input.turnRight
      ) {
        return true;
      }
    }

    return false;
  }

  private buildDynamicSnapshot(match: DuelMatch): MatchSnapshotPayload {
    const debug: Record<string, { inputQueueDepth: number }> = {};
    for (let i = 0; i < match.players.length; i++) {
      const participant = match.players[i];
      debug[participant.playerId] = {
        inputQueueDepth: participant.inputQueue.length,
      };
    }

    return {
      bullets: match.bullets.map((bullet) => {
        return {
          id: bullet.id,
          ownerId: bullet.ownerId,
          vx: bullet.vx,
          vy: bullet.vy,
          x: bullet.x,
          y: bullet.y,
        };
      }),
      countdownMs: this.countdownRemainingMs(match),
      debug,
      matchId: match.id,
      phase: match.phase,
      players: match.players.map((participant): MatchPlayerSnapshot => {
        return snapshotPlayerState(participant.state);
      }),
      sequence: match.sequence,
    };
  }

  private finishIfMatchOver(match: DuelMatch, worldEvents: WorldEvent[]) {
    const survivingPlayers = match.players.filter((participant) => {
      return participant.state.health > 0;
    });

    if (survivingPlayers.length === 2) {
      return false;
    }

    this.emitWorldEvents(match, worldEvents);
    this.emitSnapshot(match);

    this.finishMatch(match, {
      reason: "destroyed",
      winnerId: survivingPlayers.length === 1 ? survivingPlayers[0].playerId : null,
    });
    return true;
  }

  private finishMatch(
    match: DuelMatch,
    options: {
      excludedPlayerId?: string;
      reason: MatchEndedPayload["reason"];
      winnerId: string | null;
    },
  ) {
    this.closeMatch(match);

    const results: MatchResultEntry[] = [];
    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      if (participant.playerId === options.excludedPlayerId) {
        continue;
      }

      const outcome = getOutcomeForPlayer(participant.playerId, options.winnerId);
      if (participant.socketId !== null) {
        this.ctx.io.to(participant.socketId).emit("match:ended", {
          matchId: match.id,
          outcome,
          reason: options.reason,
          winnerId: options.winnerId,
        });
      }

      if (participant.userId !== null && options.reason !== "server-restart") {
        const delta =
          outcome === "win"
            ? { multiplayerWins: 1, opponentsEliminated: 1 }
            : outcome === "loss"
              ? { multiplayerLosses: 1 }
              : { multiplayerDraws: 1 };
        results.push({
          delta,
          event: { type: "mp.matchEnded", outcome },
          outcome,
          userId: participant.userId,
        });
      }
    }

    // Best-effort: never block the finish path on database writes. The
    // write is fenced on the lease and idempotent per match and user.
    void this.ctx.durability.finish(match.fence, results);
  }

  private getPlayerPositions(match: DuelMatch) {
    return match.players.map((participant) => {
      return {
        x: participant.state.x,
        y: participant.state.y,
      };
    });
  }

  private stepPlayersOnce(match: DuelMatch) {
    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];

      // Pop one input from the queue (if available), or reuse the last
      // applied input.  The caller runs this in a sub-step loop so that
      // all queued inputs are consumed — one physics step per input,
      // matching the client's prediction tick count.
      if (participant.inputQueue.length > 0) {
        participant.input = participant.inputQueue.shift()!;
        participant.state.lastInputSeq = participant.input.inputSeq;
      }

      stepPlayerState(participant.state, participant.input, MULTIPLAYER_ARENA);

      if (
        participant.state.health > 0 &&
        participant.input.fire &&
        participant.state.fireCooldownTicks === 0 &&
        participant.state.ammo > 0
      ) {
        match.bullets.push(
          createRuntimeBulletState(participant.state, `bullet-${++match.counters.bullet}`),
        );
        participant.state.ammo--;
        participant.state.fireCooldownTicks = FIRE_COOLDOWN_TICKS;
      }
    }
  }

  private updateWorldSpawns(match: DuelMatch, worldEvents: WorldEvent[]) {
    const now = Date.now();
    const playerPositions = this.getPlayerPositions(match);
    const random = () => nextSeededRandom(match.random);

    if (match.world.asteroids.size < ASTEROID_TARGET_COUNT && now >= match.spawnAt.asteroid) {
      const asteroid = spawnAsteroidFromRandom(
        match.world,
        playerPositions,
        random,
        `asteroid:spawn:${++match.counters.asteroid}`,
        MULTIPLAYER_ARENA,
      );

      if (asteroid !== null) {
        addAsteroidToWorld(match.world, asteroid, MULTIPLAYER_ARENA);
        worldEvents.push({
          asteroid,
          type: "asteroid-spawned",
        });
      }

      match.spawnAt.asteroid = now + ASTEROID_RESPAWN_INTERVAL_MS;
    }

    if (match.world.hearts.size < MAX_HEART_COUNT && now >= match.spawnAt.heart) {
      const heart = spawnHeartFromRandom(
        match.world,
        playerPositions,
        random,
        `heart:spawn:${++match.counters.heart}`,
        MULTIPLAYER_ARENA,
      );

      if (heart !== null) {
        addHeartToWorld(match.world, heart, MULTIPLAYER_ARENA);
        worldEvents.push({
          heart,
          type: "heart-spawned",
        });
      }

      match.spawnAt.heart = now + HEART_SPAWN_INTERVAL_MS;
    }

    if (match.world.ammunitionPackets.size < MAX_AMMO_PACKET_COUNT && now >= match.spawnAt.ammo) {
      const ammo = spawnAmmoFromRandom(
        match.world,
        playerPositions,
        random,
        `ammo:spawn:${++match.counters.ammo}`,
        MULTIPLAYER_ARENA,
      );

      if (ammo !== null) {
        addAmmoToWorld(match.world, ammo, MULTIPLAYER_ARENA);
        worldEvents.push({
          ammo,
          type: "ammo-spawned",
        });
      }

      match.spawnAt.ammo = now + AMMO_PACKET_SPAWN_INTERVAL_MS;
    }
  }
}
