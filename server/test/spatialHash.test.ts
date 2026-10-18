import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASTEROID_MAX_SIZE,
  addAsteroidToWorld,
  BATTLE_ROYALE_ARENA,
  circleIntersectsBounds,
  createCameraBounds,
  createEmptyMatchWorld,
  createSeededRandom,
  getAsteroidsInBounds,
  getNearbyAsteroids,
  SPATIAL_CELL_SIZE,
  SPATIAL_QUERY_PADDING,
  type WorldAsteroidState,
} from "../../shared/src";

const arena = BATTLE_ROYALE_ARENA;

/** The query as it was written with string cell keys and a Set of IDs. */
const referenceNearby = (asteroids: WorldAsteroidState[], x: number, y: number, radius: number) => {
  const cellOf = (value: number, size: number) =>
    Math.floor((value + size / 2) / SPATIAL_CELL_SIZE);
  const buckets = new Map<string, Set<string>>();
  for (const asteroid of asteroids) {
    const key = `${cellOf(asteroid.x, arena.width)}:${cellOf(asteroid.y, arena.height)}`;
    const bucket = buckets.get(key) ?? new Set<string>();
    bucket.add(asteroid.id);
    buckets.set(key, bucket);
  }
  const padding = radius + ASTEROID_MAX_SIZE / 2 + SPATIAL_QUERY_PADDING;
  const ids = new Set<string>();
  for (
    let row = cellOf(y - padding, arena.height);
    row <= cellOf(y + padding, arena.height);
    row++
  ) {
    for (
      let column = cellOf(x - padding, arena.width);
      column <= cellOf(x + padding, arena.width);
      column++
    ) {
      for (const id of buckets.get(`${column}:${row}`) ?? []) ids.add(id);
    }
  }
  const byId = new Map(asteroids.map((asteroid) => [asteroid.id, asteroid]));
  return Array.from(ids, (id) => byId.get(id));
};

const createWorld = () => {
  const random = createSeededRandom(11);
  const world = createEmptyMatchWorld();
  const asteroids: WorldAsteroidState[] = [];
  for (let index = 0; index < 120; index++) {
    const asteroid: WorldAsteroidState = {
      baseRotation: 0,
      hitPoints: 1,
      id: `asteroid:${index}`,
      size: 80 + random() * 100,
      spinSpeed: 0,
      variant: 0,
      x: (random() - 0.5) * arena.width,
      y: (random() - 0.5) * arena.height,
    };
    asteroids.push(asteroid);
    addAsteroidToWorld(world, asteroid, arena);
  }
  return { asteroids, random, world };
};

test("nearby queries return the same entities in the same order as string cell keys did", () => {
  const { asteroids, random, world } = createWorld();
  const scratch: WorldAsteroidState[] = [];
  for (let query = 0; query < 400; query++) {
    // Include points beyond the arena edge, where cells go negative.
    const x = (random() - 0.5) * arena.width * 1.2;
    const y = (random() - 0.5) * arena.height * 1.2;
    const radius = random() * 400;
    const expected = referenceNearby(asteroids, x, y, radius);
    assert.deepEqual(getNearbyAsteroids(world, x, y, radius, arena), expected);
    assert.equal(getNearbyAsteroids(world, x, y, radius, arena, scratch), scratch);
    assert.deepEqual(scratch, expected);
  }
});

test("bounds queries keep only entities that touch the bounds", () => {
  const { asteroids, random, world } = createWorld();
  for (let query = 0; query < 100; query++) {
    const bounds = createCameraBounds(
      (random() - 0.5) * arena.width,
      (random() - 0.5) * arena.height,
      1600,
      900,
    );
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const expected = referenceNearby(asteroids, centerX, centerY, 800).filter(
      (asteroid) =>
        asteroid !== undefined &&
        circleIntersectsBounds(asteroid.x, asteroid.y, asteroid.size, bounds),
    );
    assert.deepEqual(getAsteroidsInBounds(world, bounds, arena), expected);
  }
});
