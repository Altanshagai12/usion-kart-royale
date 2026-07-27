/**
 * ============================================================================
 *  Scenery — everything that turns a racetrack into Sunset Bay.
 * ============================================================================
 *  The track agent authors the road, kerbs, walls and terrain. This system
 *  reads that geometry back through `ctx.track.sample()` / `.probe()` and
 *  dresses it: the sea, the village, the harbour, the planting, the crowd,
 *  the trackside furniture and the backdrop that keeps the horizon full.
 *
 *  Everything is merged or instanced. Nothing is placed without first probing
 *  the ground under it, and every free-standing prop gets a contact shadow
 *  decal on top of its cast shadow, because ART_DIRECTION §9.4 is "nothing
 *  floats" and a shadow map alone does not survive a low sun.
 *
 *  Section layout follows §1 of the bible, keyed off normalised track t.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx, System, TrackSample } from '../types';
import { Surface } from '../types';
import { Water, type SeaField } from './Water';
import { Foliage } from './Foliage';
import {
  GeoAccum,
  InstSet,
  MatLib,
  PAL,
  aFrameSignGeo,
  awningGeo,
  balconyGeo,
  bannerArchGeo,
  barrelGeo,
  bellTowerGeo,
  bevelBox,
  boatGeo,
  bollardGeo,
  buildHouse,
  buntingFlagGeo,
  buoyGeo,
  card,
  clamp,
  crateGeo,
  deckchairGeo,
  debrisGeo,
  doorGeo,
  flowerBoxGeo,
  grandstandGeo,
  gullGeo,
  landmassGeo,
  lampGeo,
  lerp,
  lighthouseGeo,
  loft,
  makeShared,
  marshalGeo,
  mulberry32,
  netGeo,
  newHouseParts,
  parasolGeo,
  patchAerial,
  patchBob,
  patchTint,
  pick,
  ropeGeo,
  shutterGeo,
  smoothstep,
  spectatorGeo,
  stallGeo,
  startLightsGeo,
  tentGeo,
  trs,
  tyreGeo,
  wallSignGeo,
  windmillGeo,
  type RNG,
  type Shared,
} from './Props';

// --- module-scope scratch: nothing below allocates inside update() ---------
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _haze = new THREE.Color(PAL.skyWarm);
// dropShadow is called with the caller's own scratch vector, so it keeps its own
const _ds = new THREE.Vector3();
const _dn = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _dm = new THREE.Matrix4();
const _dsc = new THREE.Vector3();

const SEA_FIELD_RES = 288;

export class Scenery implements System {
  readonly group = new THREE.Group();

  private u: Shared = makeShared();
  private mats!: MatLib;
  private water!: Water;
  private foliage!: Foliage;
  private rng: RNG = mulberry32(1);

  private ctx!: Ctx;
  private seaLevel = 0;
  private flatWorld = false;
  private seaSideLUT = new Float32Array(128);
  private rotor: THREE.Object3D | null = null;
  private cheer = 0;
  private cheerTarget = 0;
  private busOff: (() => void) | null = null;

  // instance sets, kept only during construction
  private sets: Record<string, InstSet> = {};
  private acc: Record<string, GeoAccum> = {};

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.rng = mulberry32(0xbacafe);
    this.group.name = 'scenery';
    this.mats = new MatLib(ctx.renderer, this.u);
    this.mats.setEnv(ctx.envMap);

    this.surveyWorld();
    this.foliage = new Foliage(this.mats, this.u, this.rng);

    this.water = new Water(this.u);
    this.water.build(ctx, this.seaLevel, this.bakeSeaField());
    this.group.add(this.water.group);

    this.makeSets();
    this.dressStartStraight();
    this.dressHarbour();
    this.dressVillage();
    this.dressCliff();
    this.dressBeach();
    this.dressBankedCurve();
    this.dressBridgeAndHeadland();
    this.dressOpenWater();
    this.dressLandBands();
    // Backdrop before the balance pass: the balance pass asks "is this side of
    // the frame empty?", and a landmark on the horizon is one of the answers.
    this.buildBackdrop();
    this.dressFarSails();
    this.dressOpposingMidground();
    this.dressShoulders();
    this.dressGrassBand();
    this.dressVergeTransition();
    this.dressNearFrame();
    this.dressGulls();
    this.emit();

    ctx.scene.add(this.group);

    // The stand reacts to the race rather than looping a canned animation.
    this.busOff = ctx.bus.on((e) => {
      if (e.type === 'lap' || e.type === 'finish') this.cheerTarget = 1;
      else if (e.type === 'countdown' && e.n === 0) this.cheerTarget = 0.9;
      else if (e.type === 'boost' && e.kart.isPlayer) this.cheerTarget = Math.max(this.cheerTarget, 0.45);
    });
  }

  update(ctx: Ctx, dt: number) {
    const u = this.u;
    u.uTime.value = ctx.time;
    u.uCam.value.copy(ctx.camera.position);
    // Gusts: a slow envelope so the whole treeline breathes together.
    u.uWindAmp.value = 0.72 + Math.sin(ctx.time * 0.19) * 0.26 + Math.sin(ctx.time * 0.61 + 1.7) * 0.12;

    _n.copy(ctx.sunDirection).transformDirection(ctx.camera.matrixWorldInverse);
    u.uSunView.value.copy(_n);
    if (ctx.sun) u.uSunCol.value.copy(ctx.sun.color).multiplyScalar(clamp(ctx.sun.intensity * 0.14, 0.2, 1.1));

    this.cheerTarget = Math.max(0, this.cheerTarget - dt * 0.5);
    // Baseline burble so the crowd is never frozen, spiking on race events.
    const want = 0.14 + this.cheerTarget * 0.86;
    this.cheer += (want - this.cheer) * Math.min(1, dt * 3.2);
    u.uCheer.value = this.cheer;

    if (this.rotor) this.rotor.rotation.z -= dt * (0.42 + u.uWindAmp.value * 0.3);
    this.water.update(ctx);
    if (ctx.envMap) this.mats.setEnv(ctx.envMap);
  }

  dispose() {
    this.busOff?.();
    this.water.dispose();
    this.mats.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }

  // ==========================================================================
  // World survey — sea level, which side the water is on, and a depth field
  // ==========================================================================

  /**
   * The track is authored in parallel with this module, so nothing about the
   * terrain can be assumed. Probe it and derive what we need.
   */
  private surveyWorld() {
    const track = this.ctx.track;
    let minY = Infinity;
    for (let i = 0; i < 256; i++) minY = Math.min(minY, track.sample(i / 256).pos.y);

    // The track owns the terrain and therefore owns the waterline: wherever it
    // reports Surface.Water it has already clamped the ground to sea level, so
    // read the value back rather than guessing at it. Only if nothing on the
    // circuit fronts water do we fall back to "a quay's height below the
    // lowest point of the road".
    this.seaLevel = minY - 1.7;
    let hits = 0;
    let waterY = -Infinity;
    for (let i = 0; i < 96; i++) {
      const s = track.sample(i / 96);
      for (const side of [1, -1]) {
        for (const d of [30, 70, 140]) {
          _p.copy(s.pos).addScaledVector(s.binormal, side * (s.halfWidth + d)).setY(s.pos.y - 5);
          const pr = track.probe(_p, s.t);
          if (pr.surface === Surface.Water) {
            hits++;
            // The highest point still reported as water IS the surface — a
            // track that clamps its water probes returns one value, and one
            // that does not still converges on the shoreline from below.
            if (pr.y > waterY) waterY = pr.y;
          }
        }
      }
    }
    if (hits >= 4 && waterY < minY) this.seaLevel = waterY;

    // Detect a terrain that is not there yet (or genuinely flat): if probing
    // wildly different places returns the same height there is no heightfield
    // to respect, so fall back to geometric rules for what is water.
    let same = true;
    const y0 = track.probe(track.sample(0).pos, 0).y;
    for (let i = 1; i < 12 && same; i++) {
      const s = track.sample(i / 12);
      _p.copy(s.pos).addScaledVector(s.binormal, 40).setY(s.pos.y + 20);
      if (Math.abs(track.probe(_p, s.t).y - y0) > 0.05) same = false;
    }
    this.flatWorld = same;

    // Which side is the sea? Compare terrain height a long way out on each
    // side; the lower one is water. Falls back to "away from the circuit
    // centroid" on a flat world.
    const centroid = new THREE.Vector3();
    for (let i = 0; i < 64; i++) centroid.add(track.sample(i / 64).pos);
    centroid.multiplyScalar(1 / 64);
    const raw = new Float32Array(this.seaSideLUT.length);
    for (let i = 0; i < raw.length; i++) {
      const s = track.sample(i / raw.length);
      const d = s.halfWidth + 45;
      let side: number;
      if (this.flatWorld) {
        _p.copy(s.pos).sub(centroid);
        side = _p.dot(s.binormal) >= 0 ? 1 : -1;
      } else {
        _p.copy(s.pos).addScaledVector(s.binormal, d).setY(s.pos.y + 30);
        _p2.copy(s.pos).addScaledVector(s.binormal, -d).setY(s.pos.y + 30);
        side = track.probe(_p, s.t).y <= track.probe(_p2, s.t).y ? 1 : -1;
      }
      raw[i] = side;
    }
    // Smooth so a single noisy probe cannot flip the coast for one prop.
    for (let i = 0; i < raw.length; i++) {
      let acc = 0;
      for (let k = -3; k <= 3; k++) acc += raw[(i + k + raw.length) % raw.length];
      this.seaSideLUT[i] = acc >= 0 ? 1 : -1;
    }
  }

  /** +1 if the sea lies along +binormal at t, -1 otherwise. */
  private seaSide(t: number): number {
    const n = this.seaSideLUT.length;
    return this.seaSideLUT[((Math.floor(t * n) % n) + n) % n];
  }

  /**
   * Bakes a coarse shore field over the play area:
   *   R = water depth 0..1 (drives the #3fc9c4 -> #0d5a7a ramp and shoaling)
   *   G = shore foam mask, B = cliff-foot foam mask
   * Built by splatting the centreline rather than sampling every cell against
   * every centreline point — 400 splats instead of 12 million comparisons.
   */
  private bakeSeaField(): SeaField {
    const track = this.ctx.track;
    const b = track.bounds;
    const cx = (b.min.x + b.max.x) * 0.5 || 0;
    const cz = (b.min.z + b.max.z) * 0.5 || 0;
    const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5 + 380;
    const res = SEA_FIELD_RES;
    const size = half * 2;
    const cell = size / res;
    const origin = new THREE.Vector2(cx - half, cz - half);

    const dLow = new Float32Array(res * res).fill(1e9);
    const dAny = new Float32Array(res * res).fill(1e9);
    const yNear = new Float32Array(res * res).fill(this.seaLevel);

    const N = 460;
    const REACH = 90;
    const cr = Math.ceil(REACH / cell);
    for (let i = 0; i < N; i++) {
      const s = track.sample(i / N);
      const gx = (s.pos.x - origin.x) / cell;
      const gz = (s.pos.z - origin.y) / cell;
      const lowLying = s.pos.y < this.seaLevel + 9;
      const i0 = Math.max(0, Math.floor(gx) - cr),
        i1 = Math.min(res - 1, Math.ceil(gx) + cr);
      const j0 = Math.max(0, Math.floor(gz) - cr),
        j1 = Math.min(res - 1, Math.ceil(gz) + cr);
      for (let j = j0; j <= j1; j++) {
        const dz = (j + 0.5 - gz) * cell;
        for (let ii = i0; ii <= i1; ii++) {
          const dx = (ii + 0.5 - gx) * cell;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > REACH) continue;
          const c = j * res + ii;
          if (d < dAny[c]) {
            dAny[c] = d;
            yNear[c] = s.pos.y;
          }
          if (lowLying && d < dLow[c]) dLow[c] = d;
        }
      }
    }

    const data = new Uint8Array(res * res * 4);
    for (let c = 0; c < res * res; c++) {
      // Shallow where a low-lying stretch of coast is close by; the cliffs
      // plunge, so height above the water deepens the sea fast.
      let depth = smoothstep(4, 58, dLow[c]);
      const cliffness = smoothstep(this.seaLevel + 11, this.seaLevel + 30, yNear[c]);
      depth = Math.max(depth, cliffness * smoothstep(2, 16, dAny[c]));
      // A surf line is a band about ten metres wide, not a quarter of the bay.
      // The band is keyed off distance to the CENTRELINE, but the waterline
      // sits a road half-width plus a verge out from there, where depth has
      // already climbed to ~0.1. A band centred on depth 0 therefore fired
      // nowhere the sea was actually visible, which is why no round-1 frame
      // had a foam line. Centre it on the depth the shoreline really has.
      const shoreFoam = (1 - smoothstep(0.04, 0.30, depth)) * (1 - cliffness) * smoothstep(90, 40, dLow[c]);
      const cliffFoam = cliffness * smoothstep(20, 5, dAny[c]);
      const o = c * 4;
      data[o] = clamp(depth, 0, 1) * 255;
      data[o + 1] = clamp(shoreFoam, 0, 1) * 255;
      data[o + 2] = clamp(cliffFoam, 0, 1) * 255;
      data[o + 3] = 255;
    }
    return { origin, size, res, data };
  }

  // ==========================================================================
  // Probing helpers
  // ==========================================================================

  /** World point at track progress `t`, `lat` metres along the binormal. */
  private at(t: number, lat: number, out: THREE.Vector3, s?: TrackSample): TrackSample {
    const sm = s ?? this.ctx.track.sample(t);
    out.copy(sm.pos).addScaledVector(sm.binormal, lat);
    return sm;
  }

  /** Ground height under `p`; writes the ground normal into `outN` if given. */
  private groundY(p: THREE.Vector3, t: number, outN?: THREE.Vector3): number {
    const pr = this.ctx.track.probe(p, t);
    if (outN) outN.copy(pr.normal).normalize();
    return pr.y;
  }

  private surfaceAt(p: THREE.Vector3, t: number): Surface {
    return this.ctx.track.probe(p, t).surface;
  }

  /** Is the point at (t, lat) open water? */
  private isSea(t: number, lat: number, s?: TrackSample): boolean {
    const sm = s ?? this.ctx.track.sample(t);
    if (Math.sign(lat) !== this.seaSide(t)) return false;
    if (this.flatWorld) return Math.abs(lat) > sm.halfWidth + 16;
    this.at(t, lat, _p2, sm);
    const pr = this.ctx.track.probe(_p2, t);
    return pr.surface === Surface.Water || pr.y < this.seaLevel + 0.35;
  }

  /** Snap `p.y` onto the terrain (or the sea) and report the surface normal. */
  private settle(p: THREE.Vector3, t: number, outN?: THREE.Vector3): number {
    if (this.flatWorld && outN) outN.copy(_up);
    const y = this.flatWorld ? this.ctx.track.probe(p, t).y : this.groundY(p, t, outN);
    p.y = y;
    return y;
  }

  /** Walk a section of the circuit by arc length. */
  private walk(t0: number, t1: number, spacing: number, cb: (t: number, s: TrackSample, i: number) => void) {
    const L = this.ctx.track.length || 1;
    const d0 = t0 * L;
    const d1 = t1 * L;
    const n = Math.max(1, Math.floor((d1 - d0) / spacing));
    for (let i = 0; i <= n; i++) {
      const d = d0 + (i / n) * (d1 - d0);
      const t = ((d / L) % 1 + 1) % 1;
      cb(t, this.ctx.track.sampleByDistance(d), i);
    }
  }

  // ==========================================================================
  // Instance sets
  // ==========================================================================

  private makeSets() {
    const M = this.mats;
    const rng = this.rng;
    const S = (k: string, g: THREE.BufferGeometry, m: THREE.Material) => (this.sets[k] = new InstSet(g, m, k));
    const A = (k: string) => (this.acc[k] = new GeoAccum());

    A('wall');
    A('roof');
    A('trim');
    A('stone');
    A('wood');
    A('rope');
    A('backdrop');

    // Boats need their own material: same painted timber, plus GPU bob. It has
    // to be a separate instance or every crate in the harbour would heave too.
    const hullMat = M.woodVariant();
    patchBob(hullMat, this.u);

    S('shutter', shutterGeo(), M.woodInst);
    S('door', doorGeo(), M.woodInst);
    S('balcony', balconyGeo(), M.stoneInst);
    S('flowerbox', flowerBoxGeo(), M.woodInst);
    S('flowers', this.flowerClusterGeo(), M.flowerMat);
    S('awning', awningGeo(), M.fabric);
    S('glass', new THREE.PlaneGeometry(1, 1), M.glass);
    const lamp = lampGeo();
    S('lampArm', lamp.arm, M.metal);
    S('lampGlow', lamp.glow, M.lamp);
    S('laundry', card(0.9, 1.1), M.laundry);
    S('bollard', bollardGeo(), M.metal);
    S('crate', crateGeo(rng), M.woodInst);
    S('barrel', barrelGeo(), M.woodInst);
    S('net', netGeo(2.4, 2.0), M.netMat);
    for (let k = 0; k < 2; k++) {
      const b = boatGeo(rng, k);
      S('hull' + k, b.hull, hullMat);
      S('rig' + k, b.rig, hullMat);
    }
    S('tyre', tyreGeo(), M.rubber);
    S('sponsor', this.sponsorPanelGeo(), M.sponsor);
    S('sponsorPost', this.sponsorPostGeo(), M.metal);
    const par = parasolGeo();
    S('parasolPole', par.pole, M.woodInst);
    S('parasolTop', par.canopy, M.fabric);
    const chair = deckchairGeo();
    S('chairFrame', chair.frame, M.woodInst);
    S('chairCloth', chair.cloth, M.fabric);
    const mar = marshalGeo();
    S('marshal', mar.post, M.woodInst);
    S('marshalFlag', mar.flag, M.cloth);
    for (let k = 0; k < 3; k++) S('debris' + k, debrisGeo(mulberry32(900 + k)), M.stoneInst);
    // Four spectator silhouettes. One capsule repeated is the single loudest
    // placeholder tell in the round-1 set; a different OUTLINE costs nothing.
    for (let k = 0; k < 4; k++) S('crowd' + k, spectatorGeo(k), M.crowd);
    S('gull', gullGeo(), M.bird);
    S('flag', this.pennantGeo(), M.cloth);
    S('bunting', buntingFlagGeo(), M.bunting);
    S('buoy', buoyGeo(), M.woodInst);
    // Second/third-band dressing: tents, stalls and A-frames, all instanced.
    for (let k = 0; k < 2; k++) {
      const st = stallGeo(mulberry32(4400 + k));
      S('stallFrame' + k, st.frame, M.woodInst);
      S('stallCanopy' + k, st.canopy, M.fabric);
      S('tent' + k, tentGeo(mulberry32(5500 + k)).body, M.fabric);
    }
    const af = aFrameSignGeo();
    S('aframe', af.frame, M.woodInst);
    S('aframePanel', af.panel, M.sponsor);
    const ws = wallSignGeo();
    S('wallsign', ws.frame, M.metal);
    S('wallsignPanel', ws.panel, M.sponsor);
    S('shadow', this.shadowQuad(), M.shadowDecal);
    S('verge', this.vergeStripGeo(), M.vergeDecal);

    // Far sails. Their own material because they need the aerial-perspective
    // patch (they live at 300–1000 m, where an untinted white sail punches a
    // hole in the haze) plus the bob the boats use, and neither belongs on the
    // shared cloth.
    const sailMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.74, metalness: 0 });
    M.register(sailMat);
    patchTint(sailMat);
    patchBob(sailMat, this.u);
    patchAerial(sailMat, this.u, 340, 1900);
    S('farSail', this.sailGeo(), sailMat);
  }

  /**
   * Signed curvature at `t` (positive = the road turns toward +binormal).
   * The near-frame pass biases its props to the OUTSIDE of a corner so they
   * sweep into frame during turn-in instead of sitting behind the camera.
   */
  private curvature(t: number): number {
    const L = this.ctx.track.length || 1;
    const d = 14 / L;
    const a = this.ctx.track.sample((t - d + 1) % 1);
    const b = this.ctx.track.sample((t + d) % 1);
    _p.copy(b.tangent).sub(a.tangent);
    return _p.dot(a.binormal);
  }

  /**
   * Footprints already claimed by authored structures (houses, the bell tower,
   * the grandstand). The later scatter passes consult this so a market stall
   * never ends up inside a terrace and the near-frame palm never grows through
   * a wall. ~150 entries against ~250 queries; a linear scan is the right
   * amount of machinery for that.
   */
  private blockers: { x: number; z: number; r: number }[] = [];

  private claim(p: THREE.Vector3, r: number) {
    this.blockers.push({ x: p.x, z: p.z, r });
  }

  private blocked(p: THREE.Vector3, pad = 0): boolean {
    for (let i = 0; i < this.blockers.length; i++) {
      const b = this.blockers[i];
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const rr = b.r + pad;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }

  /** Hash-of-index picker: no visible cycle, unlike a modulo over a walk. */
  private hash1(i: number, salt: number): number {
    let x = Math.imul(i ^ salt, 0x27d4eb2d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
    x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  }

  private flowerClusterGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    for (let i = 0; i < 3; i++) acc.add(card(0.5, 0.42), trs(0, 0, 0, (i / 3) * Math.PI, 1, 1, 1, 0, 0), new THREE.Color(1, 1, 1));
    acc.add(card(0.9, 0.3), trs(0, 0.02, 0.02, 0, 1, 1, 1, -1.35), new THREE.Color(1, 1, 1));
    return acc.build()!;
  }

  /**
   * Hoarding panel, printed on both faces. A double-sided single quad would
   * show mirrored lettering from the far side of the circuit, which is exactly
   * the kind of thing that gets noticed.
   */
  private sponsorPanelGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    const front = new THREE.PlaneGeometry(4.0, 1.0, 1, 1);
    front.translate(0, 1.75, 0.03);
    acc.add(front, _m4.identity(), new THREE.Color(1, 1, 1));
    const back = new THREE.PlaneGeometry(4.0, 1.0, 1, 1);
    const buv = back.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < buv.count; i++) buv.setX(i, 1 - buv.getX(i));
    back.rotateY(Math.PI);
    back.translate(0, 1.75, -0.03);
    acc.add(back, _m4.identity(), new THREE.Color(0.86, 0.86, 0.86));
    return acc.build()!;
  }

  private sponsorPostGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    const w = new THREE.Color(1, 1, 1);
    for (const s of [-1, 1]) acc.add(bevelBox(0.11, 3.2, 0.11, 0.02, 4), trs(s * 1.75, 0.7, 0, 0), w);
    acc.add(bevelBox(4.05, 0.09, 0.09, 0.02, 3), trs(0, 2.28, 0, 0), w);
    acc.add(bevelBox(4.05, 0.09, 0.09, 0.02, 3), trs(0, 1.24, 0, 0), w);
    // A 6 cm bevelled frame round the printed face. Round 1's boards were a
    // zero-thickness plane, so at a 14° sun they caught no edge highlight and
    // read as a decal floating in the air rather than as a physical object —
    // and a board that is not a physical object cannot be read as signage at
    // any distance, however crisp the lettering is.
    const fw = 4.16,
      fh = 1.16,
      fr = 0.07;
    const bar = new THREE.Color(0.92, 0.9, 0.88);
    for (const sy of [-1, 1]) acc.add(bevelBox(fw, fr, 0.09, 0.016, 3), trs(0, 1.75 + sy * (fh / 2 - fr / 2), 0.005, 0), bar);
    for (const sx of [-1, 1]) acc.add(bevelBox(fr, fh, 0.09, 0.016, 3), trs(sx * (fw / 2 - fr / 2), 1.75, 0.005, 0), bar);
    return acc.build()!;
  }

  /** Triangular pennant on a mast; uv.x runs from the mast outward for cloth. */
  private pennantGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    acc.add(bevelBox(0.07, 4.6, 0.07, 0.015, 5), trs(0, 2.3, 0, 0), new THREE.Color(1, 1, 1));
    const g = new THREE.PlaneGeometry(1.5, 0.9, 8, 2);
    g.translate(0.75, 0, 0);
    g.translate(0, 4.0, 0.04);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), uv.getY(i));
    acc.add(g, trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
    return acc.build()!;
  }

  private shadowQuad(): THREE.BufferGeometry {
    const g = new THREE.PlaneGeometry(1, 1, 1, 1);
    g.rotateX(-Math.PI / 2);
    return g;
  }

  /**
   * Unit verge strip lying in the XZ plane: local +X runs OUTWARD across the
   * band (u = 0 at the kerb, u = 1 at the grass), local Z runs along the road.
   * Three spans across so the quad can follow a cambered verge instead of
   * cutting through it.
   */
  private vergeStripGeo(): THREE.BufferGeometry {
    const g = new THREE.PlaneGeometry(1, 1, 3, 1);
    g.rotateX(-Math.PI / 2);
    // PlaneGeometry is centred; push it so x = 0 is the inner (kerb) edge.
    g.translate(0.5, 0, 0);
    return g;
  }

  /**
   * Stamp a soft contact shadow, aligned to the ground it sits on. The cast
   * shadow map alone leaves props looking pasted on under a 14° sun; this is
   * the AO that grounds them (§9.4).
   */
  private dropShadow(p: THREE.Vector3, radius: number, t: number, strength = 1) {
    const set = this.sets.shadow;
    if (!set) return;
    _dn.set(0, 1, 0);
    if (!this.flatWorld) this.groundY(p, t, _dn);
    _dq.setFromUnitVectors(_up, _dn);
    _ds.set(p.x, p.y + 0.05 + radius * 0.012, p.z);
    _dm.compose(_ds, _dq, _dsc.set(radius * 2, 1, radius * 2));
    set.add(_dm, { uv: new THREE.Vector4(1, 1, 0, 0), color: _col.setScalar(strength).clone(), lod: 170 });
  }

  // ==========================================================================
  // Section dressing
  // ==========================================================================

  /** 0.00–0.10: start straight — arch, grandstand, harbour front. */
  private dressStartStraight() {
    const rng = this.rng;
    const track = this.ctx.track;
    const land = -this.seaSide(0.02);
    const sea = -land;

    // --- start/finish banner arch straddling the road
    this.bannerArch(0.004, 7.2, true);
    this.bannerArch(0.30, 6.6);
    this.bannerArch(0.70, 6.6);

    // --- grandstand + crowd on the land side.
    // Round 1 had a small open shed at the frame edge with a flat purple smear
    // in it. This is 1.5x taller, 1.7x longer and pulled inboard so it anchors
    // the left third of the establishing shot instead of leaving it.
    const gs = grandstandGeo(58, 11);
    const st = track.sampleByDistance(track.length * 0.05);
    this.at(st.t, land * (st.halfWidth + 13.5), _p, st);
    this.settle(_p, st.t, _n);
    const yaw = Math.atan2(-st.binormal.x * land, -st.binormal.z * land);
    const gm = trs(_p.x, _p.y, _p.z, yaw);
    this.acc.wood.add(gs.struct, gm, new THREE.Color(0xf1e9dc));
    // sink a plinth so the stand meets any slope without a gap
    this.acc.stone.add(bevelBox(60, 4.6, 12.0, 0.08, 0.28), _m4.multiplyMatrices(gm, trs(0, -2.2, -4.2, 0)).clone(), new THREE.Color(0xd9cdb8), (_x, y) => lerp(0.42, 1, smoothstep(-2.3, -0.4, y)));
    // Grounding and footprint, stamped along the length rather than as one
    // circle. A single 64 m shadow quad aligned to the normal at the stand's
    // centre cuts through any slope it sits on, and a single 32 m blocker
    // sterilises 60 m of near-frame band either side of a stand that is only
    // 12 m deep — which is how the start straight loses its foreground element.
    for (let k = 0; k < 5; k++) {
      const off = (k / 4 - 0.5) * 48;
      // the stand's length is its local X; yaw's X axis is (cos, 0, -sin)
      _p2.set(_p.x + Math.cos(yaw) * off, _p.y, _p.z - Math.sin(yaw) * off);
      this.settle(_p2, st.t);
      this.dropShadow(_p2, 8.5, st.t, 0.62);
      this.claim(_p2, 8.5);
    }
    for (const row of gs.seats) {
      const perRow = 42;
      for (let i = 0; i < perRow; i++) {
        // gaps and knots, not a solid confetti block
        if (rng() < 0.16 + Math.abs(Math.sin(i * 0.7 + row.y)) * 0.18) continue;
        const x = -27 + (i / (perRow - 1)) * 54 + (rng() - 0.5) * 0.7;
        const local = trs(x, row.y, row.z + 0.16, Math.PI + (rng() - 0.5) * 0.6, 0.84 + rng() * 0.36);
        this.spectator(_m4.multiplyMatrices(gm, local).clone(), rng);
      }
    }
    // a sponsor cloth along the stand fascia + pennants at both ends
    for (const sx of [-1, 1]) this.pennant(_m4.multiplyMatrices(gm, trs(sx * 29.6, 0, 1.4, 0, 1, 1.4, 1)).clone(), rng);
    this.standBanner(gm, 56, 11 * 0.52 + 3.4);

    // --- start-line masts. Tall, dark, vertical, right at the line, on both
    // sides. §1 wants the start dressed and grid.png is the shot where that
    // matters most — and it is also the shot where a low sun straight down the
    // road washes out everything with a soft edge. A vertical mast survives a
    // blowout that erases a grandstand, so the line still reads as a line.
    for (const sx of [-1, 1]) {
      const ls = this.ctx.track.sample(0.006);
      this.at(0.006, sx * (ls.halfWidth + 3.6), _p, ls);
      this.settle(_p, 0.006);
      if (!this.isSea(0.006, sx * (ls.halfWidth + 3.6), ls)) {
        for (let k = 0; k < 3; k++) {
          _p2.set(_p.x + ls.tangent.x * (k - 1) * 3.4, _p.y, _p.z + ls.tangent.z * (k - 1) * 3.4);
          this.settle(_p2, 0.006);
          this.pennant(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 1, 1.5 + k * 0.28, 1), rng);
          this.dropShadow(_p2, 0.45, 0.006, 0.7);
        }
      }
    }

    // --- harbour front on the sea side: bollards, crates, nets, boats
    let quayed = 0;
    this.walk(0.0, 0.10, 9, (t, s) => {
      if (!this.isSea(t, sea * (s.halfWidth + 24), s)) return;
      quayed++;
      this.quaySegment(t, s, sea, 9.5);
      const lat = sea * (s.halfWidth + 3.4);
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      this.sets.bollard.add(trs(_p.x, _p.y, _p.z, rng() * 6.28), { color: _col.set(0x3a4046).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 120 });
      this.dropShadow(_p, 0.5, t, 0.8);
      if (rng() < 0.8) this.clutter(t, sea * (s.halfWidth + 5.5 + rng() * 2.5), rng);
      if (rng() < 0.7) this.mooredBoat(t, s, sea, rng);
    });

    // §1 promises "moored boats right" here, but whether the start straight
    // actually fronts open water is the track agent's call and on the current
    // layout it does not — which is why grid.png's right-hand side is a bare
    // green hill. Rather than leave the signature shot undressed, mirror the
    // stand's energy with a paddock: a market row, a raised spectator bank and
    // a flag avenue. Same read (built mass + crowd + verticals), no water.
    if (quayed === 0) {
      this.walk(0.005, 0.10, 12, (t, s, i) => {
        const lat = sea * (s.halfWidth + 11 + this.hash1(i, 0x2c1) * 9);
        if (this.isSea(t, lat, s)) return;
        this.at(t, lat, _p, s);
        this.settle(_p, t, _n);
        if (this.blocked(_p, 3.5)) return;
        if (!this.flatWorld && (this.surfaceAt(_p, t) === Surface.Road || _n.y < 0.86)) return;
        const inward = Math.atan2(-s.binormal.x * sea, -s.binormal.z * sea);
        const k = i & 1;
        const m = trs(_p.x, _p.y, _p.z, inward + (rng() - 0.5) * 0.5);
        this.sets['stallFrame' + k].add(m, { color: _col.set(0xefe4cf).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 200 });
        this.sets['stallCanopy' + k].add(m, { uv: new THREE.Vector4(0.25, 0.25, ((rng() * 4) | 0) * 0.25, ((rng() * 4) | 0) * 0.25), lod: 200 });
        this.dropShadow(_p, 2.2, t, 0.85);
        this.claim(_p, 3.0);
        for (let q = 0; q < 4; q++) {
          _p2.set(_p.x + (rng() - 0.5) * 7, _p.y, _p.z + (rng() - 0.5) * 7);
          this.settle(_p2, t);
          this.spectator(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 0.86 + rng() * 0.32), rng);
          this.dropShadow(_p2, 0.34, t, 0.7);
        }
        // flag avenue along the front of the row
        if (i % 2 === 0) {
          this.at(t, sea * (s.halfWidth + 6.4), _p2, s);
          this.settle(_p2, t);
          this.pennant(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 1, 1.15 + rng() * 0.5, 1), rng);
        }
      });
      this.barrierCrowd(0.01, 0.1, sea, 0.5);
    }

    // sponsor boards + tyre stacks on the land side
    this.walk(0.012, 0.095, 11, (t, s) => {
      this.sponsorBoard(t, s, land, rng);
      if (rng() < 0.4) this.tyreStack(t, s, land, rng);
    });
    // spectators lining the land-side barrier
    this.barrierCrowd(0.01, 0.1, land, 0.55);
  }

  /** 0.10–0.22: harbour sweep — the marina. */
  private dressHarbour() {
    const rng = this.rng;
    const sea = this.seaSide(0.16);
    const land = -sea;
    this.walk(0.10, 0.225, 7.5, (t, s) => {
      // Only quay the stretches that actually front open water — the sea side
      // is derived from the terrain, and it can wander on a real circuit.
      if (!this.isSea(t, sea * (s.halfWidth + 22), s)) return;
      this.quaySegment(t, s, sea, 8.0);
      const lat = sea * (s.halfWidth + 3.2);
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      if (rng() < 0.75) {
        this.sets.bollard.add(trs(_p.x, _p.y, _p.z, rng() * 6.28), { color: _col.set(0x3a4046).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 120 });
        this.dropShadow(_p, 0.5, t, 0.8);
      }
      if (rng() < 0.7) this.clutter(t, sea * (s.halfWidth + 5.2 + rng() * 3), rng);
      if (rng() < 0.85) this.mooredBoat(t, s, sea, rng);
      if (rng() < 0.3) this.pennant(trs(_p.x, _p.y, _p.z, rng() * 6.28), rng);
    });
    // jetties reaching out into the basin
    this.walk(0.115, 0.21, 34, (t, s) => {
      if (!this.isSea(t, sea * (s.halfWidth + 30), s)) return;
      this.jetty(t, s, sea, 16 + rng() * 10);
    });
    this.barrierCrowd(0.11, 0.22, land, 0.32);
    this.walk(0.10, 0.225, 16, (t, s) => {
      this.sponsorBoard(t, s, land, rng);
    });
  }

  /** 0.22–0.38: village climb — terraced houses both sides. */
  private dressVillage() {
    const rng = this.rng;
    const anchors: THREE.Vector3[] = [];
    for (const side of [-1, 1]) {
      this.terrace(0.225, 0.385, side, 5.5, rng, anchors);
      // a second, taller row set back up the hillside
      if (rng() < 0.95) this.terrace(0.235, 0.375, side, 24, rng, anchors, 1);
    }
    // laundry strung between whatever anchors ended up facing each other
    this.stringLaundry(anchors, rng);

    // cypress punctuation + potted greenery along the street
    this.walk(0.225, 0.385, 13, (t, s) => {
      for (const side of [-1, 1]) {
        if (this.isSea(t, side * (s.halfWidth + 4), s)) continue;
        if (rng() < 0.5) {
          this.at(t, side * (s.halfWidth + 3.4 + rng() * 1.6), _p, s);
          this.settle(_p, t);
          this.foliage.cyp(_p.clone(), 0.75 + rng() * 0.45, rng() * 6.28, t);
        }
        if (rng() < 0.6) {
          this.at(t, side * (s.halfWidth + 2.4 + rng()), _p, s);
          this.settle(_p, t);
          this.foliage.bush(_p.clone(), 0.5 + rng() * 0.35, rng() * 6.28, t);
        }
      }
    });
    this.barrierCrowd(0.24, 0.37, 1, 0.22);
    this.barrierCrowd(0.24, 0.37, -1, 0.22);
  }

  /** 0.38–0.52: cliff traverse — sparse, wind-bent, exposed. */
  private dressCliff() {
    const rng = this.rng;
    // Marker posts get their own tighter walk: closeup.png had ONE lone post in
    // the near band, and a rhythm of them along the drop is what gives a
    // clifftop shot its structure.
    this.walk(0.375, 0.53, 4.5, (t, s) => {
      const sea = this.seaSide(t);
      this.at(t, sea * (s.halfWidth + 1.4), _p, s);
      this.settle(_p, t);
      const hgt = 1.0 + (t * 137) % 0.28;
      this.acc.stone.add(bevelBox(0.24, hgt, 0.24, 0.03, 1.1), trs(_p.x, _p.y + hgt * 0.45, _p.z, rng() * 6.28), new THREE.Color(0xf0e8d8), (_x, y) => lerp(0.5, 1, smoothstep(-hgt * 0.4, -hgt * 0.1, y)));
      this.acc.trim.add(bevelBox(0.3, 0.09, 0.3, 0.02, 2), trs(_p.x, _p.y + hgt * 0.95, _p.z, 0), new THREE.Color(0xe0453f));
      this.dropShadow(_p, 0.34, t, 0.7);
      // clifftop scrub on the seaward lip: wind-bent, low, and it puts
      // something between the lens and the drop
      if (rng() < 0.55) {
        this.at(t, sea * (s.halfWidth + 2.2 + rng() * 2.6), _p2, s);
        this.settle(_p2, t);
        if (!this.isSea(t, sea * (s.halfWidth + 2.2), s)) {
          if (rng() < 0.7) this.foliage.bush(_p2.clone(), 0.6 + rng() * 0.5, rng() * 6.28, t, true);
          else this.foliage.tuft(_p2.clone(), 1.0 + rng() * 0.6, rng() * 6.28, true);
        }
      }
    });
    this.walk(0.38, 0.525, 10, (t, s) => {
      const land = -this.seaSide(t);
      if (rng() < 0.55) {
        this.at(t, land * (s.halfWidth + 2.6 + rng() * 5), _p, s);
        this.settle(_p, t);
        if (rng() < 0.4) this.foliage.pine(_p.clone(), 0.62 + rng() * 0.28, rng() * 6.28, t);
        else this.foliage.bush(_p.clone(), 0.7 + rng() * 0.6, rng() * 6.28, t, true);
      }
      if (rng() < 0.35) this.marshalPost(t, s, land, rng);
      // loose rock at the verge
      if (rng() < 0.5) {
        this.at(t, land * (s.halfWidth + 1.6 + rng() * 3), _p, s);
        this.settle(_p, t);
        this.sets['debris' + ((rng() * 3) | 0)].add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 0.8 + rng() * 1.4), {
          color: _col.set(0xbfae95).clone(),
          uv: new THREE.Vector4(1, 1, 0, 0),
          lod: 80,
        });
      }
    });
    this.walk(0.39, 0.51, 24, (t, s) => this.sponsorBoard(t, s, -this.seaSide(t), rng));
  }

  /** 0.60–0.74: beach descent — palms, parasols, tide line. */
  private dressBeach() {
    const rng = this.rng;
    this.walk(0.60, 0.745, 8, (t, s) => {
      const sea = this.seaSide(t);
      const land = -sea;
      // hero palms tight to the road, both sides
      if (rng() < 0.8) {
        const side = rng() < 0.6 ? sea : land;
        this.at(t, side * (s.halfWidth + 2.6 + rng() * 3.5), _p, s);
        if (!this.isSea(t, side * (s.halfWidth + 2.6), s)) {
          this.settle(_p, t);
          this.foliage.palm(_p.clone(), 0.85 + rng() * 0.5, rng() * 6.28, t);
        }
      }
      if (rng() < 0.55) {
        this.at(t, land * (s.halfWidth + 6 + rng() * 7), _p, s);
        this.settle(_p, t);
        this.foliage.palm(_p.clone(), 0.75 + rng() * 0.45, rng() * 6.28, t);
      }
      // beach furniture between the road and the water
      for (let k = 0; k < 2; k++) {
        const lat = sea * (s.halfWidth + 7 + rng() * 16);
        if (this.isSea(t, lat, s)) continue;
        this.at(t, lat, _p, s);
        this.settle(_p, t);
        if (this.flatWorld || this.surfaceAt(_p, t) !== Surface.Road) {
          if (rng() < 0.45) this.parasol(_p.clone(), t, rng);
          else if (rng() < 0.6) this.deckchair(_p.clone(), t, rng);
          else this.foliage.tuft(_p.clone(), 0.9 + rng() * 0.6, rng() * 6.28, true);
        }
      }
      // tide-line debris right at the waterline
      const tideLat = this.findWaterline(t, s, sea);
      if (tideLat !== null) {
        for (let k = 0; k < 3; k++) {
          this.at(t, tideLat - sea * (rng() * 3.5), _p, s);
          this.settle(_p, t);
          this.sets['debris' + ((rng() * 3) | 0)].add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 0.7 + rng() * 0.8), {
            color: _col.setHSL(0.1, 0.15, 0.5 + rng() * 0.3).clone(),
            uv: new THREE.Vector4(1, 1, 0, 0),
            lod: 70,
          });
          if (rng() < 0.4) this.foliage.tuft(_p.clone(), 0.7 + rng() * 0.4, rng() * 6.28, true);
        }
      }
    });
    this.walk(0.61, 0.735, 20, (t, s) => this.sponsorBoard(t, s, -this.seaSide(t), rng));
    this.barrierCrowd(0.62, 0.73, -this.seaSide(0.68), 0.25);
  }

  /** 0.74–0.86: the banked money shot — grandstand energy without the stand. */
  private dressBankedCurve() {
    const rng = this.rng;
    this.walk(0.74, 0.865, 9, (t, s) => {
      const out = this.seaSide(t);
      const land = -out;
      this.sponsorBoard(t, s, land, rng);
      if (rng() < 0.5) this.tyreStack(t, s, land, rng);
      if (rng() < 0.3) this.marshalPost(t, s, land, rng);
      if (rng() < 0.45) {
        this.at(t, land * (s.halfWidth + 7 + rng() * 5), _p, s);
        this.settle(_p, t);
        this.foliage.bush(_p.clone(), 0.8 + rng() * 0.7, rng() * 6.28, t, rng() < 0.5);
      }
      if (rng() < 0.28) {
        this.at(t, land * (s.halfWidth + 9 + rng() * 8), _p, s);
        this.settle(_p, t);
        this.foliage.pine(_p.clone(), 0.8 + rng() * 0.35, rng() * 6.28, t);
      }
    });
    this.barrierCrowd(0.75, 0.86, -this.seaSide(0.80), 0.7);
    this.walk(0.75, 0.86, 26, (t, s) => {
      this.at(t, -this.seaSide(t) * (s.halfWidth + 4.4), _p, s);
      this.settle(_p, t);
      this.pennant(trs(_p.x, _p.y, _p.z, rng() * 6.28), rng);
    });
    // The OUTER edge of the banked curve is the seaward side, and round 1 left
    // it a bare embankment — §1 promises "full bay visible below" here. Give
    // the drop side a barrier-post rhythm and a pennant line so the outside of
    // the money shot has structure against the water.
    // Posts sit 2.4 m out, clear of whatever barrier the track agent owns at
    // the road edge — this module never places furniture inside their kerb.
    this.walk(0.735, 0.875, 5.0, (t, s, i) => {
      const out = this.seaSide(t);
      const lat = out * (s.halfWidth + 2.4);
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      if (this.isSea(t, lat, s)) return;
      const yaw = Math.atan2(s.tangent.x, s.tangent.z);
      const hgt = 1.15;
      this.acc.wood.add(bevelBox(0.2, hgt, 0.2, 0.03, 2.4), trs(_p.x, _p.y + hgt * 0.42, _p.z, yaw), new THREE.Color(0xf0e6d4), (_x, y) => lerp(0.45, 1, smoothstep(-hgt * 0.42, -hgt * 0.1, y)));
      this.dropShadow(_p, 0.3, t, 0.65);
      if (i % 3 === 0) this.pennant(trs(_p.x, _p.y, _p.z, yaw, 1, 0.9, 1), rng);
      if (i % 5 === 2) {
        this.at(t, out * (s.halfWidth + 3.6), _p2, s);
        this.settle(_p2, t);
        this.foliage.bush(_p2.clone(), 0.75 + rng() * 0.5, rng() * 6.28, t, true);
      }
    });
  }

  /** 0.86–1.00: bridge, headland, windmill and lighthouse. */
  private dressBridgeAndHeadland() {
    const rng = this.rng;
    const track = this.ctx.track;

    // --- windmill on the landward headland
    {
      const s = track.sample(0.925);
      const land = -this.seaSide(0.925);
      this.at(0.925, land * (s.halfWidth + 34), _p, s);
      this.settle(_p, 0.925);
      const wm = windmillGeo();
      const yaw = Math.atan2(-s.binormal.x * land, -s.binormal.z * land);
      const base = trs(_p.x, _p.y, _p.z, yaw);
      this.acc.wall.add(wm.tower, base, new THREE.Color(0xf3ece0), (_x, y) => lerp(0.55, 1, smoothstep(0, 2.4, y)));
      this.acc.trim.add(wm.trim, base, new THREE.Color(0xe8dccb));
      this.acc.stone.add(bevelBox(9.2, 2.6, 9.2, 0.1, 0.28), _m4.multiplyMatrices(base, trs(0, -1.15, 0, 0)).clone(), new THREE.Color(0xcfc1a8));
      const rotor = new THREE.Group();
      rotor.position.copy(_p);
      rotor.rotation.y = yaw;
      const hub = new THREE.Group();
      hub.position.set(0, wm.hubY, wm.hubZ);
      const rm = new THREE.Mesh(wm.rotor, this.mats.wood);
      rm.name = 'windmill-rotor';
      rm.castShadow = true;
      hub.add(rm);
      const sails = new THREE.InstancedMesh(wm.sail, this.mats.fabric, 4);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        sails.setMatrixAt(i, _m4.compose(_p2.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, a - Math.PI / 2, 'YXZ')), _n.set(1, 1, 1)));
      }
      sails.instanceMatrix.needsUpdate = true;
      sails.geometry.setAttribute('aUv', new THREE.InstancedBufferAttribute(new Float32Array([0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.5]), 4));
      sails.name = 'windmill-sails';
      sails.castShadow = true;
      sails.frustumCulled = false;
      hub.add(sails);
      rotor.add(hub);
      this.group.add(rotor);
      this.rotor = hub;
      this.dropShadow(_p, 5.2, 0.925, 0.9);
    }

    // --- lighthouse out on the seaward point, on its own rock
    {
      const s = track.sample(0.895);
      const sea = this.seaSide(0.895);
      const lat = sea * (s.halfWidth + 48);
      this.at(0.895, lat, _p, s);
      const gy = this.flatWorld ? this.seaLevel + 1.2 : this.groundY(_p, 0.895);
      _p.y = Math.max(gy, this.seaLevel + 0.8);
      const lh = lighthouseGeo(_p.y, this.seaLevel);
      const base = trs(_p.x, _p.y, _p.z, rng() * 6.28);
      this.acc.stone.add(lh.stone, base, new THREE.Color(0xf2ece0));
      this.acc.trim.add(lh.trim, base, new THREE.Color(0xf0e6d6));
      // The lantern is emissive geometry rather than a real light: adding a
      // point light here would change the light count for every material in
      // the scene, which is not this module's call to make.
      const lampMesh = new THREE.Mesh(lh.glass, this.mats.lamp);
      lampMesh.applyMatrix4(base);
      lampMesh.name = 'lighthouse-lamp';
      this.group.add(lampMesh);
      // A gallery pennant marks the lamp height without adding a real light —
      // one more point light would change the light count for every material
      // in the scene, which is not this module's call to make.
      this.pennant(_m4.multiplyMatrices(base, trs(0, lh.lampY + 3.1, 0, 0, 0.7)).clone(), rng);
    }

    // --- return leg planting and furniture
    this.walk(0.865, 1.0, 11, (t, s) => {
      const land = -this.seaSide(t);
      if (rng() < 0.55) {
        this.at(t, land * (s.halfWidth + 4 + rng() * 8), _p, s);
        this.settle(_p, t);
        if (rng() < 0.45) this.foliage.pine(_p.clone(), 0.8 + rng() * 0.4, rng() * 6.28, t);
        else if (rng() < 0.6) this.foliage.cyp(_p.clone(), 0.85 + rng() * 0.4, rng() * 6.28, t);
        else this.foliage.bush(_p.clone(), 0.8 + rng() * 0.6, rng() * 6.28, t);
      }
      this.sponsorBoard(t, s, land, rng);
      if (rng() < 0.3) this.tyreStack(t, s, land, rng);
      const sea = this.seaSide(t);
      if (this.isSea(t, sea * (s.halfWidth + 26), s) && rng() < 0.4) this.mooredBoat(t, s, sea, rng);
    });
    this.barrierCrowd(0.94, 1.0, -this.seaSide(0.97), 0.5);
  }

  /** Grass and small planting along every shoulder that is not sand or road. */
  private dressShoulders() {
    const rng = this.rng;
    const density = clamp(this.ctx.settings.foliageDensity ?? 1, 0, 2);
    if (density <= 0.01) return;
    const step = 2.0 / Math.max(0.2, density);
    this.walk(0.0, 1.0, step, (t, s) => {
      for (const side of [-1, 1]) {
        // Skip the tunnel — nothing grows in there.
        if (t > 0.515 && t < 0.605) continue;
        // Six tufts per station instead of four, and the band reaches 18 m out
        // rather than 8. The verge is 3 m from the lens in half these shots and
        // it had no geometric grass on it at all; the base sheet alone gives a
        // 40 m verge one flat value.
        //
        // The band is anchored on the REAL road edge, not on halfWidth: the
        // kerb corridor outboard of halfWidth is Surface.Road, so a distribution
        // starting at halfWidth + 0.7 threw most of its samples onto the kerb
        // and got them rejected — which is why the densest part of the verge,
        // the metre right at the kerb, was the emptiest.
        const edge = this.roadEdge(t, s, side);
        if (edge < 0) continue;
        // Four, not six: `dressGrassBand` now owns the same strip with clumps
        // four times this volume, and these small tufts are the filler between
        // them. Six of them plus the clumps would put the verge over budget for
        // no extra read.
        for (let k = 0; k < 4; k++) {
          // biased toward the kerb so the transition band is the densest part
          const rr = rng();
          const off = edge + 0.35 + rr * rr * 16.5;
          const lat = side * off;
          if (this.isSea(t, lat, s)) continue;
          this.at(t, lat, _p, s);
          this.settle(_p, t);
          // Once the band reaches past the building line, grass has to respect
          // the footprints the authored structures claimed — a tuft growing out
          // of a house wall or through a market stall is worse than a bare verge.
          if (off > edge + 3 && this.blocked(_p, -0.5)) continue;
          const surf = this.flatWorld ? Surface.Grass : this.surfaceAt(_p, t);
          if (surf === Surface.Road || surf === Surface.Boost) continue;
          const beach = surf === Surface.Sand;
          if (beach && rng() > 0.35) continue;
          this.foliage.tuft(_p.clone(), (beach ? 0.85 : 0.75) + rng() * 0.6, rng() * 6.28, beach);
        }
        if (rng() < 0.10 * density) {
          const lat = side * (s.halfWidth + 3 + rng() * 6);
          if (this.isSea(t, lat, s)) continue;
          this.at(t, lat, _p, s);
          this.settle(_p, t);
          if (this.flatWorld || this.surfaceAt(_p, t) !== Surface.Road) this.foliage.bush(_p.clone(), 0.5 + rng() * 0.55, rng() * 6.28, t, rng() < 0.3);
        }
      }
    });
  }

  /**
   * Low-frequency clump mask, 0 = fresh growth, 1 = sun-bleached.
   *
   * Two out-of-phase products of sines at ~6 m and ~19 m, plus a slope term.
   * The 6 m octave is the clump itself; the 19 m octave is the reason a whole
   * shoulder goes dry while the next one stays green, which is what round 1's
   * uniform-frequency verge lacked. The slope term bleaches the crest of a
   * hillside because that is where the sun sits on it all day — grid.png's note
   * about "no sun-bleaching toward the crest" is exactly this term.
   */
  private clumpMask(x: number, z: number, rise: number): number {
    const fine = Math.sin(x * 1.05 + Math.sin(z * 0.72) * 1.4) * Math.sin(z * 0.94 + 0.7);
    const coarse = Math.sin(x * 0.33 - 1.1) * Math.sin(z * 0.29 + 2.3);
    let m = 0.5 + fine * 0.26 + coarse * 0.3;
    // rise is metres above the road at this sample: crests dry out
    m += clamp(rise / 14, 0, 1) * 0.3;
    return clamp(m, 0, 1);
  }

  /**
   * The hero grass band — a 12 m strip of instanced blade clumps either side of
   * the road.
   *
   * This is the single highest-value thing missing from round 1 and it is one
   * InstancedMesh. Without geometry at the verge the terrain sheet has to carry
   * the whole read, and a painted sheet has no silhouette: no blades against the
   * sky, no blades over the kerb, and therefore the razor-straight grass/kerb
   * line every wide shot showed. Density is biased hard toward the kerb, a
   * fraction of the clumps deliberately straddle the kerb lip, and colour and
   * roughness both come off `clumpMask` so the band has light and dark patches
   * instead of one frequency of acid green.
   */
  private dressGrassBand() {
    const rng = this.rng;
    const density = clamp(this.ctx.settings.foliageDensity ?? 1, 0, 2);
    if (density <= 0.01) return;
    // ~1600 m of centreline at 3.2 m, two sides, two clumps a station ≈ 2000
    // instances at density 1 — inside the 1500–3000 the note asks for.
    const step = 3.2 / clamp(density, 0.35, 1.6);
    this.walk(0.0, 1.0, step, (t, s) => {
      if (t > 0.512 && t < 0.606) return; // nothing grows in the tunnel
      for (const side of [-1, 1]) {
        const edge = this.roadEdge(t, s, side);
        if (edge < 0) continue;
        // How far this shoulder climbs above the road, for the bleaching term.
        this.at(t, side * (edge + 9), _p2, s);
        const rise = (this.flatWorld ? s.pos.y : this.groundY(_p2, t)) - s.pos.y;
        for (let k = 0; k < 2; k++) {
          // A fifth of the clumps sit ON the kerb lip. That overlap is what
          // kills the ruled line — the transition has to be broken by
          // silhouette, not by a wider dirt decal.
          const onKerb = k === 0 && rng() < 0.22;
          const rr = rng();
          // The kerb-straddling clumps sit on the OUTER lip only. Any further in
          // and a kart clipping the kerb drives visibly through them.
          const off = onKerb ? edge - 0.14 - rng() * 0.22 : edge + 0.2 + rr * rr * 11.5;
          const lat = side * off;
          if (this.isSea(t, lat, s)) continue;
          this.at(t, lat, _p, s);
          this.settle(_p, t, _n);
          if (off > edge + 3 && this.blocked(_p, -0.4)) continue;
          if (!this.flatWorld && !onKerb) {
            const surf = this.surfaceAt(_p, t);
            if (surf === Surface.Road || surf === Surface.Boost) continue;
            // sand gets marram from dressShoulders, not lawn grass
            if (surf === Surface.Sand) continue;
          }
          const dry = this.clumpMask(_p.x, _p.z, rise);
          // clumps on the kerb are trodden down; clumps out in the band are not
          const sc = onKerb ? 0.46 + rng() * 0.26 : 0.85 + rng() * 0.7;
          // lean the kerb-side clumps away from the road, as if brushed by traffic
          this.foliage.clump(_p.clone(), sc, rng() * 6.28, dry, onKerb ? 0.22 : (rng() - 0.5) * 0.12);
        }
      }
    });
  }

  /**
   * Frame balance.
   *
   * boost.png, corner.png and drift.png all failed the same way: one side of the
   * frame is a solid occluder (cliff face, terrace wall) and the other side is
   * empty water and sky, so depth collapses onto two planes with no midground
   * bridging them. The rule, applied every 25 m of centreline: if one side's
   * occlusion height exceeds a threshold, the OPPOSITE side must receive a
   * midground cluster at 25–70 m. Over water that is a rock stack, a boat raft
   * or a buoy line; over land it is a jetty-scale timber structure, a walled
   * enclosure or a stand of pines. It is a rule rather than a hand-placed list
   * because the terrain belongs to the track agent and will move under us.
   */
  private dressOpposingMidground() {
    const rng = this.rng;
    let seed = 0x3add;
    this.walk(0.0, 1.0, 25, (t, s, idx) => {
      if (t > 0.49 && t < 0.63) return;
      // Occlusion height per side: how far the ground rises above the road
      // within the near band. A cliff wall reads 8–20 m here, a verge ~1 m.
      let hi = -1;
      let occl = 0;
      for (const side of [-1, 1]) {
        let rise = 0;
        for (const d of [8, 16, 26]) {
          this.at(t, side * (s.halfWidth + d), _p, s);
          rise = Math.max(rise, (this.flatWorld ? s.pos.y : this.groundY(_p, t)) - s.pos.y);
        }
        if (rise > occl) {
          occl = rise;
          hi = side;
        }
      }
      if (occl < 6 || hi === 0) return;
      const open = -hi;
      // Only fill a side that is genuinely empty: if the open side also has
      // structure, the frame already has a midground and another cluster is
      // clutter, not depth.
      this.at(t, open * (s.halfWidth + 22), _p2, s);
      if (!this.flatWorld && this.groundY(_p2, t) - s.pos.y > 3.5) return;

      const dist = 26 + this.hash1(idx, 0x71) * 44;
      const lat = open * (s.halfWidth + dist);
      const overSea = this.isSea(t, lat, s);
      this.at(t, lat, _p, s);

      if (overSea) {
        const kind = this.hash1(idx, 0x82);
        if (kind < 0.42) {
          // Rock stack. It breaks the water surface, which also hands the eye
          // the waterline it needs to read the height of the drop.
          _p.y = this.seaLevel;
          if (!this.flatWorld && this.groundY(_p, t) > this.seaLevel - 1.2) return;
          const r = 4.5 + this.hash1(idx, 0x93) * 6;
          const h = 7 + this.hash1(idx, 0xa4) * 13;
          this.acc.stone.add(landmassGeo(r, h, seed++, 0, 1.8, 26, 8), trs(_p.x, this.seaLevel - 0.6, _p.z, this.hash1(idx, 0xb5) * 6.28), new THREE.Color(0xb8a68d), (_x, y) =>
            lerp(0.5, 1.05, smoothstep(0, h * 0.55, y))
          );
          for (let k = 0; k < 2; k++) {
            const a = this.hash1(idx * 5 + k, 0xc6) * 6.28;
            this.sets['debris' + (k % 3)].add(trs(_p.x + Math.cos(a) * r * 1.2, this.seaLevel - 0.5, _p.z + Math.sin(a) * r * 1.2, a, 1.6 + rng() * 2), {
              color: _col.set(0xac9d85).clone(),
              uv: new THREE.Vector4(1, 1, 0, 0),
              lod: 0,
            });
          }
          this.sets.gull.add(trs(_p.x, this.seaLevel + h * 0.95, _p.z, 0, 1.2), {
            bob: new THREE.Vector4(r + 7, 0.24, this.hash1(idx, 0xd7) * 6.28, 5),
            color: _col.setHSL(0.09, 0.06, 0.88).clone(),
          });
        } else if (kind < 0.78) {
          // A raft of moored boats reads as a plane on the water.
          const yaw0 = Math.atan2(s.tangent.x, s.tangent.z) + (rng() - 0.5) * 0.6;
          for (let k = 0; k < 3; k++) {
            this.at(t, open * (dist + (rng() - 0.5) * 22), _p, s);
            _p.x += (rng() - 0.5) * 16;
            _p.z += (rng() - 0.5) * 16;
            if (!this.flatWorld && this.groundY(_p, t) > this.seaLevel - 0.8) continue;
            _p.y = this.seaLevel;
            this.boatAt(trs(_p.x, _p.y, _p.z, yaw0 + (rng() - 0.5) * 0.4), rng, 1.0 + rng() * 0.7);
          }
        } else {
          // Buoy line plus a mooring pile cluster: small, but three objects at
          // one depth is all it takes to stop the water being a gradient.
          for (let k = 0; k < 4; k++) {
            this.at(t, open * (dist + k * (7 + rng() * 6)), _p, s);
            if (!this.isSea(t, open * (dist + k * 7), s)) continue;
            _p.y = this.seaLevel;
            this.sets.buoy.add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 1.0 + rng() * 0.6), {
              color: _col.set(pick(rng, [0xe0453f, 0xff9d2e, 0xf2ece0, 0x2f5d43])).clone(),
              uv: new THREE.Vector4(1, 1, 0, 0),
              bob: new THREE.Vector4(0.11 + rng() * 0.07, rng() * 6.28, 0.05 + rng() * 0.04, 0),
              lod: 380,
            });
          }
        }
        return;
      }

      // Landward and empty: give it built mass at midground scale.
      this.settle(_p, t, _n);
      if (this.blocked(_p, 5)) return;
      if (!this.flatWorld && this.surfaceAt(_p, t) === Surface.Road) return;
      const inward = Math.atan2(-s.binormal.x * open, -s.binormal.z * open);
      const kind = this.hash1(idx, 0xe8);
      if (kind < 0.4) {
        // fishing shack / field barn: one gable, one lean-to, two crates
        const w = 5.5 + rng() * 3;
        const h = 3.4 + rng() * 1.6;
        const base = trs(_p.x, _p.y, _p.z, inward + (rng() - 0.5) * 0.5);
        this.acc.wall.add(bevelBox(w, h, w * 0.8, 0.06, 0.4), _m4.multiplyMatrices(base, trs(0, h / 2, 0, 0)).clone(), _col.set(pick(rng, PAL.pastels)).clone(), (_x, y) =>
          lerp(0.55, 1, smoothstep(-h * 0.5, -h * 0.1, y))
        );
        this.acc.roof.add(bevelBox(w + 0.8, 0.3, w * 0.95, 0.05, 0.7), _m4.multiplyMatrices(base, trs(0, h + 0.15, 0, 0, 1, 1, 1, 0.22)).clone(), new THREE.Color(0xb5643f));
        this.acc.wood.add(bevelBox(w * 0.55, 2.3, 0.18, 0.03, 2), _m4.multiplyMatrices(base, trs(w * 0.1, 1.15, w * 0.42, 0)).clone(), new THREE.Color(0xd9cbb2));
        this.dropShadow(_p, w * 0.75, t, 0.85);
        this.claim(_p, w * 0.8);
        for (let k = 0; k < 2; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 6, _p.y, _p.z + (rng() - 0.5) * 6);
          this.settle(_p2, t);
          this.sets.crate.add(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28), { color: _col.setHSL(0.09, 0.26, 0.5).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 140 });
        }
      } else if (kind < 0.72) {
        // stand of pines with understorey — a soft mass, not a wall
        for (let k = 0; k < 4; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 13, _p.y, _p.z + (rng() - 0.5) * 13);
          this.settle(_p2, t);
          if (this.blocked(_p2, 2)) continue;
          if (rng() < 0.7) this.foliage.pine(_p2.clone(), 1.0 + rng() * 0.5, rng() * 6.28, t);
          else this.foliage.cyp(_p2.clone(), 1.1 + rng() * 0.5, rng() * 6.28, t);
        }
        for (let k = 0; k < 3; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 15, _p.y, _p.z + (rng() - 0.5) * 15);
          this.settle(_p2, t);
          this.foliage.bush(_p2.clone(), 1.0 + rng() * 0.7, rng() * 6.28, t, rng() < 0.4);
        }
      } else {
        // walled enclosure: a low run of dry stone with a cypress pair at one
        // corner. Cheap, and the horizontal reads as cultivation.
        this.stoneRun(t, s, lat, 14 + rng() * 10, rng);
        for (let k = 0; k < 2; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 7, _p.y, _p.z + (rng() - 0.5) * 7);
          this.settle(_p2, t);
          this.foliage.cyp(_p2.clone(), 1.15 + rng() * 0.4, rng() * 6.28, t);
        }
      }
    });
  }

  /**
   * The kerb-to-grass transition band.
   *
   * Round 1's verge butted grass straight against tarmac on a ruled line, which
   * is a thing that exists nowhere outdoors — every real road edge has a metre
   * of trodden dirt, spilled grit and dead grass. The strip is a lit decal (not
   * an unlit stamp) so it darkens in shadow with the ground it lies on, its
   * inner edge is ragged in the texture rather than parallel to the kerb, and it
   * is instanced: the whole 1600 m of both verges is one draw call.
   */
  private dressVergeTransition() {
    const set = this.sets.verge;
    if (!set) return;
    const SEG = 4.2;
    // A hair of overlap closes the crack where two segments settle onto
    // different bits of camber, without a double-blended band wide enough to
    // read as a rhythm every four metres.
    const OVER = 0.14;
    this.walk(0.0, 1.0, SEG, (t, s) => {
      // Nothing inside the tunnel, and nothing where the road edge is water.
      if (t > 0.512 && t < 0.606) return;
      for (const side of [-1, 1]) {
        // The road edge is NOT halfWidth: the track owns a kerb corridor
        // outboard of it, and its width is theirs to change. Probe outward for
        // the first sample that stops reporting Road and put the band's inner
        // edge exactly there, so the dirt never smears across the kerb.
        const inner = this.roadEdge(t, s, side);
        if (inner < 0) continue;
        // Orientation from the middle of the band (representative camber), but
        // the quad's ORIGIN height from the kerb edge itself — sampling the
        // height 1.15 m out and using it at the inner edge sinks the strip under
        // the kerb wherever the verge falls away from the road.
        const lat = side * (inner + 1.15);
        if (this.isSea(t, lat, s)) continue;
        this.at(t, lat, _p, s);
        this.settle(_p, t, _n);
        // Local +X must point away from the road; local Z then runs along it.
        const ox = s.binormal.x * side;
        const oz = s.binormal.z * side;
        const yaw = Math.atan2(-oz, ox);
        // Align to the ground first, then spin about the (new) up axis.
        _q.setFromUnitVectors(_up, this.flatWorld ? _up : _n);
        _q2.setFromEuler(_e.set(0, yaw, 0, 'YXZ'));
        _q.multiply(_q2);
        this.at(t, side * inner, _p2, s);
        this.settle(_p2, t);
        _p2.y += 0.035;
        _m4.compose(_p2, _q, _scl.set(2.3, 1, SEG + OVER));
        set.add(_m4, { uv: new THREE.Vector4(1, 1, 0, 0), lod: 130 });
      }
    });
  }

  /**
   * Lateral offset of the outer edge of the driveable corridor at `t` on `side`,
   * found by probing rather than assumed — the kerb width belongs to the track
   * agent. Returns -1 where the shoulder is water or nothing takes a decal.
   */
  private roadEdge(t: number, s: TrackSample, side: number): number {
    for (let q = 0.2; q < 3.6; q += 0.35) {
      const off = s.halfWidth + q;
      this.at(t, side * off, _p2, s);
      const surf = this.ctx.track.probe(_p2, t).surface;
      if (surf === Surface.Road || surf === Surface.Boost) continue;
      if (surf === Surface.Water) return -1;
      // back off a little so the band tucks under the kerb's outer lip rather
      // than leaving a hairline of bare terrain between the two
      return off - 0.12;
    }
    return -1;
  }

  // ==========================================================================
  // Near-frame pass — the foreground layer
  // ==========================================================================

  /**
   * Round 1 had nothing crossing the near frame edge in nine of ten shots, so
   * every frame sat on one depth plane at midground distance and died at
   * thumbnail size. This pass exists purely to break that: one tall element
   * every 60–90 m of centreline, alternating side, biased to the OUTSIDE of the
   * corner so it enters frame during turn-in, at 6–20 m from the racing line.
   *
   * The cheapest real occluders are bunting strung across the road and palms
   * leaned out over it — both are in §1/§6 of the bible and neither was visible
   * anywhere in the set.
   */
  private dressNearFrame() {
    const rng = this.rng;
    const track = this.ctx.track;
    const L = track.length || 1;
    let d = 12;
    let i = 0;
    let side = 1;
    while (d < L - 20) {
      const t = ((d / L) % 1 + 1) % 1;
      const s = track.sampleByDistance(d);
      // Bias outward: on a left-hander the outside is +binormal.
      const curv = this.curvature(t);
      const outside = Math.abs(curv) > 0.004 ? (curv > 0 ? 1 : -1) : side;
      const inTunnel = t > 0.505 && t < 0.615;
      const kind = this.hash1(i, 0x51ed);
      i++;
      side = -side;
      d += 62 + this.hash1(i, 0x9e37) * 28;
      if (inTunnel) continue;

      // Bunting across the road: two masts plus a catenary of pennants. It
      // reads at any distance, occludes the sky band, and costs one rope plus
      // ~16 triangles.
      if (kind < 0.3 && !this.isSea(t, s.halfWidth + 5, s) && !this.isSea(t, -(s.halfWidth + 5), s)) {
        if (this.crossBunting(t, s, rng)) continue;
      }

      // Site selection. The outside of a corner is preferred because that is
      // where an element sweeps into frame on turn-in — but on the cliff and the
      // banked curve the outside IS the sea, and round 1's version simply gave
      // up there. Those are precisely the sections whose frames were emptiest,
      // so fall back to the inside rather than skipping the station.
      let placed = -2;
      let lat = 0;
      const reach = 5.5 + rng() * 13;
      for (const cand of [outside, -outside]) {
        const l = cand * (s.halfWidth + reach);
        if (this.isSea(t, l, s)) continue;
        this.at(t, l, _p, s);
        this.settle(_p, t);
        // never grow a hero palm through a terrace wall
        if (this.blocked(_p, 3)) continue;
        if (!this.flatWorld) {
          const surf = this.surfaceAt(_p, t);
          if (surf === Surface.Road || surf === Surface.Boost) continue;
        }
        placed = cand;
        lat = l;
        break;
      }
      if (placed === -2) continue;
      const outward = placed;
      // yaw of the inward direction, so anything with a face looks at the road
      const inward = Math.atan2(-s.binormal.x * outward, -s.binormal.z * outward);

      if (kind < 0.56) {
        // Leaning palm — crown hangs out over the tarmac. This is the element
        // that made pack.png the one frame in the set that worked.
        const lean = 0.2 + rng() * 0.16;
        this.foliage.palm(_p.clone(), 1.15 + rng() * 0.4, rng() * 6.28, t, lean, inward);
        // a couple of understorey shrubs so the trunk is not a lone pole
        for (let k = 0; k < 2; k++) {
          this.at(t, lat - outward * (1.4 + rng() * 2.2), _p2, s);
          this.settle(_p2, t);
          this.foliage.bush(_p2.clone(), 0.85 + rng() * 0.6, rng() * 6.28, t, rng() < 0.3);
        }
      } else if (kind < 0.74) {
        // Flag-pole cluster: three masts of different heights, read as one mass
        for (let k = 0; k < 3; k++) {
          this.at(t + (k - 1) * (3.4 / L), lat + (rng() - 0.5) * 2.2, _p2, s);
          this.settle(_p2, t);
          this.pennant(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 1, 1.35 + rng() * 0.75, 1), rng);
          this.dropShadow(_p2, 0.4, t, 0.6);
        }
      } else if (kind < 0.88) {
        // Signage gantry: a full-height hoarding on stilts, tall enough to
        // break the horizon line rather than sit under it.
        const m = trs(_p.x, _p.y, _p.z, inward, 1.7 + rng() * 0.5, 2.1 + rng() * 0.6, 1);
        this.sets.sponsor.add(m, { uv: this.signCell(i), lod: 0 });
        this.sets.sponsorPost.add(m, { color: _col.set(0xb8bcc4).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 0 });
        this.dropShadow(_p, 2.6, t, 0.7);
      } else {
        // Cypress trio — the vertical accent §1 asks for through the village.
        for (let k = 0; k < 3; k++) {
          this.at(t + (k - 1) * (2.6 / L), lat + (rng() - 0.5) * 2.6, _p2, s);
          this.settle(_p2, t);
          this.foliage.cyp(_p2.clone(), 1.05 + rng() * 0.5, rng() * 6.28, t);
        }
      }
    }
  }

  /**
   * A bunting line across the road on two masts. Returns false if the ground
   * on either side will not take a mast.
   */
  private crossBunting(t: number, s: TrackSample, rng: RNG): boolean {
    const span = s.halfWidth + 3.2;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const [side, out] of [
      [1, a],
      [-1, b],
    ] as [number, THREE.Vector3][]) {
      this.at(t, side * span, out, s);
      this.settle(out, t);
      if (this.blocked(out, 1.5)) return false;
      if (!this.flatWorld) {
        const surf = this.surfaceAt(out, t);
        if (surf === Surface.Road || surf === Surface.Boost) return false;
      }
      const mastH = 6.4 + rng() * 1.4;
      this.acc.wood.add(bevelBox(0.16, mastH, 0.16, 0.03, 4), trs(out.x, out.y + mastH / 2, out.z, rng() * 6.28), new THREE.Color(0xf0e6d4));
      this.acc.wood.add(bevelBox(0.42, 0.16, 0.42, 0.03, 2), trs(out.x, out.y + 0.08, out.z, 0), new THREE.Color(0xd9cbb2));
      this.dropShadow(out, 0.55, t, 0.75);
      out.y += mastH - 0.3;
    }
    const dist = a.distanceTo(b);
    const sag = dist * 0.09;
    this.acc.rope.add(ropeGeo(a, b, sag, 0.03), _m4.identity(), new THREE.Color(0xd8cba8));
    const n = Math.max(6, Math.floor(dist / 1.15));
    for (let k = 1; k < n; k++) {
      const u = k / n;
      _p.lerpVectors(a, b, u);
      _p.y -= Math.sin(u * Math.PI) * sag;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
      this.sets.bunting.add(trs(_p.x, _p.y, _p.z, yaw, 1.1 + rng() * 0.3), {
        color: _col.set(pick(rng, PAL.crowd)).clone(),
        wind: new THREE.Vector4(rng() * 100, 0, 0, 0),
        lod: 220,
      });
    }
    return true;
  }

  // ==========================================================================
  // Depth bands — barrier, crowd, tents, tree line, buildings, hills
  // ==========================================================================

  /**
   * Nintendo layers the land side: barrier, crowd, a raised second crowd tier,
   * tents and stalls, a tree line, buildings, hills. Round 1 had barrier,
   * crowd, void — 100 m of unbroken flat green occupying a third of the frame.
   * This pass fills the 15–35 m and 40–90 m bands with instanced mass.
   */
  private dressLandBands() {
    const rng = this.rng;
    const density = clamp(this.ctx.settings.foliageDensity ?? 1, 0.25, 1.5);

    // --- mid band, 15–35 m: the paddock. Stalls, tents, walls, hedges.
    this.walk(0.0, 1.0, 26 / density, (t, s, i) => {
      if (t > 0.5 && t < 0.62) return;
      const land = -this.seaSide(t);
      const lat = land * (s.halfWidth + 15 + rng() * 20);
      if (this.isSea(t, lat, s)) return;
      this.at(t, lat, _p, s);
      this.settle(_p, t, _n);
      if (this.blocked(_p, 4)) return;
      if (!this.flatWorld) {
        if (this.surfaceAt(_p, t) === Surface.Road) return;
        // nothing man-made stands on a 1:2 slope
        if (_n.y < 0.86) return;
      }
      const inward = Math.atan2(-s.binormal.x * land, -s.binormal.z * land);
      const r = this.hash1(i, 0x2f7d);
      if (r < 0.3) {
        // market stall + a knot of people around it
        const k = i & 1;
        const m = trs(_p.x, _p.y, _p.z, inward + (rng() - 0.5) * 0.8);
        this.sets['stallFrame' + k].add(m, { color: _col.set(0xefe4cf).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 180 });
        this.sets['stallCanopy' + k].add(m, { uv: new THREE.Vector4(0.25, 0.25, ((rng() * 4) | 0) * 0.25, ((rng() * 4) | 0) * 0.25), lod: 180 });
        this.dropShadow(_p, 2.2, t, 0.85);
        this.claim(_p, 3.0);
        for (let q = 0; q < 3; q++) {
          _p2.set(_p.x + (rng() - 0.5) * 5, _p.y, _p.z + (rng() - 0.5) * 5);
          this.settle(_p2, t);
          this.spectator(trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 0.86 + rng() * 0.3), rng);
        }
      } else if (r < 0.5) {
        const k = i & 1;
        this.sets['tent' + k].add(trs(_p.x, _p.y, _p.z, inward + (rng() - 0.5) * 1.2, 1.0 + rng() * 0.35), {
          uv: new THREE.Vector4(0.25, 0.25, ((rng() * 4) | 0) * 0.25, ((rng() * 4) | 0) * 0.25),
          lod: 220,
        });
        this.dropShadow(_p, 2.6, t, 0.85);
        this.claim(_p, 3.4);
      } else if (r < 0.68) {
        // dry-stone field wall running along the contour
        this.stoneRun(t, s, lat, 9 + rng() * 11, rng);
      } else if (r < 0.86) {
        // hedgerow: a run of shrubs, not one bush on its own
        const n = 4 + ((rng() * 4) | 0);
        for (let k = 0; k < n; k++) {
          this.at(t + (k - n / 2) * (2.1 / (this.ctx.track.length || 1)), lat + (rng() - 0.5) * 2.4, _p2, s);
          this.settle(_p2, t);
          this.foliage.bush(_p2.clone(), 1.0 + rng() * 0.7, rng() * 6.28, t, rng() < 0.25);
        }
      } else {
        // terrace steps cut into the slope — reads as cultivated hillside
        for (let k = 0; k < 3; k++) {
          this.at(t, lat + land * k * 3.4, _p2, s);
          this.settle(_p2, t);
          const yaw = Math.atan2(s.tangent.x, s.tangent.z);
          this.acc.stone.add(bevelBox(1.1, 1.5, 12 + rng() * 8, 0.06, 0.4), trs(_p2.x, _p2.y - 0.2, _p2.z, yaw), new THREE.Color(0xc9b99c), (_x, y) => lerp(0.5, 1, smoothstep(-0.75, 0.4, y)));
        }
      }
    });

    // --- far band, 40–90 m: tree line and cypress clusters, the horizon filler
    this.walk(0.0, 1.0, 26 / density, (t, s, i) => {
      if (t > 0.495 && t < 0.625) return;
      const land = -this.seaSide(t);
      const lat = land * (s.halfWidth + 40 + this.hash1(i, 0x7a1) * 50);
      if (this.isSea(t, lat, s)) return;
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      if (this.blocked(_p, 6)) return;
      if (!this.flatWorld && this.surfaceAt(_p, t) === Surface.Road) return;
      const r = this.hash1(i, 0xb17);
      if (r < 0.42) {
        const n = 2 + ((rng() * 3) | 0);
        for (let k = 0; k < n; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 9, _p.y, _p.z + (rng() - 0.5) * 9);
          this.settle(_p2, t);
          this.foliage.pine(_p2.clone(), 0.95 + rng() * 0.45, rng() * 6.28, t);
        }
      } else if (r < 0.74) {
        const n = 3 + ((rng() * 4) | 0);
        for (let k = 0; k < n; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 7, _p.y, _p.z + (rng() - 0.5) * 7);
          this.settle(_p2, t);
          this.foliage.cyp(_p2.clone(), 1.0 + rng() * 0.5, rng() * 6.28, t);
        }
      } else {
        for (let k = 0; k < 5; k++) {
          _p2.set(_p.x + (rng() - 0.5) * 12, _p.y, _p.z + (rng() - 0.5) * 12);
          this.settle(_p2, t);
          this.foliage.bush(_p2.clone(), 1.1 + rng() * 0.8, rng() * 6.28, t, rng() < 0.4);
        }
      }
    });
  }

  /** A run of dry-stone wall following the road, broken into rough courses. */
  private stoneRun(t: number, s: TrackSample, lat: number, length: number, rng: RNG) {
    const L = this.ctx.track.length || 1;
    const segs = Math.max(2, Math.floor(length / 3.2));
    const yaw0 = Math.atan2(s.tangent.x, s.tangent.z);
    for (let k = 0; k < segs; k++) {
      const tt = ((t + ((k - segs / 2) * 3.2) / L) % 1 + 1) % 1;
      const ss = this.ctx.track.sample(tt);
      this.at(tt, lat, _p2, ss);
      this.settle(_p2, tt);
      const h = 0.85 + rng() * 0.45;
      this.acc.stone.add(bevelBox(0.55, h, 3.3, 0.05, 0.75), trs(_p2.x, _p2.y + h / 2 - 0.15, _p2.z, yaw0 + (rng() - 0.5) * 0.1), new THREE.Color(0xcfc0a6), (_x, y) => lerp(0.45, 1, smoothstep(-h / 2, 0, y)));
    }
  }

  // ==========================================================================
  // Open water
  // ==========================================================================

  /**
   * A blank sea occupying a third of the establishing shot is a dead zone.
   * Round 1's harbour dressing only reached ~20 m off the quay, so hero.png and
   * grid.png had a smooth plate with nothing on it. This puts objects at three
   * depths across the seaward 60–260 m band: mooring posts and buoy lines near,
   * moored boat clusters mid, a breakwater silhouette far.
   */
  private dressOpenWater() {
    const rng = this.rng;
    const track = this.ctx.track;

    // --- near band: buoy lines and mooring posts marking the fairway
    this.walk(0.0, 0.30, 16, (t, s, i) => {
      const sea = this.seaSide(t);
      for (const dist of [26 + this.hash1(i, 0x11) * 18, 52 + this.hash1(i, 0x22) * 26]) {
        const lat = sea * (s.halfWidth + dist);
        if (!this.isSea(t, lat, s)) continue;
        this.at(t, lat, _p, s);
        _p.y = this.seaLevel;
        if (rng() < 0.55) {
          this.sets.buoy.add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 0.85 + rng() * 0.5), {
            color: _col.set(pick(rng, [0xe0453f, 0xff9d2e, 0xf2ece0, 0x2f5d43])).clone(),
            uv: new THREE.Vector4(1, 1, 0, 0),
            bob: new THREE.Vector4(0.09 + rng() * 0.06, rng() * 6.28, 0.05 + rng() * 0.04, 0),
            lod: 320,
          });
        } else {
          // a stub of mooring piles, always sunk well below the waterline
          const n = 1 + ((rng() * 3) | 0);
          for (let k = 0; k < n; k++) {
            const h = 3.4 + rng() * 1.2;
            this.acc.wood.add(
              bevelBox(0.26, h, 0.26, 0.03, 2.4),
              trs(_p.x + (rng() - 0.5) * 1.6, this.seaLevel + h / 2 - 2.0, _p.z + (rng() - 0.5) * 1.6, rng() * 6.28, 1, 1, 1, (rng() - 0.5) * 0.08, (rng() - 0.5) * 0.08),
              new THREE.Color(0x9c8a6e)
            );
          }
        }
      }
    });

    // --- mid band: rafts of moored boats, clustered rather than scattered
    this.walk(0.0, 0.30, 34, (t, s, i) => {
      const sea = this.seaSide(t);
      const base = 70 + this.hash1(i, 0x33) * 90;
      if (!this.isSea(t, sea * (s.halfWidth + base), s)) return;
      const n = 2 + ((this.hash1(i, 0x44) * 4) | 0);
      const yaw0 = Math.atan2(s.tangent.x, s.tangent.z) + (rng() - 0.5) * 0.4;
      for (let k = 0; k < n; k++) {
        const lat = sea * (base + (rng() - 0.5) * 26);
        if (!this.isSea(t, lat, s)) continue;
        this.at(t, lat, _p, s);
        _p.x += (rng() - 0.5) * 22;
        _p.z += (rng() - 0.5) * 22;
        // the world-space jitter can walk a boat onto the beach; re-probe
        if (!this.flatWorld && this.groundY(_p, t) > this.seaLevel - 0.5) continue;
        _p.y = this.seaLevel;
        this.boatAt(trs(_p.x, _p.y, _p.z, yaw0 + (rng() - 0.5) * 0.3 + (rng() < 0.5 ? 0 : Math.PI)), rng, 1.0 + rng() * 0.6);
      }
    });

    // --- far band: a breakwater arm with a light on the end, closing the bay
    {
      const s = track.sample(0.13);
      const sea = this.seaSide(0.13);
      const start = s.halfWidth + 150;
      const yaw = Math.atan2(s.tangent.x, s.tangent.z);
      if (this.isSea(0.13, sea * start, s)) {
        this.at(0.13, sea * start, _p, s);
        _p.y = this.seaLevel;
        const segs = 22;
        for (let k = 0; k < segs; k++) {
          const off = (k - segs / 2) * 11;
          _p2.set(_p.x + s.tangent.x * off, this.seaLevel, _p.z + s.tangent.z * off);
          // the arm is 240 m long: probe every segment so it never drives
          // through the coastline it is supposed to shelter
          if (!this.flatWorld && this.groundY(_p2, 0.13) > this.seaLevel + 0.6) continue;
          // taper the arm so it does not read as an extruded ribbon
          const hgt = 5.4 - Math.abs(k - segs / 2) * 0.11 + Math.sin(k * 1.7) * 0.35;
          this.acc.stone.add(bevelBox(9.5, hgt, 11.4, 0.25, 0.18), trs(_p2.x, this.seaLevel + hgt / 2 - 2.6, _p2.z, yaw + Math.sin(k * 0.4) * 0.05), new THREE.Color(0xbfae95), (_x, y) => lerp(0.5, 1, smoothstep(-hgt * 0.5, -hgt * 0.15, y)));
          // armour blocks tumbled along the seaward toe
          if (k % 2 === 0) {
            this.sets['debris' + (k % 3)].add(trs(_p2.x + s.binormal.x * sea * 5.6, this.seaLevel - 0.4, _p2.z + s.binormal.z * sea * 5.6, k * 1.3, 3.0 + rng() * 1.6), {
              color: _col.set(0xb2a48c).clone(),
              uv: new THREE.Vector4(1, 1, 0, 0),
              lod: 0,
            });
          }
        }
        // a small light tower at the head of the arm
        _p2.set(_p.x + s.tangent.x * (segs / 2) * 11, this.seaLevel + 2.6, _p.z + s.tangent.z * (segs / 2) * 11);
        const lh = lighthouseGeo(_p2.y, this.seaLevel);
        const base = trs(_p2.x, _p2.y, _p2.z, rng() * 6.28, 0.55);
        this.acc.stone.add(lh.stone, base, new THREE.Color(0xefe6d6));
        this.acc.trim.add(lh.trim, base, new THREE.Color(0xe8dcc8));
        const lampMesh = new THREE.Mesh(lh.glass, this.mats.lamp);
        lampMesh.applyMatrix4(base);
        lampMesh.name = 'breakwater-lamp';
        this.group.add(lampMesh);
      }
    }

    this.dressBay();
  }

  /**
   * The rest of the bay.
   *
   * The harbour passes above only reach t = 0.30, which left the water empty
   * everywhere else — and the two sections that look hardest AT the sea are the
   * cliff traverse and the banked curve, where §1 promises "full bay visible
   * below". A blank plate under a money shot is the same dead zone the harbour
   * had; this puts sail clusters, buoys and rock stacks across the whole
   * seaward side so there is something to judge distance against from any
   * viewpoint on the circuit.
   */
  private dressBay() {
    const rng = this.rng;
    const track = this.ctx.track;

    // --- sail and buoy clusters across the open bay, whole lap
    this.walk(0.0, 1.0, 46, (t, s, i) => {
      const sea = this.seaSide(t);
      const base = 95 + this.hash1(i, 0x5a1) * 165;
      if (!this.isSea(t, sea * (s.halfWidth + base), s)) return;
      const kind = this.hash1(i, 0xc0de);
      if (kind < 0.62) {
        const n = 1 + ((this.hash1(i, 0x77) * 3) | 0);
        const yaw0 = Math.atan2(s.tangent.x, s.tangent.z) + (rng() - 0.5) * 1.1;
        for (let k = 0; k < n; k++) {
          const lat = sea * (base + (rng() - 0.5) * 40);
          if (!this.isSea(t, lat, s)) continue;
          this.at(t, lat, _p, s);
          _p.x += (rng() - 0.5) * 34;
          _p.z += (rng() - 0.5) * 34;
          if (!this.flatWorld && this.groundY(_p, t) > this.seaLevel - 0.8) continue;
          _p.y = this.seaLevel;
          this.boatAt(trs(_p.x, _p.y, _p.z, yaw0 + (rng() - 0.5) * 0.6), rng, 1.1 + rng() * 0.8);
        }
      } else {
        // a short line of marker buoys: three small objects at one depth read
        // as a plane in the water, which is what a bare gradient lacks
        for (let k = 0; k < 3; k++) {
          const lat = sea * (base + k * (9 + rng() * 7));
          if (!this.isSea(t, lat, s)) continue;
          this.at(t, lat, _p, s);
          _p.y = this.seaLevel;
          this.sets.buoy.add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 1.0 + rng() * 0.7), {
            color: _col.set(pick(rng, [0xe0453f, 0xff9d2e, 0xf2ece0, 0x2f5d43])).clone(),
            uv: new THREE.Vector4(1, 1, 0, 0),
            bob: new THREE.Vector4(0.1 + rng() * 0.07, rng() * 6.28, 0.05 + rng() * 0.05, 0),
            lod: 420,
          });
        }
      }
    });

    // --- rock stacks off the cliff and the banked curve. These are the
    // silhouette elements that give a clifftop or a banked-curve frame a
    // midground between the kerb and the horizon; a stack breaking the water
    // surface also gives the eye the waterline it needs to read the drop.
    const stackAt = [0.415, 0.46, 0.50, 0.775, 0.815, 0.85];
    let seed = 4211;
    for (const st of stackAt) {
      const s = track.sample(st);
      const sea = this.seaSide(st);
      const dist = 44 + this.hash1(seed, 0x31) * 78;
      const lat = sea * (s.halfWidth + dist);
      if (!this.isSea(st, lat, s)) {
        seed++;
        continue;
      }
      this.at(st, lat, _p, s);
      if (!this.flatWorld && this.groundY(_p, st) > this.seaLevel - 1.5) {
        seed++;
        continue;
      }
      const r = 5.5 + this.hash1(seed, 0x42) * 7;
      const h = 9 + this.hash1(seed, 0x53) * 15;
      // landmassGeo sinks its base ring far below the given sea level, so the
      // stack never shows a floating rim however the swell moves.
      const geo = landmassGeo(r, h, seed, 0, 1.7);
      this.acc.stone.add(geo, trs(_p.x, this.seaLevel - 0.6, _p.z, this.hash1(seed, 0x64) * 6.28), new THREE.Color(0xb8a68d), (_x, y) =>
        lerp(0.5, 1.05, smoothstep(0, h * 0.55, y))
      );
      // a couple of tumbled boulders at the foot, so it is not a lone cone
      for (let k = 0; k < 3; k++) {
        const a = this.hash1(seed * 7 + k, 0x75) * 6.28;
        const rr = r * (1.05 + this.hash1(seed * 7 + k, 0x86) * 0.5);
        this.sets['debris' + (k % 3)].add(trs(_p.x + Math.cos(a) * rr, this.seaLevel - 0.5, _p.z + Math.sin(a) * rr, a, 1.8 + this.hash1(seed * 7 + k, 0x97) * 2.2), {
          color: _col.set(0xac9d85).clone(),
          uv: new THREE.Vector4(1, 1, 0, 0),
          lod: 0,
        });
      }
      // gulls perch on the stacks — a living element on the far side of the drop
      for (let k = 0; k < 3; k++) {
        this.sets.gull.add(trs(_p.x, this.seaLevel + h * 0.9 + k * 3, _p.z, 0, 1.1 + this.hash1(seed + k, 0xa8) * 0.5), {
          bob: new THREE.Vector4(r + 6 + k * 4, (k % 2 ? -1 : 1) * (0.2 + this.hash1(seed + k, 0xb9) * 0.2), this.hash1(seed + k, 0xca) * 6.28, 4 + k),
          color: _col.setHSL(0.09, 0.06, 0.88).clone(),
        });
      }
      seed++;
    }
  }

  /** Gulls circling the bay and the harbour. */
  private dressGulls() {
    const rng = this.rng;
    const track = this.ctx.track;
    const flocks = [0.06, 0.15, 0.19, 0.45, 0.68, 0.9];
    for (const ft of flocks) {
      const s = track.sample(ft);
      const sea = this.seaSide(ft);
      this.at(ft, sea * (s.halfWidth + 30 + rng() * 40), _p, s);
      const base = Math.max(s.pos.y, this.seaLevel) + 12 + rng() * 16;
      const n = 3 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const r = 7 + rng() * 16;
        this.sets.gull.add(trs(_p.x, base + (rng() - 0.5) * 6, _p.z, 0, 1.0 + rng() * 0.5), {
          bob: new THREE.Vector4(r, (rng() < 0.5 ? -1 : 1) * (0.18 + rng() * 0.2), rng() * 6.28, 5 + rng() * 3),
          color: _col.setHSL(0.09, 0.06, 0.86 + rng() * 0.12).clone(),
        });
      }
    }
  }

  // ==========================================================================
  // Composite props
  // ==========================================================================

  /**
   * Banner arch over the road. §1 asks for one over the start line; round 1
   * shipped bare untextured timber, so the best framing device in the set was
   * doing no work. `hero` adds the printed course-name banner, a start-light
   * gantry and a bunting swag under the beam.
   */
  private bannerArch(t: number, height: number, hero = false) {
    const rng = this.rng;
    const s = this.ctx.track.sample(t);
    const span = s.halfWidth * 2 + 2.4;
    const g = bannerArchGeo(span, height);
    this.at(t, 0, _p, s);
    this.settle(_p, t);
    const yaw = Math.atan2(s.tangent.x, s.tangent.z);
    const m = trs(_p.x, _p.y - 0.3, _p.z, yaw);
    this.acc.wood.add(g.struct, m, new THREE.Color(0xf2ece0));
    const banner = new THREE.Mesh(g.banner, hero ? this.mats.banner : this.mats.cloth);
    banner.name = 'banner-cloth';
    banner.applyMatrix4(m);
    banner.castShadow = true;
    const n = g.banner.getAttribute('position').count;
    const wind = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) wind[i * 4] = t * 31;
    // A single mesh still needs the attribute the cloth patch reads.
    g.banner.setAttribute('aWind', new THREE.BufferAttribute(wind, 4));
    g.banner.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(n * 4).fill(0).map((_, i) => (i % 4 < 2 ? 0.25 : i % 4 === 2 ? 0.75 : 0.0)), 4));
    this.group.add(banner);
    for (const sx of [-1, 1]) {
      this.at(t, sx * (span / 2), _p2, s);
      this.settle(_p2, t);
      this.dropShadow(_p2, 1.5, t, 0.95);
    }

    // Bunting swag hung between the uprights, under the beam. It crosses the
    // upper frame edge from wherever you look at the arch.
    const ay = _p.y - 0.3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    this.at(t, -span / 2, a, s);
    this.at(t, span / 2, b, s);
    a.y = b.y = ay + height * 0.86;
    const sag = span * 0.11;
    this.acc.rope.add(ropeGeo(a, b, sag, 0.03), _m4.identity(), new THREE.Color(0xd8cba8));
    const nf = Math.max(8, Math.floor(span / 1.1));
    for (let k = 1; k < nf; k++) {
      const u = k / nf;
      _p2.lerpVectors(a, b, u);
      _p2.y -= Math.sin(u * Math.PI) * sag;
      this.sets.bunting.add(trs(_p2.x, _p2.y, _p2.z, yaw + Math.PI / 2, 1.15), {
        color: _col.set(pick(rng, PAL.crowd)).clone(),
        wind: new THREE.Vector4(rng() * 100, 0, 0, 0),
        lod: 0,
      });
    }

    if (!hero) return;
    // Start lights, slung under the beam on the approach face.
    const sl = startLightsGeo(span);
    const lm = _m4.multiplyMatrices(m, trs(0, height - 0.55, -0.5, Math.PI)).clone();
    this.acc.wood.add(sl.frame, lm, new THREE.Color(0x9aa0aa));
    const lens = new THREE.Mesh(sl.lens, this.mats.lamp);
    lens.name = 'start-lights';
    lens.applyMatrix4(lm);
    this.group.add(lens);
  }

  /** A sponsor cloth across the front of the grandstand fascia. */
  private standBanner(gm: THREE.Matrix4, len: number, y: number) {
    const rng = this.rng;
    const g = new THREE.PlaneGeometry(len, 1.5, 24, 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getY(i), uv.getX(i));
    const n = g.getAttribute('position').count;
    const wind = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) wind[i * 4] = rng() * 6;
    g.setAttribute('aWind', new THREE.BufferAttribute(wind, 4));
    const mesh = new THREE.Mesh(g, this.mats.banner);
    mesh.name = 'stand-banner';
    mesh.castShadow = true;
    mesh.applyMatrix4(_m4.multiplyMatrices(gm, trs(0, y, 1.05, 0)));
    this.group.add(mesh);
  }

  /** Quay coping + a skirt that runs down past the waterline. */
  private quaySegment(t: number, s: TrackSample, sea: number, segLen: number) {
    const lat = sea * (s.halfWidth + 1.6);
    this.at(t, lat, _p, s);
    this.settle(_p, t);
    const yaw = Math.atan2(s.tangent.x, s.tangent.z);
    this.acc.stone.add(bevelBox(1.5, 0.62, segLen, 0.06, 0.28), trs(_p.x, _p.y + 0.24, _p.z, yaw, 1, 1, 1, 0, 0), new THREE.Color(0xf0e7d6));
    // skirt: buried on land, exposed where the ground falls to the sea
    const drop = Math.max(2.5, _p.y - this.seaLevel + 2.5);
    this.acc.stone.add(bevelBox(1.9, drop, segLen, 0.05, 0.28), trs(_p.x + s.binormal.x * sea * 0.6, _p.y - drop / 2, _p.z + s.binormal.z * sea * 0.6, yaw), new THREE.Color(0xd6c8ae));
  }

  private jetty(t: number, s: TrackSample, sea: number, length: number) {
    const rng = this.rng;
    const deckY = this.seaLevel + 1.15;
    const yaw = Math.atan2(s.binormal.x * sea, s.binormal.z * sea);
    const start = s.halfWidth + 4;
    this.at(t, sea * (start + length / 2), _p, s);
    _p.y = deckY;
    const m = trs(_p.x, _p.y, _p.z, yaw);
    this.acc.wood.add(bevelBox(2.6, 0.16, length, 0.03, 0.7), m, new THREE.Color(0xd9cbb2));
    // plank joints so the deck isn't one flat slab
    for (let i = 0; i < Math.floor(length / 1.1); i++) {
      const z = -length / 2 + 0.55 + i * 1.1;
      this.acc.wood.add(bevelBox(2.66, 0.05, 0.1, 0.015, 2), _m4.multiplyMatrices(m, trs(0, 0.09, z, 0)).clone(), new THREE.Color(0xbfae93));
    }
    // pilings, always sunk well below the waterline
    for (let i = 0; i <= Math.floor(length / 3.2); i++) {
      const z = -length / 2 + (i / Math.max(1, Math.floor(length / 3.2))) * length;
      for (const sx of [-1, 1]) {
        const h = deckY - (this.seaLevel - 3.2);
        this.acc.wood.add(bevelBox(0.24, h, 0.24, 0.03, 2.2), _m4.multiplyMatrices(m, trs(sx * 1.15, -h / 2, z, 0, 1, 1, 1, 0.02 * sx)).clone(), new THREE.Color(0x9c8a6e));
      }
    }
    // moored boats along the fingers, each tied back to the deck edge
    for (let i = 0; i < 3; i++) {
      const z = -length / 2 + 3 + rng() * (length - 6);
      const sx = rng() < 0.5 ? -1 : 1;
      const local = trs(sx * 3.6, this.seaLevel - deckY, z, rng() < 0.5 ? 0 : Math.PI);
      const bm = _m4.multiplyMatrices(m, local).clone();
      this.boatAt(bm, rng, 0.9 + rng() * 0.3);
      _p.setFromMatrixPosition(bm).setY(this.seaLevel + 0.5);
      _p2.setFromMatrixPosition(_m4.multiplyMatrices(m, trs(sx * 1.25, 0.12, z, 0)));
      this.acc.rope.add(ropeGeo(_p, _p2, 0.5, 0.04), _m4.identity(), new THREE.Color(0xc7b088));
    }
    this.sets.bollard.add(_m4.multiplyMatrices(m, trs(0, 0.1, -length / 2 + 0.4, 0, 0.8)).clone(), { color: _col.set(0x4a4a52).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 130 });
  }

  private mooredBoat(t: number, s: TrackSample, sea: number, rng: RNG) {
    const lat = sea * (s.halfWidth + 8 + rng() * 12);
    if (!this.isSea(t, lat, s)) return;
    this.at(t, lat, _p, s);
    _p.y = this.seaLevel;
    const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (rng() - 0.5) * 0.5 + (rng() < 0.5 ? 0 : Math.PI);
    this.boatAt(trs(_p.x, _p.y, _p.z, yaw), rng, 0.85 + rng() * 0.45);
    // mooring rope back to the quay
    this.at(t, sea * (s.halfWidth + 3.2), _p2, s);
    this.settle(_p2, t);
    _p2.y += 0.4;
    this.acc.rope.add(ropeGeo(_p.clone().setY(this.seaLevel + 0.55), _p2, Math.max(0.4, _p.distanceTo(_p2) * 0.12), 0.045), _m4.identity(), new THREE.Color(0xc7b088));
  }

  private boatAt(m: THREE.Matrix4, rng: RNG, scale: number) {
    const k = rng() < 0.55 ? 0 : 1;
    const bob = new THREE.Vector4(0.055 + rng() * 0.05, rng() * 6.28, 0.022 + rng() * 0.02, 0);
    const hullCol = _col.set(pick(rng, PAL.boatHulls)).clone();
    const trimCol = _col.set(pick(rng, PAL.boatHulls)).clone();
    _m4.multiplyMatrices(m, trs(0, 0, 0, 0, scale));
    const mm = _m4.clone();
    this.sets['hull' + k].add(mm, { color: hullCol, bob, uv: new THREE.Vector4(1, 1, 0, 0), lod: 220 });
    this.sets['rig' + k].add(mm, { color: trimCol, bob, uv: new THREE.Vector4(1, 1, 0, 0), lod: 200 });
  }

  private clutter(t: number, lat: number, rng: RNG) {
    const s = this.ctx.track.sample(t);
    this.at(t, lat, _p, s);
    this.settle(_p, t);
    const r = rng();
    if (r < 0.42) {
      const n = 1 + ((rng() * 3) | 0);
      for (let i = 0; i < n; i++) {
        this.sets.crate.add(trs(_p.x + (rng() - 0.5) * 0.5, _p.y + i * 0.46, _p.z + (rng() - 0.5) * 0.5, rng() * 6.28), {
          color: _col.setHSL(0.09 + rng() * 0.06, 0.2 + rng() * 0.3, 0.42 + rng() * 0.3).clone(),
          uv: new THREE.Vector4(1, 1, 0, 0),
          lod: 110,
        });
      }
      this.dropShadow(_p, 0.85, t);
    } else if (r < 0.72) {
      this.sets.barrel.add(trs(_p.x, _p.y, _p.z, rng() * 6.28), {
        color: _col.setHSL(0.05 + rng() * 0.1, 0.3 + rng() * 0.3, 0.35 + rng() * 0.25).clone(),
        uv: new THREE.Vector4(1, 1, 0, 0),
        lod: 110,
      });
      this.dropShadow(_p, 0.6, t);
    } else {
      // net draped over a couple of crates
      this.sets.crate.add(trs(_p.x, _p.y, _p.z, rng() * 6.28), { color: _col.set(0x9c8a6e).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 110 });
      this.sets.net.add(trs(_p.x, _p.y + 0.9, _p.z, rng() * 6.28), { color: _col.set(0x8a7f66).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 90 });
      this.dropShadow(_p, 1.1, t);
    }
  }

  /**
   * Pick an atlas cell for placement `i`, never repeating a design inside a
   * 120 m window. `signHistory` is a small ring of the last few cells used;
   * a modulo cycle or a bare rng() both leave a readable loop period, which is
   * the classic procedural-scatter tell.
   */
  private signHistory: number[] = [];
  private signCell(i: number): THREE.Vector4 {
    let cell = (this.hash1(i, 0x5be3) * 8) | 0;
    for (let k = 0; k < 8 && this.signHistory.indexOf(cell) >= 0; k++) cell = (cell + 1) % 8;
    this.signHistory.push(cell);
    if (this.signHistory.length > 4) this.signHistory.shift();
    return new THREE.Vector4(0.5, 0.25, (cell % 2) * 0.5, ((cell / 2) | 0) * 0.25);
  }

  private signSeq = 0;

  /**
   * Roadside signage. Three body styles (hoarding, A-frame, wall-mounted),
   * eight printed designs, and jittered yaw / offset / spacing, because the
   * round-1 set read its own loop period off the barrier at a glance.
   */
  private sponsorBoard(t: number, s: TrackSample, side: number, rng: RNG) {
    const i = this.signSeq++;
    // spacing jitter: skip a placement now and then so the rhythm is uneven
    if (this.hash1(i, 0x1c33) < 0.22) return;
    const lat = side * (s.halfWidth + 2.2 + (this.hash1(i, 0x77a1) - 0.5) * 3.0);
    if (this.isSea(t, lat, s)) return;
    this.at(t, lat, _p, s);
    this.settle(_p, t);
    // The panel's own +Z is its face: point it ACROSS the track at the road,
    // which leaves its width running along the track as a hoarding should.
    const yaw = Math.atan2(-s.binormal.x * side, -s.binormal.z * side) + (this.hash1(i, 0x3ee1) - 0.5) * 0.42;
    const uv = this.signCell(i);
    const style = this.hash1(i, 0xa55e);
    if (style < 0.2) {
      // low double-sided A-frame propped at the verge
      const m = trs(_p.x, _p.y, _p.z, yaw + Math.PI / 2 + (rng() - 0.5) * 0.3);
      this.sets.aframe.add(m, { color: _col.set(0xf0e6d4).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 150 });
      this.sets.aframePanel.add(m, { uv, lod: 150 });
      this.dropShadow(_p, 1.1, t, 0.75);
    } else if (style < 0.38) {
      const m = trs(_p.x, _p.y, _p.z, yaw);
      this.sets.wallsign.add(m, { color: _col.set(0xa8adb6).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 175 });
      this.sets.wallsignPanel.add(m, { uv, lod: 175 });
      this.dropShadow(_p, 1.3, t, 0.6);
    } else {
      const sc = 0.86 + this.hash1(i, 0xd001) * 0.5;
      const m = trs(_p.x, _p.y, _p.z, yaw, sc, sc, 1);
      this.sets.sponsor.add(m, { uv, lod: 190 });
      this.sets.sponsorPost.add(m, { color: _col.set(0xb8bcc4).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 190 });
      this.dropShadow(_p, 1.5, t, 0.6);
    }
  }

  private tyreStack(t: number, s: TrackSample, side: number, rng: RNG) {
    const lat = side * (s.halfWidth + 1.5 + rng() * 1.2);
    if (this.isSea(t, lat, s)) return;
    this.at(t, lat, _p, s);
    this.settle(_p, t);
    const n = 3 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const top = i === n - 1 && rng() < 0.6;
      this.sets.tyre.add(trs(_p.x + (rng() - 0.5) * 0.06, _p.y + i * 0.255, _p.z + (rng() - 0.5) * 0.06, rng() * 6.28), {
        color: top ? _col.set(pick(rng, [PAL.kerbRed, 0x4fc3ff, 0xff9d2e])).clone() : _col.set(0x8e8e96).clone(),
        uv: new THREE.Vector4(1, 1, 0, 0),
        lod: 130,
      });
    }
    this.dropShadow(_p, 0.75, t);
  }

  private marshalPost(t: number, s: TrackSample, side: number, rng: RNG) {
    const lat = side * (s.halfWidth + 3.4);
    if (this.isSea(t, lat, s)) return;
    this.at(t, lat, _p, s);
    this.settle(_p, t);
    const yaw = Math.atan2(-s.binormal.x * side, -s.binormal.z * side);
    const m = trs(_p.x, _p.y, _p.z, yaw);
    this.sets.marshal.add(m, { color: _col.set(0xf2ece0).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 160 });
    this.sets.marshalFlag.add(m, { uv: new THREE.Vector4(0.25, 0.25, 0.0, 0.25), wind: new THREE.Vector4(rng() * 100, 0, 0, 0), lod: 160 });
    this.dropShadow(_p, 0.9, t);
  }

  private parasol(p: THREE.Vector3, t: number, rng: RNG) {
    const yaw = rng() * 6.28;
    const tilt = (rng() - 0.5) * 0.16;
    const m = trs(p.x, p.y, p.z, yaw, 0.9 + rng() * 0.25, 1, 1, tilt);
    this.sets.parasolPole.add(m, { color: _col.set(0xe6d9c2).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 120 });
    const cell = (rng() * 4) | 0;
    this.sets.parasolTop.add(m, { uv: new THREE.Vector4(0.25, 0.25, cell * 0.25, ((rng() * 4) | 0) * 0.25), lod: 120 });
    this.dropShadow(p, 1.5, t, 0.85);
  }

  private deckchair(p: THREE.Vector3, t: number, rng: RNG) {
    const m = trs(p.x, p.y, p.z, rng() * 6.28);
    this.sets.chairFrame.add(m, { color: _col.set(0xe0d2b8).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 80 });
    this.sets.chairCloth.add(m, { uv: new THREE.Vector4(0.25, 0.25, ((rng() * 4) | 0) * 0.25, ((rng() * 4) | 0) * 0.25), lod: 80 });
    this.dropShadow(p, 0.55, t, 0.8);
  }

  private pennant(m: THREE.Matrix4, rng: RNG) {
    this.sets.flag.add(m, {
      uv: new THREE.Vector4(0.25, 0.25, ((rng() * 4) | 0) * 0.25, ((rng() * 4) | 0) * 0.25),
      wind: new THREE.Vector4(rng() * 100, 0, 0, 0),
      lod: 170,
    });
  }

  private spectator(m: THREE.Matrix4, rng: RNG, variant = -1) {
    const v = variant >= 0 ? variant : rng() < 0.24 ? 1 : rng() < 0.22 ? 2 : rng() < 0.3 ? 3 : 0;
    this.sets['crowd' + v].add(m, {
      color: _col.set(pick(rng, PAL.crowd)).clone(),
      wind: new THREE.Vector4(rng() * 100, 0, 0, rng()),
      lod: 130,
    });
  }

  /**
   * Spectators along a barrier.
   *
   * Round 1 put these on a uniform 1.05 m pitch at a fixed lateral offset, so
   * they read as a single file of identical capsules with the guardrail passing
   * through their torsos. Three changes fix that:
   *   • KNOTS. Density is modulated by a smooth field along the centreline that
   *     is boosted at corners, so the crowd bunches where the action is and
   *     thins on the straights.
   *   • CLEARANCE. Nothing spawns inside `railClear` of the road edge, which is
   *     where the barrier lives.
   *   • A SECOND RANK. A raised bank behind the front row, which is the layer
   *     Nintendo always has and this set never did.
   */
  private barrierCrowd(t0: number, t1: number, side: number, density: number, railClear = 3.4) {
    const rng = this.rng;
    const d = density * clamp(this.ctx.settings.foliageDensity ?? 1, 0.25, 1.5);
    let seq = 0;
    this.walk(t0, t1, 0.85, (t, s) => {
      const i = seq++;
      // clustering field: two out-of-phase sines plus a corner boost
      const knot = 0.5 + 0.5 * Math.sin(i * 0.21 + t * 61) * Math.sin(i * 0.071 + 2.1);
      const corner = clamp(Math.abs(this.curvature(t)) * 90, 0, 1);
      const local = d * (0.24 + knot * 1.5) * (0.7 + corner * 0.9);
      if (rng() > local) return;
      const back = rng() < 0.34;
      const lat = side * (s.halfWidth + railClear + (back ? 2.6 + rng() * 2.0 : rng() * 1.9));
      if (this.isSea(t, lat, s)) return;
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      if (!this.flatWorld) {
        const surf = this.surfaceAt(_p, t);
        if (surf === Surface.Road || surf === Surface.Boost) return;
      }
      // The back rank stands on a low bank so its heads clear the front row.
      if (back) {
        const yaw0 = Math.atan2(s.tangent.x, s.tangent.z);
        this.acc.stone.add(bevelBox(2.6, 0.9, 2.4, 0.06, 0.5), trs(_p.x, _p.y - 0.2, _p.z, yaw0), new THREE.Color(0xc4b79e), (_x, y) => lerp(0.45, 1, smoothstep(-0.45, 0.3, y)));
        _p.y += 0.44;
      }
      const yaw = Math.atan2(-s.binormal.x * side, -s.binormal.z * side) + (rng() - 0.5) * 1.1;
      this.spectator(trs(_p.x, _p.y, _p.z, yaw, 0.82 + rng() * 0.38), rng);
      // Everything in this world gets a contact decal (§9.4). A spectator that
      // does not darken the grass under their feet floats, full stop.
      this.dropShadow(_p, 0.34, t, 0.7);
    });
  }

  // --- village terrace -------------------------------------------------------

  /**
   * A terraced run.
   *
   * Round 1 produced a near-uniform grid of identical boxes at one height and
   * one footprint depth, packed edge to edge — squinted, an orange-pink noise
   * field with no landmark in it. What changed:
   *   • a 5:3:1 height distribution over 2 / 3 / 4 storeys instead of a
   *     constant, so the roofline steps;
   *   • per-house setback jitter, so the facade line is not one extruded ribbon;
   *   • alley gaps carved every few houses, giving the mass negative space;
   *   • one authored landmark per run — a campanile at ~2.5x the surrounding
   *     height, placed at the tightest corner so it becomes the visual apex.
   */
  private terrace(t0: number, t1: number, side: number, setback: number, rng: RNG, anchors: THREE.Vector3[], tier = 0) {
    const track = this.ctx.track;
    const L = track.length || 1;
    let d = t0 * L;
    const dEnd = t1 * L;
    // Houses write straight into the shared merge buffers: a whole street of
    // thirty terraced facades comes out as three meshes.
    const parts = newHouseParts(this.acc.wall, this.acc.roof, this.acc.trim);

    // Where the landmark goes: the tightest corner in the run, on the outside.
    let towerD = -1;
    let bestCurv = 0;
    for (let k = 0; k <= 24; k++) {
      const dd = t0 * L + (k / 24) * (dEnd - t0 * L);
      const tt = ((dd / L) % 1 + 1) % 1;
      const c = this.curvature(tt) * side;
      if (-c > bestCurv) {
        bestCurv = -c;
        towerD = dd;
      }
    }
    let towerDone = tier > 0 || towerD < 0;

    let guard = 0;
    let sinceAlley = 0;
    while (d < dEnd && guard++ < 220) {
      // 2 / 3 / 4 storeys at roughly 5:3:1 — a height distribution, not a
      // constant, is what turns a wall of boxes into a hillside town.
      const hr = rng();
      let floors = hr < 0.555 ? 2 : hr < 0.888 ? 3 : 4;
      floors = clamp(floors + tier, 2, 5);
      const w = 5.0 + rng() * 4.2;
      const depth = 6.0 + rng() * 5.0;
      // Setback jitter breaks the single extruded facade line.
      const jitter = (rng() - 0.5) * 2.4;
      const s = track.sampleByDistance(d + w / 2);
      const t = s.t;
      const lat = side * (s.halfWidth + setback + jitter + depth / 2);
      if (this.isSea(t, lat, s)) {
        d += w + 0.6;
        continue;
      }
      this.at(t, lat, _p, s);
      this.settle(_p, t);
      if (!this.flatWorld) {
        const surf = this.surfaceAt(_p, t);
        if (surf === Surface.Road || surf === Surface.Boost) {
          d += w + 0.6;
          continue;
        }
      }
      const yaw = Math.atan2(-s.binormal.x * side, -s.binormal.z * side);
      const xf = trs(_p.x, _p.y, _p.z, yaw);

      if (!towerDone && d + w >= towerD) {
        towerDone = true;
        const th = 22 + rng() * 8;
        const tw = bellTowerGeo(rng, 4.2, th);
        const tint = _col.set(0xf3ebdc).clone();
        this.acc.wall.add(tw.wall, xf, tint);
        this.acc.trim.add(tw.trim, xf, new THREE.Color(0xe8dcc6));
        this.acc.roof.add(tw.roof, xf, new THREE.Color(0xc9a184));
        this.acc.stone.add(bevelBox(6.0, 2.4, 6.0, 0.08, 0.3), _m4.multiplyMatrices(xf, trs(0, -1.1, 0, 0)).clone(), new THREE.Color(0xcdbfa6));
        this.dropShadow(_p, 4.4, t, 0.85);
        this.claim(_p, 5.5);
        d += 7.2;
        sinceAlley = 0;
        continue;
      }

      const tint = this.facadeTint();
      buildHouse(parts, rng, xf, w, depth, floors, tint);
      // plinth: guarantees the terrace meets a sloping street with no gap
      this.acc.stone.add(bevelBox(w + 0.25, 3.6, depth + 0.25, 0.06, 0.28), _m4.multiplyMatrices(xf, trs(0, -1.75, 0, 0)).clone(), new THREE.Color(0xcdbfa6));
      this.dropShadow(_p, Math.max(w, depth) * 0.62, t, 0.7);
      this.claim(_p, Math.max(w, depth) * 0.62);
      // 0.55 m minimum party gap: the roofs overhang 0.13 m each side, so
      // anything tighter drives one roof through the neighbour's wall.
      d += w + 0.58;
      sinceAlley++;
      // Alley: two per run at minimum, so the terrace is buildings with space
      // between them rather than one continuous ribbon.
      if (sinceAlley >= 3 && rng() < 0.34) {
        sinceAlley = 0;
        const alley = 3.2 + rng() * 2.4;
        // an arch or a flight of steps closes the far end of the alley
        const as = track.sampleByDistance(d + alley / 2);
        this.at(as.t, side * (as.halfWidth + setback + depth + 2.0), _p2, as);
        this.settle(_p2, as.t);
        if (!this.isSea(as.t, side * (as.halfWidth + setback + depth + 2.0), as)) {
          const ay = Math.atan2(-as.binormal.x * side, -as.binormal.z * side);
          // a flight of steps climbing away up the hill closes the alley view
          for (let k = 0; k < 5; k++) {
            _p.copy(_p2).addScaledVector(as.binormal, side * k * 0.85);
            this.acc.stone.add(bevelBox(alley + 0.6, 0.26, 0.95, 0.03, 0.9), trs(_p.x, _p2.y + 0.13 + k * 0.24, _p.z, ay), new THREE.Color(0xd4c6ab), (_x, y) => lerp(0.62, 1, smoothstep(-0.13, 0.13, y)));
          }
        }
        d += alley;
      }
    }
    this.absorbHouse(parts, anchors);
  }

  /**
   * Wall colour for the next facade in a run.
   *
   * `pick(rng, palette)` is not enough and round 1 proved it: with an
   * independent draw per house the same hue lands next to itself about a fifth
   * of the time, and under a 14° warm key the five pastels' HUES converge
   * anyway — #f2c9a0 and #e8a5a0 are the same colour once #ffd9a8 is on them.
   * What actually separates two facades at that light is VALUE. So:
   *   • walk §3's five pastels as a shuffled sequence, so no hue can repeat
   *     inside a run of five houses rather than merely "usually not";
   *   • alternate a light and a knocked-back version, so consecutive facades
   *     differ by ~25% in value even when the hue barely moves.
   * Roofs stay on one terracotta (see ROOF_MULT), and it is that band of
   * constant roof over varied wall that makes a hill town legible.
   */
  private pastelSeq = 0;
  private pastelBag: number[] = [];
  private facadeTint(): THREE.Color {
    if (!this.pastelBag.length) {
      // §3's five, shuffled — not the seven-entry superset, which dilutes the
      // two cool pastels that do the most work against a warm key.
      this.pastelBag = [0, 1, 2, 3, 4];
      for (let i = 4; i > 0; i--) {
        const j = (this.rng() * (i + 1)) | 0;
        const tmp = this.pastelBag[i];
        this.pastelBag[i] = this.pastelBag[j];
        this.pastelBag[j] = tmp;
      }
    }
    const hex = PAL.pastels[this.pastelBag.pop()];
    const step = this.pastelSeq++;
    _col.set(hex);
    // alternate bright / knocked back, with a little jitter so the alternation
    // itself is not a readable rhythm
    const v = step % 2 === 0 ? 1.06 + this.rng() * 0.06 : 0.76 + this.rng() * 0.09;
    _col.multiplyScalar(v);
    return _col.clone();
  }

  private absorbHouse(parts: ReturnType<typeof newHouseParts>, anchors: THREE.Vector3[]) {
    const rng = this.rng;
    for (const sh of parts.shutters) this.sets.shutter.add(sh.m, { color: sh.color, uv: sh.uv, lod: 120 });
    for (const g of parts.glass) this.sets.glass.add(g, { lod: 150 });
    for (const b of parts.balcony) this.sets.balcony.add(b, { color: _col.set(0xf2ece0).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 130 });
    for (const f of parts.flowerbox) {
      this.sets.flowerbox.add(f.m, { color: f.color, uv: new THREE.Vector4(1, 1, 0, 0), lod: 100 });
      this.sets.flowers.add(_m4.multiplyMatrices(f.m, trs(0, 0.24, 0.02, 0)).clone(), {
        color: _col.setHSL(rng(), 0.14, 0.95).clone(),
        wind: new THREE.Vector4(rng() * 100, 1.2, 0, 0.8),
        lod: 110,
      });
    }
    for (const a of parts.awning) this.sets.awning.add(a.m, { uv: a.uv, lod: 150 });
    for (const dr of parts.door) this.sets.door.add(dr.m, { color: dr.color, uv: new THREE.Vector4(0.5, 1, 0, 0), lod: 130 });
    for (const l of parts.lamp) {
      this.sets.lampArm.add(l, { color: _col.set(0x3a3a42).clone(), uv: new THREE.Vector4(1, 1, 0, 0), lod: 120 });
      this.sets.lampGlow.add(l, { lod: 140 });
    }
    for (const a of parts.lineAnchors) anchors.push(a);
  }

  /** Hang washing between facing balconies — the signature of the village. */
  private stringLaundry(anchors: THREE.Vector3[], rng: RNG) {
    if (this.ctx.settings.quality <= 0) return;
    const used = new Uint8Array(anchors.length);
    let lines = 0;
    for (let i = 0; i < anchors.length && lines < 60; i++) {
      if (used[i]) continue;
      let best = -1;
      let bestD = Infinity;
      for (let j = i + 1; j < anchors.length; j++) {
        if (used[j]) continue;
        const d = anchors[i].distanceTo(anchors[j]);
        if (d > 6 && d < 24 && d < bestD) {
          bestD = d;
          best = j;
        }
      }
      if (best < 0) continue;
      used[i] = used[best] = 1;
      lines++;
      const a = anchors[i];
      const b = anchors[best];
      const sag = bestD * 0.11;
      this.acc.rope.add(ropeGeo(a, b, sag, 0.022), _m4.identity(), new THREE.Color(0xb8ac94));
      const n = Math.max(2, Math.floor(bestD / 1.5));
      for (let k = 1; k < n; k++) {
        const u = k / n;
        _p.lerpVectors(a, b, u);
        _p.y -= Math.sin(u * Math.PI) * sag + 0.02;
        const yaw = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
        const sc = 0.75 + rng() * 0.55;
        this.sets.laundry.add(trs(_p.x, _p.y - 1.1 * sc, _p.z, yaw, sc), {
          uv: new THREE.Vector4(0.25, 1, ((rng() * 4) | 0) * 0.25, 0),
          wind: new THREE.Vector4(rng() * 100, 0, 0, 0),
          lod: 110,
        });
      }
    }
  }

  /** Walk outward from the road until the ground drops below the waterline. */
  private findWaterline(t: number, s: TrackSample, sea: number): number | null {
    for (let d = s.halfWidth + 3; d < s.halfWidth + 70; d += 2.5) {
      if (this.isSea(t, sea * d, s)) return sea * (d - 2.0);
    }
    return null;
  }

  // ==========================================================================
  // Backdrop
  // ==========================================================================

  /**
   * The background silhouette ring.
   *
   * Round 1's version placed everything along ONE azimuth — the average
   * outward-sea direction from the circuit centroid — in a perpendicular band.
   * That works for exactly the viewpoints that happen to look down that
   * azimuth, and for every other one the horizon is empty: hero.png's entire
   * right half was flat sea meeting an empty gradient, and closeup.png had no
   * world behind the kart at all. Nintendo never leaves the horizon empty.
   *
   * So this is a RING, not a band, and it is verified rather than hoped for:
   *   • 16 slots all the way round the circuit at 420–1150 m, kind chosen from
   *     whether that bearing is water or land — islands, monasteries and
   *     lighthouse spits over the sea, terraced town stacks and cypress ridges
   *     over the land;
   *   • two far layers at 1500 m and 2400 m for aerial-perspective depth;
   *   • then a COVERAGE PASS: the centreline is walked every 40 m and, if the
   *     forward 60° cone at that sample contains no landmark, one is inserted on
   *     that bearing. That assertion is the whole point — placement authored by
   *     eye against a track this module does not own will always leave holes.
   *
   * Everything goes into the `backdrop` accumulator, which is the only material
   * carrying `patchAerial`, so all of it tints toward the sky with distance and
   * height and reads as depth rather than cardboard.
   */
  private buildBackdrop() {
    const track = this.ctx.track;
    const b = track.bounds;
    const cx = (b.min.x + b.max.x) * 0.5 || 0;
    const cz = (b.min.z + b.max.z) * 0.5 || 0;
    let cr = 0;
    for (let i = 0; i < 96; i++) {
      const p = track.sample(i / 96).pos;
      cr = Math.max(cr, Math.hypot(p.x - cx, p.z - cz));
    }
    // Everything sits clear of this so no landmark can ever intersect the
    // circuit, however the track agent reshapes it.
    const inner = cr + 260;

    const rng = mulberry32(776553);
    let seed = 11;

    // --- ring
    const SLOTS = 16;
    for (let i = 0; i < SLOTS; i++) {
      const az = (i / SLOTS) * Math.PI * 2 + (rng() - 0.5) * 0.16;
      const dist = inner + 160 + rng() * 630;
      this.landmark(az, dist, cx, cz, seed++, rng);
    }

    // --- far layers: mass and hue only, they exist to separate the ring from
    // the sky. Low-res meshes, since at 2 km a 380 m island is 40 px tall.
    for (const L of [
      { dist: 1500, count: 7, r: 260, h: 120, jag: 0.9, segs: 26, rings: 8 },
      { dist: 2400, count: 7, r: 430, h: 235, jag: 0.7, segs: 20, rings: 6 },
    ]) {
      for (let i = 0; i < L.count; i++) {
        const az = (i / L.count) * Math.PI * 2 + rng() * 0.5;
        const out = Math.max(inner + 400, L.dist * (0.82 + rng() * 0.4));
        _p.set(cx + Math.cos(az) * out, 0, cz + Math.sin(az) * out);
        const geo = landmassGeo(L.r * (0.6 + rng() * 0.8), L.h * (0.55 + rng() * 0.9), seed++, 0, L.jag, L.segs, L.rings);
        this.acc.backdrop.add(geo, trs(_p.x, this.seaLevel, _p.z, rng() * 6.28), this.hazeTint(out, 0x6f7f5c));
        this.marks.push({ x: _p.x, z: _p.z, r: L.r });
      }
    }

    // --- coverage assertion
    let inserted = 0;
    this.walk(0, 1, 40, (t, s) => {
      // A hard cap: 16 ring slots plus 14 far masses already fill the horizon,
      // and a pathological layout must not be able to turn this into a hundred
      // islands. If the cap is ever hit the ring spacing is the thing to fix.
      if (inserted >= 14) return;
      if (this.forwardCovered(s.pos, s.tangent)) return;
      // Aim the insert down the look direction, kicked sideways a little so a
      // run of empty samples does not stack four islands on one bearing.
      const yaw = Math.atan2(s.tangent.x, s.tangent.z) + (rng() - 0.5) * 0.5;
      const dirX = Math.sin(yaw);
      const dirZ = Math.cos(yaw);
      // Push out until it clears the circuit envelope.
      let d = 520 + rng() * 380;
      for (let k = 0; k < 8; k++) {
        const px = s.pos.x + dirX * d;
        const pz = s.pos.z + dirZ * d;
        if (Math.hypot(px - cx, pz - cz) >= inner) break;
        d += 220;
      }
      const px = s.pos.x + dirX * d;
      const pz = s.pos.z + dirZ * d;
      const az = Math.atan2(pz - cz, px - cx);
      this.landmark(az, Math.hypot(px - cx, pz - cz), cx, cz, seed++, rng);
      inserted++;
    });
    void inserted;
  }

  /** Landmark footprints, in world XZ, used by the coverage assertion. */
  private marks: { x: number; z: number; r: number }[] = [];

  /** Is there a background landmark inside the forward 60° cone at `p`? */
  private forwardCovered(p: THREE.Vector3, tangent: THREE.Vector3): boolean {
    const fx = tangent.x;
    const fz = tangent.z;
    const fl = Math.hypot(fx, fz) || 1;
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i];
      const dx = m.x - p.x;
      const dz = m.z - p.z;
      const dl = Math.hypot(dx, dz);
      if (dl < 1) continue;
      // half-angle 30°, widened by the mass's own angular radius: a 200 m island
      // 600 m away fills 19° on its own and does not need to be dead centre.
      const cosLimit = Math.cos(Math.PI / 6 + Math.atan2(m.r, dl));
      if ((dx * fx + dz * fz) / (dl * fl) >= cosLimit) return true;
    }
    return false;
  }

  /**
   * Two-stage aerial perspective: the albedo is pre-faded toward the sky before
   * `patchAerial`'s shader haze even runs, because a 2 km headland at full
   * saturation reads as a painted flat no matter how much fog is on top of it.
   */
  private hazeTint(dist: number, base: number): THREE.Color {
    const fade = clamp((dist - 500) / 2100, 0, 1);
    return _col.set(base).lerp(_haze, 0.18 + fade * 0.4).clone();
  }

  /**
   * One background landmark on bearing `az` at `dist` from the circuit centre.
   * The kind is chosen from whether that bearing is water — a monastery island
   * on a hillside or a terraced town in the middle of the bay would both be
   * absurd, and the whole layer stops working the moment one of them shows up.
   */
  private landmark(az: number, dist: number, cx: number, cz: number, seed: number, rng: RNG) {
    const x = cx + Math.cos(az) * dist;
    const z = cz + Math.sin(az) * dist;
    _p.set(x, this.seaLevel, z);
    // Sea or land: probe the terrain a third of the way out. Beyond the
    // heightfield the probe clamps, so also treat "lower than the harbour" as
    // water, and on a flat world fall back to the derived sea side.
    let overSea: boolean;
    if (this.flatWorld) {
      const c = new THREE.Vector3(cx, 0, cz);
      _p2.set(x, 0, z).sub(c);
      const s0 = this.ctx.track.sample(0);
      overSea = _p2.dot(s0.binormal) * this.seaSide(0) >= 0;
    } else {
      _p2.set(cx + Math.cos(az) * (dist * 0.55), 0, cz + Math.sin(az) * (dist * 0.55));
      overSea = this.groundY(_p2, 0) <= this.seaLevel + 2.5;
    }
    const yaw = az + Math.PI; // faces the circuit
    const k = (rng() * 3) | 0;

    if (overSea) {
      if (k === 0) {
        // Offshore island with a monastery on the crown — the strongest single
        // silhouette in the set, because it is the only one that is man-made.
        const r = 78 + rng() * 60;
        const h = 46 + rng() * 40;
        this.acc.backdrop.add(landmassGeo(r, h, seed, 0, 1.2, 30, 10), trs(x, this.seaLevel, z, rng() * 6.28), this.hazeTint(dist, 0x8c8a68));
        this.monastery(x, this.seaLevel + h * 0.92, z, yaw, 1.0 + rng() * 0.5, dist, rng);
        this.marks.push({ x, z, r });
      } else if (k === 1) {
        // Lighthouse on a low spit: a long flat mass with one vertical on it,
        // which is the read that says "the bay ends there".
        const r = 96 + rng() * 70;
        const h = 9 + rng() * 8;
        const geo = landmassGeo(r, h, seed, 0, 1.5, 30, 8);
        // squash it across the bearing so it reads as a spit, not a dome
        const m = _m4.compose(_p.set(x, this.seaLevel, z), _q.setFromEuler(_e.set(0, yaw, 0, 'YXZ')), _scl.set(1, 1, 0.34)).clone();
        this.acc.backdrop.add(geo, m, this.hazeTint(dist, 0xa2977a));
        const lh = lighthouseGeo(this.seaLevel + h, this.seaLevel);
        const sc = 2.6 + rng() * 1.6;
        const base = trs(x, this.seaLevel + h * 0.9, z, rng() * 6.28, sc);
        this.acc.backdrop.add(lh.stone, base, this.hazeTint(dist, 0xf0e6d4));
        this.acc.backdrop.add(lh.trim, base, this.hazeTint(dist, 0xd8654a));
        this.marks.push({ x, z, r });
      } else {
        // Bare headland shouldering into the water, cypress-topped.
        const r = 130 + rng() * 110;
        const h = 62 + rng() * 70;
        this.acc.backdrop.add(landmassGeo(r, h, seed, 0, 1.05, 32, 10), trs(x, this.seaLevel, z, rng() * 6.28), this.hazeTint(dist, 0x7d8a5e));
        this.ridgeSpires(x, this.seaLevel + h * 0.9, z, yaw, r * 0.5, 7, dist, rng);
        this.marks.push({ x, z, r });
      }
      return;
    }

    // Landward. The bible's hillside town has to appear at distance too, or the
    // village stops at the horizon line the way drift.png's did.
    if (k === 0) {
      const r = 150 + rng() * 120;
      const h = 90 + rng() * 90;
      this.acc.backdrop.add(landmassGeo(r, h, seed, 0, 0.95, 32, 10), trs(x, this.seaLevel, z, rng() * 6.28), this.hazeTint(dist, 0x76855a));
      this.ridgeSpires(x, this.seaLevel + h * 0.88, z, yaw, r * 0.55, 11, dist, rng);
      this.marks.push({ x, z, r });
    } else {
      const r = 120 + rng() * 90;
      const h = 55 + rng() * 55;
      this.acc.backdrop.add(landmassGeo(r, h, seed, 0, 1.0, 30, 9), trs(x, this.seaLevel, z, rng() * 6.28), this.hazeTint(dist, 0x84865e));
      this.townStack(x, this.seaLevel + h * 0.42, z, yaw, r * 0.62, h * 0.42, dist, rng);
      this.marks.push({ x, z, r });
    }
  }

  /** A walled monastery: a block, a cloister wall, a campanile, a pitched roof. */
  private monastery(x: number, y: number, z: number, yaw: number, sc: number, dist: number, rng: RNG) {
    const wall = this.hazeTint(dist, 0xf0e2cc);
    const roof = this.hazeTint(dist, 0xb5643f);
    const base = trs(x, y, z, yaw, sc);
    const put = (g: THREE.BufferGeometry, off: THREE.Matrix4, c: THREE.Color) => this.acc.backdrop.add(g, _m4.multiplyMatrices(base, off).clone(), c);
    const bw = 26 + rng() * 12;
    const bh = 13 + rng() * 6;
    put(bevelBox(bw, bh, 15, 0.4, 0.12), trs(0, bh / 2, 0, 0), wall);
    put(bevelBox(bw + 1.6, 2.4, 16.6, 0.4, 0.12), trs(0, bh + 1.2, 0, 0), roof);
    // campanile at one end: the vertical is what makes it read as a building
    const th = bh * 1.9 + rng() * 8;
    put(bevelBox(6.4, th, 6.4, 0.35, 0.14), trs(bw * 0.42, th / 2, 1.5, 0), wall);
    put(bevelBox(7.6, 1.8, 7.6, 0.3, 0.16), trs(bw * 0.42, th + 0.9, 1.5, 0), roof);
    // cloister wall running down the slope
    put(bevelBox(bw * 1.5, 5.2, 1.4, 0.25, 0.2), trs(-bw * 0.2, 2.6, -11, 0.22), wall);
  }

  /** A stepped stack of pastel blocks under one terracotta band — a hill town. */
  private townStack(x: number, y: number, z: number, yaw: number, spread: number, rise: number, dist: number, rng: RNG) {
    const base = trs(x, y, z, yaw);
    const roof = this.hazeTint(dist, 0xb5643f);
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const rowY = (r / rows) * rise;
      const rowZ = -r * spread * 0.26;
      const n = 6 + ((rng() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const bx = (i / (n - 1) - 0.5) * spread * (1.05 - r * 0.1) + (rng() - 0.5) * 6;
        const bw = 7 + rng() * 7;
        const bh = 8 + rng() * 9;
        // Pastel walls, ONE constant roof band. That contrast is the entire
        // reason a Mediterranean hill town is legible at silhouette size (§3).
        const wall = this.hazeTint(dist, PAL.pastels[(rng() * 5) | 0]);
        this.acc.backdrop.add(bevelBox(bw, bh, 8 + rng() * 4, 0.3, 0.12), _m4.multiplyMatrices(base, trs(bx, rowY + bh / 2, rowZ, (rng() - 0.5) * 0.3)).clone(), wall);
        this.acc.backdrop.add(bevelBox(bw + 1.1, 1.5, 9.4, 0.25, 0.14), _m4.multiplyMatrices(base, trs(bx, rowY + bh + 0.75, rowZ, (rng() - 0.5) * 0.3)).clone(), roof);
      }
    }
  }

  /** A line of cypress/pine spires along a ridge crest. */
  private ridgeSpires(x: number, y: number, z: number, yaw: number, spread: number, n: number, dist: number, rng: RNG) {
    const base = trs(x, y, z, yaw);
    const col = this.hazeTint(dist, 0x46592f);
    for (let i = 0; i < n; i++) {
      const h = 14 + rng() * 16;
      const spire = loft((t, o) => o.set(0, t * h, 0), 4, 6, (t) => Math.pow(Math.sin(Math.pow(t, 0.6) * Math.PI * 0.95), 0.7) * (1.9 + rng() * 1.2), 1, true, true);
      const bx = (i / Math.max(1, n - 1) - 0.5) * spread * 2 + (rng() - 0.5) * 8;
      const bz = (rng() - 0.5) * spread * 0.5;
      // sink the base so a spire on a curved crest never floats off it
      this.acc.backdrop.add(spire, _m4.multiplyMatrices(base, trs(bx, -h * 0.14 - Math.abs(bx) * 0.06, bz, 0)).clone(), col);
    }
  }

  /**
   * Sail impostors across the far bay. §1's harbour and the two sections that
   * look AT the sea all needed something to read distance against past the
   * ~260 m the boat passes reach; a white triangle at 400–1000 m is the cheapest
   * distance cue in the game and it is what a real bay is full of.
   */
  private dressFarSails() {
    const rng = mulberry32(0x5a115);
    const set = this.sets.farSail;
    if (!set) return;
    this.walk(0, 1, 34, (t, s, i) => {
      const sea = this.seaSide(t);
      const base = 300 + this.hash1(i, 0x5a11) * 640;
      const lat = sea * (s.halfWidth + base);
      if (!this.isSea(t, lat, s)) return;
      const n = 1 + ((this.hash1(i, 0x5a22) * 3) | 0);
      for (let k = 0; k < n; k++) {
        this.at(t, sea * (base + (rng() - 0.5) * 220), _p, s);
        _p.x += (rng() - 0.5) * 180;
        _p.z += (rng() - 0.5) * 180;
        if (!this.flatWorld && this.groundY(_p, t) > this.seaLevel - 1.5) continue;
        _p.y = this.seaLevel;
        set.add(trs(_p.x, _p.y, _p.z, rng() * 6.28, 2.2 + rng() * 3.4), {
          color: _col.setHSL(0.09, 0.05 + rng() * 0.06, 0.86 + rng() * 0.12).clone(),
          uv: new THREE.Vector4(1, 1, 0, 0),
          bob: new THREE.Vector4(0.14 + rng() * 0.1, rng() * 6.28, 0.02 + rng() * 0.02, 0),
          lod: 0,
        });
      }
    });
  }

  /** Two triangular sails on a hull sliver — 14 triangles, reads at a kilometre. */
  private sailGeo(): THREE.BufferGeometry {
    const acc = new GeoAccum();
    const tri = (w: number, h: number, off: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, w, 0, 0, 0, h, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
      g.setIndex([0, 1, 2]);
      g.computeVertexNormals();
      g.translate(off, 0.35, 0);
      return g;
    };
    const w = new THREE.Color(1, 1, 1);
    acc.add(tri(-1.05, 3.5, 0.05), _m4.identity(), w);
    acc.add(tri(0.62, 2.3, -0.05), _m4.identity(), w);
    // hull sliver: without it the sails float on the waterline
    acc.add(bevelBox(2.5, 0.42, 0.7, 0.06, 1), trs(-0.2, 0.16, 0, 0), new THREE.Color(0.42, 0.44, 0.48));
    acc.add(bevelBox(0.09, 3.7, 0.09, 0.02, 1), trs(0, 1.9, 0, 0), new THREE.Color(0.72, 0.7, 0.66));
    return acc.build()!;
  }

  // ==========================================================================
  // Emit
  // ==========================================================================

  private emit() {
    const M = this.mats;
    const mkMerged = (accKey: string, mat: THREE.Material, name: string, cast = true, receive = true) => {
      const g = this.acc[accKey].build();
      if (!g) return;
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      this.group.add(mesh);
    };
    mkMerged('wall', M.wall, 'village-walls');
    mkMerged('roof', M.roof, 'village-roofs');
    mkMerged('trim', M.trim, 'village-trim');
    mkMerged('stone', M.stone, 'stonework');
    mkMerged('wood', M.wood, 'timberwork');
    mkMerged('rope', M.rope, 'ropes', false, false);
    mkMerged('backdrop', M.backdrop, 'backdrop', false, false);

    // Foliage first: it contributes to the same contact-shadow batch.
    for (const mesh of this.foliage.build()) this.group.add(mesh);
    for (const s of this.foliage.shadows) this.dropShadow(s.p, s.r, s.t, 0.85);

    // Sets that cast no shadow.
    //
    // Every entry here is a shadow nobody can see, not a shadow anybody would
    // miss. Each one is worth 1.33 draw calls a frame (one near cascade every
    // frame, one far cascade every third) out of a budget of 250.
    //
    // The bar is set by the key light, and this one is LOW: SUN_DIRECTION is
    // 14 degrees above the horizon, so a prop throws a shadow four times its
    // own height. That rules out the obvious-looking savings — a sign panel
    // sitting inside its frame is not hidden by the frame's shadow at this
    // elevation, it is the solid middle of a long shape whose outline is all
    // that would be left. What survives the bar is geometry that is thin in
    // every direction (rigging, a draped net), and light sources and glazing,
    // which should never have been casting at all.
    //
    // Anything whose shadow does work — parasols and canopies, which exist to
    // make shade; tyre stacks, crates, bollards, signs and posts, which need a
    // contact shadow to sit on the ground; all foliage — is deliberately NOT
    // here.
    const noCast = new Set([
      'shadow', 'verge', 'flowers', 'gull', 'laundry', 'bunting', 'buoy',
      // cloth on a mast, small and metres above whatever it would land on
      'marshalFlag', 'flag',
      // boat rigging: masts and stays, a few centimetres across
      'rig0', 'rig1',
      // draped net, and the lighthouse's emissive lens and its glazing
      'net', 'lampGlow', 'glass',
    ]);
    for (const k of Object.keys(this.sets)) {
      const cast = !noCast.has(k);
      const mesh = this.sets[k].build(cast, k !== 'shadow');
      if (!mesh) continue;
      if (k === 'shadow') {
        mesh.renderOrder = 2;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
      }
      // The verge band lies under the contact-shadow decals, so it has to
      // resolve before them; both are transparent and neither writes depth.
      if (k === 'verge') mesh.renderOrder = 1;
      if (k === 'gull') mesh.frustumCulled = false; // the orbit lives in the shader
      this.group.add(mesh);
    }
    this.sets = {};
    this.acc = {};
  }
}
