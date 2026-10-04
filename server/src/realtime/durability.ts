import { performance } from "node:perf_hooks";

import type { MatchMode } from "../../../shared/src";
import { achievementService, type MatchResultEntry } from "../achievementService";
import {
  LEASE_LOCAL_MARGIN_MS,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  SNAPSHOT_WRITE_INTERVAL_MS,
} from "./config";
import type { CoordinationStore, LeaseFence } from "./store";

export interface DurableHost {
  drop(matchId: string): void;
  fences(): LeaseFence[];
  snapshotFor(matchId: string): { fence: LeaseFence; sequence: number; state: unknown } | null;
}

/**
 * Lease and snapshot bookkeeping for the matches this replica owns:
 * renews leases, writes fenced periodic snapshots, and drops a match the
 * moment its lease is lost so two replicas never simulate it at once.
 */
export class MatchDurability {
  private hosts: DurableHost[] = [];
  /** Local monotonic deadline until which a lease is known to be held. */
  private validUntil = new Map<string, number>();
  private writesInFlight = new Set<string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private store: CoordinationStore,
    private replicaId: string,
    /** True only with Postgres and Redis: another replica can take over. */
    readonly canHandOff: boolean,
  ) {}

  register(host: DurableHost) {
    this.hosts.push(host);
  }

  start() {
    const renew = setInterval(() => void this.renew(), LEASE_RENEW_INTERVAL_MS);
    renew.unref?.();
    this.timers.push(renew);
    if (this.canHandOff) {
      const snapshots = setInterval(() => this.writeSnapshots(), SNAPSHOT_WRITE_INTERVAL_MS);
      snapshots.unref?.();
      this.timers.push(snapshots);
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  leaseLive(matchId: string) {
    return (this.validUntil.get(matchId) ?? 0) > performance.now();
  }

  async open(matchId: string, mode: MatchMode) {
    const startedAt = performance.now();
    const fence = await this.store.createLease(matchId, mode, this.replicaId);
    this.markHeld(matchId, startedAt);
    return fence;
  }

  /** Record a lease this replica just claimed from another owner. */
  adopt(fence: LeaseFence, claimedAt: number) {
    this.markHeld(fence.matchId, claimedAt);
  }

  async handoff(fence: LeaseFence, sequence: number, state: unknown) {
    try {
      const written = await this.store.writeSnapshot(fence, sequence, state, { handoff: true });
      if (written) this.validUntil.delete(fence.matchId);
      return written;
    } catch (error) {
      console.error(`[handoff] final snapshot for ${fence.matchId} failed`, error);
      return false;
    }
  }

  /**
   * Record a finished match: per-match result receipts and stat
   * increments, fenced on the lease, in one transaction.
   */
  async finish(fence: LeaseFence, results: MatchResultEntry[]) {
    this.validUntil.delete(fence.matchId);
    try {
      const outcome = await achievementService.applyMatchResults(
        fence.matchId,
        this.store.durable ? fence : null,
        results,
      );
      if (outcome === "fenced") {
        console.warn(
          `[durability] result for ${fence.matchId} rejected: epoch ${fence.epoch} is stale`,
        );
        return;
      }
      if (!this.store.durable || outcome === "no-database") {
        await this.store.finishLease(fence);
      }
    } catch (error) {
      console.error(`[durability] recording result for ${fence.matchId} failed`, error);
    }
  }

  private markHeld(matchId: string, since: number) {
    this.validUntil.set(matchId, since + LEASE_TTL_MS - LEASE_LOCAL_MARGIN_MS);
  }

  private async renew() {
    const fences = this.hosts.flatMap((host) => host.fences());
    if (fences.length === 0) return;
    const startedAt = performance.now();
    let held: Set<string>;
    try {
      held = await this.store.renewLeases(fences);
    } catch (error) {
      // Keep simulating until the local deadline passes; then ticks stop.
      console.error("[durability] lease renew failed", error);
      return;
    }
    for (const fence of fences) {
      if (held.has(fence.matchId)) {
        this.markHeld(fence.matchId, startedAt);
        continue;
      }
      console.warn(`[durability] lost lease for ${fence.matchId} (epoch ${fence.epoch})`);
      this.loseMatch(fence.matchId);
    }
  }

  private writeSnapshots() {
    for (const host of this.hosts) {
      for (const fence of host.fences()) {
        if (this.writesInFlight.has(fence.matchId)) continue;
        const snapshot = host.snapshotFor(fence.matchId);
        if (snapshot === null) continue;
        this.writesInFlight.add(fence.matchId);
        void this.store
          .writeSnapshot(snapshot.fence, snapshot.sequence, snapshot.state)
          .then((written) => {
            if (!written) {
              console.warn(
                `[durability] fenced snapshot write rejected for ${fence.matchId} (epoch ${fence.epoch})`,
              );
              this.loseMatch(fence.matchId);
            }
          })
          .catch((error) => {
            console.error(`[durability] snapshot write for ${fence.matchId} failed`, error);
          })
          .finally(() => {
            this.writesInFlight.delete(fence.matchId);
          });
      }
    }
  }

  private loseMatch(matchId: string) {
    this.validUntil.delete(matchId);
    for (const host of this.hosts) host.drop(matchId);
  }
}
