import { performance } from "node:perf_hooks";
import type { Socket } from "socket.io";
import { z } from "zod";

import {
  type ClientToServerEvents,
  type MatchMode,
  type MatchResumeResult,
  MULTIPLAYER_SHIP_VARIANTS,
  type QueueJoinResult,
  type QueueLeaveResult,
  type ServerToClientEvents,
  type ShipInputState,
  type ShipVariant,
} from "../../../shared/src";
import { type BattleRoyaleService, LOBBY_LEASE_NAME, LOBBY_ROOM_ID } from "../battleRoyaleService";
import type { MultiplayerService } from "../multiplayerService";
import type { BusMessage, ReplicaBus, SocketRoute } from "./bus";
import {
  LEASE_LOCAL_MARGIN_MS,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  MATCHMAKER_INTERVAL_MS,
  QUEUE_STATUS_INTERVAL_MS,
  RECOVERY_SCAN_INTERVAL_MS,
  TICKET_REFRESH_INTERVAL_MS,
} from "./config";
import type { MatchDurability } from "./durability";
import type { RouteRegistry, TypedServer } from "./matchHost";
import type { CoordinationStore } from "./store";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const queueJoinSchema = z.object({
  mode: z.enum(["duel", "battle-royale"]),
  shipVariant: z.enum(MULTIPLAYER_SHIP_VARIANTS as unknown as [string, ...string[]]),
});

const resumeSchema = z.object({
  matchId: z.string().min(1).max(128),
  resumeToken: z.string().min(1).max(128),
});

const isInput = (value: unknown): value is ShipInputState => {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.inputSeq === "number" &&
    typeof input.fire === "boolean" &&
    typeof input.thrust === "boolean" &&
    typeof input.turnLeft === "boolean" &&
    typeof input.turnRight === "boolean"
  );
};

const replyWith = <T>(ack: unknown) => {
  return (result: T) => {
    if (typeof ack === "function") ack(result);
  };
};

/**
 * Socket-facing side of the realtime server on one replica.
 *
 * - Queue commands arrive on the socket itself, so they always reach the
 *   replica that holds the socket. Tickets go to the shared queue.
 * - Any non-draining replica pairs duel tickets; the lobby lease holder
 *   runs the battle-royale lobby.
 * - Input and resume requests are forwarded to the replica that owns
 *   the match, which may be a different one.
 * - Non-draining replicas claim matches whose owner drained or died.
 */
export class RealtimeCoordinator implements RouteRegistry {
  private routes = new Map<string, SocketRoute>();
  private localTickets = new Map<string, MatchMode>();
  private draining = false;
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private lobbyOwned = false;
  private lobbyValidUntil = 0;
  private lobbyRenewAt = 0;
  private duel!: MultiplayerService;
  private battleRoyale!: BattleRoyaleService;

  constructor(
    private io: TypedServer,
    private store: CoordinationStore,
    private bus: ReplicaBus,
    private durability: MatchDurability,
    readonly replicaId: string,
  ) {}

  attachHosts(duel: MultiplayerService, battleRoyale: BattleRoyaleService) {
    this.duel = duel;
    this.battleRoyale = battleRoyale;
    this.durability.register(duel);
    this.durability.register(battleRoyale);
  }

  private host(mode: MatchMode) {
    return mode === "duel" ? this.duel : this.battleRoyale;
  }

  async start() {
    await this.bus.start((message) => this.handleBusMessage(message));
    this.durability.start();
    this.every(MATCHMAKER_INTERVAL_MS, "matchmaker", () => this.runMatchmaker());
    this.every(MATCHMAKER_INTERVAL_MS, "lobby", () => this.runLobby());
    this.every(RECOVERY_SCAN_INTERVAL_MS, "recovery", () => this.runRecovery());
    this.every(TICKET_REFRESH_INTERVAL_MS, "tickets", () =>
      this.store.refreshTickets(this.replicaId),
    );
    this.every(QUEUE_STATUS_INTERVAL_MS, "status", () => this.emitQueueStatus());
    this.every(30_000, "cleanup", () => this.store.cleanup());
  }

  /** Run a periodic job, never overlapping with itself, never while draining. */
  private every(intervalMs: number, name: string, job: () => Promise<unknown>) {
    const timer = setInterval(() => {
      if (this.draining || this.busy.has(name)) return;
      this.busy.add(name);
      job()
        .catch((error) => console.error(`[realtime] ${name} failed`, error))
        .finally(() => this.busy.delete(name));
    }, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  registerSocket(socket: TypedSocket) {
    socket.on("queue:join", (payload, ack) => {
      void this.handleQueueJoin(socket, payload, replyWith<QueueJoinResult>(ack));
    });
    socket.on("queue:leave", (ack) => {
      void this.handleQueueLeave(socket, replyWith<QueueLeaveResult>(ack));
    });
    socket.on("match:input", (input) => {
      this.routeInput(socket.id, "duel", input);
    });
    socket.on("br:input", (input) => {
      this.routeInput(socket.id, "battle-royale", input);
    });
    socket.on("match:resume", (payload, ack) => {
      void this.handleResume(socket, payload, replyWith<MatchResumeResult>(ack));
    });
    socket.on("disconnect", () => {
      void this.handleDisconnect(socket.id);
    });
  }

  bind(socketId: string, replicaId: string, route: SocketRoute) {
    if (replicaId === this.replicaId) {
      this.applyBind(socketId, route);
      return;
    }
    this.bus.publish(replicaId, { type: "bind", route, socketId });
  }

  unbind(socketId: string, replicaId: string, matchId: string) {
    if (replicaId === this.replicaId) {
      this.applyUnbind(socketId, matchId);
      return;
    }
    this.bus.publish(replicaId, { type: "unbind", matchId, socketId });
  }

  /**
   * SIGTERM: stop matchmaking and claims, hand every owned match off
   * with a final snapshot, then disconnect local sockets so clients
   * reconnect to a live replica and resume.
   */
  async beginDrain() {
    if (this.draining) return;
    this.draining = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.battleRoyale.resetLobby();
    await Promise.allSettled([
      this.store.releaseSingleton(LOBBY_LEASE_NAME, this.replicaId),
      this.store.deleteTicketsForReplica(this.replicaId),
    ]);
    this.localTickets.clear();
    await Promise.allSettled([this.duel.beginDrain(), this.battleRoyale.beginDrain()]);
    this.durability.stop();
    this.io.local.emit("server:draining");
    this.io.local.disconnectSockets(true);
  }

  private async handleQueueJoin(
    socket: TypedSocket,
    payload: unknown,
    reply: (result: QueueJoinResult) => void,
  ) {
    if (this.draining) {
      reply({ enqueued: false, reason: "server-draining" });
      return;
    }
    const parsed = queueJoinSchema.safeParse(payload);
    if (!parsed.success) {
      reply({ enqueued: false, reason: "invalid-request" });
      return;
    }
    if (this.routes.has(socket.id)) {
      reply({ enqueued: false, reason: "already-in-match" });
      return;
    }
    const mode = parsed.data.mode;
    try {
      await this.store.putTicket({
        mode,
        replicaId: this.replicaId,
        shipVariant: parsed.data.shipVariant as ShipVariant,
        socketId: socket.id,
        userId: (socket.data as { userId?: string }).userId ?? null,
      });
    } catch (error) {
      console.error("[realtime] enqueue failed", error);
      reply({ enqueued: false, reason: "unavailable" });
      return;
    }
    this.localTickets.set(socket.id, mode);
    if (mode === "battle-royale") {
      socket.join(LOBBY_ROOM_ID);
    } else {
      socket.leave(LOBBY_ROOM_ID);
    }
    reply({ enqueued: true });
    void this.emitQueueStatus().catch(() => {});
  }

  private async handleQueueLeave(socket: TypedSocket, reply: (result: QueueLeaveResult) => void) {
    if (this.localTickets.delete(socket.id)) {
      socket.leave(LOBBY_ROOM_ID);
      await this.store.deleteTicket(socket.id).catch(() => false);
      reply({ removed: true, scope: "queue" });
      return;
    }
    const route = this.routes.get(socket.id);
    if (route === undefined) {
      reply({ removed: false, scope: "none" });
      return;
    }
    this.routes.delete(socket.id);
    this.deliver(route, {
      type: "detach",
      explicit: true,
      matchId: route.matchId,
      mode: route.mode,
      socketId: socket.id,
    });
    reply({ removed: true, scope: "match" });
  }

  private async handleDisconnect(socketId: string) {
    if (this.localTickets.delete(socketId)) {
      await this.store.deleteTicket(socketId).catch(() => false);
    }
    const route = this.routes.get(socketId);
    if (route === undefined) return;
    this.routes.delete(socketId);
    // Any disconnect keeps the seat for the resume grace period: the
    // client may be reconnecting to another replica. Leaving on purpose
    // goes through "queue:leave", which forfeits at once.
    this.deliver(route, {
      type: "detach",
      explicit: false,
      matchId: route.matchId,
      mode: route.mode,
      socketId,
    });
  }

  private routeInput(socketId: string, mode: MatchMode, input: unknown) {
    const route = this.routes.get(socketId);
    if (route === undefined || route.mode !== mode || !isInput(input)) return;
    this.deliver(route, { type: "input", input, matchId: route.matchId, mode, socketId });
  }

  private deliver(route: SocketRoute, message: Extract<BusMessage, { type: "input" | "detach" }>) {
    if (route.owner === this.replicaId) {
      this.handleBusMessage(message);
      return;
    }
    this.bus.publish(route.owner, message);
  }

  /**
   * A client presents matchId + resume token after a reconnect. Look up
   * the current owner in the lease table and forward the request there.
   */
  private async handleResume(
    socket: TypedSocket,
    payload: unknown,
    reply: (result: MatchResumeResult) => void,
  ) {
    const parsed = resumeSchema.safeParse(payload);
    if (!parsed.success) {
      reply({ status: "unknown" });
      return;
    }
    if (this.draining) {
      reply({ status: "pending" });
      return;
    }
    const { matchId, resumeToken } = parsed.data;
    let lease: Awaited<ReturnType<CoordinationStore["getLease"]>>;
    try {
      lease = await this.store.getLease(matchId);
    } catch {
      reply({ status: "pending" });
      return;
    }
    if (lease === null || (lease.mode !== "duel" && lease.mode !== "battle-royale")) {
      reply({ status: "unknown" });
      return;
    }
    if (lease.state === "finished") {
      reply({ status: "ended", reason: "server-restart" });
      return;
    }
    if (lease.state === "handoff" || lease.expiresAt < Date.now()) {
      reply({ status: "pending" });
      return;
    }

    const mode = lease.mode as MatchMode;
    const request = { matchId, mode, replicaId: this.replicaId, resumeToken, socketId: socket.id };
    const result =
      lease.owner === this.replicaId
        ? this.attachLocally(request)
        : await this.bus.requestResume(lease.owner, request);

    if (result.status === "resumed" && socket.connected) {
      if (this.localTickets.delete(socket.id)) {
        void this.store.deleteTicket(socket.id).catch(() => false);
      }
      this.routes.set(socket.id, { matchId, mode, owner: lease.owner });
    }
    reply(result);
  }

  private attachLocally(request: {
    matchId: string;
    mode: MatchMode;
    replicaId: string;
    resumeToken: string;
    socketId: string;
  }): MatchResumeResult {
    if (this.draining) return { status: "pending" };
    const host = this.host(request.mode);
    if (!host.hasMatch(request.matchId)) {
      // Not loaded (yet) here: the lease row may be a moment ahead of us.
      return { status: "pending" };
    }
    return host.attach(request.matchId, request.resumeToken, request.socketId, request.replicaId);
  }

  private handleBusMessage(message: BusMessage) {
    switch (message.type) {
      case "input":
        this.host(message.mode).handleInput(message.matchId, message.socketId, message.input);
        return;
      case "detach":
        this.host(message.mode).handleDetach(message.matchId, message.socketId, message.explicit);
        return;
      case "bind":
        this.applyBind(message.socketId, message.route);
        return;
      case "unbind":
        this.applyUnbind(message.socketId, message.matchId);
        return;
      case "resume": {
        const result = this.attachLocally(message);
        this.bus.publish(message.replyTo, {
          type: "resume-reply",
          requestId: message.requestId,
          result,
        });
        return;
      }
      case "resume-reply":
        return;
    }
  }

  private applyBind(socketId: string, route: SocketRoute) {
    this.localTickets.delete(socketId);
    if (!this.io.sockets.sockets.has(socketId)) {
      // The socket left before the match was created: free the seat.
      this.deliver(route, {
        type: "detach",
        explicit: false,
        matchId: route.matchId,
        mode: route.mode,
        socketId,
      });
      return;
    }
    this.routes.set(socketId, route);
  }

  private applyUnbind(socketId: string, matchId: string) {
    if (this.routes.get(socketId)?.matchId === matchId) {
      this.routes.delete(socketId);
    }
  }

  private async runMatchmaker() {
    for (;;) {
      const tickets = await this.store.takeTickets("duel", 2, 2);
      if (tickets.length < 2) return;
      try {
        await this.duel.createMatch(tickets);
      } catch (error) {
        console.error("[matchmaking] duel creation failed; requeueing players", error);
        await Promise.all(tickets.map((ticket) => this.store.putTicket(ticket)));
        return;
      }
    }
  }

  private async runLobby() {
    const now = performance.now();
    if (now >= this.lobbyRenewAt) {
      const owned = await this.store.acquireSingleton(LOBBY_LEASE_NAME, this.replicaId);
      if (!owned && this.lobbyOwned) this.battleRoyale.resetLobby();
      this.lobbyOwned = owned;
      this.lobbyValidUntil = owned ? now + LEASE_TTL_MS - LEASE_LOCAL_MARGIN_MS : 0;
      this.lobbyRenewAt = now + LEASE_RENEW_INTERVAL_MS;
    }
    if (!this.lobbyOwned || performance.now() > this.lobbyValidUntil) return;
    await this.battleRoyale.runLobby(this.store);
  }

  private async runRecovery() {
    const claimable = await this.store.listClaimable(10);
    for (const lease of claimable) {
      if (this.draining) return;
      if (lease.mode !== "duel" && lease.mode !== "battle-royale") continue;
      const mode = lease.mode as MatchMode;
      const claimedAt = performance.now();
      const fence = await this.store.claimLease(lease.matchId, lease.epoch, this.replicaId);
      if (fence === null) continue;
      const host = this.host(mode);
      // Our own stale copy (lease expired under us) must not survive.
      host.drop(fence.matchId);
      this.durability.adopt(fence, claimedAt);
      const snapshot = await this.store.readSnapshot(fence.matchId);
      if (host.restore(fence, snapshot)) {
        console.log(
          `[handoff] claimed ${fence.matchId} at epoch ${fence.epoch} from ${lease.owner} (${lease.state}), snapshot sequence ${snapshot?.sequence}`,
        );
        continue;
      }
      console.warn(
        `[handoff] ${fence.matchId}: no usable snapshot, ending uncounted (server-restart)`,
      );
      host.endUnrecoverable(fence);
    }
  }

  private async emitQueueStatus() {
    const duelSockets = Array.from(this.localTickets).filter(([, mode]) => mode === "duel");
    if (duelSockets.length === 0) return;
    const queue = await this.store.listTickets("duel");
    queue.forEach((ticket, index) => {
      if (ticket.replicaId !== this.replicaId || !this.localTickets.has(ticket.socketId)) return;
      this.io.to(ticket.socketId).emit("matchmaking:status", {
        position: index + 1,
        queueSize: queue.length,
      });
    });
  }
}
