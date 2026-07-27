/**
 * ============================================================================
 *  Atmosphere — the physical model behind the sky, and the shaders that draw it.
 * ============================================================================
 *  Art bible §2: golden hour, sun at 14° elevation, zenith #3f74c4, horizon
 *  #ffd0a0, Rayleigh + Mie, warm bloom around the disc.
 *
 *  The model is Nishita single scattering integrated through a spherical
 *  atmosphere. Two things make it usable in a 60 fps game:
 *
 *  1. The scattering integrals are baked once, on the CPU, into a 2D LUT
 *     parameterised by (view elevation, angle to sun). With a FIXED sun that
 *     pair determines the geometry exactly, so the LUT is lossless up to
 *     interpolation. Crucially the *phase functions are not baked* — they are
 *     evaluated per pixel, which is what keeps the Mie forward lobe around the
 *     disc razor sharp while the expensive part stays a single texture fetch.
 *
 *  2. A two-point calibration layer sits on top: the Rayleigh term is scaled by
 *     a gain that is solved at boot so the tonemapped zenith and horizon land
 *     exactly on the art bible's hexes. The gain is fitted by numerically
 *     inverting three's ACES curve, so the sky obeys the bible after tone
 *     mapping rather than before it — which is the only place it matters.
 *
 *  Everything here is deterministic; the same boot produces the same sky.
 * ============================================================================
 */
import * as THREE from 'three';
import { createNoise4D } from 'simplex-noise';

// --- art bible constants -----------------------------------------------------

/** Unit vector pointing TOWARD the sun. Art bible §2. Non-negotiable. */
export const SUN_DIRECTION = new THREE.Vector3(-0.62, 0.245, -0.745).normalize();
/** Key light colour, art bible §2. */
export const SUN_LIGHT_COLOR = 0xffd9a8;
/** Warm ground bounce, art bible §2. */
export const GROUND_BOUNCE_COLOR = 0xc98f5a;
/** Cool sky fill, art bible §2. */
export const SKY_FILL_COLOR = 0xa8c8ff;
/** Target displayed sky colours after tone mapping. */
export const SKY_ZENITH_TARGET = 0x3f74c4;
export const SKY_HORIZON_TARGET = 0xffd0a0;

// --- model constants ---------------------------------------------------------

const PLANET_R = 6360e3;
const ATMO_R = 6420e3;
const H_RAYLEIGH = 8000;
const H_MIE = 1200;
/** Rayleigh scattering at sea level, per metre, for R/G/B. */
const BETA_R = [5.8e-6, 13.5e-6, 33.1e-6];
/** Mie scattering at sea level, scaled by the turbidity we want. */
const BETA_M = 21e-6 * 0.5;
/** Mie extinction is a little above its scattering — aerosols absorb. */
const MIE_EXTINCTION = 1.1;
/** Cornette-Shanks asymmetry. 0.76 is the usual hazy-day value. */
const MIE_G = 0.76;
/**
 * Isotropic floor added to the Mie phase. Single scattering puts essentially
 * all the aerosol light into the forward lobe, so the half of the sky away from
 * the sun loses its haze entirely and comes back as a clean Rayleigh cyan — the
 * "it looks like noon over there" failure. Real multiple-scattered aerosol light
 * is close to isotropic, and adding it back is what turns the away-from-sun sky
 * blue-VIOLET instead of blue. The calibration re-solves against this, so the
 * bible's zenith and horizon hexes still land exactly.
 */
const MIE_ISOTROPIC = 0.12;
/**
 * Rayleigh backscatter suppression. rayleighPhase peaks equally forward and
 * backward, so with a single horizon gain fitted at 90° to the sun the ANTI-solar
 * horizon came out ~1.9x brighter than the fit direction — a superwhite band
 * wrapped the entire compass and every frame read as the same washed-out haze
 * regardless of where the camera pointed. In the real thing that light has
 * grazed the whole atmosphere and is extinguished; single scattering cannot see
 * that. The falloff is keyed to gamma < -0.05 so the fit directions (gamma ~ 0
 * at the horizon probe, +0.245 at the zenith) are untouched and the calibration
 * is exactly preserved.
 */
const RAYLEIGH_BACKSCATTER = 0.40;
/** Arbitrary radiometric scale; the calibration layer removes the ambiguity. */
const SUN_ENERGY = 22;
/** Aerosols here are warm — this is what gives the disc its golden collar. */
const MIE_TINT = [1.0, 0.78, 0.52];
/**
 * Elevation (dir.y) at which the horizon gain has fully handed over to zenith.
 * 0.42 rather than 0.35: the warm band has to survive up to ~25° or the sky
 * jumps from a white horizon straight into saturated blue with no golden middle,
 * which is the other half of the "different time of day in every frame" note.
 */
const GAIN_BLEND_END = 0.42;
const GAIN_BLEND_POW = 0.95;
/** Eye height used for the integrals. Sea level plus a bit of cliff. */
const VIEW_ALTITUDE = 300;

const I_STEPS = 20;
const J_STEPS = 8;

/** LUT dimensions. Both axes hold smooth functions, so this is plenty. */
export const LUT_WIDTH = 128;
export const LUT_HEIGHT = 64;

const CLOUD_NOISE_SIZE = 256;
/** Cycles-per-tile baked into R,G,B,A of the cloud noise. */
const CLOUD_NOISE_OCTAVES = [2, 4, 8, 16];

// --- scratch -----------------------------------------------------------------

const _integralR = new Float64Array(3);
const _rayScratch = new Float64Array(3);
const _mieScratch = new Float64Array(3);
const _dir = new THREE.Vector3();
const _shBasis: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const UP_AXIS = new THREE.Vector3(0, 1, 0);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- ACES, forward and inverted ---------------------------------------------
// Mirrors three's tonemapping_pars_fragment.glsl exactly, including the /0.6
// "brighter viewing environment" fudge, so the calibration is not a guess.

const ACES_IN = [0.59719, 0.35458, 0.04823, 0.0760, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];

function mat3Apply(m: number[], v: Float64Array, out: Float64Array): void {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
}

const _acesTmp = new Float64Array(3);

/** three's ACESFilmicToneMapping, on the CPU. `v` is linear-sRGB, in place. */
export function acesToneMap(v: Float64Array, exposure: number): void {
  const k = exposure / 0.6;
  _acesTmp[0] = v[0] * k; _acesTmp[1] = v[1] * k; _acesTmp[2] = v[2] * k;
  mat3Apply(ACES_IN, _acesTmp, v);
  for (let i = 0; i < 3; i++) {
    const a = v[i];
    v[i] = (a * (a + 0.0245786) - 0.000090537) / (a * (0.983729 * a + 0.432951) + 0.238081);
  }
  _acesTmp[0] = v[0]; _acesTmp[1] = v[1]; _acesTmp[2] = v[2];
  mat3Apply(ACES_OUT, _acesTmp, v);
  for (let i = 0; i < 3; i++) v[i] = Math.min(Math.max(v[i], 0), 1);
}

const _invProbe = new Float64Array(3);

/**
 * Find the linear radiance that ACES maps to `target` (linear-sRGB display
 * value). Fixed point with a damped exponent; ACES is monotone per channel so
 * this converges in well under 200 iterations even for near-clipped targets.
 */
function inverseAces(target: Float64Array, exposure: number, out: Float64Array): void {
  out[0] = Math.max(target[0], 1e-4);
  out[1] = Math.max(target[1], 1e-4);
  out[2] = Math.max(target[2], 1e-4);
  for (let it = 0; it < 200; it++) {
    _invProbe.set(out);
    acesToneMap(_invProbe, exposure);
    for (let c = 0; c < 3; c++) {
      // Pure white is unreachable — ACES only approaches 1 asymptotically —
      // so clamp the target just short of the ceiling.
      const t = Math.min(target[c], 0.9975);
      out[c] *= Math.pow(t / Math.max(_invProbe[c], 1e-6), 0.5);
    }
  }
}

function hexToLinear(hex: number, out: Float64Array): void {
  for (let i = 0; i < 3; i++) {
    const s = ((hex >> (16 - i * 8)) & 255) / 255;
    out[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }
}

// --- phase functions ---------------------------------------------------------

function smoothstep01(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Must stay bit-for-bit equivalent to the GLSL twin in SKY_FRAGMENT_SHADER. */
function rayleighPhase(c: number): number {
  const back = RAYLEIGH_BACKSCATTER
    + (1 - RAYLEIGH_BACKSCATTER) * smoothstep01(-0.95, -0.05, c);
  return 0.0596831 * (1 + c * c) * back;
}

function miePhase(c: number, g: number): number {
  const g2 = g * g;
  const d = Math.max(1 + g2 - 2 * g * c, 1e-4);
  return 0.1193662 * ((1 - g2) * (1 + c * c)) / ((2 + g2) * d * Math.sqrt(d));
}

/**
 * The atmosphere, evaluated on the CPU and baked for the GPU.
 *
 * Owns the calibration gains, so the fog colour, the ambient SH and the sky
 * shader are all guaranteed to agree — a fog colour that does not match the
 * sky at the horizon is the single most common way this look falls apart.
 */
export class AtmosphereModel {
  readonly sun = SUN_DIRECTION.clone();
  readonly exposure: number;

  /** Rayleigh gains, solved against the art bible's hexes. */
  readonly gainZenith = new THREE.Vector3();
  readonly gainHorizon = new THREE.Vector3();
  /** Linear radiance of the horizon; drives fog and the sky/fog weld. */
  readonly horizonColor = new THREE.Vector3();
  /** Linear radiance below the horizon — sea and sand haze, feeds the env map. */
  readonly groundColor = new THREE.Vector3();
  /** Linear radiance of the zenith. */
  readonly zenithColor = new THREE.Vector3();
  /** Radiance of the sun disc, already reddened by its own path through the air. */
  readonly sunDiscColor = new THREE.Vector3();
  /** Sunlight arriving at cloud altitude — less reddened than the disc. */
  readonly cloudSunColor = new THREE.Vector3();
  /** Skylight filling the shaded side of a cloud. */
  readonly cloudAmbientColor = new THREE.Vector3();

  /**
   * The colour distance fog and the low sky converge on: the horizon radiance
   * with the highlight rolloff applied, so it agrees with the dome in hue but
   * lands under the ACES knee in value. Distinct from `horizonColor`, which is
   * deliberately superwhite and must stay that way for the dome to hit the
   * bible's #ffd0a0.
   */
  readonly hazeColor = new THREE.Vector3();

  /** How bright the disc core is. High on purpose: it must clip and bloom. */
  sunDiscIntensity = 42;
  /** Angular radius of the disc, radians. ~3x life size, Nintendo rules. */
  sunAngularRadius = 0.019;

  private readonly mieTint = new THREE.Vector3(MIE_TINT[0], MIE_TINT[1], MIE_TINT[2]);
  /** Horizon direction used as the calibration probe: 90° in azimuth from the sun. */
  private readonly fitDir = new THREE.Vector3();

  constructor(exposure = 1.05) {
    this.exposure = exposure;

    const sh = new THREE.Vector3(this.sun.x, 0, this.sun.z).normalize();
    this.fitDir.set(-sh.z, 0.02, sh.x).normalize();

    this.calibrate();
  }

  // -- integration ------------------------------------------------------------

  /**
   * Accumulate the Rayleigh (per channel) and Mie (grey) scattering integrals
   * along `dir`. Phase functions are deliberately NOT applied here: keeping
   * them out is what lets the GPU bake this into a smooth, filterable LUT.
   * Returns the Mie integral; the Rayleigh integral lands in `outR`.
   */
  private integrate(dx: number, dy: number, dz: number, outR: Float64Array): number {
    outR[0] = 0; outR[1] = 0; outR[2] = 0;
    const oy = PLANET_R + VIEW_ALTITUDE;

    // ray/atmosphere, with the camera inside the shell so there is always a hit
    const bA = 2 * oy * dy;
    const cA = oy * oy - ATMO_R * ATMO_R;
    const discA = bA * bA - 4 * cA;
    if (discA <= 0) return 0;
    let t1 = (-bA + Math.sqrt(discA)) * 0.5;

    // clip against the planet so downward rays terminate at the surface
    const cP = oy * oy - PLANET_R * PLANET_R;
    const discP = bA * bA - 4 * cP;
    if (discP > 0) {
      const tp = (-bA - Math.sqrt(discP)) * 0.5;
      if (tp > 0) t1 = Math.min(t1, tp);
    }

    const step = t1 / I_STEPS;
    let odR = 0;
    let odM = 0;
    let mie = 0;
    let t = step * 0.5;

    for (let i = 0; i < I_STEPS; i++) {
      const px = dx * t, py = oy + dy * t, pz = dz * t;
      const h = Math.sqrt(px * px + py * py + pz * pz) - PLANET_R;
      const hr = Math.exp(-h / H_RAYLEIGH) * step;
      const hm = Math.exp(-h / H_MIE) * step;
      odR += hr;
      odM += hm;

      // secondary ray toward the sun
      const sx = this.sun.x, sy = this.sun.y, sz = this.sun.z;
      const bL = 2 * (px * sx + py * sy + pz * sz);
      const cL = px * px + py * py + pz * pz - ATMO_R * ATMO_R;
      const tL = (-bL + Math.sqrt(Math.max(bL * bL - 4 * cL, 0))) * 0.5;
      const lStep = tL / J_STEPS;
      let lodR = 0;
      let lodM = 0;
      let lit = true;
      let lt = lStep * 0.5;
      for (let j = 0; j < J_STEPS; j++) {
        const qx = px + sx * lt, qy = py + sy * lt, qz = pz + sz * lt;
        const lh = Math.sqrt(qx * qx + qy * qy + qz * qz) - PLANET_R;
        if (lh < 0) { lit = false; break; }
        lodR += Math.exp(-lh / H_RAYLEIGH) * lStep;
        lodM += Math.exp(-lh / H_MIE) * lStep;
        lt += lStep;
      }

      if (lit) {
        const tauM = BETA_M * MIE_EXTINCTION * (odM + lodM);
        for (let c = 0; c < 3; c++) {
          outR[c] += hr * Math.exp(-(BETA_R[c] * (odR + lodR) + tauM));
        }
        mie += hm * Math.exp(-(BETA_R[1] * (odR + lodR) + tauM));
      }
      t += step;
    }
    return mie;
  }

  /** Split radiance into its Rayleigh and Mie parts, both pre-gain. */
  private parts(dx: number, dy: number, dz: number, ray: Float64Array, mieOut: Float64Array): void {
    const mie = this.integrate(dx, dy, dz, _integralR);
    const gamma = dx * this.sun.x + dy * this.sun.y + dz * this.sun.z;
    const pr = rayleighPhase(gamma);
    const pm = miePhase(gamma, MIE_G);
    for (let c = 0; c < 3; c++) {
      ray[c] = SUN_ENERGY * BETA_R[c] * _integralR[c] * pr;
      mieOut[c] = SUN_ENERGY * BETA_M * mie * (pm + MIE_ISOTROPIC) * MIE_TINT[c];
    }
  }

  /**
   * Roll the top end of a linear radiance off toward `ceiling`. The sky's own
   * horizon is deliberately superwhite (the bible's #ffd0a0 has R = 255, so the
   * only linear value that tone maps to it is one that clips), and that is fine
   * for the DOME — but anything that uses it as an asymptote for geometry, i.e.
   * fog, drives every distant surface past the ACES knee where all form
   * disappears. Compressed, the same hue lands just under the knee: distant land
   * still reads as a silhouette against the sky instead of dissolving into it.
   */
  static compressHighlights(
    v: THREE.Vector3, out: THREE.Vector3, knee = 0.55, ceiling = 1.15,
  ): THREE.Vector3 {
    const span = ceiling - knee;
    const f = (x: number) => (x <= knee ? x : knee + span * (1 - Math.exp(-(x - knee) / span)));
    return out.set(f(v.x), f(v.y), f(v.z));
  }

  // -- calibration ------------------------------------------------------------

  private calibrate(): void {
    const target = new Float64Array(3);
    const solved = new Float64Array(3);

    // zenith
    hexToLinear(SKY_ZENITH_TARGET, target);
    inverseAces(target, this.exposure, solved);
    this.parts(0, 1, 0, _rayScratch, _mieScratch);
    this.gainZenith.set(
      Math.max((solved[0] - _mieScratch[0]) / _rayScratch[0], 0),
      Math.max((solved[1] - _mieScratch[1]) / _rayScratch[1], 0),
      Math.max((solved[2] - _mieScratch[2]) / _rayScratch[2], 0),
    );
    this.zenithColor.set(solved[0], solved[1], solved[2]);

    // horizon, probed 90° in azimuth from the sun so the fit is not dominated
    // by the blown-out sun-facing side
    hexToLinear(SKY_HORIZON_TARGET, target);
    inverseAces(target, this.exposure, solved);
    this.parts(this.fitDir.x, this.fitDir.y, this.fitDir.z, _rayScratch, _mieScratch);
    this.gainHorizon.set(
      Math.max((solved[0] - _mieScratch[0]) / _rayScratch[0], 0),
      Math.max((solved[1] - _mieScratch[1]) / _rayScratch[1], 0),
      Math.max((solved[2] - _mieScratch[2]) / _rayScratch[2], 0),
    );

    // The fit direction now evaluates (by construction) to the bible's horizon.
    // Fog inherits it verbatim so the two can never drift apart.
    this.radiance(this.fitDir, this.horizonColor, false);

    // Below the horizon: warm sea and sand haze. Only the env map and the last
    // couple of degrees of the dome ever see this, but a black lower hemisphere
    // would strip every PBR material of its bounce.
    this.groundColor.set(
      this.horizonColor.x * 0.30 + 0.014,
      this.horizonColor.y * 0.30 + 0.080,
      this.horizonColor.z * 0.30 + 0.097,
    );

    // Sun disc: transmittance along its own path, normalised then driven hot.
    const trans = this.sunTransmittance();
    const peak = Math.max(trans.x, trans.y, trans.z);
    this.sunDiscColor.copy(trans).multiplyScalar(this.sunDiscIntensity / peak);

    // Cloud lighting. Clouds sit above most of the haze so they see a cleaner,
    // slightly less reddened sun than the disc we draw at the horizon line.
    //
    // 1.7, not 3.4: at 3.4 the lit face landed at linear ~2.2 and ACES returned
    // (244,238,232) — a NEUTRAL WHITE cumulus, which is the single loudest
    // "this is midday" signal a sky can send. Halved, the same cloud sits at
    // ~1.28 linear and tone maps to (236,221,207): still the brightest thing in
    // frame after the disc, but unmistakably warm. The thin backlit rims still
    // clip, because the forward Mie lobe multiplies this by up to 2.2.
    const warm = new THREE.Color(SUN_LIGHT_COLOR);
    this.cloudSunColor.set(warm.r, warm.g, warm.b).multiplyScalar(1.7);
    // Shaded cloud, weighted toward the LOW sky rather than the zenith: at 14°
    // sun elevation a cumulus base is looking almost entirely at the warm half
    // of the dome, so it reads dusty rose, not lavender-grey. Zenith-dominant
    // fill was making every cloud core read cold, which fought the key.
    this.cloudAmbientColor.copy(this.zenithColor).multiplyScalar(0.40)
      .addScaledVector(this.horizonColor, 0.20);

    // Aerial perspective, from the same calibrated horizon the dome uses.
    AtmosphereModel.compressHighlights(this.horizonColor, this.hazeColor);
  }

  /** Transmittance of the whole atmosphere along the sun ray. */
  private sunTransmittance(): THREE.Vector3 {
    const s = this.sun;
    const oy = PLANET_R + VIEW_ALTITUDE;
    const b = 2 * oy * s.y;
    const c = oy * oy - ATMO_R * ATMO_R;
    const t1 = (-b + Math.sqrt(b * b - 4 * c)) * 0.5;
    const step = t1 / 32;
    let odR = 0;
    let odM = 0;
    let t = step * 0.5;
    for (let i = 0; i < 32; i++) {
      const px = s.x * t, py = oy + s.y * t, pz = s.z * t;
      const h = Math.sqrt(px * px + py * py + pz * pz) - PLANET_R;
      odR += Math.exp(-h / H_RAYLEIGH) * step;
      odM += Math.exp(-h / H_MIE) * step;
      t += step;
    }
    const tm = BETA_M * MIE_EXTINCTION * odM;
    return new THREE.Vector3(
      Math.exp(-(BETA_R[0] * odR + tm)),
      Math.exp(-(BETA_R[1] * odR + tm)),
      Math.exp(-(BETA_R[2] * odR + tm)),
    );
  }

  // -- evaluation -------------------------------------------------------------

  /**
   * Calibrated sky radiance for `dir`, matching the fragment shader term for
   * term (minus the disc and the clouds). Used for fog, ambient SH and any
   * system that wants to know what colour the sky is in a direction.
   */
  radiance(dir: THREE.Vector3, out: THREE.Vector3, weld = true): THREE.Vector3 {
    this.parts(dir.x, dir.y, dir.z, _rayScratch, _mieScratch);
    const mu = dir.y;
    let k = (mu - 0) / GAIN_BLEND_END;
    k = Math.min(Math.max(k, 0), 1);
    k = Math.pow(k * k * (3 - 2 * k), GAIN_BLEND_POW);
    out.set(
      _rayScratch[0] * (this.gainHorizon.x + (this.gainZenith.x - this.gainHorizon.x) * k) + _mieScratch[0],
      _rayScratch[1] * (this.gainHorizon.y + (this.gainZenith.y - this.gainHorizon.y) * k) + _mieScratch[1],
      _rayScratch[2] * (this.gainHorizon.z + (this.gainZenith.z - this.gainHorizon.z) * k) + _mieScratch[2],
    );
    if (mu < 0) {
      let g = Math.min(Math.max(-mu / 0.16, 0), 1);
      g = g * g * (3 - 2 * g);
      out.lerp(this.groundColor, g);
    }
    if (weld) {
      // Twin of the weld in the fragment shader; see the comment there.
      let w = Math.min(Math.max(Math.abs(mu) / 0.030, 0), 1);
      w = 1 - w * w * (3 - 2 * w);
      out.lerp(this.hazeColor, 0.34 * w);
    }
    return out;
  }

  // -- baking -----------------------------------------------------------------

  /**
   * Bake the scattering integrals into an RGBA half-float LUT.
   * u = sqrt(view elevation)  — packs texels toward the horizon where the
   *     gradient is steepest.
   * v = (angle-to-sun cosine remapped to 0..1).
   * RGB hold the Rayleigh integral, A the Mie integral. Phases stay on the GPU.
   */
  bakeScatteringLUT(): THREE.DataTexture {
    const w = LUT_WIDTH, h = LUT_HEIGHT;
    const data = new Uint16Array(w * h * 4);
    const sy = this.sun.y;
    const shLen = Math.sqrt(Math.max(1 - sy * sy, 1e-6));
    // horizontal basis: e points along the sun's azimuth, f is perpendicular
    const ex = this.sun.x / shLen, ez = this.sun.z / shLen;
    const fx = -ez, fz = ex;

    for (let y = 0; y < h; y++) {
      const gamma = ((y + 0.5) / h) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const mu = u * u;
        const sinMu = Math.sqrt(Math.max(1 - mu * mu, 0));
        // gamma = mu*sun.y + p*|sun_horizontal|  =>  solve for p, clamp to the
        // physically reachable range so the out-of-gamut corners hold their
        // nearest valid neighbour instead of garbage.
        let p = (gamma - mu * sy) / shLen;
        p = Math.min(Math.max(p, -sinMu), sinMu);
        const q = Math.sqrt(Math.max(sinMu * sinMu - p * p, 0));
        const dx = ex * p + fx * q;
        const dz = ez * p + fz * q;

        const mie = this.integrate(dx, mu, dz, _integralR);
        const i = (y * w + x) * 4;
        data[i] = THREE.DataUtils.toHalfFloat(SUN_ENERGY * BETA_R[0] * _integralR[0]);
        data[i + 1] = THREE.DataUtils.toHalfFloat(SUN_ENERGY * BETA_R[1] * _integralR[1]);
        data[i + 2] = THREE.DataUtils.toHalfFloat(SUN_ENERGY * BETA_R[2] * _integralR[2]);
        data[i + 3] = THREE.DataUtils.toHalfFloat(SUN_ENERGY * BETA_M * mie);
      }
    }

    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Tileable 4-octave noise, one octave per channel. Sampling it once gives a
   * complete FBM; sampling it twice at incommensurate scales gives eight
   * octaves for two fetches, which is what keeps the clouds cheap.
   * Tileability comes from evaluating 4D simplex on a torus.
   */
  bakeCloudNoise(): THREE.DataTexture {
    const size = CLOUD_NOISE_SIZE;
    const noise = createNoise4D(mulberry32(0x5eed1234));
    const data = new Uint8Array(size * size * 4);
    const TAU = Math.PI * 2;
    for (let c = 0; c < 4; c++) {
      const r = CLOUD_NOISE_OCTAVES[c] / TAU;
      for (let y = 0; y < size; y++) {
        const v = (y / size) * TAU;
        const cv = Math.cos(v) * r, sv = Math.sin(v) * r;
        for (let x = 0; x < size; x++) {
          const u = (x / size) * TAU;
          const n = noise(Math.cos(u) * r, Math.sin(u) * r, cv, sv);
          data[(y * size + x) * 4 + c] = Math.round(Math.min(Math.max(n * 0.5 + 0.5, 0), 1) * 255);
        }
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Project the calibrated sky (including its ground hemisphere) onto SH9.
   * Fibonacci sampling, uniform solid angle, three's own basis and
   * normalisation so the result drops straight into a LightProbe.
   */
  projectSH(samples = 2048, fillTint = 0.5): THREE.SphericalHarmonics3 {
    const sh = new THREE.SphericalHarmonics3();
    const coeff = sh.coefficients;
    const radiance = new THREE.Vector3();
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < samples; i++) {
      const y = 1 - (2 * i + 1) / samples;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const phi = i * golden;
      _dir.set(Math.cos(phi) * r, y, Math.sin(phi) * r);
      this.radiance(_dir, radiance);
      THREE.SphericalHarmonics3.getBasisAt(_dir, _shBasis);
      for (let j = 0; j < 9; j++) {
        const b = _shBasis[j];
        coeff[j].x += radiance.x * b;
        coeff[j].y += radiance.y * b;
        coeff[j].z += radiance.z * b;
      }
    }
    const norm = (4 * Math.PI) / samples;
    for (let j = 0; j < 9; j++) coeff[j].multiplyScalar(norm);

    if (fillTint > 0) this.tintFill(sh, fillTint);
    return sh;
  }

  /**
   * Pull the probe's chromaticity partway toward the art bible's stated sky
   * fill (#a8c8ff). Single-scattering skylight is bluer than the real thing —
   * multiple scattering desaturates it, and we do not simulate multiple
   * scattering. Luminance is preserved, so this changes the hue of shaded
   * surfaces without touching how bright they are.
   */
  private tintFill(sh: THREE.SphericalHarmonics3, blend: number): void {
    const irr = sh.getIrradianceAt(UP_AXIS, new THREE.Vector3());
    if (irr.x <= 0 || irr.y <= 0 || irr.z <= 0) return;

    const t = new THREE.Color(SKY_FILL_COLOR);
    const lumaIrr = 0.2126 * irr.x + 0.7152 * irr.y + 0.0722 * irr.z;
    const lumaT = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
    const k = lumaIrr / Math.max(lumaT, 1e-6);

    const gx = 1 + ((t.r * k) / irr.x - 1) * blend;
    const gy = 1 + ((t.g * k) / irr.y - 1) * blend;
    const gz = 1 + ((t.b * k) / irr.z - 1) * blend;
    for (let j = 0; j < 9; j++) {
      sh.coefficients[j].x *= gx;
      sh.coefficients[j].y *= gy;
      sh.coefficients[j].z *= gz;
    }
  }

  /** Uniform block the sky material needs from the model. */
  uniformValues() {
    return {
      gainZenith: this.gainZenith.clone(),
      gainHorizon: this.gainHorizon.clone(),
      mieTint: this.mieTint.clone(),
      mieG: MIE_G,
      mieIso: MIE_ISOTROPIC,
      rayBack: RAYLEIGH_BACKSCATTER,
      gainBlendEnd: GAIN_BLEND_END,
      gainBlendPow: GAIN_BLEND_POW,
    };
  }
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * Classic infinite-skybox vertex: strip the translation from the model-view so
 * the box is always centred on the eye, then force z = w so it lands exactly on
 * the far plane and passes the default LEQUAL depth test against a cleared
 * buffer. No near/far tuning, no scale to keep in sync with the camera.
 */
export const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  vec4 clip = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
  gl_Position = clip.xyww;
}
`;

export const SKY_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uLut;
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec2 uSunPlane;      // normalised sun azimuth, for cloud self-shadowing
uniform vec3 uGainZenith;
uniform vec3 uGainHorizon;
uniform vec3 uMieTint;
uniform vec3 uSunDisc;
uniform vec3 uGroundColor;
uniform vec3 uHorizonColor;
uniform vec3 uHazeColor;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmbient;
uniform vec2 uCameraXZ;
uniform float uTime;
uniform float uMieG;
uniform float uMieIso;
uniform float uRayBack;
uniform float uGainBlendEnd;
uniform float uGainBlendPow;
uniform float uSunRadius;
uniform float uCloudAmount;

varying vec3 vDir;

// Twin of the CPU rayleighPhase above — the two MUST stay identical or the
// calibrated gains stop meaning anything. uRayBack kills the anti-solar
// backscatter lobe that single scattering wildly overestimates.
float rayleighPhase(float c) {
  float back = mix(uRayBack, 1.0, smoothstep(-0.95, -0.05, c));
  return 0.0596831 * (1.0 + c * c) * back;
}

// Cornette-Shanks. The sharp forward lobe here is the whole reason the phase
// functions are evaluated per pixel instead of being baked into the LUT.
float miePhase(float c, float g) {
  float g2 = g * g;
  float d = max(1.0 + g2 - 2.0 * g * c, 1e-4);
  return 0.1193662 * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * d * sqrt(d));
}

vec3 atmosphere(vec3 dir, float gamma) {
  float mu = dir.y;
  vec2 uv = vec2(sqrt(clamp(mu, 0.0, 1.0)), gamma * 0.5 + 0.5);
  vec4 s = texture2D(uLut, uv);

  float k = pow(smoothstep(0.0, uGainBlendEnd, mu), uGainBlendPow);
  vec3 gain = mix(uGainHorizon, uGainZenith, k);

  vec3 col = s.rgb * rayleighPhase(gamma) * gain
           + s.a * uMieTint * (miePhase(gamma, uMieG) + uMieIso);

  // Below the horizon we are looking into sea and sand haze. This exists so the
  // env map has a lower hemisphere; on screen it is under the terrain.
  col = mix(col, uGroundColor, smoothstep(0.0, 0.16, -mu));

  // Take the kink out of the sky/ground join. This used to be a 0.75 weld over
  // ±2.6° toward a superwhite constant in every azimuth — the blown band that
  // wrapped the whole horizon in all ten shots and gave drift.png its straight
  // seam. With the backscatter fixed the model's own horizon is already
  // consistent around the compass and the fog converges on the same rolled-off
  // haze, so all this has left to do is soften the join.
  col = mix(col, uHazeColor, 0.34 * (1.0 - smoothstep(0.0, 0.030, abs(mu))));
  return col;
}

// --- clouds ---------------------------------------------------------------
// Three parallax planes rather than a raymarch: at 60 fps with a full game
// underneath, layered planes with real sun-side occlusion buy 90% of the depth
// for 5% of the cost. Each layer is lit from behind by the low sun, so thin
// edges glow warm and thick cores fall back to cool skylight.

// One fetch, four octaves — the noise texture carries 2/4/8/16 cycles per tile
// in R/G/B/A. Weighted hard toward the base octave: the threshold below slices
// this field, and a detail-heavy field slices into speckle rather than mass.
float fbmTex(vec2 p) {
  vec4 a = texture2D(uNoise, p);
  return a.r * 0.60 + a.g * 0.24 + a.b * 0.10 + a.a * 0.06;
}

float cloudField(vec2 p, vec2 w) {
  return fbmTex(p + w) * 0.80 + fbmTex(p * 2.63 + w * 1.9 + vec2(0.31, 0.77)) * 0.20;
}

// Note the deliberate absence of early-outs: every texture fetch here has to be
// reached by the whole quad or the implicit mip derivatives go undefined and
// cloud edges speckle. The layer is masked by multiplying alpha instead.
vec4 cloudLayer(vec3 dir, float gamma, float height, float scale,
                vec2 drift, float cover, float thick, float alphaMul) {
  float fade = smoothstep(0.015, 0.17, dir.y);

  // planar projection: true perspective convergence toward the horizon, and
  // real translational parallax between the layers as the kart moves
  float t = height / max(dir.y, 0.015);
  vec2 p = (uCameraXZ + dir.xz * t) * scale + drift * uTime;

  vec3 w3 = texture2D(uNoise, p * 0.31 + drift * uTime * 0.4).rgb;
  vec2 warp = (w3.xy - 0.5) * 0.22;

  float d = cloudField(p, warp);
  // low-frequency coverage modulation at an incommensurate scale — this is what
  // stops the 256px noise tile from reading as a grid across the sky
  float cov = cover + (w3.z - 0.5) * 0.30;
  float a = smoothstep(cov, cov + 0.13, d);

  // one tap displaced toward the sun approximates the optical depth of the path
  // the sunlight took to reach this pixel. With the sun 14° up that path is
  // mostly horizontal, which is exactly why the rims light and the cores do not.
  float dl = cloudField(p + uSunPlane * 0.13, warp);
  float al = smoothstep(cov, cov + 0.13, dl);
  // 0.10 floor: multiple scattering keeps even a thick core off the floor.
  // Without it the shaded side collapses onto pure skylight and goes violet.
  float trans = 0.10 + 0.90 * exp(-(a * 0.45 + al * 1.30) * thick);

  // The isotropic term carries most of the weight: real clouds multiple-scatter
  // into near-Lambertian white, and a pure single-scattering lobe would leave
  // every cloud with the sun behind the camera looking like a bruise.
  float forward = miePhase(gamma, 0.62) * 1.5;
  vec3 lit = uCloudSun * (trans * (0.55 + forward));
  float powder = 1.0 - exp(-3.0 * a);
  vec3 amb = uCloudAmbient * (0.42 + 0.58 * powder);

  vec3 col = amb + lit;
  // Clouds obey the same aerial perspective as everything else. Toward the
  // rolled-off haze, not the clipping horizon constant: at 0.85 toward a
  // superwhite the whole lower cloud deck turned into one featureless cream
  // smear about 40% up frame, which is what deleted the background layer.
  col = mix(col, uHazeColor, (1.0 - fade) * 0.70);
  return vec4(col, a * alphaMul * fade * uCloudAmount);
}

// Triangular-PDF dither. A 4000px-wide smooth gradient quantised to 8 bits
// bands visibly; a sub-LSB of noise removes it for free. Static in screen space
// so it never crawls. The relative term handles the bright end where ACES has
// compressed the signal, the absolute term handles the dark end.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 dir = normalize(vDir);
  float gamma = dot(dir, uSunDir);

  vec3 col = atmosphere(dir, gamma);

  // sun disc with limb darkening, plus two halo lobes
  float ang = acos(clamp(gamma, -1.0, 1.0));
  float r = clamp(ang / uSunRadius, 0.0, 1.0);
  float limb = pow(max(1.0 - r * r, 0.0), 0.35);
  float disc = 1.0 - smoothstep(0.80, 1.0, r);
  col += uSunDisc * disc * mix(0.45, 1.0, limb);
  col += uSunDisc * 0.010 * exp(-ang * 20.0);
  col += uSunDisc * 0.0006 * exp(-ang * 4.5);

  // Composited top-down: the high cirrus is furthest away in every direction,
  // the low deck is nearest, and each plane parallaxes against the others.
#if CLOUD_LAYERS > 2
  vec4 c0 = cloudLayer(dir, gamma, 3400.0, 0.000105, vec2(0.00068, 0.00037), 0.520, 0.80, 0.50);
  col = mix(col, c0.rgb, c0.a);
#endif
#if CLOUD_LAYERS > 1
  vec4 c1 = cloudLayer(dir, gamma, 1750.0, 0.00021, vec2(0.00123, 0.00053), 0.500, 1.35, 0.92);
  col = mix(col, c1.rgb, c1.a);
#endif
#if CLOUD_LAYERS > 0
  vec4 c2 = cloudLayer(dir, gamma, 980.0, 0.00042, vec2(0.00198, 0.00082), 0.515, 1.85, 1.0);
  col = mix(col, c2.rgb, c2.a);
#endif

  float n = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.31) - 1.0;
  col *= 1.0 + n * 0.0050;
  col += n * 0.0020;

  gl_FragColor = vec4(max(col, 0.0), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
