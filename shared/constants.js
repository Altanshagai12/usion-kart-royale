export const PROTOCOL_VERSION = 1;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const TOTAL_LAPS = 3;
export const TRACK_LENGTH = 1600;
export const KART_RADIUS = 0.9;

export const SIM_HZ = 60;
export const SIM_DT_MS = 1000 / SIM_HZ;
export const NET_EVERY_SIM_TICKS = 3;
export const KEYFRAME_EVERY_NET_TICKS = 20;
export const INPUT_HZ = 30;
export const INPUT_RATE_LIMIT_PER_S = 60;
export const SNAPSHOT_MAX_BYTES = 7500;

export const COUNTDOWN_MS = 3400;
export const AUTO_START_MS = 5000;
export const RESULTS_LINGER_MS = 30000;
export const SESSION_SILENT_TIMEOUT_MS = 45000;
export const RECONNECT_GRACE_MS = 15000;
export const LONE_PLAYER_END_MS = 20000;

export const MAX_SPEED = 31;
export const ACCEL = 10.5;
export const BRAKE = 18;
export const COAST_DRAG = 1.5;
export const AERO_DRAG = 0.008;
export const OFFROAD_SPEED_MUL = 0.72;

export const WHEELBASE = 2.05;
export const MAX_STEER_RAD = 0.48;
export const STEER_RESPONSE = 8;
export const STEER_ACCEL = 26;
export const STEER_RATE_LOW = 5.8;
export const STEER_RATE_HIGH = 3.2;
export const YAW_RESPONSE = 5.5;
export const MAX_YAW_ACCEL = 7;
export const HEADING_DAMP = 0.18;

export const DRIFT_MIN_SPEED = 9;
export const DRIFT_MIN_STEER = 0.18;
export const DRIFT_YAW_MUL = 1.16;
export const DRIFT_CHARGE_T1 = 0.55;
export const DRIFT_CHARGE_T2 = 1.15;
export const DRIFT_CHARGE_T3 = 1.9;
export const DRIFT_BOOST = [0, 1.3, 2.2, 3.1];

export const GRID_LAT = 3.2;
export const GRID_ROW_DS = 8;
export const GRID_STAGGER = 4;
export const GRID_BACK0 = 11;

export const STATE_PRECISION = 1e4;
export const DESYNC_SNAP_METERS = 7;

export const TRACK_LEGS = [
  [160, -13.85], [192, -102.06], [70, -44.48], [60, 40.84],
  [66, -44.12], [60, -20.79], [90, -21.02], [74, -4.13],
  [60, -17.70], [128, -21.13], [110, -2.81], [114, -21.15],
  [192, -170.85], [60, 42.32], [84, 11.22], [80, 24.47],
];

export const TRACK_WIDTH = [
  [0.000, 8.8], [0.070, 8.6], [0.140, 8.1], [0.210, 7.5],
  [0.270, 7.0], [0.330, 6.8], [0.380, 6.4], [0.440, 5.7],
  [0.480, 5.4], [0.521, 5.9], [0.560, 6.3], [0.620, 6.9],
  [0.700, 7.6], [0.760, 8.8], [0.830, 8.7], [0.880, 7.2],
  [0.930, 7.0], [0.968, 8.2],
];
