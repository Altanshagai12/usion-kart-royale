import { createPlayer } from '../shared/race-sim.js';
import { createItemRuntime } from './item-runtime.js';
import { MIN_PLAYERS, RESULTS_LINGER_MS } from './config.js';

export function resultWithVotes(room) {
  return room.resultPayload
    ? { ...room.resultPayload, rematch_user_ids: [...room.rematchVotes] }
    : null;
}

export function requestRematch(room, conn) {
  if (room.phase !== 'finished' || !room.resultPayload
      || room.resultPayload.reason === 'host_left'
      || room.connections.get(conn.userId) !== conn) return false;
  const player = room.players.find((candidate) => (
    candidate.userId === conn.userId && candidate.connected
  ));
  if (!player) return false;

  if (room.rematchVotes.has(conn.userId)) return true;
  room.rematchVotes.add(conn.userId);
  room.armClose(RESULTS_LINGER_MS);
  const result = resultWithVotes(room);
  if (result) room.broadcast('match_end', result);
  evaluateRematch(room);
  return true;
}

export function evaluateRematch(room) {
  if (room.phase !== 'finished' || !room.resultPayload) return false;
  const connected = room.players.filter((candidate) => candidate.connected);
  const hostPresent = connected.some((candidate) => candidate.userId === room.hostUserId);
  if (!hostPresent || connected.length < MIN_PLAYERS
      || !connected.every((candidate) => room.rematchVotes.has(candidate.userId))) return false;
  resetForRematch(room);
  return true;
}

export function closeFinishedAfterHostExit(room) {
  if (room.phase !== 'finished' || !room.resultPayload) return false;
  const result = resultWithVotes(room);
  room.resultPayload = null;
  room.rematchVotes.clear();
  room.broadcast('match_end', {
    ...(result || {}), reason: 'host_left', rematch_user_ids: [],
  });
  room.armClose(100);
  return true;
}

export function resetForRematch(room) {
  if (room.closeTimer) clearTimeout(room.closeTimer);
  if (room.tickTimer) clearTimeout(room.tickTimer);
  room.closeTimer = null;
  room.tickTimer = null;
  room.phase = 'waiting';
  room.countdownMs = 0;
  room.roundStartedAt = 0;
  room.firstFinishAt = 0;
  room.loneSince = 0;
  room.lastTickAt = 0;
  room.serverTick = 0;
  room.netTick = 0;
  room.items = createItemRuntime();
  room.players = room.players.map((previous) => {
    const player = createPlayer({
      slot: previous.slot, userId: previous.userId, name: previous.name,
    });
    player.connected = previous.connected;
    player.disconnectedAt = previous.disconnectedAt || 0;
    player.ready = previous.userId === room.hostUserId;
    return player;
  });
  room.rematchVotes.clear();
  room.resultPayload = null;
  room.broadcast('player_joined', { roster: room.roster() });
  // Keep the broadcast sequence monotonic while forcing the first reset frame
  // to be a keyframe, so predictors cannot blend the old finish into the grid.
  room.netTickFrame();
}
