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
/**
 * Clearance from the tarmac to the *centre* of the box, metres, measured along
 * the local ground normal.
 *
 * 1.25 put the underside 0.48 m clear, which at racing distance is far enough
 * that the eye stops connecting the box to its shadow and starts reading the
 * pair as a sprite over a decal. 1.05 keeps the hover unmistakable — the box is
 * still visibly floating, still above the kart's nose — while halving the gap
 * the contact shadow has to bridge.
 */
const BOX_HEIGHT = 1.05;
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
  /** the point on the tarmac directly under the box, for the contact shadow */
  ground: THREE.Vector3;
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
  // 1024², not 256². The player drives *through* these, so they are inside the
  // bible's "within 5 m" band (§4) every few seconds, and at 256 the glyph was
  // being magnified roughly 4x past its native size — the single most obvious
  // thing wrong with the box in the round-1 frame. One texture, ~5 MB with
  // mips, shared by every instance.
  const S = 1024;
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
  // Two-pass outline: a wide dark keyline that survives bloom, then a thin
  // warm one inside it. At 256 the wide stroke alone was all that resolved and
  // the glyph read as a soft brown smudge.
  g.lineWidth = S * 0.095;
  g.strokeStyle = '#4a2404';
  g.strokeText('?', S * 0.5, S * 0.55);
  g.lineWidth = S * 0.042;
  g.strokeStyle = '#8c4a10';
  g.strokeText('?', S * 0.5, S * 0.55);
  const q = g.createLinearGradient(0, S * 0.2, 0, S * 0.85);
  q.addColorStop(0, '#fff6d8');
  q.addColorStop(0.45, '#ffd45c');
  q.addColorStop(1, '#f09520');
  g.fillStyle = q;
  g.fillText('?', S * 0.5, S * 0.55);

  // Glass sweep. A single diagonal band of near-specular white across the pane,
  // clipped to the inside of the frame. It is what makes a flat quad read as
  // something with a surface between you and the mark.
  g.save();
  g.beginPath();
  g.rect(S * 0.145, S * 0.145, S * 0.71, S * 0.71);
  g.clip();
  const sweep = g.createLinearGradient(S * 0.1, S * 0.75, S * 0.72, S * 0.05);
  sweep.addColorStop(0.00, 'rgba(255,255,255,0)');
  sweep.addColorStop(0.44, 'rgba(255,255,255,0)');
  sweep.addColorStop(0.52, 'rgba(238,252,255,0.30)');
  sweep.addColorStop(0.58, 'rgba(255,255,255,0)');
  sweep.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = sweep;
  g.fillRect(0, 0, S, S);
  g.restore();

  // --- roughness -----------------------------------------------------------
  // §4: "Roughness must vary spatially. A constant roughness value reads as
  // plastic and is the #1 tell of an amateur real-time scene." The pane is
  // polished glass, the frame trim is brushed metal-ish, the glyph's raised
  // outline is matte lacquer — three different responses to the same key.
  const rp = pad(S >> 1);
  const rg = rp.g;
  const R = rp.size;
  rg.fillStyle = '#3d3d3d';                              // pane: glossy
  rg.fillRect(0, 0, R, R);
  const rgrd = rg.createRadialGradient(R * 0.42, R * 0.36, R * 0.02, R * 0.5, R * 0.5, R * 0.8);
  rgrd.addColorStop(0, '#242424');                       // polished toward the hot spot
  rgrd.addColorStop(1, '#5a5a5a');                       // duller at the edges
  rg.fillStyle = rgrd;
  rg.fillRect(0, 0, R, R);
  rg.strokeStyle = '#1e1e1e';                            // trim: near-mirror
  rg.lineWidth = R * 0.035;
  rg.strokeRect(R * 0.085, R * 0.085, R * 0.83, R * 0.83);
  rg.font = `900 ${R * 0.62}px "SF Pro Display", system-ui, sans-serif`;
  rg.textAlign = 'center';
  rg.textBaseline = 'middle';
  rg.lineJoin = 'round';
  rg.lineWidth = R * 0.095;
  rg.strokeStyle = '#a8a8a8';                            // glyph keyline: matte
  rg.strokeText('?', R * 0.5, R * 0.55);
  rg.fillStyle = '#7c7c7c';
  rg.fillText('?', R * 0.5, R * 0.55);
  const rghMap = padTexture(rp, false);

  const m = new THREE.MeshPhysicalMaterial({
    map: padTexture(p, true),
    roughnessMap: rghMap,
    transparent: true,
    // Near-opaque, and paired with `depthWrite` below. At 0.86 with no depth
    // write, whichever instance the buffer happened to submit last won, so a
    // box 20 m further down the row composited over the one in front of it and
    // the whole group averaged to the milky wash the review picked up on.
    opacity: 0.94,
    // Not a mirror. A little roughness is what lets the facets take different
    // amounts of key instead of all returning the same sky. The map above
    // modulates this, so it is the ceiling rather than the value.
    roughness: 1,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    emissive: new THREE.Color(0x1d5566),
    emissiveIntensity: 0.22,
    // Grazing-angle rim, so the silhouette survives against a blown sky
    // instead of dissolving into it. Pulled back from 1 now that an explicit
    // fresnel term (below) does this job properly — the two stacked was two
    // rims on the same edge.
    sheen: 0.55,
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
    // Writes depth. At 0.94 the shell is opaque enough that the usual reason to
    // skip it — soft edges bleeding into each other — does not apply, and
    // without it the transparent queue sorts *objects*, not the ~70 instances
    // inside this one mesh, so box-behind-box ordering was decided by buffer
    // index. The glow shell and the ground pool are both drawn ahead of it
    // (lower `renderOrder`) so they are unaffected.
    depthWrite: true,
  });

  // --- fresnel rim ---------------------------------------------------------
  // Sheen alone is a cloth lobe; it lifts the grazing angles a little but it is
  // energy-conserving and tinted by the key, so against a blown golden-hour sky
  // the silhouette still dissolved. This is an explicit view-dependent term
  // added to emissive: the edge of the glass lights up regardless of what is
  // behind it, which is the whole job of a rim on a translucent pickup.
  m.onBeforeCompile = (shader) => {
    // Tight and confined to the silhouette. This feeds emissive, which is
    // un-lit and un-exposed, so a broad term here is a free trip past the bloom
    // threshold across a third of the cube — power 3 keeps it to the last few
    // degrees of grazing angle, which is where a real glass edge lights up.
    shader.uniforms.uRimColor = { value: new THREE.Color(0x9fe8ff) };
    shader.uniforms.uRimPower = { value: 3.0 };
    shader.uniforms.uRimStrength = { value: 0.9 };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // `normal` (not the raw `vNormal` varying) is the shading normal after
        // <normal_fragment_begin>, so the rim follows the fillet's interpolated
        // curvature — which is the whole point of chamfering the edges.
        `#include <emissivemap_fragment>
{
  float rimF = 1.0 - saturate( abs( dot( normal, normalize( vViewPosition ) ) ) );
  totalEmissiveRadiance += uRimColor * pow( rimF, uRimPower ) * uRimStrength;
}`,
      );
  };
  // One material, one program — but be explicit so a future variant does not
  // silently share this one's compiled shader.
  m.customProgramCacheKey = () => 'itembox-fresnel';

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
  private boxGlow!: BlobShadows;
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
        // Lay the row out on the centreline frame first — that is what makes it
        // a wall across the tangent rather than a line down the road.
        const p = new THREE.Vector3()
          .copy(s.pos)
          .addScaledVector(s.binormal, lat);

        // ...then re-seat it off the surface actually underneath. The centreline
        // frame is a plane; the road is not. Crown, camber and the banked
        // sections all mean that offsetting laterally from `s.pos` and *then*
        // lifting along `s.normal` leaves the outer boxes of a row at a
        // different clearance from the inner ones — up to half a metre on the
        // 20 degree coastal curve — which is exactly the "no consistent height,
        // no ground contact" read in the review. Probing under each box and
        // lifting along the local ground normal gives every box in every row the
        // same clearance over the tarmac it is actually floating above, and
        // hands the contact shadow an exact ground point instead of a guess.
        const probe = track.probe(p, t);
        const ground = new THREE.Vector3(p.x, probe.y, p.z);
        const normal = probe.normal.clone();
        p.copy(ground).addScaledVector(normal, BOX_HEIGHT);

        this.boxes.push({
          pos: p,
          ground,
          normal,
          phase: (this.boxes.length % 7) * 0.9 + t * 11,
          down: 0,
          scale: 1,
        });
      }
    }

    this.boxMat = boxMaterial(ctx);
    if (this.boxMat.map) {
      this.boxMat.map.anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy());
    }
    // seg 6, not 4. `roundedBox` subdivides uniformly and then projects
    // everything outside the inner core onto the fillet, so at seg 4 the only
    // ring outside the core was the outermost one: every rounded edge was a
    // *single* quad, which is a chamfer the shading cannot resolve into a
    // highlight. Six puts two rings in the fillet and the edges start catching
    // the key the way §5 asks for. 432 tris, one instanced draw.
    const geo = roundedBox(BOX_SIZE, BOX_SIZE * 0.17, 6);
    this.boxMesh = new THREE.InstancedMesh(geo, this.boxMat, this.boxes.length);
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.castShadow = false;   // a translucent shell casts a poor shadow
    this.boxMesh.frustumCulled = false;
    this.boxMesh.renderOrder = 4;
    this.boxMesh.name = 'item-boxes';

    // The glow. This used to be a core *inside* the cube, and with the shell now
    // writing depth at 0.94 an interior lamp is a lamp in a box: 94% of it is
    // thrown away and the 6% that survives lands as a white bloom directly over
    // the mark, which is the milky centre the review saw. So it is turned inside
    // out — a soft additive shell a little larger than the box, drawn *before*
    // it. Everything inside the silhouette is covered by the shell; what
    // survives is a warm halo bleeding out past the edges. Against the sky that
    // is the "this is a pickup" read, and it is the same instanced mesh and the
    // same draw call it always was.
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      map: radialSprite(64, 0.0, 2.1),
      transparent: true,
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const coreGeo = new THREE.OctahedronGeometry(BOX_SIZE * 0.92, 1);
    this.coreMesh = new THREE.InstancedMesh(coreGeo, this.coreMat, this.boxes.length);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 3;

    // Contact shadow. Tighter and denser than the shared default: a 1.9 m blob
    // at 0.44 over a 1.55 m box spread the darkness so thin it was inside the
    // tarmac's own aggregate noise, which is why the review read it as absent.
    this.boxShadows = new BlobShadows(this.boxes.length, {
      opacity: 0.62,
      gamma: 1.9,
      inner: 0.10,
      name: 'item-box-shadows',
    });
    // ...and the light the box spills back down onto the road. An emissive
    // object with a hole punched in the tarmac under it and nothing else is
    // half a lighting event. Additive, warm, wider and much softer than the
    // shadow, drawn under it so the shadow core still reads.
    this.boxGlow = new BlobShadows(this.boxes.length, {
      color: 0xffc478,
      opacity: 0.30,
      gamma: 2.6,
      additive: true,
      lift: 0.035,
      renderOrder: 1,
      name: 'item-box-glow',
    });
    this.group.add(this.boxMesh, this.coreMesh, this.boxGlow.mesh, this.boxShadows.mesh);
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
    this.boxGlow.begin();
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
      // Bob along the *local ground normal*, not world Y, so on the banked
      // sections the box rises off the road rather than leaning away from it.
      const bob = Math.sin(now * 1.7 + b.phase) * 0.16;
      _e.set(
        Math.sin(now * 0.7 + b.phase) * 0.22,
        now * 1.15 + b.phase,
        Math.cos(now * 0.53 + b.phase * 1.3) * 0.18,
      );
      _q.setFromEuler(_e);
      _v2.copy(b.pos).addScaledVector(b.normal, bob);
      _s.setScalar(pop);
      _m.compose(_v2, _q, _s);
      this.boxMesh.setMatrixAt(live, _m);

      // the halo counter-rotates and breathes — two motions, never in sync
      const pulse = 0.94 + Math.sin(now * 4.1 + b.phase * 2.1) * 0.10;
      _e.set(now * -0.9, now * 1.9 + b.phase, 0);
      _q.setFromEuler(_e);
      _s.setScalar(pop * pulse);
      _m.compose(_v2, _q, _s);
      this.coreMesh.setMatrixAt(live, _m);

      // Ground contact. `b.ground` is the probed point on the tarmac directly
      // under the box, so both layers land on the surface rather than on a
      // plane through the centreline. The shadow shrinks and softens as the box
      // rises on its bob; the light pool does the opposite and spreads, which is
      // what a lamp moving away from a surface actually does.
      // Both spans are full widths, not radii: 1.85 m of shadow under a 1.55 m
      // box, and a light pool a little over twice that.
      const lift = clamp((BOX_HEIGHT + bob) / 3, 0, 1);
      const g = b.ground;
      this.boxShadows.add(g.x, g.y, g.z, b.normal, (1.85 - lift * 0.42) * pop);
      this.boxGlow.add(g.x, g.y, g.z, b.normal, (3.4 + lift * 0.9) * pop);
      live++;
    }

    this.boxMesh.count = live;
    this.coreMesh.count = live;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.coreMesh.instanceMatrix.needsUpdate = true;
    this.boxShadows.end();
    this.boxGlow.end();

    // The halo breathes rather than cycling the full hue wheel. Two reasons:
    // the old sweep spent a third of its cycle in greens and magentas the
    // course palette does not contain, and the halo now sits *outside* the
    // silhouette against a sky that is already near the bloom threshold, where
    // §6's "three effects must not white the frame out" bites hardest. So it
    // stays in the sky-warm band (`#ffd0a0` is hue ~0.08) and pulses value
    // instead — complementary to the sea-glass shell, so the two separate.
    const h = 0.085 + Math.sin(now * 0.6) * 0.025;
    this.coreMat.color.setHSL(h, 0.72, 0.50 + Math.sin(now * 2.3) * 0.06);
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
    this.boxMat.roughnessMap?.dispose();
    this.boxMat.dispose();
    this.coreMat.dispose();
    this.boxShadows.dispose();
    this.boxGlow.dispose();
  }
}
