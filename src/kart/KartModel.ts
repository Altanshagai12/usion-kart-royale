/**
 * ============================================================================
 *  KartModel — the object the player stares at for the whole race.
 * ============================================================================
 *  Chunky Nintendo proportions: 0.36 m wheels against a 2.0 m body, an open
 *  tub with visible side rails, fat rear fenders and a driver sitting proud of
 *  the bodywork. Nothing here is a box: every part is lofted through chamfered
 *  cross-sections so each edge carries a highlight.
 *
 *  Local frame (matches Kart.step): +Z forward, +Y up, +X is the kart's RIGHT.
 *  y = 0 is the ground contact plane, so the root can be dropped straight onto
 *  a surface probe.
 *
 *  --- what other systems can reach ------------------------------------------
 *  root.userData.body          Group  — physics animates roll / pitch / squash
 *  root.userData.driver        DriverRig — see Driver.ts for the pose API
 *  root.userData.exhausts      Object3D[2] — boost flame anchors, +Z points out
 *  root.userData.sparks        Object3D[2] — rear contact patches, drift sparks
 *  root.userData.wheelContacts Object3D[4] — FL, FR, RL, RR at ground level
 *  root.userData.livery        Livery — colours for HUD / minimap / particles
 *  root.userData.shadowBlob    Mesh — fake contact shadow, hide it if you own
 *                                     a better one
 *  root.userData.triangles     number
 *  Named children: 'body', 'driver', 'exhaustL/R', 'sparkL/R', 'wheelFL' ...
 *
 *  Wheels are returned FL, FR, RL, RR (front = +Z, and index 0/2 are the -X
 *  side, matching the ordering the physics placeholder shipped with). Each is
 *  a pivot with `rotation.order = 'YXZ'`, so physics can set `rotation.y` for
 *  steer and `rotation.x` for roll on the same object and get the right result.
 * ============================================================================
 */
import * as THREE from 'three';
import type { KartStats } from '../types';
import {
  Mesher, PANEL_SIZE, PANEL_UV, Role, WHEEL_UV, contactBlob, getLivery, kartMaterials,
  liveryGeometry, mat, syncKartEnv,
  type Built, type Livery, type Section,
} from './Liveries';
import { buildDriver, driverTriangles, DriverRig } from './Driver';

// --- hard dimensions ---------------------------------------------------------
const WHEEL_R = 0.36;
const WHEEL_HW = 0.15;
const TRACK_X = 0.72;     // half track width
const FRONT_Z = 0.72;
const REAR_Z = -0.74;
/** Outermost radius the tyre reaches, tread scallop included. */
const TYRE_OUTER_R = 0.376;

/**
 * Resample a control polyline through a Catmull-Rom so `addTube` sweeps a
 * continuous curve instead of mitring at every control point. A chrome tube
 * with faceted bends catches broken specular — the highlight jumps from facet
 * to facet instead of running along the bend — and chrome at roughness 0.15
 * needs *curvature* to have anything to reflect in the first place.
 *
 * Samples are placed at equal increments of (arc length + BEND_W x turning
 * angle), NOT at equal arc length. Equal spacing is the obvious thing and it is
 * the wrong thing: it spends the same number of samples on the roll hoop's
 * dead-straight uprights as on its shoulders, so the residual facet all piles
 * up in the two bends that are actually on the silhouette. Weighting by
 * curvature moves samples from where they buy nothing to where they buy
 * everything — on the hoop it takes the worst joint from 17.6 to 13.4 degrees
 * for exactly zero extra triangles, which is the same result as raising the
 * sample count from 22 to 30.
 */
const BEND_W = 0.5;
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();

function smoothPath(pts: THREE.Vector3[], n: number): THREE.Vector3[] {
  const fineN = Math.max(64, (n - 1) * 8);
  const fine = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5).getSpacedPoints(fineN);
  // w[i] = cost of reaching fine[i]; strictly increasing, so it inverts cleanly
  const w = new Float64Array(fineN + 1);
  for (let i = 1; i <= fineN; i++) {
    let turn = 0;
    if (i < fineN) {
      _sa.subVectors(fine[i], fine[i - 1]).normalize();
      _sb.subVectors(fine[i + 1], fine[i]).normalize();
      turn = Math.acos(THREE.MathUtils.clamp(_sa.dot(_sb), -1, 1));
    }
    w[i] = w[i - 1] + fine[i].distanceTo(fine[i - 1]) + BEND_W * turn;
  }
  const out: THREE.Vector3[] = [fine[0].clone()];
  let k = 1;
  for (let s = 1; s < n - 1; s++) {
    const t = (s / (n - 1)) * w[fineN];
    while (k < fineN && w[k] < t) k++;
    const f = (t - w[k - 1]) / Math.max(1e-9, w[k] - w[k - 1]);
    out.push(new THREE.Vector3().lerpVectors(fine[k - 1], fine[k], f));
  }
  out.push(fine[fineN].clone());
  return out;
}

// ---------------------------------------------------------------------------
// Chassis — four merged buckets, one draw call each
// ---------------------------------------------------------------------------

interface ChassisGeo {
  paint: Built;
  decal: Built;
  chrome: Built;
  plastic: Built;
  fender: Built;
}
let _chassis: ChassisGeo | null = null;

/**
 * Ceiling on how far the fender node tracks the wheels — past this it would
 * visibly detach from the bodywork it is bolted to. Suspension's `visualOffset`
 * clamps at 0.18 m, so the tyre can out-run the fender by at most
 * 0.18 - FEND_MAX_LIFT m. Measured against the built geometry, the closest
 * fender vertex that overlaps the tyre's tread band sits 81 mm off the tread at
 * rest (the section's outward flare puts its lowest points either side of the
 * tyre, not over it) and 36 mm at the very bottom of the travel, so the tread
 * cannot reach the arch anywhere in the range. The ceiling is kept this low deliberately: the arch's forward end is
 * buried in the side pod (see the angular span below) and that is what makes it
 * read as mounted rather than floating, so it must not lift far enough to pull
 * its own root out into the open.
 */
const FEND_MAX_LIFT = 0.10;
/** Crown clearance at the section centreline. See the measurement above. */
const FEND_GAP = 0.030;

function buildChassis(): ChassisGeo {
  if (_chassis) return _chassis;

  const P = new Mesher(); // painted bodywork
  const D = new Mesher(); // livery decal panels
  const C = new Mesher(); // chrome
  const M = new Mesher(); // matte plastic
  const F = new Mesher(); // painted rear fenders — own node, tracks the wheels

  // --- floor pan ----------------------------------------------------------
  // Deliberately on the MATTE mesher, not the painted one. It is the darkest
  // large surface on the kart and it sits nearly edge-on to the camera, which
  // is the worst possible case for a clearcoat: round 1 put it on the lacquer
  // and the whole skirt crawled with white per-pixel sparkle. Nothing under a
  // kart is polished anyway.
  M.addLoft(
    [
      { z: -0.86, hw: 0.44, hh: 0.045, y: 0.195, r: 0.03 },
      { z: -0.40, hw: 0.47, hh: 0.05, y: 0.195, r: 0.035 },
      { z: 0.20, hw: 0.46, hh: 0.05, y: 0.20, r: 0.035 },
      { z: 0.62, hw: 0.42, hh: 0.048, y: 0.205, r: 0.03 },
      { z: 0.96, hw: 0.30, hh: 0.042, y: 0.215, r: 0.028 },
    ],
    Role.Shadowed,
    undefined,
    { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
  );

  // --- side rails: the wrapped cockpit tub --------------------------------
  for (const s of [-1, 1]) {
    P.addLoft(
      [
        { z: -0.78, hw: 0.072, hh: 0.115, y: 0.35, r: 0.05 },
        { z: -0.52, hw: 0.078, hh: 0.185, y: 0.42, r: 0.055 },
        { z: -0.12, hw: 0.080, hh: 0.190, y: 0.435, r: 0.058 },
        { z: 0.24, hw: 0.076, hh: 0.170, y: 0.425, r: 0.055 },
        { z: 0.56, hw: 0.070, hh: 0.135, y: 0.40, r: 0.05 },
      ],
      Role.Base,
      mat(s * 0.437, 0, 0),
      { corner: 2, capStart: 0.05, capEnd: 0.05 },
    );
    // rail cap stripe — a trim-coloured bead along the top edge of the tub
    P.addLoft(
      [
        { z: -0.70, hw: 0.055, hh: 0.016, y: 0.60, r: 0.012 },
        { z: -0.12, hw: 0.060, hh: 0.018, y: 0.628, r: 0.014 },
        { z: 0.50, hw: 0.052, hh: 0.016, y: 0.538, r: 0.012 },
      ],
      Role.Trim,
      mat(s * 0.437, 0, 0),
      { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
    );
  }

  // --- nose: swept, tapering, sitting on the floor pan --------------------
  P.addLoft(
    [
      { z: 0.46, hw: 0.44, hh: 0.145, y: 0.385, r: 0.09, taper: -0.14 },
      { z: 0.66, hw: 0.43, hh: 0.150, y: 0.385, r: 0.09, taper: -0.16 },
      { z: 0.86, hw: 0.38, hh: 0.140, y: 0.375, r: 0.085, taper: -0.20 },
      { z: 1.00, hw: 0.30, hh: 0.115, y: 0.360, r: 0.07, taper: -0.24 },
    ],
    Role.Base,
    undefined,
    { corner: 2, capStart: 0.05, capEnd: 0.06 },
  );

  // --- side pods ----------------------------------------------------------
  for (const s of [-1, 1]) {
    // The flat run of the flank (between the corner radii) is exactly the
    // height of the livery panel that sits on it, and the tumblehome matches
    // the panel's tilt, so the decal lies flush instead of hovering.
    P.addLoft(
      [
        { z: -0.34, hw: 0.128, hh: 0.150, y: 0.350, r: 0.05, taper: -0.10 },
        { z: -0.10, hw: 0.145, hh: 0.170, y: 0.350, r: 0.05, taper: -0.10 },
        { z: 0.14, hw: 0.142, hh: 0.168, y: 0.350, r: 0.05, taper: -0.10 },
        { z: 0.32, hw: 0.118, hh: 0.140, y: 0.348, r: 0.05, taper: -0.12 },
      ],
      Role.Base,
      mat(s * 0.635, 0, 0),
      { corner: 2, capStart: 0.05, capEnd: 0.05 },
    );
    // pod intake mouth, recessed and dark so the pod reads as hollow
    M.addLoft(
      [
        { z: 0.0, hw: 0.055, hh: 0.075, y: 0.35, r: 0.03 },
        { z: 0.05, hw: 0.045, hh: 0.065, y: 0.35, r: 0.025 },
      ],
      Role.Plastic,
      mat(s * 0.635, 0, 0.30),
      { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
    );
  }

  // --- rear engine block --------------------------------------------------
  P.addLoft(
    [
      { z: -0.94, hw: 0.30, hh: 0.215, y: 0.49, r: 0.075, taper: -0.1 },
      { z: -0.80, hw: 0.335, hh: 0.245, y: 0.50, r: 0.085, taper: -0.1 },
      { z: -0.62, hw: 0.325, hh: 0.235, y: 0.495, r: 0.08, taper: -0.12 },
    ],
    Role.Base,
    undefined,
    // shallow rear chamfer so the number plate has a flat face to sit on
    { corner: 2, capStart: 0.03, capEnd: 0.05 },
  );
  // cooling fins on top of the block
  for (let i = 0; i < 3; i++) {
    M.addLoft(
      [
        { z: -0.90, hw: 0.019, hh: 0.035, y: 0.755, r: 0.008 },
        { z: -0.66, hw: 0.019, hh: 0.042, y: 0.765, r: 0.008 },
      ],
      Role.Plastic,
      mat((i - 1) * 0.105, 0, 0),
      { corner: 1, capStart: 0.012, capEnd: 0.012, capSeg: 1 },
    );
  }
  // airbox scoop
  C.addLoft(
    [
      { z: -0.70, hw: 0.10, hh: 0.055, y: 0.80, r: 0.03 },
      { z: -0.56, hw: 0.115, hh: 0.062, y: 0.815, r: 0.035 },
    ],
    Role.Steel,
    undefined,
    { corner: 2, capStart: 0.03, capEnd: 0.035 },
  );

  // --- rear fenders: a fat arc over each rear wheel ------------------------
  // Sized off TYRE_OUTER_R rather than by eye, and on their OWN mesher.
  //
  // Round 1 put the inner face at 0.375 against a 0.376 tyre, so the tread came
  // through the fender at rest. A static gap fixes the static shot and nothing
  // else: the fenders hang off `body`, which only rolls and pitches, while the
  // wheels live on `root` and are driven by Suspension.visualOffset — up to
  // 0.18 m of vertical travel relative to the bodywork, clamped. Under the
  // lateral load of a drift the outside rear compresses ~0.12 m past rest, so
  // ANY plausible static clearance is punched straight through in exactly the
  // cornering and drift frames the review shoots. Matching 0.18 m statically
  // would mean a mudguard floating 20 cm off the tyre, which is a worse defect
  // than the one it fixes.
  //
  // So the pair goes on a node that rides with the rear axle (see buildKart),
  // and the gap only has to cover the residual the node's own clamp leaves.
  const FEND_HH = 0.048;
  const FEND_R = TYRE_OUTER_R + FEND_GAP + FEND_HH;
  for (const s of [-1, 1]) {
    const arc: Section[] = [];
    const N = 6;
    for (let i = 0; i <= N; i++) {
      // 150 deg -> 2.5 deg. The forward end used to stop at 30 deg, which put it
      // 19 mm above the side pod with nothing between the two: a mudguard
      // anchored to thin air, and a slot you can see daylight through in the
      // hero crop. Carried down to the axle line it plunges INTO the pod
      // instead, so the arch grows out of the bodywork — and it stays buried
      // through the whole FEND_MAX_LIFT range, which is what lets the arch move
      // with the wheel without its root ever coming into view. Two painted
      // surfaces of the same coat interpenetrating is invisible; a painted
      // surface interpenetrating a black tyre is the note we are answering.
      const a = THREE.MathUtils.lerp(2.62, 0.044, i / N);
      arc.push({
        z: REAR_Z + Math.cos(a) * FEND_R,
        y: WHEEL_R + Math.sin(a) * FEND_R,
        hw: 0.168,
        hh: FEND_HH,
        r: 0.038,
        taper: -0.45, // curls the outer face over instead of ending in a shelf
      });
    }
    F.addLoft(arc, Role.Base, mat(s * TRACK_X, 0, 0), { corner: 2, capStart: 0.03, capEnd: 0.03, capSeg: 1 });
  }

  // --- front bumper: a bowed bar, painted, with a chrome rub strip ---------
  const bumper = (hw: number, hh: number, y: number, role: number, mesher: Mesher, zOff: number, corner: number) => {
    const secs: Section[] = [];
    for (let i = 0; i <= 4; i++) {
      const u = (i / 4) * 2 - 1;
      secs.push({ z: u * 0.50, hw, hh, x: u * u * 0.075 + zOff, y, r: Math.min(hw, hh) * 0.8 });
    }
    // loft runs along local +Z; a quarter turn about Y sends it across the kart
    mesher.addLoft(secs, role, mat(0, 0, 1.03, 0, Math.PI / 2, 0), { corner, capStart: 0.05, capEnd: 0.05 });
  };
  bumper(0.085, 0.075, 0.30, Role.Base, P, 0, 3);
  bumper(0.030, 0.030, 0.30, Role.Steel, C, -0.085, 1);
  // splitter under the bumper
  M.addLoft(
    [
      { z: -0.44, hw: 0.05, hh: 0.02, y: 0.185, r: 0.012 },
      { z: 0.44, hw: 0.05, hh: 0.02, y: 0.185, r: 0.012 },
    ],
    Role.Plastic,
    mat(0, 0, 0.98, 0, Math.PI / 2, 0),
    { corner: 1, capStart: 0.02, capEnd: 0.02, capSeg: 1 },
  );

  // --- roll bar + rear wing ------------------------------------------------
  // Swept along a smoothed curve: the nine control points below are a polyline
  // with real corners in it, and a mitred chrome hoop is the §5 hard-edge tell
  // in tube form. 26 path samples x 10 radial keeps the bends continuous all
  // the way round, which is what lets the highlight run along the hoop.
  C.addTube(
    smoothPath([
      new THREE.Vector3(-0.40, 0.55, -0.42),
      new THREE.Vector3(-0.425, 0.86, -0.47),
      new THREE.Vector3(-0.375, 1.12, -0.45),
      new THREE.Vector3(-0.23, 1.265, -0.41),
      new THREE.Vector3(0, 1.31, -0.395),
      new THREE.Vector3(0.23, 1.265, -0.41),
      new THREE.Vector3(0.375, 1.12, -0.45),
      new THREE.Vector3(0.425, 0.86, -0.47),
      new THREE.Vector3(0.40, 0.55, -0.42),
    ], 22),
    0.036, 10, Role.Steel,
  );
  // Hoop cross brace and the wing stays. 8 radial, not 6: a hexagonal chrome
  // tube shows three facets across a 20 px silhouette and every one of them is
  // a hard edge, which is the §5 tell in miniature. 8 costs 24 triangles total
  // across the three tubes and closes the worst of it.
  C.addTube(
    [new THREE.Vector3(-0.40, 0.92, -0.465), new THREE.Vector3(0.40, 0.92, -0.465)],
    0.024, 8, Role.Steel,
  );
  for (const s of [-1, 1]) {
    C.addTube(
      [new THREE.Vector3(s * 0.30, 0.80, -0.90), new THREE.Vector3(s * 0.30, 0.99, -1.00)],
      0.022, 8, Role.Steel,
    );
  }
  P.addLoft(
    [
      { z: -0.44, hw: 0.115, hh: 0.020, y: 1.015, r: 0.014 },
      { z: 0, hw: 0.125, hh: 0.022, y: 1.03, r: 0.016 },
      { z: 0.44, hw: 0.115, hh: 0.020, y: 1.015, r: 0.014 },
    ],
    Role.Trim,
    mat(0, 0, -1.02, 0, Math.PI / 2, 0),
    { corner: 2, capStart: 0.025, capEnd: 0.025, capSeg: 1 },
  );

  // --- exhaust stacks ------------------------------------------------------
  for (const s of [-1, 1]) {
    C.addTube(
      smoothPath([
        new THREE.Vector3(s * 0.17, 0.58, -0.82),
        new THREE.Vector3(s * 0.21, 0.70, -0.99),
        new THREE.Vector3(s * 0.235, 0.845, -1.09),
      ], 6),
      (t) => 0.046 + t * t * 0.018,
      9, Role.Steel,
    );
  }

  // --- seat, dash, column --------------------------------------------------
  M.addLoft(
    [
      { z: -0.40, hw: 0.215, hh: 0.045, y: 0.375, r: 0.03 },
      { z: -0.10, hw: 0.225, hh: 0.05, y: 0.365, r: 0.032 },
      { z: 0.06, hw: 0.205, hh: 0.045, y: 0.365, r: 0.03 },
    ],
    Role.Plastic,
    undefined,
    { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
  );
  // backrest, raked back, with bolsters
  M.addLoft(
    [
      { z: 0.0, hw: 0.225, hh: 0.055, r: 0.04 },
      { z: 0.32, hw: 0.235, hh: 0.055, r: 0.04 },
      { z: 0.56, hw: 0.20, hh: 0.05, r: 0.04 },
    ],
    Role.Plastic,
    mat(0, 0.36, -0.40, -Math.PI / 2 + 0.30),
    { corner: 1, capStart: 0.045, capEnd: 0.05, capSeg: 1 },
  );
  for (const s of [-1, 1]) {
    M.addLoft(
      [
        { z: 0.06, hw: 0.045, hh: 0.075, r: 0.03 },
        { z: 0.42, hw: 0.05, hh: 0.08, r: 0.032 },
      ],
      Role.Plastic,
      mat(s * 0.225, 0.36, -0.40, -Math.PI / 2 + 0.30),
      { corner: 1, capStart: 0.03, capEnd: 0.03, capSeg: 1 },
    );
  }
  // headrest pad in the livery trim
  P.addLoft(
    [
      { z: 0.0, hw: 0.135, hh: 0.055, r: 0.04 },
      { z: 0.14, hw: 0.125, hh: 0.05, r: 0.038 },
    ],
    Role.Trim,
    mat(0, 0.90, -0.545, -Math.PI / 2 + 0.30),
    { corner: 2, capStart: 0.035, capEnd: 0.035 },
  );
  // dash + column shroud + pedals
  M.addLoft(
    [
      { z: -0.24, hw: 0.06, hh: 0.085, y: 0.50, r: 0.035 },
      { z: 0.24, hw: 0.06, hh: 0.085, y: 0.50, r: 0.035 },
    ],
    Role.Plastic,
    mat(0, 0, 0.47, 0, Math.PI / 2, 0),
    { corner: 1, capStart: 0.04, capEnd: 0.04, capSeg: 1 },
  );
  C.addTube(
    [new THREE.Vector3(0, 0.53, 0.46), new THREE.Vector3(0, 0.84, 0.29)],
    0.028, 8, Role.Steel,
  );
  C.addGeometry(new THREE.TorusGeometry(0.045, 0.012, 4, 9), Role.Steel, mat(0.13, 0.565, 0.455, 0.35), 1.5);
  // (the pedal box that used to live here is fully enclosed by the nose and the
  // dash shroud — it never reached a pixel in any of the ten review shots, so
  // its 128 triangles now pay for the roll bar's continuous bends instead)

  // --- mirrors + fuel filler ----------------------------------------------
  for (const s of [-1, 1]) {
    C.addTube(
      [new THREE.Vector3(s * 0.42, 0.63, 0.30), new THREE.Vector3(s * 0.52, 0.76, 0.28)],
      0.014, 5, Role.Steel,
    );
    P.addLoft(
      [
        { z: 0.0, hw: 0.058, hh: 0.038, r: 0.022 },
        { z: 0.03, hw: 0.055, hh: 0.036, r: 0.02 },
      ],
      Role.Trim,
      mat(s * 0.545, 0.79, 0.275, 0, s * 0.35, 0),
      { corner: 2, capStart: 0.018, capEnd: 0.018, capSeg: 1 },
    );
  }
  C.addLoft(
    [
      { z: 0.0, hw: 0.052, hh: 0.052, y: 0.665, r: 0.05 },
      { z: 0.022, hw: 0.048, hh: 0.048, y: 0.665, r: 0.046 },
    ],
    Role.Steel,
    mat(-0.24, 0, -0.60, Math.PI / 2),
    { corner: 2, capStart: 0.014, capEnd: 0.014, capSeg: 1 },
  );

  // --- decal panels --------------------------------------------------------
  // pods: local +X must run toward the kart's nose on the left side so the
  // sponsor mark reads correctly from outside; the right-hand quadrant of the
  // atlas is drawn mirrored to compensate.
  // The extra rotation is applied on the RIGHT of the yaw so it happens in the
  // panel's own frame: it rakes the top edge inboard to follow the tumblehome.
  const [pw, ph] = PANEL_SIZE.pod;
  D.addPanel(pw, ph, 0.010, PANEL_UV.podL,
    mat(-0.784, 0.350, -0.01, 0, -Math.PI / 2, 0).multiply(mat(0, 0, 0, -0.10, 0, 0)), Role.Base, 5);
  D.addPanel(pw, ph, 0.010, PANEL_UV.podR,
    mat(0.784, 0.350, -0.01, 0, Math.PI / 2, 0).multiply(mat(0, 0, 0, -0.10, 0, 0)), Role.Base, 5);
  // nose deck: lies flat on the bonnet, raked with it, read by the chase camera
  const [nw, nh] = PANEL_SIZE.nose;
  D.addPanel(
    nw, nh, 0.012, PANEL_UV.nose,
    mat(0, 0.532, 0.76, 0.12, 0, 0).multiply(mat(0, 0, 0, 0, Math.PI, 0)).multiply(mat(0, 0, 0, -Math.PI / 2, 0, 0)),
    Role.Base, 6,
  );
  // tail number plate — the panel the player stares at all race
  const [tw, th] = PANEL_SIZE.tail;
  D.addPanel(tw, th, 0.010, PANEL_UV.tail, mat(0, 0.50, -0.972, 0, Math.PI, 0), Role.Base, 5);

  _chassis = {
    paint: P.finish(), decal: D.finish(), chrome: C.finish(), plastic: M.finish(), fender: F.finish(),
  };
  return _chassis;
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

let _wheel: Built | null = null;

function buildWheel(): Built {
  if (_wheel) return _wheel;
  const W = new Mesher();
  const RAD = 26; // this is the closest object to the camera all race
  const RF = WHEEL_UV.rimFace; // metal zone of the atlas
  const DC = WHEEL_UV.disc;

  // Tyre: a real sidewall profile — bead, bulge, shoulder, crowned tread. The
  // v coordinate walks into the sidewall band of the atlas and back out, so
  // the moulded lettering lands on both flanks automatically.
  const hw = WHEEL_HW;
  const profile = [
    -hw * 0.80, 0.200, 0.300,
    -hw * 0.99, 0.292, 0.470,
    -hw * 0.92, 0.350, 0.575,
    -hw * 0.78, 0.366, 0.620,
    0.000, 0.374, 0.800,
    hw * 0.78, 0.366, 0.980,
    hw * 0.92, 0.350, 0.575,
    hw * 0.99, 0.292, 0.470,
    hw * 0.80, 0.200, 0.300,
  ];
  // Scallop the shoulders. The block count matches the atlas (10) and divides
  // into the segment count, so the nibble lands on the drawn tread instead of
  // beating against it.
  W.addRevolve(profile, RAD, Role.Rubber, undefined, 1, 0, (i, a) =>
    i === 3 || i === 5 ? Math.sin(a * 10) * 0.004 : i === 4 ? Math.sin(a * 10) * 0.0018 : 0,
  );

  // Rim: a closed back plate (so you never see through the spokes into the
  // world), barrel, and a lip that curls back under itself. The V values walk
  // DOWN the atlas's baked AO ramp as the surface goes deeper into the wheel:
  // 0.06 on the outboard lip, 0.16-0.19 on the barrel wall, 0.24 on the back
  // plate you see between the spokes. That is the occlusion term the spoke
  // recesses were missing. 20 radial, not 26 — it lives inside the tyre bead
  // and never contributes to a silhouette.
  W.addRevolve(
    [
      -hw * 0.78, 0.000, 0.245,
      -hw * 0.78, 0.196, 0.190,
      hw * 0.60, 0.197, 0.165,
      hw * 0.78, 0.203, 0.150,
      hw * 0.68, 0.174, 0.060,
    ],
    20, Role.Rim, undefined, RF[2], RF[0],
  );
  // Spokes: five chunky blades from the hub out to the lip. corner 2 rounds the
  // blade's long edges and a 2-segment cap chamfers the outboard END, which was
  // flat and unchamfered in round 1 and therefore caught no specular line at
  // all. The inboard end is left open (closeStart false) because it is buried
  // under the hub dome — that pays for the chamfer at the end you can see.
  const spokeMark = W.mark();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 10;
    W.addLoft(
      [
        { z: 0.05, hw: 0.026, hh: 0.055, r: 0.014 },
        { z: 0.172, hw: 0.024, hh: 0.034, r: 0.013 },
      ],
      Role.Rim,
      // spin the blade about the axle so the loft runs radially, not axially
      mat(hw * 0.60, 0, 0, a, 0, 0),
      { corner: 1, closeStart: false, capEnd: 0.017, capSeg: 2 },
    );
  }
  // Lofts carry metre-space UVs, so pin the spokes into the rim's metal zone —
  // and into a NARROW V slice near the top of it, so the blades stay in the
  // bright, un-occluded end of the AO ramp while the barrel behind them sinks.
  W.remapUV(spokeMark, [RF[0] + 0.04, RF[1] + 0.035, RF[2] * 0.7, 0.035]);

  // Hub nut: a shallow chamfered dome pinned to the atlas's polished band
  // (metalness 1, roughness 0.10). One small mirror in the middle of a wheel
  // is what makes the whole rim read as metal; without it the anodised barrel
  // has no hard glint anywhere to anchor it.
  W.addRevolve(
    [
      hw * 0.585, 0.000, 0.266,
      hw * 0.575, 0.024, 0.270,
      hw * 0.540, 0.046, 0.274,
      hw * 0.455, 0.062, 0.279,
      hw * 0.320, 0.072, 0.284,
    ],
    10, Role.Hub, undefined, WHEEL_UV.nut[2] * 0.25, 0.1,
  );

  // Brake disc, drilled, sitting behind the spokes where you can actually see
  // it through them.
  W.addRevolve(
    [
      -0.012, 0.082, 0.02,
      -0.012, 0.152, 0.24,
      0.012, 0.152, 0.24,
      0.012, 0.082, 0.02,
    ],
    8, Role.Disc, mat(-hw * 0.22, 0, 0), DC[2], DC[0],
  );

  _wheel = W.finish();
  return _wheel;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const _perLivery = new Map<number, {
  paint: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  plastic: THREE.BufferGeometry;
  fender: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  tris: number;
}>();

function liveryGeos(l: Livery) {
  let hit = _perLivery.get(l.index);
  if (hit) return hit;
  const ch = buildChassis();
  const wh = buildWheel();
  hit = {
    paint: liveryGeometry(ch.paint, l),
    chrome: liveryGeometry(ch.chrome, l),
    plastic: liveryGeometry(ch.plastic, l),
    fender: liveryGeometry(ch.fender, l),
    wheel: liveryGeometry(wh, l),
    tris: ch.paint.triangles + ch.decal.triangles + ch.chrome.triangles + ch.plastic.triangles
      + ch.fender.triangles + wh.triangles * 4 + driverTriangles(),
  };
  _perLivery.set(l.index, hit);
  return hit;
}

/** Anchor whose +Z points along `dir` — VFX emits along an anchor's forward. */
function anchor(name: string, x: number, y: number, z: number, dir?: THREE.Vector3): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  if (dir) o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  return o;
}

export function buildKart(stats: KartStats): { root: THREE.Group; wheels: THREE.Object3D[] } {
  const livery = getLivery(stats);
  const mats = kartMaterials();
  const geos = liveryGeos(livery);
  const chassis = buildChassis();

  const root = new THREE.Group();
  root.name = `kart_${livery.name}`;

  // Everything that rolls and pitches with the springs hangs off `body`; the
  // wheels stay on the root so physics can drive them per-corner.
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const add = (geo: THREE.BufferGeometry, material: THREE.Material, name: string) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    body.add(m);
    return m;
  };
  // The kart's whole material set is authored against an absolute environment
  // response and then divided by whatever `scene.environmentIntensity` happens
  // to be (see ENV_TARGET in Liveries). Reading it here rather than hard-coding
  // the reciprocal means the karts stay correct if the sky is ever retuned —
  // and in round 1 the sky's 0.40 global is precisely what turned eight
  // clearcoated karts into eight matte clay toys. One float compare per frame.
  add(geos.paint, mats.paint, 'bodyPaint').onBeforeRender = (_r, scene) => {
    syncKartEnv(scene.environmentIntensity);
  };
  add(chassis.decal.geo, livery.decalMat, 'bodyLivery');
  add(geos.chrome, mats.chrome, 'bodyChrome');
  add(geos.plastic, mats.plastic, 'bodyPlastic');
  const fenders = add(geos.fender, mats.paint, 'bodyFenders');

  // --- driver -------------------------------------------------------------
  const driver: DriverRig = buildDriver(livery);
  driver.root.position.set(0, 0.42, -0.14);
  body.add(driver.root);

  // --- wheels: FL, FR, RL, RR (index 0/2 are the -X side) -----------------
  const wheels: THREE.Object3D[] = [];
  const wheelContacts: THREE.Object3D[] = [];
  const layout: [number, number, string][] = [
    [-TRACK_X, FRONT_Z, 'FL'],
    [TRACK_X, FRONT_Z, 'FR'],
    [-TRACK_X, REAR_Z, 'RL'],
    [TRACK_X, REAR_Z, 'RR'],
  ];
  for (const [x, z, label] of layout) {
    const pivot = new THREE.Group();
    pivot.name = `wheel${label}`;
    // steer (Y) must be applied before spin (X) or the axle tilts
    pivot.rotation.order = 'YXZ';
    pivot.position.set(x, WHEEL_R, z);
    pivot.userData.side = Math.sign(x);
    pivot.userData.front = z > 0;
    pivot.userData.radius = WHEEL_R;
    pivot.userData.restY = WHEEL_R;

    const hub = new THREE.Group();
    hub.rotation.y = x > 0 ? 0 : Math.PI; // rim face always points outboard
    const wm = new THREE.Mesh(geos.wheel, mats.wheel);
    wm.name = `tyre${label}`;
    wm.castShadow = true;
    hub.add(wm);
    pivot.add(hub);
    root.add(pivot);
    wheels.push(pivot);

    const contact = anchor(`contact${label}`, x, 0.01, z);
    root.add(contact);
    wheelContacts.push(contact);
  }

  // --- rear fenders ride with the rear axle --------------------------------
  // A guard bolted to the bodywork, over a wheel with up to 0.18 m of visual
  // suspension travel relative to that bodywork, either intersects the tyre or
  // floats above it. The way out of the trade is to stop pretending it is
  // rigid. It follows the MORE compressed of the two rear corners rather than
  // their mean: the max guarantees neither tyre can reach the arc, and the
  // price is that the unloaded side shows a slightly wider gap mid-drift, which
  // is nothing next to a tread block coming through the paint.
  //
  // onBeforeRender is the only hook that runs after physics has posed the
  // wheels. three calls it BEFORE it derives modelViewMatrix from matrixWorld,
  // so refreshing the matrix by hand here lands in the frame being drawn rather
  // than one frame late. (The shadow pass has no such hook and runs first, so
  // the fender's shadow trails its geometry by a frame — 100 mm at the very
  // worst, on a soft penumbra, for one frame of a landing.) One max, one clamp,
  // no allocation, and it early-outs whenever the lift has not changed.
  const wRL = wheels[2];
  const wRR = wheels[3];
  fenders.onBeforeRender = () => {
    const lift = Math.min(
      FEND_MAX_LIFT,
      Math.max(0, wRL.position.y - WHEEL_R, wRR.position.y - WHEEL_R),
    );
    if (lift !== fenders.position.y) {
      fenders.position.y = lift;
      fenders.updateMatrix();
      fenders.matrixWorld.multiplyMatrices(body.matrixWorld, fenders.matrix);
    }
  };

  // --- effect anchors ------------------------------------------------------
  const exDir = new THREE.Vector3(0, 0.55, -0.84);
  const exhausts = [
    anchor('exhaustL', -0.235, 0.855, -1.12, exDir),
    anchor('exhaustR', 0.235, 0.855, -1.12, exDir),
  ];
  for (const e of exhausts) body.add(e);
  // Sparks come off the rear contact patches, just inboard of the tyre wall,
  // and live on the root so they stay pinned to the ground while the body
  // rolls. Separate objects from the contacts so physics and VFX can move
  // theirs independently.
  const sparks = [
    anchor('sparkL', -(TRACK_X - WHEEL_HW * 0.5), 0.05, REAR_Z),
    anchor('sparkR', TRACK_X - WHEEL_HW * 0.5, 0.05, REAR_Z),
  ];
  for (const s of sparks) root.add(s);

  // --- fake contact shadow -------------------------------------------------
  const blob = contactBlob();
  const shadowBlob = new THREE.Mesh(blob.geo, blob.mat);
  shadowBlob.name = 'shadowBlob';
  shadowBlob.position.y = 0.012;
  shadowBlob.renderOrder = -1;
  root.add(shadowBlob);

  root.userData.body = body;
  root.userData.driver = driver;
  root.userData.exhausts = exhausts;
  root.userData.exhaustTips = exhausts;
  root.userData.sparks = sparks;
  root.userData.wheelContacts = wheelContacts;
  root.userData.wheels = wheels;
  root.userData.livery = livery;
  root.userData.shadowBlob = shadowBlob;
  root.userData.triangles = geos.tris;

  return { root, wheels };
}
