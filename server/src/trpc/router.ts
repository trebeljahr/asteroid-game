import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { z } from "zod";

import {
  ACHIEVEMENT_DEFINITIONS,
  MULTIPLAYER_SHIP_VARIANTS,
  type MultiplayerRuntimeConfig,
  type ShipVariant,
  toPublicAchievement,
} from "../../../shared/src";
import type { AchievementService } from "../achievementService";
import { getOrCreateUserByDeviceToken, updateDisplayName } from "../userService";

export interface TRPCContext {
  deviceToken: string | null;
}

export const createTRPCContext = (opts: CreateExpressContextOptions): TRPCContext => {
  const header = opts.req.header("x-device-token");
  return {
    deviceToken: typeof header === "string" && header.length > 0 ? header : null,
  };
};

const t = initTRPC.context<TRPCContext>().create();

const requireDeviceToken = t.middleware(({ ctx, next }) => {
  if (ctx.deviceToken === null) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing X-Device-Token header",
    });
  }
  return next({ ctx: { ...ctx, deviceToken: ctx.deviceToken } });
});

const authedProcedure = t.procedure.use(requireDeviceToken);

interface MultiplayerController {
  enqueueSocketById(
    socketId: string,
    shipVariant: ShipVariant,
  ): { enqueued: false; reason: "already-matched" | "socket-not-found" | "server-draining" } | { enqueued: true };
  getRuntimeConfig(): MultiplayerRuntimeConfig;
  leaveSocketById(
    socketId: string,
  ): { removed: false; scope: "none" } | { removed: true; scope: "match" | "queue" };
}

interface BattleRoyaleController {
  enqueue(
    socketId: string,
    shipVariant: ShipVariant,
  ):
    | {
        enqueued: false;
        reason: "already-in-match" | "socket-not-found" | "lobby-full" | "server-draining";
      }
    | { enqueued: true };
  leave(
    socketId: string,
  ): { removed: false; scope: "none" } | { removed: true; scope: "lobby" | "match" };
}

export const createAppRouter = (
  multiplayerService: MultiplayerController,
  battleRoyaleService: BattleRoyaleController,
  achievementService: AchievementService,
) => {
  return t.router({
    health: t.procedure.query(() => {
      return { ok: true };
    }),

    user: t.router({
      bootstrap: authedProcedure.mutation(async ({ ctx }) => {
        try {
          const context = await getOrCreateUserByDeviceToken(ctx.deviceToken);
          const achievements = await achievementService.listForUser(context.user.id);
          return {
            user: {
              id: context.user.id,
              displayName: context.user.displayName,
              hasEmail: context.user.email !== null,
              createdAt: context.user.createdAt.toISOString(),
            },
            stats: {
              runAttempts: context.stats.runAttempts,
              runCompletions: context.stats.runCompletions,
              runBestTimeMs: context.stats.runBestTimeMs,
              multiplayerWins: context.stats.multiplayerWins,
              multiplayerLosses: context.stats.multiplayerLosses,
              multiplayerDraws: context.stats.multiplayerDraws,
              brMatches: context.stats.brMatches,
              brWins: context.stats.brWins,
              brTopThree: context.stats.brTopThree,
              asteroidsDestroyed: context.stats.asteroidsDestroyed,
              bulletsFired: context.stats.bulletsFired,
              heartsCollected: context.stats.heartsCollected,
              ammoCollected: context.stats.ammoCollected,
              goalsCleared: context.stats.goalsCleared,
              opponentsEliminated: context.stats.opponentsEliminated,
            },
            achievements,
          };
        } catch (error) {
          // Gracefully degrade when the database is unavailable so the
          // client still boots into singleplayer.
          console.warn("[trpc] user.bootstrap failed, returning offline view:", error);
          return null;
        }
      }),

      setDisplayName: authedProcedure
        .input(z.object({ displayName: z.string().min(1).max(32) }))
        .mutation(async ({ ctx, input }) => {
          const context = await getOrCreateUserByDeviceToken(ctx.deviceToken);
          await updateDisplayName(context.user.id, input.displayName);
          return { ok: true as const };
        }),
    }),

    achievements: t.router({
      definitions: t.procedure.query(() => {
        return ACHIEVEMENT_DEFINITIONS.map(toPublicAchievement);
      }),
      list: authedProcedure.query(async ({ ctx }) => {
        try {
          const context = await getOrCreateUserByDeviceToken(ctx.deviceToken);
          return await achievementService.listForUser(context.user.id);
        } catch (error) {
          console.warn("[trpc] achievements.list failed", error);
          return ACHIEVEMENT_DEFINITIONS.map((definition) => ({
            ...toPublicAchievement(definition),
            unlockedAt: null as Date | null,
            progressValue: 0,
          }));
        }
      }),
      /**
       * Clients dispatch singleplayer events here (run attempts,
       * completions, goal clears, asteroid destructions). Server-side
       * authoritative events (MP/BR match results) are dispatched by
       * the match services directly.
       */
      reportClientEvent: authedProcedure
        .input(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("run.attempted") }),
            z.object({
              type: z.literal("run.completed"),
              durationMs: z
                .number()
                .int()
                .min(0)
                .max(60 * 60 * 1000),
              noDamage: z.boolean(),
            }),
            z.object({ type: z.literal("run.goalReached") }),
            z.object({ type: z.literal("asteroid.destroyed") }),
            z.object({ type: z.literal("heart.collected") }),
            z.object({ type: z.literal("ammo.collected") }),
            z.object({
              type: z.literal("bullet.fired"),
              count: z.number().int().min(1).max(8),
            }),
          ]),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const context = await getOrCreateUserByDeviceToken(ctx.deviceToken);
            const unlocks = await dispatchClientEvent(achievementService, context.user.id, input);
            return {
              unlocked: unlocks.map((entry) => entry.achievementId),
            };
          } catch (error) {
            console.warn("[trpc] achievements.reportClientEvent failed", error);
            return { unlocked: [] as string[] };
          }
        }),
    }),

    multiplayer: t.router({
      joinQueue: t.procedure
        .input(
          z.object({
            socketId: z.string().min(1),
            shipVariant: z.enum(MULTIPLAYER_SHIP_VARIANTS as unknown as [string, ...string[]]),
          }),
        )
        .mutation(({ input }) => {
          return multiplayerService.enqueueSocketById(
            input.socketId,
            input.shipVariant as ShipVariant,
          );
        }),
      leaveQueue: t.procedure
        .input(
          z.object({
            socketId: z.string().min(1),
          }),
        )
        .mutation(({ input }) => {
          return multiplayerService.leaveSocketById(input.socketId);
        }),
      runtime: t.procedure.query(() => {
        return multiplayerService.getRuntimeConfig();
      }),
    }),
    battleRoyale: t.router({
      joinQueue: t.procedure
        .input(
          z.object({
            socketId: z.string().min(1),
            shipVariant: z.enum(MULTIPLAYER_SHIP_VARIANTS as unknown as [string, ...string[]]),
          }),
        )
        .mutation(({ input }) => {
          return battleRoyaleService.enqueue(input.socketId, input.shipVariant as ShipVariant);
        }),
      leaveQueue: t.procedure
        .input(
          z.object({
            socketId: z.string().min(1),
          }),
        )
        .mutation(({ input }) => {
          return battleRoyaleService.leave(input.socketId);
        }),
    }),
  });
};

export type AppRouter = ReturnType<typeof createAppRouter>;

/**
 * Maps a client-reported event onto a stat delta and an achievement
 * event payload, then applies both to the achievement service. Event
 * payload is what the achievement predicates see; the stat delta is
 * what's persisted for cumulative progress.
 */
const dispatchClientEvent = async (
  achievementService: AchievementService,
  userId: string,
  event:
    | { type: "run.attempted" }
    | { type: "run.completed"; durationMs: number; noDamage: boolean }
    | { type: "run.goalReached" }
    | { type: "asteroid.destroyed" }
    | { type: "heart.collected" }
    | { type: "ammo.collected" }
    | { type: "bullet.fired"; count: number },
) => {
  switch (event.type) {
    case "run.attempted":
      return achievementService.applyEvent(userId, { runAttempts: 1 }, { type: "run.attempted" });
    case "run.completed":
      return achievementService.applyEvent(
        userId,
        {
          runCompletions: 1,
          runBestTimeMs: event.durationMs,
        },
        {
          type: "run.completed",
          durationMs: event.durationMs,
          noDamage: event.noDamage,
        },
      );
    case "run.goalReached":
      return achievementService.applyEvent(userId, { goalsCleared: 1 }, { type: "goal.reached" });
    case "asteroid.destroyed":
      return achievementService.applyEvent(
        userId,
        { asteroidsDestroyed: 1 },
        { type: "asteroid.destroyed" },
      );
    case "heart.collected":
      return achievementService.applyEvent(
        userId,
        { heartsCollected: 1 },
        { type: "heart.collected" },
      );
    case "ammo.collected":
      return achievementService.applyEvent(
        userId,
        { ammoCollected: 1 },
        { type: "ammo.collected" },
      );
    case "bullet.fired":
      return achievementService.applyEvent(
        userId,
        { bulletsFired: event.count },
        { type: "bullet.fired", count: event.count },
      );
  }
};
