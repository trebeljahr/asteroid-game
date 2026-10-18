import type p5 from "p5";
import {
  getMuzzleOffset,
  type MatchBulletSnapshot,
  type MatchPlayerSnapshot,
} from "../../shared/src";
import { type CameraBounds, circleIntersectsBounds } from "./utils";

type Rgb = readonly [number, number, number];

export interface ShotPalette {
  core: Rgb;
  glow: Rgb;
}

export type ImpactKind = "asteroid" | "edge" | "fade" | "ship";

/** The local pilot's shots. */
export const FRIENDLY_SHOT_PALETTE: ShotPalette = {
  core: [228, 250, 255],
  glow: [58, 190, 255],
};

/** Every other pilot's shots. */
export const HOSTILE_SHOT_PALETTE: ShotPalette = {
  core: [255, 240, 216],
  glow: [255, 104, 58],
};

const FRAME_MS = 1000 / 60;
const BOLT_TRAIL_LENGTH = 150;
const BOLT_GLOW_WIDTH = 11;
const BOLT_CORE_WIDTH = 3.6;
const BOLT_HALO_RADIUS = 20;
const MUZZLE_FLASH_MS = 130;
const IMPACT_MS = 240;
const MAX_SPARKS = 420;
const SPARK_DRAG = 0.9;
const SPARK_STREAK = 2.4;
const AIM_GUIDE_DASH = [5, 9];

const IMPACT_PROFILES: Record<ImpactKind, { radius: number; sparks: number; speed: number }> = {
  asteroid: { radius: 30, sparks: 10, speed: 7 },
  edge: { radius: 22, sparks: 6, speed: 5 },
  fade: { radius: 14, sparks: 0, speed: 0 },
  ship: { radius: 46, sparks: 18, speed: 9.5 },
};

interface MuzzleFlash {
  angle: number;
  ownerId: string;
  palette: ShotPalette;
  startedAt: number;
  x: number;
  y: number;
}

interface Impact {
  kind: ImpactKind;
  palette: ShotPalette;
  startedAt: number;
  x: number;
  y: number;
}

interface Spark {
  bornAt: number;
  color: Rgb;
  lifeMs: number;
  vx: number;
  vy: number;
  width: number;
  x: number;
  y: number;
}

export interface ReticleState {
  ammo: number;
  /** 1 right after a local shot, easing to 0. */
  bloom: number;
  /** 1 right after a local shot connected with a ship, easing to 0. */
  hitFlash: number;
  /** True when the pointer has not moved or fired for a while. */
  idle: boolean;
  x: number;
  y: number;
}

// The p5 typings do not declare the canvas context the sketch draws on.
const getContext = (p: p5) => {
  return (p as unknown as { drawingContext: CanvasRenderingContext2D }).drawingContext;
};

const colorOf = (color: Rgb, alpha: number) => {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.max(0, Math.min(1, alpha))})`;
};

const randomBetween = (minValue: number, maxValue: number) => {
  return minValue + Math.random() * (maxValue - minValue);
};

/**
 * Client-only visuals for shots in the networked modes: energy bolts with
 * tracer trails, muzzle flashes, impact bursts and the aim guide. Nothing
 * here feeds back into the simulation.
 *
 * Draws on the 2D canvas context directly, because the glow needs
 * gradients and additive blending that the p5 API does not offer.
 */
export class WeaponEffectsSystem {
  p: p5;
  bulletOrigins: Map<string, { x: number; y: number }>;
  impacts: Impact[];
  lastRunAt: number;
  muzzleFlashes: MuzzleFlash[];
  sparks: Spark[];

  constructor(p: p5) {
    this.p = p;
    this.bulletOrigins = new Map();
    this.impacts = [];
    this.lastRunAt = 0;
    this.muzzleFlashes = [];
    this.sparks = [];
  }

  /**
   * Remember where a bullet entered play, so its trail never reaches behind
   * the muzzle. `bullet` is as it left the muzzle.
   */
  trackBullet(bullet: MatchBulletSnapshot) {
    this.bulletOrigins.set(bullet.id, { x: bullet.x, y: bullet.y });
  }

  forgetBullet(bulletId: string) {
    this.bulletOrigins.delete(bulletId);
  }

  forgetAllBullets() {
    this.bulletOrigins.clear();
  }

  /** `x`/`y` are only used while the owner's ship is not on screen to anchor the flash. */
  addMuzzleFlash(ownerId: string, x: number, y: number, angle: number, palette: ShotPalette) {
    this.muzzleFlashes.push({ angle, ownerId, palette, startedAt: performance.now(), x, y });
    this.addSparks(x, y, angle, 0.5, 4, 8, palette);
  }

  addImpact(x: number, y: number, incomingAngle: number, palette: ShotPalette, kind: ImpactKind) {
    const profile = IMPACT_PROFILES[kind];
    this.impacts.push({ kind, palette, startedAt: performance.now(), x, y });
    // Debris sprays back toward where the shot came from.
    this.addSparks(x, y, incomingAngle + Math.PI, 1.25, profile.sparks, profile.speed, palette);
  }

  drawBolts(bullets: MatchBulletSnapshot[], localPlayerId: string, cameraBounds: CameraBounds) {
    const ctx = getContext(this.p);
    const now = performance.now();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = 0; i < bullets.length; i++) {
      const bullet = bullets[i];
      if (!circleIntersectsBounds(bullet.x, bullet.y, BOLT_TRAIL_LENGTH * 2, cameraBounds)) {
        continue;
      }
      this.drawBolt(
        ctx,
        bullet,
        bullet.ownerId === localPlayerId ? FRIENDLY_SHOT_PALETTE : HOSTILE_SHOT_PALETTE,
        now,
      );
    }
    ctx.restore();
  }

  /** A dashed line from the muzzle along the shot's path. */
  drawAimGuide(x: number, y: number, angle: number, length: number, alpha: number) {
    if (length <= 0 || alpha <= 0) {
      return;
    }

    const ctx = getContext(this.p);
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;
    const line = ctx.createLinearGradient(x, y, endX, endY);
    line.addColorStop(0, colorOf(FRIENDLY_SHOT_PALETTE.glow, 0.6 * alpha));
    line.addColorStop(1, colorOf(FRIENDLY_SHOT_PALETTE.glow, 0));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = line;
    ctx.setLineDash(AIM_GUIDE_DASH);
    // The dashes drift outward, which reads as a direction.
    ctx.lineDashOffset = -((performance.now() * 0.04) % (AIM_GUIDE_DASH[0] + AIM_GUIDE_DASH[1]));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    const muzzle = ctx.createRadialGradient(x, y, 0, x, y, 9);
    muzzle.addColorStop(0, colorOf(FRIENDLY_SHOT_PALETTE.core, 0.8 * alpha));
    muzzle.addColorStop(1, colorOf(FRIENDLY_SHOT_PALETTE.glow, 0));
    ctx.fillStyle = muzzle;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Sparks, impact bursts and muzzle flashes. Draw after the ships so they sit on top. */
  run(players: MatchPlayerSnapshot[], cameraBounds: CameraBounds) {
    const ctx = getContext(this.p);
    const now = performance.now();
    const elapsedTicks = this.lastRunAt === 0 ? 1 : Math.min(4, (now - this.lastRunAt) / FRAME_MS);
    this.lastRunAt = now;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    this.runSparks(ctx, now, elapsedTicks, cameraBounds);
    this.runImpacts(ctx, now, cameraBounds);
    this.runMuzzleFlashes(ctx, now, players, cameraBounds);
    ctx.restore();
  }

  private addSparks(
    x: number,
    y: number,
    angle: number,
    spread: number,
    amount: number,
    speed: number,
    palette: ShotPalette,
  ) {
    const now = performance.now();
    for (let i = 0; i < amount; i++) {
      const sparkAngle = angle + randomBetween(-spread, spread);
      const sparkSpeed = speed * randomBetween(0.35, 1);
      this.sparks.push({
        bornAt: now,
        color: Math.random() < 0.4 ? palette.core : palette.glow,
        lifeMs: randomBetween(160, 380),
        vx: Math.cos(sparkAngle) * sparkSpeed,
        vy: Math.sin(sparkAngle) * sparkSpeed,
        width: randomBetween(1.2, 2.6),
        x,
        y,
      });
    }

    if (this.sparks.length > MAX_SPARKS) {
      this.sparks.splice(0, this.sparks.length - MAX_SPARKS);
    }
  }

  private drawBolt(
    ctx: CanvasRenderingContext2D,
    bullet: MatchBulletSnapshot,
    palette: ShotPalette,
    now: number,
  ) {
    const speed = Math.hypot(bullet.vx, bullet.vy);
    if (speed < 0.0001) {
      return;
    }

    const directionX = bullet.vx / speed;
    const directionY = bullet.vy / speed;
    const origin = this.bulletOrigins.get(bullet.id);
    const trail =
      origin === undefined
        ? BOLT_TRAIL_LENGTH
        : Math.min(BOLT_TRAIL_LENGTH, Math.hypot(bullet.x - origin.x, bullet.y - origin.y));
    // Each bolt shimmers on its own phase.
    const flicker = 0.86 + 0.14 * Math.sin(now * 0.05 + bullet.id.length + bullet.x * 0.01);

    if (trail > 1) {
      const tailX = bullet.x - directionX * trail;
      const tailY = bullet.y - directionY * trail;
      const glow = ctx.createLinearGradient(tailX, tailY, bullet.x, bullet.y);
      glow.addColorStop(0, colorOf(palette.glow, 0));
      glow.addColorStop(1, colorOf(palette.glow, 0.6 * flicker));
      ctx.strokeStyle = glow;
      ctx.lineWidth = BOLT_GLOW_WIDTH;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(bullet.x, bullet.y);
      ctx.stroke();

      const coreTailX = bullet.x - directionX * trail * 0.42;
      const coreTailY = bullet.y - directionY * trail * 0.42;
      const core = ctx.createLinearGradient(coreTailX, coreTailY, bullet.x, bullet.y);
      core.addColorStop(0, colorOf(palette.core, 0));
      core.addColorStop(1, colorOf(palette.core, 0.95));
      ctx.strokeStyle = core;
      ctx.lineWidth = BOLT_CORE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(coreTailX, coreTailY);
      ctx.lineTo(bullet.x, bullet.y);
      ctx.stroke();
    }

    const halo = ctx.createRadialGradient(
      bullet.x,
      bullet.y,
      0,
      bullet.x,
      bullet.y,
      BOLT_HALO_RADIUS,
    );
    halo.addColorStop(0, colorOf(palette.core, 0.95));
    halo.addColorStop(0.3, colorOf(palette.glow, 0.6 * flicker));
    halo.addColorStop(1, colorOf(palette.glow, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, BOLT_HALO_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  private runSparks(
    ctx: CanvasRenderingContext2D,
    now: number,
    elapsedTicks: number,
    cameraBounds: CameraBounds,
  ) {
    const drag = SPARK_DRAG ** elapsedTicks;

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const spark = this.sparks[i];
      const age = (now - spark.bornAt) / spark.lifeMs;
      if (age >= 1) {
        this.sparks.splice(i, 1);
        continue;
      }

      spark.x += spark.vx * elapsedTicks;
      spark.y += spark.vy * elapsedTicks;
      spark.vx *= drag;
      spark.vy *= drag;

      if (!circleIntersectsBounds(spark.x, spark.y, 40, cameraBounds)) {
        continue;
      }

      ctx.strokeStyle = colorOf(spark.color, (1 - age) ** 1.5);
      ctx.lineWidth = spark.width * (1 - age * 0.5);
      ctx.beginPath();
      ctx.moveTo(spark.x, spark.y);
      ctx.lineTo(spark.x - spark.vx * SPARK_STREAK, spark.y - spark.vy * SPARK_STREAK);
      ctx.stroke();
    }
  }

  private runImpacts(ctx: CanvasRenderingContext2D, now: number, cameraBounds: CameraBounds) {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const impact = this.impacts[i];
      const progress = (now - impact.startedAt) / IMPACT_MS;
      if (progress >= 1) {
        this.impacts.splice(i, 1);
        continue;
      }

      const radius = IMPACT_PROFILES[impact.kind].radius;
      if (!circleIntersectsBounds(impact.x, impact.y, radius * 2, cameraBounds)) {
        continue;
      }

      const eased = 1 - (1 - progress) ** 3;
      const fade = 1 - progress;

      const flashRadius = radius * (0.45 + 0.4 * eased);
      const flash = ctx.createRadialGradient(
        impact.x,
        impact.y,
        0,
        impact.x,
        impact.y,
        flashRadius,
      );
      flash.addColorStop(0, colorOf(impact.palette.core, 0.95 * fade * fade));
      flash.addColorStop(0.45, colorOf(impact.palette.glow, 0.5 * fade * fade));
      flash.addColorStop(1, colorOf(impact.palette.glow, 0));
      ctx.fillStyle = flash;
      ctx.beginPath();
      ctx.arc(impact.x, impact.y, flashRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = colorOf(impact.palette.glow, 0.85 * fade);
      ctx.lineWidth = 0.6 + 2.8 * fade;
      ctx.beginPath();
      ctx.arc(impact.x, impact.y, 4 + (radius - 4) * eased, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private runMuzzleFlashes(
    ctx: CanvasRenderingContext2D,
    now: number,
    players: MatchPlayerSnapshot[],
    cameraBounds: CameraBounds,
  ) {
    for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
      const flash = this.muzzleFlashes[i];
      const progress = (now - flash.startedAt) / MUZZLE_FLASH_MS;
      if (progress >= 1) {
        this.muzzleFlashes.splice(i, 1);
        continue;
      }

      // Follow the ship, so the flash stays on the hull of a moving shooter.
      let x = flash.x;
      let y = flash.y;
      for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
        const player = players[playerIndex];
        if (player.id !== flash.ownerId) {
          continue;
        }
        const muzzleOffset = getMuzzleOffset(player.angle, flash.angle);
        x = player.x + Math.cos(flash.angle) * muzzleOffset;
        y = player.y + Math.sin(flash.angle) * muzzleOffset;
        break;
      }

      if (!circleIntersectsBounds(x, y, 160, cameraBounds)) {
        continue;
      }

      this.drawMuzzleFlash(ctx, x, y, flash.angle, flash.palette, progress);
    }
  }

  private drawMuzzleFlash(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    palette: ShotPalette,
    progress: number,
  ) {
    const fade = 1 - progress;
    const reach = 1 - (1 - progress) ** 2;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const bloomRadius = 22 + 18 * reach;
    const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, bloomRadius);
    bloom.addColorStop(0, colorOf(palette.core, 0.9 * fade));
    bloom.addColorStop(0.35, colorOf(palette.glow, 0.55 * fade));
    bloom.addColorStop(1, colorOf(palette.glow, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, bloomRadius, 0, Math.PI * 2);
    ctx.fill();

    // One lance along the barrel and two short flares off to the sides.
    this.drawFlare(ctx, 0, 40 + 34 * reach, 7 * fade + 1, palette, fade);
    this.drawFlare(ctx, 1.15, 16 + 14 * reach, 4 * fade + 0.6, palette, fade * 0.8);
    this.drawFlare(ctx, -1.15, 16 + 14 * reach, 4 * fade + 0.6, palette, fade * 0.8);
    ctx.restore();
  }

  private drawFlare(
    ctx: CanvasRenderingContext2D,
    angle: number,
    length: number,
    halfWidth: number,
    palette: ShotPalette,
    alpha: number,
  ) {
    ctx.save();
    ctx.rotate(angle);
    const fill = ctx.createLinearGradient(0, 0, length, 0);
    fill.addColorStop(0, colorOf(palette.core, alpha));
    fill.addColorStop(0.5, colorOf(palette.glow, 0.7 * alpha));
    fill.addColorStop(1, colorOf(palette.glow, 0));
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(length * 0.16, -halfWidth);
    ctx.lineTo(length, 0);
    ctx.lineTo(length * 0.16, halfWidth);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

const RETICLE_READY: Rgb = [150, 226, 255];
const RETICLE_LOW_AMMO: Rgb = [255, 198, 122];
const RETICLE_EMPTY: Rgb = [255, 104, 104];
const RETICLE_HIT: Rgb = [255, 255, 255];
const RETICLE_OUTLINE = "rgba(2, 8, 16, 0.5)";
const RETICLE_LOW_AMMO_THRESHOLD = 3;

/** The aiming crosshair, in screen space. Replaces the mouse cursor during a match. */
export const drawReticle = (p: p5, state: ReticleState) => {
  const ctx = getContext(p);
  const color =
    state.ammo <= 0
      ? RETICLE_EMPTY
      : state.ammo <= RETICLE_LOW_AMMO_THRESHOLD
        ? RETICLE_LOW_AMMO
        : RETICLE_READY;
  const alpha = state.idle ? 0.42 : 0.96;
  const radius = 12 + 7 * state.bloom;
  const gap = 0.34;

  const strokeShape = (width: number, style: string) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.beginPath();
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const start = (quadrant * Math.PI) / 2 + gap;
      const end = ((quadrant + 1) * Math.PI) / 2 - gap;
      ctx.moveTo(Math.cos(start) * radius, Math.sin(start) * radius);
      ctx.arc(0, 0, radius, start, end);

      const tick = (quadrant * Math.PI) / 2;
      ctx.moveTo(Math.cos(tick) * (radius + 3), Math.sin(tick) * (radius + 3));
      ctx.lineTo(Math.cos(tick) * (radius + 9), Math.sin(tick) * (radius + 9));
    }
    ctx.stroke();
  };

  ctx.save();
  ctx.translate(state.x, state.y);
  ctx.lineCap = "round";
  // A dark outline keeps the reticle readable over bright rocks and blasts.
  strokeShape(4.2, RETICLE_OUTLINE);
  strokeShape(1.8, colorOf(color, alpha));

  ctx.fillStyle = colorOf(color, alpha);
  ctx.beginPath();
  ctx.arc(0, 0, 1.9, 0, Math.PI * 2);
  ctx.fill();

  if (state.hitFlash > 0) {
    const inner = radius * 0.5 + 5 * (1 - state.hitFlash);
    const outer = inner + 9;
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = colorOf(RETICLE_HIT, state.hitFlash);
    ctx.beginPath();
    for (let corner = 0; corner < 4; corner++) {
      const diagonal = Math.PI / 4 + (corner * Math.PI) / 2;
      ctx.moveTo(Math.cos(diagonal) * inner, Math.sin(diagonal) * inner);
      ctx.lineTo(Math.cos(diagonal) * outer, Math.sin(diagonal) * outer);
    }
    ctx.stroke();
  }
  ctx.restore();
};
