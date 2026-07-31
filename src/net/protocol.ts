export interface DirectRosterRow {
  slot: number;
  user_id: string;
  name: string;
  connected?: boolean;
}

export interface DirectPlayerRow {
  slot: number;
  user_id: string;
  name: string;
  connected: boolean;
  distance: number;
  lateral: number;
  speed: number;
  heading: number;
  yaw_rate: number;
  rack: number;
  rack_velocity: number;
  drifting: boolean;
  drift_dir: number;
  drift_charge: number;
  lap: number;
  place: number;
  finished: boolean;
  finish_ms: number | null;
}

export interface DirectSnapshot {
  v: number;
  s: number;
  k?: boolean;
  server_ts: number;
  elapsed_ms: number;
  phase: 'waiting' | 'countdown' | 'playing' | 'finished';
  countdown_ms: number;
  roster: DirectRosterRow[];
  ack: Record<string, number>;
  players: DirectPlayerRow[];
}

export interface DirectJoined {
  room_id: string;
  slot: number | null;
  spectator: boolean;
  roster: DirectRosterRow[];
  phase: DirectSnapshot['phase'];
  snapshot?: DirectSnapshot;
}

export interface DrivePayload {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  iseq: number;
  client_sent_at: number;
}

export function isSnapshot(value: unknown): value is DirectSnapshot {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<DirectSnapshot>;
  return frame.v === 1
    && Number.isInteger(frame.s)
    && typeof frame.server_ts === 'number'
    && typeof frame.elapsed_ms === 'number'
    && ['waiting', 'countdown', 'playing', 'finished'].includes(String(frame.phase))
    && Array.isArray(frame.roster)
    && Array.isArray(frame.players)
    && frame.players.length <= 4
    && frame.players.every((row) => (
      Number.isInteger(row?.slot)
      && typeof row?.user_id === 'string'
      && Number.isFinite(row?.distance)
      && Number.isFinite(row?.lateral)
      && Number.isFinite(row?.speed)
    ));
}
