/**
 * ============================================================================
 *  Four-corner raycast suspension.
 * ============================================================================
 *  Each wheel hangs from a hardpoint on the chassis and probes the world with
 *  `ITrack.probe`. The probe is a heightfield query, so we turn it into a
 *  ground *plane* (point + normal) once per frame and intersect the wheel's
 *  down-ray against that plane every substep. That is both cheaper than
 *  re-probing at 120 Hz and stable, because the plane does not flicker between
 *  substeps the way a raw height sample can.
 *
 *  Roll and pitch are real degrees of freedom here, not cosmetic tweens. Each
 *  spring force generates a torque about the roll and pitch axes, the inertial
 *  couple from lateral/longitudinal acceleration acting at the centre of mass
 *  height pushes back, and the dampers resist the rate. The result is that
 *  weight genuinely transfers to the outside wheels in a corner and to the
 *  front under braking — which the tyre model then reads as load.
 *
 *  Sign conventions (body space, +X right, +Y up, +Z forward):
 *    roll  > 0  =>  right-hand side of the chassis moves DOWN
 *    pitch > 0  =>  nose moves DOWN
 *  so the downward displacement of the chassis at a hardpoint p is
 *  `p.x * roll + p.z * pitch`, which is exactly the extra spring compression.
 * ============================================================================
 */
import * as THREE from 'three';
import { SURFACE_PROPS, Surface, type ITrack } from '../types';

export interface SuspensionConfig {
  wheelRadius: number;
  /** spring free length between hardpoint and wheel centre at full droop */
  restLength: number;
  /** compression at static equilibrium — sets ride height and stiffness */
  restCompression: number;
  /** compression at which the bump stop starts biting */
  maxCompression: number;
  /** how far past rest length the wheel may hang in the air */
  maxDroop: number;
  /** half the track width (lateral hardpoint offset) */
  halfTrack: number;
  /** half the wheelbase (longitudinal hardpoint offset) */
  halfBase: number;
  /** centre-of-mass height above the roll/pitch axes */
  comHeight: number;
  dampingCompress: number;
  dampingRebound: number;
  /**
   * Anti-roll bar rate, N.m per radian per kg of chassis. The four springs
   * alone cannot hold the chassis flat: at a lateral load of only ~1.5 g the
   * inside pair reaches zero compression, after which the outside pair is
   * pinned at half the kart's weight and the restoring torque stops growing —
   * so roll runs away to its limit and the kart corners on two wheels. The bar
   * adds roll stiffness without touching ride height, which is exactly what it
   * does on a real chassis.
   */
  antiRoll: number;
}

export const DEFAULT_SUSPENSION: SuspensionConfig = {
  wheelRadius: 0.36,
  restLength: 0.3,
  restCompression: 0.12,
  maxCompression: 0.24,
  maxDroop: 0.13,
  halfTrack: 0.66,
  halfBase: 0.8,
  comHeight: 0.34,
  dampingCompress: 0.44,
  dampingRebound: 0.66,
  antiRoll: 58,
};

export interface Wheel {
  readonly index: number;
  readonly front: boolean;
  /** -1 = left, +1 = right */
  readonly side: number;
  /** hardpoint in body space */
  readonly attach: THREE.Vector3;
  /** hardpoint in world space, refreshed once per frame */
  readonly attachWorld: THREE.Vector3;

  // --- cached ground plane under this wheel ---
  readonly groundPoint: THREE.Vector3;
  readonly groundNormal: THREE.Vector3;
  groundValid: boolean;
  surface: Surface;
  groundT: number;
  edgeRatio: number;

  // --- live state ---
  /** metres of spring compression; negative means drooping */
  compression: number;
  compressionVel: number;
  /** vertical load in newtons that the tyre model gets to use */
  load: number;
  contact: boolean;
  bottomed: boolean;
  /** world-space contact patch, used for the tyre force lever arm */
  readonly contactPoint: THREE.Vector3;

  // --- visual state, consumed by Kart ---
  steerAngle: number;
  spinAngle: number;
  spinRate: number;
  /** 0..1 friction-circle saturation from the tyre solve, for VFX */
  slip: number;
  /** rest Y of the visual wheel node, sampled from the model at build time */
  restY: number;
}

// --- module scratch: no allocation inside any method below --------------------
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

function makeWheel(index: number, cfg: SuspensionConfig): Wheel {
  const front = index < 2;
  const side = index % 2 === 0 ? -1 : 1;
  return {
    index,
    front,
    side,
    attach: new THREE.Vector3(
      side * cfg.halfTrack,
      cfg.restLength + cfg.wheelRadius - cfg.restCompression,
      (front ? 1 : -1) * cfg.halfBase,
    ),
    attachWorld: new THREE.Vector3(),
    groundPoint: new THREE.Vector3(),
    groundNormal: new THREE.Vector3(0, 1, 0),
    groundValid: false,
    surface: Surface.Road,
    groundT: 0,
    edgeRatio: 0,
    compression: cfg.restCompression,
    compressionVel: 0,
    load: 0,
    contact: true,
    bottomed: false,
    contactPoint: new THREE.Vector3(),
    steerAngle: 0,
    spinAngle: 0,
    spinRate: 0,
    slip: 0,
    restY: cfg.wheelRadius,
  };
}

/**
 * Deterministic spatial noise for surface rumble. Keyed to world position
 * rather than to time so that rough ground feels like ground you are driving
 * over, not like a camera shake bolted on afterwards.
 */
function rumbleAt(x: number, z: number): number {
  return (
    Math.sin(x * 4.7 + z * 3.1) * 0.5 +
    Math.sin(x * 11.3 - z * 7.9) * 0.31 +
    Math.sin(x * 23.7 + z * 19.1) * 0.19
  );
}

export class Suspension {
  readonly wheels: Wheel[];
  readonly cfg: SuspensionConfig;

  // roll/pitch degrees of freedom, radians
  roll = 0;
  rollVel = 0;
  pitch = 0;
  pitchVel = 0;

  /** load-weighted average of the contact normals — the chassis' "up" target */
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  /** number of wheels touching down last solve */
  contacts = 4;
  /** sum of the spring forces along the chassis up axis, newtons */
  totalForce = 0;
  /** deepest travel past the bump stop this solve, metres */
  bottomDepth = 0;
  /** surface under the most heavily loaded wheel */
  dominantSurface: Surface = Surface.Road;
  /** load-weighted blend of the per-wheel surface constants */
  gripMul = 1;
  dragMul = 1;
  maxSpeedMul = 1;

  private stiffness = 8000;
  private rollInertia = 60;
  private pitchInertia = 120;
  private mass = 200;

  constructor(cfg: SuspensionConfig = DEFAULT_SUSPENSION) {
    this.cfg = cfg;
    this.wheels = [0, 1, 2, 3].map((i) => makeWheel(i, cfg));
  }

  /**
   * Ride height must not depend on kart weight, so the spring rate is derived
   * from the mass rather than being a constant. Heavier karts get stiffer
   * springs and therefore identical stance but more resistance to roll.
   */
  setMass(mass: number, gravity: number) {
    this.mass = mass;
    this.stiffness = (mass * gravity) / (4 * this.cfg.restCompression);
    this.rollInertia = mass * 0.55 * 0.55;
    this.pitchInertia = mass * 0.78 * 0.78;
  }

  reset() {
    this.roll = this.rollVel = this.pitch = this.pitchVel = 0;
    this.groundNormal.set(0, 1, 0);
    this.contacts = 4;
    for (const w of this.wheels) {
      w.compression = this.cfg.restCompression;
      w.compressionVel = 0;
      w.load = (this.mass * 20) / 4;
      w.contact = true;
      w.bottomed = false;
      w.slip = 0;
      w.spinRate = 0;
      w.groundValid = false;
    }
  }

  /**
   * Once per frame: place the hardpoints in the world and sample the ground
   * plane beneath each of them. `quat` must be the terrain-aligned chassis
   * orientation WITHOUT the roll/pitch degrees of freedom applied — those are
   * folded in analytically during `solve`, and double-counting them would make
   * the suspension fight itself.
   */
  probeGround(track: ITrack, position: THREE.Vector3, quat: THREE.Quaternion, hintT: number) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.attachWorld.copy(w.attach).applyQuaternion(quat).add(position);
      const probe = track.probe(w.attachWorld, hintT);
      const ny = probe.normal.y;
      if (!Number.isFinite(probe.y) || !Number.isFinite(ny)) {
        w.groundValid = false;
        continue;
      }
      w.groundValid = true;
      w.surface = probe.surface;
      w.groundT = probe.t;
      w.edgeRatio = probe.edgeRatio;
      w.groundNormal.copy(probe.normal);
      if (w.groundNormal.lengthSq() < 1e-6) w.groundNormal.set(0, 1, 0);
      else w.groundNormal.normalize();

      const rumble = SURFACE_PROPS[probe.surface].rumble;
      const jitter = rumble > 0 ? rumble * rumbleAt(w.attachWorld.x, w.attachWorld.z) : 0;
      w.groundPoint.set(w.attachWorld.x, probe.y + jitter, w.attachWorld.z);
    }
  }

  /**
   * One substep of spring/damper + roll/pitch integration.
   *
   * @param aLat   lateral acceleration in body space (+ = toward the right)
   * @param aLong  longitudinal acceleration (+ = forward)
   * @returns total spring force along `up`, newtons
   */
  solve(
    dt: number,
    position: THREE.Vector3,
    quat: THREE.Quaternion,
    up: THREE.Vector3,
    aLat: number,
    aLong: number,
    airborneRighting: boolean,
  ): number {
    const cfg = this.cfg;
    const restDist = cfg.restLength + cfg.wheelRadius;
    const maxLoad = this.mass * 260; // hard clamp: a bad probe can never launch a kart
    let total = 0;
    let rollTorque = 0;
    let pitchTorque = 0;
    let contacts = 0;
    let normalWeight = 0;
    let bottom = 0;
    _n.set(0, 0, 0);

    this.dominantSurface = Surface.Road;
    let bestLoad = -1;
    let grip = 0;
    let drag = 0;
    let vmax = 0;
    let propWeight = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const prev = w.compression;

      // Hardpoint follows the chassis; roll/pitch are added analytically below.
      _p.copy(w.attach).applyQuaternion(quat).add(position);
      w.attachWorld.copy(_p);

      let comp: number;
      let dist = restDist + cfg.maxDroop + 1;
      if (w.groundValid) {
        // Ray/plane: distance from the hardpoint down along -up to the ground.
        _d.subVectors(_p, w.groundPoint);
        const denom = Math.max(0.25, up.dot(w.groundNormal));
        dist = _d.dot(w.groundNormal) / denom;
        if (!Number.isFinite(dist)) dist = restDist + cfg.maxDroop + 1;
      }
      comp = restDist - dist + w.attach.x * this.roll + w.attach.z * this.pitch;

      const touching = w.groundValid && comp > -cfg.maxDroop;
      if (comp < -cfg.maxDroop) comp = -cfg.maxDroop;
      else if (comp > cfg.maxCompression + 0.06) comp = cfg.maxCompression + 0.06;

      w.compression = comp;
      w.compressionVel = (comp - prev) / dt;
      w.contact = touching;
      w.bottomed = comp >= cfg.maxCompression;

      if (touching) {
        contacts++;
        const zeta = w.compressionVel >= 0 ? cfg.dampingCompress : cfg.dampingRebound;
        const damping = 2 * zeta * Math.sqrt(this.stiffness * (this.mass * 0.25));
        let f = this.stiffness * comp + damping * w.compressionVel;
        if (w.bottomed) {
          // Progressive bump stop. The force term alone cannot arrest a fast
          // landing without going numerically unstable, so it only shapes the
          // feel — Kart applies a velocity-level constraint using `bottomDepth`
          // to actually stop the chassis. See Kart.substep.
          const over = comp - cfg.maxCompression;
          if (over > bottom) bottom = over;
          f += this.stiffness * (18 * over + 120 * over * over);
          if (w.compressionVel > 0) f += damping * 2 * w.compressionVel;
        }
        if (f < 0) f = 0;
        else if (f > maxLoad) f = maxLoad;
        w.load = f;
        total += f;
        rollTorque -= f * w.attach.x;
        pitchTorque -= f * w.attach.z;

        // contact patch = hardpoint projected down onto the plane
        w.contactPoint.copy(_p).addScaledVector(up, comp - restDist);
        _n.addScaledVector(w.groundNormal, f + 1);
        normalWeight += f + 1;

        const props = SURFACE_PROPS[w.surface];
        const pw = f + 1;
        grip += props.gripMul * pw;
        drag += props.dragMul * pw;
        vmax += props.maxSpeedMul * pw;
        propWeight += pw;
        if (f > bestLoad) {
          bestLoad = f;
          this.dominantSurface = w.surface;
        }
      } else {
        w.load = 0;
        w.contactPoint.copy(_p).addScaledVector(up, -(restDist + cfg.maxDroop));
      }
    }

    this.contacts = contacts;
    this.totalForce = total;
    this.bottomDepth = bottom;

    if (normalWeight > 0) {
      _n.divideScalar(normalWeight);
      if (_n.lengthSq() > 1e-6) this.groundNormal.copy(_n).normalize();
    }
    if (propWeight > 0) {
      this.gripMul = grip / propWeight;
      this.dragMul = drag / propWeight;
      this.maxSpeedMul = vmax / propWeight;
    } else {
      // Airborne: keep whatever we last stood on so the numbers do not pop on
      // landing, but never let a stale off-track penalty apply mid-jump.
      this.gripMul = 1;
      this.dragMul = 1;
    }

    // Inertial couple: tyre forces act at ground level, mass acts at comHeight.
    rollTorque -= this.mass * aLat * cfg.comHeight;
    pitchTorque -= this.mass * aLong * cfg.comHeight;

    const arb = this.mass * cfg.antiRoll;
    rollTorque += -arb * this.roll - this.mass * 2.2 * this.rollVel;

    if (airborneRighting) {
      // Nothing damps the attitude in the air, so add an explicit critically
      // damped return to level. Karts should not tumble.
      const k = 26 * this.rollInertia;
      rollTorque += -this.roll * k - this.rollVel * 2 * Math.sqrt(k * this.rollInertia);
      const kp = 26 * this.pitchInertia;
      pitchTorque += -this.pitch * kp - this.pitchVel * 2 * Math.sqrt(kp * this.pitchInertia);
    }

    this.rollVel += (rollTorque / this.rollInertia) * dt;
    this.pitchVel += (pitchTorque / this.pitchInertia) * dt;
    this.roll += this.rollVel * dt;
    this.pitch += this.pitchVel * dt;

    // A kart up on two wheels reads as broken, not as dynamic.
    const LIM = 0.26;
    if (this.roll > LIM) { this.roll = LIM; if (this.rollVel > 0) this.rollVel = 0; }
    else if (this.roll < -LIM) { this.roll = -LIM; if (this.rollVel < 0) this.rollVel = 0; }
    if (this.pitch > LIM) { this.pitch = LIM; if (this.pitchVel > 0) this.pitchVel = 0; }
    else if (this.pitch < -LIM) { this.pitch = -LIM; if (this.pitchVel < 0) this.pitchVel = 0; }

    if (!Number.isFinite(this.roll) || !Number.isFinite(this.pitch)) {
      this.roll = this.pitch = this.rollVel = this.pitchVel = 0;
    }

    return total;
  }

  /**
   * How far the visual wheel node sits from its modelled rest position.
   * Positive = the wheel has risen into its well because the chassis dropped.
   */
  visualOffset(w: Wheel): number {
    const o = w.compression - this.cfg.restCompression;
    return o < -0.18 ? -0.18 : o > 0.18 ? 0.18 : o;
  }
}
