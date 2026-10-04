import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createAdapter } from "@socket.io/redis-adapter";
import * as trpcExpress from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../../shared/src";
import { achievementService } from "./achievementService";
import { BattleRoyaleService } from "./battleRoyaleService";
import { getPool } from "./db";
import { runMigrations } from "./db/runMigrations";
import { getMultiplayerRuntimeConfig, MultiplayerService } from "./multiplayerService";
import { ReplicaBus } from "./realtime/bus";
import { DRAIN_DELAY_MS } from "./realtime/config";
import { RealtimeCoordinator } from "./realtime/coordinator";
import { MatchDurability } from "./realtime/durability";
import { REPLICA_ID } from "./realtime/ids";
import {
  type CoordinationStore,
  MemoryCoordinationStore,
  PostgresCoordinationStore,
} from "./realtime/store";
import { connectRedis } from "./redis";
import { createAppRouter, createTRPCContext } from "./trpc/router";

const app = express();
const httpServer = createServer(app);
let draining = false;
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: true,
    credentials: true,
  },
});

let coordinator: RealtimeCoordinator | null = null;
const appRouter = createAppRouter(
  { getRuntimeConfig: getMultiplayerRuntimeConfig },
  achievementService,
);

const clientDistPath = path.resolve(__dirname, "../../client/dist");

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({
    router: appRouter,
    createContext: createTRPCContext,
  }),
);

app.get("/health", (_request, response) => {
  if (draining) return response.status(503).json({ ok: false });
  response.json({ ok: true });
});

if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get("*", (_request, response) => {
    response.sendFile(path.join(clientDistPath, "index.html"));
  });
} else {
  app.get("/", (_request, response) => {
    response
      .status(200)
      .send("Client build not found. Run `pnpm dev` or `pnpm build` from the repo root.");
  });
}

io.use(async (socket, next) => {
  if (draining) {
    next(new Error("Server restarting; reconnect shortly"));
    return;
  }
  const token = extractDeviceToken(socket.handshake.auth?.deviceToken);
  if (token === null) {
    // Allow anonymous connections — they simply won't earn achievements.
    next();
    return;
  }
  try {
    const { getOrCreateUserByDeviceToken } = await import("./userService");
    const context = await getOrCreateUserByDeviceToken(token);
    (socket.data as { userId?: string }).userId = context.user.id;
  } catch (error) {
    // Never block the handshake on DB errors — multiplayer must keep
    // working even if persistence is down. Just log and move on.
    console.warn("[socket.io] device-token resolution failed", error);
  }
  next();
});

const userRoomId = (userId: string) => `user:${userId}`;

io.on("connection", (socket) => {
  console.log(`New user with id: ${socket.id}`);
  const userId = (socket.data as { userId?: string }).userId;
  if (userId !== undefined) {
    // Join a personal room so the achievement service can push
    // unlocks to just this user, even across multiple tabs.
    socket.join(userRoomId(userId));
  }
  coordinator?.registerSocket(socket);
});

// Fan out achievement unlocks to the owning user's room. Since the
// achievement service lives in-process, this handles pushes from any
// code that calls applyEvent — gameplay services, tRPC endpoints, etc.
achievementService.onUnlock((event) => {
  io.to(userRoomId(event.userId)).emit("achievement:unlocked", {
    achievementId: event.achievementId,
    unlockedAt: event.unlockedAt.toISOString(),
  });
});

function extractDeviceToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return trimmed;
}

const port = Number(process.env.PORT ?? 9777);

process.on("SIGTERM", () => {
  if (draining) return;
  draining = true;
  // Hand live matches to another replica: final snapshot, lease
  // `handoff`, then clients reconnect elsewhere and resume.
  void coordinator?.beginDrain().catch((error) => {
    console.error("[drain] handoff failed", error);
  });
  // Coolify needs time to remove this instance from proxy routing.
  setTimeout(() => {
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }, DRAIN_DELAY_MS);
});

const start = async () => {
  let databaseReady = false;
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      databaseReady = true;
    } catch (error) {
      console.error("[db] Startup migration failed. Continuing without persistence:", error);
    }
  } else {
    console.warn("[db] DATABASE_URL not set — user accounts and achievements disabled");
  }

  const redis = await connectRedis();
  if (redis !== null) {
    io.adapter(createAdapter(redis, redis.duplicate()));
    console.log("[socket.io] Using Redis adapter for horizontal scaling");
  }

  // Durable handoff needs both: Postgres holds leases, snapshots and the
  // shared queue; Redis carries room fanout and replica-to-replica
  // messages. Without either, run as one replica with in-memory state.
  const pool = databaseReady ? getPool() : null;
  const durable = pool !== null && redis !== null;
  const store: CoordinationStore = durable
    ? new PostgresCoordinationStore(pool)
    : new MemoryCoordinationStore();
  const bus = new ReplicaBus(
    REPLICA_ID,
    durable ? redis : null,
    durable ? redis.duplicate() : null,
  );
  const durability = new MatchDurability(store, REPLICA_ID, durable);
  coordinator = new RealtimeCoordinator(io, store, bus, durability, REPLICA_ID);
  const context = { durability, io, replicaId: REPLICA_ID, routes: coordinator };
  coordinator.attachHosts(new MultiplayerService(context), new BattleRoyaleService(context));
  await coordinator.start();
  console.log(
    `[realtime] replica ${REPLICA_ID}: ${durable ? "durable match handoff (Postgres + Redis)" : "single replica, in-memory matches"}`,
  );

  httpServer.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
};

void start();
