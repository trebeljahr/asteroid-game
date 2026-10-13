/**
 * Turns elapsed wall time into a whole number of fixed simulation steps.
 *
 * Timers and animation frames fire late and at their own rate: browsers
 * round `setInterval(1000 / 60)` down to 16 ms and Node rounds it up, so a
 * loop that steps once per callback runs at a different speed on every
 * machine. Counting elapsed time instead keeps every loop on the same
 * rate on average, however unevenly it is called.
 */
export class FixedStepClock {
  private accumulatedMs = 0;
  private lastAt: number | null = null;

  constructor(
    private readonly stepMs: number,
    /** Most steps one `advance` call returns. Time beyond that is dropped, not owed. */
    private readonly maxStepsPerAdvance: number,
  ) {}

  /** Forget elapsed time and start counting from `now`. */
  reset(now: number | null = null) {
    this.accumulatedMs = 0;
    this.lastAt = now;
  }

  /** The number of steps that became due since the previous call. */
  advance(now: number) {
    if (this.lastAt === null) {
      this.lastAt = now;
      return 0;
    }

    this.accumulatedMs += Math.max(0, now - this.lastAt);
    this.lastAt = now;

    const steps = Math.floor(this.accumulatedMs / this.stepMs);
    if (steps > this.maxStepsPerAdvance) {
      this.accumulatedMs = 0;
      return this.maxStepsPerAdvance;
    }

    this.accumulatedMs -= steps * this.stepMs;
    return steps;
  }

  /** How far `now` is into the step that has not run yet, from 0 to 1. */
  alphaAt(now: number) {
    if (this.lastAt === null) {
      return 1;
    }
    const pendingMs = this.accumulatedMs + Math.max(0, now - this.lastAt);
    return Math.min(1, pendingMs / this.stepMs);
  }

  /** Milliseconds from `now` until the next step is due. */
  msUntilNextStep(now: number) {
    if (this.lastAt === null) {
      return this.stepMs;
    }
    const pendingMs = this.accumulatedMs + Math.max(0, now - this.lastAt);
    return Math.max(0, this.stepMs - pendingMs);
  }
}
