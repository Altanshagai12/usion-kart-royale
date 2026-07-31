import {
  PROTOCOL_VERSION, SNAPSHOT_MAX_BYTES,
} from './config.js';

export function serializeSnapshot(room, { keyframe = false, advance = false } = {}) {
  if (advance) room.snapSeq += 1;
  const ack = {};
  for (const player of room.players) ack[player.slot] = player.ackIseq;
  const payload = {
    v: PROTOCOL_VERSION,
    s: room.snapSeq,
    k: keyframe || undefined,
    server_ts: Date.now(),
    elapsed_ms: room.roundStartedAt ? Date.now() - room.roundStartedAt : 0,
    phase: room.phase,
    countdown_ms: room.phase === 'countdown' ? Math.max(0, room.countdownMs) : 0,
    roster: room.roster(),
    ack,
    players: room.players.map((player) => ({
      slot: player.slot,
      user_id: player.userId,
      name: player.name,
      connected: player.connected,
      distance: player.distance,
      lateral: player.lateral,
      speed: player.speed,
      heading: player.heading,
      yaw_rate: player.yawRate,
      rack: player.rack,
      rack_velocity: player.rackVelocity,
      drifting: player.drifting,
      drift_dir: player.driftDir,
      drift_charge: player.driftCharge,
      lap: player.lap,
      place: player.place,
      finished: player.finished,
      finish_ms: player.finishMs,
    })),
  };
  const json = JSON.stringify({
    type: keyframe ? 'state_snapshot' : 'state_delta',
    room_id: room.roomId,
    payload,
  });
  const bytes = Buffer.byteLength(json);
  if (bytes >= SNAPSHOT_MAX_BYTES) {
    throw new Error(`snapshot ${bytes} exceeds ${SNAPSHOT_MAX_BYTES}`);
  }
  return { payload, json };
}
