import {
  RESULTS_LINGER_MS, TOTAL_LAPS, TRACK_LENGTH,
} from './config.js';
import { submitResult } from './webhook.js';

export function finishRoom(room, reason) {
  if (room.phase === 'finished') return;
  room.phase = 'finished';
  if (room.tickTimer) clearTimeout(room.tickTimer);
  room.netTickFrame();
  const placements = [...room.players].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return a.finished
      ? (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity)
      : b.distance - a.distance;
  });
  const winner = placements[0];
  room.rematchVotes.clear();
  room.resultPayload = {
    winner_ids: winner ? [winner.userId] : [],
    reason,
    placements: placements.map((player, index) => ({
      user_id: player.userId,
      place: index + 1,
      finish_ms: player.finishMs,
    })),
  };
  room.broadcast('match_end', { ...room.resultPayload, rematch_user_ids: [] });
  submitResult({
    roomId: room.roomId,
    sessionId: room.lastSessionId || 'unknown',
    winnerIds: winner ? [winner.userId] : [],
    participants: room.players.map((player) => player.userId),
    reason,
    finalStats: {
      laps: TOTAL_LAPS,
      track_length: TRACK_LENGTH,
      placements: placements.map((player) => ({
        user_id: player.userId,
        finish_ms: player.finishMs,
        distance: player.distance,
      })),
    },
  }).catch((error) => console.error('[RESULT]', error));
  room.armClose(RESULTS_LINGER_MS);
}
