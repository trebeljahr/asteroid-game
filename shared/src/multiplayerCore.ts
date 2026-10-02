export type MatchEndReason = "destroyed" | "inactive" | "opponent-left" | "server-restart";
export type MatchOutcome = "draw" | "loss" | "win";
export type MatchPhase = "active" | "countdown";
export type PlayerSlot = "alpha" | "beta";
export type ShipVariant =
  | "aurora-sprint"
  | "comet-lance"
  | "ember-needle"
  | "orbit-dart"
  | "solar-sloop"
  | "starfin-drifter";

export interface ArenaConfig {
  height: number;
  width: number;
}

export interface ShipInputState {
  fire: boolean;
  inputSeq: number;
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
}

export interface MatchPlayerSnapshot {
  angle: number;
  ammo: number;
  damageRecoveryTicks: number;
  health: number;
  id: string;
  lastInputSeq: number;
  shipVariant: ShipVariant;
  slot: PlayerSlot;
  thrusting: boolean;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export interface RuntimePlayerState extends MatchPlayerSnapshot {
  fireCooldownTicks: number;
}

export interface MatchBulletSnapshot {
  id: string;
  ownerId: string;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export interface RuntimeBulletState extends MatchBulletSnapshot {
  ttlTicks: number;
}

export interface WorldAsteroidState {
  baseRotation: number;
  hitPoints: number;
  id: string;
  size: number;
  spinSpeed: number;
  variant: number;
  x: number;
  y: number;
}

export interface WorldHeartState {
  id: string;
  size: number;
  x: number;
  y: number;
}

export interface WorldAmmoState {
  amount: number;
  id: string;
  size: number;
  x: number;
  y: number;
}

export type WorldEvent =
  | {
      asteroid: WorldAsteroidState;
      type: "asteroid-spawned";
    }
  | {
      asteroidId: string;
      type: "asteroid-removed";
    }
  | {
      heart: WorldHeartState;
      type: "heart-spawned";
    }
  | {
      heartId: string;
      type: "heart-removed";
    }
  | {
      ammo: WorldAmmoState;
      type: "ammo-spawned";
    }
  | {
      ammoId: string;
      type: "ammo-removed";
    };

export interface MatchmakingStatusPayload {
  position: number;
  queueSize: number;
}

export interface MatchFoundPayload {
  arena: ArenaConfig;
  countdownMs: number;
  matchId: string;
  maxHealth: number;
  opponentId: string;
  playerId: string;
  slot: PlayerSlot;
  worldSeed: number;
}

export interface MatchWorldEventsPayload {
  events: WorldEvent[];
  matchId: string;
  worldVersion: number;
}

export interface MatchSnapshotPlayerDebug {
  inputQueueDepth: number;
}

export interface MatchSnapshotPayload {
  bullets: MatchBulletSnapshot[];
  countdownMs: number;
  debug?: Record<string, MatchSnapshotPlayerDebug>;
  matchId: string;
  phase: MatchPhase;
  players: MatchPlayerSnapshot[];
  sequence: number;
}

export interface MatchEndedPayload {
  matchId: string;
  outcome: MatchOutcome;
  reason: MatchEndReason;
  winnerId: string | null;
}

export interface MultiplayerRuntimeConfig {
  inputPushIntervalMs: number;
  serverAuthorityMode: "authoritative";
  worldSyncMode: "seed-plus-events";
}

export interface AchievementUnlockedPayload {
  achievementId: string;
  unlockedAt: string;
}

export interface ServerToClientEvents {
  "match:ended": (payload: MatchEndedPayload) => void;
  "match:found": (payload: MatchFoundPayload) => void;
  "match:snapshot": (payload: MatchSnapshotPayload) => void;
  "match:world-events": (payload: MatchWorldEventsPayload) => void;
  "matchmaking:status": (payload: MatchmakingStatusPayload) => void;
  "br:lobby": (payload: import("./battleRoyaleCore").BattleRoyaleLobbyPayload) => void;
  "br:match-found": (payload: import("./battleRoyaleCore").BattleRoyaleMatchFoundPayload) => void;
  "br:snapshot": (payload: import("./battleRoyaleCore").BattleRoyaleSnapshotPayload) => void;
  "br:world-events": (payload: MatchWorldEventsPayload) => void;
  "br:eliminated": (payload: import("./battleRoyaleCore").BattleRoyaleEliminatedPayload) => void;
  "br:match-ended": (payload: import("./battleRoyaleCore").BattleRoyaleMatchEndedPayload) => void;
  "achievement:unlocked": (payload: AchievementUnlockedPayload) => void;
}

export interface ClientToServerEvents {
  "match:input": (payload: ShipInputState) => void;
  "br:input": (payload: ShipInputState) => void;
}

export type SpatialHash = Map<string, Set<string>>;

export interface MatchWorldRuntime {
  ammoHash: SpatialHash;
  ammunitionPackets: Map<string, WorldAmmoState>;
  asteroidHash: SpatialHash;
  asteroids: Map<string, WorldAsteroidState>;
  heartHash: SpatialHash;
  hearts: Map<string, WorldHeartState>;
}

export interface CameraBounds {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export const MULTIPLAYER_ARENA: ArenaConfig = {
  width: 3200,
  height: 2000,
};
export const DEFAULT_SHIP_VARIANT: ShipVariant = "orbit-dart";
export const MULTIPLAYER_SHIP_VARIANTS = [
  "aurora-sprint",
  "comet-lance",
  "ember-needle",
  "orbit-dart",
  "solar-sloop",
  "starfin-drifter",
] as const satisfies readonly ShipVariant[];
export const TICK_INTERVAL_MS = 1000 / 60;
export const SNAPSHOT_INTERVAL_TICKS = 2;
export const MATCH_COUNTDOWN_MS = 2500;
export const INACTIVE_MATCH_TIMEOUT_MS = 120000;
export const PLAYER_MAX_HEALTH = 5;
export const PLAYER_MAX_AMMO = 15;
export const PLAYER_COLLISION_DIAMETER = 92;
export const PLAYER_DAMAGE_RECOVERY_TICKS = 24;
export const PLAYER_COLLISION_RESTITUTION = 0.24;
export const PLAYER_THRUST = 0.24;
export const PLAYER_TURN_SPEED = 0.055;
export const PLAYER_DRAG = 0.988;
export const PLAYER_MAX_SPEED = 8.8;
export const FIRE_COOLDOWN_TICKS = Math.round(190 / TICK_INTERVAL_MS);
export const BULLET_TTL_TICKS = Math.round(1600 / TICK_INTERVAL_MS);
export const BULLET_SPEED = 15.5;
export const BULLET_DIAMETER = 14;
export const BULLET_NOSE_OFFSET = 58;
export const WORLD_MARGIN = 140;
export const PLAYER_SAFE_RADIUS = 320;
export const HEART_SAFE_RADIUS = 190;
export const AMMO_SAFE_RADIUS = 180;
export const ASTEROID_TARGET_COUNT = 22;
export const ASTEROID_MIN_SIZE = 82;
export const ASTEROID_MAX_SIZE = 188;
export const ASTEROID_CLEARANCE = 72;
export const ASTEROID_RESPAWN_INTERVAL_MS = 6500;
export const HEART_SIZE = 200 / 3;
export const HEART_CLEARANCE = 36;
export const INITIAL_HEART_COUNT = 7;
export const MAX_HEART_COUNT = 11;
export const HEART_SPAWN_INTERVAL_MS = 8500;
export const PLAYER_STARTING_AMMO = 5;
export const AMMO_PACKET_CLEARANCE = 32;
export const INITIAL_AMMO_PACKET_COUNT = 5;
export const MAX_AMMO_PACKET_COUNT = 8;
export const AMMO_PACKET_SPAWN_INTERVAL_MS = 9000;
export const SPATIAL_CELL_SIZE = 280;
export const SPATIAL_QUERY_PADDING = 36;
export const LOCAL_INPUT_PUSH_INTERVAL_MS = 33;
export const AMMO_PACKET_AMOUNTS = [3, 3, 4, 4, 5, 5, 6] as const;
const getAmmoPacketSize = (amount: number) => {
  return 48 + amount * 4;
};
export const AMMO_PACKET_MAX_SIZE = getAmmoPacketSize(
  AMMO_PACKET_AMOUNTS[AMMO_PACKET_AMOUNTS.length - 1],
);

export const createEmptyInputState = (): ShipInputState => {
  return {
    fire: false,
    inputSeq: 0,
    thrust: false,
    turnLeft: false,
    turnRight: false,
  };
};

export const clamp = (value: number, minValue: number, maxValue: number) => {
  return Math.max(minValue, Math.min(maxValue, value));
};

export const circlesOverlap = (
  x1: number,
  y1: number,
  diameter1: number,
  x2: number,
  y2: number,
  diameter2: number,
) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const radiusSum = diameter1 / 2 + diameter2 / 2;
  return dx * dx + dy * dy <= radiusSum * radiusSum;
};

export const createCameraBounds = (
  centerX: number,
  centerY: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 0,
): CameraBounds => {
  return {
    left: centerX - viewportWidth / 2 - padding,
    right: centerX + viewportWidth / 2 + padding,
    top: centerY - viewportHeight / 2 - padding,
    bottom: centerY + viewportHeight / 2 + padding,
  };
};

export const circleIntersectsBounds = (
  x: number,
  y: number,
  diameter: number,
  bounds: CameraBounds,
) => {
  const radius = diameter / 2;
  return (
    x + radius >= bounds.left &&
    x - radius <= bounds.right &&
    y + radius >= bounds.top &&
    y - radius <= bounds.bottom
  );
};

export const createHashKey = (column: number, row: number) => {
  return `${column}:${row}`;
};

export const createSeededRandom = (seed: number) => {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

export const randomBetween = (random: () => number, minValue: number, maxValue: number) => {
  return minValue + random() * (maxValue - minValue);
};

export const getPlayerSpawnPosition = (
  slot: PlayerSlot,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return {
    x: slot === "alpha" ? -arena.width * 0.2 : arena.width * 0.2,
    y: 0,
  };
};

export const createRuntimePlayerState = (
  id: string,
  slot: PlayerSlot,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
  shipVariant: ShipVariant = DEFAULT_SHIP_VARIANT,
): RuntimePlayerState => {
  const spawn = getPlayerSpawnPosition(slot, arena);

  return {
    angle: slot === "alpha" ? 0 : Math.PI,
    ammo: PLAYER_STARTING_AMMO,
    damageRecoveryTicks: 0,
    fireCooldownTicks: 0,
    health: PLAYER_MAX_HEALTH,
    id,
    lastInputSeq: 0,
    shipVariant,
    slot,
    thrusting: false,
    vx: 0,
    vy: 0,
    x: spawn.x,
    y: spawn.y,
  };
};

export const createRuntimeBulletState = (
  playerState: RuntimePlayerState,
  bulletId: string,
): RuntimeBulletState => {
  const directionX = Math.cos(playerState.angle);
  const directionY = Math.sin(playerState.angle);

  return {
    id: bulletId,
    ownerId: playerState.id,
    ttlTicks: BULLET_TTL_TICKS,
    vx: playerState.vx * 0.35 + directionX * BULLET_SPEED,
    vy: playerState.vy * 0.35 + directionY * BULLET_SPEED,
    x: playerState.x + directionX * BULLET_NOSE_OFFSET,
    y: playerState.y + directionY * BULLET_NOSE_OFFSET,
  };
};

export const advanceRuntimeBulletState = (bullet: RuntimeBulletState) => {
  bullet.x += bullet.vx;
  bullet.y += bullet.vy;
  bullet.ttlTicks--;
};

export const isRuntimeBulletOutOfBounds = (
  bullet: RuntimeBulletState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return (
    bullet.ttlTicks <= 0 ||
    Math.abs(bullet.x) > arena.width / 2 ||
    Math.abs(bullet.y) > arena.height / 2
  );
};

export const snapshotPlayerState = (state: RuntimePlayerState): MatchPlayerSnapshot => {
  return {
    angle: state.angle,
    ammo: state.ammo,
    damageRecoveryTicks: state.damageRecoveryTicks,
    health: state.health,
    id: state.id,
    lastInputSeq: state.lastInputSeq,
    shipVariant: state.shipVariant,
    slot: state.slot,
    thrusting: state.thrusting,
    vx: state.vx,
    vy: state.vy,
    x: state.x,
    y: state.y,
  };
};

export const projectPlayerSnapshot = (
  state: MatchPlayerSnapshot,
  predictedTicks: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
): MatchPlayerSnapshot => {
  const xLimit = arena.width / 2 - PLAYER_COLLISION_DIAMETER / 2;
  const yLimit = arena.height / 2 - PLAYER_COLLISION_DIAMETER / 2;

  return {
    ...state,
    x: clamp(state.x + state.vx * predictedTicks, -xLimit, xLimit),
    y: clamp(state.y + state.vy * predictedTicks, -yLimit, yLimit),
  };
};

export const projectBulletSnapshot = (
  bullet: MatchBulletSnapshot,
  predictedTicks: number,
): MatchBulletSnapshot => {
  return {
    ...bullet,
    x: bullet.x + bullet.vx * predictedTicks,
    y: bullet.y + bullet.vy * predictedTicks,
  };
};

export const stepPlayerState = (
  state: RuntimePlayerState,
  input: ShipInputState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  if (state.health <= 0) {
    state.thrusting = false;
    return;
  }

  if (state.damageRecoveryTicks > 0) {
    state.damageRecoveryTicks--;
  }

  const xLimit = arena.width / 2 - PLAYER_COLLISION_DIAMETER / 2;
  const yLimit = arena.height / 2 - PLAYER_COLLISION_DIAMETER / 2;
  const turnDirection = Number(input.turnRight) - Number(input.turnLeft);

  state.angle += turnDirection * PLAYER_TURN_SPEED;
  state.thrusting = input.thrust;

  if (input.thrust) {
    state.vx += Math.cos(state.angle) * PLAYER_THRUST;
    state.vy += Math.sin(state.angle) * PLAYER_THRUST;
  }

  state.vx *= PLAYER_DRAG;
  state.vy *= PLAYER_DRAG;

  const speed = Math.hypot(state.vx, state.vy);
  if (speed > PLAYER_MAX_SPEED) {
    const speedScale = PLAYER_MAX_SPEED / speed;
    state.vx *= speedScale;
    state.vy *= speedScale;
  }

  const nextX = clamp(state.x + state.vx, -xLimit, xLimit);
  const nextY = clamp(state.y + state.vy, -yLimit, yLimit);

  if (nextX !== state.x + state.vx) {
    state.vx = 0;
  }
  if (nextY !== state.y + state.vy) {
    state.vy = 0;
  }

  state.x = nextX;
  state.y = nextY;

  if (state.fireCooldownTicks > 0) {
    state.fireCooldownTicks--;
  }
};

export const resolvePlayerCollision = (
  firstPlayer: RuntimePlayerState,
  secondPlayer: RuntimePlayerState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  const dx = secondPlayer.x - firstPlayer.x;
  const dy = secondPlayer.y - firstPlayer.y;
  const distance = Math.hypot(dx, dy);
  const minimumDistance = PLAYER_COLLISION_DIAMETER;

  if (distance >= minimumDistance) {
    return false;
  }

  const normalX = distance > 0.0001 ? dx / distance : 1;
  const normalY = distance > 0.0001 ? dy / distance : 0;
  const overlap = minimumDistance - distance;
  const pushX = normalX * overlap * 0.5;
  const pushY = normalY * overlap * 0.5;
  const xLimit = arena.width / 2 - PLAYER_COLLISION_DIAMETER / 2;
  const yLimit = arena.height / 2 - PLAYER_COLLISION_DIAMETER / 2;

  firstPlayer.x = clamp(firstPlayer.x - pushX, -xLimit, xLimit);
  firstPlayer.y = clamp(firstPlayer.y - pushY, -yLimit, yLimit);
  secondPlayer.x = clamp(secondPlayer.x + pushX, -xLimit, xLimit);
  secondPlayer.y = clamp(secondPlayer.y + pushY, -yLimit, yLimit);

  const firstVelocityAlongNormal = firstPlayer.vx * normalX + firstPlayer.vy * normalY;
  const secondVelocityAlongNormal = secondPlayer.vx * normalX + secondPlayer.vy * normalY;
  const closingSpeed = Math.max(0, firstVelocityAlongNormal - secondVelocityAlongNormal);
  const bounceSpeed = closingSpeed * PLAYER_COLLISION_RESTITUTION;

  if (bounceSpeed > 0) {
    firstPlayer.vx = clamp(
      firstPlayer.vx - normalX * bounceSpeed * 0.5,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    firstPlayer.vy = clamp(
      firstPlayer.vy - normalY * bounceSpeed * 0.5,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    secondPlayer.vx = clamp(
      secondPlayer.vx + normalX * bounceSpeed * 0.5,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    secondPlayer.vy = clamp(
      secondPlayer.vy + normalY * bounceSpeed * 0.5,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
  }

  return true;
};

export const createEmptyMatchWorld = (): MatchWorldRuntime => {
  return {
    ammoHash: new Map<string, Set<string>>(),
    ammunitionPackets: new Map<string, WorldAmmoState>(),
    asteroidHash: new Map<string, Set<string>>(),
    asteroids: new Map<string, WorldAsteroidState>(),
    heartHash: new Map<string, Set<string>>(),
    hearts: new Map<string, WorldHeartState>(),
  };
};

export const addAsteroidToWorld = (
  world: MatchWorldRuntime,
  asteroid: WorldAsteroidState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  world.asteroids.set(asteroid.id, asteroid);
  addEntityToSpatialHash(world.asteroidHash, asteroid.id, asteroid.x, asteroid.y, arena);
};

export const removeAsteroidFromWorld = (
  world: MatchWorldRuntime,
  asteroidId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  const asteroid = world.asteroids.get(asteroidId);
  if (asteroid === undefined) {
    return false;
  }

  removeEntityFromSpatialHash(world.asteroidHash, asteroidId, asteroid.x, asteroid.y, arena);
  world.asteroids.delete(asteroidId);
  return true;
};

export const addHeartToWorld = (
  world: MatchWorldRuntime,
  heart: WorldHeartState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  world.hearts.set(heart.id, heart);
  addEntityToSpatialHash(world.heartHash, heart.id, heart.x, heart.y, arena);
};

export const removeHeartFromWorld = (
  world: MatchWorldRuntime,
  heartId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  const heart = world.hearts.get(heartId);
  if (heart === undefined) {
    return false;
  }

  removeEntityFromSpatialHash(world.heartHash, heartId, heart.x, heart.y, arena);
  world.hearts.delete(heartId);
  return true;
};

export const addAmmoToWorld = (
  world: MatchWorldRuntime,
  ammo: WorldAmmoState,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  world.ammunitionPackets.set(ammo.id, ammo);
  addEntityToSpatialHash(world.ammoHash, ammo.id, ammo.x, ammo.y, arena);
};

export const removeAmmoFromWorld = (
  world: MatchWorldRuntime,
  ammoId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  const ammo = world.ammunitionPackets.get(ammoId);
  if (ammo === undefined) {
    return false;
  }

  removeEntityFromSpatialHash(world.ammoHash, ammoId, ammo.x, ammo.y, arena);
  world.ammunitionPackets.delete(ammoId);
  return true;
};

export const applyWorldEvent = (
  world: MatchWorldRuntime,
  event: WorldEvent,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  switch (event.type) {
    case "asteroid-spawned":
      addAsteroidToWorld(world, event.asteroid, arena);
      return;
    case "asteroid-removed":
      removeAsteroidFromWorld(world, event.asteroidId, arena);
      return;
    case "heart-spawned":
      addHeartToWorld(world, event.heart, arena);
      return;
    case "heart-removed":
      removeHeartFromWorld(world, event.heartId, arena);
      return;
    case "ammo-spawned":
      addAmmoToWorld(world, event.ammo, arena);
      return;
    case "ammo-removed":
      removeAmmoFromWorld(world, event.ammoId, arena);
      return;
  }
};

export const applyWorldEvents = (
  world: MatchWorldRuntime,
  events: WorldEvent[],
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  for (let i = 0; i < events.length; i++) {
    applyWorldEvent(world, events[i], arena);
  }
};

export const getNearbyAsteroids = (
  world: MatchWorldRuntime,
  x: number,
  y: number,
  radius: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return querySpatialEntities(
    world.asteroidHash,
    world.asteroids,
    x,
    y,
    radius,
    ASTEROID_MAX_SIZE,
    arena,
  );
};

export const getNearbyHearts = (
  world: MatchWorldRuntime,
  x: number,
  y: number,
  radius: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return querySpatialEntities(world.heartHash, world.hearts, x, y, radius, HEART_SIZE, arena);
};

export const getAsteroidsInBounds = (
  world: MatchWorldRuntime,
  bounds: CameraBounds,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return queryEntitiesInBounds(
    world.asteroidHash,
    world.asteroids,
    bounds,
    ASTEROID_MAX_SIZE,
    arena,
  );
};

export const getHeartsInBounds = (
  world: MatchWorldRuntime,
  bounds: CameraBounds,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return queryEntitiesInBounds(world.heartHash, world.hearts, bounds, HEART_SIZE, arena);
};

export const getNearbyAmmoPackets = (
  world: MatchWorldRuntime,
  x: number,
  y: number,
  radius: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return querySpatialEntities(
    world.ammoHash,
    world.ammunitionPackets,
    x,
    y,
    radius,
    AMMO_PACKET_MAX_SIZE,
    arena,
  );
};

export const getAmmoPacketsInBounds = (
  world: MatchWorldRuntime,
  bounds: CameraBounds,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  return queryEntitiesInBounds(
    world.ammoHash,
    world.ammunitionPackets,
    bounds,
    AMMO_PACKET_MAX_SIZE,
    arena,
  );
};

export const createInitialMatchWorld = (
  worldSeed: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  const random = createSeededRandom(worldSeed);
  const world = createEmptyMatchWorld();
  const playerPositions = [
    getPlayerSpawnPosition("alpha", arena),
    getPlayerSpawnPosition("beta", arena),
  ];

  for (let asteroidIndex = 0; asteroidIndex < ASTEROID_TARGET_COUNT; asteroidIndex++) {
    const asteroid = spawnAsteroidFromRandom(
      world,
      playerPositions,
      random,
      `asteroid:init:${asteroidIndex}`,
      arena,
    );

    if (asteroid !== null) {
      addAsteroidToWorld(world, asteroid, arena);
    }
  }

  for (let heartIndex = 0; heartIndex < INITIAL_HEART_COUNT; heartIndex++) {
    const heart = spawnHeartFromRandom(
      world,
      playerPositions,
      random,
      `heart:init:${heartIndex}`,
      arena,
    );

    if (heart !== null) {
      addHeartToWorld(world, heart, arena);
    }
  }

  for (let ammoPacketIndex = 0; ammoPacketIndex < INITIAL_AMMO_PACKET_COUNT; ammoPacketIndex++) {
    const ammo = spawnAmmoFromRandom(
      world,
      playerPositions,
      random,
      `ammo:init:${ammoPacketIndex}`,
      arena,
    );

    if (ammo !== null) {
      addAmmoToWorld(world, ammo, arena);
    }
  }

  return world;
};

export const spawnAsteroidFromRandom = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  asteroidId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
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

    return createAsteroidState(random, asteroidId, x, y, size);
  }

  return null;
};

export const spawnHeartFromRandom = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  heartId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
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
      size: HEART_SIZE,
      x,
      y,
    };
  }

  return null;
};

export const spawnAmmoFromRandom = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  random: () => number,
  ammoId: string,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
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
    const amount = AMMO_PACKET_AMOUNTS[Math.floor(random() * AMMO_PACKET_AMOUNTS.length)];
    const size = getAmmoPacketSize(amount);

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

export const isAsteroidSpawnValid = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
  size: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  if (!isInsideWorldMargin(x, y, arena)) {
    return false;
  }

  for (let i = 0; i < playerPositions.length; i++) {
    const player = playerPositions[i];
    if (
      circlesOverlap(x, y, size + PLAYER_SAFE_RADIUS, player.x, player.y, PLAYER_COLLISION_DIAMETER)
    ) {
      return false;
    }
  }

  const nearbyAsteroids = getNearbyAsteroids(world, x, y, size + ASTEROID_CLEARANCE, arena);
  for (let i = 0; i < nearbyAsteroids.length; i++) {
    const asteroid = nearbyAsteroids[i];
    if (
      circlesOverlap(
        x,
        y,
        size + ASTEROID_CLEARANCE,
        asteroid.x,
        asteroid.y,
        asteroid.size + ASTEROID_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  const nearbyHearts = getNearbyHearts(world, x, y, size, arena);
  for (let i = 0; i < nearbyHearts.length; i++) {
    const heart = nearbyHearts[i];
    if (
      circlesOverlap(x, y, size + HEART_CLEARANCE, heart.x, heart.y, heart.size + HEART_CLEARANCE)
    ) {
      return false;
    }
  }

  const nearbyAmmoPackets = getNearbyAmmoPackets(world, x, y, size, arena);
  for (let i = 0; i < nearbyAmmoPackets.length; i++) {
    const ammo = nearbyAmmoPackets[i];
    if (
      circlesOverlap(
        x,
        y,
        size + AMMO_PACKET_CLEARANCE,
        ammo.x,
        ammo.y,
        ammo.size + AMMO_PACKET_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  return true;
};

export const isHeartSpawnValid = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  if (!isInsideWorldMargin(x, y, arena)) {
    return false;
  }

  for (let i = 0; i < playerPositions.length; i++) {
    const player = playerPositions[i];
    if (
      circlesOverlap(
        x,
        y,
        HEART_SIZE + HEART_SAFE_RADIUS,
        player.x,
        player.y,
        PLAYER_COLLISION_DIAMETER,
      )
    ) {
      return false;
    }
  }

  const nearbyAsteroids = getNearbyAsteroids(world, x, y, HEART_SIZE, arena);
  for (let i = 0; i < nearbyAsteroids.length; i++) {
    const asteroid = nearbyAsteroids[i];
    if (
      circlesOverlap(
        x,
        y,
        HEART_SIZE + HEART_CLEARANCE,
        asteroid.x,
        asteroid.y,
        asteroid.size + HEART_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  const nearbyHearts = getNearbyHearts(world, x, y, HEART_SIZE, arena);
  for (let i = 0; i < nearbyHearts.length; i++) {
    const heart = nearbyHearts[i];
    if (
      circlesOverlap(
        x,
        y,
        HEART_SIZE + HEART_CLEARANCE,
        heart.x,
        heart.y,
        heart.size + HEART_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  const nearbyAmmoPackets = getNearbyAmmoPackets(world, x, y, HEART_SIZE, arena);
  for (let i = 0; i < nearbyAmmoPackets.length; i++) {
    const ammo = nearbyAmmoPackets[i];
    if (
      circlesOverlap(
        x,
        y,
        HEART_SIZE + AMMO_PACKET_CLEARANCE,
        ammo.x,
        ammo.y,
        ammo.size + AMMO_PACKET_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  return true;
};

export const isAmmoSpawnValid = (
  world: MatchWorldRuntime,
  playerPositions: ReadonlyArray<{ x: number; y: number }>,
  x: number,
  y: number,
  size: number,
  arena: ArenaConfig = MULTIPLAYER_ARENA,
) => {
  if (!isInsideWorldMargin(x, y, arena)) {
    return false;
  }

  for (let i = 0; i < playerPositions.length; i++) {
    const player = playerPositions[i];
    if (
      circlesOverlap(x, y, size + AMMO_SAFE_RADIUS, player.x, player.y, PLAYER_COLLISION_DIAMETER)
    ) {
      return false;
    }
  }

  const nearbyAsteroids = getNearbyAsteroids(world, x, y, size, arena);
  for (let i = 0; i < nearbyAsteroids.length; i++) {
    const asteroid = nearbyAsteroids[i];
    if (
      circlesOverlap(
        x,
        y,
        size + AMMO_PACKET_CLEARANCE,
        asteroid.x,
        asteroid.y,
        asteroid.size + AMMO_PACKET_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  const nearbyHearts = getNearbyHearts(world, x, y, size, arena);
  for (let i = 0; i < nearbyHearts.length; i++) {
    const heart = nearbyHearts[i];
    if (
      circlesOverlap(
        x,
        y,
        size + AMMO_PACKET_CLEARANCE,
        heart.x,
        heart.y,
        heart.size + AMMO_PACKET_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  const nearbyAmmoPackets = getNearbyAmmoPackets(world, x, y, size, arena);
  for (let i = 0; i < nearbyAmmoPackets.length; i++) {
    const ammo = nearbyAmmoPackets[i];
    if (
      circlesOverlap(
        x,
        y,
        size + AMMO_PACKET_CLEARANCE,
        ammo.x,
        ammo.y,
        ammo.size + AMMO_PACKET_CLEARANCE,
      )
    ) {
      return false;
    }
  }

  return true;
};

const createAsteroidState = (
  random: () => number,
  asteroidId: string,
  x: number,
  y: number,
  size: number,
): WorldAsteroidState => {
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
};

const isInsideWorldMargin = (x: number, y: number, arena: ArenaConfig) => {
  return (
    x >= -arena.width / 2 + WORLD_MARGIN &&
    x <= arena.width / 2 - WORLD_MARGIN &&
    y >= -arena.height / 2 + WORLD_MARGIN &&
    y <= arena.height / 2 - WORLD_MARGIN
  );
};

const addEntityToSpatialHash = (
  hash: SpatialHash,
  entityId: string,
  x: number,
  y: number,
  arena: ArenaConfig,
) => {
  const column = Math.floor((x + arena.width / 2) / SPATIAL_CELL_SIZE);
  const row = Math.floor((y + arena.height / 2) / SPATIAL_CELL_SIZE);
  const hashKey = createHashKey(column, row);
  const existingBucket = hash.get(hashKey);

  if (existingBucket === undefined) {
    hash.set(hashKey, new Set<string>([entityId]));
    return;
  }

  existingBucket.add(entityId);
};

const removeEntityFromSpatialHash = (
  hash: SpatialHash,
  entityId: string,
  x: number,
  y: number,
  arena: ArenaConfig,
) => {
  const column = Math.floor((x + arena.width / 2) / SPATIAL_CELL_SIZE);
  const row = Math.floor((y + arena.height / 2) / SPATIAL_CELL_SIZE);
  const hashKey = createHashKey(column, row);
  const existingBucket = hash.get(hashKey);
  existingBucket?.delete(entityId);

  if (existingBucket !== undefined && existingBucket.size === 0) {
    hash.delete(hashKey);
  }
};

const queryEntityIds = (
  hash: SpatialHash,
  x: number,
  y: number,
  radius: number,
  maxEntitySize: number,
  arena: ArenaConfig,
) => {
  const searchPadding = radius + maxEntitySize / 2 + SPATIAL_QUERY_PADDING;
  const minColumn = Math.floor((x - searchPadding + arena.width / 2) / SPATIAL_CELL_SIZE);
  const maxColumn = Math.floor((x + searchPadding + arena.width / 2) / SPATIAL_CELL_SIZE);
  const minRow = Math.floor((y - searchPadding + arena.height / 2) / SPATIAL_CELL_SIZE);
  const maxRow = Math.floor((y + searchPadding + arena.height / 2) / SPATIAL_CELL_SIZE);
  const entityIds = new Set<string>();

  for (let row = minRow; row <= maxRow; row++) {
    for (let column = minColumn; column <= maxColumn; column++) {
      const bucket = hash.get(createHashKey(column, row));
      if (bucket === undefined) {
        continue;
      }

      bucket.forEach((entityId) => {
        entityIds.add(entityId);
      });
    }
  }

  return Array.from(entityIds);
};

const querySpatialEntities = <T extends { id: string }>(
  hash: SpatialHash,
  entities: Map<string, T>,
  x: number,
  y: number,
  radius: number,
  maxEntitySize: number,
  arena: ArenaConfig,
) => {
  const entityIds = queryEntityIds(hash, x, y, radius, maxEntitySize, arena);
  const nearbyEntities: T[] = [];

  for (let i = 0; i < entityIds.length; i++) {
    const entity = entities.get(entityIds[i]);
    if (entity !== undefined) {
      nearbyEntities.push(entity);
    }
  }

  return nearbyEntities;
};

const queryEntitiesInBounds = <T extends { id: string; size: number; x: number; y: number }>(
  hash: SpatialHash,
  entities: Map<string, T>,
  bounds: CameraBounds,
  maxEntitySize: number,
  arena: ArenaConfig,
) => {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const radius = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) / 2;
  const candidateIds = queryEntityIds(hash, centerX, centerY, radius, maxEntitySize, arena);
  const visibleEntities: T[] = [];

  for (let i = 0; i < candidateIds.length; i++) {
    const entity = entities.get(candidateIds[i]);
    if (entity === undefined) {
      continue;
    }

    if (circleIntersectsBounds(entity.x, entity.y, entity.size, bounds)) {
      visibleEntities.push(entity);
    }
  }

  return visibleEntities;
};
