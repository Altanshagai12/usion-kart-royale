import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

/**
 * ============================================================================
 *  Particles — instanced, vertex-shader-simulated, zero-allocation.
 * ============================================================================
 *  Two draw calls serve every particle in the game: one additive (sparks,
 *  flame, sparkle, flash) and one alpha-blended-and-lit (smoke, dust, spray,
 *  debris, confetti). A particle is written ONCE at spawn into a ring buffer
 *  of interleaved instance attributes; from then on the vertex shader
 *  integrates its motion analytically, so the CPU cost of a live particle is
 *  exactly zero and nothing is allocated after boot.
 *
 *  Motion is the closed-form solution of  v' = -k v + g  (linear drag under
 *  constant gravity), which gives believable terminal velocity for smoke and
 *  debris alike from a single `exp()` — no per-frame integration, no drift.
 *
 *  Soft particles, three independent mechanisms, none of which needs the
 *  render pipeline's cooperation:
 *
 *    1. A real ground-PLANE fade. Every emitter hands us the surface under it
 *       from `ctx.track.probe` — height *and* normal — and the fragment shader
 *       fades on the signed distance to that plane. Correct through banking.
 *    2. A camera-facing bias: the sprite centre is nudged toward the eye by up
 *       to a few tens of centimetres before billboarding, so it simply stops
 *       intersecting the surface it was about to cut.
 *    3. Soft-edged tiles: no sprite in the atlas reaches full alpha anywhere
 *       except a pinpoint core, so there is no hard silhouette to reveal.
 *
 *  If the pipeline ever does publish a depth texture (see `setDepthTexture`)
 *  a proper depth comparison stacks on top of all three.
 * ============================================================================
 */

export const enum PTile {
  Glow = 0,   // soft round halo — spark bloom, generic light puff
  Core = 1,   // tight hot dot with a 4-point flare — spark cores
  Smoke = 2,  // billowy eroded puff — tyre smoke, dust, explosion column
  Flame = 3,  // tapered tongue, hot base to cool tip — exhaust plume, fireball
  Star = 4,   // 5-point star — pickups, star power, spin-out ring
  Streak = 5, // soft capsule — velocity-stretched sparks, debris
  Ring = 6,   // thin annulus — small ground shock, tier flash
  Splash = 7, // droplet cluster — water spray, sand grains
}

export const enum PMode {
  /** camera-facing billboard */
  Billboard = 0,
  /** quad lying in the world XZ plane — ground flashes, scorch puffs */
  Ground = 1,
  /** billboard elongated along its screen-space velocity */
  Stretch = 2,
}

/**
 * Mutable spawn description. Callers grab `particles.p`, overwrite the fields
 * they care about and call `emit()` — no object literals in the hot path.
 */
export interface EmitParams {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** uniform random sphere added to the spawn point, metres */
  posJitter: number;
  /** uniform random sphere added to the velocity, m/s */
  velJitter: number;
  /** ±fraction applied to |velocity| */
  velScatter: number;
  life: number;
  /** ±fraction of life */
  lifeJitter: number;
  size0: number; size1: number;
  /** ±fraction applied to both sizes */
  sizeJitter: number;
  r0: number; g0: number; b0: number; a0: number;
  r1: number; g1: number; b1: number; a1: number;
  /** m/s², negative falls */
  gravity: number;
  /** linear drag coefficient, 1/s. Higher = stops sooner. */
  drag: number;
  /** rad/s billboard roll; randomised in sign */
  spin: number;
  tile: PTile;
  mode: PMode;
  /** extra length per m/s of speed, Stretch mode only */
  stretch: number;
  /** fraction of life spent fading in */
  fadeIn: number;
  /** world Y of the surface this particle should not cut through */
  groundY: number;
  /**
   * Unit normal of that surface. The soft fade is a real plane test, not a
   * height test: on the 20-degree banked coastal curve a horizontal-plane fade
   * is out by two thirds of a metre across a 2 m puff, which is exactly the
   * width of the hard intersection line craft keeps flagging.
   */
  gnx: number; gny: number; gnz: number;
  /** metres of soft-fade depth. 0 disables both soft tests. */
  softness: number;
  /**
   * Metres to pull the sprite toward the camera before it is billboarded.
   * The cheapest half of "soft particles": a quad biased 0.2–0.4 m toward the
   * eye simply stops intersecting the thing it was about to slice through, and
   * at these sizes the parallax error is invisible.
   */
  camBias: number;
  count: number;
}

// 8 x vec4 — kept at exactly 32 floats so every attribute is vec4-aligned.
const STRIDE = 32;

// ---------------------------------------------------------------------------
// Procedural atlas
// ---------------------------------------------------------------------------

const noise2 = createNoise2D(mulberry32(0x5eed1e));

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fbm(x: number, y: number, oct: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= 0.52; freq *= 2.07;
  }
  return sum / norm; // -1..1
}

function sstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** RGBA in 0..1. Called per texel of a tile, with u,v in 0..1. */
type TileFn = (u: number, v: number, out: Float32Array) => void;

/**
 * Packs `fns.length` tiles into a cols x rows atlas and builds the whole mip
 * chain with a box filter. Because tile edges stay power-of-two aligned at
 * every level, a plain 2x2 downsample never mixes neighbouring tiles — which
 * is the entire reason we can afford mipmaps on an atlas at all.
 */
export function buildAtlas(fns: TileFn[], cols: number, rows: number, size: number): THREE.DataTexture {
  const w = cols * size, h = rows * size;
  const level0 = new Uint8Array(w * h * 4);
  const px = new Float32Array(4);
  for (let t = 0; t < fns.length; t++) {
    const ox = (t % cols) * size;
    const oy = Math.floor(t / cols) * size;
    const fn = fns[t];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // sample at texel centres so the tile is symmetric
        fn((x + 0.5) / size, (y + 0.5) / size, px);
        const o = ((oy + y) * w + ox + x) * 4;
        level0[o] = clamp01(px[0]) * 255;
        level0[o + 1] = clamp01(px[1]) * 255;
        level0[o + 2] = clamp01(px[2]) * 255;
        level0[o + 3] = clamp01(px[3]) * 255;
      }
    }
  }

  const mips: { data: Uint8Array; width: number; height: number }[] = [{ data: level0, width: w, height: h }];
  let cur = level0, cw = w, ch = h;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(cw - 1, x * 2), x1 = Math.min(cw - 1, x * 2 + 1);
        const y0 = Math.min(ch - 1, y * 2), y1 = Math.min(ch - 1, y * 2 + 1);
        const o = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) {
          next[o + c] = (cur[(y0 * cw + x0) * 4 + c] + cur[(y0 * cw + x1) * 4 + c] +
            cur[(y1 * cw + x0) * 4 + c] + cur[(y1 * cw + x1) * 4 + c] + 2) >> 2;
        }
      }
    }
    mips.push({ data: next, width: nw, height: nh });
    cur = next; cw = nw; ch = nh;
  }

  const tex = new THREE.DataTexture(level0, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips as any;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // Masks and tint ramps are authored as linear values, not sRGB imagery.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** The eight sprite shapes. Every tile leaves a transparent 1-texel border. */
function particleTiles(): TileFn[] {
  const border = (u: number, v: number) => sstep(0.0, 0.012, Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)));

  return [
    // 0 — Glow: wide gaussian-ish halo with a hint of a core.
    (u, v, o) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const f = Math.max(0, 1 - d);
      const a = Math.min(1, Math.pow(f, 2.7) + 0.45 * Math.pow(f, 11));
      o[0] = o[1] = o[2] = 1; o[3] = a * border(u, v);
    },
    // 1 — Core: a blown pinpoint riding a wide soft glow, plus a *feathered*
    //     4-point flare.
    //
    //     The flare used to be `1 - |y| * 22`, i.e. a 1/22-wide linear ramp.
    //     That is a hard-edged cross barely two texels across: once the sprite
    //     is under ~20 px on screen the mip chain collapses it into a solid
    //     diamond with a crisp silhouette and no falloff at all, which is
    //     exactly the "blue confetti" the drift sparks were reading as. A
    //     gaussian flare band and a wide power-law halo survive minification —
    //     the sprite just gets softer as it shrinks instead of harder.
    //
    //     Round 4: the profile is now dominated by *falloff*. The previous
    //     `core + 0.34*halo` reached alpha 1 by 40% of the radius, so with an
    //     additively-authored colour the whole inner disc saturated and the
    //     sprite arrived as a hard-edged chip — the torn-purple-confetti read on
    //     the tier-2 drift frame. A tight gaussian core riding a long power-law
    //     skirt spends almost all of its area below the clip point, which is
    //     what makes a spark look like a spark instead of a decal.
    (u, v, o) => {
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
      const d = Math.hypot(x, y);
      const f = Math.max(0, 1 - d);
      const core = Math.exp(-d * d * 34);
      const halo = 0.16 * Math.pow(f, 2.2);
      const fall = Math.pow(f, 3.2);
      const flare = Math.exp(-y * y * 18) + Math.exp(-x * x * 18);
      const a = core + halo + 0.22 * fall * flare;
      // slightly warm core so additive stacking does not read as dead white
      o[0] = 1; o[1] = 0.97; o[2] = 0.93; o[3] = Math.min(1, a) * border(u, v);
    },
    // 2 — Smoke: eroded billow. RGB carries interior density variation so the
    //     lit puff has form before a single light hits it.
    (u, v, o) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = fbm(u * 3.2, v * 3.2, 4);
      const n2 = fbm(u * 8.4 + 11.3, v * 8.4 - 5.1, 3);
      const mask = Math.pow(Math.max(0, 1 - d), 0.85);
      const dens = mask * (0.66 + 0.46 * n + 0.18 * n2);
      let a = sstep(0.09, 0.72, dens);
      a *= sstep(1.0, 0.74, d);
      const shade = 0.70 + 0.30 * clamp01(0.5 + 0.5 * n) + 0.06 * n2;
      o[0] = shade; o[1] = shade * 0.995; o[2] = shade * 0.985;
      o[3] = a * border(u, v);
    },
    // 3 — Flame: base at v=0, tip at v=1, tapered and wobbled, with a baked
    //     temperature ramp from white-hot to deep orange.
    //
    //     The alpha is a two-lobe radial falloff — a tight bright core riding a
    //     wide, long soft tail — and it reaches zero *smoothly* at the
    //     silhouette. A smoothstep-to-1 profile (which is what this used to be)
    //     produces a hard alpha edge, and a hard alpha edge on an additive
    //     sprite is exactly the cardboard-cutout tell the plume was showing.
    (u, v, o) => {
      const x = (u - 0.5) * 2;
      const width = Math.pow(Math.max(0.001, 1 - v), 0.55) * 0.92;
      const wob = fbm(u * 4.6, v * 3.1 - 2.0, 3) * 0.20 * v;
      // 1 on the spine, 0 on the silhouette, negative outside it
      const q = clamp01(1 - Math.abs(x) / width + wob);
      let a = 0.42 * Math.pow(q, 1.9) + 0.58 * Math.pow(q, 7.0);
      // long soft dissolve at the tip and a soft shoulder at the base — no
      // clipped end caps in either direction
      a *= sstep(1.0, 0.52, v);
      a *= sstep(0.0, 0.16, v);
      const core = clamp01((1 - v) * 1.35 * (1 - Math.abs(x) * 0.8));
      const c = Math.pow(core, 1.6);
      o[0] = 1.0;
      o[1] = 0.24 + 0.70 * c;
      o[2] = 0.04 + 0.56 * c * c;
      o[3] = a * border(u, v);
    },
    // 4 — Star: a four-point sparkle, authored as *light* rather than as a
    //     shape. The old five-lobed disc had a filled body with a hard rim: at
    //     twenty pixels across it read as a white flower petal pasted over the
    //     kart, which is what the closeup frame was showing beside the driver.
    //     Two crossed gaussian bars plus a bright pinpoint and a wide skirt
    //     minify into a soft twinkle instead of a solid glyph.
    (u, v, o) => {
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
      const r = Math.hypot(x, y);
      const fade = Math.max(0, 1 - r);
      const bar = Math.exp(-y * y * 150) * Math.exp(-x * x * 1.6)
        + Math.exp(-x * x * 150) * Math.exp(-y * y * 1.6);
      const dia = 0.42 * (Math.exp(-(x - y) * (x - y) * 220) + Math.exp(-(x + y) * (x + y) * 220))
        * Math.exp(-r * r * 2.4);
      const point = Math.exp(-r * r * 90);
      const a = Math.min(1, (0.62 * bar + dia) * Math.pow(fade, 1.4) + point + 0.10 * Math.pow(fade, 3.0));
      o[0] = 1; o[1] = 0.985; o[2] = 0.95; o[3] = a * border(u, v);
    },
    // 5 — Streak: soft capsule along +v, for stretched sparks and debris. A
    //     narrow blown spine inside a wider soft body, so a motion-streaked
    //     spark still has a hot centre line rather than reading as a flat bar.
    (u, v, o) => {
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
      const along = Math.pow(Math.max(0, 1 - Math.abs(y)), 0.75);
      const body = sstep(0.0, 0.62, 1 - Math.abs(x) / 0.46);
      const spine = Math.exp(-x * x * 34);
      o[0] = 1; o[1] = 0.98; o[2] = 0.95;
      o[3] = Math.min(1, along * (0.55 * body + 0.62 * spine)) * border(u, v);
    },
    // 6 — Ring: thin gaussian annulus.
    (u, v, o) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const t = (d - 0.76) / 0.15;
      const a = Math.exp(-t * t) * sstep(1.0, 0.9, d);
      o[0] = o[1] = o[2] = 1; o[3] = a * border(u, v);
    },
    // 7 — Splash: droplet cluster, for water spray and sand grains.
    (u, v, o) => {
      const rnd = mulberry32(0x51a5);
      let a = 0;
      for (let i = 0; i < 9; i++) {
        const cx = 0.5 + (rnd() - 0.5) * 0.72;
        const cy = 0.5 + (rnd() - 0.5) * 0.72;
        const rr = 0.055 + rnd() * 0.115;
        const d = Math.hypot(u - cx, v - cy);
        a = Math.max(a, 1 - sstep(rr * 0.35, rr, d));
      }
      a *= sstep(1.0, 0.78, Math.hypot(u - 0.5, v - 0.5) * 2);
      const n = 0.86 + 0.14 * fbm(u * 12, v * 12, 2);
      o[0] = n; o[1] = n; o[2] = 1; o[3] = a * border(u, v);
    },
  ];
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
uniform float uTime;
uniform vec2  uAtlasTiles;
/** max fraction of the viewport HEIGHT a single sprite may cover */
uniform float uSizeCap;
/** x: fully faded at this view depth, y: fully opaque from here out */
uniform vec2  uNearFade;

attribute vec4 aStart;  // xyz spawn point, w birth time
attribute vec4 aVel;    // xyz initial velocity, w lifetime
attribute vec4 aDyn;    // x gravity, y drag, z spin, w mode
attribute vec4 aSize;   // x size0, y size1, z stretch, w fadeIn
attribute vec4 aColA;   // rgb at birth, a alpha at birth
attribute vec4 aColB;   // rgb at death, a alpha at death
attribute vec4 aMisc;   // x tile, y seed, z groundY, w softness
attribute vec4 aGrnd;   // xyz ground normal, w camera bias in metres

varying vec4 vColor;
varying vec2 vUv;
varying vec2 vSprite;
varying vec3 vWorld;
varying float vViewZ;
/** xyz ground-plane normal, w = -dot(normal, pointOnPlane) */
varying vec4 vPlane;
varying float vSoft;
varying float vNear;
varying float vHot;

void main() {
  float age = uTime - aStart.w;
  float life = max(aVel.w, 1e-4);
  float u = age / life;

  // Dead / unborn instances collapse outside the clip volume: they cost a
  // vertex shader invocation and nothing else. This is what lets the ring
  // buffer stay a fixed-size, allocation-free draw.
  if (age < 0.0 || u >= 1.0) {
    vColor = vec4(0.0); vUv = vec2(0.0); vSprite = vec2(0.0);
    vWorld = vec3(0.0); vViewZ = 1.0; vPlane = vec4(0.0, 1.0, 0.0, 0.0);
    vSoft = 0.0; vNear = 0.0;
    vHot = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Tiles that represent *incandescent* matter (spark cores and velocity
  // streaks) get a white-hot centre in the fragment shader. A spark that is
  // uniformly tier-blue from core to fringe is the single loudest tell that a
  // particle is a UI sprite composited over the scene rather than a piece of
  // burning metal — real sparks clip to white in the middle and only carry
  // their colour in the falloff.
  vHot = (abs(aMisc.x - 1.0) < 0.5 || abs(aMisc.x - 5.0) < 0.5) ? 1.0 : 0.0;

  // Closed-form v' = -k v + g. One exp() buys terminal velocity for free.
  float k = max(aDyn.y, 1e-3);
  float decay = exp(-k * age);
  vec3 g = vec3(0.0, aDyn.x, 0.0);
  vec3 gk = g / k;
  vec3 wp = aStart.xyz + (aVel.xyz + gk) * (1.0 - decay) / k - gk * age;

  // The ground plane this particle must not cut through, captured at spawn from
  // ctx.track.probe. Encoded as a plane equation so the fragment shader gets a
  // true signed distance and the fade follows the banking of the road.
  vec3 gN = aGrnd.xyz;
  float gl2 = dot(gN, gN);
  gN = gl2 > 1e-6 ? gN * inversesqrt(gl2) : vec3(0.0, 1.0, 0.0);
  vPlane = vec4(gN, -dot(gN, vec3(aStart.x, aMisc.z, aStart.z)));

  // Camera-facing bias. Applied to the particle CENTRE, before billboarding, so
  // the whole quad shifts rigidly and the bias cannot swim across the sprite.
  // Clamped to a fraction of the distance to the eye so a particle spawned on
  // top of the lens is not shoved through it.
  vec3 toCam = cameraPosition - wp;
  float toCamLen = length(toCam);
  if (aGrnd.w > 0.0 && toCamLen > 1e-4) {
    wp += (toCam / toCamLen) * min(aGrnd.w, toCamLen * 0.35);
  }

  float sz = mix(aSize.x, aSize.y, u);
  float alpha = mix(aColA.a, aColB.a, u) * smoothstep(0.0, max(aSize.w, 1e-4), u);
  vColor = vec4(mix(aColA.rgb, aColB.rgb, u), alpha);

  float ang = aDyn.z * age + aMisc.y * 6.2831853;
  float sa = sin(ang), ca = cos(ang);

  // Camera basis pulled straight out of the view matrix — no extra uniforms.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  // --- screen-space size clamp -------------------------------------------
  // A sprite emitted toward a chase camera walks into the near plane and its
  // projected size runs away; two of them then cover the frame. Cap the
  // projected height instead of trusting the world-space size, which costs one
  // divide and makes every emitter safe at any camera distance. Ground-aligned
  // quads are exempt: they lie on the floor, perspective already reads them
  // correctly, and clamping them would shrink ground glows as you approach.
  float centreZ = max(-(viewMatrix * vec4(wp, 1.0)).z, 1e-3);
  float szCap = uSizeCap * centreZ / max(projectionMatrix[1][1], 1e-4);
  float szB = min(sz, szCap);

  float mode = aDyn.w;
  vec3 vert;
  if (mode < 0.5) {
    vec2 q = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca) * szB;
    vert = wp + camRight * q.x + camUp * q.y;
  } else if (mode < 1.5) {
    // Ground-aligned: lies flat in XZ, spun about world up.
    vec3 q = vec3(position.x * ca - position.y * sa, 0.0, position.x * sa + position.y * ca) * sz;
    vert = wp + q;
  } else {
    vec3 vel = (aVel.xyz + gk) * decay - gk;
    vec3 velV = mat3(viewMatrix) * vel;
    vec2 d = velV.xy;
    float dl = length(d);
    float vl = length(velV);
    // Screen-space projection of the velocity, 0..1. When the particle travels
    // (anti)parallel to the view axis the stretch direction is undefined: the
    // quad snaps to an arbitrary orientation and an asymmetric tile like the
    // flame tongue then reads as a hard triangular shard. Blend back to a plain
    // billboard before that happens rather than at the degenerate point.
    float project = vl > 1e-4 ? dl / vl : 0.0;
    // Engage earlier than the degenerate point but still well clear of it. At
    // the old 0.30 threshold a spark thrown sideways out of a rear wheel and
    // viewed from a chase camera sat *below* the knee for most of its life, so
    // nothing streaked and the sparks read as evenly-spaced confetti.
    float blend = smoothstep(0.16, 0.44, project);

    vec2 axB = vec2(-sa, ca);                       // billboard up, with roll
    vec2 axS = dl > 1e-4 ? d / dl : axB;
    axS *= dot(axS, axB) < 0.0 ? -1.0 : 1.0;        // keep the mix off the pole
    vec2 ax = normalize(mix(axB, axS, blend));
    vec2 ay = vec2(-ax.y, ax.x);
    float len = szB * (1.0 + aSize.z * min(length(vel) * 0.055, 4.0) * blend);
    len = min(len, szCap * 2.2);
    vec2 q = ax * (position.y * len) + ay * (position.x * szB);
    vert = wp + camRight * q.x + camUp * q.y;
  }

  vec4 mv = viewMatrix * vec4(vert, 1.0);
  vViewZ = -mv.z;
  vWorld = vert;
  vSoft = aMisc.w;
  vSprite = position.xy * 2.0;
  // Lens fade. Nothing should be legible in the first metre in front of the
  // near plane: at that range a sprite is a texture-filling smear, not an
  // effect. Driven off the particle centre so the fade cannot swim across a
  // single quad.
  vNear = smoothstep(uNearFade.x, uNearFade.y, centreZ);

  float col = mod(aMisc.x, uAtlasTiles.x);
  float row = floor(aMisc.x / uAtlasTiles.x);
  vUv = (uv + vec2(col, row)) / uAtlasTiles;

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uGain;
/**
 * Per-fragment additive shoulder. Additive effects must ADD to a scene, not
 * replace it: without a bound, ten overlapping spark cores authored at 3x a
 * saturated primary put 30 units of radiance through one pixel and the tone
 * mapper has nothing left to do but return white. rgb / (1 + rgb * uClip)
 * is a Reinhard shoulder applied to the *emission*, so a lone core still
 * clears the bloom threshold and a pile of them asymptotes just above it
 * instead of running away. Cheap, monotonic, and it never dims a single
 * particle enough to notice.
 *
 * 0.13, down from 0.19. The claim above — that a lone core still clears the
 * bloom threshold — stopped being true when the two numbers moved past each
 * other. At 0.19 the shoulder asymptotes at 1/0.19 = 5.26 and, more to the
 * point, it takes a spark authored at 2.35 down to 1.61 before it ever reaches
 * the framebuffer, so a drift spark composited onto shadowed tarmac landed at
 * a luminance of about 1.2 against PostFX's 1.55 gate: no bloom, ever, on any
 * spark in the game. That is the whole of "the sparks read as dust motes" —
 * a spark IS its glow. At 0.13 the same core arrives at 1.79, clears the gate,
 * and the asymptote is still a hard 7.7, so ten overlapping cores cannot run
 * away and the boost + tier-3 + tunnel-exit stack still cannot white out.
 */
uniform float uClip;
#ifdef LIT
uniform vec3 uSunDir;      // direction TOWARD the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uBounceColor;
#endif
#ifdef SOFT_DEPTH
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uCamPlanes;   // near, far
#endif

varying vec4 vColor;
varying vec2 vUv;
varying vec2 vSprite;
varying vec3 vWorld;
varying float vViewZ;
varying vec4 vPlane;
varying float vSoft;
varying float vNear;
varying float vHot;

void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vColor.a * vNear;
  if (a < 0.004) discard;

  vec3 rgb = tex.rgb * vColor.rgb;

#ifdef ADDITIVE
  // Hot core. The sprite mask doubles as "how deep into the spark are we", so
  // cubing it gives a tight centre and a wide fringe. Pulling the weak channels
  // up to the strongest one desaturates the core toward white without touching
  // its energy. Off for every tile except the spark core and the streak (vHot),
  // so glow halos still carry flat tier colour.
  //
  // Round 5: cubed, not squared, and 0.45 rather than 0.85. Squared-times-0.85
  // reached 0.6 desaturation by 40% of the sprite radius, and because the
  // stretched streak tile holds a high mask value all the way down its spine,
  // an *entire tier-2 spark* arrived at the tone mapper as neutral white. The
  // drift review is unambiguous: the sparks read as fireflies with no hue in
  // them at all. A cubed mask confines the whitening to the genuine pinpoint
  // and leaves the streak body carrying #ff9d2e.
  float mx = max(max(rgb.r, rgb.g), rgb.b);
  float hotMask = tex.a * tex.a * tex.a;
  rgb = mix(rgb, vec3(mx), vHot * hotMask * 0.45);
#endif

#ifdef LIT
  // Reconstruct a hemisphere normal from the sprite disc so the puff shades
  // like a ball of vapour rather than a flat decal.
  vec3 n;
  n.xy = vSprite;
  float r2 = dot(n.xy, n.xy);
  n.z = sqrt(max(0.0, 1.0 - min(r2, 1.0)));
  vec3 N = normalize(n * mat3(viewMatrix)); // orthonormal => transpose == inverse

  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = dot(N, uSunDir);
  // Wrapped diffuse: vapour is translucent, it does not terminate at N.L = 0.
  float wrapD = clamp((ndl + 0.62) / 1.62, 0.0, 1.0);
  // Forward scattering when the sun is on the far side of the puff. This is
  // the golden-hour money shot for tyre smoke on the cliff traverse. Two lobes:
  // a broad Henyey-Greenstein-ish haze plus a tight glow right on the sun
  // vector, so a puff between the camera and a 14-degree sun goes genuinely hot
  // rather than one shade lighter.
  float sv = clamp(-dot(uSunDir, V), 0.0, 1.0);
  float fwd = 0.55 * pow(sv, 2.0) + 1.25 * pow(sv, 7.0);
  // Silhouette rim: the edge of a billboarded puff is where the sight line
  // passes through the least vapour, so it is where backlight leaks through.
  float rim = pow(clamp(dot(vSprite, vSprite), 0.0, 1.0), 1.6) * clamp(0.35 - ndl, 0.0, 1.0);
  vec3 amb = mix(uBounceColor, uSkyColor, N.y * 0.5 + 0.5);
  // KEY AND FILL, NOT KEY PLUS AMBIENT.
  //
  // The previous form was amb * 0.62 + sun * (...), i.e. a constant ambient
  // floor with the key added on top. Two things follow from that and both of
  // them are visible in the pack/wide review frames: the sum on the lit side
  // lands above 1.0 for a puff whose base colour is already near 0.8, so the
  // sun side clips and loses all its internal form; and the shadow side never
  // falls below the flat achromatic floor, so there is no cool lobe for the
  // warm one to read against. A puff with no value ratio across it is a
  // cotton-wool decal, which is exactly the note.
  //
  // Fill is now *complementary* to the key: it is strongest where the key is
  // absent. That gives a genuine two-lobe split — roughly 2.5x brighter and
  // distinctly warm on the sun side, cool sky-blue in the shadow — with the lit
  // side landing just under clip so the billow keeps its density variation.
  // ART_DIRECTION §6: the smoke must catch the sun; §2: shadows lean cool.
  vec3 key = uSunColor * (wrapD * 0.95 + fwd * 1.05 + rim * 1.25);
  vec3 fill = amb * (0.30 + 0.34 * (1.0 - wrapD));
  rgb *= key + fill;
#endif

  float soft = 1.0;
  if (vSoft > 0.0) {
#ifdef SOFT_DEPTH
    float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
    float nz = uCamPlanes.x, fz = uCamPlanes.y;
    float sceneZ = (2.0 * nz * fz) / (fz + nz - (d * 2.0 - 1.0) * (fz - nz));
    soft *= clamp((sceneZ - vViewZ) / vSoft, 0.0, 1.0);
#endif
    // Ground-plane fade. Cheap, always on, and on its own it already removes
    // the hard intersection line where a billboard sinks into the tarmac. The
    // plane carries the surface normal from ctx.track.probe, so this stays
    // correct through 20 degrees of banking and over the cliff camber.
    float h = dot(vPlane.xyz, vWorld) + vPlane.w;
    soft *= smoothstep(-0.30 * vSoft, vSoft * 0.85, h);
  }
  a *= soft;
  if (a < 0.004) discard;

  rgb *= uGain;
#ifdef ADDITIVE
  rgb = rgb / (1.0 + rgb * uClip);
#endif
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

function baseQuad(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // The vertex shader places everything in world space; a bounding volume
  // would be meaningless and culling it would be wrong.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

class Layer {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  readonly buffer: THREE.InstancedInterleavedBuffer;
  readonly data: Float32Array;
  readonly material: THREE.ShaderMaterial;

  private head = 0;
  private lo = Infinity;
  private hi = -Infinity;
  private wrapped = false;
  /** wall-clock time at which the newest particle expires */
  private liveUntil = -1;

  constructor(readonly capacity: number, atlas: THREE.DataTexture, additive: boolean, lit: boolean) {
    this.geo = baseQuad();
    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const names = ['aStart', 'aVel', 'aDyn', 'aSize', 'aColA', 'aColB', 'aMisc', 'aGrnd'];
    for (let i = 0; i < names.length; i++) {
      this.geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buffer, 4, i * 4));
    }
    this.geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: atlas },
        uAtlasTiles: { value: new THREE.Vector2(4, 2) },
        uGain: { value: 1 },
        uClip: { value: additive ? 0.13 : 0.0 },
        // 0.40 of viewport height. Big enough for an explosion fireball to feel
        // enormous, small enough that no single sprite can ever become the
        // frame — which is what the boost plume was doing into the chase cam.
        uSizeCap: { value: 0.40 },
        uNearFade: { value: new THREE.Vector2(0.35, 1.25) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.4, 0.5, 0.7) },
        uBounceColor: { value: new THREE.Color(0.25, 0.18, 0.12) },
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uCamPlanes: { value: new THREE.Vector2(0.2, 3000) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: {
        ...(lit ? { LIT: '' } : {}),
        ...(additive ? { ADDITIVE: '' } : {}),
      } as Record<string, string>,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    this.mesh.matrixAutoUpdate = false;
  }

  spawn(p: EmitParams, now: number, seed: number) {
    const i = this.head;
    this.head = this.head + 1;
    if (this.head >= this.capacity) { this.head = 0; this.wrapped = true; }
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;

    const d = this.data;
    const o = i * STRIDE;
    const R = Math.random;

    // --- position ---
    const pj = p.posJitter;
    d[o] = p.x + (R() - 0.5) * 2 * pj;
    d[o + 1] = p.y + (R() - 0.5) * 2 * pj;
    d[o + 2] = p.z + (R() - 0.5) * 2 * pj;
    const life = p.life * (1 + (R() - 0.5) * 2 * p.lifeJitter);
    d[o + 3] = now;

    // --- velocity ---
    const scat = 1 + (R() - 0.5) * 2 * p.velScatter;
    const vj = p.velJitter;
    d[o + 4] = p.vx * scat + (R() - 0.5) * 2 * vj;
    d[o + 5] = p.vy * scat + (R() - 0.5) * 2 * vj;
    d[o + 6] = p.vz * scat + (R() - 0.5) * 2 * vj;
    d[o + 7] = life;

    d[o + 8] = p.gravity;
    d[o + 9] = p.drag;
    d[o + 10] = p.spin * (R() < 0.5 ? -1 : 1);
    d[o + 11] = p.mode;

    const sj = 1 + (R() - 0.5) * 2 * p.sizeJitter;
    d[o + 12] = p.size0 * sj;
    d[o + 13] = p.size1 * sj;
    d[o + 14] = p.stretch;
    d[o + 15] = p.fadeIn;

    d[o + 16] = p.r0; d[o + 17] = p.g0; d[o + 18] = p.b0; d[o + 19] = p.a0;
    d[o + 20] = p.r1; d[o + 21] = p.g1; d[o + 22] = p.b1; d[o + 23] = p.a1;

    d[o + 24] = p.tile;
    d[o + 25] = seed;
    d[o + 26] = p.groundY;
    d[o + 27] = p.softness;

    d[o + 28] = p.gnx; d[o + 29] = p.gny; d[o + 30] = p.gnz;
    d[o + 31] = p.camBias;

    const until = now + life;
    if (until > this.liveUntil) this.liveUntil = until;
  }

  /**
   * Shorten the lifetime of the newest `count` slots so anything still alive
   * expires `fade` seconds from now. Walks backwards from the write head, which
   * is exactly newest-first, and stops at the ring's live extent.
   */
  retireRecent(count: number, now: number, fade: number) {
    const cap = this.capacity;
    const n = Math.min(count, this.wrapped ? cap : this.head);
    const d = this.data;
    let i = this.head;
    for (let j = 0; j < n; j++) {
      i = i === 0 ? cap - 1 : i - 1;
      const o = i * STRIDE;
      const age = now - d[o + 3];
      const life = d[o + 7];
      if (age < 0 || age >= life) continue;
      const shortened = age + fade;
      if (shortened >= life) continue;
      d[o + 7] = shortened;
      if (i < this.lo) this.lo = i;
      if (i > this.hi) this.hi = i;
    }
  }

  flush(now: number) {
    if (this.hi >= this.lo) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.lo * STRIDE, (this.hi - this.lo + 1) * STRIDE);
      this.buffer.needsUpdate = true;
      this.lo = Infinity; this.hi = -Infinity;
    }
    // Skip the draw entirely once every particle has expired.
    this.geo.instanceCount = now > this.liveUntil ? 0 : (this.wrapped ? this.capacity : this.head);
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

export class Particles {
  readonly group = new THREE.Group();
  readonly atlas: THREE.DataTexture;
  private readonly additiveLayer: Layer;
  private readonly alphaLayer: Layer;
  private readonly layers: Layer[];

  /** density multiplier from settings, applied to every emit count */
  density = 1;

  /** Shared spawn description — fill it, then call emit(). Never copied. */
  readonly p: EmitParams = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    posJitter: 0, velJitter: 0, velScatter: 0,
    life: 1, lifeJitter: 0.2,
    size0: 1, size1: 1, sizeJitter: 0.2,
    r0: 1, g0: 1, b0: 1, a0: 1,
    r1: 1, g1: 1, b1: 1, a1: 0,
    gravity: 0, drag: 1, spin: 0,
    tile: PTile.Glow, mode: PMode.Billboard, stretch: 0, fadeIn: 0.08,
    groundY: -1e4, gnx: 0, gny: 1, gnz: 0, softness: 0, camBias: 0, count: 1,
  };

  constructor(additiveCapacity: number, alphaCapacity: number) {
    this.atlas = buildAtlas(particleTiles(), 4, 2, 256);
    this.additiveLayer = new Layer(additiveCapacity, this.atlas, true, false);
    this.alphaLayer = new Layer(alphaCapacity, this.atlas, false, true);
    this.layers = [this.alphaLayer, this.additiveLayer];
    this.group.add(this.alphaLayer.mesh, this.additiveLayer.mesh);
    this.group.matrixAutoUpdate = false;
  }

  /** Reset the shared params to neutral defaults before configuring an emit. */
  reset(): EmitParams {
    const p = this.p;
    p.x = p.y = p.z = 0;
    p.vx = p.vy = p.vz = 0;
    p.posJitter = 0; p.velJitter = 0; p.velScatter = 0;
    p.life = 1; p.lifeJitter = 0.2;
    p.size0 = 1; p.size1 = 1; p.sizeJitter = 0.2;
    p.r0 = p.g0 = p.b0 = 1; p.a0 = 1;
    p.r1 = p.g1 = p.b1 = 1; p.a1 = 0;
    p.gravity = 0; p.drag = 1; p.spin = 0;
    p.tile = PTile.Glow; p.mode = PMode.Billboard; p.stretch = 0; p.fadeIn = 0.08;
    p.groundY = -1e4; p.gnx = 0; p.gny = 1; p.gnz = 0;
    p.softness = 0; p.camBias = 0; p.count = 1;
    return p;
  }

  /**
   * Declare the surface this emission sits on. Every emitter should call this:
   * it is what drives the soft fade *and* the camera-facing bias, and the two
   * together are the whole reason particles stop slicing through the road.
   */
  ground(y: number, n: { x: number; y: number; z: number }, softness: number, camBias = 0.22): EmitParams {
    const p = this.p;
    p.groundY = y; p.gnx = n.x; p.gny = n.y; p.gnz = n.z;
    p.softness = softness; p.camBias = camBias;
    return p;
  }

  at(x: number, y: number, z: number): EmitParams { const p = this.p; p.x = x; p.y = y; p.z = z; return p; }
  vel(x: number, y: number, z: number): EmitParams { const p = this.p; p.vx = x; p.vy = y; p.vz = z; return p; }

  /** Birth colour = `c * intensity` (HDR allowed), alpha `a`. */
  colorA(c: THREE.Color, intensity: number, a: number): EmitParams {
    const p = this.p; p.r0 = c.r * intensity; p.g0 = c.g * intensity; p.b0 = c.b * intensity; p.a0 = a; return p;
  }
  colorB(c: THREE.Color, intensity: number, a: number): EmitParams {
    const p = this.p; p.r1 = c.r * intensity; p.g1 = c.g * intensity; p.b1 = c.b * intensity; p.a1 = a; return p;
  }

  /**
   * Spawn `p.count * density` particles. Counts always round to at least one
   * when the caller asked for any at all, so low-density machines still get
   * the readability cue, just thinner.
   */
  emit(additive: boolean) {
    const p = this.p;
    let n = p.count * this.density;
    // fractional remainder resolved stochastically — avoids density banding
    let count = Math.floor(n);
    if (Math.random() < n - count) count++;
    if (count <= 0) count = p.count > 0 ? 1 : 0;
    const layer = additive ? this.additiveLayer : this.alphaLayer;
    const now = this.time;
    for (let i = 0; i < count; i++) layer.spawn(p, now, Math.random());
  }

  private time = 0;

  /**
   * Stamp the clock used as the birth time of everything emitted this frame.
   * Call before the first emit; `update()` re-stamps and then flushes.
   */
  setTime(t: number) { this.time = t; }

  /** Global additive attenuation — see Effects for how the load is measured. */
  set additiveGain(v: number) { this.additiveLayer.material.uniforms.uGain.value = v; }

  setLighting(sunDir: THREE.Vector3, sun: THREE.Color, sky: THREE.Color, bounce: THREE.Color) {
    const u = this.alphaLayer.material.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.copy(sun);
    u.uSkyColor.value.copy(sky);
    u.uBounceColor.value.copy(bounce);
  }

  /**
   * Opt-in true soft particles. The render pipeline owns the depth buffer; if
   * it publishes one we use it, otherwise the ground-plane fade carries us.
   *
   * Both layers get it. The additive layer needs it *more* than the alpha one:
   * an exhaust plume that cuts a hard intersection line through the tarmac is
   * the single loudest amateur tell an arcade racer can ship.
   */
  setDepthTexture(tex: THREE.Texture | null, near: number, far: number) {
    for (const l of this.layers) {
      const m = l.material;
      const had = m.defines.SOFT_DEPTH !== undefined;
      const want = !!tex;
      m.uniforms.uDepth.value = tex;
      m.uniforms.uCamPlanes.value.set(near, far);
      if (want !== had) {
        if (want) m.defines.SOFT_DEPTH = ''; else delete m.defines.SOFT_DEPTH;
        m.needsUpdate = true; // recompile: the depth branch is a static define
      }
    }
  }

  resize(w: number, h: number) {
    for (const l of this.layers) l.material.uniforms.uInvRes.value.set(1 / w, 1 / h);
  }

  /**
   * Cut short the newest `count` particles on a layer so they dissolve within
   * `fade` seconds. Used on a drift-tier change: without it the frame shows the
   * old tier's colour and the new one at the same time, which contradicts the
   * one thing drift particles exist to communicate.
   *
   * Bounded work, no allocation, and harmless on slots that are already dead.
   */
  retireRecent(additive: boolean, count: number, fade = 0.07) {
    (additive ? this.additiveLayer : this.alphaLayer).retireRecent(count, this.time, fade);
  }

  update(time: number) {
    this.time = time;
    for (const l of this.layers) {
      l.material.uniforms.uTime.value = time;
      l.flush(time);
    }
  }

  dispose() {
    for (const l of this.layers) l.dispose();
    this.atlas.dispose();
  }
}
