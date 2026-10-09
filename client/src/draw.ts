import type p5 from "p5";
import { circleOverlapsCollisionShape, collisionShapesOverlap } from "../../shared/src";
import { reportAchievementEvent } from "./achievementEvents";
import { asteroids, maxAsteroidSize } from "./asteroids";
import { playSound } from "./audio";
import { border } from "./border";
import { bullets } from "./bullets";
import {
  drawCollisionCircle,
  drawCollisionShapeDebug,
  drawShipCollisionBox,
  isDebugToolsEnabled,
} from "./collisionDebug";
import { explosions } from "./explosions";
import { type GameMode, getGameState, shouldAdvanceRunSimulation } from "./gameState";
import { goals } from "./goals";
import { MAX_PLAYER_HEALTH } from "./healthHud";
import { hearts } from "./hearts";
import { isMobileDevice } from "./input";
import { drawMultiplayerMode } from "./multiplayerSession";
import { player, playerHitsCollectible } from "./player";
import { formatRunDuration } from "./runSession";
import { shipDebris } from "./shipDebris";
import { createCameraBounds, getViewScale, height, width } from "./utils";

const modeTitles: Record<GameMode, string> = {
  singleplayer: "Singleplayer Mode",
  multiplayer: "Multiplayer Mode",
  "battle-royale": "Battle Royale",
  horde: "Enemy Hordes Mode",
};

const shieldBlue = {
  fill: [35, 102, 148, 112] as const,
  glow: [102, 225, 255, 225] as const,
  muted: [178, 236, 255, 190] as const,
  stroke: [112, 221, 255, 138] as const,
};

export const draw = (p: p5) => {
  const state = getGameState();
  if (state.scene.type === "mode" && state.scene.mode === "singleplayer") {
    if (!shouldAdvanceRunSimulation(state)) {
      return;
    }

    const cameraBounds = createCameraBounds(
      player.enginePlayer.position.x,
      player.enginePlayer.position.y,
      maxAsteroidSize,
    );

    p.clear();
    p.push();
    p.translate(width / 2, height / 2);
    const viewScale = getViewScale();
    if (viewScale !== 1) {
      p.scale(viewScale);
    }
    p.translate(-player.enginePlayer.position.x, -player.enginePlayer.position.y);
    border.show();
    p.noStroke();
    player.run();
    gameLogic(cameraBounds);
    if (state.settings.collisionDebugEnabled && isDebugToolsEnabled()) {
      drawRunCollisionDebug(p);
    }
    p.pop();
    player.showHealth();
    hearts.drawHudEffects();
    drawGoalProgress(p);
    drawHudHint(p, "Esc: menu", "Singleplayer mode");
    return;
  }

  if (
    state.scene.type === "mode" &&
    (state.scene.mode === "multiplayer" || state.scene.mode === "battle-royale")
  ) {
    drawMultiplayerMode(p);
    return;
  }

  p.clear();
  drawBackdrop(p);

  if (state.scene.type === "mode") {
    drawPlaceholderMode(p, state.scene.mode);
    return;
  }

  if (state.scene.type === "main-menu") {
    p.clear();
    return;
  }

  if (state.scene.type === "result") {
    p.clear();
    return;
  }
};

function gameLogic(cameraBounds: ReturnType<typeof createCameraBounds>) {
  bullets.update(cameraBounds);
  hearts.run(cameraBounds);
  explosions.run(cameraBounds);
  shipDebris.run(cameraBounds);
  asteroids.run(cameraBounds);
  goals.run(cameraBounds);

  const handledAsteroidIds = new Set<string>();

  handlePlayerAsteroidCollisions(handledAsteroidIds);
  handleBulletAsteroidCollisions(handledAsteroidIds);
  handleHeartCollection();
}

function handlePlayerAsteroidCollisions(handledAsteroidIds: Set<string>) {
  const playerCollider = player.getCollider();
  const nearbyAsteroids = asteroids.queryNearby(
    player.enginePlayer.position.x,
    player.enginePlayer.position.y,
    player.getCollisionSearchDiameter() / 2,
  );

  for (let i = 0; i < nearbyAsteroids.length; i++) {
    const asteroidIndex = nearbyAsteroids[i];
    const asteroid = asteroids.asteroids[asteroidIndex];
    if (handledAsteroidIds.has(asteroid.id)) {
      continue;
    }
    if (!collisionShapesOverlap(playerCollider.shape, asteroid.getCollisionShape())) {
      continue;
    }
    if (!player.damage()) {
      break;
    }
    explosions.createExplosion(asteroid.pos);
    playSound("explosion");
    asteroids.removeAsteroid(asteroidIndex);
    handledAsteroidIds.add(asteroid.id);
    break;
  }
}

function drawRunCollisionDebug(p: p5) {
  drawShipCollisionBox(p, player.getCollider());

  for (let i = 0; i < asteroids.asteroids.length; i++) {
    const asteroid = asteroids.asteroids[i];
    drawCollisionShapeDebug(p, asteroid.getCollisionShape());
  }

  for (let i = 0; i < bullets.bullets.length; i++) {
    const bullet = bullets.bullets[i];
    drawCollisionCircle(p, bullet.pos.x, bullet.pos.y, bullet.size);
  }

  for (let i = 0; i < hearts.hearts.length; i++) {
    const heart = hearts.hearts[i];
    drawCollisionCircle(p, heart.pos.x, heart.pos.y, heart.size);
  }

  for (let i = 0; i < goals.route.length; i++) {
    const goal = goals.route[i];
    drawCollisionCircle(p, goal.pos.x, goal.pos.y, goal.size);
  }
}

function handleBulletAsteroidCollisions(handledAsteroidIds: Set<string>) {
  for (let bulletIndex = bullets.bullets.length - 1; bulletIndex >= 0; bulletIndex--) {
    const bullet = bullets.bullets[bulletIndex];
    const nearbyAsteroids = asteroids.queryNearby(bullet.pos.x, bullet.pos.y, bullet.size / 2);

    for (let i = 0; i < nearbyAsteroids.length; i++) {
      const asteroidIndex = nearbyAsteroids[i];
      const asteroid = asteroids.asteroids[asteroidIndex];
      if (handledAsteroidIds.has(asteroid.id)) {
        continue;
      }
      if (
        !circleOverlapsCollisionShape(
          bullet.pos.x,
          bullet.pos.y,
          bullet.size,
          asteroid.getCollisionShape(),
        )
      ) {
        continue;
      }
      asteroid.hit();
      if (asteroid.hitPoints <= 0) {
        asteroids.removeAsteroid(asteroidIndex);
        handledAsteroidIds.add(asteroid.id);
        playSound("explosion");
        reportAchievementEvent({ type: "asteroid.destroyed" });
      } else {
        playSound("bulletHit");
      }
      bullets.bullets.splice(bulletIndex, 1);
      break;
    }
  }
}

function handleHeartCollection() {
  const collectedHeartIndices = new Set<number>();

  for (let i = 0; i < hearts.hearts.length; i++) {
    const heart = hearts.hearts[i];
    if (!playerHitsCollectible(heart, player)) {
      continue;
    }
    if (player.life >= MAX_PLAYER_HEALTH) {
      collectedHeartIndices.add(i);
      continue;
    }
    hearts.createPickupEffect(
      heart.pos,
      Math.min(player.life + collectedHeartIndices.size, MAX_PLAYER_HEALTH - 1),
      player.enginePlayer.position.x,
      player.enginePlayer.position.y,
    );
    player.life = Math.min(player.life + 1, MAX_PLAYER_HEALTH);
    collectedHeartIndices.add(i);
    playSound("heartPickup");
    reportAchievementEvent({ type: "heart.collected" });
  }

  if (collectedHeartIndices.size === 0) {
    return;
  }

  hearts.hearts = hearts.hearts.filter((_heart, index) => {
    return !collectedHeartIndices.has(index);
  });
}

function drawBackdrop(p: p5) {
  p.background(4, 9, 24, 210);
  p.noFill();
  p.stroke(120, 220, 255, 50);
  p.strokeWeight(2);
  p.circle(width * 0.2, height * 0.25, 220);
  p.circle(width * 0.82, height * 0.72, 320);
  p.stroke(255, 185, 90, 45);
  p.circle(width * 0.75, height * 0.18, 140);
}

function drawCenterMessage(p: p5, title: string, subtitle: string) {
  p.fill(255);
  p.noStroke();
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(44);
  p.text(title, width / 2, height / 2 - 40);
  p.fill(220, 232, 240);
  p.textSize(18);
  p.text(subtitle, width / 2, height / 2 + 20, width * 0.6, 140);
}

function drawPlaceholderMode(p: p5, mode: GameMode) {
  drawCenterMessage(
    p,
    modeTitles[mode],
    "This mode is wired into the state machine as a placeholder for now. Press Esc to open the in-game menu and switch back out.",
  );
  drawHudHint(p, "Esc: menu", "Placeholder");
}

function drawGoalProgress(p: p5) {
  const horizontalPadding = Math.max(14, width * 0.025);
  const panelWidth = Math.min(312, Math.max(220, width * 0.34));
  const panelHeight = Math.max(82, Math.min(94, height * 0.14));
  const panelX = width - panelWidth - horizontalPadding;
  const panelY = Math.max(16, height * 0.026);
  const completedGoals = goals.completedGoals;
  const totalGoals = goals.totalGoals;
  const remainingGoals = goals.remainingGoals;
  const timerLabel = formatRunDuration(undefined, 1);

  p.push();
  p.rectMode(p.CORNER);
  p.noStroke();
  p.fill(shieldBlue.fill[0], shieldBlue.fill[1], shieldBlue.fill[2], shieldBlue.fill[3]);
  p.rect(panelX, panelY, panelWidth, panelHeight, 18);
  p.stroke(shieldBlue.stroke[0], shieldBlue.stroke[1], shieldBlue.stroke[2], shieldBlue.stroke[3]);
  p.strokeWeight(1.5);
  p.noFill();
  p.rect(panelX, panelY, panelWidth, panelHeight, 18);

  p.noStroke();
  p.fill(shieldBlue.muted[0], shieldBlue.muted[1], shieldBlue.muted[2], 150);
  p.textAlign(p.LEFT, p.TOP);
  p.textSize(Math.max(10, panelHeight * 0.13));
  p.text("Force-Field Route", panelX + 16, panelY + 12);

  p.fill(shieldBlue.glow[0], shieldBlue.glow[1], shieldBlue.glow[2], 232);
  p.textAlign(p.RIGHT, p.TOP);
  p.textSize(Math.max(16, panelHeight * 0.22));
  p.text(timerLabel, panelX + panelWidth - 16, panelY + 10);

  p.fill(shieldBlue.glow[0], shieldBlue.glow[1], shieldBlue.glow[2], 238);
  p.textAlign(p.LEFT, p.TOP);
  p.textSize(Math.max(14, panelHeight * 0.21));
  p.text(`${completedGoals} cleared • ${remainingGoals} remaining`, panelX + 16, panelY + 36);

  const capsuleGap = 10;
  const capsuleWidth = Math.min(44, (panelWidth - 32 - capsuleGap * (totalGoals - 1)) / totalGoals);
  const capsuleHeight = 10;
  const rowX = panelX + 16;
  const rowY = panelY + 66;

  for (let i = 0; i < totalGoals; i++) {
    const capsuleX = rowX + i * (capsuleWidth + capsuleGap);
    const isCleared = i < completedGoals;
    const isCurrent = i === completedGoals;
    const pulse = (p.sin(p.frameCount * 0.14 + i * 0.4) + 1) / 2;
    const alpha = isCleared ? 240 : isCurrent ? 145 + pulse * 55 : 42;

    p.noStroke();
    p.fill(shieldBlue.glow[0], shieldBlue.glow[1], shieldBlue.glow[2], alpha);
    p.rect(capsuleX, rowY, capsuleWidth, capsuleHeight, 999);

    if (isCurrent) {
      p.fill(209, 248, 255, 210);
      p.circle(capsuleX + capsuleWidth / 2, rowY + capsuleHeight / 2, 7 + pulse * 2);
    }
  }

  p.pop();
}

function drawHudHint(p: p5, actionText: string, modeLabel: string) {
  if (isMobileDevice()) {
    return;
  }

  p.fill(200, 220, 232, 160);
  p.noStroke();
  p.textAlign(p.RIGHT, p.BOTTOM);
  p.textSize(13);
  p.text(modeLabel, width - 24, height - 42);
  p.fill(170, 198, 214, 150);
  p.textSize(12);
  p.text(actionText, width - 24, height - 22);
}
