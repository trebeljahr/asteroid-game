import { z } from "zod";

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
  circleOverlapsShipCollider,
  circlesOverlap,
  createBattleRoyalePlayerState,
  createEmptyInputState,
  createInitialBattleRoyaleWorld,
  createRuntimeBulletState,
  createSeededRandomState,
  FIRE_COOLDOWN_TICKS,
  getNearbyAmmoPackets,
  getNearbyAsteroids,
  getNearbyHearts,
  getShipCollider,
  getShipCollisionBoundingDiameter,
  INACTIVE_MATCH_TIMEOUT_MS,
  isRuntimeBulletOutOfBounds,
  type MatchPlayerSnapshot,
  type MatchResumedPayload,
  type MatchSnapshotPayload,
  type MatchWorldEventsPayload,
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
  spawnBattleRoyaleAmmo,
  spawnBattleRoyaleAsteroid,
  spawnBattleRoyaleHeart,
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
import type { CoordinationStore, LeaseFence, Ticket } from "./realtime/store";

interface BrParticipant extends HostParticipant {
  // Tracks when this player was eliminated, so we can report placement
  // and optionally keep their camera alive until the round ends.
  eliminatedAt: number | null;
  eliminationPlacement: number | null;
  spawnIndex: number;
}

interface BrMatch extends HostMatch<BrParticipant> {
  eliminationsSoFar: number;
}

const brSnapshotSchema = baseSnapshotSchema.extend({
  eliminationsSoFar: z.number().int().nonnegative(),
  mode: z.literal("battle-royale"),
  players: z
    .array(
      participantSchema.extend({
        eliminated: z.boolean(),
        eliminationPlacement: z.number().int().positive().nullable(),
        spawnIndex: z.number().int().nonnegative(),
      }),
    )
    .min(BATTLE_ROYALE_MIN_PLAYERS)
    .max(BATTLE_ROYALE_MAX_PLAYERS),
});

export const LOBBY_ROOM_ID = "battle-royale:lobby";
export const LOBBY_LEASE_NAME = "lobby:battle-royale";

const roomIdFor = (matchId: string) => `battle-royale:${matchId}`;

/**
 * Battle-royale matches plus the shared lobby. The lobby queue lives in
 * the shared ticket table; exactly one replica (the holder of the lobby
 * lease) runs the countdown and emits to the lobby room, so lobby
 * sockets on every replica see one countdown.
 */
export class BattleRoyaleService extends MatchHostBase<BrParticipant, BrMatch> {
  readonly mode = "battle-royale" as const;
  protected readonly arena = BATTLE_ROYALE_ARENA;
  private lobbyTimerStartedAt: number | null = null;
  private lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
  private lastLobbyCount = 0;

  constructor(ctx: HostContext) {
    super(ctx);
  }

  /** Forget the countdown when this replica stops owning the lobby. */
  resetLobby() {
    this.lobbyTimerStartedAt = null;
    this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    this.lastLobbyCount = 0;
  }

  /** One lobby step. Only the replica holding the lobby lease calls this. */
  async runLobby(store: CoordinationStore) {
    const tickets = await store.listTickets("battle-royale");
    const count = tickets.length;
    if (count === 0) {
      this.resetLobby();
      return;
    }

    if (count < BATTLE_ROYALE_MIN_PLAYERS) {
      this.resetLobby();
      this.lastLobbyCount = count;
      // Keep clients aware of the current headcount.
      this.broadcastLobbyStatus(count);
      return;
    }

    const now = Date.now();
    if (this.lobbyTimerStartedAt === null) {
      this.lobbyTimerStartedAt = now;
      this.lobbyCountdownMs = BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    } else if (count > this.lastLobbyCount) {
      // Extend the countdown whenever a new player arrives while the
      // minimum threshold is met. Extending gives late joiners a fair
      // chance to boot up before the match begins.
      const remaining = this.getLobbyCountdownRemainingMs(now);
      this.lobbyTimerStartedAt = now;
      this.lobbyCountdownMs = Math.min(BATTLE_ROYALE_LOBBY_RESET_MAX_MS, remaining + 3000);
    }
    this.lastLobbyCount = count;

    // If we've hit the max, skip the wait and start immediately.
    if (count >= BATTLE_ROYALE_MAX_PLAYERS || this.getLobbyCountdownRemainingMs(now) === 0) {
      this.resetLobby();
      const entries = await store.takeTickets(
        "battle-royale",
        BATTLE_ROYALE_MIN_PLAYERS,
        BATTLE_ROYALE_MAX_PLAYERS,
      );
      if (entries.length > 0) {
        try {
          await this.createMatch(entries);
        } catch (error) {
          console.error("[br] match creation failed; returning players to the lobby", error);
          await Promise.all(entries.map((entry) => store.putTicket(entry)));
        }
      }
      return;
    }

    this.broadcastLobbyStatus(count);
  }

  async createMatch(entries: Ticket[]) {
    const matchId = newMatchId("br-match");
    const fence = await this.ctx.durability.open(matchId, this.mode);
    const now = Date.now();
    const worldSeed = Math.floor(Math.random() * 0xffffffff);
    const totalPlayers = entries.length;
    const tokens = entries.map(() => newResumeToken());

    const players = entries.map((entry, index): BrParticipant => {
      const playerId = newPlayerId();
      return {
        detachedAt: null,
        eliminatedAt: null,
        eliminationPlacement: null,
        input: createEmptyInputState(),
        inputQueue: [],
        playerId,
        replicaId: entry.replicaId,
        resumeTokenHash: hashResumeToken(tokens[index]),
        socketId: entry.socketId,
        spawnIndex: index,
        state: createBattleRoyalePlayerState(
          playerId,
          index,
          totalPlayers,
          entry.shipVariant,
          BATTLE_ROYALE_ARENA,
        ),
        userId: entry.userId,
      };
    });

    const playerPositions = players.map((player) => {
      return { x: player.state.x, y: player.state.y };
    });

    const match: BrMatch = {
      bullets: [],
      counters: { ammo: 0, asteroid: 0, bullet: 0, heart: 0 },
      countdownEndsAt: now + BATTLE_ROYALE_MATCH_COUNTDOWN_MS,
      eliminationsSoFar: 0,
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
        ammo: now + BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS,
        asteroid: now + BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS,
        heart: now + BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS,
      },
      world: createInitialBattleRoyaleWorld(worldSeed, playerPositions, BATTLE_ROYALE_ARENA),
      worldSeed,
      worldVersion: 0,
    };

    this.matches.set(matchId, match);

    const playerIds = players.map((player) => player.playerId);
    for (let index = 0; index < players.length; index++) {
      const player = players[index];
      if (player.socketId === null) continue;
      this.ctx.io.in(player.socketId).socketsLeave(LOBBY_ROOM_ID);
      this.seatParticipant(match, player);
      const payload: BattleRoyaleMatchFoundPayload = {
        arena: BATTLE_ROYALE_ARENA,
        countdownMs: BATTLE_ROYALE_MATCH_COUNTDOWN_MS,
        matchId,
        maxHealth: PLAYER_MAX_HEALTH,
        playerId: player.playerId,
        playerIds,
        resumeToken: tokens[index],
        spawnIndex: player.spawnIndex,
        worldSeed,
      };
      this.ctx.io.to(player.socketId).emit("br:match-found", payload);
    }

    this.emitSnapshot(match);
  }

  protected roomIdFor(matchId: string) {
    return roomIdFor(matchId);
  }

  protected emitMigrating(match: BrMatch) {
    this.ctx.io.to(match.roomId).emit("match:migrating", { matchId: match.id });
  }

  protected emitRestartEnded(matchId: string) {
    this.ctx.io.to(roomIdFor(matchId)).emit("br:match-ended", {
      matchId,
      reason: "server-restart",
      winnerId: null,
      youWon: false,
    });
  }

  protected forfeit(match: BrMatch, participant: BrParticipant) {
    // Treat leaving as instant elimination.
    if (participant.state.health > 0) {
      participant.state.health = 0;
      this.markElimination(match, participant);
    }
    this.finishIfMatchOver(match);
  }

  protected endUncounted(match: BrMatch) {
    this.finishMatch(match, { reason: "server-restart", winnerId: null });
  }

  protected buildResumedPayload(match: BrMatch, participant: BrParticipant): MatchResumedPayload {
    return {
      arena: BATTLE_ROYALE_ARENA,
      matchId: match.id,
      maxHealth: PLAYER_MAX_HEALTH,
      mode: "battle-royale",
      opponentId: null,
      placement: participant.eliminationPlacement,
      playerId: participant.playerId,
      playerIds: match.players.map((player) => player.playerId),
      slot: "alpha",
      snapshot: this.buildSnapshot(match),
      survivorsRemaining: this.countSurvivors(match),
      world: this.worldLists(match),
    };
  }

  protected serializeMatch(match: BrMatch) {
    return {
      ...this.serializeBase(match),
      eliminationsSoFar: match.eliminationsSoFar,
      mode: "battle-royale" as const,
      players: match.players.map((participant) => {
        return {
          ...this.serializeParticipant(participant),
          eliminated: participant.eliminatedAt !== null,
          eliminationPlacement: participant.eliminationPlacement,
          spawnIndex: participant.spawnIndex,
        };
      }),
    };
  }

  protected restoreMatch(fence: LeaseFence, state: unknown, now: number): BrMatch | null {
    const parsed = brSnapshotSchema.safeParse(state);
    if (!parsed.success) {
      console.warn(
        `[handoff] invalid battle-royale snapshot for ${fence.matchId}`,
        parsed.error.issues[0]?.message,
      );
      return null;
    }
    return {
      ...this.restoreBase(fence, parsed.data, now),
      eliminationsSoFar: parsed.data.eliminationsSoFar,
      players: parsed.data.players.map((player) => {
        return {
          ...this.restoreParticipantBase(player, now),
          eliminatedAt: player.eliminated ? now : null,
          eliminationPlacement: player.eliminationPlacement,
          spawnIndex: player.spawnIndex,
        };
      }),
    };
  }

  protected stepActive(match: BrMatch, worldEvents: WorldEvent[]) {
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
      return true;
    }

    if (Date.now() - match.lastActivityAt >= INACTIVE_MATCH_TIMEOUT_MS) {
      this.finishMatch(match, { reason: "inactive", winnerId: null });
      return true;
    }
    return false;
  }

  protected emitSnapshot(match: BrMatch) {
    const payload: BattleRoyaleSnapshotPayload = {
      ...this.buildSnapshot(match),
      survivorsRemaining: this.countSurvivors(match),
    };
    this.ctx.io.to(match.roomId).emit("br:snapshot", payload);
  }

  protected emitWorldEvents(match: BrMatch, events: WorldEvent[]) {
    if (events.length === 0) return;
    match.worldVersion++;
    const payload: MatchWorldEventsPayload = {
      events,
      matchId: match.id,
      worldVersion: match.worldVersion,
    };
    this.ctx.io.to(match.roomId).emit("br:world-events", payload);
  }

  private broadcastLobbyStatus(count: number) {
    const payload: BattleRoyaleLobbyPayload = {
      phase: this.lobbyTimerStartedAt === null ? "lobby" : "countdown",
      countdownMs: this.getLobbyCountdownRemainingMs(Date.now()),
      playerCount: count,
      minPlayers: BATTLE_ROYALE_MIN_PLAYERS,
      maxPlayers: BATTLE_ROYALE_MAX_PLAYERS,
    };
    this.ctx.io.to(LOBBY_ROOM_ID).emit("br:lobby", payload);
  }

  private getLobbyCountdownRemainingMs(now: number): number {
    if (this.lobbyTimerStartedAt === null) {
      return BATTLE_ROYALE_LOBBY_COUNTDOWN_MS;
    }
    const elapsed = now - this.lobbyTimerStartedAt;
    return Math.max(0, this.lobbyCountdownMs - elapsed);
  }

  private countSurvivors(match: BrMatch) {
    return match.players.filter((participant) => participant.state.health > 0).length;
  }

  private buildSnapshot(match: BrMatch): MatchSnapshotPayload {
    return {
      bullets: match.bullets.map((bullet) => ({
        id: bullet.id,
        ownerId: bullet.ownerId,
        vx: bullet.vx,
        vy: bullet.vy,
        x: bullet.x,
        y: bullet.y,
      })),
      countdownMs: this.countdownRemainingMs(match),
      matchId: match.id,
      phase: match.phase,
      players: match.players.map(
        (participant): MatchPlayerSnapshot => snapshotPlayerState(participant.state),
      ),
      sequence: match.sequence,
    };
  }

  private stepPlayersOnce(match: BrMatch) {
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
          createRuntimeBulletState(participant.state, `br-bullet-${++match.counters.bullet}`),
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

  private handlePlayerShipCollisions(match: BrMatch, playerDamageById: Map<string, number>) {
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
    match: BrMatch,
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
        match.world,
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
      if (removeAsteroidFromWorld(match.world, asteroidId, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ asteroidId, type: "asteroid-removed" });
      }
    });
  }

  private handleBulletCollisions(
    match: BrMatch,
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
        match.world,
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
    match: BrMatch,
    asteroidDamageById: Map<string, number>,
    worldEvents: WorldEvent[],
  ) {
    for (const [asteroidId, damage] of asteroidDamageById.entries()) {
      const asteroid = match.world.asteroids.get(asteroidId);
      if (asteroid === undefined) continue;
      asteroid.hitPoints -= damage;
      if (asteroid.hitPoints > 0) continue;
      if (removeAsteroidFromWorld(match.world, asteroidId, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ asteroidId, type: "asteroid-removed" });
      }
    }
  }

  private applyHeartCollections(
    match: BrMatch,
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
        match.world,
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
      if (removeHeartFromWorld(match.world, id, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ heartId: id, type: "heart-removed" });
      }
    });
  }

  private applyAmmoCollections(match: BrMatch, worldEvents: WorldEvent[]) {
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
        match.world,
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
      if (removeAmmoFromWorld(match.world, id, BATTLE_ROYALE_ARENA)) {
        worldEvents.push({ ammoId: id, type: "ammo-removed" });
      }
    });
  }

  private applyPlayerDamageAndHealing(
    match: BrMatch,
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

  private handleNewEliminations(match: BrMatch) {
    for (const participant of match.players) {
      if (participant.state.health <= 0 && participant.eliminatedAt === null) {
        this.markElimination(match, participant);
      }
    }
  }

  private markElimination(match: BrMatch, participant: BrParticipant) {
    participant.eliminatedAt = Date.now();
    const survivors = this.countSurvivors(match);
    // Placement is based on reverse elimination order — the last
    // player alive is 1st, the previous to die is 2nd, and so on.
    const placement = match.players.length - match.eliminationsSoFar;
    participant.eliminationPlacement = placement;
    match.eliminationsSoFar++;
    if (participant.socketId !== null) {
      this.ctx.io.to(participant.socketId).emit("br:eliminated", {
        matchId: match.id,
        placement,
        playerId: participant.playerId,
        survivorsRemaining: survivors,
      });
    }
  }

  private matchResults(match: BrMatch, winnerId: string | null): MatchResultEntry[] {
    const total = match.players.length;
    const results: MatchResultEntry[] = [];
    for (const participant of match.players) {
      if (participant.userId === null) continue;

      const won = winnerId !== null && winnerId === participant.playerId;
      // Winner's placement is 1 (survived to the end). Others use their
      // elimination placement (set in markElimination).
      const placement = won ? 1 : (participant.eliminationPlacement ?? total);

      const delta: MatchResultEntry["delta"] = {
        brMatches: 1,
      };
      if (won) {
        delta.brWins = 1;
        delta.brTopThree = 1;
      } else if (placement <= 3) {
        delta.brTopThree = 1;
      }
      results.push({
        delta,
        event: {
          type: "br.matchEnded",
          placement,
          survivors: won ? 1 : 0,
          won,
        },
        outcome: won ? "win" : `placement-${placement}`,
        userId: participant.userId,
      });
    }
    return results;
  }

  private finishIfMatchOver(match: BrMatch): boolean {
    const survivors = match.players.filter((player) => player.state.health > 0);
    if (survivors.length > 1) {
      return false;
    }
    this.emitSnapshot(match);
    const winnerId = survivors.length === 1 ? survivors[0].playerId : null;
    this.finishMatch(match, { reason: "winner", winnerId });
    return true;
  }

  private finishMatch(
    match: BrMatch,
    options: { reason: BattleRoyaleMatchEndedPayload["reason"]; winnerId: string | null },
  ) {
    this.closeMatch(match);

    for (const participant of match.players) {
      if (participant.socketId === null) continue;
      const payload: BattleRoyaleMatchEndedPayload = {
        matchId: match.id,
        reason: options.reason,
        winnerId: options.winnerId,
        youWon: options.winnerId !== null && options.winnerId === participant.playerId,
      };
      this.ctx.io.to(participant.socketId).emit("br:match-ended", payload);
    }

    const counted = options.reason !== "inactive" && options.reason !== "server-restart";
    void this.ctx.durability.finish(
      match.fence,
      counted ? this.matchResults(match, options.winnerId) : [],
    );
  }

  private updateWorldSpawns(match: BrMatch, worldEvents: WorldEvent[]) {
    const now = Date.now();
    const playerPositions = match.players.map((player) => ({
      x: player.state.x,
      y: player.state.y,
    }));
    const random = () => nextSeededRandom(match.random);

    if (
      match.world.asteroids.size < BATTLE_ROYALE_ASTEROID_TARGET_COUNT &&
      now >= match.spawnAt.asteroid
    ) {
      const asteroid = spawnBattleRoyaleAsteroid(
        match.world,
        playerPositions,
        random,
        `br-asteroid:spawn:${++match.counters.asteroid}`,
        BATTLE_ROYALE_ARENA,
      );
      if (asteroid !== null) {
        addAsteroidToWorld(match.world, asteroid, BATTLE_ROYALE_ARENA);
        worldEvents.push({ asteroid, type: "asteroid-spawned" });
      }
      match.spawnAt.asteroid = now + BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS;
    }

    if (match.world.hearts.size < BATTLE_ROYALE_MAX_HEART_COUNT && now >= match.spawnAt.heart) {
      const heart = spawnBattleRoyaleHeart(
        match.world,
        playerPositions,
        random,
        `br-heart:spawn:${++match.counters.heart}`,
        BATTLE_ROYALE_ARENA,
      );
      if (heart !== null) {
        addHeartToWorld(match.world, heart, BATTLE_ROYALE_ARENA);
        worldEvents.push({ heart, type: "heart-spawned" });
      }
      match.spawnAt.heart = now + BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS;
    }

    if (
      match.world.ammunitionPackets.size < BATTLE_ROYALE_MAX_AMMO_PACKET_COUNT &&
      now >= match.spawnAt.ammo
    ) {
      const ammo = spawnBattleRoyaleAmmo(
        match.world,
        playerPositions,
        random,
        `br-ammo:spawn:${++match.counters.ammo}`,
        BATTLE_ROYALE_ARENA,
      );
      if (ammo !== null) {
        addAmmoToWorld(match.world, ammo, BATTLE_ROYALE_ARENA);
        worldEvents.push({ ammo, type: "ammo-spawned" });
      }
      match.spawnAt.ammo = now + BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS;
    }
  }
}
