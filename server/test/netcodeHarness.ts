import type { MockTimers } from "node:test";

import { replayPendingInputs } from "../../client/src/netcode/reconcile";
import { sampleRemotePlayers } from "../../client/src/netcode/remoteEntities";
import { RenderSmoother } from "../../client/src/netcode/renderSmoother";
import { ServerTimeline } from "../../client/src/netcode/serverTimeline";
import {
  FixedStepClock,
  type MatchSnapshotPayload,
  MULTIPLAYER_ARENA,
  type RuntimePlayerState,
  type ShipInputState,
  stepPlayerState,
  TICK_INTERVAL_MS,
} from "../../shared/src";
import { MultiplayerService } from "../src/multiplayerService";
import type { HostContext } from "../src/realtime/matchHost";
import type { Ticket } from "../src/realtime/store";

/**
 * A duel played in virtual time: the real server simulation, two clients
 * built from the real client netcode modules, and a simulated network
 * between them. Timers and the clock are mocked, so a run is exact and
 * repeatable however busy the machine is.
 */

export type Controls = Omit<ShipInputState, "inputSeq">;

export interface LinkProfile {
  /** Extra delay per packet, drawn evenly from 0 to this value. */
  jitterMs: number;
  /** One-way delay of every packet. */
  latencyMs: number;
  /** A periodic stall, as after a lost TCP packet. Packets queue up and arrive together. */
  stall?: { everyMs: number; forMs: number };
}

export interface PilotOptions {
  controls: (elapsedMs: number) => Controls;
  /** Inputs sent per simulation tick. An honest client sends one. */
  inputsPerTick?: number;
  link: LinkProfile;
}

export interface PilotReport {
  /** Inputs the server applied to this ship between consecutive snapshots. Two when even. */
  appliedPerSnapshot: number[];
  /** Distance the server moved the predicted ship at each snapshot, in pixels. */
  corrections: number[];
  /** Frames on which the drawn opponent moved against its own velocity. */
  opponentBackwardFrames: number;
  /** Per frame: how far the drawn opponent strayed from steady motion, in pixels. */
  opponentHitches: number[];
  /** Per frame: how far the drawn own ship strayed from steady motion, in pixels. */
  selfHitches: number[];
}

export interface DuelReport {
  /** The match ended before the run did, for example because a ship was destroyed. */
  endedEarly: boolean;
  frames: number;
  /** Final authoritative ship states, by socket ID. */
  serverPlayers: Record<string, RuntimePlayerState>;
  /** Every snapshot the server emitted, before any network delay. */
  serverSnapshots: MatchSnapshotPayload[];
  pilots: Record<string, PilotReport>;
}

const FRAME_MS = 1000 / 60;
const SOCKET_IDS = ["s1", "s2"] as const;
/** A larger change of speed in one frame is a wall or a collision, not a hitch. */
const SPEED_JUMP = 1;

export const idle: Controls = { fire: false, thrust: false, turnLeft: false, turnRight: false };

export const runDuel = async (
  timers: MockTimers,
  options: { activeMs: number; pilots: [PilotOptions, PilotOptions]; seed?: number },
): Promise<DuelReport> => {
  timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const now = () => Date.now();

  let randomState = options.seed ?? 20261013;
  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 4294967296;
  };

  // Ordered delivery with latency, jitter and stalls: what TCP gives a WebSocket.
  const lastDueAt = new Map<string, number>();
  const send = (direction: string, profile: LinkProfile, deliver: () => void) => {
    const sentAt = now();
    let delay = profile.latencyMs + random() * profile.jitterMs;
    if (profile.stall !== undefined && sentAt % profile.stall.everyMs < 20) {
      delay += profile.stall.forMs;
    }
    const dueAt = Math.max(lastDueAt.get(direction) ?? 0, sentAt + delay);
    lastDueAt.set(direction, dueAt);
    setTimeout(deliver, dueAt - sentAt);
  };

  const serverSnapshots: MatchSnapshotPayload[] = [];
  const listeners = new Map<string, (event: string, payload: unknown) => void>();
  const profiles = new Map<string, LinkProfile>(
    SOCKET_IDS.map((socketId, index) => [socketId, options.pilots[index].link]),
  );
  const io = {
    in: () => ({ socketsJoin: () => {}, socketsLeave: () => {} }),
    to: (target: string) => ({
      emit: (event: string, payload: unknown) => {
        const wire = JSON.stringify(payload);
        if (event === "match:snapshot") {
          serverSnapshots.push(JSON.parse(wire));
        }
        const receivers = target.startsWith("multiplayer:") ? SOCKET_IDS : [target];
        for (const socketId of receivers) {
          const profile = profiles.get(socketId);
          if (profile === undefined) continue;
          send(`down:${socketId}`, profile, () => {
            listeners.get(socketId)?.(event, JSON.parse(wire));
          });
        }
      },
    }),
  };
  const context = {
    durability: {
      canHandOff: false,
      finish: async () => {},
      leaseLive: () => true,
      open: async (matchId: string) => ({ epoch: 1, matchId, owner: "replica-test" }),
    },
    io,
    now,
    replicaId: "replica-test",
    routes: { bind: () => {}, unbind: () => {} },
  } as unknown as HostContext;
  const duel = new MultiplayerService(context);

  const seats = new Map<string, { matchId: string; playerId: string }>();
  const pilots = SOCKET_IDS.map((socketId, index) => {
    const pilot = options.pilots[index];
    const report: PilotReport = {
      appliedPerSnapshot: [],
      corrections: [],
      opponentBackwardFrames: 0,
      opponentHitches: [],
      selfHitches: [],
    };
    const clock = new FixedStepClock(TICK_INTERVAL_MS, 6);
    const smoother = new RenderSmoother();
    const timeline = new ServerTimeline<MatchSnapshotPayload>();
    let predicted: RuntimePlayerState | null = null;
    let pending: Array<{ input: ShipInputState; seq: number }> = [];
    let seq = 0;
    let startedAt: number | null = null;
    let latest: MatchSnapshotPayload | null = null;

    const pump = () => {
      if (startedAt === null || predicted === null) return;
      const dueTicks = clock.advance(now());
      for (let tick = 0; tick < dueTicks * (pilot.inputsPerTick ?? 1); tick++) {
        const input: ShipInputState = { ...pilot.controls(now() - startedAt), inputSeq: ++seq };
        pending.push({ input, seq });
        stepPlayerState(predicted, input, MULTIPLAYER_ARENA);
        smoother.advance(predicted);
        const seat = seats.get(socketId);
        if (seat === undefined) continue;
        send(`up:${socketId}`, pilot.link, () => {
          duel.handleInput(seat.matchId, socketId, input);
        });
      }
    };
    setInterval(pump, 8);

    listeners.set(socketId, (event, payload) => {
      if (event === "match:found") {
        seats.set(socketId, payload as { matchId: string; playerId: string });
        return;
      }
      if (event !== "match:snapshot") return;
      const snapshot = payload as MatchSnapshotPayload;
      if (latest !== null && snapshot.sequence <= latest.sequence) return;
      latest = snapshot;
      timeline.observe(snapshot.sequence, snapshot, now());
      if (snapshot.phase !== "active") return;

      const self = snapshot.players.find((player) => player.id === seats.get(socketId)?.playerId);
      if (self === undefined) return;
      const before = predicted;
      const reconciled = replayPendingInputs(self, pending, MULTIPLAYER_ARENA);
      predicted = reconciled.state;
      pending = reconciled.pending;
      smoother.rebase(reconciled.beforeLastStep, predicted, clock.alphaAt(now()), now());
      if (before !== null) {
        report.corrections.push(Math.hypot(predicted.x - before.x, predicted.y - before.y));
      }
      if (startedAt === null) {
        startedAt = now();
        clock.reset(now());
      }
    });

    // What the player sees, once per display frame. A smooth picture moves
    // each frame by its velocity; anything else is a visible hitch.
    let previous: { opponent: RuntimePlayerState | null; self: RuntimePlayerState } | null = null;
    let previousFrameAt = 0;
    const frame = () => {
      pump();
      if (predicted === null || latest === null || latest.phase !== "active") return false;
      const pose = smoother.poseAt(clock.alphaAt(now()), now());
      const view = timeline.view(now());
      const self = { ...predicted, ...pose };
      const opponent =
        view === null
          ? null
          : ({
              ...sampleRemotePlayers(view, self.id, MULTIPLAYER_ARENA)[0],
              fireCooldownTicks: 0,
            } as RuntimePlayerState);
      if (previous !== null) {
        const frameTicks = (now() - previousFrameAt) / TICK_INTERVAL_MS;
        const steady = (ship: RuntimePlayerState, before: RuntimePlayerState) => {
          return Math.hypot(ship.vx - before.vx, ship.vy - before.vy) < SPEED_JUMP;
        };
        if (steady(self, previous.self)) {
          report.selfHitches.push(
            Math.hypot(
              self.x - previous.self.x - self.vx * frameTicks,
              self.y - previous.self.y - self.vy * frameTicks,
            ),
          );
        }
        if (
          opponent !== null &&
          previous.opponent !== null &&
          steady(opponent, previous.opponent)
        ) {
          const dx = opponent.x - previous.opponent.x;
          const dy = opponent.y - previous.opponent.y;
          report.opponentHitches.push(
            Math.hypot(dx - opponent.vx * frameTicks, dy - opponent.vy * frameTicks),
          );
          const speed = Math.hypot(opponent.vx, opponent.vy);
          if (speed > 2 && dx * opponent.vx + dy * opponent.vy < -0.5 * speed) {
            report.opponentBackwardFrames++;
          }
        }
      }
      previousFrameAt = now();
      previous = { opponent, self };
      return true;
    };

    return { frame, report, socketId };
  });

  const ticket = (socketId: string): Ticket => {
    return {
      enqueuedAt: now(),
      mode: "duel",
      replicaId: "replica-test",
      shipVariant: "orbit-dart",
      socketId,
      userId: null,
    };
  };
  // The match draws its world seed from Math.random: pin it for a repeatable arena.
  const originalRandom = Math.random;
  Math.random = random;
  try {
    await duel.createMatch(SOCKET_IDS.map(ticket));
  } finally {
    Math.random = originalRandom;
  }
  const matchId = serverSnapshots[0].matchId;

  let frames = 0;
  setInterval(() => {
    let drawn = false;
    for (const pilot of pilots) {
      drawn = pilot.frame() || drawn;
    }
    if (drawn) frames++;
  }, FRAME_MS);

  // Run until the countdown is over and the match was active for `activeMs`.
  let activeSince: number | null = null;
  let endedEarly = false;
  for (let elapsed = 0; elapsed < 60_000; elapsed++) {
    timers.tick(1);
    if (activeSince === null && serverSnapshots[serverSnapshots.length - 1].phase === "active") {
      activeSince = now();
    }
    if (activeSince !== null && now() - activeSince >= options.activeMs) break;
    if (!duel.hasMatch(matchId)) {
      endedEarly = true;
      break;
    }
  }

  const active = serverSnapshots.filter((snapshot) => snapshot.phase === "active");
  pilots.forEach((pilot, index) => {
    for (let snapshot = 1; snapshot < active.length; snapshot++) {
      pilot.report.appliedPerSnapshot.push(
        active[snapshot].players[index].lastInputSeq -
          active[snapshot - 1].players[index].lastInputSeq,
      );
    }
  });

  const finalState = duel.snapshotFor(matchId)?.state as
    | { players: Array<{ state: RuntimePlayerState }> }
    | undefined;
  const serverPlayers: Record<string, RuntimePlayerState> = {};
  SOCKET_IDS.forEach((socketId, index) => {
    const state = finalState?.players[index]?.state;
    if (state !== undefined) serverPlayers[socketId] = state;
  });

  return {
    endedEarly,
    frames,
    pilots: Object.fromEntries(pilots.map((pilot) => [pilot.socketId, pilot.report])),
    serverPlayers,
    serverSnapshots,
  };
};

export const summarize = (values: number[], threshold: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return {
    count: values.length,
    max: at(1),
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    over: values.filter((value) => value > threshold).length,
    p95: at(0.95),
  };
};
