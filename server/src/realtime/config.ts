/**
 * Timing for match ownership, durable snapshots and handoff. The lease
 * TTL must stay well above the renew interval, and the resume grace
 * must cover a client reconnect through the proxy.
 */
const readMs = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const LEASE_TTL_MS = readMs("MATCH_LEASE_TTL_MS", 5000);
export const LEASE_RENEW_INTERVAL_MS = readMs("MATCH_LEASE_RENEW_MS", 1000);
export const SNAPSHOT_WRITE_INTERVAL_MS = readMs("MATCH_SNAPSHOT_INTERVAL_MS", 500);
export const RECOVERY_SCAN_INTERVAL_MS = 500;
export const RESUME_GRACE_MS = readMs("MATCH_RESUME_GRACE_MS", 10_000);
export const RESUME_COUNTDOWN_MS = 3000;
export const TICKET_TTL_MS = 5000;
export const TICKET_REFRESH_INTERVAL_MS = 1000;
export const MATCHMAKER_INTERVAL_MS = 250;
export const QUEUE_STATUS_INTERVAL_MS = 500;
export const BUS_REQUEST_TIMEOUT_MS = 2000;
export const DRAIN_DELAY_MS = readMs("DRAIN_DELAY_MS", 20_000);
/** Safety margin so an owner stops emitting before its lease can expire. */
export const LEASE_LOCAL_MARGIN_MS = 750;
