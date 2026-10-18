import {
  type ArenaConfig,
  type MatchBulletSnapshot,
  type MatchPlayerSnapshot,
  type MatchSnapshotPayload,
  projectPlayerSnapshot,
} from "../../../shared/src";
import type { BulletTracker } from "./bulletTracker";
import { lerpPose } from "./renderSmoother";
import { MAX_EXTRAPOLATION_TICKS, type TimelineView } from "./serverTimeline";

/**
 * Every ship except the local player's, at the moment the timeline draws:
 * between two snapshots when both exist, otherwise projected a short way
 * past the newest one.
 */
export const sampleRemotePlayers = (
  view: TimelineView<MatchSnapshotPayload>,
  localPlayerId: string,
  arena: ArenaConfig,
): MatchPlayerSnapshot[] => {
  const players: MatchPlayerSnapshot[] = [];

  if (view.to === null) {
    for (let index = 0; index < view.from.players.length; index++) {
      const player = view.from.players[index];
      if (player.id !== localPlayerId) {
        players.push(projectPlayerSnapshot(player, view.ahead, arena));
      }
    }
    return players;
  }

  for (let index = 0; index < view.to.players.length; index++) {
    const later = view.to.players[index];
    if (later.id === localPlayerId) {
      continue;
    }
    const earlier = view.from.players.find((player) => player.id === later.id);
    players.push(
      earlier === undefined ? later : { ...later, ...lerpPose(earlier, later, view.mix) },
    );
  }
  return players;
};

/**
 * Bullets fly in a straight line, so they can be placed at the current
 * server tick exactly. They need no interpolation delay. Like ships, they
 * go no further than a few ticks past the newest snapshot.
 */
export const sampleBullets = (
  bullets: BulletTracker,
  liveTick: number,
  newestTick: number,
): MatchBulletSnapshot[] => {
  return bullets.sample(
    Math.max(newestTick - 2, Math.min(newestTick + MAX_EXTRAPOLATION_TICKS, liveTick)),
  );
};
