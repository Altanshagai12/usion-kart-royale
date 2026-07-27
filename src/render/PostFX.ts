/**
 * ============================================================================
 *  PostFX — the effect chain that sits on top of the raw scene render.
 * ============================================================================
 *  Ownership split with Renderer.ts: Renderer owns the WebGLRenderer, the
 *  EffectComposer and its buffers; PostFX owns everything that goes *into*
 *  the composer (passes + effects) and the per-frame uniform sync.
 *
 *  Chain, in order:
 *    RenderPass            scene -> HDR (half-float) multisampled buffer
 *    N8AOPostPass          ground-truth-ish AO, multiplied into the lit colour
 *    EffectPass[DoF]       shallow bokeh focused on the player kart
 *    EffectPass[Bloom]     high-threshold mipmap bloom, wide + soft
 *    EffectPass[Grade]     ONE shader: reprojection motion blur + chromatic
 *                          aberration + highlight shoulder + ACES + S-curve +
 *                          split tone (teal lift / warm gain) + sat rolloff +
 *                          speed lines + vignette + grain
 *    EffectPass[SMAA]      final AA resolve, dithered on the way to the screen
 *
 *  Everything downstream of the RenderPass works in scene-linear HDR until the
 *  grade shader tone maps; postprocessing re-linearises between passes and
 *  encodes to sRGB exactly once, on the final write to the default framebuffer.
 * ============================================================================
 */
import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  DepthOfFieldEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  EdgeDetectionMode,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  type Pass,
} from 'postprocessing';
// @ts-ignore — n8ao ships no type declarations, and we may not add a .d.ts here.
import { N8AOPostPass } from 'n8ao';
import { Quality, type Ctx } from '../types';

// ---------------------------------------------------------------------------
// The merged grade / lens shader.
// ---------------------------------------------------------------------------
// Five separate passes (blur, CA, tone map, grade, vignette+grain) would cost
// five full-screen bandwidth round trips and quantise the image four extra
// times. Merged, it is one pass and the whole grade happens in float.
const GRADE_FRAGMENT = /* glsl */ `
uniform mat4 prevViewProj;
uniform mat4 invViewProj;
uniform vec4 grade;   // x exposure, y S-curve amount, z saturation, w vignette
uniform vec4 lens;    // x aberration, y grain, z speed-line gain, w shutter
uniform vec2 rush;    // x radial blur amount, y gated speed intensity
uniform vec3 subject; // world-space centre of the player's kart
uniform vec2 hold;    // hold-out radii about the subject: x fully sharp, y fully blurred (metres)
uniform vec3 coolTint;
uniform vec3 warmTint;
uniform vec3 shadowLift;
uniform vec4 rolloff; // x knee (scene-linear), y exponent, z highlight desat, w desat span

const vec3 KR_LUMA = vec3(0.2126, 0.7152, 0.0722);

float krHash12(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float krValueNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(krHash12(vec2(i, 17.3)), krHash12(vec2(i + 1.0, 17.3)), f);
}

// Scene-linear highlight shoulder, applied BEFORE the display transform.
//
// ACES on its own maps everything past roughly 3x mid-grey into the last few
// hundredths of display range, so a roof at 4x and a roof at 20x land on the
// same #ffffff and the highlight reads as a flat paper cut-out with no gradient
// inside it. Compressing the top end first is what gives those two values room
// to separate again.
//
// The curve is a power law above the knee, not a saturating exponential. An
// asymptote would buy separation at the cost of never reaching white, and the
// art bible is explicit that chrome and water must clip to white and bloom;
// x^0.30 keeps climbing forever, so a specular two orders of magnitude up still
// gets there.
//
// It is gated on the brightest channel rather than on luminance: a saturated red
// at 1.2 linear has a luminance of only 0.49, so a luminance gate would let it
// past and the red channel would clip on its own — which is exactly how a warm
// highlight breaks to a flat primary. max(rgb) compresses the channel that is
// actually about to clip.
//
// rolloff.z is the highlight desaturation and it is the thing that was wrong.
// At 0.55 over a span of 12x the knee, EVERY bright coloured thing in the game
// arrived at white well before it arrived at 255: measured through the whole
// chain, a tier-3 drift plume at scene-linear (12, 4, 20) came out rgb(243, 225,
// 238) — chroma 0.07, i.e. grey — a blue boost pad at (4, 9, 14) came out
// rgb(241, 241, 238), chroma 0.01, and a boost flame at (22, 11, 3) came out
// rgb(250, 242, 234), chroma 0.06. The brief's "boost pads clipping to
// featureless white" was not the shoulder failing to compress; it was the
// shoulder deliberately bleaching the colour out first, and then bloom spreading
// the result. At 0.14 over 40x the same three land at chroma 0.19 / 0.07 / 0.21
// — highlights that roll off INTO colour, as the bible asks — while the sun disc
// and sun-on-chrome, which are another half-order up again, still reach white
// and still bloom, because that part of the bible is also non-negotiable.
//
// The knee moved with it, 0.90 -> 0.75. It has to sit just above sunlit diffuse
// white (a 0.18 grey card under the 4.2 key measures ~0.70 scene-linear) so the
// shoulder shapes specular and emission and leaves the key's own falloff alone.
vec3 krHighlightRolloff(vec3 c) {
  float m = max(max(c.r, c.g), c.b);
  float knee = rolloff.x;
  if (m <= knee) return c;
  float mc = knee * pow(m / knee, rolloff.y);
  vec3 scaled = c * (mc / max(m, 1e-5));
  float desat = smoothstep(knee, knee * rolloff.w, m) * rolloff.z;
  return mix(scaled, vec3(dot(scaled, KR_LUMA)), desat);
}

vec3 krRRTODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

// Bit-for-bit the same operator three uses for ACESFilmicToneMapping, so a
// no-post preview and the composed frame agree on exposure and hue shift.
vec3 krToneMap(vec3 c) {
  c *= grade.x / 0.6;
  c = mat3(0.59719, 0.07600, 0.02840,
           0.35458, 0.90834, 0.13383,
           0.04823, 0.01566, 0.83777) * c;
  c = krRRTODTFit(c);
  c = mat3( 1.60475, -0.10208, -0.00327,
           -0.53108,  1.10813, -0.07276,
           -0.07367, -0.00605,  1.07602) * c;
  return clamp(c, 0.0, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec2 fromCentre = uv - 0.5;

  // --- screen-space velocity -----------------------------------------------
  // Unproject this pixel to world space with the current inverse view-proj,
  // then reproject it through last frame's view-proj. Camera-only (no skinned
  // or rigid per-object velocity buffer exists in this project) but it is the
  // camera that swings on a drift exit, which is where blur reads as speed.
  vec4 world = invViewProj * vec4(fromCentre * 2.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;
  vec4 prevClip = prevViewProj * world;
  vec2 prevUv = prevClip.xy / max(prevClip.w, 1e-4) * 0.5 + 0.5;
  vec2 velocity = (uv - prevUv) * lens.w;

  velocity += fromCentre * rush.x;              // arcade zoom-blur under boost

  // --- hero hold-out --------------------------------------------------------
  // The player's kart is rigidly bolted to the camera, so a camera-only
  // reprojection sees its pixels as *static world geometry rushing backwards*
  // and smears the hero subject harder than anything else in frame — at speed
  // the model, its livery and the driver dissolve completely. There is no
  // per-object velocity buffer to solve it properly, so the subject is masked
  // out of the velocity here instead.
  //
  // The mask is a sphere in WORLD space, centred on the kart, and that is the
  // whole point. The previous attempt was a *depth band* driven off the
  // camera-to-kart distance (hold out everything nearer than 1.3x the arm), and
  // it fails for a reason that is easy to miss on a straight and impossible to
  // miss under boost: the chase rig's surge pulls the eye in to about 4.5 m on a
  // boost, so 1.3x the arm is only 1.4 m of clearance — while the kart is 2.1 m
  // long and the camera is looking *down* the length of it. The band therefore
  // cut straight through the model, and because screen-vertical maps to depth
  // under a rig that looks down, it cut horizontally: the helmet, the roll bar
  // and the spoiler (nearest the eye) stayed sharp and the fenders, the nose and
  // the number plate (furthest) took the full streak. That is precisely the
  // half-sharp, half-dissolved kart in shots/r4/boost.png and scenery.png, and
  // no amount of widening fixes it, because the failure is that a scalar depth
  // band cannot describe a 2 m object viewed end-on from 4 m away.
  //
  // Measuring distance from the kart's own centre has none of that geometry in
  // it. The world position is already reconstructed for the reprojection above,
  // so the test costs one subtract and one length. It holds at any arm length, any
  // pitch and any camera mode, and — unlike a depth band — it holds ONLY the
  // kart: a rival two metres to the side sits outside the sphere and keeps its
  // streak, where the depth band was wrongly freezing every kart in the same
  // slice of the frame.
  //
  // The radii are sized off the model. The worst corner of the bodywork is about
  // 1.7 m from the chassis centre of mass (0.87 lateral, 1.05 longitudinal, 1.05
  // to the top of the helmet), so hold.x adds a third of a metre on top of that:
  // a gather needs its *neighbours* masked too, or the road pixels just outside
  // the silhouette pick the kart up along their own streak and drag it outward —
  // the translucent wings hanging off both fenders in the r4 frames. hold.y then
  // releases over another 1.3 m so the tarmac eases back into the streak instead
  // of stepping into it.
  velocity *= smoothstep(hold.x, hold.y, distance(world.xyz, subject));

  float travel = length(velocity);
  // Capped so the fixed tap budget always covers the streak — an unbounded
  // travel with MB_SAMPLES taps turns the dither jitter into visible noise
  // rather than into a smooth blur.
  velocity *= min(travel, 0.016) / max(travel, 1e-5);

#if MB_SAMPLES < 2
  // One tap cannot integrate a streak. The loop below jitters its single tap
  // along the velocity vector, which with one sample is not a blur at all — it
  // is a per-pixel random displacement of up to half the streak length, i.e.
  // roughly +/- 15 px at 1080p at speed. That is what dissolved the tunnel
  // rock, the village roofs, the kerb stripes and the boost-pad chevrons into
  // directional mush in every headless capture (the capture path builds the
  // chain with one tap by design, so it hit every reviewed frame). With no tap
  // budget the honest answer is no blur: keep the aberration, drop the smear.
  velocity = vec2(0.0);
#endif

  // Aberration grows with r^2 so the centre of frame stays clean.
  vec2 fringe = fromCentre * lens.x * (0.35 + dot(fromCentre, fromCentre) * 3.4);
  // ...and is rolled off once the smear gets long. R and B are fetched at a
  // FIXED lateral offset while the tap itself walks along the streak, so the
  // three channels integrate three different sets of specular highlights. Over
  // a calm surface that is invisible; over the grazing sun sheen on the near
  // road it decorrelates the channels and the smear comes out as rainbow
  // speckle rather than a clean radial fringe. Nothing showed this until the
  // hero hold-out replaced the old depth band, because the band had been
  // freezing exactly that stretch of road to zero velocity. A long exposure
  // has no business carrying crisp lateral colour separation anyway.
  // length(velocity) here is post-cap and post-hold-out, so it is 0 on the
  // subject and 0 on the single-tap capture path — both keep full aberration.
  fringe *= 1.0 - 0.75 * smoothstep(0.0, 0.010, length(velocity));

  vec2 lo = texelSize;
  vec2 hi = vec2(1.0) - texelSize;
  // Jitter breaks the tap pattern into noise instead of ghost steps. It only
  // helps once there are taps to spread: with a single tap it *is* the noise.
#if MB_SAMPLES < 2
  float jitter = 0.0;
#else
  float jitter = krHash12(uv * resolution + fract(time) * 311.0) - 0.5;
#endif

  vec3 c = vec3(0.0);
  for (int i = 0; i < MB_SAMPLES; ++i) {
    float k = (float(i) + 0.5 + jitter) / float(MB_SAMPLES) - 0.5;
    vec2 p = uv + velocity * k;
    c.r += texture2D(inputBuffer, clamp(p + fringe, lo, hi)).r;
    c.g += texture2D(inputBuffer, clamp(p, lo, hi)).g;
    c.b += texture2D(inputBuffer, clamp(p - fringe, lo, hi)).b;
  }
  c /= float(MB_SAMPLES);

  // --- display transform ---------------------------------------------------
  // Shoulder first, while there is still headroom to shape: once ACES has run
  // the information is already gone.
  c = krHighlightRolloff(c);
  c = krToneMap(c);

  // Filmic S. smoothstep-toward keeps 0 and 1 pinned, so it adds midtone snap
  // without crushing the shadow detail the AO pass just paid for.
  c = mix(c, c * c * (3.0 - 2.0 * c), grade.y);

  // --- split tone ----------------------------------------------------------
  // Gain alone cannot separate a shadow from the lit surface next to it: a
  // multiply scales toward zero, so the darkest pixels stay exactly the hue
  // they already were and every shadow ends up a darker copy of the key. The
  // lift is what actually moves them — an additive teal offset weighted to the
  // bottom of the curve, which is the ASC-CDL 'offset' term and the reason a
  // graded frame has a cool side at all. Kept small so the blacks tint rather
  // than milk.
  float lum = dot(c, KR_LUMA);
  float shadowW = 1.0 - smoothstep(0.0, 0.55, lum);
  float highW = smoothstep(0.40, 1.0, lum);
  c += shadowLift * shadowW;
  c *= mix(vec3(1.0), coolTint, shadowW * 0.70);
  c *= mix(vec3(1.0), warmTint, highW * 0.55);
  c = max(c, 0.0);

  lum = dot(c, KR_LUMA);
  // Saturation lift, rolled off in the highlights so bloomed chrome and the
  // sun on water go white rather than neon.
  c = max(mix(vec3(lum), c, grade.z * (1.0 - 0.40 * smoothstep(0.70, 1.0, lum))), 0.0);

  // Normalised so 1.0 is the frame corner at any aspect ratio — otherwise the
  // vignette and the streak band drift as the window is resized.
  vec2 aspectVec = vec2(aspect, 1.0);
  float rad = length(fromCentre * aspectVec) / (0.5 * length(aspectVec));

  // --- speed lines ---------------------------------------------------------
  float streakGain = lens.z * rush.y;
  if (streakGain > 0.001) {
    float ang = atan(fromCentre.y, fromCentre.x);
    float n = krValueNoise(ang * 26.0 + time * 1.6) * 0.62
            + krValueNoise(ang * 63.0 - time * 2.4) * 0.38;
    float streak = smoothstep(0.60, 0.97, n);
    // Banded so they live in the outer third: they frame, they don't obscure.
    float band = smoothstep(0.42, 0.95, rad) * (1.0 - smoothstep(1.05, 1.45, rad));
    c += streak * band * streakGain * vec3(1.0, 0.965, 0.900);
  }

  c *= 1.0 - grade.w * smoothstep(0.30, 1.02, rad);

  // Grain last, weighted toward the midtones and shadows like real stock.
  float g = krHash12(uv * resolution * 1.37 + fract(time * 0.37) * 977.0) - 0.5;
  c += g * lens.y * (1.15 - 0.75 * lum);

  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

/** Tuning knobs for {@link GradeEffect}. All in final display-referred terms. */
export interface GradeOptions {
  /** motion-blur taps; 1 disables the blur and leaves plain aberration */
  samples: number;
  exposure: number;
  contrast: number;
  saturation: number;
  vignette: number;
  grain: number;
}

export class GradeEffect extends Effect {
  constructor(opts: GradeOptions) {
    super('KartGrade', GRADE_FRAGMENT, {
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      defines: new Map([['MB_SAMPLES', String(Math.max(1, Math.round(opts.samples)))]]),
      uniforms: new Map<string, THREE.Uniform>([
        ['prevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['invViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['grade', new THREE.Uniform(
          new THREE.Vector4(opts.exposure, opts.contrast, opts.saturation, opts.vignette))],
        ['lens', new THREE.Uniform(new THREE.Vector4(0.0007, opts.grain, 0.15, 0.0))],
        ['rush', new THREE.Uniform(new THREE.Vector2(0, 0))],
        ['subject', new THREE.Uniform(new THREE.Vector3())],
        // Released until `sync` finds a player kart: with a negative outer
        // radius the smoothstep returns 1 everywhere and nothing is held.
        ['hold', new THREE.Uniform(new THREE.Vector2(-2, -1))],
        // Teal-leaning shadows / warm highlights, both near-luminance-neutral.
        // The cool side leans on green as well as blue: a purely blue shadow
        // against a #ffd9a8 key reads as violet, which is the exact hue the
        // frame already has too much of. Teal is what separates it.
        ['coolTint', new THREE.Uniform(new THREE.Vector3(0.815, 0.985, 1.155))],
        ['warmTint', new THREE.Uniform(new THREE.Vector3(1.115, 1.005, 0.878))],
        // Additive teal lift on the bottom of the curve — art bible §2 asks for
        // a #a8c8ff sky fill in the shadows, and nothing multiplicative can
        // produce it. Sized to sit just above the noise floor of an 8-bit write.
        ['shadowLift', new THREE.Uniform(new THREE.Vector3(-0.0015, 0.0035, 0.0092))],
        // Highlight shoulder: knee just above sunlit diffuse white, then
        // x^0.30 above it, with only a light pull toward luminance so a hot
        // colour stays a colour until it is genuinely an order of magnitude
        // over. See krHighlightRolloff.
        ['rolloff', new THREE.Uniform(new THREE.Vector4(0.75, 0.30, 0.14, 40.0))],
      ]),
    });
  }

  get grade(): THREE.Vector4 { return this.uniforms.get('grade')!.value; }
  get lens(): THREE.Vector4 { return this.uniforms.get('lens')!.value; }
  get rush(): THREE.Vector2 { return this.uniforms.get('rush')!.value; }
  get subject(): THREE.Vector3 { return this.uniforms.get('subject')!.value; }
  get hold(): THREE.Vector2 { return this.uniforms.get('hold')!.value; }
  get prevViewProj(): THREE.Matrix4 { return this.uniforms.get('prevViewProj')!.value; }
  get invViewProj(): THREE.Matrix4 { return this.uniforms.get('invViewProj')!.value; }
}

// ---------------------------------------------------------------------------
// Scratch — nothing below allocates once the chain is built.
// ---------------------------------------------------------------------------
const _viewProj = new THREE.Matrix4();
const _dofTarget = new THREE.Vector3();

/** How aggressively speedIntensity is allowed to move the lens, per tier. */
const CA_REST = 0.0007;  // ~0.0004 uv of separation at the frame edge
const CA_BOOST = 0.0032; // ~0.0018 uv at the frame edge

/**
 * Radius around the player kart's centre of mass, in metres, inside which the
 * reprojection blur is switched off completely, and the radius at which it is
 * fully back. See the hero hold-out block in GRADE_FRAGMENT for the sizing.
 *
 * These are world units, so they do not care how long the chase arm is, which
 * is the entire reason this replaced a depth band.
 */
const SUBJECT_HOLD = 2.05;
const SUBJECT_FADE = 3.40;

export interface PostFXOptions {
  /** true when we detected a software rasteriser (headless capture / CI) */
  software: boolean;
}

/**
 * Builds and drives the effect chain. One instance lives for the lifetime of
 * the pipeline; `build()` may be called repeatedly as quality settings change.
 */
export class PostFX {
  grade: GradeEffect | null = null;
  bloom: BloomEffect | null = null;
  dof: DepthOfFieldEffect | null = null;
  smaa: SMAAEffect | null = null;
  /** N8AOPostPass — untyped, the package has no declarations. */
  ao: any = null;

  private passes: Pass[] = [];
  private gradePass: EffectPass | null = null;
  private speed = 0;
  private primed = false;
  /** last frame's view-projection, kept out of the uniform so we can rotate it */
  private readonly lastViewProj = new THREE.Matrix4();

  build(ctx: Ctx, composer: EffectComposer, opts: PostFXOptions): void {
    this.dispose();

    const s = ctx.settings;
    const q = s.quality;
    const high = q >= Quality.High;

    const renderPass = new RenderPass(ctx.scene, ctx.camera);
    this.add(composer, renderPass);

    // --- ambient occlusion -------------------------------------------------
    if (s.ssao) {
      const ao = new N8AOPostPass(ctx.scene, ctx.camera, ctx.width, ctx.height);
      const cfg = ao.configuration;
      // A short world-space radius keeps the darkening where contact actually
      // happens (tyre/tarmac, kerb/road, planter/pavement). Large radii are
      // what produce the flat grey haze that gives cheap AO away.
      cfg.aoRadius = 1.5;
      cfg.distanceFalloff = 1.0;
      // N8AO's `intensity` is the exponent on the visibility term, so it is the
      // only knob that changes how *dark* contact gets. Measured against this
      // stack on a kart-sized box on tarmac: at 3.0 the road under the chassis
      // came out 29% below open road and the tyre contact strip 8% below, which
      // is inside the noise of a frame this bright — the art directors read it
      // as "no AO at all" and they were right to. 5.0 doubles both (44% / 19%),
      // which is the shipped-kart-racer look, and it costs nothing: the sample
      // count is unchanged.
      cfg.intensity = q >= Quality.Ultra ? 5.4 : 5.0;
      cfg.aoSamples = high ? 16 : 8;
      cfg.denoiseSamples = 8;
      // A 6-texel poisson denoise at half res is a 12-pixel blur, which is
      // wider than the contact band it is supposed to be cleaning up and turns
      // a tyre patch into a smudge. Tighter, and one iteration at High — the
      // second buys smoothness the tyre contact does not want.
      cfg.denoiseRadius = 3;
      cfg.denoiseIterations = q >= Quality.Ultra ? 2 : 1;
      // Occlusion tinted toward the sky fill instead of black — the art bible
      // forbids pure-black shadow, and cool crevices sit right next to the
      // warm key light.
      cfg.color = new THREE.Color(0x101c2a);
      cfg.colorMultiply = true;
      cfg.screenSpaceRadius = false;
      cfg.depthAwareUpsampling = true;
      cfg.halfRes = q < Quality.Ultra;
      cfg.accumulate = false;
      cfg.neuralDenoise = false;
      // The auto-detect walks the entire scene graph every single frame.
      ao.autoDetectTransparency = false;
      cfg.transparencyAware = false;
      this.ao = ao;
      this.add(composer, ao);
    }

    // --- depth of field ----------------------------------------------------
    if (s.dof) {
      // Garnish only: a long focus range means the road, the kerbs and the
      // next two corners stay razor sharp and only the bay and the headland
      // soften. bokehScale stays small for the same reason.
      const dof = new DepthOfFieldEffect(ctx.camera, {
        focusDistance: 9,
        focusRange: 60,
        bokehScale: 1.25,
        resolutionScale: 0.5,
      });
      dof.target = _dofTarget.set(0, 0, 0);
      this.dof = dof;
      this.add(composer, new EffectPass(ctx.camera, dof));
    }

    // --- bloom -------------------------------------------------------------
    if (s.bloom) {
      // Threshold sits above diffuse white on purpose: only the sun on chrome,
      // the water sparkle, drift sparks and boost flame clear it. A low
      // threshold is what turns a frame milky.
      //
      // It is measured on the SCENE-LINEAR buffer, not on display values, and
      // that is where 0.9 went wrong: with exposure 1.05 through ACES a linear
      // 0.9 lands around 0.6 on screen, i.e. below every lit road surface, wall
      // and kerb in the game. The whole frame was above threshold, so bloom
      // welded the sun-facing tarmac into the sky and ate the vanishing point,
      // the roof ridges and the boost chevrons. 2.0 linear is just past display
      // white, which is what "above diffuse white" was always supposed to mean;
      // chrome, water sparkle, sparks and flame sit an order of magnitude above
      // it and still bloom exactly as the art bible requires.
      const bloom = new BloomEffect({
        // ADD, not SCREEN: the buffer is scene-linear HDR, and screen blending
        // values above 1 actually *darkens* them. Bloom is light being added.
        blendFunction: BlendFunction.ADD,
        luminanceThreshold: 2.0,
        luminanceSmoothing: 0.32,
        mipmapBlur: true,
        // Slightly hotter to pay back the pixels the higher threshold removed:
        // fewer sources, each allowed to glow harder.
        intensity: 0.88,
        // Wide and soft — a big mip chain with a high radius reads as a lens,
        // a small one reads as a glow filter. One level down at High: the top
        // mip of an eight-level chain is a quarter-frame halo, which is what
        // let a single blown highlight bleed across the whole horizon.
        radius: 0.74,
        levels: high ? 7 : 6,
      });
      this.bloom = bloom;
      this.add(composer, new EffectPass(ctx.camera, bloom));
    }

    // --- merged grade / lens ----------------------------------------------
    // Software rasterisers pay for every tap, and a headless capture is a
    // still frame anyway — one tap keeps the aberration and drops the blur.
    // (The shader honours that literally now: below two taps it zeroes the
    // velocity instead of stochastically displacing the single tap.)
    const samples = !s.motionBlur || opts.software ? 1 : (high ? 6 : 4);
    const grade = new GradeEffect({
      samples,
      exposure: 1.05,
      contrast: 0.18,
      saturation: 1.12,
      vignette: 0.22,
      grain: 0.012,
    });
    this.grade = grade;
    this.gradePass = new EffectPass(ctx.camera, grade);
    this.add(composer, this.gradePass);

    // --- resolve -----------------------------------------------------------
    const smaa = new SMAAEffect({
      // Low tier runs without MSAA, so SMAA has to carry the whole edge budget.
      preset: high ? SMAAPreset.ULTRA : SMAAPreset.HIGH,
      edgeDetectionMode: EdgeDetectionMode.COLOR,
    });
    this.smaa = smaa;
    const smaaPass = new EffectPass(ctx.camera, smaa);
    // Ordered dither on the final 8-bit write; without it the sky gradient
    // bands, which section 9 of the art bible calls out by name.
    smaaPass.dithering = true;
    this.add(composer, smaaPass);

    this.primed = false;
  }

  /**
   * Per-frame uniform sync. Called immediately before `composer.render()`, so
   * the camera has already been placed by ChaseCamera.lateUpdate.
   */
  sync(ctx: Ctx, dt: number): void {
    const grade = this.grade;
    if (grade === null) return;

    const camera = ctx.camera;

    // The renderer will do this again in a moment, but we need this frame's
    // view matrix *now* — otherwise the velocity we compute lags the depth
    // buffer we compute it against by a frame.
    camera.updateMatrixWorld();

    // Reprojection matrices. On the first frame after a (re)build there is no
    // history, so seed it with the current transform and blur nothing.
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.primed) {
      this.lastViewProj.copy(_viewProj);
      this.primed = true;
    }
    grade.invViewProj.copy(_viewProj).invert();
    grade.prevViewProj.copy(this.lastViewProj);
    this.lastViewProj.copy(_viewProj);

    // Ease the speed signal so a boost pad does not snap the lens.
    const target = THREE.MathUtils.clamp(ctx.speedIntensity, 0, 1);
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / 0.11));
    const speed = this.speed;

    // Shutter is normalised against a 60 Hz frame so the blur length is a
    // function of how fast the world moves, not of how fast we happen to run.
    const shutter = ctx.settings.motionBlur
      ? 0.5 * THREE.MathUtils.clamp(1 / 60 / Math.max(dt, 1e-4), 0.2, 2)
      : 0;

    const lens = grade.lens;
    lens.x = CA_REST + (CA_BOOST - CA_REST) * speed;
    lens.w = shutter;

    const rush = grade.rush;
    // Zoom-blur only exists where there are taps to spend on it.
    rush.x = shutter > 0 ? 0.018 * speed * speed : 0;
    // Streaks stay off until roughly 70% of top speed, per the art bible.
    rush.y = THREE.MathUtils.smoothstep(speed, 0.42, 1.0);

    // Keep `time` in a range where fract() still has bits left for the grain.
    const pass = this.gradePass as any;
    if (pass !== null && pass.fullscreenMaterial.time > 600) pass.fullscreenMaterial.time = 0;

    if (this.bloom !== null) {
      // A touch more glow under boost; the flame and the sparks are the payload.
      this.bloom.intensity = 0.88 + 0.22 * speed;
    }

    const player = ctx.race?.player;

    // Park the hold-out sphere on the hero kart. Nothing here is derived from
    // the camera: the arm length, the rig's pitch and the camera mode all move
    // the kart around the frame and around the depth range, and none of them
    // move it relative to itself.
    const hold = grade.hold;
    if (player !== undefined && player !== null) {
      grade.subject.copy(player.position);
      hold.set(SUBJECT_HOLD, SUBJECT_FADE);
    } else {
      // No subject to protect — release the mask and let the whole frame blur.
      hold.set(-2, -1);
    }

    if (this.dof !== null) {
      if (player !== undefined && player !== null) {
        _dofTarget.copy(player.position);
        this.dof.target = _dofTarget;
      } else {
        this.dof.target = null;
      }
    }
  }

  dispose(): void {
    for (const pass of this.passes) pass.dispose();
    this.passes.length = 0;
    this.grade = null;
    this.bloom = null;
    this.dof = null;
    this.smaa = null;
    this.ao = null;
    this.gradePass = null;
  }

  /** Registers a pass with the composer and tracks it for disposal. */
  private add(composer: EffectComposer, pass: Pass): void {
    composer.addPass(pass);
    this.passes.push(pass);
  }
}
