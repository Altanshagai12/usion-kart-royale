/**
 * ============================================================================
 *  ITEMS — boxes, the distribution table, and every item's effect
 * ============================================================================
 *  The classic arcade contract: what you get depends on where you are. The
 *  leader is armed to *defend* (bananas, green shells) and the back of the
 *  field is armed to *close* (mushrooms, stars, the bolt). Tuned so a comeback
 *  is always live without leaving first place defenceless — the leader's shell
 *  and banana are genuinely useful held behind, which is the whole point of the
 *  hold-behind mechanic.
 *
 *  Input note: `InputState` exposes only rising edges, so "hold the button to
 *  trail a shield" is expressed as press-with-backwards (deploy behind, where
 *  it shields you) then press again (release it). Same call, `use(kart, true)`,
 *  and the AI drives it through exactly the same path.
 * ============================================================================
 */
import * as THREE from 'three';
import { ItemKind, type Ctx, type IItems, type IKart } from '../types';
import type { RacingLine } from './AI';
import {
  BlobShadows, Projectiles, mushroomArt, pad, padTexture, radialSprite, roundedBox,
} from './Projectiles';

// --- tuning ------------------------------------------------------------------
const BOX_SIZE = 1.55;
/**
 * Seconds a collected box stays down.
 *
 * This is a *pack* number, not a lap number: rows are ~160 m apart, so nobody
 * re-passes a box inside a minute. What it decides is how much of the field
 * gets anything at all when eight karts cross a row nose to tail — at 4.5 s
 * everyone behind the leading two or three found an empty road.
 */
const BOX_RESPAWN = 2.5;
const BOX_PICKUP_R = 1.9;
const BOX_HEIGHT = 1.25;
/** seconds the roulette spins before the item can be spent (matches the HUD) */
const ARM_TIME = 1.05;

const MUSHROOM_BOOST = 1.55;
const MUSHROOM_STRENGTH = 1.3;
const STAR_TIME = 7.4;
const BOLT_TIME = 6.5;
const BOLT_STUN = 0.65;

/** rows of boxes around the lap, avoiding the boost strips */
const BOX_ROWS = [0.052, 0.148, 0.246, 0.336, 0.428, 0.505, 0.646, 0.712, 0.802, 0.906];

/**
 * A row of boxes is a *wall*, not a decoration: it must span the road, and
 * consecutive capture volumes must overlap, so that no line through it comes
 * out the other side empty-handed.
 *
 * The previous fixed five lanes at ±0.66 of the half-width covered the middle
 * half of a 9 m-half-width road and left ±3 m of clear tarmac against each
 * kerb. That is exactly where a racing line runs — the apex of every corner on
 * this circuit is hard against the kerb — so the field could and did drive
 * through row after row without touching one. Lanes are therefore derived from
 * the actual width at each row: spread edge to edge inside the kerb margin, and
 * enough of them that the gap never exceeds the capture diameter.
 */
const BOX_ROW_MARGIN = 1.8;
/** target metres between boxes in a row; must stay under 2 × BOX_PICKUP_R */
const BOX_LANE_GAP = 3.1;
const BOX_LANES_MIN = 3;
const BOX_LANES_MAX = 8;

// --- distribution ------------------------------------------------------------
// Columns are leader / midfield / last. Everything between is a lerp, so an
// eight-kart field gets a smooth gradient rather than three step changes.
const WEIGHTS: Record<number, [number, number, number]> = {
  [ItemKind.Mushroom]:       [10, 26, 16],
  [ItemKind.TripleMushroom]: [0, 10, 21],
  [ItemKind.GreenShell]:     [33, 19, 6],
  [ItemKind.RedShell]:       [4, 21, 17],
  [ItemKind.Banana]:         [38, 13, 4],
  [ItemKind.Star]:           [0, 4, 17],
  [ItemKind.Bolt]:           [0, 2, 10],
  [ItemKind.Bomb]:           [15, 11, 5],
};
const KINDS = Object.keys(WEIGHTS).map(Number) as ItemKind[];

interface Slot {
  kind: ItemKind;
  count: number;
  /** seconds until the item may be spent — the roulette is not decoration */
  arm: number;
  /** handle of a projectile being trailed as a shield, or -1 */
  carried: number;
  /** shrunk-by-bolt timer */
  shrink: number;
  /** cooldown on star knock-asides so one pass is not eight hits */
  starHit: number;
}

interface Box {
  pos: THREE.Vector3;
  /** ground point + normal, for the contact shadow */
  groundY: number;
  normal: THREE.Vector3;
  phase: number;
  /** >0 = collected, counting down to respawn */
  down: number;
  /** 0..1 presence, drives the pop */
  scale: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- item-box art -------------------------------------------------------------

/**
 * Translucent lacquered cube with a gold "?" on every face.
 *
 * The value range here is the whole job. Against a golden-hour sky the box is
 * lit from behind and read against the brightest thing in the frame, so an
 * albedo that starts near white has nowhere left to go: the key blows the lit
 * faces to paper, bloom eats the edges, and the cube stops being an object. The
 * previous gradient ran `#dff6ff → #ffe9c8` — 0.87 to 0.95 luma before a single
 * photon hit it — under a mirror clearcoat at `envMapIntensity 1.4`, with an
 * additive un-tone-mapped core burning through from inside.
 *
 * So: the glass is pitched down into the sea/sky end of the course palette
 * where it has three stops of headroom, the frame trim and the glyph keep the
 * hot values, and the two are far enough apart in value that the facets
 * separate under any exposure. Only the trim and the mark are allowed to bloom.
 */
function boxMaterial(ctx: Ctx): THREE.MeshPhysicalMaterial {
  const S = 256;
  const p = pad(S);
  const g = p.g;
  // Sea-glass, keyed to `sea shallow #3fc9c4` and `sky-warm #ffd0a0`. Mid
  // values, so the key light has somewhere to travel.
  const grd = g.createLinearGradient(0, 0, S, S);
  grd.addColorStop(0.0, '#6fd8d4');
  grd.addColorStop(0.42, '#3fa8bc');
  grd.addColorStop(0.74, '#7d86c8');
  grd.addColorStop(1.0, '#d8a26a');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  // Corner-to-centre falloff. A flat fill reads as a card whichever way the
  // cube turns; a face that is darker at its edges reads as a pane with depth.
  const vig = g.createRadialGradient(S * 0.5, S * 0.45, S * 0.05, S * 0.5, S * 0.5, S * 0.78);
  vig.addColorStop(0, 'rgba(210,255,255,0.42)');
  vig.addColorStop(0.55, 'rgba(120,190,205,0.0)');
  vig.addColorStop(1, 'rgba(18,58,78,0.5)');
  g.fillStyle = vig;
  g.fillRect(0, 0, S, S);

  // inset frame — reads as a bevelled pane rather than a painted decal. This
  // is one of the two things allowed to clip: a hot thin line against a mid
  // face is what draws the eye from 60 m.
  g.strokeStyle = 'rgba(255,244,214,0.95)';
  g.lineWidth = S * 0.035;
  g.strokeRect(S * 0.085, S * 0.085, S * 0.83, S * 0.83);
  g.strokeStyle = 'rgba(14,52,70,0.55)';
  g.lineWidth = S * 0.016;
  g.strokeRect(S * 0.145, S * 0.145, S * 0.71, S * 0.71);

  // the mark
  g.font = `900 ${S * 0.62}px "SF Pro Display", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = S * 0.085;
  g.strokeStyle = '#5c2f08';
  g.strokeText('?', S * 0.5, S * 0.55);
  const q = g.createLinearGradient(0, S * 0.2, 0, S * 0.85);
  q.addColorStop(0, '#fff6d8');
  q.addColorStop(0.45, '#ffd45c');
  q.addColorStop(1, '#f09520');
  g.fillStyle = q;
  g.fillText('?', S * 0.5, S * 0.55);

  const m = new THREE.MeshPhysicalMaterial({
    map: padTexture(p, true),
    transparent: true,
    // More opaque than before: at 0.72 the far face and the core both showed
    // through the near face and averaged the whole cube to one value.
    opacity: 0.86,
    // Not a mirror. A little roughness is what lets the facets take different
    // amounts of key instead of all returning the same sky.
    roughness: 0.24,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    emissive: new THREE.Color(0x1d5566),
    emissiveIntensity: 0.22,
    // Grazing-angle rim, so the silhouette survives against a blown sky
    // instead of dissolving into it.
    sheen: 1,
    sheenRoughness: 0.34,
    sheenColor: new THREE.Color(0xbff2ff),
    // Front faces only. `DoubleSide` is the intuitive choice for glass and it is
    // what was flattening the cube: the six faces of one instance are submitted
    // in geometry order with no per-triangle depth sort, so a *back* face —
    // which at golden hour is the face the sun is behind, i.e. the brightest and
    // least informative one in the box — frequently composited on top of the
    // near faces at 0.86 opacity and buried their shading. Whether the cube
    // showed any facet separation at all came down to which way it happened to
    // be spinning. Drawing only the near faces makes the three visible facets
    // read the key honestly, and halves the transparent fragment cost of ~70
    // instances while it is at it.
    side: THREE.FrontSide,
    depthWrite: false,
  });
  if (ctx.envMap) {
    m.envMap = ctx.envMap;
    m.envMapIntensity = 0.75;
  }
  return m;
}

// =============================================================================

export class Items implements IItems {
  readonly group = new THREE.Group();

  private slots = new Map<number, Slot>();
  private heldViews = new Map<number, { kind: ItemKind; count: number }>();
  private boxes: Box[] = [];
  private proj = new Projectiles();
  private karts: readonly IKart[] = [];
  private ctx!: Ctx;

  private boxMesh!: THREE.InstancedMesh;
  private coreMesh!: THREE.InstancedMesh;
  private boxShadows!: BlobShadows;
  private orbitMesh!: THREE.InstancedMesh;
  private boxMat!: THREE.MeshPhysicalMaterial;
  private coreMat!: THREE.MeshBasicMaterial;
  private env: THREE.Texture | null = null;

  // ---------------------------------------------------------------- lifecycle

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.karts = ctx.race?.karts ?? [];
    this.group.name = 'items';

    this.proj.init(ctx);
    this.buildBoxes(ctx);
    this.buildOrbit();

    ctx.scene.add(this.group);
    for (const k of this.karts) this.slots.set(k.id, this.freshSlot());
  }

  private freshSlot(): Slot {
    return { kind: ItemKind.None, count: 0, arm: 0, carried: -1, shrink: 0, starHit: 0 };
  }

  setRacingLine(l: RacingLine) {
    this.proj.setRacingLine(l);
  }

  /** Obstacles the AI should steer around. */
  get hazards() {
    return this.proj.hazards;
  }

  /** Full wipe — new race. */
  reset() {
    for (const k of this.karts) {
      const s = this.slots.get(k.id) ?? this.freshSlot();
      s.kind = ItemKind.None;
      s.count = 0;
      s.arm = 0;
      s.carried = -1;
      s.shrink = 0;
      s.starHit = 0;
      this.slots.set(k.id, s);
      k.object.scale.setScalar(1);
      k.starTime = 0;
    }
    for (const b of this.boxes) {
      b.down = 0;
      b.scale = 1;
    }
    this.proj.clear();
  }

  // -------------------------------------------------------------------- build

  private buildBoxes(ctx: Ctx) {
    const track = ctx.track;
    for (const t of BOX_ROWS) {
      const s = track.sample(t);
      // Half the span the row has to cover, kerb margin removed.
      const reach = Math.max(2.4, s.halfWidth - BOX_ROW_MARGIN);
      const lanes = clamp(
        Math.round((reach * 2) / BOX_LANE_GAP) + 1,
        BOX_LANES_MIN,
        BOX_LANES_MAX,
      );
      for (let j = 0; j < lanes; j++) {
        const lat = ((j / (lanes - 1)) * 2 - 1) * reach;
        const p = new THREE.Vector3()
          .copy(s.pos)
          .addScaledVector(s.binormal, lat)
          .addScaledVector(s.normal, BOX_HEIGHT);
        const probe = track.probe(p, t);
        this.boxes.push({
          pos: p,
          groundY: probe.y,
          normal: probe.normal.clone(),
          phase: (this.boxes.length % 7) * 0.9 + t * 11,
          down: 0,
          scale: 1,
        });
      }
    }

    this.boxMat = boxMaterial(ctx);
    const geo = roundedBox(BOX_SIZE, BOX_SIZE * 0.17, 4);
    this.boxMesh = new THREE.InstancedMesh(geo, this.boxMat, this.boxes.length);
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.castShadow = false;   // a translucent shell casts a poor shadow
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 4;
    this.boxMesh.name = 'item-boxes';

    // The inner core. Additive and un-tone-mapped, so every pixel it covers is
    // a pixel the shell's shading cannot win back — at 0.9 opacity across 30%
    // of the box it was averaging the whole cube up to white before bloom even
    // started. Smaller and dimmer: it is a glow *inside* a glass box, not a
    // lamp with a box painted on it.
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a8,
      map: radialSprite(64, 0.0, 1.4),
      transparent: true,
      opacity: 0.44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coreGeo = new THREE.OctahedronGeometry(BOX_SIZE * 0.20, 0);
    this.coreMesh = new THREE.InstancedMesh(coreGeo, this.coreMat, this.boxes.length);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 3;

    this.boxShadows = new BlobShadows(this.boxes.length);
    this.group.add(this.boxMesh, this.coreMesh, this.boxShadows.mesh);
  }

  private buildOrbit() {
    const art = mushroomArt('#ff6a5e', '#fff3e0');
    if (this.ctx.envMap) art.mat.envMap = this.ctx.envMap;
    this.orbitMesh = new THREE.InstancedMesh(art.geo, art.mat, 24);
    this.orbitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.orbitMesh.frustumCulled = false;
    this.orbitMesh.castShadow = true;
    this.orbitMesh.count = 0;
    this.orbitMesh.name = 'item-orbit';
    this.group.add(this.orbitMesh);
  }

  // --------------------------------------------------------------- IItems API

  /**
   * Weighted roll. `place` is 1-based; the position is normalised across the
   * field so the table reads the same in a 4-kart race as in an 8-kart one.
   */
  roll(place: number, racers: number): ItemKind {
    const p = racers > 1 ? clamp((place - 1) / (racers - 1), 0, 1) : 0;
    let total = 0;
    let pick = ItemKind.Mushroom;
    for (const kind of KINDS) {
      const w = WEIGHTS[kind];
      // two-segment lerp through the midfield column
      const v = p < 0.5 ? w[0] + (w[1] - w[0]) * (p * 2) : w[1] + (w[2] - w[1]) * ((p - 0.5) * 2);
      if (v <= 0) continue;
      total += v;
      if (Math.random() * total < v) pick = kind;
    }
    return total > 0 ? pick : ItemKind.Mushroom;
  }

  /**
   * The returned record is a per-kart view that is refreshed in place: the HUD
   * and every AI driver ask for this once a frame, and eight fresh objects per
   * frame is eight objects per frame the collector has to sweep. Read it, do
   * not store it.
   *
   * **A trailed shield counts as held.** Deploying a shell or a banana behind
   * you moves it out of the slot and onto a tow rope, but it is still your
   * item — it still occupies the slot as far as `pickup` is concerned, and the
   * same button still spends it. Reporting `None` for it made the HUD show an
   * empty item box while the player was visibly towing a shell, and it made the
   * AI's spend logic bail out at its `None` guard, so no driver ever released
   * what it was towing and no driver could ever collect another box for the
   * rest of the race. One kart's first banana ended its item game.
   */
  held(kart: IKart) {
    const s = this.slots.get(kart.id);
    let out = this.heldViews.get(kart.id);
    if (!out) {
      out = { kind: ItemKind.None, count: 0 };
      this.heldViews.set(kart.id, out);
    }
    if (s && s.kind === ItemKind.None && s.carried >= 0) {
      out.kind = this.proj.carriedKind(s.carried, kart.id);
      out.count = out.kind === ItemKind.None ? 0 : 1;
    } else {
      out.kind = s ? s.kind : ItemKind.None;
      out.count = s ? s.count : 0;
    }
    return out;
  }

  /**
   * What this kart is towing behind it, or `None`. Distinct from `held`: a
   * towed item is spent by *releasing* it, which is a different decision from
   * choosing when to throw, and the AI needs to tell the two apart.
   */
  towing(kart: IKart): ItemKind {
    const s = this.slots.get(kart.id);
    if (!s || s.carried < 0) return ItemKind.None;
    return this.proj.carriedKind(s.carried, kart.id);
  }

  give(kart: IKart, kind: ItemKind, count = 1) {
    const s = this.slot(kart);
    s.kind = kind;
    s.count = kind === ItemKind.TripleMushroom ? Math.max(count, 3) : count;
    s.arm = ARM_TIME;
  }

  pickup(kart: IKart) {
    const s = this.slot(kart);
    if (s.kind !== ItemKind.None || s.carried >= 0) return;
    const racers = this.karts.length || 8;
    this.give(kart, this.roll(kart.place || racers, racers));
    this.ctx.bus.emit({ type: 'item-pickup', kart });
  }

  use(kart: IKart, backwards: boolean): boolean {
    const s = this.slot(kart);
    const ctx = this.ctx;

    // A trailing shield is released by the same button that deployed it.
    if (s.carried >= 0) {
      if (this.proj.isCarried(s.carried, kart.id)) {
        const target = backwards ? -1 : this.targetAhead(kart);
        this.proj.release(s.carried, kart, backwards, target);
        s.carried = -1;
        return true;
      }
      s.carried = -1;
    }

    if (s.kind === ItemKind.None || s.count <= 0) return false;
    if (s.arm > 0) return false;
    if (kart.stunTime > 0) return false;

    const kind = s.kind;
    let consumed = true;

    switch (kind) {
      case ItemKind.Mushroom:
      case ItemKind.TripleMushroom:
        kart.applyBoost(MUSHROOM_BOOST, MUSHROOM_STRENGTH);
        break;

      case ItemKind.Star:
        kart.starTime = Math.max(kart.starTime, STAR_TIME);
        kart.applyBoost(0.8, 1.2);
        break;

      case ItemKind.Bolt:
        this.fireBolt(kart);
        break;

      case ItemKind.GreenShell:
      case ItemKind.RedShell:
      case ItemKind.Banana:
      case ItemKind.Bomb: {
        const carry = backwards && kind !== ItemKind.Bomb;
        const target = kind === ItemKind.RedShell && !carry ? this.targetAhead(kart) : -1;
        const h = this.proj.spawn(kind, kart, backwards, carry, target);
        if (h < 0) return false;
        if (carry) s.carried = h;
        break;
      }

      default:
        consumed = false;
        break;
    }

    if (!consumed) return false;
    ctx.bus.emit({ type: 'item-use', kart, kind });

    s.count--;
    if (s.count <= 0) {
      s.kind = ItemKind.None;
      s.count = 0;
    } else {
      // a triple is spent one at a time, and each one arms briefly
      s.arm = 0.22;
    }
    return true;
  }

  // ------------------------------------------------------------------ helpers

  private slot(kart: IKart): Slot {
    let s = this.slots.get(kart.id);
    if (!s) {
      s = this.freshSlot();
      this.slots.set(kart.id, s);
    }
    return s;
  }

  /** The kart one place ahead — the red shell's rightful victim. */
  private targetAhead(kart: IKart): number {
    const standings = this.ctx.race?.standings;
    if (!standings || !standings.length) return -1;
    const idx = standings.indexOf(kart);
    for (let i = idx - 1; i >= 0; i--) {
      const o = standings[i];
      if (o && !o.finished) return o.id;
    }
    return -1;
  }

  private fireBolt(user: IKart) {
    for (const k of this.karts) {
      if (k === user || k.finished) continue;
      if (k.starTime > 0) continue;
      const before = k.stunTime;
      k.squash(BOLT_STUN);
      if (k.stunTime <= before) continue;   // invulnerable, nothing landed
      const s = this.slot(k);
      s.shrink = BOLT_TIME;
      // dropping whatever they were towing is half the point of the bolt
      if (s.carried >= 0) {
        this.proj.drop(s.carried);
        s.carried = -1;
      }
      this.ctx.bus.emit({ type: 'hit', kart: k, kind: ItemKind.Bolt });
    }
  }

  // -------------------------------------------------------------------- frame

  update(ctx: Ctx, dt: number) {
    this.ctx = ctx;
    const karts = ctx.race?.karts ?? this.karts;
    this.karts = karts;
    const now = ctx.time;

    // The sky may only publish its environment map after our materials were
    // built; pick it up the frame it appears rather than shipping matte plastic.
    if (ctx.envMap !== this.env) {
      this.env = ctx.envMap;
      this.boxMat.envMap = this.env;
      this.boxMat.needsUpdate = true;
      const om = this.orbitMesh.material as THREE.MeshPhysicalMaterial;
      om.envMap = this.env;
      om.needsUpdate = true;
      this.proj.setEnv(this.env);
    }

    this.updateBoxes(dt, karts, now);

    // --- per-kart item state ------------------------------------------------
    for (const k of karts) {
      const s = this.slot(k);
      if (s.arm > 0) s.arm = Math.max(0, s.arm - dt);
      if (s.starHit > 0) s.starHit -= dt;
      if (s.carried >= 0 && !this.proj.isCarried(s.carried, k.id)) s.carried = -1;

      // bolt: shrunk, slowed, and visibly smaller until it wears off
      if (s.shrink > 0) {
        s.shrink = Math.max(0, s.shrink - dt);
        const u = clamp(s.shrink / BOLT_TIME, 0, 1);
        // quick squash down, slow grow back — recovery should be felt
        const shrunk = 0.52 + 0.48 * Math.pow(1 - u, 2.2);
        k.object.scale.setScalar(shrunk);
        // a real speed penalty applied as drag, through the sanctioned command
        _v.copy(k.velocity).multiplyScalar(-clamp(1.35 * dt, 0, 0.5) * u);
        _v.y = 0;
        k.launch(_v);
        if (s.shrink <= 0) k.object.scale.setScalar(1);
      }

      // star: barge anyone you touch out of the way
      if (k.starTime > 0 && s.starHit <= 0) this.starSweep(ctx, k, s);
    }

    this.proj.update(ctx, dt, karts);
    this.updateOrbit(karts, now);
  }

  private starSweep(ctx: Ctx, star: IKart, s: Slot) {
    for (const o of this.karts) {
      if (o === star || o.starTime > 0) continue;
      _v.subVectors(o.position, star.position);
      if (Math.abs(_v.y) > 2) continue;
      _v.y = 0;
      if (_v.lengthSq() > 3.2 * 3.2) continue;
      const before = o.stunTime;
      o.spinOut(1.25);
      if (o.stunTime <= before) continue;
      if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
      _v.normalize().multiplyScalar(11);
      _v.y = 5.5;
      o.launch(_v);
      ctx.bus.emit({ type: 'hit', kart: o, kind: ItemKind.Star });
      s.starHit = 0.4;
    }
  }

  // ---------------------------------------------------------------- item boxes

  private updateBoxes(dt: number, karts: readonly IKart[], now: number) {
    this.boxShadows.begin();
    let live = 0;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];

      if (b.down > 0) {
        b.down -= dt;
        if (b.down <= 0) b.scale = 0.001;
      } else {
        // elastic pop-in; a box that fades back is invisible at racing speed
        if (b.scale < 1) {
          b.scale = Math.min(1, b.scale + dt * 3.4);
        }
        for (let j = 0; j < karts.length; j++) {
          const k = karts[j];
          if (k.finished) continue;
          _v.subVectors(k.position, b.pos);
          if (Math.abs(_v.y) > 2.2) continue;
          _v.y = 0;
          if (_v.lengthSq() > BOX_PICKUP_R * BOX_PICKUP_R) continue;
          const s = this.slot(k);
          if (s.kind !== ItemKind.None || s.carried >= 0) continue;
          this.pickup(k);
          b.down = BOX_RESPAWN;
          b.scale = 0;
          break;
        }
      }

      if (b.scale <= 0.005) continue;

      // overshoot on the way in, so it lands with a bit of weight
      const pop = b.scale < 1
        ? 1 - Math.pow(1 - b.scale, 3) + Math.sin(b.scale * Math.PI) * 0.22
        : 1;
      const bob = Math.sin(now * 1.7 + b.phase) * 0.16;
      _e.set(
        Math.sin(now * 0.7 + b.phase) * 0.22,
        now * 1.15 + b.phase,
        Math.cos(now * 0.53 + b.phase * 1.3) * 0.18,
      );
      _q.setFromEuler(_e);
      _v2.copy(b.pos);
      _v2.y += bob;
      _s.setScalar(pop);
      _m.compose(_v2, _q, _s);
      this.boxMesh.setMatrixAt(live, _m);

      // the core counter-rotates and breathes — two motions, never in sync
      const pulse = 0.82 + Math.sin(now * 4.1 + b.phase * 2.1) * 0.18;
      _e.set(now * -0.9, now * 1.9 + b.phase, 0);
      _q.setFromEuler(_e);
      _s.setScalar(pop * pulse);
      _m.compose(_v2, _q, _s);
      this.coreMesh.setMatrixAt(live, _m);

      // the shadow shrinks and softens as the box rises on its bob
      const lift = clamp((_v2.y - b.groundY) / 3, 0, 1);
      this.boxShadows.add(b.pos.x, b.groundY, b.pos.z, b.normal, (1.9 - lift * 0.5) * pop);
      live++;
    }

    this.boxMesh.count = live;
    this.coreMesh.count = live;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.coreMesh.instanceMatrix.needsUpdate = true;
    this.boxShadows.end();

    // The core cycles hue slowly, which is what makes the box catch the eye.
    // Lightness held well below 1: this feeds an additive pass, so 0.78 was
    // adding most of a full white on top of an already-lit face.
    const h = (now * 0.11) % 1;
    this.coreMat.color.setHSL(h, 0.62, 0.52);
  }

  // ------------------------------------------------------------- carried items

  /** Triple mushrooms orbit the kart that owns them. */
  private updateOrbit(karts: readonly IKart[], now: number) {
    let n = 0;
    for (const k of karts) {
      const s = this.slots.get(k.id);
      if (!s || s.kind !== ItemKind.TripleMushroom || s.count <= 0) continue;
      const scale = k.object.scale.x || 1;
      for (let i = 0; i < s.count && n < 24; i++) {
        const a = now * 2.1 + (i / Math.max(1, s.count)) * Math.PI * 2;
        const r = 1.55 * scale;
        _v2.set(
          k.position.x + Math.sin(a) * r,
          k.position.y + 0.42 * scale + Math.sin(now * 3.2 + i) * 0.06,
          k.position.z + Math.cos(a) * r,
        );
        _q.setFromAxisAngle(UP, -a);
        _s.setScalar(0.95 * scale);
        _m.compose(_v2, _q, _s);
        this.orbitMesh.setMatrixAt(n++, _m);
      }
    }
    this.orbitMesh.count = n;
    this.orbitMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.proj.dispose();
    this.boxMesh.geometry.dispose();
    this.coreMesh.geometry.dispose();
    this.orbitMesh.geometry.dispose();
    (this.orbitMesh.material as THREE.Material).dispose();
    this.boxMat.map?.dispose();
    this.boxMat.dispose();
    this.coreMat.dispose();
    this.boxShadows.dispose();
  }
}
