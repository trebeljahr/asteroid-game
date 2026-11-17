import p5 from "p5";
import { reportAchievementEvent } from "./achievementEvents";
import { playSound } from "./audio";
import { showSingleplayerVictory } from "./gameUiActions";
import { player, playerHitsCollectible } from "./player";
import {
  boardSizeX,
  boardSizeY,
  type CameraBounds,
  circleIntersectsBounds,
  clamp,
  distSquare,
} from "./utils";

type Vector = p5.Vector;

interface GoalLeg {
  distance: number;
  label: string;
}

const GOAL_WORLD_MARGIN = 240;
const GOAL_POSITION_ATTEMPTS = 80;
const GOAL_SCAN_STEPS = 36;
const GOAL_SEPARATION = 260;
const GOAL_RANDOM_FALLBACK_ATTEMPTS = 240;

const createGoalLegs = (): GoalLeg[] => {
  const worldDistance = Math.min(boardSizeX, boardSizeY);
  const worldDiagonal = Math.sqrt(boardSizeX * boardSizeX + boardSizeY * boardSizeY);

  return [
    {
      distance: Math.max(worldDiagonal * 0.32, worldDistance * 0.42),
      label: "Warmup Gate",
    },
    {
      distance: worldDiagonal * 0.5,
      label: "Midfield Gate",
    },
    {
      distance: worldDiagonal * 0.67,
      label: "Deep Space Gate",
    },
    {
      distance: worldDiagonal * 0.46,
      label: "Sprint Gate",
    },
  ];
};

export let goals = {} as Goals;
export const resetGoals = (p: p5) => {
  goals = new Goals(p);
};
export const refreshGoalsAfterResize = () => {
  goals.refreshAfterResize();
};

class Goals {
  currentGoalIndex: number;
  p: p5;
  route: Goal[];

  constructor(p: p5) {
    this.p = p;
    this.currentGoalIndex = 0;
    this.route = this.createRoute();
  }

  get completedGoals() {
    return this.currentGoalIndex;
  }

  get goal() {
    return this.route[this.currentGoalIndex];
  }

  get remainingGoals() {
    return this.route.length - this.currentGoalIndex;
  }

  get totalGoals() {
    return this.route.length;
  }

  createRoute() {
    const route: Goal[] = [];
    let previousHeading: number | null = null;
    let origin = this.p.createVector(
      player.enginePlayer.position.x,
      player.enginePlayer.position.y,
    );

    const legs = createGoalLegs();

    for (let i = 0; i < legs.length; i++) {
      const nextGoal = this.createGoalPosition(origin, legs[i].distance, route, previousHeading);
      previousHeading = nextGoal.heading;
      origin = nextGoal.pos.copy();
      route.push(new Goal(this.p, nextGoal.pos, i + 1, legs.length, legs[i].label));
    }

    return route;
  }

  refreshAfterResize() {
    const refreshedRoute: Goal[] = [];
    let previousHeading: number | null = null;
    let origin = this.p.createVector(
      player.enginePlayer.position.x,
      player.enginePlayer.position.y,
    );

    for (let i = 0; i < this.route.length; i++) {
      const existingGoal = this.route[i];
      const clampedPosition = this.clampGoalPosition(existingGoal.pos);
      let nextGoalPosition = clampedPosition;

      if (!this.isGoalPositionValid(clampedPosition, refreshedRoute)) {
        const fallbackDistance = Math.max(
          GOAL_SEPARATION * 1.15,
          p5.Vector.dist(origin, existingGoal.pos),
        );
        const nextGoal = this.createGoalPosition(
          origin,
          fallbackDistance,
          refreshedRoute,
          previousHeading,
        );
        nextGoalPosition = nextGoal.pos;
      }

      const nextHeading = p5.Vector.sub(nextGoalPosition, origin).heading();
      refreshedRoute.push(
        new Goal(
          this.p,
          nextGoalPosition,
          existingGoal.index,
          existingGoal.totalGoals,
          existingGoal.label,
        ),
      );
      previousHeading = nextHeading;
      origin = nextGoalPosition.copy();
    }

    this.route = refreshedRoute;
    this.currentGoalIndex = clamp(this.currentGoalIndex, 0, this.route.length - 1);
  }

  createGoalPosition(
    origin: Vector,
    distance: number,
    existingRoute: Goal[],
    previousHeading: number | null,
  ) {
    for (let attempt = 0; attempt < GOAL_POSITION_ATTEMPTS; attempt++) {
      const nextHeading = this.sampleHeading(previousHeading, attempt);
      const candidate = p5.Vector.add(origin, p5.Vector.fromAngle(nextHeading, distance));
      if (this.isGoalPositionValid(candidate, existingRoute)) {
        return {
          heading: nextHeading,
          pos: candidate,
        };
      }
    }

    for (let step = 0; step < GOAL_SCAN_STEPS; step++) {
      const nextHeading = (this.p.TWO_PI * step) / GOAL_SCAN_STEPS;
      const candidate = p5.Vector.add(origin, p5.Vector.fromAngle(nextHeading, distance));
      if (this.isGoalPositionValid(candidate, existingRoute)) {
        return {
          heading: nextHeading,
          pos: candidate,
        };
      }
    }

    const centerHeading = p5.Vector.sub(this.p.createVector(0, 0), origin).heading();
    for (let step = 0; step < GOAL_SCAN_STEPS; step++) {
      const offset =
        ((step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * this.p.PI) / GOAL_SCAN_STEPS;
      const nextHeading = centerHeading + offset;
      const candidate = p5.Vector.add(origin, p5.Vector.fromAngle(nextHeading, distance));
      if (this.isGoalPositionValid(candidate, existingRoute)) {
        return {
          heading: nextHeading,
          pos: candidate,
        };
      }
    }

    for (let attempt = 0; attempt < GOAL_RANDOM_FALLBACK_ATTEMPTS; attempt++) {
      const candidate = this.randomBoundedGoalPosition();
      if (this.isGoalPositionValid(candidate, existingRoute)) {
        return {
          heading: p5.Vector.sub(candidate, origin).heading(),
          pos: candidate,
        };
      }
    }

    return {
      heading: centerHeading,
      pos: this.clampGoalPosition(
        this.p.createVector(
          origin.x + this.p.cos(centerHeading) * distance,
          origin.y + this.p.sin(centerHeading) * distance,
        ),
      ),
    };
  }

  clampGoalPosition(candidate: Vector) {
    return this.p.createVector(
      clamp(candidate.x, -boardSizeX + GOAL_WORLD_MARGIN, boardSizeX - GOAL_WORLD_MARGIN),
      clamp(candidate.y, -boardSizeY + GOAL_WORLD_MARGIN, boardSizeY - GOAL_WORLD_MARGIN),
    );
  }

  randomBoundedGoalPosition() {
    return this.p.createVector(
      this.p.random(-boardSizeX + GOAL_WORLD_MARGIN, boardSizeX - GOAL_WORLD_MARGIN),
      this.p.random(-boardSizeY + GOAL_WORLD_MARGIN, boardSizeY - GOAL_WORLD_MARGIN),
    );
  }

  sampleHeading(previousHeading: number | null, attempt: number) {
    if (previousHeading === null) {
      return this.p.random(this.p.TWO_PI);
    }

    const turnWindow = this.p.map(
      attempt,
      0,
      GOAL_POSITION_ATTEMPTS - 1,
      this.p.PI * 0.72,
      this.p.PI,
    );
    return previousHeading + this.p.random(-turnWindow, turnWindow);
  }

  isGoalPositionValid(candidate: Vector, existingRoute: Goal[]) {
    if (
      candidate.x < -boardSizeX + GOAL_WORLD_MARGIN ||
      candidate.x > boardSizeX - GOAL_WORLD_MARGIN ||
      candidate.y < -boardSizeY + GOAL_WORLD_MARGIN ||
      candidate.y > boardSizeY - GOAL_WORLD_MARGIN
    ) {
      return false;
    }

    if (
      distSquare(
        candidate.x,
        candidate.y,
        player.enginePlayer.position.x,
        player.enginePlayer.position.y,
      ) <
      GOAL_SEPARATION * GOAL_SEPARATION
    ) {
      return false;
    }

    for (let i = 0; i < existingRoute.length; i++) {
      const routeGoal = existingRoute[i];
      if (
        distSquare(candidate.x, candidate.y, routeGoal.pos.x, routeGoal.pos.y) <
        GOAL_SEPARATION * GOAL_SEPARATION
      ) {
        return false;
      }
    }

    return true;
  }

  run(cameraBounds?: CameraBounds) {
    const currentGoal = this.goal;
    if (
      cameraBounds === undefined ||
      circleIntersectsBounds(currentGoal.pos.x, currentGoal.pos.y, currentGoal.size, cameraBounds)
    ) {
      currentGoal.draw();
    }

    if (playerHitsCollectible(currentGoal, player)) {
      this.advanceGoal();
    }
  }

  advanceGoal() {
    if (this.currentGoalIndex >= this.route.length - 1) {
      showSingleplayerVictory();
      return;
    }

    this.currentGoalIndex++;
    playSound("goalReached");
    reportAchievementEvent({ type: "run.goalReached" });
  }
}

export class Goal {
  index: number;
  label: string;
  p: p5;
  phase: number;
  pos: Vector;
  size: number;
  totalGoals: number;

  constructor(p: p5, pos: Vector, index: number, totalGoals: number, label: string) {
    this.pos = pos.copy();
    this.size = 120;
    this.p = p;
    this.index = index;
    this.totalGoals = totalGoals;
    this.label = label;
    this.phase = p.random(p.TWO_PI);
  }

  draw() {
    const pulse = (this.p.sin(this.p.frameCount * 0.08 + this.phase) + 1) / 2;
    const spinA = this.phase + this.p.frameCount * 0.014;
    const spinB = -this.phase - this.p.frameCount * 0.02;
    const outerSize = this.size + pulse * 10;
    const glowBlue = [110, 228, 255] as const;

    this.p.push();
    this.p.translate(this.pos.x, this.pos.y);
    this.p.noFill();

    this.p.stroke(glowBlue[0], glowBlue[1], glowBlue[2], 34);
    this.p.strokeWeight(18);
    this.p.circle(0, 0, outerSize + 34);

    this.p.stroke(glowBlue[0], glowBlue[1], glowBlue[2], 210);
    this.p.strokeWeight(6);
    this.p.push();
    this.p.rotate(spinA);
    this.p.arc(0, 0, outerSize + 10, outerSize + 10, 0.2, 1.45);
    this.p.arc(0, 0, outerSize + 10, outerSize + 10, 2.1, 3.28);
    this.p.arc(0, 0, outerSize + 10, outerSize + 10, 4.05, 5.28);
    this.p.pop();

    this.p.stroke(162, 240, 255, 180);
    this.p.strokeWeight(3);
    this.p.push();
    this.p.rotate(spinB);
    this.p.arc(0, 0, this.size * 0.9, this.size * 0.9, 0.42, 1.12);
    this.p.arc(0, 0, this.size * 0.9, this.size * 0.9, 2.52, 3.25);
    this.p.arc(0, 0, this.size * 0.9, this.size * 0.9, 4.56, 5.31);
    this.p.pop();

    this.p.noStroke();
    this.p.fill(glowBlue[0], glowBlue[1], glowBlue[2], 32 + pulse * 30);
    this.p.circle(0, 0, this.size * 0.56 + pulse * 12);

    this.p.stroke(182, 245, 255, 150);
    this.p.strokeWeight(2);
    for (let markerIndex = 0; markerIndex < 6; markerIndex++) {
      const markerAngle = spinA + (this.p.TWO_PI * markerIndex) / 6;
      const markerStart = p5.Vector.fromAngle(markerAngle, this.size * 0.64);
      const markerEnd = p5.Vector.fromAngle(markerAngle, this.size * 0.82);
      this.p.line(markerStart.x, markerStart.y, markerEnd.x, markerEnd.y);
    }

    this.p.noStroke();
    this.p.fill(229, 248, 255);
    this.p.textAlign(this.p.CENTER, this.p.CENTER);
    this.p.textSize(26);
    this.p.text(`${this.index}/${this.totalGoals}`, 0, -4);
    this.p.pop();
  }
}
