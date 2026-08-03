import {
  ACCEL, AERO_DRAG, BRAKE, COAST_DRAG, DRIFT_BOOST, DRIFT_CHARGE_T1,
  DRIFT_CHARGE_T2, DRIFT_CHARGE_T3, DRIFT_MIN_SPEED, DRIFT_MIN_STEER,
  DRIFT_YAW_MUL, GRID_BACK0, GRID_LAT, GRID_ROW_DS, GRID_STAGGER,
  KART_RADIUS, MAX_SPEED, MAX_STEER_RAD, OFFROAD_SPEED_MUL,
  STATE_PRECISION, STEER_ACCEL, STEER_RATE_HIGH, STEER_RATE_LOW,
  STEER_RESPONSE, TOTAL_LAPS, TRACK_LEGS, TRACK_LENGTH, TRACK_WIDTH,
  WHEELBASE, YAW_RESPONSE, YAW_RETURN_RESPONSE, MAX_YAW_ACCEL,
  MAX_LATERAL_ACCEL, HEADING_DAMP,
} from './constants.js';
import {
  cloneItemSlots, createItemSlots, ensureItemSlots, syncLegacyItem,
} from './item-inventory.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const moveToward = (v, target, d) => (
  v < target ? Math.min(target, v + d) : Math.max(target, v - d)
);
const q = (v) => Math.round(v * STATE_PRECISION) / STATE_PRECISION;
const mod = (v, n) => ((v % n) + n) % n;

const CURVATURE_SAMPLES = buildCurvature();

function buildCurvature() {
  const count = Math.round(TRACK_LENGTH);
  let raw = new Float64Array(count);
  let distance = 0;
  for (const [length, degrees] of TRACK_LEGS) {
    const k = (degrees * Math.PI / 180) / length;
    const end = Math.min(count, Math.round(distance + length));
    for (let i = Math.round(distance); i < end; i++) raw[i] = k;
    distance += length;
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(count);
    const radius = 15;
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += raw[mod(i + j, count)];
      next[i] = sum / (radius * 2 + 1);
    }
    raw = next;
  }
  let integral = 0;
  for (let i = 0; i < count; i++) integral += raw[i];
  const scale = (-2 * Math.PI) / integral;
  for (let i = 0; i < count; i++) raw[i] *= scale;
  return raw;
}

export function curvatureAt(distance) {
  const d = mod(distance, TRACK_LENGTH);
  const i = Math.floor(d);
  const f = d - i;
  const a = CURVATURE_SAMPLES[i];
  const b = CURVATURE_SAMPLES[(i + 1) % CURVATURE_SAMPLES.length];
  return a + (b - a) * f;
}

export function halfWidthAt(distance) {
  const t = mod(distance, TRACK_LENGTH) / TRACK_LENGTH;
  for (let i = 0; i < TRACK_WIDTH.length; i++) {
    const a = TRACK_WIDTH[i];
    const b = TRACK_WIDTH[(i + 1) % TRACK_WIDTH.length];
    const bt = i === TRACK_WIDTH.length - 1 ? b[0] + 1 : b[0];
    const tt = i === TRACK_WIDTH.length - 1 && t < a[0] ? t + 1 : t;
    if (tt >= a[0] && tt <= bt) {
      const f = (tt - a[0]) / Math.max(1e-6, bt - a[0]);
      return a[1] + (b[1] - a[1]) * f;
    }
  }
  return TRACK_WIDTH[0][1];
}

export function createPlayer({ slot, userId, name }) {
  const row = slot >> 1;
  const col = slot & 1;
  return {
    slot, userId, name, connected: true,
    distance: -(GRID_BACK0 + row * GRID_ROW_DS + col * GRID_STAGGER),
    lateral: (col === 0 ? -1 : 1) * GRID_LAT,
    speed: 0, heading: 0, yawRate: 0,
    rack: 0, rackVelocity: 0,
    input: neutralInput(), ackIseq: 0,
    ackItemSeq: 0,
    drifting: false, driftDir: 0, driftCharge: 0,
    itemSlots: createItemSlots(),
    itemKind: 0, itemCount: 0, itemArm: 0,
    itemRevision: 0,
    boostTime: 0, stunTime: 0, starTime: 0, shrinkTime: 0,
    lap: 0, place: slot + 1, finished: false, finishMs: null,
  };
}

export function neutralInput() {
  return { steer: 0, accel: 0, brake: 0, drift: false, iseq: 0 };
}

export function sanitizeInput(raw = {}) {
  const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  return {
    steer: clamp(finite(raw.steer), -1, 1),
    accel: clamp(finite(raw.accel), 0, 1),
    brake: clamp(finite(raw.brake), 0, 1),
    drift: raw.drift === true,
    iseq: Math.max(0, Math.trunc(finite(raw.iseq))),
  };
}

export function stepPlayer(player, rawInput, dt) {
  let p = { ...player, itemSlots: cloneItemSlots(player) };
  const input = sanitizeInput(rawInput);
  const steps = Math.max(1, Math.ceil(dt * 120 - 1e-9));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) p = stepPlayerSubstep(p, input, h);
  for (const key of [
    'distance', 'lateral', 'speed', 'heading', 'yawRate', 'rack',
    'rackVelocity', 'driftCharge', 'boostTime', 'stunTime',
    'starTime', 'shrinkTime',
  ]) p[key] = q(p[key]);
  for (const slot of ensureItemSlots(p)) slot.arm = q(slot.arm);
  syncLegacyItem(p);
  return p;
}

function stepPlayerSubstep(player, input, dt) {
  const p = { ...player };
  const stunned = p.stunTime > 0;
  if (stunned) input = neutralInput();
  for (const slot of ensureItemSlots(p)) slot.arm = Math.max(0, slot.arm - dt);
  syncLegacyItem(p);
  p.boostTime = Math.max(0, (p.boostTime || 0) - dt);
  p.stunTime = Math.max(0, (p.stunTime || 0) - dt);
  p.starTime = Math.max(0, (p.starTime || 0) - dt);
  p.shrinkTime = Math.max(0, (p.shrinkTime || 0) - dt);
  const speedMix = clamp(Math.abs(p.speed) / MAX_SPEED, 0, 1);
  const maxRackRate = STEER_RATE_LOW + (STEER_RATE_HIGH - STEER_RATE_LOW) * speedMix;
  const desiredRackVelocity = clamp(
    (input.steer - p.rack) * STEER_RESPONSE,
    -maxRackRate,
    maxRackRate,
  );
  p.rackVelocity = moveToward(p.rackVelocity, desiredRackVelocity, STEER_ACCEL * dt);
  p.rack = clamp(p.rack + p.rackVelocity * dt, -1, 1);

  const effectAccel = p.boostTime > 0 ? 5.5 : p.starTime > 0 ? 2.2 : 0;
  const longitudinal = input.accel * ACCEL + effectAccel - input.brake * BRAKE
    - COAST_DRAG - AERO_DRAG * p.speed * p.speed;
  const effectMax = MAX_SPEED + (p.boostTime > 0 ? 5 : 0) + (p.starTime > 0 ? 2 : 0);
  const shrinkMul = p.shrinkTime > 0 ? 0.78 : 1;
  p.speed = clamp(p.speed + longitudinal * dt, 0, effectMax * shrinkMul);

  const wantsDrift = input.drift
    && p.speed >= DRIFT_MIN_SPEED
    && Math.abs(p.rack) >= DRIFT_MIN_STEER;
  if (wantsDrift) {
    if (!p.drifting) {
      p.drifting = true;
      p.driftDir = Math.sign(p.rack) || 1;
      p.driftCharge = 0;
    }
    p.driftCharge += dt;
  } else if (p.drifting) {
    let tier = 0;
    if (p.driftCharge >= DRIFT_CHARGE_T3) tier = 3;
    else if (p.driftCharge >= DRIFT_CHARGE_T2) tier = 2;
    else if (p.driftCharge >= DRIFT_CHARGE_T1) tier = 1;
    p.speed = Math.min(MAX_SPEED + DRIFT_BOOST[tier], p.speed + DRIFT_BOOST[tier]);
    p.drifting = false;
    p.driftDir = 0;
    p.driftCharge = 0;
  }

  const yawMul = p.drifting ? DRIFT_YAW_MUL : 1;
  const bicycleYawRate = (
    (p.speed / WHEELBASE) * Math.tan(p.rack * MAX_STEER_RAD) * yawMul
  );
  // A bicycle model without tyre saturation asks for more than 4 rad/s at race
  // speed and full lock. That is not a turn: it is an instantaneous spin into
  // the road edge. Bound yaw by the lateral acceleration the tyres can produce,
  // while retaining the bicycle response at low speed and small steering input.
  const gripYawRate = MAX_LATERAL_ACCEL / Math.max(1, Math.abs(p.speed));
  const targetYawRate = clamp(bicycleYawRate, -gripYawRate, gripYawRate);
  const yawResponse = Math.abs(input.steer) < 0.03
    ? YAW_RETURN_RESPONSE
    : YAW_RESPONSE;
  p.yawRate += clamp(
    (targetYawRate - p.yawRate) * yawResponse,
    -MAX_YAW_ACCEL,
    MAX_YAW_ACCEL,
  ) * dt;

  const curvature = curvatureAt(p.distance);
  p.heading += (p.yawRate - curvature * p.speed) * dt;
  if (Math.abs(input.steer) < 0.03) p.heading *= Math.exp(-HEADING_DAMP * dt);
  p.heading = clamp(p.heading, -1.05, 1.05);

  const denom = Math.max(0.35, 1 - curvature * p.lateral);
  p.distance += (p.speed * Math.cos(p.heading) / denom) * dt;
  p.lateral += p.speed * Math.sin(p.heading) * dt;

  const edge = Math.max(1.2, halfWidthAt(p.distance) - KART_RADIUS);
  if (Math.abs(p.lateral) > edge) {
    p.lateral = clamp(p.lateral, -edge, edge);
    p.heading *= -0.35;
    p.yawRate *= 0.55;
    p.speed *= OFFROAD_SPEED_MUL;
  }

  p.lap = p.distance < 0 ? 0 : Math.min(TOTAL_LAPS, Math.floor(p.distance / TRACK_LENGTH) + 1);
  if (p.distance >= TRACK_LENGTH * TOTAL_LAPS) p.finished = true;

  return p;
}

export function stepRace(players, dt) {
  const next = players.map((p) => (
    p.finished ? { ...p, speed: q(Math.max(0, p.speed - BRAKE * 0.4 * dt)) }
      : stepPlayer(p, p.connected ? p.input : neutralInput(), dt)
  ));
  resolveKartContacts(next);
  const sorted = [...next].sort((a, b) => {
    if (a.finished && b.finished) return (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity);
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.distance - a.distance;
  });
  sorted.forEach((p, i) => { p.place = i + 1; });
  return next;
}

function resolveKartContacts(players) {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const along = Math.abs(a.distance - b.distance);
      const across = Math.abs(a.lateral - b.lateral);
      if (along >= 2.2 || across >= 1.8) continue;
      const sign = Math.sign(a.lateral - b.lateral) || (a.slot < b.slot ? -1 : 1);
      const push = (1.8 - across) * 0.5;
      a.lateral += sign * push;
      b.lateral -= sign * push;
      a.speed *= 0.93;
      b.speed *= 0.93;
    }
  }
}
