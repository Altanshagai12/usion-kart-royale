/**
 * ============================================================================
 *  CHASE CAMERA — spring-arm rig
 * ============================================================================
 *  The camera is a gameplay system, not a transform copier.
 *
 *   - It rides a critically-damped spring arm behind the kart, with separate
 *     smoothing constants for the eye (weighty) and the aim point (stiffer, so
 *     the kart stays framed). Every filter in here is either the analytic
 *     critically-damped solution or a substepped harmonic oscillator, so the
 *     response is identical at 30, 60 and 144 Hz. There is not one raw
 *     per-frame lerp constant anywhere in this file.
 *
 *   - The arm follows the direction of TRAVEL, not the direction the chassis
 *     points. During a drift it stays behind the velocity heading, so the kart
 *     visibly slides sideways across the frame. That single detail is most of
 *     what makes a kart racer read as a kart racer.
 *
 *   - A drift is a composition, not a rotation. On top of the travel heading
 *     the rig yaws its aim into the corner, slides laterally toward the outside
 *     of the slide and leans harder with every mini-turbo tier, so the kart is
 *     thrown a sixth of the frame off centre with the exit opening in front of
 *     it. Same kart, same corner, unmistakably different frame.
 *
 *   - It rolls with the road: the up vector chases the banked track normal
 *     with deliberate lag and a clamped magnitude, so the 20 degree coastal
 *     curve tilts the horizon instead of leaving it stubbornly level. The gain
 *     is deliberately *partial* — a rig glued 1:1 to the road plane renders a
 *     banked corner as a level frame with level trackside furniture, which is
 *     the one thing a banked corner must never look like.
 *
 *   - It finds the view. Every frame it asks the track how far the ground falls
 *     away on each side; where there is a drop (the cliff traverse, the banked
 *     coastal 180, the bridge over the inlet) the rig lifts and pitches down so
 *     the bay, the drop and the skyline enter frame instead of twenty-six
 *     metres of tarmac and a strip of haze. This is derived from the terrain,
 *     not from a hand-written table of t ranges, so it follows the layout if
 *     the layout moves.
 *
 *   - It reacts. FOV opens with speed, punches on boost and rubber-bands back;
 *     the arm lengthens and drops at speed; landings dip, braking pitches the
 *     nose down, impacts kick and shake.
 *
 *   - It never clips. The arm is swept against walls, terrain and the tunnel
 *     bore, pulled in hard on a hit and let back out slowly.
 *
 *  Zero allocation in lateUpdate: every vector, quaternion, matrix and track
 *  sample used per frame is module scope or owned by the instance.
 * ============================================================================
 */
import * as THREE from 'three';
import { BASE_TOP_SPEED, RaceState, type Ctx, type IKart, type System, type TrackSample } from '../types';

// ---------------------------------------------------------------------------
//  Tuning
// ---------------------------------------------------------------------------

const FOV_BASE = 60;
/** Vertical FOV is derived from this reference aspect whenever the frame is
 *  narrower, so a tall window widens the lens instead of cropping the road. */
const REF_ASPECT = 16 / 9;

const ARM_DIST = 6.9;        // metres behind the pivot at rest
const ARM_DIST_SPEED = 2.5;  // extra length at full speed
const ARM_HEIGHT = 3.02;     // metres above the pivot at rest
const ARM_HEIGHT_SPEED = -0.5;
const PIVOT_UP = 0.62;       // the arm hangs off a point above the chassis COM
const AIM_UP = 1.26;

const POS_SMOOTH = 0.155;    // eye spring — the "weight" of the rig
const AIM_SMOOTH = 0.095;    // aim spring — stiffer, keeps the kart framed
const UP_SMOOTH = 0.40;      // banking lag

/**
 * Fraction of the road's tilt the camera adopts.
 *
 * This wants to be well under 1. Trackside furniture is planted along the road
 * normal, so on a 20 degree bank the palms, signs and fence posts are already
 * leaning 20 degrees with the surface; a rig that also adopts 20 degrees
 * renders every one of them bolt upright and the corner reads as a straight.
 * At 0.68 the horizon still swings a decisive 13.6 degrees on the coastal 180
 * *and* the kart and the furniture visibly lean 6.4 the other way, so the frame
 * carries the bank twice over. If the world ever plants trackside props along
 * world up instead of the road normal, this can go back toward 0.85.
 */
const ROLL_GAIN = 0.68;
const MAX_ROLL = 0.42;       // ~24 degrees — bank plus the drift lean, no more

// --- drift framing -------------------------------------------------------
/** peak yaw of the aim into the corner, radians (~14 deg at full tier) */
const DRIFT_YAW = 0.245;
/** lateral shift of the eye, metres, toward the outside of the slide */
const DRIFT_RIG_LAT = 0.85;
/** extra lean, radians: base plus per-tier, ~4.0 to 7.4 degrees */
const DRIFT_ROLL = 0.070;
const DRIFT_ROLL_TIER = 0.058;

// --- vista: how the rig reacts to ground falling away beside the road ----
/** how far past the road edge the terrain is interrogated, metres */
const VISTA_PROBE = 26;
/** drop, in metres, that counts as no view / as a full view */
const VISTA_MIN = 2.0;
const VISTA_MAX = 13.0;
/**
 * Extra arm height over a full drop. Sized off the geometry it has to beat:
 * on a 20 degree bank with a 13 m half-width the outer kerb crest stands 4.5 m
 * above the centreline, so a 3 m eye is *below* the lip of the corner it is
 * driving and the bay behind it cannot be in frame at any pitch. 5.8 m clears
 * the crest with a usable wedge of sea beyond it.
 */
const VISTA_HEIGHT = 2.75;
const VISTA_DIST = 0.6;      // and a touch further back so it isn't top-down
const VISTA_AIM_UP = 1.0;    // aim rises less than the eye -> ~7 deg of pitch
/** lean the eye out over the drop — the cheapest metre of sightline there is */
const VISTA_EYE_LAT = 1.6;

const CAM_RADIUS = 0.55;     // collision probe radius
const GROUND_CLEAR = 0.85;   // minimum metres between the eye and the ground
const ARM_RECOVER = 0.55;    // seconds for the arm to ease back out after a hit

const INTRO_DUR = 3.55;      // countdown fly-in length
const FINISH_HOLD = 2.3;     // seconds the finish-line cut holds trackside

// ---------------------------------------------------------------------------
//  Module scratch — nothing below here allocates once init() has run
// ---------------------------------------------------------------------------

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _chaseEye = new THREE.Vector3();
const _chaseAim = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _face = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _euler = new THREE.Euler();

/** Track.sample() accepts a scratch target; the ITrack interface hides it. */
type SampleFn = (t: number, out?: TrackSample) => TrackSample;

type CamMode = 'chase' | 'wide' | 'close';

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }

function smootherstep(x: number) {
  x = clamp(x, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Analytic critically-damped spring. Unconditionally stable for any dt,
 * settles without overshoot, and the response is a pure function of
 * `smoothTime` rather than of the frame rate.
 */
function damp1(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + om * change) * dt;
  vel.v = (vel.v - om * temp) * e;
  return target + (change + temp) * e;
}

/** Vector form of the above; writes through `cur` and `vel`. */
function damp3(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  const om = 2 / Math.max(1e-4, smoothTime);
  const x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x, cy = cur.y - target.y, cz = cur.z - target.z;
  const tx = (vel.x + om * cx) * dt, ty = (vel.y + om * cy) * dt, tz = (vel.z + om * cz) * dt;
  vel.set((vel.x - om * tx) * e, (vel.y - om * ty) * e, (vel.z - om * tz) * e);
  cur.set(target.x + (cx + tx) * e, target.y + (cy + ty) * e, target.z + (cz + tz) * e);
}

/**
 * Harmonic oscillator with a free damping ratio — this is the one that is
 * allowed to overshoot, which is what gives the FOV its rubber-band settle
 * after a boost and the landing dip its bounce. Semi-implicit Euler,
 * substepped so a long frame can never make it explode.
 */
class Osc {
  v = 0;
  vel = 0;
  step(target: number, omega: number, zeta: number, dt: number) {
    const steps = Math.min(8, Math.max(1, Math.ceil(dt * omega * 3)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel += (-2 * zeta * omega * this.vel - omega * omega * (this.v - target)) * h;
      this.v += this.vel * h;
    }
    return this.v;
  }
  kick(a: number) { this.vel += a; }
}

/** Two detuned sines: dense enough to read as shake, smooth enough not to alias. */
function shakeNoise(t: number, seed: number) {
  return Math.sin(t * 27.3 + seed * 4.7) * 0.62 + Math.sin(t * 44.1 + seed * 11.3) * 0.38;
}

// ---------------------------------------------------------------------------

export class ChaseCamera implements System {
  // --- rig state ---------------------------------------------------------
  private eye = new THREE.Vector3();
  private eyeVel = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private aimVel = new THREE.Vector3();
  /** true when the current pose is bolted to the kart rather than to the world */
  private followsKart = true;
  private arm = new THREE.Vector3(0, 0, 1);   // smoothed unit heading, world space
  private armVel = new THREE.Vector3();
  private upSm = new THREE.Vector3(0, 1, 0);  // smoothed camera up
  private upVel = new THREE.Vector3();
  private ready = false;

  // --- scalar filters ----------------------------------------------------
  private driftSigned = 0;   // -1 .. 1, smoothed drift direction
  private driftAmt = 0;      // |driftSigned|
  private driftVel = { v: 0 };
  private tierAmt = 0;       // 0..1, smoothed mini-turbo charge tier
  private tierVel = { v: 0 };
  private vista = 0;         // 0..1, how much the ground falls away beside us
  private vistaVel = { v: 0 };
  private vistaSide = 0;     // signed: +1 the drop is to the right, -1 left
  private vistaSideVel = { v: 0 };
  private brakeAmt = 0;
  private brakeVel = { v: 0 };
  private lookAmt = 0;
  private lookVel = { v: 0 };
  private lookHold = 0;
  private armFrac = 1;                        // collision-limited arm fraction
  private armFracVel = { v: 0 };
  private fovOsc = new Osc();
  private dip = new Osc();                    // landing bob
  private kick = new Osc();                   // impact punch along the view axis
  private surge = new Osc();                  // boost arm-pull

  // --- shake -------------------------------------------------------------
  private trauma = 0;
  private traumaDecay = 3.3;

  // --- cinematics --------------------------------------------------------
  private introT = 0;
  private finishT = 0;
  private orbit = 0;
  private prevState: RaceState = RaceState.Menu;
  private cutPos = new THREE.Vector3();
  private cutTangent = new THREE.Vector3();

  // --- environment -------------------------------------------------------
  private fovAspectMul = 1;
  private sampleFn: SampleFn | null = null;
  private smp: TrackSample | null = null;
  private smpV: TrackSample | null = null;
  private blockers: THREE.Mesh[] = [];
  private blockerBox = new THREE.Box3();
  private hasBlockers = false;
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private unsub: (() => void) | null = null;

  // =======================================================================

  init(ctx: Ctx) {
    ctx.camera.near = 0.2;
    ctx.camera.far = 3000;
    this.fovOsc.v = FOV_BASE;
    ctx.camera.fov = FOV_BASE;
    ctx.camera.updateProjectionMatrix();
    this.resize(ctx.width, ctx.height);

    // Bound once. The cast exposes Track's scratch-target overload, which
    // ITrack omits; an implementation that ignores the second argument still
    // returns a correct sample, it just costs one allocation.
    this.sampleFn = (ctx.track.sample as SampleFn).bind(ctx.track);
    this.smp = ctx.track.sample(0);
    // A second scratch sample: the corner-lead lookup in poseChase and the
    // terrain interrogation in updateVista are both live in the same frame and
    // must not write into each other.
    this.smpV = ctx.track.sample(0);

    // Only the tunnel bore needs a real ray test. Walls and terrain are
    // resolved through the track's own analytic queries, which are an order of
    // magnitude cheaper than triangle soup.
    ctx.track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh || (m as any).isInstancedMesh) return;
      if (!/tunnel|bore/i.test(m.name)) return;
      m.updateWorldMatrix(true, false);
      this.blockers.push(m);
      this.blockerBox.union(new THREE.Box3().setFromObject(m));
    });
    this.hasBlockers = this.blockers.length > 0;
    // Margin so the gate opens before the eye is actually inside the bore.
    if (this.hasBlockers) this.blockerBox.expandByScalar(16);

    // Screen shake already arrives through ctx.shake() -> addShake(); these
    // handlers only add the rig displacements nobody else can produce.
    this.unsub = ctx.bus.on((e) => {
      if (!('kart' in e) || !e.kart?.isPlayer) return;
      switch (e.type) {
        case 'land':
          // `impact` is a descent rate in m/s: a drop off the bridge thumps,
          // a kerb hop barely registers.
          this.dip.kick(-clamp(e.impact * 0.055, 0, 1.15));
          break;
        case 'collide':
          this.kick.kick(clamp(e.impulse * 0.035, 0, 1.4));
          break;
        case 'boost':
          this.surge.kick(-4.6 - e.tier * 0.9);
          break;
        case 'hit':
          this.kick.kick(0.9);
          break;
      }
    });
  }

  dispose() { this.unsub?.(); this.unsub = null; }

  addShake(a: number, s = 0.3) {
    this.trauma = Math.min(1, this.trauma + a);
    // A longer requested duration means a slower bleed-off, not a timer — so
    // overlapping requests compose instead of the last one winning.
    this.traumaDecay = Math.min(this.traumaDecay, clamp(1 / Math.max(0.08, s), 0.6, 6));
  }

  resize(w: number, h: number) {
    const aspect = h > 0 ? w / h : REF_ASPECT;
    // Hor+ : hold the horizontal field constant below 16:9.
    const base = THREE.MathUtils.degToRad(FOV_BASE);
    this.fovAspectMul = aspect >= REF_ASPECT
      ? 1
      : (2 * Math.atan(Math.tan(base * 0.5) * REF_ASPECT / aspect)) / base;
    this.fovAspectMul = clamp(this.fovAspectMul, 1, 1.45);
  }

  // =======================================================================
  //  Frame
  // =======================================================================

  lateUpdate(ctx: Ctx, dt: number) {
    const k = ctx.race?.player;
    if (!k || !this.sampleFn) return;
    dt = Math.max(1e-4, dt);

    const mode: CamMode = ((window as any).__camMode as CamMode) || 'chase';
    const state = ctx.race.state;

    // --- speed / drift / brake scalars ------------------------------------
    const speed = Math.abs(k.forwardSpeed);
    const sp = clamp(speed / BASE_TOP_SPEED, 0, 1.25);
    // Signed, so the roll and the framing offset ease *out* through zero when
    // the drift releases instead of snapping the instant driftDir clears.
    const drifting = k.driftDir !== 0 && !k.airborne;
    // Snap in, ooze out: the composition should change the instant the slide
    // catches and unwind slowly enough that the release reads as a release.
    this.driftSigned = damp1(this.driftSigned, drifting ? k.driftDir : 0, this.driftVel, drifting ? 0.15 : 0.40, dt);
    this.driftAmt = Math.abs(this.driftSigned);
    // Tier drives the *depth* of the lean, so a purple slide is framed harder
    // than a blue one and the tier change is felt in the rig, not just in the
    // spark colour.
    this.tierAmt = damp1(this.tierAmt, drifting ? clamp(k.driftTier / 3, 0, 1) : 0, this.tierVel, 0.22, dt);
    const braking = ctx.input.state.brake > 0.4 && k.forwardSpeed > 5 ? 1 : 0;
    this.brakeAmt = damp1(this.brakeAmt, braking, this.brakeVel, 0.2, dt);

    // lookBack is specified as a rising edge but plays naturally as a held
    // button; a short hold window makes both spellings behave sensibly.
    if (ctx.input.state.lookBack) this.lookHold = 0.3; else this.lookHold -= dt;
    const wantLook = this.lookHold > 0 && state === RaceState.Racing && mode === 'chase' ? 1 : 0;
    this.lookAmt = damp1(this.lookAmt, wantLook, this.lookVel, 0.19, dt);

    // --- ground frame and heading -----------------------------------------
    const probe = ctx.track.probe(k.position, k.t);
    this.updateUp(k, probe.normal, mode, dt);
    this.updateHeading(k, dt);
    this.updateVista(ctx, k, dt);

    // --- pose --------------------------------------------------------------
    const cinematic = this.buildPose(ctx, k, mode, state, sp, dt);

    // --- springs -----------------------------------------------------------
    if (!this.ready) {
      this.ready = true;
      this.eye.copy(_eye); this.aim.copy(_aim);
      this.eyeVel.set(0, 0, 0); this.aimVel.set(0, 0, 0);
    }
    const eyeSmooth = cinematic ? 0.34 : POS_SMOOTH + this.lookAmt * 0.05;
    const aimSmooth = cinematic ? 0.26 : AIM_SMOOTH;

    // A critically-damped spring chasing a *moving* target settles with a
    // standing error of |v| * smoothTime — at 30 m/s that silently added 4.6 m
    // to the arm and 2.8 m to the aim, so the rig geometry the constants above
    // describe was only ever true at a standstill (the kart shrank to a third
    // of its parked size on a straight). Feeding the target's own velocity
    // forward cancels the standing error exactly while leaving the transient
    // response — the "weight" of the rig — untouched.
    if (this.followsKart) {
      _lead.copy(k.velocity);
      _eye.addScaledVector(_lead, eyeSmooth);
      _aim.addScaledVector(_lead, aimSmooth);
    }

    damp3(this.eye, _eye, this.eyeVel, eyeSmooth, dt);
    damp3(this.aim, _aim, this.aimVel, aimSmooth, dt);

    // --- impact offsets, applied outside the springs so they read as hits ---
    const dip = this.dip.step(0, 15, 0.42, dt);
    const kick = this.kick.step(0, 21, 0.36, dt);
    _tmp.copy(this.eye).addScaledVector(this.upSm, dip * 6.0);
    _dir.copy(this.aim).sub(this.eye);
    const armLen = _dir.length();
    if (armLen > 1e-3) _dir.multiplyScalar(1 / armLen); else _dir.set(0, 0, -1);
    _tmp.addScaledVector(_dir, -kick * 8.0);

    // Floor of last resort: whatever the springs and cinematics decided, the
    // eye never ends up inside the ground or under the sea.
    const under = ctx.track.probe(_tmp, k.t);
    if (_tmp.y < under.y + GROUND_CLEAR) _tmp.y = under.y + GROUND_CLEAR;

    ctx.camera.position.copy(_tmp);

    // --- orientation --------------------------------------------------------
    _up.copy(this.upSm);
    _m.lookAt(_tmp, this.aim, _up);
    ctx.camera.quaternion.setFromRotationMatrix(_m);

    this.applyShake(ctx, dt);
    this.applyFov(ctx, mode, sp, dt);
  }

  // =======================================================================
  //  Up vector — banking with lag and a hard roll ceiling
  // =======================================================================

  private updateUp(k: IKart, groundNormal: THREE.Vector3, mode: CamMode, dt: number) {
    _up.copy(groundNormal);
    if (_up.y < 0.15) _up.copy(WORLD_UP); // nonsense normal (cliff face) — bail out
    if (k.airborne) _up.lerp(WORLD_UP, 0.65);

    // Adopt only part of the road's tilt: a camera that banks 1:1 with a 20
    // degree curve throws away the horizon as a readable reference.
    let gain = ROLL_GAIN;
    if (mode === 'wide') gain = 0.18;        // establishing plates want a level horizon
    else if (mode === 'close') gain = 0.95;
    _up.lerp(WORLD_UP, 1 - gain).normalize();

    // Extra lean into the drift, deepening with the mini-turbo tier. On top of
    // a banked corner this is what takes the horizon past twenty degrees on the
    // money shot; on a flat one it is the only thing that says "sideways".
    if (this.driftAmt > 1e-3) {
      const lean = (DRIFT_ROLL + DRIFT_ROLL_TIER * this.tierAmt) * this.driftSigned;
      _q.setFromAxisAngle(this.arm, lean);
      _up.applyQuaternion(_q);
    }

    // Clamp roll measured about the view axis, so slope (which is pitch, not
    // roll) is never penalised by the limit.
    _right.crossVectors(this.arm, WORLD_UP);
    if (_right.lengthSq() > 1e-6) {
      _right.normalize();
      _tmp2.crossVectors(_right, this.arm).normalize(); // the "level up" in this plane
      const roll = Math.atan2(_up.dot(_right), _up.dot(_tmp2));
      const limited = clamp(roll, -MAX_ROLL, MAX_ROLL);
      if (limited !== roll) {
        const pitchPart = _up.dot(this.arm);
        _up.copy(_tmp2).multiplyScalar(Math.cos(limited))
          .addScaledVector(_right, Math.sin(limited))
          .addScaledVector(this.arm, pitchPart)
          .normalize();
      }
    }

    damp3(this.upSm, _up, this.upVel, mode === 'chase' ? UP_SMOOTH : 0.3, dt);
    this.upSm.normalize();
  }

  // =======================================================================
  //  Heading — direction of travel, not direction of facing
  // =======================================================================

  private updateHeading(k: IKart, dt: number) {
    // Project onto the plane of the camera up so slope never leaks into yaw.
    _face.copy(k.forward);
    _face.addScaledVector(this.upSm, -_face.dot(this.upSm));
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();

    _vel.copy(k.velocity);
    _vel.addScaledVector(this.upSm, -_vel.dot(this.upSm));
    const vlen = _vel.length();

    let w = 0;
    if (vlen > 2) {
      _vel.multiplyScalar(1 / vlen);
      // Reversing, spun out or shelled: the velocity heading would whip the
      // camera through 180 degrees, so it is only trusted while it broadly
      // agrees with where the chassis points.
      const agree = _vel.dot(_face);
      if (agree > 0.2) {
        w = clamp((vlen - 2) / 5, 0, 1)
          * (0.34 + 0.56 * this.driftAmt)
          * clamp((agree - 0.2) / 0.35, 0, 1);
      }
    }
    if (w > 0) _face.lerp(_vel, Math.min(w, 0.92)).normalize();

    // Look-back is applied later as a yaw offset on the settled arm: springing
    // the direction vector itself through an antipode is degenerate, and
    // orbiting the arm is what gives the whip-round its arc.
    damp3(this.arm, _face, this.armVel, 0.12 + this.driftAmt * 0.05, dt);
    // Insurance against a degenerate spin-out passing through the antipode.
    if (this.arm.lengthSq() < 1e-6) { this.arm.copy(_face); this.armVel.set(0, 0, 0); }
    this.arm.normalize();
  }

  // =======================================================================
  //  Vista — "is there anything to look at out there?"
  // =======================================================================
  //
  //  The round-one coastal frames failed on geometry, not on dressing: an eye
  //  three metres above a twenty-six metre wide banked road sees tarmac to the
  //  horizon and nothing else, because the road plane subtends the entire lower
  //  frame and the outer kerb is above the eyeline. No amount of scenery fixes
  //  that; the rig has to get above the road.
  //
  //  So: measure. Probe the ground a fixed distance outboard of each kerb and
  //  compare it with the centreline. A drop means there is a view — the sea off
  //  the cliff traverse, the bay inside the banked 180, the inlet under the
  //  bridge — and the rig lifts, leans toward the drop and pitches down until
  //  it is in frame. Rising ground (the village cutting, the tunnel bore) reads
  //  as no drop and changes nothing, which is exactly right: those sections
  //  want the low, fast, close-in rig they already have.
  //
  //  Two probes and one centreline sample per frame. The karts do thirty-two.

  private updateVista(ctx: Ctx, k: IKart, dt: number) {
    let drop = 0;
    let side = this.vistaSide >= 0 ? 1 : -1;

    // Never lift inside the bore: the roof is 4.5 m up and the sweep would just
    // yank the arm straight back in, which pumps.
    if (!(this.hasBlockers && this.blockerBox.containsPoint(k.position))) {
      const s = this.sampleFn!(k.t, this.smpV!);
      const out = s.halfWidth + VISTA_PROBE;

      _tmp.copy(s.pos).addScaledVector(s.binormal, out);
      const dropR = s.pos.y - ctx.track.probe(_tmp, k.t).y;
      _tmp.copy(s.pos).addScaledVector(s.binormal, -out);
      const dropL = s.pos.y - ctx.track.probe(_tmp, k.t).y;

      drop = Math.max(dropL, dropR);
      side = dropR >= dropL ? 1 : -1;
    }

    const v = smootherstep((drop - VISTA_MIN) / (VISTA_MAX - VISTA_MIN));
    // Slow, and near-symmetric: this is a landscape-scale quantity, so the rig
    // must neither bob over a gully nor snap back down at a bridge abutment.
    this.vista = damp1(this.vista, v, this.vistaVel, v > this.vista ? 0.75 : 0.8, dt);
    this.vistaSide = damp1(this.vistaSide, side * v, this.vistaSideVel, 0.75, dt);
  }

  // =======================================================================
  //  Pose selection. Fills _eye / _aim; returns true for cinematic framing,
  //  which runs looser springs.
  // =======================================================================

  private buildPose(ctx: Ctx, k: IKart, mode: CamMode, state: RaceState, sp: number, dt: number): boolean {
    // Harness modes win outright: they are portfolio frames, not gameplay, and
    // must not be hijacked by a race-state cinematic.
    // Poses that are rigidly bolted to the kart need the spring's standing
    // tracking error cancelled (see the lead in lateUpdate); poses anchored to
    // the world — the finish cut, the results orbit — must not have it.
    this.followsKart = true;
    if (mode === 'wide') { this.poseWide(ctx, k); return true; }
    if (mode === 'close') { this.poseClose(k); return true; }

    // Arm the fly-in on the way *into* the countdown, not every frame of it.
    if (state === RaceState.Countdown && this.prevState !== RaceState.Countdown) this.introT = 0;
    if (state === RaceState.Finished && this.prevState !== RaceState.Finished) {
      this.finishT = 0;
      this.captureFinishCut(ctx, k);
    }
    if (state === RaceState.Results && this.prevState !== RaceState.Results) this.orbit = 0;
    this.prevState = state;

    // The live chase pose is always solved: cinematics blend onto it, and the
    // handover out of one has to be seamless.
    this.poseChase(ctx, k, sp, dt);
    _chaseEye.copy(_eye);
    _chaseAim.copy(_aim);

    if (state === RaceState.Results || state === RaceState.Menu) {
      this.poseOrbit(ctx, k, state === RaceState.Menu, dt);
      this.followsKart = false;
      return true;
    }
    if (state === RaceState.Finished) {
      this.finishT += dt;
      this.poseFinish(k);
      this.followsKart = false;
      return true;
    }

    // The countdown pose holds through the GO frame and releases the instant
    // the player is actually driving, so the intro can never eat the race.
    const introLive = state === RaceState.Countdown
      || (this.introT < INTRO_DUR && state === RaceState.Racing && Math.abs(k.forwardSpeed) < 2.5);
    if (this.introT < INTRO_DUR) {
      this.introT += introLive ? dt : dt * 2.6; // released early — hurry the settle
      const p = clamp(this.introT / INTRO_DUR, 0, 1);
      if (p < 1) { this.poseIntro(k, p); this.followsKart = false; return true; }
    }
    return false;
  }

  // --- the chase pose proper ---------------------------------------------

  private poseChase(ctx: Ctx, k: IKart, sp: number, dt: number) {
    const surge = this.surge.step(0, 13, 0.5, dt);

    _pivot.copy(k.position).addScaledVector(this.upSm, PIVOT_UP);

    // Look-back swings the whole rig around the pivot rather than flipping the
    // aim, so the return is a real move instead of a cut.
    _dir.copy(this.arm);
    if (this.lookAmt > 1e-3) {
      _q.setFromAxisAngle(this.upSm, Math.PI * this.lookAmt);
      _dir.applyQuaternion(_q);
    }

    // surge < 0 on boost entry (arm snaps in), then overshoots long as it
    // settles — the classic "the world pulls away from you" kick.
    // Looking back is the one time the view must not be hoisted over a cliff:
    // the point of it is the kart behind you.
    const vista = this.vista * (1 - this.lookAmt);
    let dist = ARM_DIST + ARM_DIST_SPEED * sp + surge * 2.4 - this.brakeAmt * 0.85 - this.lookAmt * 1.4
      + VISTA_DIST * vista;
    let height = ARM_HEIGHT + ARM_HEIGHT_SPEED * sp - this.brakeAmt * 0.3 + this.lookAmt * 0.25
      + VISTA_HEIGHT * vista;
    if (k.airborne) height += 0.35;

    // Sweep the arm for obstructions and pull it in on a hit. Recovery is
    // deliberately slower than the pull, so the rig never pumps.
    const hit = this.sweepArm(ctx, k, _pivot, _dir, dist, height);
    if (hit < this.armFrac) { this.armFrac = hit; this.armFracVel.v = 0; }
    else this.armFrac = damp1(this.armFrac, hit, this.armFracVel, ARM_RECOVER, dt);
    const f = clamp(this.armFrac, 0.28, 1);

    _eye.copy(_pivot).addScaledVector(_dir, -dist * f).addScaledVector(this.upSm, height * f);

    // The frame's own right, reused by every offset below.
    _right.crossVectors(_dir, this.upSm);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();

    // Lean the eye out over the drop. A metre is nothing to the rig and it is
    // the difference between the outer kerb hiding the bay and the bay opening
    // up beyond it.
    if (vista > 1e-3) _eye.addScaledVector(_right, this.vistaSide * (1 - this.lookAmt) * VISTA_EYE_LAT);

    // Slide the rig toward the outside of the slide. Small, but it means the
    // parallax between kart and road changes when the state changes instead of
    // the kart simply rotating in place.
    if (this.driftAmt > 1e-3) _eye.addScaledVector(_right, -this.driftSigned * DRIFT_RIG_LAT);

    // Both offsets are lateral, so the arm sweep (which only walks the arm
    // itself) cannot see them. One analytic wall query resolves it — and it is
    // a resolve, not a bail-out, so the composition survives a brush past a
    // guardrail instead of snapping back to centre.
    if (vista > 1e-3 || this.driftAmt > 1e-3) {
      const w = ctx.track.collideWalls(_eye, CAM_RADIUS, k.t);
      if (w) _eye.add(w.push);
    }

    // Aim ahead along the arm, plus a lead into the coming corner so the apex
    // is on screen before the kart gets there.
    _aim.copy(k.position).addScaledVector(this.upSm, AIM_UP - this.brakeAmt * 0.42);
    _aim.addScaledVector(_dir, (5.2 + 4.6 * sp) * (1 - 0.35 * this.lookAmt));

    if (this.lookAmt < 0.5) {
      const ahead = (24 + 30 * sp) / Math.max(1, ctx.track.length);
      const s = this.sampleFn!(k.t + ahead, this.smp!);
      _tmp.copy(s.pos).addScaledVector(s.normal, 1.6);
      _aim.lerp(_tmp, 0.2 * (1 - this.lookAmt * 2));
    }

    // The aim rises by less than the eye did, so the net effect of the vista
    // lift is roughly six degrees of downward pitch: the horizon climbs out of
    // dead centre into the upper third and the drop-away fills what it leaves.
    if (vista > 1e-3) _aim.addScaledVector(this.upSm, VISTA_AIM_UP * vista);

    // Push the kart off frame centre while it is sideways. This is a yaw, not a
    // fixed nudge: the offset has to scale with how far away the aim point is,
    // or it is worth three degrees on a straight and nothing at all at speed.
    // Yawing the aim *into* the corner throws the kart toward the outside of
    // frame and opens the exit up in front of it — the drift composition, and
    // also the more useful one to actually drive.
    if (this.driftAmt > 1e-3) {
      const aimDist = _aim.distanceTo(_eye);
      const yaw = DRIFT_YAW * this.driftSigned * (0.55 + 0.45 * this.tierAmt);
      _aim.addScaledVector(_right, Math.tan(yaw) * aimDist);
    }
  }

  /**
   * Usable fraction of the desired arm. Walls and terrain go through the
   * track's analytic queries; the tunnel bore is the one thing that needs a
   * real ray, and that is gated on the bore's own bounds so the cost is only
   * paid on the eight percent of the lap that is underground.
   */
  private sweepArm(ctx: Ctx, k: IKart, pivot: THREE.Vector3, dir: THREE.Vector3, dist: number, height: number) {
    let frac = 1;

    const SAMPLES = 5;
    for (let i = 1; i <= SAMPLES; i++) {
      const s = i / SAMPLES;
      _tmp.copy(pivot).addScaledVector(dir, -dist * s).addScaledVector(this.upSm, height * s);
      const pr = ctx.track.probe(_tmp, k.t);
      // Rising ground behind (village climb, cliff cutting) or a barrier the
      // eye is low enough to hit: stop at the previous station.
      if (_tmp.y < pr.y + GROUND_CLEAR || ctx.track.collideWalls(_tmp, CAM_RADIUS, k.t)) {
        frac = (i - 1) / SAMPLES;
        break;
      }
    }

    if (this.hasBlockers && this.blockerBox.containsPoint(pivot)) {
      _tmp.copy(dir).multiplyScalar(-dist).addScaledVector(this.upSm, height);
      const len = _tmp.length();
      if (len > 1e-3) {
        _tmp.multiplyScalar(1 / len);
        this.ray.set(pivot, _tmp);
        this.ray.near = 0.1;
        this.ray.far = len;
        this.hits.length = 0;
        this.ray.intersectObjects(this.blockers, false, this.hits);
        if (this.hits.length) {
          frac = Math.min(frac, Math.max(0, (this.hits[0].distance - CAM_RADIUS) / len));
        }
      }
    }

    return frac;
  }

  // --- countdown fly-in ---------------------------------------------------

  private poseIntro(k: IKart, p: number) {
    // Two beats. First a held front-quarter of the whole grid — the shot that
    // sells the field — then a sweep around the flank that lands exactly on
    // the chase pose as the lights go out.
    const front = smootherstep(clamp(p / 0.6, 0, 1));
    const settle = smootherstep(clamp((p - 0.58) / 0.42, 0, 1));

    const ang = -0.55 - front * 0.62 - settle * 1.65; // front quarter -> flank -> rear
    const dist = 17.5 - front * 5.0 - settle * 2.0;
    const height = 7.6 - front * 2.6 - settle * 1.2;

    _q.setFromAxisAngle(this.upSm, ang);
    _dir.copy(this.arm).applyQuaternion(_q);

    _eye.copy(k.position).addScaledVector(_dir, dist).addScaledVector(this.upSm, height);
    // Look back down the grid, past pole, at the field behind.
    _aim.copy(k.position).addScaledVector(this.upSm, 1.1).addScaledVector(this.arm, -7.5);

    // Ease home so the handover to gameplay has no seam at all.
    _eye.lerp(_chaseEye, settle);
    _aim.lerp(_chaseAim, settle);
  }

  // --- finish line --------------------------------------------------------

  private captureFinishCut(ctx: Ctx, k: IKart) {
    const s = this.sampleFn!(k.t + 0.004, this.smp!);
    const pr = ctx.track.probe(k.position, k.t);
    const side = pr.lateral >= 0 ? 1 : -1; // stand on the outside of the kart
    this.cutPos.copy(s.pos)
      .addScaledVector(s.binormal, side * (s.halfWidth + 8.5))
      .addScaledVector(s.normal, 3.4);
    this.cutTangent.copy(s.tangent);
    // A cut is a cut: teleport the springs rather than sweeping across the map.
    this.eye.copy(this.cutPos);
    this.aim.copy(k.position);
    this.eyeVel.set(0, 0, 0);
    this.aimVel.set(0, 0, 0);
    this.ready = true;
  }

  private poseFinish(k: IKart) {
    if (this.finishT < FINISH_HOLD) {
      // Trackside, dollying gently with the kart so it doesn't just leave frame.
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, this.finishT * 3.2);
      _aim.copy(k.position).addScaledVector(this.upSm, 0.9);
    } else {
      // Then rise into a wide victory-lap chase.
      const w = smootherstep((this.finishT - FINISH_HOLD) / 1.6);
      _tmp.copy(k.position).addScaledVector(this.arm, -11.5).addScaledVector(this.upSm, 5.6);
      _eye.copy(this.cutPos).addScaledVector(this.cutTangent, FINISH_HOLD * 3.2).lerp(_tmp, w);
      _aim.copy(k.position).addScaledVector(this.upSm, 0.9).addScaledVector(this.arm, 4.0 * w);
    }
  }

  // --- results / menu orbit ----------------------------------------------

  private poseOrbit(ctx: Ctx, player: IKart, wide: boolean, dt: number) {
    const winner = (ctx.race.standings && ctx.race.standings[0]) || player;
    this.orbit += dt * (wide ? 0.13 : 0.2);

    const dist = wide ? 13.5 : 8.4;
    const height = wide ? 4.6 : 2.9;
    _q.setFromAxisAngle(WORLD_UP, this.orbit);
    _dir.set(0, 0, 1).applyQuaternion(_q);

    _eye.copy(winner.position)
      .addScaledVector(_dir, dist)
      .addScaledVector(WORLD_UP, height + Math.sin(this.orbit * 1.7) * 0.35);
    _aim.copy(winner.position).addScaledVector(WORLD_UP, wide ? 1.4 : 0.95);
  }

  // --- harness modes ------------------------------------------------------

  private poseWide(ctx: Ctx, k: IKart) {
    // High three-quarter establishing plate: far enough back that the ribbon of
    // circuit reads diagonally through frame, yawed off the racing axis so it
    // isn't a symmetric postcard.
    _q.setFromAxisAngle(WORLD_UP, 0.62);
    _dir.copy(this.arm).applyQuaternion(_q);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1); else _dir.normalize();

    _eye.copy(k.position).addScaledVector(_dir, -80).addScaledVector(WORLD_UP, 30);

    // Aim well ahead of the player rather than at them: the resulting ~14
    // degree pitch puts the sea horizon in the upper third, so the plate keeps
    // its band of golden-hour sky instead of staring at the floor.
    const ahead = 70 / Math.max(1, ctx.track.length);
    const s = this.sampleFn!(k.t + ahead, this.smp!);
    _aim.copy(k.position).lerp(s.pos, 0.4).addScaledVector(WORLD_UP, 4);
  }

  private poseClose(k: IKart) {
    // The classic front three-quarter hero angle, locked to the chassis rather
    // than to the travel heading so the model always presents the same face.
    _face.copy(k.forward);
    _face.addScaledVector(this.upSm, -_face.dot(this.upSm));
    if (_face.lengthSq() < 1e-6) _face.copy(this.arm); else _face.normalize();

    // Stand on the side the ground *rises*, so whatever is behind the kart is
    // the view rather than two hundred metres of receding tarmac. On the cliff
    // traverse that swaps a brown post and a band of haze for the drop and the
    // sea; where the ground is level either side it lands exactly where it did.
    const side = this.vistaSide >= 0 ? 1 : -1;
    _q.setFromAxisAngle(this.upSm, 0.66 * side);
    _dir.copy(_face).applyQuaternion(_q);

    // Lifting the eye tips the background down out of the sky and into the
    // landscape — the same trick as the chase rig's vista lift, at hero scale.
    const lift = 1.02 + 0.62 * this.vista;
    _eye.copy(k.position).addScaledVector(_dir, 3.9 + 0.35 * this.vista).addScaledVector(this.upSm, lift);
    _aim.copy(k.position).addScaledVector(this.upSm, 0.5).addScaledVector(_face, 0.25);
  }

  // =======================================================================
  //  Shake + FOV
  // =======================================================================

  private applyShake(ctx: Ctx, dt: number) {
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return; }
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    if (this.trauma <= 0) { this.traumaDecay = 3.3; return; }

    // Squared falloff: small knocks stay subtle, big ones hit hard.
    const a = this.trauma * this.trauma;
    const t = ctx.time;

    // Rotational shake carries most of the weight. Translating the eye alone
    // reads as a camera bug; rotating it reads as an impact.
    _euler.set(
      shakeNoise(t, 1) * a * 0.028,
      shakeNoise(t, 2) * a * 0.032,
      shakeNoise(t, 3) * a * 0.045,
    );
    _q.setFromEuler(_euler);
    ctx.camera.quaternion.multiply(_q);

    _tmp.set(shakeNoise(t, 4) * a * 0.16, shakeNoise(t, 5) * a * 0.14, 0)
      .applyQuaternion(ctx.camera.quaternion);
    ctx.camera.position.add(_tmp);
  }

  private applyFov(ctx: Ctx, mode: CamMode, sp: number, dt: number) {
    let target: number;
    let omega = 11;
    let zeta = 0.62;

    if (mode === 'wide') { target = 44; omega = 8; zeta = 1; }
    else if (mode === 'close') { target = 34; omega = 8; zeta = 1; }
    else if (ctx.race.state === RaceState.Results || ctx.race.state === RaceState.Menu) {
      target = 40; omega = 7; zeta = 1;
    } else if (this.introT < INTRO_DUR) {
      // Long lens on the fly-in, opening out to the gameplay field of view.
      target = 46 + (FOV_BASE - 46) * smootherstep(this.introT / INTRO_DUR);
      omega = 7; zeta = 1;
    } else {
      target = clamp(
        FOV_BASE
        + sp * 7.2               // speed opens the frame
        + ctx.fovPunch * 0.95    // boost punch, pre-smoothed upstream
        + this.lookAmt * 3.0     // slightly wider over the shoulder
        - this.brakeAmt * 2.2,   // and tighter under braking
        40, 84,
      );
    }
    target *= this.fovAspectMul;

    // Underdamped on purpose in gameplay: the FOV rubber-bands back after a
    // boost, and that overshoot is what sells the release.
    const fov = this.fovOsc.step(target, omega, zeta, dt);
    if (Math.abs(fov - ctx.camera.fov) > 0.015) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
  }
}
