// Battle-royale multiplayer mode.
//
// Runs parallel to the existing 1v1 "duel" multiplayer code. Reuses the
// shared physics, collision, spawn, and snapshot utilities from
// multiplayerCore but adds its own lobby/matchmaking flow, a larger
// arena, spawn positions distributed around a ring, and a variable
// player count.

import {
  AMMO_PACKET_AMOUNTS,
  type ArenaConfig,
  ASTEROID_MAX_SIZE,
  ASTEROID_MIN_SIZE,
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  createEmptyMatchWorld,
  createSeededRandom,
  DEFAULT_SHIP_VARIANT,
  isAmmoSpawnValid,
  isAsteroidSpawnValid,
  isHeartSpawnValid,
  type MatchBulletSnapshot,
  type MatchPhase,
  type MatchPlayerSnapshot,
  type MatchWorldRuntime,
  PLAYER_MAX_HEALTH,
  PLAYER_STARTING_AMMO,
  type RuntimePlayerState,
  randomBetween,
  type ShipVariant,
  WORLD_MARGIN,
} from "./multiplayerCore";

export const BATTLE_ROYALE_ARENA: ArenaConfig = {
  width: 5200,
  height: 3400,
};

export const BATTLE_ROYALE_MAX_PLAYERS = 20;
export const BATTLE_ROYALE_MIN_PLAYERS = 2;

// Lobby countdown in milliseconds once the minimum player count is met.
// Resets upward (caps at LOBBY_RESET_MAX_MS) each time a new player
// joins so late arrivals still get a fair start window.
export const BATTLE_ROYALE_LOBBY_COUNTDOWN_MS = 15000;
export const BATTLE_ROYALE_LOBBY_RESET_MAX_MS = 15000;

// Match countdown ("get ready!") once the lobby resolves and before
// players can input.
export const BATTLE_ROYALE_MATCH_COUNTDOWN_MS = 4000;

export const BATTLE_ROYALE_ASTEROID_TARGET_COUNT = 48;
export const BATTLE_ROYALE_INITIAL_HEART_COUNT = 20;
export const BATTLE_ROYALE_MAX_HEART_COUNT = 28;
export const BATTLE_ROYALE_HEART_SPAWN_INTERVAL_MS = 6000;
export const BATTLE_ROYALE_INITIAL_AMMO_PACKET_COUNT = 16;
export const BATTLE_ROYALE_MAX_AMMO_PACKET_COUNT = 22;
export const BATTLE_ROYALE_AMMO_PACKET_SPAWN_INTERVAL_MS = 6500;
export const BATTLE_ROYALE_ASTEROID_RESPAWN_INTERVAL_MS = 4500;

export type BattleRoyaleLobbyPhase = "lobby" | "countdown" | "active" | "ended";

export interface BattleRoyaleLobbyPayload {
  countdownMs: number;
  maxPlayers: number;
  minPlayers: number;
  phase: BattleRoyaleLobbyPhase;
  playerCount: number;
}

export interface BattleRoyaleMatchFoundPayload {
  arena: ArenaConfig;
  countdownMs: number;
  matchId: string;
  maxHealth: number;
  playerId: string;
  playerIds: string[];
  /** Secret the client presents to resume this seat after a reconnect or server handoff. */
  resumeToken: string;
  spawnIndex: number;
  worldSeed: number;
}

export interface BattleRoyaleSnapshotPayload {
  bullets: MatchBulletSnapshot[];
  countdownMs: number;
  matchId: string;
  phase: MatchPhase;
  players: MatchPlayerSnapshot[];
  sequence: number;
  survivorsRemaining: number;
}

export interface BattleRoyaleMatchEndedPayload {
  matchId: string;
  reason: "eliminated" | "inactive" | "winner" | "server-restart";
  winnerId: string | null;
  youWon: boolean;
}

export interface BattleRoyaleEliminatedPayload {
  matchId: string;
  placement: number;
  playerId: string;
  survivorsRemaining: number;
}

/**
 * Positions players at evenly-spaced points around a ring centered on
 * the arena. The ring radius leaves enough room for the safe spawn
 * clearance around each player and the arena border.
 */
export const getBattleRoyaleSpawnPosition = (
  spawnIndex: number,
  totalPlayers: number,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
) => {
  if (totalPlayers <= 0) {
    return { x: 0, y: 0 };
  }
  const safeHorizontal = arena.width / 2 - WORLD_MARGIN * 2;
  const safeVertical = arena.height / 2 - WORLD_MARGIN * 2;
  const radius = Math.min(safeHorizontal, safeVertical) * 0.82;
  const angle = (spawnIndex / totalPlayers) * Math.PI * 2;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
};

export const createBattleRoyalePlayerState = (
  id: string,
  spawnIndex: number,
  totalPlayers: number,
  shipVariant: ShipVariant = DEFAULT_SHIP_VARIANT,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
): RuntimePlayerState => {
  const spawn = getBattleRoyaleSpawnPosition(spawnIndex, totalPlayers, arena);
  // Face the arena center so the first moments feel purposeful.
  const angle = Math.atan2(-spawn.y, -spawn.x);
  return {
    angle,
    ammo: PLAYER_STARTING_AMMO,
    damageRecoveryTicks: 0,
    fireCooldownTicks: 0,
    health: PLAYER_MAX_HEALTH,
    id,
    lastInputSeq: 0,
    shipVariant,
    // Slot is only meaningful for the duel's alpha/beta convention.
    // Battle-royale players share a single slot value and rely on the
    // spawn index supplied via the match-found payload for rendering.
    slot: "alpha",
    thrusting: false,
    vx: 0,
    vy: 0,
    x: spawn.x,
    y: spawn.y,
  };
};

/**
 * Build the initial BR world with asteroids, hearts, and ammo packets
 * placed so they avoid every player's spawn position. Mirrors the
 * duel's createInitialMatchWorld but takes the full player position
 * list as input and uses BR-specific counts.
 */
export const createInitialBattleRoyaleWorld = (
  worldSeed: number,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
): MatchWorldRuntime => {
  const random = createSeededRandom(worldSeed);
  const world = createEmptyMatchWorld();

  for (let i = 0; i < BATTLE_ROYALE_ASTEROID_TARGET_COUNT; i++) {
    const asteroid = spawnBattleRoyaleAsteroid(
      world,
      playerPositions,
      random,
      `br-asteroid:init:${i}`,
      arena,
    );
    if (asteroid !== null) {
      addAsteroidToWorld(world, asteroid, arena);
    }
  }

  for (let i = 0; i < BATTLE_ROYALE_INITIAL_HEART_COUNT; i++) {
    const heart = spawnBattleRoyaleHeart(
      world,
      playerPositions,
      random,
      `br-heart:init:${i}`,
      arena,
    );
    if (heart !== null) {
      addHeartToWorld(world, heart, arena);
    }
  }

  for (let i = 0; i < BATTLE_ROYALE_INITIAL_AMMO_PACKET_COUNT; i++) {
    const ammo = spawnBattleRoyaleAmmo(world, playerPositions, random, `br-ammo:init:${i}`, arena);
    if (ammo !== null) {
      addAmmoToWorld(world, ammo, arena);
    }
  }

  return world;
};

// Re-implemented spawn helpers that accept an arena param so we can
// reuse them for the larger BR arena. Implementation mirrors the
// multiplayerCore helpers but parameterized.
export const spawnBattleRoyaleAsteroid = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  asteroidId: string,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
) => {
  for (let attempt = 0; attempt < 240; attempt++) {
    const size = randomBetween(random, ASTEROID_MIN_SIZE, ASTEROID_MAX_SIZE);
    const x = randomBetween(
      random,
      -arena.width / 2 + WORLD_MARGIN,
      arena.width / 2 - WORLD_MARGIN,
    );
    const y = randomBetween(
      random,
      -arena.height / 2 + WORLD_MARGIN,
      arena.height / 2 - WORLD_MARGIN,
    );

    if (!isAsteroidSpawnValid(world, playerPositions, x, y, size, arena)) {
      continue;
    }

    return {
      baseRotation: randomBetween(random, 0, Math.PI * 2),
      hitPoints: Math.max(1, Math.round(size / 50)),
      id: asteroidId,
      size,
      spinSpeed: randomBetween(random, -0.0045, 0.0045),
      variant: Math.floor(randomBetween(random, 0, 3)),
      x,
      y,
    };
  }
  return null;
};

export const spawnBattleRoyaleHeart = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  heartId: string,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
) => {
  for (let attempt = 0; attempt < 240; attempt++) {
    const x = randomBetween(
      random,
      -arena.width / 2 + WORLD_MARGIN,
      arena.width / 2 - WORLD_MARGIN,
    );
    const y = randomBetween(
      random,
      -arena.height / 2 + WORLD_MARGIN,
      arena.height / 2 - WORLD_MARGIN,
    );
    if (!isHeartSpawnValid(world, playerPositions, x, y, arena)) {
      continue;
    }
    return {
      id: heartId,
      size: 200 / 3, // matches HEART_SIZE in multiplayerCore
      x,
      y,
    };
  }
  return null;
};

export const spawnBattleRoyaleAmmo = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  ammoId: string,
  arena: ArenaConfig = BATTLE_ROYALE_ARENA,
) => {
  for (let attempt = 0; attempt < 240; attempt++) {
    const amount = AMMO_PACKET_AMOUNTS[Math.floor(random() * AMMO_PACKET_AMOUNTS.length)];
    const size = 48 + amount * 4;
    const x = randomBetween(
      random,
      -arena.width / 2 + WORLD_MARGIN,
      arena.width / 2 - WORLD_MARGIN,
    );
    const y = randomBetween(
      random,
      -arena.height / 2 + WORLD_MARGIN,
      arena.height / 2 - WORLD_MARGIN,
    );

    if (!isAmmoSpawnValid(world, playerPositions, x, y, size, arena)) {
      continue;
    }

    return {
      amount,
      id: ammoId,
      size,
      x,
      y,
    };
  }
  return null;
};
