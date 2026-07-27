/**
 * ============================================================================
 *  AI — racing line solver + driver model
 * ============================================================================
 *  Two pieces, deliberately separated:
 *
 *  1. `RacingLine` is solved ONCE at boot. It is a minimum-curvature line
 *     through the corridor (the classic out–in–out falls straight out of
 *     Laplacian relaxation of the lateral offset), biased to a late apex,
 *     then given a speed profile: cornering limit from the local radius and
 *     the banking, followed by a backward pass so every braking zone is
 *     already baked in. The drivers therefore *lift before* the corner rather
 *     than discovering it mid-entry, which is the single biggest difference
 *     between an AI that looks like it can drive and one that does not.
 *
 *  2. `AIDriver` is one racer. It steers at a speed-scaled lookahead point
 *     with a PD controller plus a cross-track term, brakes off the profile,
 *     drifts through anything tight enough to be worth a mini-turbo, biases
 *     its lane around rivals and hazards, decides when to spend its item, and
 *     — importantly — is imperfect: every driver carries a steering-noise
 *     signature, a personal speed ceiling and an occasional genuine mistake.
 *
 *  Nothing here allocates after `init`. Every lookup is a typed-array read.
 * ============================================================================
 */
import * as THREE from 'three';
import { BASE_TOP_SPEED, ItemKind, Surface, type Ctx, type IKart, type ITrack } from '../types';

// --- solver tuning -----------------------------------------------------------
/** node spacing of the baked line, metres */
const NODE_DS = 4;
/** how far inside the kerb the line is allowed to run */
const EDGE_MARGIN = 2.0;
/** relaxation passes for the minimum-curvature solve */
const RELAX_PASSES = 320;
const RELAX_RATE = 0.32;
/** metres the apex is pushed later than the geometric optimum */
const LATE_APEX_SHIFT = 13;
/** arcade gravity — must match Kart.ts, the banking term depends on it */
const GRAVITY = 20;
/** lateral acceleration a kart can hold on clean tarmac, m/s^2 */
const A_LAT = 12.6;
/** braking capability used to build the approach ramps, m/s^2 */
const A_BRAKE = 11.5;
/**
 * Curvature at which a corner is worth drifting. Sunset Bay is a fast circuit —
 * the racing line only bends harder than this at the harbour sweep, the tight
 * pair of village esses and the banked 180, which is about the right number of
 * mini-turbos per lap. Lower it and they drift the straights.
 */
const DRIFT_MIN_CURV = 0.0098;

// --- module scratch ----------------------------------------------------------
const _p0 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** wrap to (-PI, PI] */
function wrapPi(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
/** deterministic per-driver randomness — a race must replay the same way */
function hash01(n: number) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A world obstacle the drivers should not run into (bananas, live shells). */
export interface HazardLike {
  x: number;
  y: number;
  z: number;
  r: number;
  /** kart id that owns it, or -1 — an owner ignores its own hazard */
  owner: number;
}

// =============================================================================
//  Racing line
// =============================================================================

export class RacingLine {
  count = 0;
  ds = 0;
  length = 0;

  /** line point */
  px!: Float32Array; py!: Float32Array; pz!: Float32Array;
  /** centreline point */
  cx!: Float32Array; cy!: Float32Array; cz!: Float32Array;
  /** banked binormal ("right") at the station */
  bx!: Float32Array; by!: Float32Array; bz!: Float32Array;
  /** unit tangent of the LINE (not the centreline), XZ-heading in `yaw` */
  yaw!: Float32Array;
  /** lateral offset of the line from the centreline, metres */
  off!: Float32Array;
  half!: Float32Array;
  bank!: Float32Array;
  /** signed curvature of the line, 1/m (sign matches TrackLayout: -ve = left) */
  curv!: Float32Array;
  /** target speed, m/s */
  speed!: Float32Array;

  build(track: ITrack) {
    const L = track.length;
    const n = Math.max(64, Math.round(L / NODE_DS));
    this.count = n;
    this.length = L;
    this.ds = L / n;

    const f = () => new Float32Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.cx = f(); this.cy = f(); this.cz = f();
    this.bx = f(); this.by = f(); this.bz = f();
    this.yaw = f(); this.off = f(); this.half = f();
    this.bank = f(); this.curv = f(); this.speed = f();

    // --- bake the corridor ------------------------------------------------
    for (let i = 0; i < n; i++) {
      const s = track.sample(i / n);
      this.cx[i] = s.pos.x; this.cy[i] = s.pos.y; this.cz[i] = s.pos.z;
      this.bx[i] = s.binormal.x; this.by[i] = s.binormal.y; this.bz[i] = s.binormal.z;
      this.half[i] = s.halfWidth;
      this.bank[i] = s.bank;
    }

    // --- centreline curvature, for the corner-hugging blend below ----------
    const ck = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const v1x = this.cx[i] - this.cx[a], v1z = this.cz[i] - this.cz[a];
      const v2x = this.cx[b] - this.cx[i], v2z = this.cz[b] - this.cz[i];
      const l1 = Math.hypot(v1x, v1z) || 1e-4;
      const l2 = Math.hypot(v2x, v2z) || 1e-4;
      const t1x = v1x / l1, t1z = v1z / l1;
      const t2x = v2x / l2, t2z = v2z / l2;
      ck[i] = (2 * Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z)) / (l1 + l2);
    }

    // --- minimum-curvature relaxation -------------------------------------
    // Moving every node toward the midpoint of its neighbours, but only along
    // the lateral axis, is gradient descent on total curvature. Constrained by
    // the corridor it converges on the geometric racing line: wide on entry,
    // clipping the apex, wide again on exit.
    const off = this.off;
    const lim = new Float32Array(n);
    for (let i = 0; i < n; i++) lim[i] = Math.max(0.5, this.half[i] - EDGE_MARGIN);

    for (let pass = 0; pass < RELAX_PASSES; pass++) {
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        const b = (i + 1) % n;
        this.nodePoint(a, off[a], _p0);
        this.nodePoint(b, off[b], _p2);
        // midpoint of the neighbours, expressed in this node's lateral frame
        const mx = (_p0.x + _p2.x) * 0.5 - this.cx[i];
        const my = (_p0.y + _p2.y) * 0.5 - this.cy[i];
        const mz = (_p0.z + _p2.z) * 0.5 - this.cz[i];
        const want = mx * this.bx[i] + my * this.by[i] + mz * this.bz[i];
        off[i] = clamp(off[i] + (want - off[i]) * RELAX_RATE, -lim[i], lim[i]);
      }
    }

    // --- corner-hugging blend ----------------------------------------------
    // A pure minimum-curvature line straight-lines a 26 m wide chicane into
    // nothing: technically fastest, but it drives like a solver and it never
    // loads the kart hard enough to be worth a drift. Blending a little of the
    // classic hug-the-inside line back in restores the shape of the circuit —
    // the corners stay corners, the mini-turbos are worth taking, and the cost
    // in lap time is a couple of tenths.
    {
      const w = 0.24;
      for (let i = 0; i < n; i++) {
        const inside = Math.sign(ck[i]) * Math.min(1, Math.abs(ck[i]) * 150) * this.half[i] * 0.5;
        off[i] = clamp(off[i] + (inside - off[i]) * w, -lim[i], lim[i]);
      }
    }

    // --- late apex ---------------------------------------------------------
    // Re-reading the converged offset from slightly *earlier* along the track
    // delays the whole pattern, which is exactly what a late apex is: give up
    // entry radius to straighten the exit. Only applied where it is a corner —
    // shifting the line on a straight would just make it wander.
    {
      const shift = Math.max(1, Math.round(LATE_APEX_SHIFT / this.ds));
      const src = Float32Array.from(off);
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n;
        const b = (i + 1) % n;
        // second difference of the offset ~ how hard this node is working
        const bend = Math.abs(src[a] - 2 * src[i] + src[b]) / this.ds;
        const w = Math.min(1, bend * 26) * 0.55;
        const j = (i - shift + n) % n;
        off[i] = clamp(src[i] + (src[j] - src[i]) * w, -lim[i], lim[i]);
      }
      // a couple of relaxation passes to take the kinks back out
      for (let pass = 0; pass < 12; pass++) {
        for (let i = 0; i < n; i++) {
          const a = (i - 1 + n) % n;
          const b = (i + 1) % n;
          off[i] = clamp(off[i] * 0.6 + (off[a] + off[b]) * 0.2, -lim[i], lim[i]);
        }
      }
    }

    // --- resolve points, headings, curvature -------------------------------
    for (let i = 0; i < n; i++) {
      this.nodePoint(i, off[i], _p0);
      this.px[i] = _p0.x; this.py[i] = _p0.y; this.pz[i] = _p0.z;
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const v1x = this.px[i] - this.px[a], v1z = this.pz[i] - this.pz[a];
      const v2x = this.px[b] - this.px[i], v2z = this.pz[b] - this.pz[i];
      const l1 = Math.hypot(v1x, v1z) || 1e-4;
      const l2 = Math.hypot(v2x, v2z) || 1e-4;
      const t1x = v1x / l1, t1z = v1z / l1;
      const t2x = v2x / l2, t2z = v2z / l2;
      // same sign convention as TrackLayout's curvature schedule
      const d = Math.atan2(t1x * t2z - t1z * t2x, t1x * t2x + t1z * t2z);
      // the two segment directions are (l1+l2)/2 apart along the path, not
      // l1+l2 — getting this wrong halves every curvature and the whole field
      // arrives at the hairpin believing it is a kink
      this.curv[i] = (2 * d) / (l1 + l2);
      this.yaw[i] = Math.atan2(v2x + v1x, v2z + v1z);
    }
    // curvature straight off three samples is noisy at 4 m spacing; a short
    // circular blur turns it into something a speed profile can trust
    this.smoothCurv(2);

    // --- speed profile ------------------------------------------------------
    const sp = this.speed;
    const vCap = BASE_TOP_SPEED * 1.14;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.curv[i]);
      // banking helps when the road leans into the corner; TrackLayout's
      // convention is +bank = right side raised, which supports a LEFT turn
      // (negative curvature), so the two signs must oppose to be a benefit.
      const help = -Math.sign(this.curv[i]) * this.bank[i];
      const aLat = Math.max(4, A_LAT + GRAVITY * Math.sin(clamp(help, -0.45, 0.45)) * 0.85);
      sp[i] = k > 1e-5 ? Math.min(vCap, Math.sqrt(aLat / k)) : vCap;
    }
    // backward pass, twice around so the loop seam is consistent: no node may
    // be faster than it can brake from into the node after it
    for (let pass = 0; pass < 2; pass++) {
      for (let s = n - 1; s >= 0; s--) {
        const i = s;
        const j = (i + 1) % n;
        const cap = Math.sqrt(sp[j] * sp[j] + 2 * A_BRAKE * this.ds);
        if (sp[i] > cap) sp[i] = cap;
      }
    }
  }

  private smoothCurv(radius: number) {
    const n = this.count;
    const src = Float32Array.from(this.curv);
    const w = radius * 2 + 1;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[(i + k + n) % n];
      this.curv[i] = acc / w;
    }
  }

  private nodePoint(i: number, off: number, out: THREE.Vector3) {
    out.set(
      this.cx[i] + this.bx[i] * off,
      this.cy[i] + this.by[i] * off,
      this.cz[i] + this.bz[i] * off,
    );
  }

  // --- runtime lookups (all wrap, all allocation-free) --------------------

  /** node index for an arc distance */
  index(d: number): number {
    const n = this.count;
    let i = Math.floor((d / this.length) * n) % n;
    if (i < 0) i += n;
    return i;
  }

  /** interpolated line point at arc distance `d` */
  point(d: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.count;
    let f = (d / this.length) * n;
    f -= Math.floor(f / n) * n;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const u = f - Math.floor(f);
    out.set(
      this.px[i] + (this.px[j] - this.px[i]) * u,
      this.py[i] + (this.py[j] - this.py[i]) * u,
      this.pz[i] + (this.pz[j] - this.pz[i]) * u,
    );
    return out;
  }

  offsetAt(d: number): number {
    const n = this.count;
    let f = (d / this.length) * n;
    f -= Math.floor(f / n) * n;
    const i = Math.floor(f) % n;
    const j = (i + 1) % n;
    const u = f - Math.floor(f);
    return this.off[i] + (this.off[j] - this.off[i]) * u;
  }

  speedAt(d: number): number {
    return this.speed[this.index(d)];
  }

  curvAt(d: number): number {
    return this.curv[this.index(d)];
  }

  /** lowest target speed over the next `span` metres */
  minSpeed(d: number, span: number): number {
    const steps = Math.max(1, Math.round(span / this.ds));
    const i0 = this.index(d);
    let m = Infinity;
    for (let s = 0; s <= steps; s++) {
      const v = this.speed[(i0 + s) % this.count];
      if (v < m) m = v;
    }
    return m;
  }

  /** strongest |curvature| over the next `span` metres, keeping its sign */
  peakCurv(d: number, span: number): number {
    const steps = Math.max(1, Math.round(span / this.ds));
    const i0 = this.index(d);
    let best = 0;
    for (let s = 0; s <= steps; s++) {
      const c = this.curv[(i0 + s) % this.count];
      if (Math.abs(c) > Math.abs(best)) best = c;
    }
    return best;
  }

  /** signed lateral offset of a world point from the centreline at progress t */
  lateralOf(x: number, y: number, z: number, t: number): number {
    const i = this.index(t * this.length);
    return (x - this.cx[i]) * this.bx[i] + (y - this.cy[i]) * this.by[i] + (z - this.cz[i]) * this.bz[i];
  }
}

// =============================================================================
//  Driver
// =============================================================================

export interface DriveCmd {
  steer: number;
  throttle: number;
  brake: number;
  drift: boolean;
  /** set for exactly one frame when the driver wants to spend its item */
  useItem: boolean;
  /** true = deploy behind (shield / drop), false = fire ahead */
  itemBackwards: boolean;
}

/** The bit of the item system that knows about tow ropes. See `drive`. */
interface Towable {
  towing(kart: IKart): ItemKind;
}

const enum Mistake {
  None = 0,
  Wobble = 1,
  LateBrake = 2,
  NoDrift = 3,
}

export class AIDriver {
  readonly cmd: DriveCmd = {
    steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, itemBackwards: false,
  };

  /** 0..1 — how close to the limit this driver runs */
  readonly skill: number;
  /** 0..1 — willingness to lean on rivals and spend items early */
  readonly aggression: number;

  private prevErr = 0;
  private iErr = 0;
  private steerSmooth = 0;
  private lane = 0;
  private laneTarget = 0;
  private driftHold = false;
  private driftCool = 0;
  private driftSide = 0;
  /** seconds left of the deliberate over-steer that engages the slide */
  private driftEntry = 0;
  private noisePhase: number;
  private noiseRate: number;
  private mistake = Mistake.None;
  private mistakeT = 0;
  private nextMistake: number;
  private itemDelay = 0;
  private lastKind: ItemKind = ItemKind.None;
  /** seconds the current shield has been on the tow rope */
  private carryT = 0;
  private stuckT = 0;

  constructor(readonly kart: IKart, private line: RacingLine, seed: number) {
    const h0 = hash01(seed * 7 + 11);
    const h1 = hash01(seed * 13 + 5);
    const st = kart.stats;
    // Skill leans on handling (a nimble character is driven by a nimble AI) and
    // is spread by a stable per-racer hash so the field is not homogeneous.
    this.skill = clamp(0.70 + (st.handlingMul - 1) * 1.5 + (h0 - 0.5) * 0.20, 0.5, 1);
    this.aggression = clamp(0.45 + (st.accelMul - 1) * 1.8 + (h1 - 0.5) * 0.5, 0.1, 1);
    this.noisePhase = h0 * Math.PI * 2;
    this.noiseRate = 0.55 + h1 * 0.5;
    this.nextMistake = 9 + h1 * 18;
  }

  reset() {
    this.prevErr = 0;
    this.iErr = 0;
    this.steerSmooth = 0;
    this.lane = this.laneTarget = 0;
    this.driftHold = false;
    this.driftCool = 0;
    this.driftSide = 0;
    this.driftEntry = 0;
    this.mistake = Mistake.None;
    this.mistakeT = 0;
    this.itemDelay = 0;
    this.carryT = 0;
    this.stuckT = 0;
    this.cmd.steer = this.cmd.throttle = this.cmd.brake = 0;
    this.cmd.drift = false;
    this.cmd.useItem = false;
  }

  /**
   * @param band  rubber-band multiplier on the target speed (1 = neutral)
   * @param held  the item this driver is holding, for the spend decision
   * @param towed the item already deployed behind it as a shield, if any —
   *              spent by releasing rather than by throwing
   */
  update(
    ctx: Ctx,
    dt: number,
    karts: readonly IKart[],
    hazards: readonly HazardLike[],
    band: number,
    held: ItemKind,
    heldCount: number,
    racing: boolean,
    towed: ItemKind = ItemKind.None,
  ) {
    const k = this.kart;
    const cmd = this.cmd;
    cmd.useItem = false;

    const line = this.line;
    const L = line.length;
    const d = k.t * L;
    const speed = k.forwardSpeed;
    const time = ctx.time;

    // ---- personality timers ------------------------------------------------
    if (this.driftCool > 0) this.driftCool -= dt;
    if (this.mistakeT > 0) {
      this.mistakeT -= dt;
      if (this.mistakeT <= 0) this.mistake = Mistake.None;
    } else {
      this.nextMistake -= dt;
      if (this.nextMistake <= 0) this.rollMistake();
    }

    if (!racing) {
      // Held on the grid: no steering, no throttle. The countdown "rocket
      // start" is the director's business, not the driver's.
      cmd.steer = 0; cmd.throttle = 0; cmd.brake = 0; cmd.drift = false;
      return;
    }

    // ---- lane bias: rivals, hazards, and the odd defensive weave -----------
    this.updateLane(k, karts, hazards, d, dt);

    // ---- steering ----------------------------------------------------------
    // Lookahead grows with speed so fast sections are read early and hairpins
    // are not cut. Lower skill looks less far ahead — that alone produces a
    // recognisably clumsier line.
    const look = clamp(5.5 + Math.abs(speed) * (0.42 + this.skill * 0.18), 6, 30);
    line.point(d + look, _tgt);
    // apply the lane bias in the corridor frame at the lookahead station
    const li = line.index(d + look);
    const limit = Math.max(0.6, line.half[li] - 1.4);
    const lineOff = line.off[li];
    const bias = clamp(lineOff + this.lane, -limit, limit) - lineOff;
    _tgt.x += line.bx[li] * bias;
    _tgt.y += line.by[li] * bias;
    _tgt.z += line.bz[li] * bias;

    const desired = Math.atan2(_tgt.x - k.position.x, _tgt.z - k.position.z);
    const heading = Math.atan2(k.forward.x, k.forward.z);
    let err = wrapPi(desired - heading);

    const lat = line.lateralOf(k.position.x, k.position.y, k.position.z, k.t);
    const cross = lat - (line.offsetAt(d) + bias);

    const dErr = clamp((err - this.prevErr) / Math.max(dt, 1e-3), -8, 8);
    this.prevErr = err;
    this.iErr = clamp(this.iErr + err * dt, -0.4, 0.4);

    // Cross-track: being at a *greater* lateral than the line means being
    // displaced toward +binormal, and closing that gap means increasing yaw,
    // which is a positive steer. Pure pursuit alone leaves a standing offset
    // through long constant-radius corners; this is what removes it.
    let steer = err * 2.35 + dErr * 0.10 + this.iErr * 0.30 + cross * 0.045;

    // reversing out of a wall: invert so the correction is not fighting itself
    if (speed < -0.5) steer = -steer;

    // ---- imperfection ------------------------------------------------------
    // Two incommensurate sines: a slow drift off-line and a faster twitch.
    // Never enough to unsettle the kart, always enough that no two frames of
    // a replay look mechanically identical.
    const n1 = Math.sin(time * this.noiseRate + this.noisePhase);
    const n2 = Math.sin(time * this.noiseRate * 2.73 + this.noisePhase * 1.7);
    const noiseAmp = 0.075 * (1.25 - this.skill);
    steer += (n1 * 0.7 + n2 * 0.3) * noiseAmp;
    if (this.mistake === Mistake.Wobble) {
      steer += Math.sin(time * 9.5 + this.noisePhase) * 0.30;
    }

    steer = clamp(steer, -1, 1);
    // A rack is not instantaneous and neither is a human. Smoothing here is
    // what stops the AI looking like it is being driven by a solver.
    this.steerSmooth += (steer - this.steerSmooth) * Math.min(1, dt * 16);
    cmd.steer = clamp(this.steerSmooth, -1, 1);

    // ---- drift -------------------------------------------------------------
    cmd.drift = this.updateDrift(k, d, speed, cross, dt);
    if (this.driftEntry > 0 && k.driftDir === 0) {
      // flick it in: the chassis needs a loaded rack when the hop lands
      cmd.steer = clamp(cmd.steer + this.driftSide * 0.45, -1, 1);
    }

    // ---- speed -------------------------------------------------------------
    // The profile already contains the braking ramps, so the target is simply
    // the profile a short way ahead — plus a floor from what is under us now.
    const reactSpan = clamp(Math.abs(speed) * 0.35, 4, 22);
    let target = Math.min(line.speedAt(d), line.minSpeed(d, reactSpan));
    target *= band;
    // personal ceiling: even a perfect line is driven a little short of it
    target *= 0.90 + this.skill * 0.11;
    if (this.mistake === Mistake.LateBrake) target *= 1.16;
    if (k.stunTime > 0) target = 0;

    const over = speed - target;
    if (over > 2.2) {
      cmd.brake = clamp((over - 2.2) * 0.22, 0, 1);
      cmd.throttle = 0;
    } else if (over > 0.4) {
      cmd.brake = 0;
      // coast rather than stamping off the throttle — keeps the kart settled
      cmd.throttle = clamp(1 - over * 0.5, 0.25, 1);
    } else {
      cmd.brake = 0;
      cmd.throttle = 1;
    }
    // Never coast out of a corner: the exit is where lap time is made.
    if (k.driftDir !== 0 || k.boostTime > 0) { cmd.throttle = 1; cmd.brake = 0; }

    // ---- unstick -----------------------------------------------------------
    // Beached on a kerb or nose-in to a wall: reverse out rather than sitting
    // there with the throttle pinned looking broken.
    if (Math.abs(speed) < 1.6 && k.stunTime <= 0) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 1.4) {
      cmd.throttle = 0;
      cmd.brake = 1;
      cmd.drift = false;
      cmd.steer = -cmd.steer * 0.6;
      if (this.stuckT > 3.0) this.stuckT = 0;
    }

    // ---- items -------------------------------------------------------------
    this.decideItem(k, karts, d, dt, held, heldCount, towed);
  }

  // --------------------------------------------------------------------------

  private rollMistake() {
    const r = hash01((this.kart.id + 1) * 977 + Math.floor(this.nextMistake * 1000) + 7);
    // A better driver makes rarer and shorter mistakes, never none at all.
    const gap = 10 + this.skill * 26;
    this.nextMistake = gap * (0.55 + r);
    if (r > 0.72 - this.skill * 0.25) return; // most rolls are a non-event
    if (r < 0.28) { this.mistake = Mistake.Wobble; this.mistakeT = 0.5 + r; }
    else if (r < 0.52) { this.mistake = Mistake.LateBrake; this.mistakeT = 1.1; }
    else { this.mistake = Mistake.NoDrift; this.mistakeT = 1.8; }
  }

  /**
   * Lane bias in metres, positive = shift right. Rivals push you sideways,
   * hazards push you harder, and the corridor limit is respected by the caller.
   */
  private updateLane(
    k: IKart,
    karts: readonly IKart[],
    hazards: readonly HazardLike[],
    d: number,
    dt: number,
  ) {
    let want = 0;
    const line = this.line;
    // `fwd x up`, NOT `up x fwd`: this must point the same way as the track's
    // binormal (SurfaceProbe's +lateral) or every avoidance push is inverted
    // and the field steers into each other instead of around.
    _right.crossVectors(k.forward, UP);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();

    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k) continue;
      _rel.subVectors(o.position, k.position);
      if (Math.abs(_rel.y) > 3) continue;      // different level of the circuit
      const ahead = _rel.dot(k.forward);
      if (ahead < -2 || ahead > 26) continue;
      const side = _rel.dot(_right);
      if (Math.abs(side) > 5.5) continue;
      // closer and more square-on = stronger push
      const prox = 1 - clamp(ahead / 26, 0, 1);
      const push = (2.6 + this.aggression * 1.2) * prox * (side > 0 ? -1 : 1);
      // An aggressive driver commits to one side instead of splitting the
      // difference between two rivals, which is what causes the classic
      // "AI wobbles between two karts and hits both" look.
      want += push * (1 - Math.abs(side) / 5.5);
    }

    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      if (h.owner === k.id) continue;
      _rel.set(h.x - k.position.x, h.y - k.position.y, h.z - k.position.z);
      if (Math.abs(_rel.y) > 3) continue;
      const ahead = _rel.dot(k.forward);
      if (ahead < 0 || ahead > 34) continue;
      const side = _rel.dot(_right);
      const clear = h.r + 1.5;
      if (Math.abs(side) > clear + 2.5) continue;
      const prox = 1 - clamp(ahead / 34, 0, 1);
      want += (side > 0 ? -1 : 1) * (clear + 1.2 - Math.abs(side)) * prox * 2.2;
    }

    // Blocking: when leading, sit on the inside line so a rival has to go the
    // long way round. The inside of a corner is on the sign(curvature) side.
    if (k.place === 1 && this.aggression > 0.5) {
      want += Math.sign(line.curvAt(d) || 1) * 0.6 * this.aggression;
    }

    this.laneTarget = clamp(want, -6, 6);
    // Bias moves at a believable rate — a kart cannot teleport across the road.
    const rate = Math.min(1, dt * 2.6);
    this.lane += (this.laneTarget - this.lane) * rate;
    // and it decays back to the racing line when nothing is in the way
    if (Math.abs(this.laneTarget) < 0.05) this.lane *= 1 - Math.min(1, dt * 1.6);
  }

  /**
   * Drift is worth it when the corner is long and tight enough to bank at
   * least a tier-1 mini-turbo. Entering one straightens the kart's line, so
   * the decision is made on the corner *ahead*, not the one under the wheels.
   */
  private updateDrift(k: IKart, d: number, speed: number, cross: number, dt: number): boolean {
    if (this.mistake === Mistake.NoDrift || k.stunTime > 0 || speed < 9) {
      this.driftHold = false;
      this.driftEntry = 0;
      return false;
    }

    const line = this.line;
    const peak = line.peakCurv(d, clamp(speed * 0.45, 8, 22));
    const tight = Math.abs(peak);

    if (this.driftHold) {
      if (k.driftDir !== 0) this.driftEntry = 0;
      else this.driftEntry -= dt;

      const exit = Math.abs(line.peakCurv(d, 16));
      // Running wide is the signal a human reads to straighten up and stop
      // trying to be a hero; without it a missed apex compounds into the grass.
      const wide = Math.abs(cross) > 4.5;
      // Hold until the corner genuinely opens up, then release to cash the
      // mini-turbo onto the exit — bailing early throws the whole charge away.
      if (exit < 0.0072 || wide || (this.driftEntry <= 0 && k.driftDir === 0)) {
        this.driftHold = false;
        this.driftCool = 0.4;
        return false;
      }
      return true;
    }

    if (this.driftCool <= 0 && tight > DRIFT_MIN_CURV && speed > 12 && k.boostTime <= 0) {
      this.driftHold = true;
      // steer sign that turns into this corner: +curvature turns toward -yaw
      this.driftSide = -Math.sign(peak);
      // The chassis only bites if the rack is loaded when the hop lands, so
      // the entry deliberately over-steers for a moment. This is exactly what
      // a player does — you flick it in, you do not ease it in.
      this.driftEntry = 0.5;
      return true;
    }
    return false;
  }

  /**
   * Item policy. Deliberately not optimal: an AI that never wastes a shell is
   * miserable to race against. Reaction delay, range checks and a coin-flip on
   * marginal shots keep it human.
   */
  private decideItem(
    k: IKart,
    karts: readonly IKart[],
    d: number,
    dt: number,
    held: ItemKind,
    count: number,
    towed: ItemKind,
  ) {
    const cmd = this.cmd;
    if (held === ItemKind.None && towed === ItemKind.None) {
      this.lastKind = ItemKind.None;
      this.carryT = 0;
      return;
    }
    if (towed !== ItemKind.None) {
      this.carryT += dt;
    } else {
      this.carryT = 0;
      if (held !== this.lastKind) {
        this.lastKind = held;
        // reaction time — sharper drivers think faster
        this.itemDelay = 0.35 + (1 - this.skill) * 1.1 + hash01(k.id * 31 + held) * 0.6;
      }
      if (this.itemDelay > 0) { this.itemDelay -= dt; return; }
    }

    // --- who is where -------------------------------------------------------
    let aheadKart: IKart | null = null;
    let aheadDist = Infinity;
    let aheadAngle = Math.PI;
    let behindDist = Infinity;
    for (let i = 0; i < karts.length; i++) {
      const o = karts[i];
      if (o === k || o.finished) continue;
      _rel.subVectors(o.position, k.position);
      const dist = _rel.length();
      if (dist < 1e-3 || Math.abs(_rel.y) > 6) continue;
      const along = _rel.dot(k.forward) / dist;
      if (along > 0.25 && dist < aheadDist) {
        aheadDist = dist;
        aheadKart = o;
        aheadAngle = Math.acos(clamp(along, -1, 1));
      } else if (along < -0.2 && dist < behindDist) {
        behindDist = dist;
      }
    }

    const straight = Math.abs(this.line.peakCurv(d, 55)) < 0.009;
    const leading = k.place === 1;
    let fire = false;
    let back = false;

    // --- towing a shield ----------------------------------------------------
    // Not a fire decision: the same button *releases* what is already deployed,
    // and until this existed nobody ever pressed it. A driver that dropped a
    // banana behind itself towed it to the flag, and because a tow occupies the
    // item slot it also never collected another box for the rest of the race.
    if (towed !== ItemKind.None) {
      // A tow is worth something — it blocks a shell coming up the road — so it
      // is spent on a reason, not on a timer. The timer is only the backstop
      // that stops a driver hoarding one all lap while boxes go past.
      const hunted = behindDist < 17;
      const bored = this.carryT > 9 + (1 - this.aggression) * 8;
      switch (towed) {
        case ItemKind.RedShell:
          // Homing: turn it round the moment there is anything to home on.
          if (aheadKart && aheadDist < 85) { fire = true; back = false; }
          else if (hunted || bored) { fire = true; back = true; }
          break;
        case ItemKind.GreenShell:
          if (aheadKart && aheadDist < 34 && aheadAngle < 0.20) { fire = true; back = false; }
          else if (hunted || bored) { fire = true; back = true; }
          break;
        default:
          // Banana, bomb: dropping it is the whole point. On the apex if we can
          // manage it — a banana on the racing line through a corner is worth
          // several thrown down a straight.
          if (hunted || (bored && !straight) || this.carryT > 16) { fire = true; back = true; }
          break;
      }
      if (fire) {
        cmd.useItem = true;
        cmd.itemBackwards = back;
        this.lastKind = ItemKind.None;
        this.carryT = 0;
        this.itemDelay = 0.4;
      }
      return;
    }

    switch (held) {
      case ItemKind.Mushroom:
      case ItemKind.TripleMushroom:
        // Spend a boost where it converts: a straight, on the ground, not
        // already boosting. A weaker driver is happy to waste one.
        fire = k.boostTime <= 0 && !k.airborne &&
          (straight || this.skill < 0.65) && Math.abs(k.forwardSpeed) > 8;
        // a spare shroom is the cheapest way out of the rough
        if (count > 1) fire = fire || k.surface === Surface.OffTrack || k.surface === Surface.Sand;
        break;

      case ItemKind.GreenShell:
        if (aheadKart && aheadDist < 34 && aheadAngle < 0.20) fire = true;
        else if (behindDist < 26 || (leading && this.skill > 0.6)) { fire = true; back = true; }
        break;

      case ItemKind.RedShell:
        // Homing, so the angle matters far less than the range.
        if (aheadKart && aheadDist < 85) fire = true;
        else if (leading && behindDist < 22) { fire = true; back = true; }
        break;

      case ItemKind.Banana:
        // Bananas are worth more behind you than thrown; only a straggler with
        // nobody near bothers to lob one forward.
        //
        // "Worth more behind you" used to be a comment above `fire = true`,
        // which threw it away instantly regardless. Deploying it *is* still the
        // right move — behind you it becomes a tow, and a tow is a live shield
        // — but there is no hurry, and a driver that hangs on to it for a beat
        // reads as one that knows what it is for.
        fire = behindDist < 60 || leading || !straight || this.aggression > 0.55;
        back = behindDist < 45 || leading || this.skill > 0.5;
        break;

      case ItemKind.Star:
        fire = !leading || behindDist < 30 || straight;
        break;

      case ItemKind.Bolt:
        fire = !leading;
        break;

      case ItemKind.Bomb:
        if (aheadKart && aheadDist < 42 && aheadAngle < 0.30) fire = true;
        else if (behindDist < 20) { fire = true; back = true; }
        break;
    }

    if (fire) {
      cmd.useItem = true;
      cmd.itemBackwards = back;
      this.lastKind = ItemKind.None;
      this.itemDelay = 0.4;
    }
  }
}

// =============================================================================
//  Field — owns the line, the drivers and the rubber band
// =============================================================================

/** peak catch-up / leash acceleration, m/s^2 — see `beginFrame` */
const ASSIST_CATCHUP = 0.85;
const ASSIST_LEASH = 0.6;

export class AIField {
  readonly line = new RacingLine();
  private drivers = new Map<number, AIDriver>();
  private bands = new Map<number, number>();
  private assists = new Map<number, number>();
  private hazards: readonly HazardLike[] = [];

  init(ctx: Ctx, karts: readonly IKart[]) {
    this.line.build(ctx.track);
    for (const k of karts) {
      this.drivers.set(k.id, new AIDriver(k, this.line, k.id + 1));
      this.bands.set(k.id, 1);
      this.assists.set(k.id, 0);
    }
  }

  setHazards(h: readonly HazardLike[]) {
    this.hazards = h;
  }

  driver(k: IKart): AIDriver {
    return this.drivers.get(k.id)!;
  }

  reset() {
    for (const d of this.drivers.values()) d.reset();
    for (const key of this.bands.keys()) {
      this.bands.set(key, 1);
      this.assists.set(key, 0);
    }
  }

  /**
   * Rubber band, recomputed once a frame for the whole field.
   *
   * Two levers, both restrained, and neither applied to the player:
   *
   *  - `band` scales the target speed, which only bites in the corners. On a
   *    circuit this fast that is a handful of seconds a lap, so on its own it
   *    does very little — which is exactly why the second lever exists.
   *  - `assist` is a small longitudinal acceleration, well under half of the
   *    aerodynamic drag at speed, applied through the sanctioned `launch`
   *    command. Read it as a slipstream for the chasers and dirty air for the
   *    leader: it shifts the equilibrium top speed by a few percent, it does
   *    NOT touch `boostTime`, so nothing lights up, and a kart being helped
   *    still has to actually drive the corner.
   *
   * Neither can rescue a driver who is off the road, and neither is enough to
   * overturn a genuinely quick lap. It only stops the field being strung out
   * over half a lap by the final tour.
   */
  beginFrame(karts: readonly IKart[], player: IKart, dt: number) {
    let leadDist = -Infinity;
    for (const k of karts) if (k.raceDistance > leadDist) leadDist = k.raceDistance;

    for (const k of karts) {
      if (k.isPlayer) continue;
      const gapToLead = leadDist - k.raceDistance;
      const gapToPlayer = player ? k.raceDistance - player.raceDistance : 0;
      const leading = gapToLead < 1;

      let band = 1;
      let assist = 0;

      // catch-up: nothing inside 30 m, saturating at 110 m adrift
      const behind = clamp((gapToLead - 30) / 80, 0, 1);
      band += behind * 0.05;
      assist += behind * ASSIST_CATCHUP;

      // leash: only the actual leader, and only once genuinely clear ahead
      if (leading) {
        const clear = clamp((gapToPlayer - 40) / 110, 0, 1);
        band -= clear * 0.04;
        assist -= clear * ASSIST_LEASH;
      }

      const prev = this.bands.get(k.id) ?? 1;
      // slew-limited so a lap-counter flip cannot snap everyone's pace at once
      this.bands.set(k.id, prev + clamp(band - prev, -dt * 0.3, dt * 0.3));
      const pa = this.assists.get(k.id) ?? 0;
      this.assists.set(k.id, pa + clamp(assist - pa, -dt * 1.2, dt * 1.2));
    }
  }

  /** Longitudinal assist for this kart, m/s^2. Race applies it as an impulse. */
  assistFor(k: IKart): number {
    return this.assists.get(k.id) ?? 0;
  }

  drive(ctx: Ctx, k: IKart, dt: number, karts: readonly IKart[], racing: boolean): DriveCmd {
    const drv = this.drivers.get(k.id)!;
    const held = ctx.items.held(k);
    // `towing` is a detail of the concrete item system rather than part of the
    // published `IItems` surface, so it is asked for structurally: a driver
    // that cannot see its own tow rope simply never decides to let go, which is
    // the old behaviour and safe.
    const towed = (ctx.items as Partial<Towable>).towing?.(k) ?? ItemKind.None;
    drv.update(
      ctx, dt, karts, this.hazards,
      this.bands.get(k.id) ?? 1,
      held.kind, held.count, racing, towed,
    );
    return drv.cmd;
  }
}
