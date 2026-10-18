import p5 from "p5";
import { io, type Socket } from "socket.io-client";

import {
  addAmmoToWorld,
  addAsteroidToWorld,
  addHeartToWorld,
  applyWorldEvents,
  type BattleRoyaleEliminatedPayload,
  type BattleRoyaleLobbyPayload,
  type BattleRoyaleMatchEndedPayload,
  type BattleRoyaleMatchFoundPayload,
  type BattleRoyaleSnapshotPayload,
  BULLET_DIAMETER,
  type ClientToServerEvents,
  circleOverlapsShipCollider,
  circlesOverlap,
  createEmptyMatchWorld,
  createInitialBattleRoyaleWorld,
  createInitialMatchWorld,
  FIRE_COOLDOWN_TICKS,
  FixedStepClock,
  getAmmoPacketsInBounds,
  getAsteroidsInBounds,
  getHeartsInBounds,
  getMuzzleOffset,
  getNearbyAmmoPackets,
  getNearbyAsteroids,
  getNearbyHearts,
  getShipCollider,
  getShipCollisionBoundingDiameter,
  LOCAL_INPUT_PUSH_INTERVAL_MS,
  MATCH_COUNTDOWN_MS,
  type MatchBulletSnapshot,
  type MatchEndedPayload,
  type MatchEndReason,
  type MatchFoundPayload,
  type MatchmakingStatusPayload,
  type MatchOutcome,
  type MatchPlayerSnapshot,
  type MatchResumedPayload,
  type MatchSnapshotPayload,
  type MatchWorldEventsPayload,
  type MatchWorldRuntime,
  MULTIPLAYER_PROTOCOL_VERSION,
  type MultiplayerRuntimeConfig,
  PLAYER_DAMAGE_RECOVERY_TICKS,
  PLAYER_MAX_AMMO,
  PLAYER_MAX_HEALTH,
  type PlayerSlot,
  PROTOCOL_MISMATCH_ERROR,
  type RuntimePlayerState,
  removeAmmoFromWorld,
  removeAsteroidFromWorld,
  removeHeartFromWorld,
  resolveFireAngle,
  type ServerToClientEvents,
  type ShipCollider,
  type ShipInputState,
  type ShipVariant,
  SNAPSHOT_INTERVAL_TICKS,
  solveAimAngle,
  stepPlayerState,
  TICK_INTERVAL_MS,
  type WorldEvent,
} from "../../shared/src";
import { getOrCreateDeviceToken, recordLocalUnlock } from "./account";
import { playSound } from "./audio";
import { drawCollisionCircle, drawShipCollisionBox, isDebugToolsEnabled } from "./collisionDebug";
import { ExplosionSystem } from "./explosions";
import { type GameState, gameStateMachine, getGameState } from "./gameState";
import { showMultiplayerResult } from "./gameUiActions";
import { getHudHeartSize, getHudHeartTopLeft } from "./healthHud";
import {
  clearShipInput,
  getAimDirection,
  getAimPointer,
  isMobileDevice,
  isShipActionActive,
} from "./input";
import { createSimulatedLink } from "./netcode/delayLine";
import { replayPendingInputs } from "./netcode/reconcile";
import { sampleBullets, sampleRemotePlayers } from "./netcode/remoteEntities";
import { RenderSmoother } from "./netcode/renderSmoother";
import { ServerTimeline } from "./netcode/serverTimeline";
import { ShipDebrisSystem } from "./shipDebris";
import { assets } from "./sketch";
import { recordMultiplayerResult } from "./stats";
import { ThrusterExhaustSystem } from "./thruster";
import { trpcClient } from "./trpcClient";
import { type CameraBounds, createCameraBounds, getViewScale, height, width } from "./utils";
import {
  drawReticle,
  FRIENDLY_SHOT_PALETTE,
  HOSTILE_SHOT_PALETTE,
  type ImpactKind,
  WeaponEffectsSystem,
} from "./weaponEffects";

type MultiplayerStatus = "connecting" | "error" | "idle" | "matched" | "queueing";

type MultiplayerMatchMode = "duel" | "battle-royale";

interface ActiveMatchState {
  mode: MultiplayerMatchMode;
  arena: MatchFoundPayload["arena"];
  foundAt: number;
  matchId: string;
  maxHealth: number;
  /** For duel, the single opponent id. Null/empty for battle royale. */
  opponentId: string | null;
  /** All player ids in this match, including self. Used by BR rendering. */
  allPlayerIds: string[];
  playerId: string;
  /** Presented with matchId to re-attach after a reconnect or server handoff. */
  resumeToken: string;
  /** True while the client reconnects and re-attaches to the match. */
  migrating: boolean;
  /** True once the match was resumed at least once (changes countdown copy). */
  resumed: boolean;
  slot: PlayerSlot;
  snapshot: MatchSnapshotPayload | null;
  snapshotReceivedAt: number;
  world: MatchWorldRuntime;
  worldVersion: number;
  survivorsRemaining: number;
  /** Personal placement once eliminated, e.g. 5 = finished 5th. */
  placement: number | null;
}

interface BattleRoyaleLobbyState {
  phase: BattleRoyaleLobbyPayload["phase"];
  countdownMs: number;
  playerCount: number;
  minPlayers: number;
  maxPlayers: number;
}

interface MultiplayerViewState {
  errorMessage: string | null;
  match: ActiveMatchState | null;
  queuePosition: number;
  queueSize: number;
  status: MultiplayerStatus;
  battleRoyaleLobby: BattleRoyaleLobbyState | null;
}

/** How often a timer checks for due prediction ticks, besides every frame. */
const PREDICTION_PUMP_INTERVAL_MS = 8;
/** Prediction ticks run at once after the page stalls. Missed time beyond that is dropped. */
const MAX_PREDICTION_CATCH_UP_TICKS = 6;
/** How long the client keeps trying to resume before it gives the match up. */
const RESUME_DEADLINE_MS = 45_000;
const RESUME_RETRY_MS = 500;
const RESUME_COUNTDOWN_MS = 3000;
/** No snapshot for this long means the match owner is gone: try to resume. */
const SNAPSHOT_STALL_MS = 3000;
const RECONNECT_RETRY_MS = 400;
const SHIP_WIDTH = 60;
const SHIP_HEIGHT = 120;
const WORLD_CULL_PADDING = 220;
const HUD_EFFECT_BURST_FRAMES = 10;
const HUD_EFFECT_FLIGHT_FRAMES = 24;
const HUD_EFFECT_PARTICLE_COUNT = 4;
const SHIP_ARRIVAL_DURATION_MS = 780;
const SHIP_DESTRUCTION_DURATION_MS = 720;
/** The pointer counts as idle after this long without a move or a shot. */
const AIM_POINTER_IDLE_MS = 3500;
const AIM_GUIDE_LENGTH = 300;
/** How far out the touch stick's aim point sits. The distance does not change the shot. */
const AIM_STICK_REACH = 1000;
/** Aim angles go over the wire every tick while firing: three decimals keep them short. */
const AIM_ANGLE_PRECISION = 1000;
/** How far past its last snapshot a vanished bullet is traced to find what it hit. */
const BULLET_IMPACT_SCAN_TICKS = SNAPSHOT_INTERVAL_TICKS + 1;
/**
 * A server bullet of our own that shows up this soon after a predicted
 * shot already had its muzzle flash drawn.
 */
const LOCAL_SHOT_ECHO_MS = 600;
const RETICLE_BLOOM_MS = 170;
const HIT_MARKER_MS = 260;
const CAMERA_KICK_DECAY_MS = 70;
const CAMERA_KICK_SHOT = 3;
const CAMERA_KICK_DAMAGE = 11;

interface AmmoHudEffect {
  age: number;
  burstOffset: p5.Vector;
  scale: number;
  startScreenPos: p5.Vector;
}

interface PendingResultState {
  showAt: number;
  subtitle: string;
  title: string;
}

interface PlayerDestructionState {
  startedAt: number;
}

interface PlayerArrivalState {
  startedAt: number;
}

const createInitialViewState = (): MultiplayerViewState => {
  return {
    errorMessage: null,
    match: null,
    queuePosition: 0,
    queueSize: 0,
    status: "idle",
    battleRoyaleLobby: null,
  };
};

const getResultCopy = (
  outcome: MatchOutcome,
  reason: MatchEndReason,
): { subtitle: string; title: string } => {
  if (reason === "opponent-left") {
    if (outcome === "win") {
      return {
        subtitle: "The other pilot dropped from the field. Queue again to find another duel.",
        title: "Opponent forfeited",
      };
    }
    return {
      subtitle: "The battle ended early before a clean finish. Queue again when you are ready.",
      title: "Match ended early",
    };
  }

  if (reason === "server-restart") {
    return {
      subtitle: "The server restarted. This round did not count. Queue again for a new match.",
      title: "Match interrupted",
    };
  }

  if (reason === "inactive") {
    return {
      subtitle:
        "The match was closed after a minute without meaningful movement. Queue again when both players are ready.",
      title: "Match closed",
    };
  }

  if (outcome === "win") {
    return {
      subtitle: "The other ship broke apart first. Queue again to keep the streak moving.",
      title: "Victory secured",
    };
  }

  if (outcome === "loss") {
    return {
      subtitle:
        "Your hull gave out under the barrage. Queue again and try a new route through the field.",
      title: "Ship destroyed",
    };
  }

  return {
    subtitle: "Both ships were destroyed in the same exchange. Queue again for a cleaner finish.",
    title: "Mutual destruction",
  };
};

const formatPlacement = (placement: number): string => {
  const lastTwo = placement % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${placement}th`;
  }
  switch (placement % 10) {
    case 1:
      return `${placement}st`;
    case 2:
      return `${placement}nd`;
    case 3:
      return `${placement}rd`;
    default:
      return `${placement}th`;
  }
};

const _sameInputState = (left: ShipInputState, right: ShipInputState) => {
  return (
    left.fire === right.fire &&
    left.thrust === right.thrust &&
    left.turnLeft === right.turnLeft &&
    left.turnRight === right.turnRight
  );
};

const drawHeartOutline = (p: p5, x: number, y: number, size: number) => {
  p.push();
  p.translate(x, y);
  p.scale(size / 100);
  p.noFill();
  p.stroke(138, 149, 163, 220);
  p.strokeWeight(7);
  p.beginShape();
  p.vertex(50, 88);
  p.bezierVertex(14, 60, 8, 22, 30, 22);
  p.bezierVertex(43, 22, 50, 34, 50, 34);
  p.bezierVertex(50, 34, 57, 22, 70, 22);
  p.bezierVertex(92, 22, 86, 60, 50, 88);
  p.endShape();
  p.pop();
};

interface NetcodeDebugSample {
  bufferSize: number;
  dx: number;
  dy: number;
  inputQueueDepth: number;
  lastInputSeq: number;
  serverSequence: number;
  snapshotIntervalMs: number;
  timestamp: number;
}

const NETCODE_DEBUG_HISTORY = 120;

class MultiplayerClientSession {
  private aimCursorHidden = false;
  private ammoHudEffects: AmmoHudEffect[] = [];
  private cameraKick = { updatedAt: 0, x: 0, y: 0 };
  private collisionExplosions: ExplosionSystem | null = null;
  private debugHistory: NetcodeDebugSample[] = [];
  private hitMarkerAt = 0;
  private initialized = false;
  private inputPushIntervalMs = LOCAL_INPUT_PUSH_INTERVAL_MS;
  private isLeavingMode = false;
  private inputBuffer: Array<{ seq: number; input: ShipInputState }> = [];
  private inputSeqCounter = 0;
  private lastLocalShotAt = 0;
  private lastSentAt = 0;
  private lastSentInput: ShipInputState = {
    fire: false,
    inputSeq: 0,
    thrust: false,
    turnLeft: false,
    turnRight: false,
  };
  private localFireCooldownTicks = 0;
  private pendingResult: PendingResultState | null = null;
  /** Input sequences of predicted shots the server has not processed yet. */
  private pendingShotSeqs: number[] = [];
  private predictedSelf: RuntimePlayerState | null = null;
  private predictionTickTimer: ReturnType<typeof setInterval> | null = null;
  private p: p5 | null = null;
  private playerArrivals = new Map<string, PlayerArrivalState>();
  private playerDestructions = new Map<string, PlayerDestructionState>();
  private shipDebrisEffects: ShipDebrisSystem | null = null;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private resumeDeadline = 0;
  private resumeInFlight = false;
  private resumeTimeouts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private selfSmoother = new RenderSmoother();
  private simulatedLink = createSimulatedLink(isDebugToolsEnabled());
  private tickClock = new FixedStepClock(TICK_INTERVAL_MS, MAX_PREDICTION_CATCH_UP_TICKS);
  private timeline = new ServerTimeline<MatchSnapshotPayload>();
  private thrusters = new Map<string, ThrusterExhaustSystem>();
  private viewState = createInitialViewState();
  private weaponEffects: WeaponEffectsSystem | null = null;

  initialize(p: p5) {
    if (this.initialized) {
      return;
    }

    this.p = p;
    this.resetClientEffects();

    const isNetworkedMode = (scene: GameState["scene"]): boolean => {
      return (
        scene.type === "mode" && (scene.mode === "multiplayer" || scene.mode === "battle-royale")
      );
    };

    gameStateMachine.subscribe((state, previousState) => {
      const wasMultiplayerMode = isNetworkedMode(previousState.scene);
      const isMultiplayerMode = isNetworkedMode(state.scene);
      const modeChanged =
        state.scene.type === "mode" &&
        previousState.scene.type === "mode" &&
        state.scene.mode !== previousState.scene.mode;

      if (!wasMultiplayerMode && isMultiplayerMode) {
        this.enterMode();
        return;
      }

      if (wasMultiplayerMode && !isMultiplayerMode) {
        this.leaveMode();
        return;
      }

      // Transitioning directly between duel and battle-royale (or vice
      // versa) needs a full mode reset since each mode owns its own
      // queue/lobby state on the server.
      if (wasMultiplayerMode && isMultiplayerMode && modeChanged) {
        this.leaveMode();
        this.enterMode();
      }
    });

    this.initialized = true;
  }

  draw(p: p5) {
    if (this.flushPendingResultIfReady()) {
      return;
    }
    p.clear();
    this.setAimCursorHidden(this.isAimReticleVisible());

    const activeMatch = this.viewState.match;
    if (activeMatch === null) {
      this.drawBackdrop(p);
      this.drawQueueState(p);
      this.drawHint(p, "Esc: menu");
      return;
    }

    if (
      !activeMatch.migrating &&
      activeMatch.snapshot !== null &&
      performance.now() - activeMatch.snapshotReceivedAt > SNAPSHOT_STALL_MS
    ) {
      // The match owner went quiet (crash or handoff we did not hear about).
      this.beginMigration();
    }

    if (activeMatch.migrating) {
      if (activeMatch.snapshot !== null && activeMatch.snapshot.phase === "active") {
        this.drawMatchWorld(p, activeMatch);
      } else {
        this.drawBackdrop(p);
      }
      this.drawMatchFoundOverlay(p, activeMatch);
      this.drawHint(p, "Esc: menu");
      return;
    }

    if (activeMatch.snapshot === null || activeMatch.snapshot.phase === "countdown") {
      this.drawBackdrop(p);
      this.drawMatchFoundOverlay(p, activeMatch);
      this.drawHint(p, "Esc: menu");
      return;
    }

    this.drawMatchWorld(p, activeMatch);
    this.drawHint(p, "Click: fire at cursor  •  Space: fire ahead  •  Esc: menu");
  }

  private applyRuntimeConfig(runtimeConfig: MultiplayerRuntimeConfig) {
    this.inputPushIntervalMs = runtimeConfig.inputPushIntervalMs;
  }

  private async fetchRuntimeConfig() {
    try {
      const runtimeConfig = await trpcClient.multiplayer.runtime.query();
      this.applyRuntimeConfig(runtimeConfig);
    } catch (_error) {
      // The socket path is still the critical path. Keep a safe fallback if the
      // typed control plane is unavailable temporarily.
    }
  }

  private connectSocket() {
    if (this.socket !== null) {
      if (!this.socket.connected) {
        this.socket.connect();
      }
      return;
    }

    // WebSocket only: the polling transport needs sticky sessions, and
    // replicas behind a round-robin proxy do not share Engine.IO sessions.
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      autoConnect: false,
      auth: {
        deviceToken: getOrCreateDeviceToken(),
        protocol: MULTIPLAYER_PROTOCOL_VERSION,
      },
      reconnectionDelay: RECONNECT_RETRY_MS,
      reconnectionDelayMax: 2000,
      // A frozen replica can accept TCP but never answer: give up quickly
      // so the next attempt can reach another replica.
      timeout: 3000,
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      if (!this.isMultiplayerModeActive()) {
        return;
      }

      this.viewState.errorMessage = null;
      if (this.viewState.match !== null) {
        // Back on a (possibly different) server: re-attach to the match.
        this.beginMigration();
        return;
      }

      this.viewState.status = "queueing";
      void this.joinQueue();
    });

    socket.on("connect_error", (error) => {
      if (!this.isMultiplayerModeActive() || this.isLeavingMode) {
        return;
      }

      if (error.message === PROTOCOL_MISMATCH_ERROR) {
        // The server speaks another protocol version. Reconnecting cannot
        // fix that; only a reload loads the matching client.
        if (this.viewState.match !== null) {
          clearShipInput();
          this.resetViewState();
        }
        this.viewState.errorMessage = "The game was updated. Reload the page to play online.";
        this.viewState.status = "error";
        return;
      }

      if (!socket.active) {
        // Rejected by the server (for example a draining replica). Socket.IO
        // does not retry that on its own; the next attempt may reach another
        // replica.
        this.scheduleReconnect();
      }
      if (this.viewState.match !== null) {
        return;
      }

      this.viewState.errorMessage =
        "Unable to reach the matchmaking server. Start the server and try again.";
      this.viewState.status = "error";
    });

    socket.on("disconnect", (reason) => {
      if (!this.isMultiplayerModeActive() || this.isLeavingMode) {
        return;
      }

      if (reason === "io server disconnect") {
        // The server closed this socket (restart or handoff): reconnect.
        this.scheduleReconnect();
      }

      if (this.viewState.match !== null) {
        this.beginMigration();
        return;
      }

      this.viewState.errorMessage = "Reconnecting to the matchmaking server.";
      this.viewState.status = "connecting";
    });

    socket.on("server:draining", () => {
      if (!this.isMultiplayerModeActive()) return;
      if (this.viewState.match !== null) {
        this.beginMigration();
        return;
      }
      this.viewState.errorMessage = "Server restarting. Reconnecting.";
      this.viewState.status = "connecting";
    });

    socket.on("match:migrating", (payload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) return;
      if (payload.matchId !== this.viewState.match.matchId) return;
      this.beginMigration();
    });

    socket.on("match:resumed", (payload: MatchResumedPayload) => {
      this.applyResumedMatch(payload);
    });

    socket.on("matchmaking:status", (payload: MatchmakingStatusPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match !== null) {
        return;
      }

      this.viewState.errorMessage = null;
      this.viewState.match = null;
      this.viewState.queuePosition = payload.position;
      this.viewState.queueSize = payload.queueSize;
      this.viewState.status = "queueing";
    });

    // Server-side achievement unlocks (from MP/BR match results or
    // other server-authoritative sources) arrive here. The local
    // record keeps the UI in sync without a re-bootstrap.
    socket.on("achievement:unlocked", (payload) => {
      recordLocalUnlock(payload.achievementId, new Date(payload.unlockedAt));
    });

    socket.on("match:found", (payload: MatchFoundPayload) => {
      if (!this.isMultiplayerModeActive()) {
        return;
      }

      this.viewState.errorMessage = null;
      this.viewState.match = {
        mode: "duel",
        arena: payload.arena,
        foundAt: performance.now(),
        matchId: payload.matchId,
        maxHealth: payload.maxHealth,
        opponentId: payload.opponentId,
        allPlayerIds: [payload.playerId, payload.opponentId],
        playerId: payload.playerId,
        resumeToken: payload.resumeToken,
        migrating: false,
        resumed: false,
        slot: payload.slot,
        snapshot: null,
        snapshotReceivedAt: performance.now(),
        world: createInitialMatchWorld(payload.worldSeed, payload.arena),
        worldVersion: 0,
        survivorsRemaining: 2,
        placement: null,
      };
      this.viewState.queuePosition = 0;
      this.viewState.queueSize = 0;
      this.viewState.status = "matched";
      this.lastSentAt = 0;
      this.lastSentInput = {
        fire: false,
        inputSeq: 0,
        thrust: false,
        turnLeft: false,
        turnRight: false,
      };
      this.resetClientEffects();
    });

    socket.on("br:lobby", (payload: BattleRoyaleLobbyPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match !== null) return;
      if (this.getActiveModeMode() !== "battle-royale") return;
      this.viewState.battleRoyaleLobby = {
        phase: payload.phase,
        countdownMs: payload.countdownMs,
        playerCount: payload.playerCount,
        minPlayers: payload.minPlayers,
        maxPlayers: payload.maxPlayers,
      };
      this.viewState.status = "queueing";
    });

    socket.on("br:match-found", (payload: BattleRoyaleMatchFoundPayload) => {
      if (!this.isMultiplayerModeActive()) return;
      if (this.getActiveModeMode() !== "battle-royale") return;

      this.viewState.errorMessage = null;
      this.viewState.battleRoyaleLobby = null;
      this.viewState.match = {
        mode: "battle-royale",
        arena: payload.arena,
        foundAt: performance.now(),
        matchId: payload.matchId,
        maxHealth: payload.maxHealth,
        opponentId: null,
        allPlayerIds: payload.playerIds.slice(),
        playerId: payload.playerId,
        resumeToken: payload.resumeToken,
        migrating: false,
        resumed: false,
        // Slot is unused in BR but the field remains for duel
        // compatibility.
        slot: "alpha",
        snapshot: null,
        snapshotReceivedAt: performance.now(),
        world: createInitialBattleRoyaleWorld(
          payload.worldSeed,
          payload.playerIds.map((_, index) => {
            // The spawn ring is recomputed on the client to match the
            // server. This mirrors the createInitialBattleRoyaleWorld
            // input on the server.
            const total = payload.playerIds.length;
            const angle = (index / total) * Math.PI * 2;
            const arena = payload.arena;
            const safeH = arena.width / 2 - 280;
            const safeV = arena.height / 2 - 280;
            const radius = Math.min(safeH, safeV) * 0.82;
            return {
              x: Math.cos(angle) * radius,
              y: Math.sin(angle) * radius,
            };
          }),
          payload.arena,
        ),
        worldVersion: 0,
        survivorsRemaining: payload.playerIds.length,
        placement: null,
      };
      this.viewState.queuePosition = 0;
      this.viewState.queueSize = 0;
      this.viewState.status = "matched";
      this.lastSentAt = 0;
      this.lastSentInput = {
        fire: false,
        inputSeq: 0,
        thrust: false,
        turnLeft: false,
        turnRight: false,
      };
      this.resetClientEffects();
    });

    socket.on("br:snapshot", (payload: BattleRoyaleSnapshotPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (this.viewState.match.mode !== "battle-royale") return;
      if (payload.matchId !== this.viewState.match.matchId) return;
      if (this.viewState.match.migrating) return;

      const previousSnapshot = this.viewState.match.snapshot;
      if (previousSnapshot !== null && payload.sequence <= previousSnapshot.sequence) {
        return;
      }

      // Adapt the BR snapshot to the duel's MatchSnapshotPayload shape so
      // the render pipeline can be reused as-is.
      const adaptedSnapshot: MatchSnapshotPayload = {
        bullets: payload.bullets,
        countdownMs: payload.countdownMs,
        matchId: payload.matchId,
        phase: payload.phase,
        players: payload.players,
        sequence: payload.sequence,
      };

      if (previousSnapshot !== null) {
        this.playSnapshotEffects(previousSnapshot, adaptedSnapshot);
      }

      if (
        (previousSnapshot === null && payload.phase === "active") ||
        (previousSnapshot !== null &&
          previousSnapshot.phase === "countdown" &&
          payload.phase === "active")
      ) {
        this.triggerPlayerArrivals(payload.players);
      }

      const now = performance.now();
      this.viewState.match.snapshot = adaptedSnapshot;
      this.viewState.match.snapshotReceivedAt = now;
      this.timeline.observe(adaptedSnapshot.sequence, adaptedSnapshot, now);
      this.viewState.match.survivorsRemaining = payload.survivorsRemaining;
      this.viewState.status = "matched";

      if (payload.phase !== "active") {
        return;
      }

      const serverSelf = payload.players.find(
        (player) => player.id === this.viewState.match?.playerId,
      );
      if (serverSelf !== undefined) {
        const wasFirstActiveSnapshot = this.predictedSelf === null;
        this.reconcilePredictedSelf(serverSelf, this.viewState.match.arena);
        if (wasFirstActiveSnapshot) {
          this.startPredictionLoop();
        }
      }
    });

    socket.on("br:world-events", (payload: MatchWorldEventsPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (this.viewState.match.mode !== "battle-royale") return;
      if (payload.matchId !== this.viewState.match.matchId) return;
      if (this.viewState.match.migrating) return;
      if (payload.worldVersion <= this.viewState.match.worldVersion) return;

      this.playWorldEventEffects(this.viewState.match, payload.events);
      applyWorldEvents(this.viewState.match.world, payload.events, this.viewState.match.arena);
      this.viewState.match.worldVersion = payload.worldVersion;
    });

    socket.on("br:eliminated", (payload: BattleRoyaleEliminatedPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (payload.matchId !== this.viewState.match.matchId) return;
      if (payload.playerId !== this.viewState.match.playerId) return;
      this.viewState.match.placement = payload.placement;
    });

    socket.on("br:match-ended", (payload: BattleRoyaleMatchEndedPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (payload.matchId !== this.viewState.match.matchId) return;

      const placement = this.viewState.match.placement;
      clearShipInput();

      let title: string;
      let subtitle: string;
      if (payload.youWon) {
        title = "Victory Royale";
        subtitle = "Last ship standing. The arena is yours.";
      } else if (payload.reason === "server-restart") {
        title = "Match interrupted";
        subtitle = "The server restarted. This round did not count. Queue again for a new match.";
      } else if (payload.reason === "inactive") {
        title = "Match closed";
        subtitle =
          "The match ended after a long period of inactivity. Queue again to try another round.";
      } else if (placement !== null) {
        title = `Eliminated — ${formatPlacement(placement)} place`;
        subtitle = "Your ship was destroyed. Queue again to jump back into the next battle royale.";
      } else {
        title = "Battle over";
        subtitle = "The last ship standing claimed the match. Queue again for another try.";
      }

      if (payload.reason !== "server-restart") {
        recordMultiplayerResult(payload.youWon ? "win" : "loss");
      }
      this.resetViewState();
      showMultiplayerResult(title, subtitle);
    });

    socket.on("match:world-events", (payload: MatchWorldEventsPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (payload.matchId !== this.viewState.match.matchId || this.viewState.match.migrating) {
        return;
      }
      if (payload.worldVersion <= this.viewState.match.worldVersion) {
        return;
      }

      this.playWorldEventEffects(this.viewState.match, payload.events);
      applyWorldEvents(this.viewState.match.world, payload.events, this.viewState.match.arena);
      this.viewState.match.worldVersion = payload.worldVersion;
    });

    socket.on("match:snapshot", (payload: MatchSnapshotPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (payload.matchId !== this.viewState.match.matchId || this.viewState.match.migrating) {
        return;
      }

      const previousSnapshot = this.viewState.match.snapshot;

      // Reject stale or duplicate snapshots.
      if (previousSnapshot !== null && payload.sequence <= previousSnapshot.sequence) {
        return;
      }

      if (previousSnapshot !== null) {
        this.playSnapshotEffects(previousSnapshot, payload);
      }

      if (
        (previousSnapshot === null && payload.phase === "active") ||
        (previousSnapshot !== null &&
          previousSnapshot.phase === "countdown" &&
          payload.phase === "active")
      ) {
        this.triggerPlayerArrivals(payload.players);
      }

      const now = performance.now();
      const prevSnapshotReceivedAt = this.viewState.match.snapshotReceivedAt;

      this.viewState.match.snapshot = payload;
      this.viewState.match.snapshotReceivedAt = now;
      this.timeline.observe(payload.sequence, payload, now);
      this.viewState.status = "matched";

      // Only run prediction and reconciliation during the active phase.
      // During countdown the server does not step player physics, so
      // predicting locally would accumulate a buffer that can never be
      // correctly reconciled.
      if (payload.phase !== "active") {
        return;
      }

      const serverSelf = payload.players.find(
        (player) => player.id === this.viewState.match?.playerId,
      );
      if (serverSelf !== undefined) {
        const wasFirstActiveSnapshot = this.predictedSelf === null;
        const prevX = this.predictedSelf?.x ?? serverSelf.x;
        const prevY = this.predictedSelf?.y ?? serverSelf.y;

        this.reconcilePredictedSelf(serverSelf, this.viewState.match.arena);

        if (wasFirstActiveSnapshot) {
          this.startPredictionLoop();
        }

        if (getGameState().settings.netcodeDebugEnabled) {
          const snapshotInterval = previousSnapshot !== null ? now - prevSnapshotReceivedAt : 0;
          const playerDebug = payload.debug?.[this.viewState.match.playerId];
          this.debugHistory.push({
            bufferSize: this.inputBuffer.length,
            dx: this.predictedSelf!.x - prevX,
            dy: this.predictedSelf!.y - prevY,
            inputQueueDepth: playerDebug?.inputQueueDepth ?? -1,
            lastInputSeq: serverSelf.lastInputSeq,
            serverSequence: payload.sequence,
            snapshotIntervalMs: snapshotInterval,
            timestamp: now,
          });
          if (this.debugHistory.length > NETCODE_DEBUG_HISTORY) {
            this.debugHistory.shift();
          }
        }
      }
    });

    socket.on("match:ended", (payload: MatchEndedPayload) => {
      if (!this.isMultiplayerModeActive() || this.viewState.match === null) {
        return;
      }
      if (payload.matchId !== this.viewState.match.matchId) {
        return;
      }

      const resultCopy = getResultCopy(payload.outcome, payload.reason);
      if (payload.reason !== "server-restart") recordMultiplayerResult(payload.outcome);
      clearShipInput();

      if (payload.reason === "destroyed") {
        this.pendingResult = {
          showAt: performance.now() + SHIP_DESTRUCTION_DURATION_MS,
          subtitle: resultCopy.subtitle,
          title: resultCopy.title,
        };

        const latestSnapshot = this.viewState.match.snapshot;
        if (latestSnapshot !== null) {
          for (let i = 0; i < latestSnapshot.players.length; i++) {
            const player = latestSnapshot.players[i];
            if (payload.winnerId !== null && player.id === payload.winnerId) {
              continue;
            }

            this.createShipDestruction(player);
          }
        }
        return;
      }

      this.resetViewState();
      showMultiplayerResult(resultCopy.title, resultCopy.subtitle);
    });

    if (this.simulatedLink.up.active) {
      this.simulateSlowLink(socket);
    }

    this.socket = socket;
    socket.connect();
  }

  /**
   * Development only (`?debug=1&lag=60&jitter=20`): delay the inputs this
   * socket sends and everything it receives, to feel a real network on
   * one machine. `onevent` is where socket.io-client hands a received
   * event to its listeners; it is not part of the public API.
   */
  private simulateSlowLink(socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
    const { down, up } = this.simulatedLink;
    const raw = socket as unknown as {
      emit: (...args: unknown[]) => unknown;
      onevent: (packet: unknown) => void;
    };
    const emit = raw.emit.bind(socket);
    const onevent = raw.onevent.bind(socket);
    raw.emit = (...args) => {
      if (args[0] !== "match:input" && args[0] !== "br:input") {
        return emit(...args);
      }
      up.send(() => emit(...args));
      return socket;
    };
    raw.onevent = (packet) => {
      down.send(() => onevent(packet));
    };
  }

  private createCollisionExplosion(x: number, y: number, extraBursts = 0) {
    if (this.p === null) {
      return;
    }

    if (this.collisionExplosions === null) {
      this.collisionExplosions = new ExplosionSystem(this.p);
    }

    this.collisionExplosions.createExplosion(this.p.createVector(x, y));
    for (let i = 0; i < extraBursts; i++) {
      const offset = p5.Vector.fromAngle(this.p.random(0, this.p.TWO_PI), this.p.random(8, 24));
      const burstPos = this.p.createVector(x + offset.x, y + offset.y);
      this.collisionExplosions.createExplosion(burstPos);
    }
    playSound("explosion");
  }

  private createAmmoPickupEffect(
    worldX: number,
    worldY: number,
    cameraCenterX: number,
    cameraCenterY: number,
  ) {
    if (this.p === null) {
      return;
    }

    const startScreenPos = this.p.createVector(
      width / 2 + (worldX - cameraCenterX),
      height / 2 + (worldY - cameraCenterY),
    );

    for (let i = 0; i < HUD_EFFECT_PARTICLE_COUNT; i++) {
      const angle = (this.p.TWO_PI * i) / HUD_EFFECT_PARTICLE_COUNT + this.p.random(-0.2, 0.2);
      const burstDistance = this.p.random(18, 34);
      this.ammoHudEffects.push({
        age: this.p.random(3),
        burstOffset: p5.Vector.fromAngle(angle, burstDistance),
        scale: this.p.random(0.5, 0.72),
        startScreenPos: startScreenPos.copy(),
      });
    }
  }

  private createShipDestruction(player: MatchPlayerSnapshot) {
    if (this.playerDestructions.has(player.id)) {
      return;
    }

    const startedAt = performance.now();
    this.playerDestructions.set(player.id, { startedAt });
    this.createCollisionExplosion(player.x, player.y, 2);
    this.shipDebrisEffects?.createShipBreakup(player.x, player.y, player.angle, player.shipVariant);

    if (this.pendingResult !== null) {
      this.pendingResult.showAt = Math.max(
        this.pendingResult.showAt,
        startedAt + SHIP_DESTRUCTION_DURATION_MS,
      );
    }
  }

  private drawAmmoHudEffects(p: p5) {
    const target = this.getAmmoHudCenter();

    for (let i = this.ammoHudEffects.length - 1; i >= 0; i--) {
      const effect = this.ammoHudEffects[i];
      const totalFrames = HUD_EFFECT_BURST_FRAMES + HUD_EFFECT_FLIGHT_FRAMES;

      if (effect.age >= totalFrames) {
        this.ammoHudEffects.splice(i, 1);
        continue;
      }

      const burstProgress = Math.min(effect.age / HUD_EFFECT_BURST_FRAMES, 1);
      const easedBurst = 1 - (1 - burstProgress) * (1 - burstProgress);
      const burstPos = p5.Vector.add(
        effect.startScreenPos,
        p5.Vector.mult(effect.burstOffset, easedBurst),
      ).add(0, -8 * easedBurst);

      let drawX = burstPos.x;
      let drawY = burstPos.y;
      let drawSize = 20 * effect.scale;
      let drawAlpha = 230;

      if (effect.age >= HUD_EFFECT_BURST_FRAMES) {
        const flightProgress = (effect.age - HUD_EFFECT_BURST_FRAMES) / HUD_EFFECT_FLIGHT_FRAMES;
        const easedFlight = 1 - (1 - flightProgress) * (1 - flightProgress) * (1 - flightProgress);
        drawX = p.lerp(burstPos.x, target.x, easedFlight);
        drawY = p.lerp(burstPos.y, target.y, easedFlight);
        drawSize = p.lerp(20 * effect.scale, 16, easedFlight);
        drawAlpha = p.lerp(230, 215, easedFlight);
      }

      p.push();
      p.noStroke();
      p.fill(190, 233, 255, 34);
      p.circle(drawX, drawY, drawSize * 1.85);
      p.imageMode(p.CENTER);
      p.tint(255, drawAlpha);
      p.image(assets.ammoAsset, drawX, drawY, drawSize, drawSize);
      p.noTint();
      p.pop();

      effect.age++;
    }
  }

  private flushPendingResultIfReady() {
    if (
      this.pendingResult === null ||
      performance.now() < this.pendingResult.showAt ||
      !this.isMultiplayerModeActive()
    ) {
      return false;
    }

    const result = this.pendingResult;
    this.resetViewState();
    showMultiplayerResult(result.title, result.subtitle);
    return true;
  }

  private getAmmoHudCenter() {
    const panelWidth = Math.min(188, Math.max(154, width * 0.18));
    const panelHeight = 70;
    const panelX = width - panelWidth - 20;
    const panelY = 18;

    return {
      x: panelX + 34,
      y: panelY + panelHeight / 2,
    };
  }

  private drawAmmoCollectible(
    p: p5,
    ammoPacket: ReturnType<typeof getAmmoPacketsInBounds>[number],
    highlighted: boolean,
  ) {
    p.push();
    p.imageMode(p.CENTER);

    if (highlighted) {
      p.noStroke();
      p.fill(166, 233, 255, 42);
      p.circle(ammoPacket.x, ammoPacket.y, ammoPacket.size * 1.45);
    }

    p.noStroke();
    p.fill(218, 244, 255, 240);
    p.ellipse(ammoPacket.x, ammoPacket.y, ammoPacket.size, ammoPacket.size);
    p.image(
      assets.ammoAsset,
      ammoPacket.x,
      ammoPacket.y,
      ammoPacket.size / 1.5,
      ammoPacket.size / 1.5,
    );
    p.pop();
  }

  private drawAmmoHud(p: p5, ammo: number) {
    const panelWidth = Math.min(188, Math.max(154, width * 0.18));
    const panelHeight = 70;
    const panelX = width - panelWidth - 20;
    const panelY = 18;
    const isLowAmmo = ammo <= 3;
    const ammoCenter = this.getAmmoHudCenter();

    p.push();
    p.rectMode(p.CORNER);
    p.noStroke();
    p.fill(isLowAmmo ? 34 : 15, isLowAmmo ? 27 : 30, isLowAmmo ? 24 : 49, 220);
    p.rect(panelX, panelY, panelWidth, panelHeight, 18);
    p.stroke(isLowAmmo ? 255 : 103, isLowAmmo ? 172 : 201, isLowAmmo ? 128 : 242, 120);
    p.strokeWeight(1.2);
    p.noFill();
    p.rect(panelX, panelY, panelWidth, panelHeight, 18);

    p.imageMode(p.CENTER);
    p.noTint();
    p.image(assets.ammoAsset, ammoCenter.x, ammoCenter.y, 30, 30);

    p.noStroke();
    p.textAlign(p.LEFT, p.TOP);
    p.fill(194, 219, 235, 155);
    p.textSize(12);
    p.text("Ammo", panelX + 56, panelY + 12);

    p.fill(244, 249, 255);
    p.textSize(26);
    p.text(`${ammo} / ${PLAYER_MAX_AMMO}`, panelX + 56, panelY + 26);
    p.pop();
  }

  private drawAsteroid(
    p: p5,
    asteroid: ReturnType<typeof getAsteroidsInBounds>[number],
    predictedSequence: number,
  ) {
    const asteroidTexture = assets.asteroids[asteroid.variant] ?? assets.asteroids[0];

    p.push();
    p.imageMode(p.CENTER);
    p.translate(asteroid.x, asteroid.y);
    p.rotate(asteroid.baseRotation + predictedSequence * asteroid.spinSpeed);
    p.image(asteroidTexture, 0, 0, asteroid.size, asteroid.size);
    p.pop();
  }

  private drawBackdrop(p: p5, focusX = 0, focusY = 0) {
    const parallaxX = width / 2 - focusX * 0.025;
    const parallaxY = height / 2 - focusY * 0.025;

    p.push();
    p.imageMode(p.CENTER);
    p.tint(255, 36);
    p.image(assets.space, parallaxX, parallaxY, width * 1.34, height * 1.34);
    p.noTint();
    p.pop();
  }

  private drawCenterCard(p: p5, title: string, subtitle: string, cardHeight = 224) {
    const cardWidth = Math.min(540, width - 40);
    const cardX = width / 2 - cardWidth / 2;
    const cardY = height / 2 - cardHeight / 2;

    p.push();
    p.rectMode(p.CORNER);
    p.noStroke();
    p.fill(5, 14, 28, 228);
    p.rect(cardX, cardY, cardWidth, cardHeight, 24);
    p.stroke(116, 204, 245, 122);
    p.strokeWeight(1.4);
    p.noFill();
    p.rect(cardX, cardY, cardWidth, cardHeight, 24);

    p.noStroke();
    p.fill(241, 247, 252);
    p.textAlign(p.CENTER, p.CENTER);
    p.textSize(32);
    p.text(title, width / 2, cardY + 58);

    p.fill(196, 216, 231);
    p.textAlign(p.CENTER, p.TOP);
    p.textSize(16);
    p.textLeading(24);
    p.text(subtitle, cardX + 36, cardY + 102, cardWidth - 72, cardHeight - 132);
    p.pop();
  }

  private drawMatchFoundOverlay(p: p5, match: ActiveMatchState) {
    const totalCountdownMs = match.resumed ? RESUME_COUNTDOWN_MS : MATCH_COUNTDOWN_MS;
    const remainingCountdownMs = match.migrating
      ? Math.max(0, this.resumeDeadline - performance.now())
      : (match.snapshot?.countdownMs ??
        Math.max(0, MATCH_COUNTDOWN_MS - (performance.now() - match.foundAt)));
    const progress = match.migrating
      ? 1 - remainingCountdownMs / RESUME_DEADLINE_MS
      : 1 - remainingCountdownMs / totalCountdownMs;
    const copy = match.migrating
      ? {
          body: "The server is handing this match to another instance. Your ship is safe and the match resumes in a moment.",
          label: "Reconnecting",
          title: "Reconnecting to the arena",
        }
      : match.resumed
        ? {
            body: "Back in the arena. The match continues from where it paused.",
            label: "Resuming",
            title: "Match resuming",
          }
        : {
            body: "Get ready. Stabilizing the arena link and preparing both ships for launch.",
            label: "Launch sequence",
            title: "Another pilot found",
          };
    const countdownValue = Math.max(1, Math.min(3, Math.ceil(remainingCountdownMs / 1000)));
    const cardWidth = Math.min(560, width - 40);
    const cardHeight = 244;
    const cardX = width / 2 - cardWidth / 2;
    const cardY = height / 2 - cardHeight / 2;
    const barX = cardX + 48;
    const barY = cardY + 170;
    const barWidth = cardWidth - 96;
    const barHeight = 14;

    p.push();
    p.rectMode(p.CORNER);
    p.noStroke();
    p.fill(6, 13, 25, 170);
    p.rect(0, 0, width, height);

    p.fill(5, 14, 28, 234);
    p.rect(cardX, cardY, cardWidth, cardHeight, 24);
    p.stroke(116, 204, 245, 122);
    p.strokeWeight(1.4);
    p.noFill();
    p.rect(cardX, cardY, cardWidth, cardHeight, 24);

    p.noStroke();
    p.fill(241, 247, 252);
    p.textAlign(p.CENTER, p.CENTER);
    p.textSize(32);
    p.text(copy.title, width / 2, cardY + 58);

    p.fill(196, 216, 231);
    p.textAlign(p.CENTER, p.TOP);
    p.textSize(16);
    p.textLeading(24);
    p.text(copy.body, cardX + 36, cardY + 98, cardWidth - 72, 58);

    p.noStroke();
    p.fill(12, 28, 46, 220);
    p.rect(barX, barY, barWidth, barHeight, 999);
    p.fill(104, 197, 244, 220);
    p.rect(barX, barY, barWidth * Math.max(0, Math.min(1, progress)), barHeight, 999);

    p.fill(180, 207, 224, 188);
    p.textAlign(p.CENTER, p.TOP);
    p.textSize(13);
    p.text(
      match.migrating ? copy.label : `${copy.label} • ${countdownValue}`,
      width / 2,
      barY + 24,
    );
    p.pop();
  }

  private drawHeartCollectible(
    p: p5,
    heart: ReturnType<typeof getHeartsInBounds>[number],
    highlighted: boolean,
  ) {
    p.push();
    p.imageMode(p.CENTER);

    if (highlighted) {
      p.noStroke();
      p.fill(255, 196, 214, 48);
      p.circle(heart.x, heart.y, heart.size * 1.35);
    }

    p.noStroke();
    p.fill(255);
    p.ellipse(heart.x, heart.y, heart.size, heart.size);
    p.image(assets.heart, heart.x, heart.y, heart.size / 1.5, heart.size / 1.5);
    p.pop();
  }

  private drawHealthHud(
    p: p5,
    label: string,
    health: number,
    maxHealth: number,
    align: "left" | "right",
  ) {
    const heartSize = getHudHeartSize();
    const heartGap = heartSize * 0.08;
    const top = getHudHeartTopLeft(0).y;
    const labelY = Math.max(8, top - 18);

    p.push();
    if (label.trim().length > 0) {
      p.textSize(12);
      p.noStroke();
      p.fill(212, 224, 235, 178);

      if (align === "left") {
        p.textAlign(p.LEFT, p.TOP);
        p.text(label, getHudHeartTopLeft(0).x, labelY);
      } else {
        p.textAlign(p.RIGHT, p.TOP);
        p.text(label, width - getHudHeartTopLeft(0).x, labelY);
      }
    }

    for (let i = 0; i < maxHealth; i++) {
      const x =
        align === "left"
          ? getHudHeartTopLeft(i).x
          : width - getHudHeartTopLeft(0).x - heartSize - i * (heartSize + heartGap);

      if (i < health) {
        p.image(assets.heart, x, top, heartSize, heartSize);
        continue;
      }

      drawHeartOutline(p, x, top, heartSize);
    }

    p.pop();
  }

  private drawHint(p: p5, text: string) {
    if (isMobileDevice()) {
      return;
    }

    p.fill(200, 220, 232, 160);
    p.noStroke();
    p.textAlign(p.RIGHT, p.BOTTOM);
    p.textSize(13);
    p.text("Multiplayer mode", width - 24, height - 42);
    p.fill(170, 198, 214, 150);
    p.textSize(12);
    p.text(text, width - 24, height - 22);
  }

  private drawMatchWorld(p: p5, match: ActiveMatchState) {
    if (match.snapshot === null) {
      return;
    }

    const now = performance.now();
    this.pumpPrediction(now);

    // Everything remote is placed on the server's clock, not on the time
    // its packet happened to arrive: bullets at the current server tick,
    // ships slightly behind it, between two snapshots.
    const liveTick = this.timeline.liveTick(now);
    const predictedTicks = liveTick - match.snapshot.sequence;
    const renderedBullets = sampleBullets(match.snapshot, liveTick);

    const selfPlayer = this.getRenderedSelf(match, now);

    const timelineView = this.timeline.view(now);
    const opponentPlayers: MatchPlayerSnapshot[] =
      timelineView === null
        ? match.snapshot.players.filter((player) => player.id !== match.playerId)
        : sampleRemotePlayers(timelineView, match.playerId, match.arena);
    // For the duel-only radar HUD we still want a single reference
    // opponent. Pick the first alive one (fallback: first entry).
    const primaryOpponent =
      opponentPlayers.find((player) => player.health > 0) ?? opponentPlayers[0] ?? null;

    const renderedPlayers: MatchPlayerSnapshot[] = [];
    if (selfPlayer !== null) renderedPlayers.push(selfPlayer);
    renderedPlayers.push(...opponentPlayers);

    if (selfPlayer === null) {
      this.drawBackdrop(p);
      this.drawCenterCard(
        p,
        "Waiting for own ship",
        "The shared simulation is live, but the latest player snapshot has not arrived yet.",
      );
      return;
    }

    const cameraBounds = createCameraBounds(selfPlayer.x, selfPlayer.y, WORLD_CULL_PADDING);
    const cameraKick = this.updateCameraKick();
    const selfCollider = this.getPlayerCollider(selfPlayer);
    const visibleAsteroids = getAsteroidsInBounds(match.world, cameraBounds, match.arena);
    const visibleHearts = getHeartsInBounds(match.world, cameraBounds, match.arena);
    const visibleAmmoPackets = getAmmoPacketsInBounds(match.world, cameraBounds, match.arena);

    const collidingHeartIds = new Set(
      getNearbyHearts(
        match.world,
        selfPlayer.x,
        selfPlayer.y,
        getShipCollisionBoundingDiameter(selfPlayer.shipVariant),
        match.arena,
      )
        .filter((heart) => {
          return circleOverlapsShipCollider(heart.x, heart.y, heart.size, selfCollider);
        })
        .map((heart) => heart.id),
    );

    const collidingAmmoIds = new Set(
      getNearbyAmmoPackets(
        match.world,
        selfPlayer.x,
        selfPlayer.y,
        getShipCollisionBoundingDiameter(selfPlayer.shipVariant),
        match.arena,
      )
        .filter((ammoPacket) => {
          return circleOverlapsShipCollider(
            ammoPacket.x,
            ammoPacket.y,
            ammoPacket.size,
            selfCollider,
          );
        })
        .map((ammoPacket) => ammoPacket.id),
    );

    this.drawBackdrop(p, selfPlayer.x, selfPlayer.y);

    p.push();
    p.translate(width / 2 + cameraKick.x, height / 2 + cameraKick.y);
    const viewScale = getViewScale();
    if (viewScale !== 1) {
      p.scale(viewScale);
    }
    p.translate(-selfPlayer.x, -selfPlayer.y);
    this.drawWorldBorder(p, match.arena);

    for (let heartIndex = 0; heartIndex < visibleHearts.length; heartIndex++) {
      this.drawHeartCollectible(
        p,
        visibleHearts[heartIndex],
        collidingHeartIds.has(visibleHearts[heartIndex].id),
      );
    }

    for (let ammoPacketIndex = 0; ammoPacketIndex < visibleAmmoPackets.length; ammoPacketIndex++) {
      this.drawAmmoCollectible(
        p,
        visibleAmmoPackets[ammoPacketIndex],
        collidingAmmoIds.has(visibleAmmoPackets[ammoPacketIndex].id),
      );
    }

    this.collisionExplosions?.run(cameraBounds);
    this.shipDebrisEffects?.run(cameraBounds);

    for (let asteroidIndex = 0; asteroidIndex < visibleAsteroids.length; asteroidIndex++) {
      this.drawAsteroid(
        p,
        visibleAsteroids[asteroidIndex],
        match.snapshot.sequence + predictedTicks,
      );
    }

    this.drawThrusters(p, renderedPlayers, match.playerId);
    this.weaponEffects?.drawBolts(renderedBullets, match.playerId, cameraBounds);
    this.drawAimGuide(selfPlayer);

    this.drawPlayerArrivalPortals(p, renderedPlayers);

    for (let playerIndex = 0; playerIndex < renderedPlayers.length; playerIndex++) {
      this.drawShip(
        p,
        renderedPlayers[playerIndex],
        renderedPlayers[playerIndex].id === match.playerId,
      );
    }

    this.weaponEffects?.run(renderedPlayers, cameraBounds);

    if (getGameState().settings.collisionDebugEnabled && isDebugToolsEnabled()) {
      this.drawCollisionDebug(
        p,
        renderedPlayers,
        renderedBullets,
        visibleAsteroids,
        visibleHearts,
        visibleAmmoPackets,
      );
    }

    p.pop();

    this.drawHealthHud(p, "", selfPlayer.health, match.maxHealth, "left");
    this.drawAmmoHud(p, selfPlayer.ammo);
    this.drawAmmoHudEffects(p);
    this.drawRadarHud(
      p,
      selfPlayer,
      match.mode === "battle-royale" ? opponentPlayers : primaryOpponent,
      match.arena,
    );

    this.drawAimReticle(p, selfPlayer);

    if (getGameState().settings.netcodeDebugEnabled && isDebugToolsEnabled()) {
      this.drawNetcodeDebugOverlay(p, match);
    }
  }

  /**
   * The world position an aimed shot should travel toward, or null when the
   * shot goes straight ahead. A held mouse button aims at the cursor, the
   * touch stick aims along its direction, and the plain fire key does not
   * aim. `preview` also counts a cursor that moved lately without firing.
   */
  private resolveAimTarget(self: MatchPlayerSnapshot, preview: boolean) {
    const pointer = getAimPointer();
    if (pointer !== null && (pointer.firing || (preview && this.isAimPointerEngaged()))) {
      const viewScale = getViewScale();
      return {
        x: self.x + (pointer.x - width / 2) / viewScale,
        y: self.y + (pointer.y - height / 2) / viewScale,
      };
    }

    const direction = getAimDirection();
    if (direction !== null) {
      return {
        x: self.x + Math.cos(direction) * AIM_STICK_REACH,
        y: self.y + Math.sin(direction) * AIM_STICK_REACH,
      };
    }

    return null;
  }

  private isAimPointerEngaged() {
    const pointer = getAimPointer();
    return (
      pointer !== null &&
      (pointer.firing || performance.now() - pointer.movedAt < AIM_POINTER_IDLE_MS)
    );
  }

  /** True while the reticle stands in for the mouse cursor. */
  private isAimReticleVisible() {
    const match = this.viewState.match;
    return (
      match !== null &&
      !match.migrating &&
      match.snapshot !== null &&
      match.snapshot.phase === "active" &&
      this.pendingResult === null &&
      this.predictedSelf !== null &&
      this.predictedSelf.health > 0 &&
      getGameState().overlay === null &&
      getAimPointer() !== null
    );
  }

  private setAimCursorHidden(hidden: boolean) {
    if (this.aimCursorHidden === hidden) {
      return;
    }
    this.aimCursorHidden = hidden;
    document.body.classList.toggle("is-aiming", hidden);
  }

  private drawAimGuide(selfPlayer: MatchPlayerSnapshot) {
    if (selfPlayer.health <= 0 || getGameState().overlay !== null) {
      return;
    }

    // The fire key shoots straight ahead even while the cursor is on screen:
    // do not suggest otherwise.
    const firesAhead =
      isShipActionActive("fire") && getAimPointer()?.firing !== true && getAimDirection() === null;
    if (firesAhead) {
      return;
    }

    const target = this.resolveAimTarget(selfPlayer, true);
    const fireAngle = target === null ? null : solveAimAngle(selfPlayer, target.x, target.y);
    if (target === null || fireAngle === null) {
      return;
    }

    // The guide follows the bullet's path. That differs from the fire angle
    // while the ship moves, because the bullet keeps part of its velocity.
    const muzzleOffset = getMuzzleOffset(selfPlayer.angle, fireAngle);
    const muzzleX = selfPlayer.x + Math.cos(fireAngle) * muzzleOffset;
    const muzzleY = selfPlayer.y + Math.sin(fireAngle) * muzzleOffset;
    const reach = Math.hypot(target.x - muzzleX, target.y - muzzleY);
    this.weaponEffects?.drawAimGuide(
      muzzleX,
      muzzleY,
      Math.atan2(target.y - muzzleY, target.x - muzzleX),
      // Stop at the cursor so the guide never points past the target.
      Math.min(AIM_GUIDE_LENGTH, reach),
      selfPlayer.ammo > 0 ? 1 : 0.35,
    );
  }

  private drawAimReticle(p: p5, selfPlayer: MatchPlayerSnapshot) {
    const pointer = getAimPointer();
    if (pointer === null || !this.isAimReticleVisible()) {
      return;
    }

    const now = performance.now();
    drawReticle(p, {
      ammo: selfPlayer.ammo,
      bloom: Math.max(0, 1 - (now - this.lastLocalShotAt) / RETICLE_BLOOM_MS),
      hitFlash: Math.max(0, 1 - (now - this.hitMarkerAt) / HIT_MARKER_MS),
      idle: !this.isAimPointerEngaged(),
      x: pointer.x,
      y: pointer.y,
    });
  }

  /** Push the camera, for the punch of a shot or a hit. It eases back on its own. */
  private kickCamera(angle: number, strength: number) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    this.cameraKick.x += Math.cos(angle) * strength;
    this.cameraKick.y += Math.sin(angle) * strength;
  }

  private updateCameraKick() {
    const now = performance.now();
    const decay = Math.exp(-(now - this.cameraKick.updatedAt) / CAMERA_KICK_DECAY_MS);
    this.cameraKick.updatedAt = now;
    this.cameraKick.x *= decay;
    this.cameraKick.y *= decay;
    return this.cameraKick;
  }

  private isInView(x: number, y: number) {
    const self = this.predictedSelf;
    if (self === null) {
      return false;
    }
    const bounds: CameraBounds = createCameraBounds(self.x, self.y);
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }

  /** The local ship as drawn: the predicted ship, moved smoothly between ticks. */
  private getRenderedSelf(match: ActiveMatchState, now: number): MatchPlayerSnapshot | null {
    if (this.predictedSelf === null) {
      // Prediction has not started yet: show the server's ship.
      return match.snapshot?.players.find((player) => player.id === match.playerId) ?? null;
    }

    const pose = this.selfSmoother.poseAt(this.tickClock.alphaAt(now), now);
    return pose === null ? this.predictedSelf : { ...this.predictedSelf, ...pose };
  }

  private drawNetcodeDebugOverlay(p: p5, _match: ActiveMatchState) {
    const history = this.debugHistory;
    if (history.length === 0) {
      return;
    }

    const panelX = 10;
    const panelY = 10;
    const panelW = 340;
    const lineH = 15;
    const graphH = 50;
    const graphGap = 6;
    const latest = history[history.length - 1];

    // --- text stats ---
    const lines = [
      `Netcode debug  (${history.length} samples)`,
      `buffer size: ${latest.bufferSize}`,
      `recon dx: ${latest.dx.toFixed(2)}  dy: ${latest.dy.toFixed(2)}  dist: ${Math.hypot(latest.dx, latest.dy).toFixed(2)}`,
      `server seq: ${latest.serverSequence}  lastInputSeq: ${latest.lastInputSeq}`,
      `server queue depth: ${latest.inputQueueDepth === -1 ? "n/a" : latest.inputQueueDepth}`,
      `client inputSeq: ${this.inputSeqCounter}`,
      `snapshot interval: ${latest.snapshotIntervalMs.toFixed(1)} ms`,
      `input to confirmation: ${(latest.bufferSize * TICK_INTERVAL_MS).toFixed(0)} ms`,
      `remote ships drawn ${this.timeline.interpolationDelayMs.toFixed(0)} ms behind`,
    ];
    const textBlockH = lines.length * lineH + 4;

    // Three graphs: reconciliation distance, buffer size, queue depth
    const totalH = textBlockH + (graphH + graphGap) * 3 + 8;

    p.push();
    p.fill(0, 0, 0, 180);
    p.noStroke();
    p.rect(panelX, panelY, panelW, totalH, 4);

    p.fill(255);
    p.textSize(11);
    p.textFont("monospace");
    p.textAlign(p.LEFT, p.TOP);
    for (let i = 0; i < lines.length; i++) {
      p.text(lines[i], panelX + 8, panelY + 4 + i * lineH);
    }

    // --- helper to draw a mini graph ---
    const drawGraph = (
      yOffset: number,
      label: string,
      values: number[],
      color: [number, number, number],
      fixedMax?: number,
    ) => {
      const gx = panelX + 8;
      const gy = panelY + textBlockH + yOffset;
      const gw = panelW - 16;

      p.fill(20, 20, 30, 200);
      p.noStroke();
      p.rect(gx, gy, gw, graphH, 2);

      if (values.length < 2) {
        return;
      }

      const maxVal = fixedMax ?? Math.max(...values, 1);

      p.stroke(color[0], color[1], color[2], 220);
      p.strokeWeight(1.5);
      p.noFill();
      p.beginShape();
      for (let i = 0; i < values.length; i++) {
        const vx = gx + (i / (values.length - 1)) * gw;
        const vy = gy + graphH - (Math.min(values[i], maxVal) / maxVal) * (graphH - 4) - 2;
        p.vertex(vx, vy);
      }
      p.endShape();

      // Zero line
      p.stroke(255, 255, 255, 40);
      p.strokeWeight(0.5);
      const zeroY = gy + graphH - 2;
      p.line(gx, zeroY, gx + gw, zeroY);

      p.noStroke();
      p.fill(color[0], color[1], color[2], 200);
      p.textSize(9);
      p.text(`${label}  max: ${maxVal.toFixed(1)}`, gx + 4, gy + 2);
    };

    const reconDist = history.map((s) => Math.hypot(s.dx, s.dy));
    const bufferSizes = history.map((s) => s.bufferSize);
    const queueDepths = history.map((s) => Math.max(0, s.inputQueueDepth));

    drawGraph(0, "recon distance (px)", reconDist, [255, 100, 100]);
    drawGraph(graphH + graphGap, "input buffer size", bufferSizes, [100, 200, 255]);
    drawGraph((graphH + graphGap) * 2, "server queue depth", queueDepths, [100, 255, 140]);

    p.pop();
  }

  private drawQueueState(p: p5) {
    if (this.viewState.status === "error" && this.viewState.errorMessage !== null) {
      this.drawCenterCard(p, "Matchmaking offline", this.viewState.errorMessage);
      return;
    }

    if (this.viewState.status === "connecting") {
      this.drawCenterCard(
        p,
        "Connecting to matchmaking",
        "Reaching the battle server and preparing the multiplayer queue.",
      );
      return;
    }

    const mode = this.getActiveModeMode();
    if (mode === "battle-royale") {
      const lobby = this.viewState.battleRoyaleLobby;
      if (lobby === null) {
        this.drawCenterCard(
          p,
          "Joining Battle Royale lobby",
          "Connecting you to the next arena drop. Stand by.",
        );
        return;
      }

      if (lobby.playerCount < lobby.minPlayers) {
        const needed = lobby.minPlayers - lobby.playerCount;
        const plural = needed === 1 ? "pilot" : "pilots";
        this.drawCenterCard(
          p,
          "Waiting for more pilots",
          `${lobby.playerCount} in lobby. Need ${needed} more ${plural} before the match can launch. Up to ${lobby.maxPlayers} ships per arena.`,
        );
        return;
      }

      const seconds = Math.max(0, Math.ceil(lobby.countdownMs / 1000));
      this.drawCenterCard(
        p,
        `Battle Royale: ${lobby.playerCount}/${lobby.maxPlayers}`,
        `Dropping in ${seconds}s. Late arrivals can still join until the timer hits zero.`,
      );
      return;
    }

    const title = "Waiting for other player";
    const subtitle =
      this.viewState.queuePosition > 0
        ? `Queue ${this.viewState.queuePosition}/${this.viewState.queueSize}. Starting the duel as soon as another pilot joins.`
        : "Joining the multiplayer queue now. Starting the duel as soon as another pilot joins.";

    this.drawCenterCard(p, title, subtitle);
  }

  private drawRadarHud(
    p: p5,
    selfPlayer: MatchPlayerSnapshot,
    opponents: MatchPlayerSnapshot | MatchPlayerSnapshot[] | null,
    arena: MatchFoundPayload["arena"],
  ) {
    const opponentList: MatchPlayerSnapshot[] = Array.isArray(opponents)
      ? opponents
      : opponents !== null
        ? [opponents]
        : [];
    const panelWidth = Math.min(248, Math.max(208, width * 0.22));
    const panelPadding = 12;
    const mapWidth = panelWidth - panelPadding * 2;
    const mapHeight = mapWidth * (arena.height / arena.width);
    const panelHeight = mapHeight + panelPadding * 2;
    const panelX = width - panelWidth - 20;
    const panelY = 98;
    const mapX = panelX + panelPadding;
    const mapY = panelY + panelPadding;

    const toMapX = (worldX: number) => {
      return mapX + ((worldX + arena.width / 2) / arena.width) * mapWidth;
    };
    const toMapY = (worldY: number) => {
      return mapY + ((worldY + arena.height / 2) / arena.height) * mapHeight;
    };

    p.push();
    p.rectMode(p.CORNER);
    p.noStroke();
    p.fill(10, 23, 39, 220);
    p.rect(panelX, panelY, panelWidth, panelHeight, 18);
    p.stroke(103, 201, 242, 110);
    p.strokeWeight(1.2);
    p.noFill();
    p.rect(panelX, panelY, panelWidth, panelHeight, 18);

    p.fill(5, 15, 28, 205);
    p.rect(mapX, mapY, mapWidth, mapHeight, 14);
    p.stroke(103, 201, 242, 88);
    p.strokeWeight(1);
    p.noFill();
    p.rect(mapX, mapY, mapWidth, mapHeight, 14);

    const selfMapX = toMapX(selfPlayer.x);
    const selfMapY = toMapY(selfPlayer.y);
    p.noStroke();
    p.fill(121, 220, 255, 235);
    p.circle(selfMapX, selfMapY, 9);

    for (const opponent of opponentList) {
      const opponentMapX = toMapX(opponent.x);
      const opponentMapY = toMapY(opponent.y);
      p.noStroke();
      if (opponent.health <= 0) {
        p.fill(90, 100, 115, 140);
        p.circle(opponentMapX, opponentMapY, 6);
      } else {
        p.fill(255, 138, 90, 228);
        p.circle(opponentMapX, opponentMapY, 9);
      }
    }
    p.pop();
  }

  private drawShip(p: p5, player: MatchPlayerSnapshot, _isSelf: boolean) {
    const destruction = this.playerDestructions.get(player.id);
    const destructionProgress =
      destruction === undefined
        ? null
        : Math.min(1, (performance.now() - destruction.startedAt) / SHIP_DESTRUCTION_DURATION_MS);

    if (destructionProgress === 1) {
      return;
    }

    const baseRecoveryAlpha =
      player.damageRecoveryTicks > 0
        ? Math.floor(player.damageRecoveryTicks / 3) % 2 === 0
          ? 170
          : 105
        : 255;
    const recoveryAlpha =
      destructionProgress === null
        ? baseRecoveryAlpha
        : p.lerp(baseRecoveryAlpha, 0, destructionProgress);
    const arrivalProgress = this.getPlayerArrivalProgress(player.id);
    const arrivalReveal = arrivalProgress === null ? 1 : 1 - (1 - arrivalProgress) ** 3;
    const arrivalAlpha = arrivalProgress === null ? 255 : p.lerp(0, 255, arrivalReveal);
    const shipScale = destructionProgress === null ? 1 : p.lerp(1, 0.32, destructionProgress);
    const arrivalScale = arrivalProgress === null ? 1 : p.lerp(0.56, 1.04, arrivalReveal);

    p.push();
    p.translate(player.x, player.y);
    p.angleMode(p.RADIANS);
    p.rotate(player.angle);
    p.scale(shipScale * arrivalScale);
    p.imageMode(p.CENTER);
    p.rotate(p.PI / 2);
    p.tint(255, Math.min(recoveryAlpha, arrivalAlpha));
    p.image(this.getShipAsset(player.shipVariant), 0, 0, SHIP_WIDTH, SHIP_HEIGHT);
    p.noTint();
    p.pop();
  }

  private drawCollisionDebug(
    p: p5,
    players: MatchPlayerSnapshot[],
    bullets: MatchSnapshotPayload["bullets"],
    asteroids: ReturnType<typeof getAsteroidsInBounds>,
    hearts: ReturnType<typeof getHeartsInBounds>,
    ammoPackets: ReturnType<typeof getAmmoPacketsInBounds>,
  ) {
    for (let i = 0; i < asteroids.length; i++) {
      drawCollisionCircle(p, asteroids[i].x, asteroids[i].y, asteroids[i].size);
    }

    for (let i = 0; i < hearts.length; i++) {
      drawCollisionCircle(p, hearts[i].x, hearts[i].y, hearts[i].size);
    }

    for (let i = 0; i < ammoPackets.length; i++) {
      drawCollisionCircle(p, ammoPackets[i].x, ammoPackets[i].y, ammoPackets[i].size);
    }

    for (let i = 0; i < bullets.length; i++) {
      drawCollisionCircle(p, bullets[i].x, bullets[i].y, BULLET_DIAMETER);
    }

    for (let i = 0; i < players.length; i++) {
      drawShipCollisionBox(p, this.getPlayerCollider(players[i]));
    }
  }

  private getShipAsset(shipVariant: ShipVariant) {
    return assets.multiplayerShips[shipVariant] ?? assets.runShip;
  }

  private drawPlayerArrivalPortals(p: p5, players: MatchPlayerSnapshot[]) {
    for (let i = 0; i < players.length; i++) {
      const arrivalProgress = this.getPlayerArrivalProgress(players[i].id);
      if (arrivalProgress === null || arrivalProgress >= 1) {
        continue;
      }

      const easedProgress = 1 - (1 - arrivalProgress) ** 2;
      const portalSize = p.lerp(108, 42, easedProgress);
      const portalAlpha = p.lerp(210, 0, easedProgress);

      p.push();
      p.noStroke();
      p.fill(92, 214, 255, portalAlpha * 0.14);
      p.circle(players[i].x, players[i].y, portalSize * 1.2);
      p.fill(255, 255, 255, portalAlpha * 0.08);
      p.circle(players[i].x, players[i].y, portalSize * 0.68);
      p.noFill();
      p.stroke(92, 214, 255, portalAlpha);
      p.strokeWeight(2.4);
      p.circle(players[i].x, players[i].y, portalSize);
      p.stroke(214, 246, 255, portalAlpha * 0.7);
      p.strokeWeight(1.4);
      p.circle(players[i].x, players[i].y, portalSize * 0.76);
      p.pop();
    }

    this.prunePlayerArrivals();
  }

  private getPlayerCollider(player: MatchPlayerSnapshot): ShipCollider {
    return getShipCollider(player.x, player.y, player.angle, player.shipVariant);
  }

  private getPlayerArrivalProgress(playerId: string) {
    const arrival = this.playerArrivals.get(playerId);
    if (arrival === undefined) {
      return null;
    }

    return Math.min(1, (performance.now() - arrival.startedAt) / SHIP_ARRIVAL_DURATION_MS);
  }

  private prunePlayerArrivals() {
    this.playerArrivals.forEach((arrival, playerId) => {
      if (performance.now() - arrival.startedAt >= SHIP_ARRIVAL_DURATION_MS) {
        this.playerArrivals.delete(playerId);
      }
    });
  }

  private triggerPlayerArrivals(players: MatchPlayerSnapshot[]) {
    const startedAt = performance.now();
    for (let i = 0; i < players.length; i++) {
      this.playerArrivals.set(players[i].id, { startedAt });
    }
  }

  private drawThrusters(p: p5, players: MatchPlayerSnapshot[], localPlayerId: string) {
    const activePlayerIds = new Set<string>();

    for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
      const player = players[playerIndex];
      activePlayerIds.add(player.id);

      let thruster = this.thrusters.get(player.id);
      if (thruster === undefined) {
        thruster = new ThrusterExhaustSystem(
          p,
          p.createVector(player.x, player.y),
          player.angle - p.PI,
        );
        this.thrusters.set(player.id, thruster);
      }

      const exhaustPos = p5.Vector.add(
        p.createVector(player.x, player.y),
        p5.Vector.fromAngle(player.angle - p.PI, SHIP_WIDTH * 0.94),
      );
      thruster.updatePos(exhaustPos, player.angle - p.PI);

      if (player.thrusting) {
        thruster.fire(player.id === localPlayerId ? 8 : 5);
      }

      thruster.run();
    }

    Array.from(this.thrusters.keys()).forEach((playerId) => {
      if (!activePlayerIds.has(playerId)) {
        this.thrusters.delete(playerId);
      }
    });
  }

  private drawWorldBorder(p: p5, arena: MatchFoundPayload["arena"]) {
    p.push();
    p.rectMode(p.CORNER);
    p.noFill();
    p.stroke(255, 255, 255, 230);
    p.strokeWeight(1.5);
    p.rect(-arena.width / 2, -arena.height / 2, arena.width, arena.height);
    p.pop();
  }

  private enterMode() {
    this.resetViewState();
    this.viewState.status = "connecting";
    this.lastSentAt = 0;
    this.lastSentInput = {
      fire: false,
      inputSeq: 0,
      thrust: false,
      turnLeft: false,
      turnRight: false,
    };
    void this.fetchRuntimeConfig();
    this.connectSocket();
  }

  private isMultiplayerModeActive() {
    const state = getGameState();
    return (
      state.scene.type === "mode" &&
      (state.scene.mode === "multiplayer" || state.scene.mode === "battle-royale")
    );
  }

  private getActiveModeMode(): MultiplayerMatchMode | null {
    const state = getGameState();
    if (state.scene.type !== "mode") return null;
    if (state.scene.mode === "multiplayer") return "duel";
    if (state.scene.mode === "battle-royale") return "battle-royale";
    return null;
  }

  private async joinQueue() {
    const socket = this.socket;
    if (socket === null) return;
    try {
      const state = getGameState();
      const mode = this.getActiveModeMode() ?? "duel";
      const result = await socket.timeout(5000).emitWithAck("queue:join", {
        mode,
        shipVariant: state.settings.shipVariant,
      });
      if (result.enqueued || result.reason === "already-in-match") {
        return;
      }
      if (result.reason === "server-draining") {
        // This replica is shutting down; it will close the socket and the
        // reconnect lands on a live replica.
        return;
      }
      throw new Error(result.reason);
    } catch (_error) {
      if (!this.isMultiplayerModeActive() || this.viewState.match !== null) {
        return;
      }

      this.viewState.errorMessage = "Unable to enter matchmaking. Try again in a moment.";
      this.viewState.status = "error";
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket === null || this.socket.connected || this.isLeavingMode) return;
      if (!this.isMultiplayerModeActive()) return;
      this.socket.connect();
    }, RECONNECT_RETRY_MS);
  }

  /**
   * Freeze the match and keep asking the server to re-attach us with the
   * resume token until it succeeds, the match is gone, or time runs out.
   */
  private beginMigration() {
    const match = this.viewState.match;
    if (match === null) return;
    if (!match.migrating) {
      match.migrating = true;
      this.resumeDeadline = performance.now() + RESUME_DEADLINE_MS;
      this.stopPredictionLoop();
    }
    if (this.resumeTimer === null) {
      this.resumeTimer = setInterval(() => {
        void this.tryResume();
      }, RESUME_RETRY_MS);
    }
    void this.tryResume();
  }

  private async tryResume() {
    const match = this.viewState.match;
    if (match === null || !match.migrating) {
      this.stopResumeLoop();
      return;
    }
    if (performance.now() > this.resumeDeadline) {
      this.abandonMatch("lost");
      return;
    }
    const socket = this.socket;
    if (socket === null || !socket.connected || this.resumeInFlight) return;

    this.resumeInFlight = true;
    try {
      const result = await socket.timeout(2000).emitWithAck("match:resume", {
        matchId: match.matchId,
        resumeToken: match.resumeToken,
      });
      if (this.viewState.match !== match) return;
      if (result.status === "ended") {
        this.abandonMatch("ended");
      } else if (result.status === "unknown") {
        this.abandonMatch("lost");
      }
      // "resumed": match:resumed carries the state. "pending": retry.
      this.resumeTimeouts = 0;
    } catch (_error) {
      // Ack timed out. The server holding this socket may be frozen or
      // gone without closing it: after two misses, open a new connection,
      // which can land on another replica.
      this.resumeTimeouts++;
      if (this.resumeTimeouts >= 2) {
        this.resumeTimeouts = 0;
        socket.disconnect();
        this.scheduleReconnect();
      }
    } finally {
      this.resumeInFlight = false;
    }
  }

  private stopResumeLoop() {
    if (this.resumeTimer !== null) {
      clearInterval(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private abandonMatch(kind: "ended" | "lost") {
    this.stopResumeLoop();
    clearShipInput();
    this.resetViewState();
    if (kind === "ended") {
      showMultiplayerResult(
        "Match over",
        "The match ended while you were reconnecting. Queue again for a new match.",
      );
      return;
    }
    showMultiplayerResult(
      "Match interrupted",
      "The connection to the match was lost and it could not be resumed. This round did not count. Queue again for a new match.",
    );
  }

  /** Replace local match state with the server's after a re-attach. */
  private applyResumedMatch(payload: MatchResumedPayload) {
    const match = this.viewState.match;
    if (!this.isMultiplayerModeActive() || match === null) return;
    if (payload.matchId !== match.matchId) return;

    const world = createEmptyMatchWorld();
    for (const asteroid of payload.world.asteroids)
      addAsteroidToWorld(world, asteroid, payload.arena);
    for (const heart of payload.world.hearts) addHeartToWorld(world, heart, payload.arena);
    for (const ammo of payload.world.ammo) addAmmoToWorld(world, ammo, payload.arena);

    this.stopResumeLoop();
    this.stopPredictionLoop();
    // Keep the input sequence counter: the server compares it with the
    // last input it applied before the handoff.
    this.predictedSelf = null;
    this.inputBuffer = [];
    this.pendingShotSeqs = [];
    this.localFireCooldownTicks = 0;
    this.weaponEffects?.forgetAllBullets();
    this.selfSmoother.reset();
    this.timeline.reset();

    match.world = world;
    match.worldVersion = payload.world.worldVersion;
    match.snapshot = payload.snapshot;
    match.snapshotReceivedAt = performance.now();
    this.timeline.observe(payload.snapshot.sequence, payload.snapshot, match.snapshotReceivedAt);
    match.survivorsRemaining = payload.survivorsRemaining;
    match.placement = payload.placement ?? match.placement;
    match.migrating = false;
    match.resumed = true;
    this.viewState.status = "matched";

    if (payload.snapshot.phase === "active") {
      const serverSelf = payload.snapshot.players.find((player) => player.id === match.playerId);
      if (serverSelf !== undefined) {
        this.reconcilePredictedSelf(serverSelf, match.arena);
        this.startPredictionLoop();
      }
    }
  }

  private leaveMode() {
    this.isLeavingMode = true;
    clearShipInput();
    this.setAimCursorHidden(false);

    if (this.socket !== null) {
      if (this.socket.connected) {
        // Leaving on purpose: drop the queue ticket or forfeit the match
        // now instead of holding the seat for the reconnect grace period.
        this.socket.emit("queue:leave", () => {});
      }
      this.socket.disconnect();
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.resetViewState();
    this.lastSentAt = 0;
    this.lastSentInput = {
      fire: false,
      inputSeq: 0,
      thrust: false,
      turnLeft: false,
      turnRight: false,
    };
    this.isLeavingMode = false;
  }

  private playSnapshotEffects(
    previousSnapshot: MatchSnapshotPayload,
    nextSnapshot: MatchSnapshotPayload,
  ) {
    const previousPlayers = new Map<string, MatchPlayerSnapshot>();
    for (let i = 0; i < previousSnapshot.players.length; i++) {
      const player = previousSnapshot.players[i];
      previousPlayers.set(player.id, player);
    }

    for (let i = 0; i < nextSnapshot.players.length; i++) {
      const nextPlayer = nextSnapshot.players[i];
      const previousPlayer = previousPlayers.get(nextPlayer.id);

      if (nextPlayer.health > 0) {
        this.playerDestructions.delete(nextPlayer.id);
      }

      const isLocalPlayer =
        this.viewState.match !== null && nextPlayer.id === this.viewState.match.playerId;
      if (
        isLocalPlayer &&
        previousPlayer !== undefined &&
        nextPlayer.health < previousPlayer.health
      ) {
        this.kickCamera(Math.random() * Math.PI * 2, CAMERA_KICK_DAMAGE);
        if (nextPlayer.health > 0) {
          playSound("playerHit");
        }
      }

      if (
        previousPlayer === undefined ||
        nextPlayer.health >= previousPlayer.health ||
        nextPlayer.health > 0
      ) {
        continue;
      }

      if (isLocalPlayer) {
        playSound("playerDeath");
      }
      this.createShipDestruction(nextPlayer);
    }

    this.playBulletEffects(previousSnapshot, nextSnapshot);
  }

  /** Muzzle flashes for bullets that appeared, impacts for bullets that are gone. */
  private playBulletEffects(
    previousSnapshot: MatchSnapshotPayload,
    nextSnapshot: MatchSnapshotPayload,
  ) {
    const match = this.viewState.match;
    const effects = this.weaponEffects;
    if (match === null || effects === null) {
      return;
    }

    const previousBulletIds = new Set<string>();
    for (let i = 0; i < previousSnapshot.bullets.length; i++) {
      previousBulletIds.add(previousSnapshot.bullets[i].id);
    }

    const nextBulletIds = new Set<string>();
    for (let i = 0; i < nextSnapshot.bullets.length; i++) {
      const bullet = nextSnapshot.bullets[i];
      nextBulletIds.add(bullet.id);
      if (previousBulletIds.has(bullet.id)) {
        continue;
      }

      effects.trackBullet(bullet);
      const isLocalBullet = bullet.ownerId === match.playerId;
      if (isLocalBullet && performance.now() - this.lastLocalShotAt < LOCAL_SHOT_ECHO_MS) {
        continue;
      }

      effects.addMuzzleFlash(
        bullet.ownerId,
        bullet.x,
        bullet.y,
        Math.atan2(bullet.vy, bullet.vx),
        isLocalBullet ? FRIENDLY_SHOT_PALETTE : HOSTILE_SHOT_PALETTE,
      );
      if (this.isInView(bullet.x, bullet.y)) {
        playSound("shoot");
      }
    }

    for (let i = 0; i < previousSnapshot.bullets.length; i++) {
      const bullet = previousSnapshot.bullets[i];
      if (nextBulletIds.has(bullet.id)) {
        continue;
      }

      effects.forgetBullet(bullet.id);
      const impact = this.resolveBulletImpact(bullet, match, previousSnapshot.players);
      const isLocalBullet = bullet.ownerId === match.playerId;
      effects.addImpact(
        impact.x,
        impact.y,
        Math.atan2(bullet.vy, bullet.vx),
        isLocalBullet ? FRIENDLY_SHOT_PALETTE : HOSTILE_SHOT_PALETTE,
        impact.kind,
      );
      if (impact.kind === "ship" && isLocalBullet) {
        this.hitMarkerAt = performance.now();
      }
      if (impact.kind !== "fade" && this.isInView(impact.x, impact.y)) {
        playSound("bulletHit");
      }
    }
  }

  /**
   * Snapshots only say that a bullet is gone, not why. Trace it along its
   * path for the ticks since its last snapshot to find what it ran into.
   */
  private resolveBulletImpact(
    bullet: MatchBulletSnapshot,
    match: ActiveMatchState,
    players: MatchPlayerSnapshot[],
  ): { kind: ImpactKind; x: number; y: number } {
    const xLimit = match.arena.width / 2;
    const yLimit = match.arena.height / 2;

    for (let step = 0; step <= BULLET_IMPACT_SCAN_TICKS * 2; step++) {
      const ticks = step / 2;
      const x = bullet.x + bullet.vx * ticks;
      const y = bullet.y + bullet.vy * ticks;

      if (Math.abs(x) > xLimit || Math.abs(y) > yLimit) {
        return {
          kind: "edge",
          x: Math.max(-xLimit, Math.min(xLimit, x)),
          y: Math.max(-yLimit, Math.min(yLimit, y)),
        };
      }

      const nearbyAsteroids = getNearbyAsteroids(match.world, x, y, BULLET_DIAMETER, match.arena);
      for (let i = 0; i < nearbyAsteroids.length; i++) {
        const asteroid = nearbyAsteroids[i];
        if (circlesOverlap(x, y, BULLET_DIAMETER, asteroid.x, asteroid.y, asteroid.size)) {
          return { kind: "asteroid", x, y };
        }
      }

      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        // Same exemptions as the server: no self hits, and ships that are
        // dead or still recovering from a hit let bullets through.
        if (player.id === bullet.ownerId || player.health <= 0 || player.damageRecoveryTicks > 0) {
          continue;
        }
        const collider = getShipCollider(
          player.x + player.vx * ticks,
          player.y + player.vy * ticks,
          player.angle,
          player.shipVariant,
        );
        if (circleOverlapsShipCollider(x, y, BULLET_DIAMETER, collider)) {
          return { kind: "ship", x, y };
        }
      }
    }

    return { kind: "fade", x: bullet.x + bullet.vx, y: bullet.y + bullet.vy };
  }

  private playWorldEventEffects(match: ActiveMatchState, events: WorldEvent[]) {
    const localPlayer =
      match.snapshot?.players.find((player) => player.id === match.playerId) ?? null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.type === "asteroid-removed") {
        const asteroid = match.world.asteroids.get(event.asteroidId);
        if (asteroid !== undefined) {
          this.createCollisionExplosion(asteroid.x, asteroid.y);
        }
        continue;
      }

      if (event.type === "heart-removed" && localPlayer !== null) {
        const heart = match.world.hearts.get(event.heartId);
        if (
          heart !== undefined &&
          circleOverlapsShipCollider(
            heart.x,
            heart.y,
            heart.size,
            this.getPlayerCollider(localPlayer),
          )
        ) {
          playSound("heartPickup");
        }
        continue;
      }

      if (
        event.type === "ammo-removed" &&
        localPlayer !== null &&
        localPlayer.ammo < PLAYER_MAX_AMMO
      ) {
        const ammoPacket = match.world.ammunitionPackets.get(event.ammoId);
        if (
          ammoPacket !== undefined &&
          circleOverlapsShipCollider(
            ammoPacket.x,
            ammoPacket.y,
            ammoPacket.size,
            this.getPlayerCollider(localPlayer),
          )
        ) {
          this.createAmmoPickupEffect(ammoPacket.x, ammoPacket.y, localPlayer.x, localPlayer.y);
          playSound("ammoPickup");
        }
      }
    }
  }

  private reconcilePredictedSelf(
    serverState: MatchPlayerSnapshot,
    arena: ActiveMatchState["arena"],
  ) {
    // Accept the authoritative state, then replay the inputs the server
    // has not consumed yet. The server steps the ship once per input, so
    // this lands on the ship already predicted, unless something happened
    // that the client could not foresee, such as a collision.
    const reconciled = replayPendingInputs(serverState, this.inputBuffer, arena);
    this.predictedSelf = reconciled.state;
    this.inputBuffer = reconciled.pending;

    // The server's ammo count does not include shots it has not seen yet.
    this.pendingShotSeqs = this.pendingShotSeqs.filter((seq) => seq > serverState.lastInputSeq);
    this.predictedSelf.ammo = Math.max(0, serverState.ammo - this.pendingShotSeqs.length);

    // Whatever the correction, the drawn ship does not jump: the smoother
    // keeps it where it was and blends the difference out.
    const now = performance.now();
    this.selfSmoother.rebase(
      reconciled.beforeLastStep,
      reconciled.state,
      this.tickClock.alphaAt(now),
      now,
    );
  }

  private predictionTick() {
    const match = this.viewState.match;
    if (match === null || this.predictedSelf === null) {
      return;
    }

    if (this.predictedSelf.health <= 0) {
      return;
    }

    const state = getGameState();
    const seq = ++this.inputSeqCounter;
    const currentInput: ShipInputState =
      state.overlay === null
        ? {
            fire: isShipActionActive("fire") || getAimPointer()?.firing === true,
            inputSeq: seq,
            thrust: isShipActionActive("thrust"),
            turnLeft: isShipActionActive("turnLeft"),
            turnRight: isShipActionActive("turnRight"),
          }
        : {
            fire: false,
            inputSeq: seq,
            thrust: false,
            turnLeft: false,
            turnRight: false,
          };
    if (currentInput.fire) {
      const target = this.resolveAimTarget(this.predictedSelf, false);
      const aimAngle =
        target === null ? null : solveAimAngle(this.predictedSelf, target.x, target.y);
      if (aimAngle !== null) {
        currentInput.aimAngle = Math.round(aimAngle * AIM_ANGLE_PRECISION) / AIM_ANGLE_PRECISION;
      }
    }

    // Buffer for reconciliation replay
    this.inputBuffer.push({ seq, input: currentInput });
    if (this.inputBuffer.length > 180) {
      this.inputBuffer.shift();
    }

    // Step local prediction
    stepPlayerState(this.predictedSelf, currentInput, match.arena);
    this.predictLocalShot(currentInput);

    // Optimistic pickup collection — detect overlap using the same
    // collision logic as the server so hearts and ammo disappear and
    // update the HUD immediately instead of waiting for the next
    // server snapshot.  The server remains authoritative; reconciliation
    // overwrites predictedSelf.health/ammo with the server value.
    const selfCollider = getShipCollider(
      this.predictedSelf.x,
      this.predictedSelf.y,
      this.predictedSelf.angle,
      this.predictedSelf.shipVariant,
    );
    const broadDiameter = getShipCollisionBoundingDiameter(this.predictedSelf.shipVariant);

    if (this.predictedSelf.health < match.maxHealth) {
      const nearbyHearts = getNearbyHearts(
        match.world,
        this.predictedSelf.x,
        this.predictedSelf.y,
        broadDiameter,
        match.arena,
      );
      for (let i = 0; i < nearbyHearts.length; i++) {
        const heart = nearbyHearts[i];
        if (circleOverlapsShipCollider(heart.x, heart.y, heart.size, selfCollider)) {
          this.predictedSelf.health = Math.min(PLAYER_MAX_HEALTH, this.predictedSelf.health + 1);
          removeHeartFromWorld(match.world, heart.id, match.arena);
          break;
        }
      }
    }

    if (this.predictedSelf.ammo < PLAYER_MAX_AMMO) {
      const nearbyAmmo = getNearbyAmmoPackets(
        match.world,
        this.predictedSelf.x,
        this.predictedSelf.y,
        broadDiameter,
        match.arena,
      );
      for (let i = 0; i < nearbyAmmo.length; i++) {
        const ammoPacket = nearbyAmmo[i];
        if (circleOverlapsShipCollider(ammoPacket.x, ammoPacket.y, ammoPacket.size, selfCollider)) {
          this.predictedSelf.ammo = Math.min(
            PLAYER_MAX_AMMO,
            this.predictedSelf.ammo + ammoPacket.amount,
          );
          removeAmmoFromWorld(match.world, ammoPacket.id, match.arena);
          break;
        }
      }
    }

    if (this.predictedSelf.damageRecoveryTicks === 0) {
      const nearbyAsteroids = getNearbyAsteroids(
        match.world,
        this.predictedSelf.x,
        this.predictedSelf.y,
        broadDiameter,
        match.arena,
      );
      for (let i = 0; i < nearbyAsteroids.length; i++) {
        const asteroid = nearbyAsteroids[i];
        if (circleOverlapsShipCollider(asteroid.x, asteroid.y, asteroid.size, selfCollider)) {
          this.predictedSelf.health = Math.max(0, this.predictedSelf.health - 1);
          this.predictedSelf.damageRecoveryTicks = PLAYER_DAMAGE_RECOVERY_TICKS;
          removeAsteroidFromWorld(match.world, asteroid.id, match.arena);
          break;
        }
      }
    }

    // Send every tick's input so the server can process them
    // one-per-tick from its input queue.  This 1-to-1 mapping between
    // client ticks and server physics steps is what makes reconciliation
    // produce the same result as local prediction, eliminating jitter.
    if (this.socket?.connected) {
      if (match.mode === "battle-royale") {
        this.socket.emit("br:input", currentInput);
      } else {
        this.socket.emit("match:input", currentInput);
      }
    }
  }

  /**
   * Mirror the server's fire rule so the muzzle flash, the sound and the
   * ammo count answer the trigger at once, not one round trip later. The
   * bullet itself still comes from the server.
   */
  private predictLocalShot(input: ShipInputState) {
    const self = this.predictedSelf;
    if (self === null) {
      return;
    }

    if (this.localFireCooldownTicks > 0) {
      this.localFireCooldownTicks--;
    }
    if (!input.fire || this.localFireCooldownTicks > 0 || self.ammo <= 0 || self.health <= 0) {
      return;
    }

    this.localFireCooldownTicks = FIRE_COOLDOWN_TICKS;
    self.ammo--;
    this.pendingShotSeqs.push(input.inputSeq);
    this.lastLocalShotAt = performance.now();

    const fireAngle = resolveFireAngle(self, input);
    const muzzleOffset = getMuzzleOffset(self.angle, fireAngle);
    this.weaponEffects?.addMuzzleFlash(
      self.id,
      self.x + Math.cos(fireAngle) * muzzleOffset,
      self.y + Math.sin(fireAngle) * muzzleOffset,
      fireAngle,
      FRIENDLY_SHOT_PALETTE,
    );
    this.kickCamera(fireAngle + Math.PI, CAMERA_KICK_SHOT);
    playSound("shoot");
  }

  /**
   * Run every prediction tick that is due. The count comes from elapsed
   * time, so the client ticks at the server's rate whatever the timer or
   * display does.
   */
  private pumpPrediction(now = performance.now()) {
    if (this.predictionTickTimer === null) {
      return;
    }

    const dueTicks = this.tickClock.advance(now);
    for (let tick = 0; tick < dueTicks; tick++) {
      this.predictionTick();
      if (this.predictedSelf !== null) {
        this.selfSmoother.advance(this.predictedSelf);
      }
    }
  }

  private startPredictionLoop() {
    this.stopPredictionLoop();
    this.tickClock.reset(performance.now());
    // The timer keeps inputs flowing while the display is slow or hidden.
    // The draw loop pumps too, so a due tick runs right before its frame.
    this.predictionTickTimer = setInterval(() => {
      this.pumpPrediction();
    }, PREDICTION_PUMP_INTERVAL_MS);
  }

  private stopPredictionLoop() {
    if (this.predictionTickTimer !== null) {
      clearInterval(this.predictionTickTimer);
      this.predictionTickTimer = null;
    }
  }

  private clearPendingResult() {
    this.pendingResult = null;
  }

  private resetClientEffects() {
    this.stopPredictionLoop();
    this.predictedSelf = null;
    this.inputBuffer = [];
    this.inputSeqCounter = 0;
    this.selfSmoother.reset();
    this.timeline.reset();
    this.debugHistory = [];
    this.ammoHudEffects = [];
    this.cameraKick = { updatedAt: 0, x: 0, y: 0 };
    this.hitMarkerAt = 0;
    this.lastLocalShotAt = 0;
    this.localFireCooldownTicks = 0;
    this.pendingShotSeqs = [];
    this.playerArrivals.clear();
    this.playerDestructions.clear();
    this.thrusters.clear();

    if (this.p === null) {
      this.collisionExplosions = null;
      this.shipDebrisEffects = null;
      this.weaponEffects = null;
      return;
    }

    this.collisionExplosions = new ExplosionSystem(this.p);
    this.shipDebrisEffects = new ShipDebrisSystem(this.p);
    this.weaponEffects = new WeaponEffectsSystem(this.p);
  }

  private resetViewState() {
    this.stopResumeLoop();
    this.clearPendingResult();
    this.viewState = createInitialViewState();
    this.resetClientEffects();
  }
}

const multiplayerClientSession = new MultiplayerClientSession();

export const initializeMultiplayerSession = (p: p5) => {
  multiplayerClientSession.initialize(p);
};

export const drawMultiplayerMode = (p: p5) => {
  multiplayerClientSession.draw(p);
};
