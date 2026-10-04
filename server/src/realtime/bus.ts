import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

import type { MatchMode, MatchResumeResult, ShipInputState } from "../../../shared/src";
import { BUS_REQUEST_TIMEOUT_MS } from "./config";

/** Where a client socket's match commands must go. Kept by the replica that holds the socket. */
export interface SocketRoute {
  matchId: string;
  mode: MatchMode;
  owner: string;
}

export type BusMessage =
  | { type: "input"; matchId: string; mode: MatchMode; socketId: string; input: ShipInputState }
  | { type: "detach"; matchId: string; mode: MatchMode; socketId: string; explicit: boolean }
  | { type: "bind"; route: SocketRoute; socketId: string }
  | { type: "unbind"; matchId: string; socketId: string }
  | {
      type: "resume";
      matchId: string;
      mode: MatchMode;
      replicaId: string;
      requestId: string;
      replyTo: string;
      resumeToken: string;
      socketId: string;
    }
  | { type: "resume-reply"; requestId: string; result: MatchResumeResult };

type Handler = (message: BusMessage) => void;

const channelFor = (replicaId: string) => `asteroid:replica:${replicaId}`;

/**
 * Point-to-point messages between replicas. Client input and resume
 * requests arrive on whichever replica holds the socket; the bus
 * forwards them to the replica that owns the match. Redis pub/sub is
 * fanout only: it never holds authoritative state.
 */
export class ReplicaBus {
  private handler: Handler | null = null;
  private pending = new Map<string, (result: MatchResumeResult) => void>();
  private warnedLocalOnly = false;

  constructor(
    readonly replicaId: string,
    private publisher: Redis | null,
    private subscriber: Redis | null,
  ) {}

  get crossReplica() {
    return this.publisher !== null && this.subscriber !== null;
  }

  async start(handler: Handler) {
    this.handler = handler;
    if (this.subscriber === null) return;
    this.subscriber.on("message", (_channel: string, raw: string) => {
      let message: BusMessage;
      try {
        message = JSON.parse(raw) as BusMessage;
      } catch {
        return;
      }
      this.dispatch(message);
    });
    await this.subscriber.subscribe(channelFor(this.replicaId));
  }

  publish(replicaId: string, message: BusMessage) {
    if (replicaId === this.replicaId) {
      queueMicrotask(() => this.dispatch(message));
      return;
    }
    if (this.publisher === null) {
      if (!this.warnedLocalOnly) {
        this.warnedLocalOnly = true;
        console.warn("[bus] No Redis: dropping message for another replica", replicaId);
      }
      return;
    }
    void this.publisher.publish(channelFor(replicaId), JSON.stringify(message)).catch(() => {});
  }

  /** Forward a resume request to the owner and wait for its answer. */
  requestResume(
    owner: string,
    request: Omit<Extract<BusMessage, { type: "resume" }>, "type" | "requestId" | "replyTo">,
  ): Promise<MatchResumeResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ status: "pending" });
      }, BUS_REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.publish(owner, { ...request, type: "resume", requestId, replyTo: this.replicaId });
    });
  }

  private dispatch(message: BusMessage) {
    if (message.type === "resume-reply") {
      const resolve = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      resolve?.(message.result);
      return;
    }
    this.handler?.(message);
  }

  async close() {
    await this.subscriber?.quit().catch(() => {});
  }
}
