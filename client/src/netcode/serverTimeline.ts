import { TICK_INTERVAL_MS } from "../../../shared/src";

/** Arrival samples kept to find the fastest recent delivery. */
const ARRIVAL_WINDOW = 40;
/** Snapshots held for interpolation. */
const SNAPSHOT_BUFFER = 24;
/** Lateness above this is a stall, not jitter, and does not widen the delay. */
const JITTER_SAMPLE_CAP_MS = 100;
/** Most extra delay added to ride out jitter. */
const MAX_JITTER_DELAY_MS = 4 * TICK_INTERVAL_MS;
/** How fast the timeline may run ahead of or behind real time to re-align. */
const MAX_CLOCK_SLEW = 0.1;
/** A gap this large is closed at once instead of slewed. */
const CLOCK_SNAP_MS = 250;
/** Ticks an entity may be projected past the newest snapshot before it holds still. */
export const MAX_EXTRAPOLATION_TICKS = 8;

interface TimelineEntry<S> {
  snapshot: S;
  tick: number;
}

export interface TimelineView<S> {
  /** Ticks to project `from` forward when no later snapshot exists. Zero otherwise. */
  ahead: number;
  /** The newest snapshot at or before the drawn tick. */
  from: S;
  /** Position between `from` (0) and `to` (1). */
  mix: number;
  /** The snapshot after `from`, or null when the drawn tick is past the newest one. */
  to: S | null;
}

/**
 * Decides which moment of the server's simulation to draw.
 *
 * Snapshots carry the server tick they describe, but they arrive
 * unevenly. Drawing each one when it arrives, or projecting forward from
 * its arrival time, turns every late or early packet into a jump on
 * screen. The timeline instead estimates a steady server clock from the
 * fastest recent arrivals and draws a moment slightly behind it: far
 * enough that two snapshots usually surround that moment, so remote ships
 * move between positions the server really reported.
 */
export class ServerTimeline<S> {
  private arrivalOffsets: number[] = [];
  private entries: TimelineEntry<S>[] = [];
  private latenessDeviationMs = 0;
  private latenessMeanMs = 0;
  /** Local time minus server time for the newest data. Null before the first snapshot. */
  private liveOffsetMs: number | null = null;
  /** Local time minus server time for the moment being drawn. */
  private renderOffsetMs = 0;
  private spacingTicks = 2;
  private syncedAt = 0;

  reset() {
    this.arrivalOffsets = [];
    this.entries = [];
    this.latenessDeviationMs = 0;
    this.latenessMeanMs = 0;
    this.liveOffsetMs = null;
    this.renderOffsetMs = 0;
    this.spacingTicks = 2;
    this.syncedAt = 0;
  }

  /** The snapshot describing server `tick` arrived at local time `now`. */
  observe(tick: number, snapshot: S, now: number) {
    const newest = this.entries[this.entries.length - 1];
    if (newest !== undefined && tick <= newest.tick) {
      return;
    }
    if (newest !== undefined) {
      const spacing = Math.max(1, Math.min(4, tick - newest.tick));
      // Follow a slower snapshot rate at once and a faster one gradually.
      this.spacingTicks = Math.max(spacing, this.spacingTicks - 0.05);
    }

    this.entries.push({ snapshot, tick });
    if (this.entries.length > SNAPSHOT_BUFFER) {
      this.entries.shift();
    }

    const offset = now - tick * TICK_INTERVAL_MS;
    this.arrivalOffsets.push(offset);
    if (this.arrivalOffsets.length > ARRIVAL_WINDOW) {
      this.arrivalOffsets.shift();
    }

    const lateness = Math.min(JITTER_SAMPLE_CAP_MS, offset - this.fastestOffset());
    this.latenessDeviationMs +=
      (Math.abs(lateness - this.latenessMeanMs) - this.latenessDeviationMs) * 0.1;
    this.latenessMeanMs += (lateness - this.latenessMeanMs) * 0.1;

    if (this.liveOffsetMs === null) {
      this.liveOffsetMs = offset;
      this.renderOffsetMs = offset + this.targetDelayMs();
      this.syncedAt = now;
    }
  }

  /**
   * The server tick the newest data stands for right now, without the
   * interpolation delay. Use it for things that move in a straight line
   * and can be projected exactly, such as bullets.
   */
  liveTick(now: number) {
    this.sync(now);
    if (this.liveOffsetMs === null) {
      return this.newestTick();
    }
    return (now - this.liveOffsetMs) / TICK_INTERVAL_MS;
  }

  /** The server tick drawn at local time `now`. */
  renderTick(now: number) {
    this.sync(now);
    if (this.liveOffsetMs === null) {
      return this.newestTick();
    }
    return (now - this.renderOffsetMs) / TICK_INTERVAL_MS;
  }

  /** How far behind the newest data remote ships are drawn, in milliseconds. */
  get interpolationDelayMs() {
    return this.liveOffsetMs === null ? 0 : this.renderOffsetMs - this.liveOffsetMs;
  }

  newestTick() {
    return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1].tick;
  }

  /** The snapshots around the drawn moment, or null before the first snapshot. */
  view(now: number): TimelineView<S> | null {
    if (this.entries.length === 0) {
      return null;
    }

    const tick = this.renderTick(now);
    let fromIndex = 0;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (this.entries[index].tick <= tick) {
        fromIndex = index;
        break;
      }
    }

    const from = this.entries[fromIndex];
    const to = this.entries[fromIndex + 1];
    if (to === undefined) {
      return {
        ahead: Math.max(0, Math.min(MAX_EXTRAPOLATION_TICKS, tick - from.tick)),
        from: from.snapshot,
        mix: 0,
        to: null,
      };
    }

    return {
      ahead: 0,
      from: from.snapshot,
      mix: Math.max(0, Math.min(1, (tick - from.tick) / (to.tick - from.tick))),
      to: to.snapshot,
    };
  }

  private fastestOffset() {
    let fastest = this.arrivalOffsets[0];
    for (let index = 1; index < this.arrivalOffsets.length; index++) {
      fastest = Math.min(fastest, this.arrivalOffsets[index]);
    }
    return fastest;
  }

  private targetDelayMs() {
    const jitterDelay = Math.min(
      MAX_JITTER_DELAY_MS,
      this.latenessMeanMs + 2 * this.latenessDeviationMs,
    );
    return this.spacingTicks * TICK_INTERVAL_MS + jitterDelay;
  }

  /** Move both clocks toward their targets, slowly enough that nothing on screen jumps. */
  private sync(now: number) {
    if (this.liveOffsetMs === null || now <= this.syncedAt) {
      return;
    }

    const maxChange = (now - this.syncedAt) * MAX_CLOCK_SLEW;
    this.syncedAt = now;

    const approach = (value: number, target: number) => {
      const gap = target - value;
      return Math.abs(gap) > CLOCK_SNAP_MS
        ? target
        : value + Math.max(-maxChange, Math.min(maxChange, gap));
    };
    const fastest = this.fastestOffset();
    this.liveOffsetMs = approach(this.liveOffsetMs, fastest);
    this.renderOffsetMs = approach(this.renderOffsetMs, fastest + this.targetDelayMs());
  }
}
