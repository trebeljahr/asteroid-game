import type p5 from "p5";
import { v4 } from "uuid";
import {
  ASTEROID_COLLISION_SHAPES,
  type TransformedCollisionShape,
  transformCollisionShape,
} from "../../shared/src";

import { goals } from "./goals";
import { Mover } from "./mover";
import { player } from "./player";
import { assets } from "./sketch";
import {
  boardSizeX,
  boardSizeY,
  type CameraBounds,
  circleIntersectsBounds,
  circlesOverlap,
  clamp,
  distanceToSegmentSquare,
  distSquare,
} from "./utils";

type Image = p5.Image;
type Vector = p5.Vector;

interface SpawnPoint {
  x: number;
  y: number;
}

interface RouteSegment {
  end: Vector;
  start: Vector;
}

const HASH_QUERY_PADDING = 36;
const HASH_WORLD_MARGIN = 160;
const MAX_SPAWN_POINT_FACTOR = 1.9;
const MIN_ASTEROID_SIZE = 70;
const MIN_ASTEROID_COUNT = 44;
const ASTEROID_FIELD_BUILD_ATTEMPTS = 4;
const ASTEROID_OVERLAP_RESOLUTION_ATTEMPTS = 180;
const ASTEROID_SPAWN_CLEARANCE = 18;
const PLAYER_SAFE_RADIUS = 320;
const GOAL_SAFE_RADIUS = 180;
const POISSON_ATTEMPTS = 24;
const REFERENCE_WORLD_AREA = 1440 * 900 * 16;
const ROUTE_CORRIDOR_RADIUS = 170;
const SPAWN_DISTANCE_SCALES = [1, 0.98, 0.94];
const SPATIAL_HASH_CELL_SIZE = 320;

export let asteroids = {} as Asteroids;
export const resetAsteroids = (p: p5) => {
  asteroids = new Asteroids(p);
};

export const maxAsteroids = 100;
export const maxAsteroidSize = 190;
const MIN_ASTEROID_SEPARATION = maxAsteroidSize + ASTEROID_SPAWN_CLEARANCE;

const createHashKey = (column: number, row: number) => {
  return `${column}:${row}`;
};

const shuffle = <T>(p: p5, values: T[]) => {
  const nextValues = values.slice();
  for (let i = nextValues.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(p.random(i + 1));
    const currentValue = nextValues[i];
    nextValues[i] = nextValues[swapIndex];
    nextValues[swapIndex] = currentValue;
  }
  return nextValues;
};

class Asteroids {
  asteroidHashKeys: Array<string | null>;
  asteroidTargetCount: number;
  asteroids: Asteroid[];
  p: p5;
  occupiedSpawnPointIndices: Set<number>;
  routeSegments: RouteSegment[];
  spatialHash: Map<string, Set<number>>;
  spawnPoints: SpawnPoint[];

  constructor(p: p5) {
    this.p = p;
    this.asteroids = [];
    this.asteroidHashKeys = [];
    this.asteroidTargetCount = this.getAsteroidTargetCount();
    this.occupiedSpawnPointIndices = new Set<number>();
    this.spatialHash = new Map<string, Set<number>>();
    this.routeSegments = [];
    this.spawnPoints = [];

    this.rebuildField();
  }

  createRouteSegments() {
    const routeAnchors = [
      this.p.createVector(player.enginePlayer.position.x, player.enginePlayer.position.y),
      ...goals.route.map((goal) => goal.pos.copy()),
    ];
    const segments: RouteSegment[] = [];

    for (let i = 0; i < routeAnchors.length - 1; i++) {
      segments.push({
        start: routeAnchors[i],
        end: routeAnchors[i + 1],
      });
    }

    return segments;
  }

  createSpawnPoints() {
    const worldArea = boardSizeX * 2 * boardSizeY * 2;
    const targetSpawnPoints = Math.ceil(this.asteroidTargetCount * MAX_SPAWN_POINT_FACTOR);
    const baseMinDistance = clamp(
      Math.sqrt(worldArea / (this.asteroidTargetCount * 4.8)),
      MIN_ASTEROID_SEPARATION,
      290,
    );

    for (let i = 0; i < SPAWN_DISTANCE_SCALES.length; i++) {
      const nextPoints = this.generatePoissonSpawnPoints(
        baseMinDistance * SPAWN_DISTANCE_SCALES[i],
        targetSpawnPoints,
      );
      if (nextPoints.length >= this.asteroidTargetCount) {
        return shuffle(this.p, nextPoints);
      }
    }

    return shuffle(
      this.p,
      this.generateFallbackSpawnPoints(
        Math.max(MIN_ASTEROID_SEPARATION, baseMinDistance * 0.92),
        targetSpawnPoints,
      ),
    );
  }

  getAsteroidTargetCount() {
    const worldArea = boardSizeX * 2 * boardSizeY * 2;
    const scaledCount = Math.round(maxAsteroids * Math.sqrt(worldArea / REFERENCE_WORLD_AREA));
    return clamp(scaledCount, MIN_ASTEROID_COUNT, maxAsteroids);
  }

  generatePoissonSpawnPoints(minDistance: number, targetSpawnPoints: number) {
    const cellSize = minDistance / Math.sqrt(2);
    const columns = Math.ceil((boardSizeX * 2) / cellSize);
    const rows = Math.ceil((boardSizeY * 2) / cellSize);
    const grid = new Array<SpawnPoint | null>(columns * rows).fill(null);
    const spawnPoints: SpawnPoint[] = [];
    const activePoints: SpawnPoint[] = [];

    const insertPoint = (point: SpawnPoint) => {
      spawnPoints.push(point);
      activePoints.push(point);
      const gridColumn = Math.floor((point.x + boardSizeX) / cellSize);
      const gridRow = Math.floor((point.y + boardSizeY) / cellSize);
      grid[gridRow * columns + gridColumn] = point;
    };

    const isValidPoint = (point: SpawnPoint) => {
      if (!this.isSpawnPointAllowed(point)) {
        return false;
      }

      const gridColumn = Math.floor((point.x + boardSizeX) / cellSize);
      const gridRow = Math.floor((point.y + boardSizeY) / cellSize);
      const minColumn = Math.max(0, gridColumn - 2);
      const maxColumn = Math.min(columns - 1, gridColumn + 2);
      const minRow = Math.max(0, gridRow - 2);
      const maxRow = Math.min(rows - 1, gridRow + 2);

      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const neighbor = grid[row * columns + column];
          if (neighbor === null) {
            continue;
          }
          if (distSquare(point.x, point.y, neighbor.x, neighbor.y) < minDistance * minDistance) {
            return false;
          }
        }
      }

      return true;
    };

    const seedPoint = this.findSeedPoint();
    if (seedPoint === null) {
      return spawnPoints;
    }

    insertPoint(seedPoint);

    while (activePoints.length > 0 && spawnPoints.length < targetSpawnPoints) {
      const activeIndex = Math.floor(this.p.random(activePoints.length));
      const origin = activePoints[activeIndex];
      let foundNextPoint = false;

      for (let attempt = 0; attempt < POISSON_ATTEMPTS; attempt++) {
        const angle = this.p.random(this.p.TWO_PI);
        const distance = this.p.random(minDistance, minDistance * 2.05);
        const candidate = {
          x: origin.x + this.p.cos(angle) * distance,
          y: origin.y + this.p.sin(angle) * distance,
        };

        if (!isValidPoint(candidate)) {
          continue;
        }

        insertPoint(candidate);
        foundNextPoint = true;
        break;
      }

      if (!foundNextPoint) {
        activePoints.splice(activeIndex, 1);
      }
    }

    return spawnPoints;
  }

  generateFallbackSpawnPoints(minDistance: number, targetSpawnPoints: number) {
    const spawnPoints: SpawnPoint[] = [];

    for (let attempt = 0; attempt < targetSpawnPoints * 80; attempt++) {
      if (spawnPoints.length >= targetSpawnPoints) {
        break;
      }

      const candidate = this.findSeedPoint();
      if (candidate === null) {
        break;
      }

      let isFarEnough = true;
      for (let i = 0; i < spawnPoints.length; i++) {
        if (
          distSquare(candidate.x, candidate.y, spawnPoints[i].x, spawnPoints[i].y) <
          minDistance * minDistance
        ) {
          isFarEnough = false;
          break;
        }
      }

      if (isFarEnough) {
        spawnPoints.push(candidate);
      }
    }

    return spawnPoints;
  }

  findSeedPoint() {
    for (let attempt = 0; attempt < 240; attempt++) {
      const candidate = {
        x: this.p.random(-boardSizeX + HASH_WORLD_MARGIN, boardSizeX - HASH_WORLD_MARGIN),
        y: this.p.random(-boardSizeY + HASH_WORLD_MARGIN, boardSizeY - HASH_WORLD_MARGIN),
      };

      if (this.isSpawnPointAllowed(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  isSpawnPointAllowed(point: SpawnPoint) {
    if (
      point.x < -boardSizeX + HASH_WORLD_MARGIN ||
      point.x > boardSizeX - HASH_WORLD_MARGIN ||
      point.y < -boardSizeY + HASH_WORLD_MARGIN ||
      point.y > boardSizeY - HASH_WORLD_MARGIN
    ) {
      return false;
    }

    if (
      distSquare(point.x, point.y, player.enginePlayer.position.x, player.enginePlayer.position.y) <
      PLAYER_SAFE_RADIUS * PLAYER_SAFE_RADIUS
    ) {
      return false;
    }

    for (let i = 0; i < goals.route.length; i++) {
      const goal = goals.route[i];
      if (
        distSquare(point.x, point.y, goal.pos.x, goal.pos.y) <
        GOAL_SAFE_RADIUS * GOAL_SAFE_RADIUS
      ) {
        return false;
      }
    }

    for (let i = 0; i < this.routeSegments.length; i++) {
      const segment = this.routeSegments[i];
      if (
        distanceToSegmentSquare(
          point.x,
          point.y,
          segment.start.x,
          segment.start.y,
          segment.end.x,
          segment.end.y,
        ) <
        ROUTE_CORRIDOR_RADIUS * ROUTE_CORRIDOR_RADIUS
      ) {
        return false;
      }
    }

    return true;
  }

  pickOpenSpawnPointIndex(asteroidSize: number) {
    const openPointIndices: number[] = [];

    for (let i = 0; i < this.spawnPoints.length; i++) {
      if (
        !this.occupiedSpawnPointIndices.has(i) &&
        this.isSpawnPointAvailableForAsteroid(i, asteroidSize)
      ) {
        openPointIndices.push(i);
      }
    }

    if (openPointIndices.length === 0) {
      return null;
    }

    return this.p.random(openPointIndices) as number;
  }

  isSpawnPointAvailableForAsteroid(spawnPointIndex: number, asteroidSize: number) {
    const spawnPoint = this.spawnPoints[spawnPointIndex];
    const nearbyAsteroids = this.queryNearby(spawnPoint.x, spawnPoint.y, asteroidSize / 2);

    for (let i = 0; i < nearbyAsteroids.length; i++) {
      const asteroid = this.asteroids[nearbyAsteroids[i]];
      if (
        circlesOverlap(
          spawnPoint.x,
          spawnPoint.y,
          asteroidSize + ASTEROID_SPAWN_CLEARANCE,
          asteroid.pos.x,
          asteroid.pos.y,
          asteroid.size + ASTEROID_SPAWN_CLEARANCE,
        )
      ) {
        return false;
      }
    }

    return true;
  }

  createAsteroidForSpawnPoint(spawnPointIndex: number, asteroidSize: number) {
    const spawnPoint = this.spawnPoints[spawnPointIndex];
    const asteroidHitPoints = Math.round(asteroidSize * 10);

    return new Asteroid(
      this.p,
      this.p.createVector(spawnPoint.x, spawnPoint.y),
      this.p.createVector(0, 0),
      asteroidSize,
      asteroidHitPoints,
      spawnPointIndex,
    );
  }

  createNewAsteroid() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const asteroidSize = this.p.random(MIN_ASTEROID_SIZE, maxAsteroidSize);
      const spawnPointIndex = this.pickOpenSpawnPointIndex(asteroidSize);
      if (spawnPointIndex === null) {
        continue;
      }

      return this.createAsteroidForSpawnPoint(spawnPointIndex, asteroidSize);
    }

    return null;
  }

  clearField() {
    this.asteroids = [];
    this.asteroidHashKeys = [];
    this.occupiedSpawnPointIndices.clear();
    this.spatialHash.clear();
  }

  ensureAsteroidCount() {
    while (this.asteroids.length < this.asteroidTargetCount) {
      const asteroid = this.createNewAsteroid();
      if (asteroid === null) {
        return;
      }

      const asteroidIndex = this.asteroids.length;
      this.asteroids.push(asteroid);
      this.registerAsteroid(asteroidIndex, asteroid);
    }
  }

  registerAsteroid(asteroidIndex: number, asteroid: Asteroid) {
    if (asteroid.spawnPointIndex !== null) {
      this.occupiedSpawnPointIndices.add(asteroid.spawnPointIndex);
    }

    const hashKey = this.hashKeyForPosition(asteroid.pos.x, asteroid.pos.y);
    const existingBucket = this.spatialHash.get(hashKey);
    if (existingBucket !== undefined) {
      existingBucket.add(asteroidIndex);
    } else {
      this.spatialHash.set(hashKey, new Set<number>([asteroidIndex]));
    }

    this.asteroidHashKeys[asteroidIndex] = hashKey;
  }

  rebuildRegistrations() {
    this.occupiedSpawnPointIndices.clear();
    this.spatialHash.clear();
    this.asteroidHashKeys = new Array<string | null>(this.asteroids.length).fill(null);

    for (let asteroidIndex = 0; asteroidIndex < this.asteroids.length; asteroidIndex++) {
      this.registerAsteroid(asteroidIndex, this.asteroids[asteroidIndex]);
    }
  }

  unregisterAsteroid(asteroidIndex: number) {
    const asteroid = this.asteroids[asteroidIndex];
    const hashKey = this.asteroidHashKeys[asteroidIndex];

    if (asteroid.spawnPointIndex !== null) {
      this.occupiedSpawnPointIndices.delete(asteroid.spawnPointIndex);
    }

    if (hashKey !== null && hashKey !== undefined) {
      const hashBucket = this.spatialHash.get(hashKey);
      hashBucket?.delete(asteroidIndex);
      if (hashBucket !== undefined && hashBucket.size === 0) {
        this.spatialHash.delete(hashKey);
      }
    }

    this.asteroidHashKeys[asteroidIndex] = null;
  }

  hashKeyForPosition(x: number, y: number) {
    const column = Math.floor((x + boardSizeX) / SPATIAL_HASH_CELL_SIZE);
    const row = Math.floor((y + boardSizeY) / SPATIAL_HASH_CELL_SIZE);
    return createHashKey(column, row);
  }

  run(cameraBounds: CameraBounds) {
    for (let i = 0; i < this.asteroids.length; i++) {
      const asteroid = this.asteroids[i];
      if (!circleIntersectsBounds(asteroid.pos.x, asteroid.pos.y, asteroid.size, cameraBounds)) {
        continue;
      }
      asteroid.draw();
    }
  }

  removeAsteroid(indexToRemove: number) {
    if (indexToRemove < 0 || indexToRemove >= this.asteroids.length) {
      return;
    }

    this.asteroids.splice(indexToRemove, 1);
    this.asteroidTargetCount = this.asteroids.length;
    this.rebuildRegistrations();
  }

  queryNearby(x: number, y: number, radius: number) {
    const nearbyAsteroidIndices: number[] = [];
    const searchPadding = radius + maxAsteroidSize / 2 + HASH_QUERY_PADDING;
    const minColumn = Math.floor((x - searchPadding + boardSizeX) / SPATIAL_HASH_CELL_SIZE);
    const maxColumn = Math.floor((x + searchPadding + boardSizeX) / SPATIAL_HASH_CELL_SIZE);
    const minRow = Math.floor((y - searchPadding + boardSizeY) / SPATIAL_HASH_CELL_SIZE);
    const maxRow = Math.floor((y + searchPadding + boardSizeY) / SPATIAL_HASH_CELL_SIZE);

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const hashBucket = this.spatialHash.get(createHashKey(column, row));
        if (hashBucket === undefined) {
          continue;
        }
        hashBucket.forEach((asteroidIndex) => {
          nearbyAsteroidIndices.push(asteroidIndex);
        });
      }
    }

    return nearbyAsteroidIndices;
  }

  spawnNewAsteroid(indexToChange: number) {
    if (this.asteroids.length <= 0) {
      return;
    }

    const previousAsteroid = this.asteroids[indexToChange];
    this.unregisterAsteroid(indexToChange);

    const replacement = this.createNewAsteroid();
    if (replacement === null) {
      this.registerAsteroid(indexToChange, previousAsteroid);
      return;
    }

    this.asteroids[indexToChange] = replacement;
    this.registerAsteroid(indexToChange, replacement);
  }

  findOverlappingAsteroidIndex() {
    for (let asteroidIndex = 0; asteroidIndex < this.asteroids.length; asteroidIndex++) {
      const asteroid = this.asteroids[asteroidIndex];
      const nearbyAsteroids = this.queryNearby(asteroid.pos.x, asteroid.pos.y, asteroid.size / 2);

      for (let i = 0; i < nearbyAsteroids.length; i++) {
        const otherAsteroidIndex = nearbyAsteroids[i];
        if (otherAsteroidIndex <= asteroidIndex) {
          continue;
        }

        const otherAsteroid = this.asteroids[otherAsteroidIndex];
        if (
          circlesOverlap(
            asteroid.pos.x,
            asteroid.pos.y,
            asteroid.size + ASTEROID_SPAWN_CLEARANCE,
            otherAsteroid.pos.x,
            otherAsteroid.pos.y,
            otherAsteroid.size + ASTEROID_SPAWN_CLEARANCE,
          )
        ) {
          return otherAsteroidIndex;
        }
      }
    }

    return null;
  }

  resolveOverlappingAsteroids() {
    for (let attempt = 0; attempt < ASTEROID_OVERLAP_RESOLUTION_ATTEMPTS; attempt++) {
      const overlappingAsteroidIndex = this.findOverlappingAsteroidIndex();
      if (overlappingAsteroidIndex === null) {
        return true;
      }

      this.spawnNewAsteroid(overlappingAsteroidIndex);
    }

    return this.findOverlappingAsteroidIndex() === null;
  }

  rebuildField() {
    this.asteroidTargetCount = this.getAsteroidTargetCount();

    for (let attempt = 0; attempt < ASTEROID_FIELD_BUILD_ATTEMPTS; attempt++) {
      this.clearField();
      this.routeSegments = this.createRouteSegments();
      this.spawnPoints = this.createSpawnPoints();
      this.ensureAsteroidCount();

      if (this.resolveOverlappingAsteroids()) {
        return;
      }
    }
  }

  refreshAfterResize() {
    this.routeSegments = this.createRouteSegments();
    this.spawnPoints = this.createSpawnPoints();
    const invalidAsteroidIndices: number[] = [];

    for (let asteroidIndex = 0; asteroidIndex < this.asteroids.length; asteroidIndex++) {
      this.asteroids[asteroidIndex].spawnPointIndex = null;
      if (
        !this.isSpawnPointAllowed({
          x: this.asteroids[asteroidIndex].pos.x,
          y: this.asteroids[asteroidIndex].pos.y,
        })
      ) {
        invalidAsteroidIndices.push(asteroidIndex);
      }
    }

    this.rebuildRegistrations();

    for (let i = 0; i < invalidAsteroidIndices.length; i++) {
      this.spawnNewAsteroid(invalidAsteroidIndices[i]);
    }

    this.resolveOverlappingAsteroids();
  }
}

export class Asteroid extends Mover {
  baseRotation: number;
  collisionShapeCache: TransformedCollisionShape | null;
  collisionShapeFrame: number;
  hitPoints: number;
  id: string;
  img: Image;
  p: p5;
  spawnPointIndex: number | null;
  spinSpeed: number;
  variant: number;

  constructor(
    p: p5,
    pos: Vector,
    vel: Vector,
    r: number,
    hitPoints: number,
    spawnPointIndex: number | null,
  ) {
    super(p, pos, vel, r);
    this.p = p;
    this.hitPoints = hitPoints;
    this.variant = Math.floor(p.random(assets.asteroids.length));
    this.img = assets.asteroids[this.variant];
    this.baseRotation = p.random(p.TWO_PI);
    this.collisionShapeCache = null;
    this.collisionShapeFrame = -1;
    this.spinSpeed = p.random(-0.0045, 0.0045);
    this.spawnPointIndex = spawnPointIndex;
    this.id = v4();
  }

  getRotation(frameCount: number = this.p.frameCount) {
    return this.baseRotation + frameCount * this.spinSpeed;
  }

  getCollisionShape(frameCount: number = this.p.frameCount) {
    if (this.collisionShapeCache !== null && this.collisionShapeFrame === frameCount) {
      return this.collisionShapeCache;
    }

    this.collisionShapeCache = transformCollisionShape(
      ASTEROID_COLLISION_SHAPES[this.variant],
      this.pos.x,
      this.pos.y,
      this.getRotation(frameCount),
      this.size,
      this.size,
    );
    this.collisionShapeFrame = frameCount;
    return this.collisionShapeCache;
  }

  draw() {
    this.p.push();
    this.p.imageMode(this.p.CENTER);
    this.p.translate(this.pos.x, this.pos.y);
    this.p.rotate(this.getRotation());
    this.p.image(this.img, 0, 0, this.size, this.size);
    this.p.pop();
  }

  hit() {
    this.hitPoints--;
  }
}
