import {
  type ArenaConfig,
  type MatchPlayerSnapshot,
  type RuntimePlayerState,
  type ShipInputState,
  stepPlayerState,
} from "../../../shared/src";
import type { Pose } from "./renderSmoother";

/** An input the client applied locally and the server has not confirmed yet. */
export interface PendingInput {
  input: ShipInputState;
  seq: number;
}

export interface Reconciliation<T extends PendingInput> {
  /** Pose one tick before `state`, or null when no input was replayed. */
  beforeLastStep: Pose | null;
  /** Inputs the server still has to consume, oldest first. */
  pending: T[];
  /** The predicted ship: the server's state plus every pending input. */
  state: RuntimePlayerState;
}

/**
 * Rebuild the predicted ship from an authoritative snapshot.
 *
 * The server state already contains every input up to `lastInputSeq`.
 * Replaying the inputs after it, one step each, lands on the ship the
 * client had predicted, as long as the server made the same steps.
 */
export const replayPendingInputs = <T extends PendingInput>(
  serverState: MatchPlayerSnapshot,
  pending: T[],
  arena: ArenaConfig,
): Reconciliation<T> => {
  const state: RuntimePlayerState = { ...serverState, fireCooldownTicks: 0 };
  const unconfirmed = pending.filter((entry) => entry.seq > serverState.lastInputSeq);
  let beforeLastStep: Pose | null = null;

  if (state.health > 0) {
    for (let index = 0; index < unconfirmed.length; index++) {
      beforeLastStep = { angle: state.angle, x: state.x, y: state.y };
      stepPlayerState(state, unconfirmed[index].input, arena);
    }
  }

  return { beforeLastStep, pending: unconfirmed, state };
};
