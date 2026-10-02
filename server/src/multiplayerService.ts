import type { Server, Socket } from "socket.io";

import {
  AMMO_PACKET_SPAWN_INTERVAL_MS,
  ASTEROID_RESPAWN_INTERVAL_MS,
  ASTEROID_TARGET_COUNT,
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  advanceRuntimeBulletState,
  BULLET_DIAMETER,
  type ClientToServerEvents,
  circleOverlapsShipCollider,
  circlesOverlap,
  createEmptyInputState,
  createInitialMatchWorld,
  createRuntimeBulletState,
  createRuntimePlayerState,
  createSeededRandom,
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
  type MatchPhase,
  type MatchPlayerSnapshot,
  type MatchSnapshotPayload,
  type MatchWorldEventsPayload,
  type MatchWorldRuntime,
  MULTIPLAYER_ARENA,
  type MultiplayerRuntimeConfig,
  PLAYER_DAMAGE_RECOVERY_TICKS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  type PlayerSlot,
  type RuntimeBulletState,
  type RuntimePlayerState,
  removeAmmoFromWorld,
  removeAsteroidFromWorld,
  removeHeartFromWorld,
  resolvePlayerCollision,
  type ServerToClientEvents,
  type ShipInputState,
  type ShipVariant,
  SNAPSHOT_INTERVAL_TICKS,
  shipCollidersOverlap,
  snapshotPlayerState,
  spawnAmmoFromRandom,
  spawnAsteroidFromRandom,
  spawnHeartFromRandom,
  stepPlayerState,
  TICK_INTERVAL_MS,
  type WorldEvent,
} from "../../shared/src";
import { achievementService } from "./achievementService";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface MatchPlayer {
  input: ShipInputState;
  inputQueue: ShipInputState[];
  socket: TypedSocket;
  state: RuntimePlayerState;
}

interface MatchWorldState {
  nextAmmoSpawnAt: number;
  nextAsteroidSpawnAt: number;
  nextHeartSpawnAt: number;
  random: () => number;
  runtime: MatchWorldRuntime;
}

interface Match {
  bullets: RuntimeBulletState[];
  createdAt: number;
  id: string;
  lastActivityAt: number;
  phase: MatchPhase;
  players: [MatchPlayer, MatchPlayer];
  roomId: string;
  sequence: number;
  targetAsteroidCount: number;
  world: MatchWorldState;
  worldSeed: number;
  worldVersion: number;
}

const getOutcomeForPlayer = (playerId: string, winnerId: string | null): MatchOutcome => {
  if (winnerId === null) {
    return "draw";
  }
  return playerId === winnerId ? "win" : "loss";
};

export class MultiplayerService {
  private draining = false;
  private ammoCounter = 0;
  private asteroidCounter = 0;
  private bulletCounter = 0;
  private heartCounter = 0;
  private io: Server<ClientToServerEvents, ServerToClientEvents>;
  private matchCounter = 0;
  private matches = new Map<string, Match>();
  private socketToMatchId = new Map<string, string>();
  private sockets = new Map<string, TypedSocket>();
  private tickTimer: NodeJS.Timeout;
  private waitingQueue: Array<{ socketId: string; shipVariant: ShipVariant }> = [];

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>) {
    this.io = io;
    this.tickTimer = setInterval(() => {
      this.tickMatches();
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  enqueueSocketById(socketId: string, shipVariant: ShipVariant) {
    if (this.draining) return { enqueued: false as const, reason: "server-draining" as const };
    const socket = this.sockets.get(socketId);
    if (socket === undefined) {
      return { enqueued: false, reason: "socket-not-found" as const };
    }

    if (this.socketToMatchId.has(socketId)) {
      return { enqueued: false, reason: "already-matched" as const };
    }

    if (!this.waitingQueue.some((item) => item.socketId === socketId)) {
      this.waitingQueue.push({ socketId, shipVariant });
    }

    this.emitQueueStatus();
    this.tryCreateMatches();
    return { enqueued: true as const };
  }

  getRuntimeConfig(): MultiplayerRuntimeConfig {
    return {
      inputPushIntervalMs: LOCAL_INPUT_PUSH_INTERVAL_MS,
      serverAuthorityMode: "authoritative",
      worldSyncMode: "seed-plus-events",
    };
  }

  beginDrain() {
    this.draining = true;
    this.waitingQueue = [];
    for (const match of Array.from(this.matches.values())) {
      this.finishMatch(match, { reason: "server-restart", winnerId: null });
    }
    this.emitQueueStatus();
  }

  leaveSocketById(socketId: string) {
    if (this.dequeue(socketId)) {
      this.emitQueueStatus();
      return { removed: true as const, scope: "queue" as const };
    }

    const match = this.getMatchForSocket(socketId);
    if (match === null) {
      return { removed: false as const, scope: "none" as const };
    }

    const opponent = match.players.find((participant) => {
      return participant.socket.id !== socketId;
    });

    this.finishMatch(match, {
      excludedSocketId: socketId,
      reason: "opponent-left",
      winnerId: opponent?.socket.id ?? null,
    });
    return { removed: true as const, scope: "match" as const };
  }

  registerSocket(socket: TypedSocket) {
    this.sockets.set(socket.id, socket);

    socket.on("match:input", (payload) => {
      this.updatePlayerInput(socket.id, payload);
    });

    socket.on("disconnect", () => {
      this.handleDisconnect(socket.id);
    });
  }

  private applyAsteroidDamage(
    match: Match,
    asteroidDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    for (const [asteroidId, damage] of asteroidDamageById.entries()) {
      const asteroid = match.world.runtime.asteroids.get(asteroidId);
      if (asteroid === undefined) {
        continue;
      }

      asteroid.hitPoints -= damage;
      if (asteroid.hitPoints > 0) {
        continue;
      }

      if (removeAsteroidFromWorld(match.world.runtime, asteroidId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          asteroidId,
          type: "asteroid-removed",
        });
      }
    }
  }

  private applyHeartCollections(
    match: Match,
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
        match.world.runtime,
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
      if (removeHeartFromWorld(match.world.runtime, heartId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          heartId,
          type: "heart-removed",
        });
      }
    });
  }

  private applyAmmoCollections(match: Match, worldEvents: WorldEvent[]) {
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
        match.world.runtime,
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
      if (removeAmmoFromWorld(match.world.runtime, ammoId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          ammoId,
          type: "ammo-removed",
        });
      }
    });
  }

  private applyPlayerDamageAndHealing(
    match: Match,
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

  private buildDynamicSnapshot(match: Match): MatchSnapshotPayload {
    const countdownMs =
      match.phase === "countdown"
        ? Math.max(0, MATCH_COUNTDOWN_MS - (Date.now() - match.createdAt))
        : 0;

    const debug: Record<string, { inputQueueDepth: number }> = {};
    for (let i = 0; i < match.players.length; i++) {
      const participant = match.players[i];
      debug[participant.socket.id] = {
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
      countdownMs,
      debug,
      matchId: match.id,
      phase: match.phase,
      players: match.players.map((participant): MatchPlayerSnapshot => {
        return snapshotPlayerState(participant.state);
      }),
      sequence: match.sequence,
    };
  }

  private createMatchPlayer(
    socket: TypedSocket,
    slot: PlayerSlot,
    shipVariant: ShipVariant,
  ): MatchPlayer {
    return {
      input: createEmptyInputState(),
      inputQueue: [],
      socket,
      state: createRuntimePlayerState(socket.id, slot, MULTIPLAYER_ARENA, shipVariant),
    };
  }

  private createMatch(
    players: [
      { socket: TypedSocket; shipVariant: ShipVariant },
      { socket: TypedSocket; shipVariant: ShipVariant },
    ],
  ) {
    const matchId = `match-${++this.matchCounter}`;
    const roomId = `multiplayer:${matchId}`;
    const participants: [MatchPlayer, MatchPlayer] = [
      this.createMatchPlayer(players[0].socket, "alpha", players[0].shipVariant),
      this.createMatchPlayer(players[1].socket, "beta", players[1].shipVariant),
    ];
    const worldSeed = Math.floor(Math.random() * 0xffffffff);

    const match: Match = {
      bullets: [],
      createdAt: Date.now(),
      id: matchId,
      lastActivityAt: Date.now(),
      phase: "countdown",
      players: participants,
      roomId,
      sequence: 0,
      targetAsteroidCount: ASTEROID_TARGET_COUNT,
      world: {
        nextAmmoSpawnAt: Date.now() + AMMO_PACKET_SPAWN_INTERVAL_MS,
        nextAsteroidSpawnAt: Date.now() + ASTEROID_RESPAWN_INTERVAL_MS,
        nextHeartSpawnAt: Date.now() + HEART_SPAWN_INTERVAL_MS,
        random: createSeededRandom((worldSeed ^ 0x9e3779b9) >>> 0),
        runtime: createInitialMatchWorld(worldSeed, MULTIPLAYER_ARENA),
      },
      worldSeed,
      worldVersion: 0,
    };

    this.matches.set(matchId, match);

    for (let participantIndex = 0; participantIndex < participants.length; participantIndex++) {
      const participant = participants[participantIndex];
      const opponent = participants[(participantIndex + 1) % participants.length];
      this.socketToMatchId.set(participant.socket.id, matchId);
      participant.socket.join(roomId);
      participant.socket.emit("match:found", {
        arena: MULTIPLAYER_ARENA,
        countdownMs: MATCH_COUNTDOWN_MS,
        matchId,
        maxHealth: PLAYER_MAX_HEALTH,
        opponentId: opponent.socket.id,
        playerId: participant.socket.id,
        slot: participant.state.slot,
        worldSeed,
      });
    }

    this.emitDynamicSnapshot(match);
  }

  private dequeue(socketId: string) {
    const nextQueue = this.waitingQueue.filter((item) => {
      return item.socketId !== socketId;
    });

    const removed = nextQueue.length !== this.waitingQueue.length;
    this.waitingQueue = nextQueue;
    return removed;
  }

  private emitDynamicSnapshot(match: Match) {
    this.io.to(match.roomId).emit("match:snapshot", this.buildDynamicSnapshot(match));
  }

  private emitQueueStatus() {
    for (let queueIndex = 0; queueIndex < this.waitingQueue.length; queueIndex++) {
      const socket = this.sockets.get(this.waitingQueue[queueIndex].socketId);
      if (socket === undefined) {
        continue;
      }

      socket.emit("matchmaking:status", {
        position: queueIndex + 1,
        queueSize: this.waitingQueue.length,
      });
    }
  }

  private emitWorldEvents(match: Match, events: WorldEvent[]) {
    if (events.length === 0) {
      return;
    }

    match.worldVersion++;
    const payload: MatchWorldEventsPayload = {
      events,
      matchId: match.id,
      worldVersion: match.worldVersion,
    };
    this.io.to(match.roomId).emit("match:world-events", payload);
  }

  private finishIfMatchOver(match: Match, worldEvents: WorldEvent[]) {
    const survivingPlayers = match.players.filter((participant) => {
      return participant.state.health > 0;
    });

    if (survivingPlayers.length === 2) {
      return false;
    }

    this.emitWorldEvents(match, worldEvents);
    this.emitDynamicSnapshot(match);

    if (survivingPlayers.length === 1) {
      this.finishMatch(match, {
        reason: "destroyed",
        winnerId: survivingPlayers[0].socket.id,
      });
      return true;
    }

    this.finishMatch(match, {
      reason: "destroyed",
      winnerId: null,
    });
    return true;
  }

  private finishMatch(
    match: Match,
    options: {
      excludedSocketId?: string;
      reason: MatchEndedPayload["reason"];
      winnerId: string | null;
    },
  ) {
    this.matches.delete(match.id);

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      this.socketToMatchId.delete(participant.socket.id);
      participant.input = createEmptyInputState();
      participant.socket.leave(match.roomId);
    }

    for (let playerIndex = 0; playerIndex < match.players.length; playerIndex++) {
      const participant = match.players[playerIndex];
      if (participant.socket.id === options.excludedSocketId) {
        continue;
      }

      const outcome = getOutcomeForPlayer(participant.socket.id, options.winnerId);
      participant.socket.emit("match:ended", {
        matchId: match.id,
        outcome,
        reason: options.reason,
        winnerId: options.winnerId,
      });

      // Fire an achievement event for each participant. Best-effort —
      // don't block the finish path on db writes.
      const userId = (participant.socket.data as { userId?: string }).userId;
      if (userId !== undefined && options.reason !== "server-restart") {
        const delta =
          outcome === "win"
            ? { multiplayerWins: 1, opponentsEliminated: 1 }
            : outcome === "loss"
              ? { multiplayerLosses: 1 }
              : { multiplayerDraws: 1 };
        void achievementService.applyEvent(userId, delta, {
          type: "mp.matchEnded",
          outcome,
        });
      }
    }
  }

  private getMatchForSocket(socketId: string) {
    const matchId = this.socketToMatchId.get(socketId);
    if (matchId === undefined) {
      return null;
    }

    return this.matches.get(matchId) ?? null;
  }

  private getPlayerPositions(match: Match) {
    return match.players.map((participant) => {
      return {
        x: participant.state.x,
        y: participant.state.y,
      };
    });
  }

  private handleBulletCollisions(
    match: Match,
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
        match.world.runtime,
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

  private handleDisconnect(socketId: string) {
    this.sockets.delete(socketId);

    if (this.dequeue(socketId)) {
      this.emitQueueStatus();
    }

    const match = this.getMatchForSocket(socketId);
    if (match === null) {
      return;
    }

    const opponent = match.players.find((participant) => {
      return participant.socket.id !== socketId;
    });

    this.finishMatch(match, {
      excludedSocketId: socketId,
      reason: "opponent-left",
      winnerId: opponent?.socket.id ?? null,
    });
  }

  private handlePlayerAsteroidCollisions(
    match: Match,
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
        match.world.runtime,
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
      if (removeAsteroidFromWorld(match.world.runtime, asteroidId, MULTIPLAYER_ARENA)) {
        worldEvents.push({
          asteroidId,
          type: "asteroid-removed",
        });
      }
    });
  }

  private handlePlayerShipCollision(match: Match, playerDamageById: Map<string, number>) {
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
    match: Match,
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

  private tickMatches() {
    const activeMatches = Array.from(this.matches.values());

    for (let matchIndex = 0; matchIndex < activeMatches.length; matchIndex++) {
      const match = activeMatches[matchIndex];
      if (!this.matches.has(match.id)) {
        continue;
      }

      match.sequence++;

      const elapsedMs = Date.now() - match.createdAt;
      if (match.phase === "countdown" && elapsedMs >= MATCH_COUNTDOWN_MS) {
        match.phase = "active";
        match.lastActivityAt = Date.now();
      }

      const worldEvents: WorldEvent[] = [];
      if (match.phase === "active") {
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
          continue;
        }

        const isDev = process.env.NODE_ENV === "development";
        if (!isDev && Date.now() - match.lastActivityAt >= INACTIVE_MATCH_TIMEOUT_MS) {
          this.finishMatch(match, {
            reason: "inactive",
            winnerId: null,
          });
          continue;
        }
      }

      this.emitWorldEvents(match, worldEvents);

      if (match.sequence % SNAPSHOT_INTERVAL_TICKS === 0 || match.phase === "countdown") {
        this.emitDynamicSnapshot(match);
      }
    }
  }

  private tryCreateMatches() {
    while (this.waitingQueue.length > 1) {
      const matchedPlayers: Array<{ socket: TypedSocket; shipVariant: ShipVariant }> = [];

      while (this.waitingQueue.length > 0 && matchedPlayers.length < 2) {
        const queueItem = this.waitingQueue.shift();
        if (queueItem === undefined) {
          break;
        }

        const socket = this.sockets.get(queueItem.socketId);
        if (socket !== undefined) {
          matchedPlayers.push({ socket, shipVariant: queueItem.shipVariant });
        }
      }

      if (matchedPlayers.length < 2) {
        if (matchedPlayers.length === 1) {
          // Re-enqueue if we couldn't find a second player
          const socketId = matchedPlayers[0].socket.id;
          const shipVariant = matchedPlayers[0].shipVariant;
          this.waitingQueue.unshift({ socketId, shipVariant });
        }
        break;
      }

      this.createMatch(
        matchedPlayers as [
          { socket: TypedSocket; shipVariant: ShipVariant },
          { socket: TypedSocket; shipVariant: ShipVariant },
        ],
      );
    }

    this.emitQueueStatus();
  }

  private updatePlayerInput(socketId: string, payload: ShipInputState) {
    const match = this.getMatchForSocket(socketId);
    if (match === null) {
      return;
    }

    const participant = match.players.find((player) => {
      return player.socket.id === socketId;
    });
    if (participant === undefined) {
      return;
    }

    // Queue the input for ordered, one-per-tick processing.
    // This prevents intermediate inputs from being skipped when
    // multiple arrive between server ticks (due to network batching).
    participant.inputQueue.push(payload);
    if (participant.inputQueue.length > 120) {
      participant.inputQueue.shift();
    }
  }

  private stepPlayersOnce(match: Match) {
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
          createRuntimeBulletState(participant.state, `bullet-${++this.bulletCounter}`),
        );
        participant.state.ammo--;
        participant.state.fireCooldownTicks = FIRE_COOLDOWN_TICKS;
      }
    }
  }

  private updateWorldSpawns(match: Match, worldEvents: WorldEvent[]) {
    const now = Date.now();
    const playerPositions = this.getPlayerPositions(match);

    if (
      match.world.runtime.asteroids.size < match.targetAsteroidCount &&
      now >= match.world.nextAsteroidSpawnAt
    ) {
      const asteroid = spawnAsteroidFromRandom(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `asteroid:spawn:${++this.asteroidCounter}`,
        MULTIPLAYER_ARENA,
      );

      if (asteroid !== null) {
        addAsteroidToWorld(match.world.runtime, asteroid, MULTIPLAYER_ARENA);
        worldEvents.push({
          asteroid,
          type: "asteroid-spawned",
        });
      }

      match.world.nextAsteroidSpawnAt = now + ASTEROID_RESPAWN_INTERVAL_MS;
    }

    if (match.world.runtime.hearts.size < MAX_HEART_COUNT && now >= match.world.nextHeartSpawnAt) {
      const heart = spawnHeartFromRandom(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `heart:spawn:${++this.heartCounter}`,
        MULTIPLAYER_ARENA,
      );

      if (heart !== null) {
        addHeartToWorld(match.world.runtime, heart, MULTIPLAYER_ARENA);
        worldEvents.push({
          heart,
          type: "heart-spawned",
        });
      }

      match.world.nextHeartSpawnAt = now + HEART_SPAWN_INTERVAL_MS;
    }

    if (
      match.world.runtime.ammunitionPackets.size < MAX_AMMO_PACKET_COUNT &&
      now >= match.world.nextAmmoSpawnAt
    ) {
      const ammo = spawnAmmoFromRandom(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `ammo:spawn:${++this.ammoCounter}`,
        MULTIPLAYER_ARENA,
      );

      if (ammo !== null) {
        addAmmoToWorld(match.world.runtime, ammo, MULTIPLAYER_ARENA);
        worldEvents.push({
          ammo,
          type: "ammo-spawned",
        });
      }

      match.world.nextAmmoSpawnAt = now + AMMO_PACKET_SPAWN_INTERVAL_MS;
    }
  }
}
