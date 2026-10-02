import type { Server, Socket } from "socket.io";

import {
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  advanceRuntimeBulletState,
  BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS,
  BATTLE_ROYALE_ARENA,
  BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS,
  BATTLE_ROYALE_ASTEROID_TARGET_COUNT,
  BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS,
  BATTLE_ROYALE_LOBBY_COUNTDOWN_MS,
  BATTLE_ROYALE_LOBBY_RESET_MAX_MS,
  BATTLE_ROYALE_MATCH_COUNTDOWN_MS,
  BATTLE_ROYALE_MAX_AMMO_PACKET_COUNT,
  BATTLE_ROYALE_MAX_HEART_COUNT,
  BATTLE_ROYALE_MAX_PLAYERS,
  BATTLE_ROYALE_MIN_PLAYERS,
  type BattleRoyaleLobbyPayload,
  type BattleRoyaleMatchEndedPayload,
  type BattleRoyaleMatchFoundPayload,
  type BattleRoyaleSnapshotPayload,
  BULLET_DIAMETER,
  type ClientToServerEvents,
  circleOverlapsShipCollider,
  circlesOverlap,
  createBattleRoyalePlayerState,
  createEmptyInputState,
  createInitialBattleRoyaleWorld,
  createRuntimeBulletState,
  createSeededRandom,
  FIRE_COOLDOWN_TICKS,
  getNearbyAmmoPackets,
  getNearbyAsteroids,
  getNearbyHearts,
  getShipCollider,
  getShipCollisionBoundingDiameter,
  INACTIVE_MATCH_TIMEOUT_MS,
  isRuntimeBulletOutOfBounds,
  type MatchPhase,
  type MatchPlayerSnapshot,
  type MatchWorldEventsPayload,
  type MatchWorldRuntime,
  PLAYER_DAMAGE_RECOVERY_TICKS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  type RuntimeBulletState,
  type RuntimePlayerState,
  removeAmmoFromWorld,
  removeAsteroidFromWorld,
  removeHeartFromWorld,
  resolvePlayerCollision,
  type ServerToClientEvents,
  type ShipInputState,
  type ShipVariant,
  shipCollidersOverlap,
  snapshotPlayerState,
  spawnBattleRoyaleAmmo,
  spawnBattleRoyaleAsteroid,
  spawnBattleRoyaleHeart,
  stepPlayerState,
  TICK_INTERVAL_MS,
  type WorldEvent,
} from "../../shared/src";
import { achievementService } from "./achievementService";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface BattleRoyalePlayer {
  input: ShipInputState;
  inputQueue: ShipInputState[];
  socket: TypedSocket;
  state: RuntimePlayerState;
  spawnIndex: number;
  // Tracks when this player was eliminated, so we can report placement
  // and optionally keep their camera alive until the round ends.
  eliminatedAt: number | null;
  eliminationPlacement: number | null;
}

interface BattleRoyaleLobbyPlayer {
  socket: TypedSocket;
  shipVariant: ShipVariant;
  joinedAt: number;
}

interface BattleRoyaleMatchWorldState {
  nextAmmoSpawnAt: number;
  nextAsteroidSpawnAt: number;
  nextHeartSpawnAt: number;
  random: () => number;
  runtime: MatchWorldRuntime;
}

interface BattleRoyaleMatch {
  bullets: RuntimeBulletState[];
  createdAt: number;
  eliminationsSoFar: number;
  id: string;
  lastActivityAt: number;
  phase: MatchPhase;
  players: BattleRoyalePlayer[];
  roomId: string;
  sequence: number;
  world: BattleRoyaleMatchWorldState;
  worldSeed: number;
  worldVersion: number;
}

const LOBBY_ROOM_ID = "battle-royale:lobby";
const SNAPSHOT_INTERVAL_TICKS = 2;

export class BattleRoyaleService {
  private draining = false;
  private io: Server<ClientToServerEvents, ServerToClientEvents>;
  private lobby: BattleRoyaleLobbyPlayer[] = [];
  private lobbyTimerStartedAt: number | null = null;
  private lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
  private lobbyCheckTimer: NodeJS.Timeout;
  private matchCounter = 0;
  private matches = new Map<string, BattleRoyaleMatch>();
  private socketToMatchId = new Map<string, string>();
  private tickTimer: NodeJS.Timeout;
  private asteroidCounter = 0;
  private heartCounter = 0;
  private ammoCounter = 0;
  private bulletCounter = 0;

  constructor(io: Server<ClientToServerEvents, ServerToClientEvents>) {
    this.io = io;
    this.tickTimer = setInterval(() => {
      this.tickMatches();
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
    this.lobbyCheckTimer = setInterval(() => {
      this.tickLobby();
    }, 250);
    this.lobbyCheckTimer.unref?.();
  }

  registerSocketHandlers(socket: TypedSocket) {
    socket.on("br:input", (payload) => {
      this.queuePlayerInput(socket.id, payload);
    });
    socket.on("disconnect", () => {
      this.handleDisconnect(socket.id);
    });
  }

  enqueue(socketId: string, shipVariant: ShipVariant) {
    if (this.draining) return { enqueued: false as const, reason: "server-draining" as const };
    const socket = this.findSocket(socketId);
    if (socket === null) {
      return { enqueued: false as const, reason: "socket-not-found" as const };
    }
    if (this.socketToMatchId.has(socketId)) {
      return { enqueued: false as const, reason: "already-in-match" as const };
    }
    if (this.lobby.some((entry) => entry.socket.id === socketId)) {
      return { enqueued: true as const };
    }
    if (this.lobby.length >= BATTLE_ROYALE_MAX_PLAYERS) {
      return { enqueued: false as const, reason: "lobby-full" as const };
    }

    this.lobby.push({ socket, shipVariant, joinedAt: Date.now() });
    socket.join(LOBBY_ROOM_ID);

    if (this.lobby.length >= BATTLE_ROYALE_MIN_PLAYERS) {
      // Start (or extend) the countdown whenever a new player arrives
      // while the minimum threshold is met. Extending gives late joiners
      // a fair chance to boot up before the match begins.
      const now = Date.now();
      if (this.lobbyTimerStartedAt === null) {
        this.lobbyTimerStartedAt = now;
        this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
      } else {
        const elapsed = now - this.lobbyTimerStartedAt;
        const remaining = Math.max(0, this.lobbyCountdownMs - elapsed);
        const extended = Math.min(BATTLE_ROYALE_LOBBY_RESET_MAX_MS, remaining + 3000);
        this.lobbyTimerStartedAt = now;
        this.lobbyCountdownMs = extended;
      }
    } else {
      this.lobbyTimerStartedAt = null;
      this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    }

    // If we've hit the max, skip the wait and start immediately.
    if (this.lobby.length >= BATTLE_ROYALE_MAX_PLAYERS) {
      this.startMatchFromLobby();
    }

    this.broadcastLobbyStatus();
    return { enqueued: true as const };
  }

  leave(socketId: string) {
    const beforeLobbySize = this.lobby.length;
    this.lobby = this.lobby.filter((entry) => {
      if (entry.socket.id !== socketId) {
        return true;
      }
      entry.socket.leave(LOBBY_ROOM_ID);
      return false;
    });
    const removedFromLobby = this.lobby.length !== beforeLobbySize;

    if (this.lobby.length < BATTLE_ROYALE_MIN_PLAYERS) {
      this.lobbyTimerStartedAt = null;
      this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    }

    if (removedFromLobby) {
      this.broadcastLobbyStatus();
      return { removed: true as const, scope: "lobby" as const };
    }

    const matchId = this.socketToMatchId.get(socketId);
    if (matchId === undefined) {
      return { removed: false as const, scope: "none" as const };
    }
    const match = this.matches.get(matchId);
    if (match === undefined) {
      this.socketToMatchId.delete(socketId);
      return { removed: false as const, scope: "none" as const };
    }

    // Treat leaving as instant elimination.
    const player = match.players.find((participant) => participant.socket.id === socketId);
    if (player !== undefined && player.state.health > 0) {
      player.state.health = 0;
      this.markElimination(match, player);
    }

    this.socketToMatchId.delete(socketId);
    player?.socket.leave(match.roomId);

    // Check if the match is now over.
    this.finishIfMatchOver(match);
    return { removed: true as const, scope: "match" as const };
  }

  handleDisconnect(socketId: string) {
    this.leave(socketId);
  }

  beginDrain() {
    this.draining = true;
    this.lobby = [];
    this.lobbyTimerStartedAt = null;
    for (const match of Array.from(this.matches.values())) {
      this.finishMatch(match, { reason: "server-restart", winnerId: null });
    }
    this.broadcastLobbyStatus();
  }

  private findSocket(socketId: string): TypedSocket | null {
    const sockets = this.io.sockets.sockets as Map<string, TypedSocket>;
    return sockets.get(socketId) ?? null;
  }

  private broadcastLobbyStatus() {
    const payload: BattleRoyaleLobbyPayload = {
      phase: this.lobbyTimerStartedAt === null ? "lobby" : "countdown",
      countdownMs: this.getLobbyCountdownRemainingMs(),
      playerCount: this.lobby.length,
      minPlayers: BATTLE_ROYALE_MIN_PLAYERS,
      maxPlayers: BATTLE_ROYALE_MAX_PLAYERS,
    };
    this.io.to(LOBBY_ROOM_ID).emit("br:lobby", payload);
  }

  private getLobbyCountdownRemainingMs(): number {
    if (this.lobbyTimerStartedAt === null) {
      return BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    }
    const elapsed = Date.now() - this.lobbyTimerStartedAt;
    return Math.max(0, this.lobbyCountdownMs - elapsed);
  }

  private tickLobby() {
    if (this.lobby.length === 0) {
      return;
    }

    if (this.lobby.length < BATTLE_ROYALE_MIN_PLAYERS) {
      // Keep clients aware of the current headcount.
      this.broadcastLobbyStatus();
      return;
    }

    if (this.lobbyTimerStartedAt === null) {
      // Should have been set by enqueue but guard for safety.
      this.lobbyTimerStartedAt = Date.now();
    }

    if (this.getLobbyCountdownRemainingMs() === 0) {
      this.startMatchFromLobby();
      return;
    }

    this.broadcastLobbyStatus();
  }

  private startMatchFromLobby() {
    const entries = this.lobby.splice(0, BATTLE_ROYALE_MAX_PLAYERS);
    this.lobbyTimerStartedAt = null;
    this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;

    for (const entry of entries) {
      entry.socket.leave(LOBBY_ROOM_ID);
    }

    if (entries.length < BATTLE_ROYALE_MIN_PLAYERS) {
      // Shouldn't happen — put them back.
      this.lobby.unshift(...entries);
      return;
    }

    this.createMatch(entries);
    this.broadcastLobbyStatus();
  }

  private createMatch(entries: BattleRoyaleLobbyPlayer[]) {
    const matchId = `br-match-${++this.matchCounter}`;
    const roomId = `battle-royale:${matchId}`;
    const worldSeed = Math.floor(Math.random() * 0xffffffff);
    const totalPlayers = entries.length;

    const players: BattleRoyalePlayer[] = entries.map((entry, index) => {
      return {
        input: createEmptyInputState(),
        inputQueue: [],
        socket: entry.socket,
        spawnIndex: index,
        eliminatedAt: null,
        eliminationPlacement: null,
        state: createBattleRoyalePlayerState(
          entry.socket.id,
          index,
          totalPlayers,
          entry.shipVariant,
          BATTLE_ROYALE_ARENA,
        ),
      };
    });

    const playerPositions = players.map((player) => {
      return { x: player.state.x, y: player.state.y };
    });

    const match: BattleRoyaleMatch = {
      bullets: [],
      createdAt: Date.now(),
      eliminationsSoFar: 0,
      id: matchId,
      lastActivityAt: Date.now(),
      phase: "countdown",
      players,
      roomId,
      sequence: 0,
      world: {
        nextAmmoSpawnAt: Date.now() + BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS,
        nextAsteroidSpawnAt: Date.now() + BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS,
        nextHeartSpawnAt: Date.now() + BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS,
        random: createSeededRandom((worldSeed ^ 0x9e3779b9) >>> 0),
        runtime: createInitialBattleRoyaleWorld(worldSeed, playerPositions, BATTLE_ROYALE_ARENA),
      },
      worldSeed,
      worldVersion: 0,
    };

    this.matches.set(matchId, match);

    const playerIds = players.map((player) => player.socket.id);
    for (const player of players) {
      this.socketToMatchId.set(player.socket.id, matchId);
      player.socket.join(roomId);
      const payload: BattleRoyaleMatchFoundPayload = {
        arena: BATTLE_ROYALE_ARENA,
        countdownMs: BATTLE_ROYALE_MATCH_COUNTDOWN_MS,
        matchId,
        maxHealth: PLAYER_MAX_HEALTH,
        playerId: player.socket.id,
        playerIds,
        spawnIndex: player.spawnIndex,
        worldSeed,
      };
      player.socket.emit("br:match-found", payload);
    }

    this.emitSnapshot(match);
  }

  private queuePlayerInput(socketId: string, payload: ShipInputState) {
    const matchId = this.socketToMatchId.get(socketId);
    if (matchId === undefined) return;
    const match = this.matches.get(matchId);
    if (match === undefined) return;
    const participant = match.players.find((player) => player.socket.id === socketId);
    if (participant === undefined) return;
    participant.inputQueue.push(payload);
    if (participant.inputQueue.length > 120) {
      participant.inputQueue.shift();
    }
  }

  private tickMatches() {
    const matches = Array.from(this.matches.values());
    for (const match of matches) {
      if (!this.matches.has(match.id)) {
        continue;
      }
      this.tickMatch(match);
    }
  }

  private tickMatch(match: BattleRoyaleMatch) {
    match.sequence++;

    const elapsed = Date.now() - match.createdAt;
    if (match.phase === "countdown" && elapsed >= BATTLE_ROYALE_MATCH_COUNTDOWN_MS) {
      match.phase = "active";
      match.lastActivityAt = Date.now();
    }

    const worldEvents: WorldEvent[] = [];
    if (match.phase === "active") {
      const playerDamageById = new Map<string, number>();
      const healingByPlayerId = new Map<string, number>();
      const asteroidDamageById = new Map<string, number>();

      this.updateWorldSpawns(match, worldEvents);

      const maxQueued = match.players.reduce((max, player) => {
        return Math.max(max, player.inputQueue.length);
      }, 0);
      const subSteps = Math.max(1, maxQueued);

      for (let subStep = 0; subStep < subSteps; subStep++) {
        this.stepPlayersOnce(match);
        this.handlePlayerShipCollisions(match, playerDamageById);
        this.handlePlayerAsteroidCollisions(match, playerDamageById, worldEvents);
        this.handleBulletCollisions(match, playerDamageById, asteroidDamageById);
        this.applyAsteroidDamage(match, asteroidDamageById, worldEvents);
        this.applyHeartCollections(match, healingByPlayerId, worldEvents);
        this.applyAmmoCollections(match, worldEvents);
        this.applyPlayerDamageAndHealing(match, playerDamageById, healingByPlayerId);
        this.handleNewEliminations(match);
        playerDamageById.clear();
        healingByPlayerId.clear();
        asteroidDamageById.clear();
      }

      if (this.finishIfMatchOver(match)) {
        this.emitWorldEvents(match, worldEvents);
        return;
      }

      if (Date.now() - match.lastActivityAt >= INACTIVE_MATCH_TIMEOUT_MS) {
        this.finishMatch(match, { reason: "inactive", winnerId: null });
        return;
      }
    }

    this.emitWorldEvents(match, worldEvents);
    if (match.sequence % SNAPSHOT_INTERVAL_TICKS === 0 || match.phase === "countdown") {
      this.emitSnapshot(match);
    }
  }

  private stepPlayersOnce(match: BattleRoyaleMatch) {
    for (const participant of match.players) {
      if (participant.inputQueue.length > 0) {
        participant.input = participant.inputQueue.shift()!;
        participant.state.lastInputSeq = participant.input.inputSeq;
      }
      stepPlayerState(participant.state, participant.input, BATTLE_ROYALE_ARENA);

      if (
        participant.state.health > 0 &&
        participant.input.fire &&
        participant.state.fireCooldownTicks === 0 &&
        participant.state.ammo > 0
      ) {
        match.bullets.push(
          createRuntimeBulletState(participant.state, `br-bullet-${++this.bulletCounter}`),
        );
        participant.state.ammo--;
        participant.state.fireCooldownTicks = FIRE_COOLDOWN_TICKS;
        match.lastActivityAt = Date.now();
      }
      if (
        participant.state.health > 0 &&
        (participant.input.thrust || participant.input.turnLeft || participant.input.turnRight)
      ) {
        match.lastActivityAt = Date.now();
      }
    }
  }

  private handlePlayerShipCollisions(
    match: BattleRoyaleMatch,
    playerDamageById: Map<string, number>,
  ) {
    for (let i = 0; i < match.players.length; i++) {
      const a = match.players[i];
      if (a.state.health <= 0) continue;
      for (let j = i + 1; j < match.players.length; j++) {
        const b = match.players[j];
        if (b.state.health <= 0) continue;

        if (
          !shipCollidersOverlap(
            getShipCollider(a.state.x, a.state.y, a.state.angle, a.state.shipVariant),
            getShipCollider(b.state.x, b.state.y, b.state.angle, b.state.shipVariant),
          )
        ) {
          continue;
        }

        resolvePlayerCollision(a.state, b.state, BATTLE_ROYALE_ARENA);

        if (a.state.damageRecoveryTicks === 0) {
          playerDamageById.set(a.state.id, (playerDamageById.get(a.state.id) ?? 0) + 1);
        }
        if (b.state.damageRecoveryTicks === 0) {
          playerDamageById.set(b.state.id, (playerDamageById.get(b.state.id) ?? 0) + 1);
        }
      }
    }
  }

  private handlePlayerAsteroidCollisions(
    match: BattleRoyaleMatch,
    playerDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    const destroyedAsteroidIds = new Set<string>();
    for (const participant of match.players) {
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
        BATTLE_ROYALE_ARENA,
      );
      for (const asteroid of nearbyAsteroids) {
        if (destroyedAsteroidIds.has(asteroid.id)) continue;
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
      if (removeAsteroidFromWorld(match.world.runtime, asteroidId, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ asteroidId, type: "asteroid-removed" });
      }
    });
  }

  private handleBulletCollisions(
    match: BattleRoyaleMatch,
    playerDamageById: Map<string, number>,
    asteroidDamageById: Map<string, number>,
  ) {
    for (let bulletIndex = match.bullets.length - 1; bulletIndex >= 0; bulletIndex--) {
      const bullet = match.bullets[bulletIndex];
      advanceRuntimeBulletState(bullet);
      if (isRuntimeBulletOutOfBounds(bullet, BATTLE_ROYALE_ARENA)) {
        match.bullets.splice(bulletIndex, 1);
        continue;
      }
      let consumedBullet = false;
      const nearbyAsteroids = getNearbyAsteroids(
        match.world.runtime,
        bullet.x,
        bullet.y,
        BULLET_DIAMETER,
        BATTLE_ROYALE_ARENA,
      );
      for (const asteroid of nearbyAsteroids) {
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
      for (const participant of match.players) {
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

  private applyAsteroidDamage(
    match: BattleRoyaleMatch,
    asteroidDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    for (const [asteroidId, damage] of asteroidDamageById.entries()) {
      const asteroid = match.world.runtime.asteroids.get(asteroidId);
      if (asteroid === undefined) continue;
      asteroid.hitPoints -= damage;
      if (asteroid.hitPoints > 0) continue;
      if (removeAsteroidFromWorld(match.world.runtime, asteroidId, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ asteroidId, type: "asteroid-removed" });
      }
    }
  }

  private applyHeartCollections(
    match: BattleRoyaleMatch,
    healingByPlayerId: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    const collected = new Set<string>();
    for (const participant of match.players) {
      if (participant.state.health <= 0) continue;
      const collider = getShipCollider(
        participant.state.x,
        participant.state.y,
        participant.state.angle,
        participant.state.shipVariant,
      );
      const nearby = getNearbyHearts(
        match.world.runtime,
        participant.state.x,
        participant.state.y,
        getShipCollisionBoundingDiameter(participant.state.shipVariant),
        BATTLE_ROYALE_ARENA,
      );
      for (const heart of nearby) {
        if (collected.has(heart.id)) continue;
        if (circleOverlapsShipCollider(heart.x, heart.y, heart.size, collider)) {
          collected.add(heart.id);
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
    collected.forEach((id) => {
      if (removeHeartFromWorld(match.world.runtime, id, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ heartId: id, type: "heart-removed" });
      }
    });
  }

  private applyAmmoCollections(match: BattleRoyaleMatch, worldEvents: WorldEvent[]) {
    const collected = new Set<string>();
    for (const participant of match.players) {
      if (participant.state.health <= 0) continue;
      const collider = getShipCollider(
        participant.state.x,
        participant.state.y,
        participant.state.angle,
        participant.state.shipVariant,
      );
      const nearby = getNearbyAmmoPackets(
        match.world.runtime,
        participant.state.x,
        participant.state.y,
        getShipCollisionBoundingDiameter(participant.state.shipVariant),
        BATTLE_ROYALE_ARENA,
      );
      for (const packet of nearby) {
        if (collected.has(packet.id)) continue;
        if (circleOverlapsShipCollider(packet.x, packet.y, packet.size, collider)) {
          collected.add(packet.id);
          participant.state.ammo = Math.min(
            PLAYER_MAX_AMMO,
            participant.state.ammo + packet.amount,
          );
          break;
        }
      }
    }
    collected.forEach((id) => {
      if (removeAmmoFromWorld(match.world.runtime, id, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ ammoId: id, type: "ammo-removed" });
      }
    });
  }

  private applyPlayerDamageAndHealing(
    match: BattleRoyaleMatch,
    playerDamageById: Map<string, number>,
    healingByPlayerId: Map<string, number>,
  ) {
    for (const participant of match.players) {
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

  private handleNewEliminations(match: BattleRoyaleMatch) {
    for (const participant of match.players) {
      if (participant.state.health <= 0 && participant.eliminatedAt === null) {
        this.markElimination(match, participant);
      }
    }
  }

  private markElimination(match: BattleRoyaleMatch, participant: BattleRoyalePlayer) {
    participant.eliminatedAt = Date.now();
    const survivors = match.players.filter((player) => player.state.health > 0).length;
    // Placement is based on reverse elimination order — the last
    // player alive is 1st, the previous to die is 2nd, and so on.
    const placement = match.players.length - match.eliminationsSoFar;
    participant.eliminationPlacement = placement;
    match.eliminationsSoFar++;
    participant.socket.emit("br:eliminated", {
      matchId: match.id,
      placement,
      playerId: participant.socket.id,
      survivorsRemaining: survivors,
    });
  }

  private dispatchMatchEndAchievements(match: BattleRoyaleMatch, winnerId: string | null) {
    const total = match.players.length;
    for (const participant of match.players) {
      const userId = (participant.socket.data as { userId?: string }).userId;
      if (userId === undefined) continue;

      const won = winnerId !== null && winnerId === participant.socket.id;
      // Winner's placement is 1 (survived to the end). Others use their
      // elimination placement (set in markElimination).
      const placement = won ? 1 : (participant.eliminationPlacement ?? total);

      const delta: Parameters<typeof achievementService.applyEvent>[1] = {
        brMatches: 1,
      };
      if (won) {
        delta.brWins = 1;
        delta.brTopThree = 1;
      } else if (placement <= 3) {
        delta.brTopThree = 1;
      }
      void achievementService.applyEvent(userId, delta, {
        type: "br.matchEnded",
        placement,
        survivors: won ? 1 : 0,
        won,
      });
    }
  }

  private finishIfMatchOver(match: BattleRoyaleMatch): boolean {
    const survivors = match.players.filter((player) => player.state.health > 0);
    if (survivors.length > 1) {
      return false;
    }
    this.emitSnapshot(match);
    const winnerId = survivors.length === 1 ? survivors[0].socket.id : null;
    this.finishMatch(match, { reason: "winner", winnerId });
    return true;
  }

  private finishMatch(
    match: BattleRoyaleMatch,
    options: { reason: BattleRoyaleMatchEndedPayload["reason"]; winnerId: string | null },
  ) {
    this.matches.delete(match.id);

    for (const participant of match.players) {
      this.socketToMatchId.delete(participant.socket.id);
      participant.socket.leave(match.roomId);
    }

    for (const participant of match.players) {
      const payload: BattleRoyaleMatchEndedPayload = {
        matchId: match.id,
        reason: options.reason,
        winnerId: options.winnerId,
        youWon: options.winnerId !== null && options.winnerId === participant.socket.id,
      };
      participant.socket.emit("br:match-ended", payload);
    }

    if (options.reason !== "inactive" && options.reason !== "server-restart") {
      this.dispatchMatchEndAchievements(match, options.winnerId);
    }
  }

  private emitSnapshot(match: BattleRoyaleMatch) {
    const countdownMs =
      match.phase === "countdown"
        ? Math.max(0, BATTLE_ROYALE_MATCH_COUNTDOWN_MS - (Date.now() - match.createdAt))
        : 0;

    const payload: BattleRoyaleSnapshotPayload = {
      bullets: match.bullets.map((bullet) => ({
        id: bullet.id,
        ownerId: bullet.ownerId,
        vx: bullet.vx,
        vy: bullet.vy,
        x: bullet.x,
        y: bullet.y,
      })),
      countdownMs,
      matchId: match.id,
      phase: match.phase,
      players: match.players.map(
        (participant): MatchPlayerSnapshot => snapshotPlayerState(participant.state),
      ),
      sequence: match.sequence,
      survivorsRemaining: match.players.filter((participant) => participant.state.health > 0)
        .length,
    };
    this.io.to(match.roomId).emit("br:snapshot", payload);
  }

  private emitWorldEvents(match: BattleRoyaleMatch, events: WorldEvent[]) {
    if (events.length === 0) return;
    match.worldVersion++;
    const payload: MatchWorldEventsPayload = {
      events,
      matchId: match.id,
      worldVersion: match.worldVersion,
    };
    this.io.to(match.roomId).emit("br:world-events", payload);
  }

  private updateWorldSpawns(match: BattleRoyaleMatch, worldEvents: WorldEvent[]) {
    const now = Date.now();
    const playerPositions = match.players.map((player) => ({
      x: player.state.x,
      y: player.state.y,
    }));

    if (
      match.world.runtime.asteroids.size < BATTLE_ROYALE_ASTEROID_TARGET_COUNT &&
      now >= match.world.nextAsteroidSpawnAt
    ) {
      const asteroid = spawnBattleRoyaleAsteroid(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `br-asteroid:spawn:${++this.asteroidCounter}`,
        BATTLE_ROYALE_ARENA,
      );
      if (asteroid !== null) {
        addAsteroidToWorld(match.world.runtime, asteroid, BATTLE_ROYALE_ARENA);
        worldEvents.push({ asteroid, type: "asteroid-spawned" });
      }
      match.world.nextAsteroidSpawnAt = now + BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS;
    }

    if (
      match.world.runtime.hearts.size < BATTLE_ROYALE_MAX_HEART_COUNT &&
      now >= match.world.nextHeartSpawnAt
    ) {
      const heart = spawnBattleRoyaleHeart(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `br-heart:spawn:${++this.heartCounter}`,
        BATTLE_ROYALE_ARENA,
      );
      if (heart !== null) {
        addHeartToWorld(match.world.runtime, heart, BATTLE_ROYALE_ARENA);
        worldEvents.push({ heart, type: "heart-spawned" });
      }
      match.world.nextHeartSpawnAt = now + BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS;
    }

    if (
      match.world.runtime.ammunitionPackets.size < BATTLE_ROYALE_MAX_AMMO_PACKET_COUNT &&
      now >= match.world.nextAmmoSpawnAt
    ) {
      const ammo = spawnBattleRoyaleAmmo(
        match.world.runtime,
        playerPositions,
        match.world.random,
        `br-ammo:spawn:${++this.ammoCounter}`,
        BATTLE_ROYALE_ARENA,
      );
      if (ammo !== null) {
        addAmmoToWorld(match.world.runtime, ammo, BATTLE_ROYALE_ARENA);
        worldEvents.push({ ammo, type: "ammo-spawned" });
      }
      match.world.nextAmmoSpawnAt = now + BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS;
    }
  }
}
