import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";

/**
 * Identity of this server process. Unique per process, so a restarted
 * container never inherits the leases of its previous incarnation.
 */
export const REPLICA_ID = `${process.env.REPLICA_ID?.trim() || hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

/** Match IDs are random so two replicas can never create the same room. */
export const newMatchId = (prefix: "match" | "br-match") => `${prefix}-${randomUUID()}`;

/** Stable per-match player identity. Never a socket.id, which changes on reconnect. */
export const newPlayerId = () => `p-${randomBytes(8).toString("hex")}`;

export const newResumeToken = () => randomBytes(24).toString("base64url");

export const hashResumeToken = (token: string) => {
  return createHash("sha256").update(token).digest("hex");
};

export const resumeTokenMatches = (token: string, expectedHash: string) => {
  const actual = Buffer.from(hashResumeToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
