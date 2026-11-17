import { Bodies, Body, Vector, World } from "matter-js";
import p5 from "p5";
import {
  getShipCollider,
  getShipColliderSpec,
  getShipCollisionBoundingDiameter,
  type ShipCollider,
  type ShipVariant,
} from "../../shared/src";
import { reportAchievementEvent } from "./achievementEvents";
import { playSound } from "./audio";
import { bullets } from "./bullets";
import { engine } from "./engine";
import { explosions } from "./explosions";
import { getGameState } from "./gameState";
import { showSingleplayerDefeat } from "./gameUiActions";
import { goals } from "./goals";
import { getHudHeartSize, getHudHeartTopLeft, MAX_PLAYER_HEALTH } from "./healthHud";
import { hearts } from "./hearts";
import { isShipActionActive } from "./input";
import { markRunDamageTaken } from "./runSession";
import { shipDebris } from "./shipDebris";
import { assets } from "./sketch";
import { ThrusterExhaustSystem } from "./thruster";
import {
  boardSizeX,
  boardSizeY,
  clamp,
  height,
  playerHitsCircularTarget,
  REFERENCE_VIEWPORT_HEIGHT,
  REFERENCE_VIEWPORT_WIDTH,
  width,
} from "./utils";

export let player = {} as Player;
export const maxSpeed = 10;
const PLAYER_DAMAGE_RECOVERY_FRAMES = 24;

export const resetPlayer = (p: p5) => {
  if (player?.enginePlayer) {
    World.remove(engine.world, player.enginePlayer);
  }
  player = new Player(p, p.random(REFERENCE_VIEWPORT_WIDTH), p.random(REFERENCE_VIEWPORT_HEIGHT));
};

export const clampPlayerToWorldBounds = () => {
  if (!player?.enginePlayer) {
    return;
  }

  const clampedX = clamp(player.enginePlayer.position.x, -boardSizeX, boardSizeX);
  const clampedY = clamp(player.enginePlayer.position.y, -boardSizeY, boardSizeY);
  const nextVelocity = Vector.create(
    player.enginePlayer.velocity.x,
    player.enginePlayer.velocity.y,
  );

  if (clampedX !== player.enginePlayer.position.x) {
    nextVelocity.x = 0;
  }
  if (clampedY !== player.enginePlayer.position.y) {
    nextVelocity.y = 0;
  }

  Body.setVelocity(player.enginePlayer, nextVelocity);
  Body.setPosition(player.enginePlayer, Vector.create(clampedX, clampedY));
};

const stopVerticalMotion = (body: Body, yPos: number) => {
  Body.setVelocity(body, Vector.create(body.velocity.x, 0));
  Body.setPosition(body, Vector.create(body.position.x, yPos));
};

const stopHorizontalMotion = (body: Body, xPos: number) => {
  Body.setVelocity(body, Vector.create(0, body.velocity.y));
  Body.setPosition(body, Vector.create(xPos, body.position.y));
};

const drawHeartOutline = (p: p5, x: number, y: number, size: number) => {
  p.push();
  p.translate(x, y);
  p.scale(size / 100);
  p.noFill();
  p.stroke(138, 149, 163, 220);
  p.strokeWeight(7);
  p.beginShape();
  p.vertex(50, 88);
  p.bezierVertex(14, 60);
  p.bezierVertex(8, 22);
  p.bezierVertex(30, 22);
  p.bezierVertex(43, 22);
  p.bezierVertex(50, 34);
  p.bezierVertex(50, 34);
  p.bezierVertex(50, 34);
  p.bezierVertex(57, 22);
  p.bezierVertex(70, 22);
  p.bezierVertex(92, 22);
  p.bezierVertex(86, 60);
  p.bezierVertex(50, 88);
  p.endShape();
  p.pop();
};

export class Player {
  p: p5;
  size: number;
  shipVariant: ShipVariant;
  life: number;
  ammunition: number;
  collisionRecoveryFrames: number;
  thruster: ThrusterExhaustSystem;
  deathCountDown: number;
  enginePlayer: Body;
  constructor(p: p5, x: number, y: number) {
    this.p = p;
    this.deathCountDown = 0;
    this.collisionRecoveryFrames = 0;
    const gameState = getGameState();
    this.shipVariant = gameState.settings.shipVariant;
    const colliderSpec = getShipColliderSpec(this.shipVariant);
    this.size = colliderSpec.renderWidth;
    this.life = MAX_PLAYER_HEALTH;
    this.ammunition = 1000;
    this.thruster = new ThrusterExhaustSystem(p, this.p.createVector(width / 2, height), 0);
    this.enginePlayer = Bodies.rectangle(x, y, colliderSpec.length, colliderSpec.width, {
      frictionAir: 0,
      angle: 0,
    });
    World.add(engine.world, [this.enginePlayer]);
  }

  getCollider(): ShipCollider {
    return getShipCollider(
      this.enginePlayer.position.x,
      this.enginePlayer.position.y,
      this.enginePlayer.angle,
      this.shipVariant,
    );
  }

  getCollisionSearchDiameter() {
    return getShipCollisionBoundingDiameter(this.shipVariant);
  }

  draw() {
    const {
      position: { x, y },
      angle,
    } = this.enginePlayer;

    const playerPos = this.p.createVector(x, y);
    const spec = getShipColliderSpec(this.shipVariant);

    this.thruster.updatePos(
      p5.Vector.add(playerPos, p5.Vector.fromAngle(angle - this.p.PI, spec.renderHeight / 2)),
      angle - this.p.PI,
    );

    if (isShipActionActive("thrust")) {
      this.thruster.fire(10);
    }
    this.thruster.run();
    this.p.push();
    this.p.translate(x, y);
    this.p.angleMode(this.p.RADIANS);
    this.p.rectMode(this.p.CENTER);
    this.p.rotate(angle);
    this.p.fill(255);
    this.p.imageMode(this.p.CENTER);
    this.p.rotate(this.p.PI / 2);
    if (this.collisionRecoveryFrames > 0) {
      const blinkAlpha = Math.floor(this.collisionRecoveryFrames / 3) % 2 === 0 ? 170 : 105;
      this.p.tint(255, blinkAlpha);
    }
    this.p.image(assets.runShip, 0, 0, spec.renderWidth, spec.renderHeight);
    this.p.noTint();
    this.p.noFill();

    this.p.pop();
    this.p.stroke(255);

    this.drawGoalIndicator(playerPos);
  }

  drawGoalIndicator(playerPos: p5.Vector) {
    const goal = goals.goal;
    if (!goal) {
      return;
    }

    const spec = getShipColliderSpec(this.shipVariant);
    const renderRadius = Math.max(spec.renderWidth, spec.renderHeight) / 2;

    const angleToGoal = p5.Vector.sub(goal.pos, playerPos).heading();
    const pulse = (this.p.sin(this.p.frameCount * 0.12) + 1) * 4;
    const tailStart = renderRadius * 1.45;
    const tailEnd = renderRadius * 2.35 + pulse;
    const arrowBase = renderRadius * 1.95 + pulse;
    const arrowTip = renderRadius * 2.78 + pulse;

    this.p.push();
    this.p.translate(playerPos.x, playerPos.y);
    this.p.rotate(angleToGoal);
    this.p.stroke(255, 225, 110);
    this.p.strokeWeight(4);
    this.p.line(tailStart, 0, tailEnd, 0);
    this.p.noStroke();
    this.p.fill(255, 225, 110, 220);
    this.p.triangle(arrowTip, 0, arrowBase, -renderRadius * 0.22, arrowBase, renderRadius * 0.22);
    this.p.noFill();
    this.p.stroke(255, 225, 110, 120);
    this.p.strokeWeight(2);
    this.p.circle(tailStart - renderRadius * 0.15, 0, renderRadius * 0.45);
    this.p.pop();
  }

  damage() {
    if (this.life <= 0 || this.collisionRecoveryFrames > 0) {
      return false;
    }

    hearts.createLossEffect(this.life - 1);
    this.life--;
    this.collisionRecoveryFrames = PLAYER_DAMAGE_RECOVERY_FRAMES;
    markRunDamageTaken();
    if (this.life <= 0) {
      explosions.createExplosion(
        this.p.createVector(this.enginePlayer.position.x, this.enginePlayer.position.y),
      );
      shipDebris.createShipBreakup(
        this.enginePlayer.position.x,
        this.enginePlayer.position.y,
        this.enginePlayer.angle,
        this.shipVariant,
      );
      this.deathCountDown = 255;
      playSound("playerDeath");
    } else {
      playSound("playerHit");
    }
    return true;
  }

  showHealth() {
    const heartSize = getHudHeartSize();
    for (let i = 0; i < MAX_PLAYER_HEALTH; i++) {
      const heartPos = getHudHeartTopLeft(i);
      if (i < this.life) {
        this.p.image(assets.heart, heartPos.x, heartPos.y, heartSize, heartSize);
        continue;
      }
      drawHeartOutline(this.p, heartPos.x, heartPos.y, heartSize);
    }
  }

  steer() {
    if (isShipActionActive("turnLeft")) {
      Body.rotate(this.enginePlayer, -0.05);
    }

    if (isShipActionActive("turnRight")) {
      Body.rotate(this.enginePlayer, 0.05);
    }
  }

  update() {
    const {
      position: { x, y },
      velocity,
      angle,
    } = this.enginePlayer;
    if (this.collisionRecoveryFrames > 0) {
      this.collisionRecoveryFrames--;
    }
    if (x >= boardSizeX) {
      stopHorizontalMotion(this.enginePlayer, boardSizeX);
    }
    if (x <= -boardSizeX) {
      stopHorizontalMotion(this.enginePlayer, -boardSizeX);
    }
    if (y >= boardSizeY) {
      stopVerticalMotion(this.enginePlayer, boardSizeY);
    }
    if (y <= -boardSizeY) {
      stopVerticalMotion(this.enginePlayer, -boardSizeY);
    }
    if (isShipActionActive("thrust")) {
      Body.applyForce(
        this.enginePlayer,
        this.enginePlayer.position,
        Vector.rotate(Vector.create(0.01, 0), angle),
      );
    }
    if (velocity.x > maxSpeed) {
      Body.setVelocity(this.enginePlayer, {
        x: maxSpeed,
        y: velocity.y,
      });
    }
    if (velocity.y > maxSpeed) {
      Body.setVelocity(this.enginePlayer, {
        x: velocity.x,
        y: maxSpeed,
      });
    }
    if (velocity.x < -maxSpeed) {
      Body.setVelocity(this.enginePlayer, {
        x: -maxSpeed,
        y: velocity.y,
      });
    }
    if (velocity.y < -maxSpeed) {
      Body.setVelocity(this.enginePlayer, {
        x: velocity.x,
        y: -maxSpeed,
      });
    }
  }

  shoot() {
    if (isShipActionActive("fire") && this.ammunition > 0) {
      const spec = getShipColliderSpec(this.shipVariant);
      let fired = 0;
      for (let i = 0; i < 2; i++) {
        const newPos = this.p
          .createVector(this.enginePlayer.position.x, this.enginePlayer.position.y)
          .add(p5.Vector.fromAngle(this.enginePlayer.angle, spec.renderHeight / 2));
        this.ammunition--;
        bullets.addBullet(newPos, this.enginePlayer.angle);
        fired++;
      }
      playSound("shoot");
      if (fired > 0) {
        reportAchievementEvent({ type: "bullet.fired", count: fired });
      }
    }
  }

  run() {
    if (this.life <= 0) {
      if (this.deathCountDown < 0) {
        showSingleplayerDefeat();
      }
      this.deathCountDown -= 15;
      return;
    }
    this.draw();
    this.update();
    this.steer();
    this.shoot();
  }
}

export const playerHitsCollectible = (
  ammo: { pos: { x: number; y: number }; size: number },
  player: Player,
) => {
  return playerHitsCircularTarget(ammo, player);
};
