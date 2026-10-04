import type { Pool, PoolClient } from "pg";

import type { MatchMode, ShipVariant } from "../../../shared/src";
import { LEASE_TTL_MS, TICKET_TTL_MS } from "./config";

export interface Ticket {
  enqueuedAt: number;
  mode: MatchMode;
  replicaId: string;
  shipVariant: ShipVariant;
  socketId: string;
  userId: string | null;
}

/** Fencing token: a write is valid only while the lease still has this epoch and owner. */
export interface LeaseFence {
  epoch: number;
  matchId: string;
  owner: string;
}

export type LeaseState = "active" | "handoff" | "finished";

export interface LeaseRow {
  epoch: number;
  expiresAt: number;
  matchId: string;
  mode: string;
  owner: string;
  state: LeaseState;
}

export interface StoredSnapshot {
  epoch: number;
  matchId: string;
  sequence: number;
  state: unknown;
  writtenAt: number;
}

/**
 * Shared coordination state for matchmaking and match ownership.
 * Postgres is the durable implementation used whenever more than one
 * replica can run. The memory implementation keeps single-process
 * development working without a database.
 */
export interface CoordinationStore {
  readonly durable: boolean;

  putTicket(ticket: Omit<Ticket, "enqueuedAt">): Promise<void>;
  deleteTicket(socketId: string): Promise<boolean>;
  deleteTicketsForReplica(replicaId: string): Promise<void>;
  refreshTickets(replicaId: string): Promise<void>;
  /** Fresh tickets of one mode in queue order. */
  listTickets(mode: MatchMode): Promise<Ticket[]>;
  /** Atomically remove and return between `min` and `max` fresh tickets, or none. */
  takeTickets(mode: MatchMode, min: number, max: number): Promise<Ticket[]>;

  createLease(matchId: string, mode: MatchMode, owner: string): Promise<LeaseFence>;
  /** Extends the given leases; returns the match IDs that are still held. */
  renewLeases(fences: LeaseFence[]): Promise<Set<string>>;
  getLease(matchId: string): Promise<LeaseRow | null>;
  /**
   * Fenced snapshot write. With `handoff`, the lease moves to `handoff`
   * in the same transaction, which tells other replicas to claim it.
   */
  writeSnapshot(
    fence: LeaseFence,
    sequence: number,
    state: unknown,
    options?: { handoff?: boolean },
  ): Promise<boolean>;
  /** Fenced: marks the lease finished and drops its snapshot. */
  finishLease(fence: LeaseFence): Promise<boolean>;
  listClaimable(limit: number): Promise<LeaseRow[]>;
  claimLease(matchId: string, seenEpoch: number, owner: string): Promise<LeaseFence | null>;
  readSnapshot(matchId: string): Promise<StoredSnapshot | null>;

  /** Acquire or renew a named singleton lease (the battle-royale lobby owner). */
  acquireSingleton(name: string, owner: string): Promise<boolean>;
  releaseSingleton(name: string, owner: string): Promise<void>;

  cleanup(): Promise<void>;
}

const SINGLETON_MODE = "lobby";

interface TicketRow {
  enqueued_at: Date;
  mode: MatchMode;
  replica_id: string;
  ship_variant: ShipVariant;
  socket_id: string;
  user_id: string | null;
}

const toTicket = (row: TicketRow): Ticket => {
  return {
    enqueuedAt: row.enqueued_at.getTime(),
    mode: row.mode,
    replicaId: row.replica_id,
    shipVariant: row.ship_variant,
    socketId: row.socket_id,
    userId: row.user_id,
  };
};

interface LeaseDbRow {
  epoch: string | number;
  expires_at: Date;
  match_id: string;
  mode: string;
  owner_replica: string;
  state: LeaseState;
}

const toLease = (row: LeaseDbRow): LeaseRow => {
  return {
    epoch: Number(row.epoch),
    expiresAt: row.expires_at.getTime(),
    matchId: row.match_id,
    mode: row.mode,
    owner: row.owner_replica,
    state: row.state,
  };
};

const ttlSeconds = (ms: number) => ms / 1000;

export class PostgresCoordinationStore implements CoordinationStore {
  readonly durable = true;

  constructor(private pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async putTicket(ticket: Omit<Ticket, "enqueuedAt">) {
    await this.pool.query(
      `INSERT INTO matchmaking_tickets
         (socket_id, mode, replica_id, user_id, ship_variant, enqueued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(secs => $6))
       ON CONFLICT (socket_id) DO UPDATE SET
         mode = excluded.mode,
         ship_variant = excluded.ship_variant,
         expires_at = excluded.expires_at`,
      [
        ticket.socketId,
        ticket.mode,
        ticket.replicaId,
        ticket.userId,
        ticket.shipVariant,
        ttlSeconds(TICKET_TTL_MS),
      ],
    );
  }

  async deleteTicket(socketId: string) {
    const result = await this.pool.query("DELETE FROM matchmaking_tickets WHERE socket_id = $1", [
      socketId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteTicketsForReplica(replicaId: string) {
    await this.pool.query("DELETE FROM matchmaking_tickets WHERE replica_id = $1", [replicaId]);
  }

  async refreshTickets(replicaId: string) {
    await this.pool.query(
      `UPDATE matchmaking_tickets SET expires_at = now() + make_interval(secs => $2)
       WHERE replica_id = $1`,
      [replicaId, ttlSeconds(TICKET_TTL_MS)],
    );
  }

  async listTickets(mode: MatchMode) {
    const result = await this.pool.query<TicketRow>(
      `SELECT * FROM matchmaking_tickets
       WHERE mode = $1 AND expires_at > now()
       ORDER BY enqueued_at, socket_id`,
      [mode],
    );
    return result.rows.map(toTicket);
  }

  async takeTickets(mode: MatchMode, min: number, max: number) {
    const notEnough = new Error("not-enough-tickets");
    return this.transaction(async (client) => {
      const result = await client.query<TicketRow>(
        `DELETE FROM matchmaking_tickets t
         USING (
           SELECT socket_id FROM matchmaking_tickets
           WHERE mode = $1 AND expires_at > now()
           ORDER BY enqueued_at, socket_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ) picked
         WHERE t.socket_id = picked.socket_id
         RETURNING t.*`,
        [mode, max],
      );
      if (result.rows.length < min) {
        // Not enough players yet: roll back so the tickets stay queued.
        throw notEnough;
      }
      return result.rows.map(toTicket).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    }).catch((error) => {
      if (error === notEnough) return [];
      throw error;
    });
  }

  async createLease(matchId: string, mode: MatchMode, owner: string) {
    await this.pool.query(
      `INSERT INTO match_leases (match_id, mode, owner_replica, epoch, expires_at, state)
       VALUES ($1, $2, $3, 1, now() + make_interval(secs => $4), 'active')`,
      [matchId, mode, owner, ttlSeconds(LEASE_TTL_MS)],
    );
    return { epoch: 1, matchId, owner };
  }

  async renewLeases(fences: LeaseFence[]) {
    if (fences.length === 0) return new Set<string>();
    const result = await this.pool.query<{ match_id: string }>(
      `UPDATE match_leases l
       SET expires_at = now() + make_interval(secs => $4), updated_at = now()
       FROM unnest($1::text[], $2::bigint[]) AS f(match_id, epoch)
       WHERE l.match_id = f.match_id AND l.epoch = f.epoch
         AND l.owner_replica = $3 AND l.state = 'active'
       RETURNING l.match_id`,
      [
        fences.map((fence) => fence.matchId),
        fences.map((fence) => fence.epoch),
        fences[0].owner,
        ttlSeconds(LEASE_TTL_MS),
      ],
    );
    return new Set(result.rows.map((row) => row.match_id));
  }

  async getLease(matchId: string) {
    const result = await this.pool.query<LeaseDbRow>(
      "SELECT * FROM match_leases WHERE match_id = $1",
      [matchId],
    );
    return result.rows.length === 0 ? null : toLease(result.rows[0]);
  }

  async writeSnapshot(
    fence: LeaseFence,
    sequence: number,
    state: unknown,
    options: { handoff?: boolean } = {},
  ) {
    return this.transaction(async (client) => {
      const lease = await client.query(
        `SELECT 1 FROM match_leases
         WHERE match_id = $1 AND epoch = $2 AND owner_replica = $3 AND state = 'active'
         FOR UPDATE`,
        [fence.matchId, fence.epoch, fence.owner],
      );
      if (lease.rows.length === 0) {
        return false;
      }
      await client.query(
        `INSERT INTO match_snapshots (match_id, epoch, sequence, state, written_at)
         VALUES ($1, $2, $3, $4::jsonb, now())
         ON CONFLICT (match_id) DO UPDATE SET
           epoch = excluded.epoch,
           sequence = excluded.sequence,
           state = excluded.state,
           written_at = excluded.written_at
         WHERE match_snapshots.epoch < excluded.epoch
            OR (match_snapshots.epoch = excluded.epoch
                AND match_snapshots.sequence <= excluded.sequence)`,
        [fence.matchId, fence.epoch, sequence, JSON.stringify(state)],
      );
      if (options.handoff) {
        await client.query(
          `UPDATE match_leases SET state = 'handoff', updated_at = now()
           WHERE match_id = $1 AND epoch = $2`,
          [fence.matchId, fence.epoch],
        );
      }
      return true;
    });
  }

  async finishLease(fence: LeaseFence) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE match_leases SET state = 'finished', updated_at = now()
         WHERE match_id = $1 AND epoch = $2 AND owner_replica = $3 AND state <> 'finished'`,
        [fence.matchId, fence.epoch, fence.owner],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      await client.query("DELETE FROM match_snapshots WHERE match_id = $1", [fence.matchId]);
      return true;
    });
  }

  async listClaimable(limit: number) {
    const result = await this.pool.query<LeaseDbRow>(
      `SELECT * FROM match_leases
       WHERE mode <> $1
         AND (state = 'handoff' OR (state = 'active' AND expires_at < now()))
       ORDER BY updated_at
       LIMIT $2`,
      [SINGLETON_MODE, limit],
    );
    return result.rows.map(toLease);
  }

  async claimLease(matchId: string, seenEpoch: number, owner: string) {
    const result = await this.pool.query<{ epoch: string }>(
      `UPDATE match_leases
       SET owner_replica = $3, epoch = epoch + 1, state = 'active',
           expires_at = now() + make_interval(secs => $4), updated_at = now()
       WHERE match_id = $1 AND epoch = $2
         AND (state = 'handoff' OR (state = 'active' AND expires_at < now()))
       RETURNING epoch`,
      [matchId, seenEpoch, owner, ttlSeconds(LEASE_TTL_MS)],
    );
    if (result.rows.length === 0) return null;
    return { epoch: Number(result.rows[0].epoch), matchId, owner };
  }

  async readSnapshot(matchId: string) {
    const result = await this.pool.query<{
      epoch: string;
      match_id: string;
      sequence: string;
      state: unknown;
      written_at: Date;
    }>("SELECT * FROM match_snapshots WHERE match_id = $1", [matchId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      epoch: Number(row.epoch),
      matchId: row.match_id,
      sequence: Number(row.sequence),
      state: row.state,
      writtenAt: row.written_at.getTime(),
    };
  }

  async acquireSingleton(name: string, owner: string) {
    const result = await this.pool.query(
      `INSERT INTO match_leases (match_id, mode, owner_replica, epoch, expires_at, state)
       VALUES ($1, $2, $3, 1, now() + make_interval(secs => $4), 'active')
       ON CONFLICT (match_id) DO UPDATE SET
         owner_replica = excluded.owner_replica,
         epoch = match_leases.epoch
           + CASE WHEN match_leases.owner_replica = excluded.owner_replica
                   AND match_leases.state = 'active' THEN 0 ELSE 1 END,
         expires_at = excluded.expires_at,
         state = 'active',
         updated_at = now()
       WHERE match_leases.owner_replica = excluded.owner_replica
          OR match_leases.state <> 'active'
          OR match_leases.expires_at < now()
       RETURNING owner_replica`,
      [name, SINGLETON_MODE, owner, ttlSeconds(LEASE_TTL_MS)],
    );
    return result.rows.length > 0;
  }

  async releaseSingleton(name: string, owner: string) {
    await this.pool.query(
      `UPDATE match_leases SET state = 'finished', expires_at = now(), updated_at = now()
       WHERE match_id = $1 AND owner_replica = $2`,
      [name, owner],
    );
  }

  async cleanup() {
    await this.pool.query("DELETE FROM matchmaking_tickets WHERE expires_at < now()");
    await this.pool.query(
      `DELETE FROM match_leases
       WHERE state = 'finished' AND mode <> $1 AND updated_at < now() - interval '1 day'`,
      [SINGLETON_MODE],
    );
  }
}

/**
 * Single-process stand-in with the same semantics. Used when Postgres
 * or Redis is unavailable, in which case only one replica may run.
 */
export class MemoryCoordinationStore implements CoordinationStore {
  readonly durable = false;
  private tickets = new Map<string, Ticket & { expiresAt: number }>();
  private leases = new Map<string, LeaseRow>();
  private snapshots = new Map<string, StoredSnapshot>();
  private ticketSequence = 0;

  async putTicket(ticket: Omit<Ticket, "enqueuedAt">) {
    const existing = this.tickets.get(ticket.socketId);
    this.tickets.set(ticket.socketId, {
      ...ticket,
      // Keep a strictly increasing order even within one millisecond.
      enqueuedAt: existing?.enqueuedAt ?? Date.now() + ++this.ticketSequence / 1000,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
  }

  async deleteTicket(socketId: string) {
    return this.tickets.delete(socketId);
  }

  async deleteTicketsForReplica(replicaId: string) {
    for (const [socketId, ticket] of this.tickets) {
      if (ticket.replicaId === replicaId) this.tickets.delete(socketId);
    }
  }

  async refreshTickets(replicaId: string) {
    for (const ticket of this.tickets.values()) {
      if (ticket.replicaId === replicaId) ticket.expiresAt = Date.now() + TICKET_TTL_MS;
    }
  }

  async listTickets(mode: MatchMode) {
    return this.freshTickets(mode);
  }

  private freshTickets(mode: MatchMode): Ticket[] {
    const now = Date.now();
    return Array.from(this.tickets.values())
      .filter((ticket) => ticket.mode === mode && ticket.expiresAt > now)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map(({ expiresAt: _expiresAt, ...ticket }) => ticket);
  }

  async takeTickets(mode: MatchMode, min: number, max: number) {
    // No await between reading and deleting: concurrent takers must not
    // see the same tickets.
    const fresh = this.freshTickets(mode).slice(0, max);
    if (fresh.length < min) return [];
    for (const ticket of fresh) this.tickets.delete(ticket.socketId);
    return fresh;
  }

  async createLease(matchId: string, mode: MatchMode, owner: string) {
    this.leases.set(matchId, {
      epoch: 1,
      expiresAt: Date.now() + LEASE_TTL_MS,
      matchId,
      mode,
      owner,
      state: "active",
    });
    return { epoch: 1, matchId, owner };
  }

  private holds(fence: LeaseFence) {
    const lease = this.leases.get(fence.matchId);
    return (
      lease !== undefined &&
      lease.epoch === fence.epoch &&
      lease.owner === fence.owner &&
      lease.state === "active"
    );
  }

  async renewLeases(fences: LeaseFence[]) {
    const held = new Set<string>();
    for (const fence of fences) {
      const lease = this.leases.get(fence.matchId);
      if (lease !== undefined && this.holds(fence)) {
        lease.expiresAt = Date.now() + LEASE_TTL_MS;
        held.add(fence.matchId);
      }
    }
    return held;
  }

  async getLease(matchId: string) {
    const lease = this.leases.get(matchId);
    return lease === undefined ? null : { ...lease };
  }

  async writeSnapshot(
    fence: LeaseFence,
    sequence: number,
    state: unknown,
    options: { handoff?: boolean } = {},
  ) {
    if (!this.holds(fence)) return false;
    this.snapshots.set(fence.matchId, {
      epoch: fence.epoch,
      matchId: fence.matchId,
      sequence,
      state: JSON.parse(JSON.stringify(state)),
      writtenAt: Date.now(),
    });
    if (options.handoff) {
      const lease = this.leases.get(fence.matchId);
      if (lease !== undefined) lease.state = "handoff";
    }
    return true;
  }

  async finishLease(fence: LeaseFence) {
    const lease = this.leases.get(fence.matchId);
    if (
      lease === undefined ||
      lease.epoch !== fence.epoch ||
      lease.owner !== fence.owner ||
      lease.state === "finished"
    ) {
      return false;
    }
    lease.state = "finished";
    this.snapshots.delete(fence.matchId);
    return true;
  }

  async listClaimable(limit: number) {
    const now = Date.now();
    return Array.from(this.leases.values())
      .filter((lease) => {
        if (lease.mode === SINGLETON_MODE) return false;
        return lease.state === "handoff" || (lease.state === "active" && lease.expiresAt < now);
      })
      .slice(0, limit)
      .map((lease) => ({ ...lease }));
  }

  async claimLease(matchId: string, seenEpoch: number, owner: string) {
    const lease = this.leases.get(matchId);
    if (lease === undefined || lease.epoch !== seenEpoch) return null;
    const claimable =
      lease.state === "handoff" || (lease.state === "active" && lease.expiresAt < Date.now());
    if (!claimable) return null;
    lease.epoch++;
    lease.owner = owner;
    lease.state = "active";
    lease.expiresAt = Date.now() + LEASE_TTL_MS;
    return { epoch: lease.epoch, matchId, owner };
  }

  async readSnapshot(matchId: string) {
    const snapshot = this.snapshots.get(matchId);
    return snapshot === undefined ? null : { ...snapshot };
  }

  async acquireSingleton(name: string, owner: string) {
    const lease = this.leases.get(name);
    const now = Date.now();
    if (
      lease === undefined ||
      lease.owner === owner ||
      lease.state !== "active" ||
      lease.expiresAt < now
    ) {
      this.leases.set(name, {
        epoch: (lease?.epoch ?? 0) + (lease?.owner === owner ? 0 : 1),
        expiresAt: now + LEASE_TTL_MS,
        matchId: name,
        mode: SINGLETON_MODE,
        owner,
        state: "active",
      });
      return true;
    }
    return false;
  }

  async releaseSingleton(name: string, owner: string) {
    const lease = this.leases.get(name);
    if (lease !== undefined && lease.owner === owner) {
      lease.state = "finished";
      lease.expiresAt = Date.now();
    }
  }

  async cleanup() {
    const now = Date.now();
    for (const [socketId, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(socketId);
    }
    for (const [matchId, lease] of this.leases) {
      if (lease.state === "finished" && lease.mode !== SINGLETON_MODE) this.leases.delete(matchId);
    }
  }
}
