import type { ShipInputState } from "../../../shared/src";

/**
 * How the server spends a player's queued inputs.
 *
 * A client sends one input per simulation tick and predicts its own ship
 * by stepping once per input. The server must make exactly the same
 * steps, so a ship steps once per input it consumes and never on its own.
 *
 * The network delivers those inputs unevenly: none on one tick, two on
 * the next. Applying them as they arrive would make the ship stutter on
 * every other player's screen. So the queue works as a jitter buffer: the
 * ship takes one input per tick, and the few inputs left waiting cover
 * the ticks on which nothing arrives. The buffer finds its own depth:
 *
 * - Nothing waiting: the ship pauses for a tick. It does not repeat the
 *   last input, because that would be a step the client never predicted.
 *   The pause leaves one more input waiting from then on.
 * - More waiting than the connection has needed lately: the ship takes an
 *   extra input now and then, so the buffer adds no more delay than the
 *   jitter requires.
 * - More arriving than real time allows: the surplus is discarded, so a
 *   client cannot move faster by sending faster.
 */

/** Inputs kept waiting beyond what recent jitter used, as a reserve. */
export const INPUT_QUEUE_HEADROOM = 1;
/** Most inputs left waiting after a tick. Bounds the delay the buffer adds: 67 ms. */
export const MAX_HELD_INPUTS = 4;
/** Ticks the buffer watches its lowest depth before it sheds unused delay. */
export const TRIM_WINDOW_TICKS = 60;
/** Most steps one ship makes in a single tick while it works off a backlog. */
export const MAX_INPUTS_PER_TICK = 3;
/** Largest backlog a ship may work off after a connection stall: half a second. */
export const INPUT_BUDGET_MAX = 30;
/**
 * Inputs a ship earns per server tick. Slightly above one so that clients
 * whose timers run a few percent fast are not throttled.
 */
export const INPUT_BUDGET_PER_TICK = 1.05;
/** Ticks without input after which a connected ship drifts with neutral controls. */
export const STARVED_COAST_AFTER_TICKS = 30;
/** Inputs held per player between ticks. Older ones are dropped first. */
export const INPUT_QUEUE_LIMIT = 120;

export interface InputPacing {
  /** Inputs this player may still consume. Refills with server time. */
  budget: number;
  /** Fewest inputs left waiting after a tick, in the current trim window. */
  lowestHeld: number;
  /** Consecutive ticks on which no input was waiting. */
  starvedTicks: number;
  /** Ticks counted in the current trim window. */
  windowTicks: number;
}

export interface TickInputs {
  /** Inputs to apply on this tick, oldest first: one ship step each. */
  apply: ShipInputState[];
  /** The ship has had no input for a long time and drifts this tick. */
  coast: boolean;
  /** Highest sequence number discarded without being applied, if any. */
  discardedThroughSeq: number | null;
}

export const createInputPacing = (): InputPacing => {
  return {
    budget: INPUT_BUDGET_MAX,
    lowestHeld: Number.MAX_SAFE_INTEGER,
    starvedTicks: 0,
    windowTicks: 0,
  };
};

/** Decide which queued inputs a ship consumes on this server tick. Removes them from `queue`. */
export const takeInputsForTick = (pacing: InputPacing, queue: ShipInputState[]): TickInputs => {
  pacing.budget = Math.min(INPUT_BUDGET_MAX, pacing.budget + INPUT_BUDGET_PER_TICK);

  if (queue.length === 0) {
    pacing.starvedTicks++;
    pacing.lowestHeld = 0;
    return {
      apply: [],
      coast: pacing.starvedTicks > STARVED_COAST_AFTER_TICKS,
      discardedThroughSeq: null,
    };
  }
  pacing.starvedTicks = 0;

  // New inputs arrive as fast as the budget refills, so a backlog larger
  // than the budget can never be worked off. Discard it now instead of
  // letting it sit in the queue as permanent input delay.
  const affordable = Math.floor(pacing.budget);
  const surplus = queue.length - MAX_HELD_INPUTS - affordable;
  let discardedThroughSeq: number | null = null;
  if (surplus > 0) {
    const discarded = queue.splice(0, surplus);
    discardedThroughSeq = discarded[discarded.length - 1].inputSeq;
  }

  // One input per tick keeps the ship moving evenly. More are taken only
  // to shed delay: at once when a stall left a backlog, and once per
  // window when the buffer has stayed deeper than the jitter needed.
  let wanted = 1 + Math.max(0, queue.length - 1 - MAX_HELD_INPUTS);
  pacing.windowTicks++;
  pacing.lowestHeld = Math.min(pacing.lowestHeld, queue.length - wanted);
  if (pacing.windowTicks >= TRIM_WINDOW_TICKS) {
    wanted += Math.max(0, pacing.lowestHeld - INPUT_QUEUE_HEADROOM);
    pacing.windowTicks = 0;
    pacing.lowestHeld = Number.MAX_SAFE_INTEGER;
  }

  const count = Math.min(wanted, MAX_INPUTS_PER_TICK, affordable, queue.length);
  pacing.budget -= count;

  return { apply: queue.splice(0, count), coast: false, discardedThroughSeq };
};
