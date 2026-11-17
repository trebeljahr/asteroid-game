import p5 from "p5";
import { asteroids } from "./asteroids";
import { getHudHeartCenter, getHudHeartSize } from "./healthHud";
import { assets } from "./sketch";
import {
  type CameraBounds,
  circleIntersectsBounds,
  circlesOverlap,
  height,
  randomSpawnPoint,
  width,
} from "./utils";

type Vector = p5.Vector;

interface CollectHeartEffect {
  age: number;
  burstOffset: Vector;
  scale: number;
  startScreenPos: Vector;
  targetSlotIndex: number;
  type: "collect";
}

interface LossHeartEffect {
  age: number;
  burstOffset: Vector;
  scale: number;
  startScreenPos: Vector;
  type: "loss";
}

type HeartHudEffect = CollectHeartEffect | LossHeartEffect;

export let hearts = {} as Hearts;
export const maxHeartSize = 200 / 3;
const HEART_ASTEROID_CLEARANCE = 18;
const HEART_PICKUP_BURST_FRAMES = 10;
const HEART_PICKUP_FLIGHT_FRAMES = 24;
const HEART_PICKUP_PARTICLE_COUNT = 4;
const HEART_POP_FRAMES = 18;
const HEART_POP_PARTICLE_COUNT = 5;
const HEART_SPAWN_INTERVAL_FRAMES = 840;
const HEART_SPAWN_POSITION_ATTEMPTS = 160;
const INITIAL_HEART_COUNT = 12;
const MAX_HEARTS = 18;

export const resetHearts = (p: p5) => {
  hearts = new Hearts(p);
};

class Hearts {
  hearts: Heart[];
  hudEffects: HeartHudEffect[];
  p: p5;

  constructor(p: p5) {
    this.p = p;
    this.hearts = [];
    this.hudEffects = [];
    this.spawnHearts(INITIAL_HEART_COUNT);
  }

  findClearSpawnPoint(size: number) {
    let pos = randomSpawnPoint(this.p);

    for (let attempt = 0; attempt < HEART_SPAWN_POSITION_ATTEMPTS; attempt++) {
      const overlappingAsteroids = asteroids.queryNearby(pos.x, pos.y, size / 2);
      let isOverlapping = false;

      for (let i = 0; i < overlappingAsteroids.length; i++) {
        const asteroid = asteroids.asteroids[overlappingAsteroids[i]];
        if (
          circlesOverlap(
            pos.x,
            pos.y,
            size + HEART_ASTEROID_CLEARANCE * 2,
            asteroid.pos.x,
            asteroid.pos.y,
            asteroid.size,
          )
        ) {
          isOverlapping = true;
          break;
        }
      }

      if (!isOverlapping) {
        for (let heartIndex = 0; heartIndex < this.hearts.length; heartIndex++) {
          const heart = this.hearts[heartIndex];
          if (
            circlesOverlap(
              pos.x,
              pos.y,
              size + HEART_ASTEROID_CLEARANCE,
              heart.pos.x,
              heart.pos.y,
              heart.size,
            )
          ) {
            isOverlapping = true;
            break;
          }
        }
      }

      if (!isOverlapping) {
        return pos;
      }

      pos = randomSpawnPoint(this.p);
    }

    return pos;
  }

  spawnHearts(amount: number) {
    for (let i = 0; i < amount; i++) {
      this.hearts.push(new Heart(this.p, this.findClearSpawnPoint(200 / 3), 200));
    }
  }

  createPickupEffect(
    heartPos: Vector,
    targetSlotIndex: number,
    cameraCenterX: number,
    cameraCenterY: number,
  ) {
    const startScreenPos = this.p.createVector(
      width / 2 + (heartPos.x - cameraCenterX),
      height / 2 + (heartPos.y - cameraCenterY),
    );

    for (let i = 0; i < HEART_PICKUP_PARTICLE_COUNT; i++) {
      const angle = (this.p.TWO_PI * i) / HEART_PICKUP_PARTICLE_COUNT + this.p.random(-0.2, 0.2);
      const burstDistance = this.p.random(18, 34);
      this.hudEffects.push({
        age: this.p.random(3),
        burstOffset: p5.Vector.fromAngle(angle, burstDistance),
        scale: this.p.random(0.48, 0.68),
        startScreenPos: startScreenPos.copy(),
        targetSlotIndex,
        type: "collect",
      });
    }
  }

  createLossEffect(slotIndex: number) {
    const startScreenPos = this.p.createVector(
      getHudHeartCenter(slotIndex).x,
      getHudHeartCenter(slotIndex).y,
    );

    for (let i = 0; i < HEART_POP_PARTICLE_COUNT; i++) {
      const angle = (this.p.TWO_PI * i) / HEART_POP_PARTICLE_COUNT + this.p.random(-0.3, 0.3);
      const burstDistance = this.p.random(16, 28);
      this.hudEffects.push({
        age: this.p.random(2),
        burstOffset: p5.Vector.fromAngle(angle, burstDistance),
        scale: this.p.random(0.46, 0.72),
        startScreenPos: startScreenPos.copy(),
        type: "loss",
      });
    }
  }

  drawHudEffects() {
    for (let i = this.hudEffects.length - 1; i >= 0; i--) {
      const effect = this.hudEffects[i];
      if (effect.type === "collect") {
        if (effect.age >= HEART_PICKUP_BURST_FRAMES + HEART_PICKUP_FLIGHT_FRAMES) {
          this.hudEffects.splice(i, 1);
          continue;
        }
        this.drawCollectEffect(effect);
        effect.age++;
        continue;
      }

      if (effect.age >= HEART_POP_FRAMES) {
        this.hudEffects.splice(i, 1);
        continue;
      }
      this.drawLossEffect(effect);
      effect.age++;
    }
  }

  drawCollectEffect(effect: CollectHeartEffect) {
    const targetPos = getHudHeartCenter(effect.targetSlotIndex);
    const burstProgress = Math.min(effect.age / HEART_PICKUP_BURST_FRAMES, 1);
    const easedBurst = 1 - (1 - burstProgress) * (1 - burstProgress);
    const burstPos = p5.Vector.add(
      effect.startScreenPos,
      p5.Vector.mult(effect.burstOffset, easedBurst),
    ).add(0, -8 * easedBurst);

    let drawX = burstPos.x;
    let drawY = burstPos.y;
    let drawSize = getHudHeartSize() * 0.42 * effect.scale;
    let drawAlpha = 235;

    if (effect.age >= HEART_PICKUP_BURST_FRAMES) {
      const flightProgress = (effect.age - HEART_PICKUP_BURST_FRAMES) / HEART_PICKUP_FLIGHT_FRAMES;
      const easedFlight = 1 - (1 - flightProgress) * (1 - flightProgress) * (1 - flightProgress);
      drawX = this.p.lerp(burstPos.x, targetPos.x, easedFlight);
      drawY = this.p.lerp(burstPos.y, targetPos.y, easedFlight);
      drawSize = this.p.lerp(getHudHeartSize() * 0.42 * effect.scale, 18, easedFlight);
      drawAlpha = this.p.lerp(235, 215, easedFlight);
    }

    this.drawHeartEffectSprite(drawX, drawY, drawSize, drawAlpha, true);
  }

  drawLossEffect(effect: LossHeartEffect) {
    const progress = effect.age / HEART_POP_FRAMES;
    const easedProgress = 1 - (1 - progress) * (1 - progress);
    const drawPos = p5.Vector.add(
      effect.startScreenPos,
      p5.Vector.mult(effect.burstOffset, easedProgress),
    ).add(0, -18 * progress);
    const drawSize = this.p.lerp(getHudHeartSize() * 0.54 * effect.scale, 10, progress);
    const drawAlpha = this.p.lerp(220, 0, progress);

    this.drawHeartEffectSprite(drawPos.x, drawPos.y, drawSize, drawAlpha, false);
  }

  drawHeartEffectSprite(
    drawX: number,
    drawY: number,
    drawSize: number,
    drawAlpha: number,
    isHealing: boolean,
  ) {
    this.p.push();
    this.p.noStroke();
    this.p.fill(isHealing ? 255 : 245, isHealing ? 182 : 120, isHealing ? 206 : 130, 34);
    this.p.circle(drawX, drawY, drawSize * 1.7);
    this.p.imageMode(this.p.CENTER);
    if (isHealing) {
      this.p.tint(255, 196, 214, drawAlpha);
    } else {
      this.p.tint(255, 150, 160, drawAlpha);
    }
    this.p.image(assets.heart, drawX, drawY, drawSize, drawSize);
    this.p.noTint();
    this.p.pop();
  }

  run(cameraBounds?: CameraBounds) {
    if (this.p.frameCount % HEART_SPAWN_INTERVAL_FRAMES === 0 && this.hearts.length < MAX_HEARTS) {
      this.spawnHearts(1);
    }
    for (let i = this.hearts.length - 1; i >= 0; i--) {
      const heart = this.hearts[i];
      if (
        cameraBounds !== undefined &&
        !circleIntersectsBounds(heart.pos.x, heart.pos.y, heart.size, cameraBounds)
      ) {
        continue;
      }
      heart.draw();
    }
  }
}

class Heart {
  p: p5;
  pos: Vector;
  size: number;

  constructor(p: p5, pos: Vector, size: number) {
    this.pos = pos.copy();
    this.size = size / 3;
    this.p = p;
  }

  draw() {
    this.p.rectMode(this.p.CENTER);
    this.p.fill(255);
    this.p.imageMode(this.p.CENTER);
    this.p.ellipse(this.pos.x, this.pos.y, this.size, this.size);
    this.p.image(assets.heart, this.pos.x, this.pos.y, this.size / 1.5, this.size / 1.5);
  }
}
