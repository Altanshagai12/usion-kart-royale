/**
 * ============================================================================
 *  Driver — the figure in the seat, and the rig other systems pose.
 * ============================================================================
 *  Built once and shared: five meshes (torso+legs, arms, helmet, visor,
 *  steering wheel) whose geometry is identical for every racer. Only the
 *  vertex-colour attribute differs per livery.
 *
 *  Local space: origin at the hip point, +Y up, +Z forward (the kart's own
 *  axes). In this game's convention +X is the kart's RIGHT — `Kart.step`
 *  increases yaw for a right turn and a positive yaw sends local +Z toward
 *  world +X, so a right turn banks the driver toward +X.
 *
 *  POSING (physics / VFX drive these; everything is -1..1 and smoothed):
 *      rig.steer  +1 = full right lock   -> wheel + arm counter-steer
 *      rig.lean   +1 = cornering right   -> body and head fall into the turn
 *      rig.pitch  +1 = accelerating, -1 = braking
 *      rig.duck    1 = tucked under boost
 *      rig.apex   +1 = look right toward the apex
 *      rig.jolt(a)     one-shot impact shove
 *      rig.update(dt)  once a frame; it damps toward the targets
 * ============================================================================
 */
import * as THREE from 'three';
import {
  Mesher, Role, kartMaterials, liveryGeometry, mat,
  type Built, type Livery, type Section,
} from './Liveries';

// --- rig constants -----------------------------------------------------------

/** Steering column pivot, in driver-local space, and its rake. */
const COL_POS = new THREE.Vector3(0, 0.46, 0.40);
const COL_RAKE = -0.95; // radians about X: axis ends up 35 deg off vertical
const HEAD_POS = new THREE.Vector3(0, 0.60, -0.01);
const SHOULDER = 0.252;
/** Steering wheel rim radius. The hands are derived FROM this, never beside it. */
const RIM_R = 0.155;
/** Rim tube radius — the fist has to be fatter than this to look wrapped. */
const RIM_TUBE = 0.030;

/** A point on the steering-wheel rim, in hips space. phi = 0 is 12 o'clock. */
function rimPoint(phi: number, col: THREE.Matrix4, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(phi) * RIM_R, 0, Math.cos(phi) * RIM_R).applyMatrix4(col);
}

/** Superellipse outline; p ~3.4 traces a softly rounded rectangle. */
function squircle(t: number, p: number, out: [number, number]): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  out[0] = Math.sign(c) * Math.pow(Math.abs(c), 2 / p);
  out[1] = Math.sign(s) * Math.pow(Math.abs(s), 2 / p);
  return out;
}

/**
 * A patch of a sphere whose OUTLINE is a rounded rectangle rather than a
 * lat/long rectangle.
 *
 * This is the whole reason the round-1 visor read as a sticker: a
 * SphereGeometry cut with phiStart/thetaStart has four hard 90-degree corners,
 * and hard corners sitting on a curved surface look printed on however good
 * the material is. `profile` is a list of [outline scale, sphere radius] rings,
 * so one generator makes both the glass (scale 0 -> 1 at a constant radius, a
 * proper cap) and the bezel around it (scale 1 -> 1.2 with the radius rising
 * over a crest and sinking back under the shell, a chamfered rim that catches
 * a specular line off the low sun).
 */
function spherePatch(
  yawHalf: number, pitchMid: number, pitchHalf: number,
  profile: readonly (readonly [number, number])[], cols: number, sharp = 3.4,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const sc: [number, number] = [0, 0];
  for (let r = 0; r < profile.length; r++) {
    const s = profile[r][0];
    const R = profile[r][1];
    for (let j = 0; j <= cols; j++) {
      squircle((j / cols) * Math.PI * 2, sharp, sc);
      const u = sc[0] * yawHalf * s;
      const v = pitchMid + sc[1] * pitchHalf * s;
      const cv = Math.cos(v);
      pos.push(Math.sin(u) * cv * R, Math.sin(v) * R, Math.cos(u) * cv * R);
      uv.push(0.5 + sc[0] * s * 0.5, 0.5 + sc[1] * s * 0.5);
    }
  }
  for (let r = 0; r < profile.length - 1; r++) {
    for (let j = 0; j < cols; j++) {
      const a = r * (cols + 1) + j;
      // j walks clockwise as seen from outside the shell (u>0 lands on the
      // viewer's left), so the outward-facing winding is the reversed one.
      idx.push(a, a + cols + 2, a + 1, a, a + cols + 1, a + cols + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

interface DriverGeo {
  torso: Built;
  arms: Built;
  helmet: Built;
  visor: Built;
  wheel: Built;
}

let _geo: DriverGeo | null = null;
const _perLivery = new Map<number, { torso: THREE.BufferGeometry; arms: THREE.BufferGeometry; helmet: THREE.BufferGeometry; wheel: THREE.BufferGeometry }>();

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function torsoAndLegs(): Built {
  const m = new Mesher();

  // --- torso: a chamfered tub, leaned forward, wider at the shoulders ------
  const body: Section[] = [
    { z: 0.00, hw: 0.20, hh: 0.145, r: 0.08 },
    { z: 0.14, hw: 0.225, hh: 0.155, r: 0.085 },
    { z: 0.30, hw: 0.248, hh: 0.165, r: 0.09 },
    { z: 0.41, hw: 0.262, hh: 0.158, r: 0.095 },
    { z: 0.47, hw: 0.215, hh: 0.135, r: 0.09 },
  ];
  m.addLoft(body, Role.Suit, mat(0, 0.02, -0.02, -Math.PI / 2 + 0.17), { corner: 3, capStart: 0.06, capEnd: 0.05, capSeg: 1 });

  // chest panel in the team colour — reads as a race suit, not a blob
  m.addLoft(
    [{ z: 0.05, hw: 0.13, hh: 0.03, r: 0.02 }, { z: 0.30, hw: 0.16, hh: 0.03, r: 0.02 }],
    Role.Base,
    mat(0, 0.02, 0.115, -Math.PI / 2 + 0.17),
    { corner: 2, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
  );
  // --- neck + collar ------------------------------------------------------
  // Round 1 left a 6 cm gap between the top of the tub and the bottom of the
  // helmet: at hero distance you could see sky through the driver's throat,
  // which is the single biggest reason the head read as a floating ball. The
  // neck runs from inside the torso up to inside the helmet, so no pose of the
  // head rig can open the join back up.
  m.addLoft(
    [
      { z: 0.430, hw: 0.108, hh: 0.100, r: 0.048 },
      { z: 0.515, hw: 0.096, hh: 0.090, r: 0.044 },
      { z: 0.605, hw: 0.088, hh: 0.082, r: 0.040 },
    ],
    Role.Plastic,
    mat(0, 0, 0.005, -Math.PI / 2),
    { corner: 2, closeStart: false, capEnd: 0.02, capSeg: 1 },
  );
  // collar ring in the team trim, sitting on the shoulders
  m.addLoft(
    [
      { z: 0.395, hw: 0.134, hh: 0.124, r: 0.058 },
      { z: 0.455, hw: 0.122, hh: 0.113, r: 0.054 },
    ],
    Role.Trim,
    mat(0, 0, 0.005, -Math.PI / 2),
    { corner: 2, closeStart: false, capEnd: 0.022, capSeg: 1 },
  );

  // (shoulder balls now live in `arms()` — see the note there: they have to
  // travel with the counter-steer or the arm tears out of the socket)

  // --- legs: thigh forward, shin down to a boot ---------------------------
  for (const s of [-1, 1]) {
    m.addTube(
      [
        new THREE.Vector3(s * 0.135, 0.03, 0.03),
        new THREE.Vector3(s * 0.155, 0.075, 0.24),
        new THREE.Vector3(s * 0.162, 0.055, 0.44),
      ],
      (t) => 0.105 - t * 0.022,
      8,
      Role.Suit,
    );
    m.addTube(
      [
        new THREE.Vector3(s * 0.162, 0.055, 0.44),
        new THREE.Vector3(s * 0.166, -0.03, 0.55),
        new THREE.Vector3(s * 0.17, -0.10, 0.60),
      ],
      (t) => 0.085 - t * 0.012,
      8,
      Role.Suit,
    );
    // knee pad — a bright chip that catches the sun above the bodywork
    m.addGeometry(new THREE.SphereGeometry(0.085, 6, 5), Role.Base, mat(s * 0.158, 0.085, 0.42, 0, 0, 0, 1, 0.85, 1.15), 1.2);
    // Boot. Fully enclosed by the nose bodywork, so two sections is all it
    // earns — and the heel is left open: it starts 50 mm from the shin tube's
    // end cap, well inside that cap's 62 mm dome, so the 24 triangles the
    // chamfer there was costing could never reach a pixel. They pay for the
    // roll-hoop bracing instead.
    m.addLoft(
      [
        { z: 0.00, hw: 0.075, hh: 0.055, r: 0.03 },
        { z: 0.17, hw: 0.075, hh: 0.040, r: 0.026 },
      ],
      Role.Plastic,
      mat(s * 0.17, -0.14, 0.57, -0.25),
      { corner: 1, closeStart: false, capEnd: 0.03, capSeg: 1 },
    );
  }

  return m.finish();
}

/**
 * Shoulder ball, upper arm, forearm, cuff and fist — per side, in hips space,
 * then baked into the steering column's frame.
 *
 * Two round-1 notes land here and only one of them was about geometry.
 *
 *  - "no forearm geometry between the gloves and the shoulders at all": the
 *    tubes WERE there, but they ran from a shoulder buried inside the torso,
 *    through the torso's own volume, in Role.Suit — which for the red livery
 *    is a dark red against a dark red tub. Two limbs of identical value
 *    crossing in the same depth range read as one mass. So the arm is now
 *    routed OUTBOARD and ABOVE the side rails where it silhouettes cleanly,
 *    and the forearm is in the livery coat rather than the suit, which gives
 *    the limb a hard value break from the torso it crosses.
 *  - "gloves hover 15 cm from a wheel they are not connected to": they were
 *    actually within a centimetre of the rim, but a rounded box floating
 *    *beside* a torus does not read as a grip. The fist is now a fat capsule
 *    swept ALONG the rim tangent and centred on the rim itself, so the wheel
 *    visibly enters and leaves the hand. Both the grip point and the tangent
 *    are derived from RIM_R, so neither can drift if the wheel is retuned.
 *
 * The shoulder ball moved here from the torso: `armRig` counter-steers about
 * the column axis, and a socket that stays behind while the arm swings is a
 * tear. Carried with the arm, it slides over the torso like a real shoulder.
 */
function arms(): Built {
  const m = new Mesher();
  const col = columnMatrix();
  const hub = new THREE.Vector3(0, 0, 0).applyMatrix4(col);
  const wrist = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const fistA = new THREE.Vector3();
  const fistB = new THREE.Vector3();
  const cuffA = new THREE.Vector3();
  const cuffB = new THREE.Vector3();

  for (const s of [-1, 1]) {
    const phi = s * 1.05; // ten-to-two, 60 deg either side of the rim's crown
    rimPoint(phi, col, wrist);
    rimPoint(phi + 0.14, col, pa);
    rimPoint(phi - 0.14, col, pb);
    tan.subVectors(pa, pb).normalize();
    radial.subVectors(wrist, hub).normalize();

    const shoulder = new THREE.Vector3(s * SHOULDER, 0.420, 0.030);
    const elbow = new THREE.Vector3(s * 0.318, 0.370, 0.226);

    // shoulder ball, squashed into a deltoid
    m.addGeometry(
      new THREE.SphereGeometry(0.108, 10, 7),
      Role.Trim,
      mat(shoulder.x, shoulder.y, shoulder.z, 0, 0, 0, 1, 0.92, 1.06),
      1.2,
    );
    // upper arm: out over the side rail, then down to the elbow
    m.addTube(
      [shoulder, new THREE.Vector3(s * 0.300, 0.394, 0.126), elbow],
      (t) => 0.082 - t * 0.020,
      9, Role.Suit,
    );
    // forearm, in the livery coat so the limb separates from the dark tub
    const fore = [
      elbow,
      new THREE.Vector3(s * 0.288, 0.424, 0.318),
      new THREE.Vector3(s * 0.214, 0.482, 0.398),
      new THREE.Vector3(
        THREE.MathUtils.lerp(wrist.x, elbow.x, 0.14),
        THREE.MathUtils.lerp(wrist.y, elbow.y, 0.10),
        THREE.MathUtils.lerp(wrist.z, elbow.z, 0.10),
      ),
    ];
    m.addTube(fore, (t) => 0.064 - t * 0.018, 9, Role.Base);
    // cuff band in the trim colour, right where the sleeve meets the glove
    cuffA.lerpVectors(wrist, fore[2], 0.36);
    cuffB.lerpVectors(wrist, fore[2], 0.08);
    m.addTube([cuffA, cuffB], 0.056, 9, Role.Trim);
    // fist: a fat capsule swept along the rim tangent, sitting ON the rim and
    // nudged a touch outboard so the knuckles stand proud of the tube
    fistA.copy(wrist).addScaledVector(radial, 0.010).addScaledVector(tan, -0.062);
    fistB.copy(wrist).addScaledVector(radial, 0.010).addScaledVector(tan, 0.062);
    m.addTube(
      [fistA, new THREE.Vector3().lerpVectors(fistA, fistB, 0.5), fistB],
      (t) => RIM_TUBE + 0.030 - Math.abs(t - 0.5) * 0.052,
      9, Role.Glove,
    );
  }
  const b = m.finish();
  // Bake into the steering-column frame so the whole assembly can counter-steer
  // about the column axis with a single rotation.y.
  b.geo.applyMatrix4(columnMatrix().invert());
  return b;
}

function columnMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    COL_POS,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(COL_RAKE, 0, 0)),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Steering wheel, authored directly in column-local space (axis = +Y). */
function steeringWheel(): Built {
  const m = new Mesher();
  const R = RIM_R;
  // 18 segments, not 12: at hero distance a 12-gon rim silhouettes as a
  // dodecagon and the hands sit right on top of it.
  const rim = new THREE.TorusGeometry(R, RIM_TUBE, 5, 16);
  rim.rotateX(-Math.PI / 2); // torus axis +Z -> +Y
  m.addGeometry(rim, Role.Plastic, undefined, 1.6);
  // three spokes in the trim colour; the loft runs along +Z so a plain yaw
  // fans them out inside the wheel plane
  for (let i = 0; i < 3; i++) {
    m.addLoft(
      [
        { z: 0.02, hw: 0.028, hh: 0.016, r: 0.008 },
        { z: R - 0.012, hw: 0.020, hh: 0.013, r: 0.006 },
      ],
      Role.Trim,
      mat(0, 0, 0, 0, Math.PI + (i * Math.PI * 2) / 3, 0),
      { corner: 1, capStart: 0.01, capEnd: 0.01, capSeg: 1 },
    );
  }
  // boss with the team badge colour
  m.addLoft(
    [
      { z: -0.022, hw: 0.055, hh: 0.055, r: 0.05 },
      { z: 0.018, hw: 0.052, hh: 0.052, r: 0.048 },
    ],
    Role.Base,
    mat(0, 0, 0, Math.PI / 2),
    { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
  );
  return m.finish();
}

// Eye port: 134 deg of yaw, straddling the helmet equator so the chin bar
// closes under it. Bezel and glass share these so they can never disagree.
const VISOR_YAW = 1.17;
const VISOR_PITCH = 0.13;
const VISOR_HALF = 0.30;
const VISOR_COLS = 22;

/** Full-face helmet, authored in head-local space (origin = neck pivot). */
function helmet(): { helmet: Built; visor: Built } {
  const m = new Mesher();
  const cy = 0.175;
  const shell = mat(0, cy, 0.005, 0, 0, 0, 1.0, 0.98, 1.04);
  // Shell: 24 x 15 rather than 16 x 11. The helmet is roughly 130 px across in
  // the hero framing, so 16 segments puts a visible 8 px chord on the
  // silhouette — and with the Mesher no longer de-indexing primitives it is
  // smooth-shaded now, so the extra rings actually buy curvature rather than
  // just more flat facets.
  m.addGeometry(new THREE.SphereGeometry(0.205, 22, 14), Role.Base, shell, 1.5);
  // crown stripe
  m.addGeometry(
    new THREE.SphereGeometry(0.207, 6, 14, Math.PI / 2 - 0.19, 0.38, 0, Math.PI),
    Role.Trim,
    mat(0, cy, 0.005, 0, 0, 0, 1.0, 0.985, 1.045),
    1.5,
  );
  // chin bar
  m.addLoft(
    [
      { z: -0.05, hw: 0.10, hh: 0.055, r: 0.03 },
      { z: 0.06, hw: 0.115, hh: 0.062, r: 0.035 },
      { z: 0.16, hw: 0.095, hh: 0.055, r: 0.03 },
    ],
    Role.Trim,
    mat(0, cy - 0.10, 0.06, -0.22),
    { corner: 2, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
  );
  // Visor bezel: a rounded-rectangle ring that rises 7 mm proud of the glass
  // and sinks back under the shell on its outer edge. The glass therefore sits
  // in a genuine recess with a chamfered lip around it — and that lip is the
  // element that catches a hard specular line off the low sun, which is what
  // makes the whole assembly read as a shield rather than a decal.
  m.addGeometry(
    spherePatch(VISOR_YAW, VISOR_PITCH, VISOR_HALF, [
      [1.000, 0.2085],
      [1.045, 0.2160],
      [1.105, 0.2148],
      [1.200, 0.2035],
    ], VISOR_COLS),
    Role.Plastic, shell, 1.5,
  );
  // rear aero fin
  m.addLoft(
    [
      { z: 0.0, hw: 0.018, hh: 0.05, r: 0.012 },
      { z: 0.09, hw: 0.014, hh: 0.035, r: 0.01 },
    ],
    Role.Accent,
    mat(0, cy + 0.10, -0.15, 0.55),
    { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
  );
  // brow peak
  m.addLoft(
    [
      { z: 0.0, hw: 0.13, hh: 0.022, r: 0.012 },
      { z: 0.055, hw: 0.115, hh: 0.016, r: 0.01 },
    ],
    Role.Trim,
    mat(0, cy + 0.085, 0.15, -0.5),
    { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
  );

  // The glass itself: a true spherical cap filling the bezel's aperture, at a
  // constant radius so it is optically a piece of a sphere and the reflected
  // sun sweeps across it cleanly as the head turns.
  const v = new Mesher();
  v.addGeometry(
    spherePatch(VISOR_YAW, VISOR_PITCH, VISOR_HALF, [
      [0.00, 0.2085],
      [0.42, 0.2085],
      [0.76, 0.2085],
      [1.00, 0.2085],
    ], VISOR_COLS),
    Role.Plastic, shell, 1,
  );
  return { helmet: m.finish(), visor: v.finish() };
}

function driverGeo(): DriverGeo {
  if (_geo) return _geo;
  const h = helmet();
  _geo = { torso: torsoAndLegs(), arms: arms(), helmet: h.helmet, visor: h.visor, wheel: steeringWheel() };
  return _geo;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

function damp(cur: number, target: number, lambda: number, dt: number) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export class DriverRig {
  readonly root = new THREE.Group();

  // --- pose targets, -1..1 ------------------------------------------------
  steer = 0;
  lean = 0;
  pitch = 0;
  duck = 0;
  apex = 0;

  private hips = new THREE.Group();
  private head = new THREE.Group();
  private column = new THREE.Group();
  private armRig = new THREE.Group();
  private wheelNode = new THREE.Group();

  private sSteer = 0;
  private sLean = 0;
  private sPitch = 0;
  private sDuck = 0;
  private sApex = 0;
  private joltAmt = 0;
  private clock = Math.random() * 10; // desync the idle across the grid
  /** set once someone calls update() — kills the self-driving fallback */
  private driven = false;
  private lastTick = 0;

  constructor(livery: Livery) {
    const g = driverGeo();
    const mats = kartMaterials();
    let per = _perLivery.get(livery.index);
    if (!per) {
      per = {
        torso: liveryGeometry(g.torso, livery),
        arms: liveryGeometry(g.arms, livery),
        helmet: liveryGeometry(g.helmet, livery),
        wheel: liveryGeometry(g.wheel, livery),
      };
      _perLivery.set(livery.index, per);
    }

    const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, name: string) => {
      const o = new THREE.Mesh(geo, material);
      o.castShadow = true;
      o.name = name;
      return o;
    };

    this.hips.add(mesh(per.torso, mats.character, 'driverTorso'));
    this.head.position.copy(HEAD_POS);
    this.head.add(mesh(per.helmet, mats.paint, 'driverHelmet'));
    this.head.add(mesh(g.visor.geo, mats.glass, 'driverVisor'));
    this.hips.add(this.head);

    this.column.position.copy(COL_POS);
    this.column.rotation.x = COL_RAKE;
    this.armRig.position.copy(COL_POS);
    this.armRig.rotation.x = COL_RAKE;
    this.column.add(this.wheelNode);
    this.wheelNode.add(mesh(per.wheel, mats.plastic, 'steeringWheel'));
    this.armRig.add(mesh(per.arms, mats.character, 'driverArms'));

    this.hips.add(this.column);
    this.hips.add(this.armRig);
    this.root.add(this.hips);
    this.root.name = 'driver';
    this.root.userData.rig = this;

    // Fallback: if nobody drives the rig, breathe and settle on our own clock
    // so the figure is never a statue. Disables itself the moment a real
    // system calls update(). The shadow pass gets a ~0 delta and is a no-op.
    const torso = this.hips.children[0] as THREE.Mesh;
    torso.onBeforeRender = () => {
      if (this.driven) return;
      const now = performance.now() / 1000;
      const dt = this.lastTick ? Math.min(0.05, now - this.lastTick) : 0;
      this.lastTick = now;
      if (dt > 0) this.apply(dt);
    };
  }

  /** Convenience for callers that would rather push a whole pose at once. */
  setPose(steer: number, lean: number, pitch: number, duck: number, apex: number) {
    this.steer = steer;
    this.lean = lean;
    this.pitch = pitch;
    this.duck = duck;
    this.apex = apex;
  }

  /** One-shot shove — collisions, landings, item hits. */
  jolt(strength: number) {
    this.joltAmt = Math.min(1.5, this.joltAmt + strength);
  }

  update(dt: number) {
    this.driven = true;
    this.apply(dt);
  }

  private apply(dt: number) {
    this.clock += dt;
    this.sSteer = damp(this.sSteer, THREE.MathUtils.clamp(this.steer, -1, 1), 13, dt);
    this.sLean = damp(this.sLean, THREE.MathUtils.clamp(this.lean, -1, 1), 7, dt);
    this.sPitch = damp(this.sPitch, THREE.MathUtils.clamp(this.pitch, -1, 1), 6, dt);
    this.sDuck = damp(this.sDuck, THREE.MathUtils.clamp(this.duck, 0, 1), 9, dt);
    this.sApex = damp(this.sApex, THREE.MathUtils.clamp(this.apex, -1, 1), 5, dt);
    this.joltAmt *= Math.exp(-9 * dt);

    // idle: a slow breath plus a faster tremor that scales with the shove
    const breath = Math.sin(this.clock * 1.7) * 0.012;
    const shudder = Math.sin(this.clock * 46) * this.joltAmt * 0.05;

    // +lean is a right-hand corner, and +X is the kart's right, so the torso
    // rolls toward -Z-rotation to fall into the turn.
    this.hips.rotation.z = -this.sLean * 0.17 + shudder;
    this.hips.rotation.x = -this.sPitch * 0.09 + this.sDuck * 0.34 + breath;
    this.hips.position.y = -this.sDuck * 0.07 - Math.abs(this.sLean) * 0.012 + breath * 0.4;
    this.hips.position.z = this.sDuck * 0.035;

    this.head.rotation.y = this.sApex * 0.62;
    this.head.rotation.z = -this.sLean * 0.24 - shudder * 1.6;
    this.head.rotation.x = -this.sDuck * 0.22 - this.sPitch * 0.05 - breath * 1.6;

    this.wheelNode.rotation.y = -this.sSteer * 0.85;
    // The arms swing about the column too, but at a quarter of the rim's
    // throw: the shoulder balls ride with them and have to stay inside the
    // torso's shoulder line at full lock.
    this.armRig.rotation.y = -this.sSteer * 0.22;
  }
}

/** Build a driver for one livery. Geometry is shared; only colours differ. */
export function buildDriver(livery: Livery): DriverRig {
  return new DriverRig(livery);
}

/** Triangle count of one driver, for the kart's budget report. */
export function driverTriangles(): number {
  const g = driverGeo();
  return g.torso.triangles + g.arms.triangles + g.helmet.triangles + g.visor.triangles + g.wheel.triangles;
}
