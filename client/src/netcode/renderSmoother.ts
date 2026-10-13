export interface Pose {
  angle: number;
  x: number;
  y: number;
}

/** Time for a visual correction to shrink by half. */
const ERROR_HALF_LIFE_MS = 60;
/** A correction larger than this is a real teleport and is shown as one. */
const SNAP_DISTANCE = 260;

const TWO_PI = Math.PI * 2;

/** The same angle, expressed between -PI and PI. */
export const wrapAngle = (angle: number) => {
  const wrapped = (angle + Math.PI) % TWO_PI;
  return (wrapped < 0 ? wrapped + TWO_PI : wrapped) - Math.PI;
};

const copyPose = (pose: Pose): Pose => {
  return { angle: pose.angle, x: pose.x, y: pose.y };
};

export const lerpPose = (from: Pose, to: Pose, mix: number): Pose => {
  return {
    angle: from.angle + wrapAngle(to.angle - from.angle) * mix,
    x: from.x + (to.x - from.x) * mix,
    y: from.y + (to.y - from.y) * mix,
  };
};

/**
 * Turns a ship that the simulation moves in fixed ticks into a ship that
 * moves smoothly on screen.
 *
 * Two things would otherwise be visible. The display does not refresh in
 * step with the simulation, so some frames would show no tick and others
 * two; drawing between the last two ticks removes that. And when the
 * server corrects the predicted ship, it would jump; the smoother keeps
 * the ship where it was drawn and blends the difference out over a few
 * frames. The simulation itself always holds the corrected state.
 */
export class RenderSmoother {
  private current: Pose | null = null;
  private error: Pose = { angle: 0, x: 0, y: 0 };
  private errorAt = 0;
  private previous: Pose | null = null;

  reset() {
    this.current = null;
    this.previous = null;
    this.error = { angle: 0, x: 0, y: 0 };
    this.errorAt = 0;
  }

  /** The simulation stepped one tick forward and now stands at `pose`. */
  advance(pose: Pose) {
    this.previous = this.current ?? copyPose(pose);
    this.current = copyPose(pose);
  }

  /**
   * An authoritative correction replaced the simulated ship. `current` is
   * its new pose and `previous` the pose one tick earlier, or null when
   * the correction did not replay a tick.
   */
  rebase(previous: Pose | null, current: Pose, alpha: number, now: number) {
    const shown = this.poseAt(alpha, now);

    if (previous !== null) {
      this.previous = copyPose(previous);
    } else if (this.previous !== null && this.current !== null) {
      // Keep the last tick's movement and carry it to the corrected spot.
      this.previous = {
        angle: this.previous.angle + (current.angle - this.current.angle),
        x: this.previous.x + (current.x - this.current.x),
        y: this.previous.y + (current.y - this.current.y),
      };
    } else {
      this.previous = copyPose(current);
    }
    this.current = copyPose(current);

    if (shown === null) {
      this.error = { angle: 0, x: 0, y: 0 };
      return;
    }

    const corrected = lerpPose(this.previous, this.current, alpha);
    const errorX = shown.x - corrected.x;
    const errorY = shown.y - corrected.y;
    if (Math.hypot(errorX, errorY) > SNAP_DISTANCE) {
      this.error = { angle: 0, x: 0, y: 0 };
      return;
    }

    this.error = { angle: wrapAngle(shown.angle - corrected.angle), x: errorX, y: errorY };
    this.errorAt = now;
  }

  /**
   * The pose to draw. `alpha` is how far the display is between the
   * previous tick (0) and the current one (1).
   */
  poseAt(alpha: number, now: number): Pose | null {
    if (this.current === null) {
      return null;
    }

    const pose = lerpPose(this.previous ?? this.current, this.current, alpha);
    const remaining = 0.5 ** (Math.max(0, now - this.errorAt) / ERROR_HALF_LIFE_MS);
    return {
      angle: pose.angle + this.error.angle * remaining,
      x: pose.x + this.error.x * remaining,
      y: pose.y + this.error.y * remaining,
    };
  }
}
