import { type MatchBulletSnapshot, projectBulletSnapshot } from "../../../shared/src";

interface TrackedBullet {
  /** The bullet's position at server tick `tick`. */
  bullet: MatchBulletSnapshot;
  tick: number;
}

/**
 * The bullets in flight, rebuilt from the server's bullet-spawned and
 * bullet-removed world events. Snapshots do not carry bullets: a bullet
 * flies in a straight line at a fixed speed, so its position at any tick
 * follows from where it was at one known tick.
 */
export class BulletTracker {
  private bullets = new Map<string, TrackedBullet>();

  get size() {
    return this.bullets.size;
  }

  reset() {
    this.bullets.clear();
  }

  /** Replace every bullet with `bullets`, which are at server tick `tick`. */
  load(bullets: MatchBulletSnapshot[], tick: number) {
    this.bullets.clear();
    for (let index = 0; index < bullets.length; index++) {
      const bullet = bullets[index];
      this.bullets.set(bullet.id, { bullet: { ...bullet }, tick });
    }
  }

  /**
   * A bullet fired on server tick `tick`, as it left the muzzle. The
   * server moves it one step on that same tick, so the muzzle position is
   * where it was at the tick before.
   */
  spawn(bullet: MatchBulletSnapshot, tick: number) {
    this.bullets.set(bullet.id, { bullet: { ...bullet }, tick: tick - 1 });
  }

  /**
   * Forget a bullet the server removed on tick `tick`. Returns where it was
   * on that tick, which is where it hit, or null for an unknown bullet.
   */
  remove(bulletId: string, tick: number): MatchBulletSnapshot | null {
    const tracked = this.bullets.get(bulletId);
    if (tracked === undefined) {
      return null;
    }
    this.bullets.delete(bulletId);
    return projectBulletSnapshot(tracked.bullet, tick - tracked.tick);
  }

  /**
   * The server only moves bullets while the match is active. During a
   * countdown they stay where they are while its ticks go on.
   */
  hold(tick: number) {
    for (const tracked of this.bullets.values()) {
      tracked.tick = tick;
    }
  }

  /** Every bullet at server tick `tick`, which may be fractional. */
  sample(tick: number): MatchBulletSnapshot[] {
    const bullets: MatchBulletSnapshot[] = [];
    for (const tracked of this.bullets.values()) {
      bullets.push(projectBulletSnapshot(tracked.bullet, tick - tracked.tick));
    }
    return bullets;
  }
}
