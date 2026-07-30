import { Quality, type Settings } from '../types';
import { setTextureBudget } from '../render/Textures';
import { logPipeline } from './Diagnostics';

/**
 * ===========================================================================
 *  Device classification
 * ===========================================================================
 *  This used to be `/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)`.
 *  That test is wrong in the one way that matters most: iPadOS Safari defaults
 *  to "Request Desktop Website" and reports a *Macintosh* user agent with no
 *  iPad token anywhere in it. The same mistake has already bitten the touch
 *  controls in this project once. An iPad falling through to the desktop GPU
 *  sniff below reports an Apple GPU string and is handed Ultra, which on a
 *  device with a shared memory pool is an instant jetsam kill.
 *
 *  So the UA is used only as corroboration, never as the deciding signal. The
 *  signals that actually describe the hardware are:
 *
 *    pointer: coarse / hover: none  — the browser telling us the primary input
 *                                     is a finger. True on every phone and
 *                                     tablet including desktop-mode iPadOS.
 *    navigator.maxTouchPoints       — non-zero on iPadOS in desktop mode; zero
 *                                     on a Mac, trackpad and Touch Bar alike.
 *    screen.width/height            — CSS pixels of the panel, which separates
 *                                     a phone from a tablet far more reliably
 *                                     than any device name.
 *    deviceMemory / hardwareConcurrency — where the browser offers them, a
 *                                     direct read on the memory ceiling we are
 *                                     actually budgeting against.
 *
 *  A touch laptop (Surface, some Chromebooks) reports coarse pointer *and* a
 *  large screen *and* plenty of cores, so it lands on the desktop path, which
 *  is the intent.
 * ===========================================================================
 */

function mql(q: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(q).matches;
}

interface NavExtras {
  maxTouchPoints?: number;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  userAgentData?: { mobile?: boolean };
}

export interface DeviceProfile {
  /** primary input is a finger — phone or tablet, including desktop-mode iPadOS */
  touchPrimary: boolean;
  /** touch device whose panel is phone-sized; the tightest memory ceiling we ship to */
  handheld: boolean;
  /** GB of RAM if the browser will say, else 0 */
  memoryGB: number;
  cores: number;
  /** shortest edge of the panel in CSS pixels */
  minEdge: number;
  dpr: number;
}

export function profileDevice(): DeviceProfile {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & NavExtras;
  const touchPoints = nav.maxTouchPoints ?? 0;
  const coarse = mql('(pointer: coarse)') || mql('(any-pointer: coarse)');
  const noHover = mql('(hover: none)');
  const uaMobile = nav.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile Safari|Silk/i.test(nav.userAgent || '');

  // Two independent signals must agree, so a desktop browser that happens to
  // report a coarse pointer (a plugged-in tablet, a remote session) does not
  // get demoted, and an iPad in desktop mode — coarse + 5 touch points — does.
  const touchPrimary = ((coarse || noHover) && touchPoints > 0) ||
    (uaMobile && (coarse || noHover || touchPoints > 0));

  const sw = typeof screen !== 'undefined' ? screen.width || 0 : 0;
  const sh = typeof screen !== 'undefined' ? screen.height || 0 : 0;
  const minEdge = Math.min(sw || 9999, sh || 9999);
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const memoryGB = nav.deviceMemory ?? 0;
  const cores = nav.hardwareConcurrency ?? 0;

  // 500 CSS px of short edge is comfortably above every phone in landscape
  // (iPhone 15 Pro Max is 430) and comfortably below every tablet (iPad mini is
  // 744). A "large" phone and a "small" tablet do not overlap here.
  const handheld = touchPrimary && (minEdge <= 500 || (memoryGB > 0 && memoryGB <= 4));

  return { touchPrimary, handheld, memoryGB, cores, minEdge, dpr };
}

/**
 * ===========================================================================
 *  GPU capability probe — what the driver DOES, not what it SAYS.
 * ===========================================================================
 *  Several players on Brave / Edge / Chrome get a live HUD over an empty
 *  world while the identical build runs fine elsewhere. Nobody has ever sent a
 *  dump, so the fix has to be written blind, and writing it blind means never
 *  taking a capability on trust again.
 *
 *  Every check below is an EXPERIMENT, because every one of them has a cheaper
 *  version that lies:
 *
 *    - `getExtension('EXT_color_buffer_half_float') !== null` is what the
 *      pipeline used to decide the composer's buffer format on. The extension
 *      string is a promise about a format, not about an ATTACHMENT: a driver
 *      can advertise it and still refuse the framebuffer, and when it does the
 *      refusal is silent — every draw into that target is discarded and the
 *      canvas is exactly, uniformly black. Simulated (attachment silently
 *      refused after the extension said yes) the game today submits 222 draw
 *      calls into a canvas that is never painted, with no error anywhere. So
 *      the probe builds the attachment and asks `checkFramebufferStatus`.
 *
 *    - "the GPU runs WebGL2, so it runs our shaders" is the leading theory's
 *      exact mistake. A trial program with the shape of a real material —
 *      GLSL ES 3.00, a struct-array light loop, derivatives, textureLod, a
 *      full varying set — is compiled AND linked here, and `getShaderInfoLog`
 *      is kept whether or not it failed, because that log is the bug report
 *      that has never arrived.
 *
 *  One context, probed once, memoised: `RenderPipeline` reads the same record
 *  rather than opening a second throwaway context (browsers cap live contexts
 *  at around sixteen, and we were spending two of them before the game began).
 * ===========================================================================
 */
export interface GLCapabilities {
  /** a WebGL2 context could be created at all — false means the game cannot run */
  webgl2: boolean;
  /** the extension string claims a renderable float colour buffer */
  halfFloatExtension: boolean;
  /** an RGBA16F colour attachment was built, reported COMPLETE and cleared */
  halfFloatRenderable: boolean;
  /** the same, for the 8-bit fallback the composer drops to */
  byteRenderable: boolean;
  /** float textures can be sampled with linear filtering (PMREM, AO) */
  floatLinear: boolean;
  /** a representative GLSL ES 3.00 program compiled and linked */
  trialProgram: boolean;
  /** whatever the driver said about it — empty on success */
  trialLog: string;
  maxTextureSize: number;
  maxRenderbufferSize: number;
  maxSamples: number;
  vendor: string;
  renderer: string;
  /** SwiftShader / llvmpipe / ANGLE-on-CPU, i.e. a headless capture or CI */
  software: boolean;
}

/**
 * Forced failures, for the fallback tests. `?glfail=halffloat,composer,...`
 *
 * Only two of the five conditions this round has to survive can be forced from
 * outside the app (`getContext` and `getExtension` are patchable from the
 * page); the rest are internal, and a fallback that has never been executed is
 * decoration. Parsed once, empty in normal play, and every consumer of it is a
 * single `has()` on a Set that is empty on every real device.
 */
const FORCED_FAILURES: ReadonlySet<string> = new Set(
  (typeof location !== 'undefined'
    ? (new URLSearchParams(location.search).get('glfail') || '')
    : '').split(',').map((s) => s.trim()).filter(Boolean),
);

export function forcedFailure(name: string): boolean {
  return FORCED_FAILURES.has(name);
}

/**
 * Empties the GL error queue so the next check reads its OWN result.
 *
 * BOUNDED, and that bound is load-bearing rather than defensive: `getError`
 * normally clears the flag it returns, so the obvious `while` terminates — but
 * a context in the LOST state returns `CONTEXT_LOST_WEBGL` on every call
 * forever, and a lost context is exactly the situation this code exists to
 * survive. An unbounded drain there hangs the tab, which is a worse failure
 * than the one being diagnosed.
 */
export function drainErrors(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  for (let i = 0; i < 16; i++) {
    if (gl.getError() === gl.NO_ERROR) return;
  }
}

/**
 * Builds a colour attachment of the given format and asks the driver whether
 * it would actually render into it. Returns false on anything short of
 * FRAMEBUFFER_COMPLETE with a clean error queue after a real clear.
 */
function attachmentWorks(
  gl: WebGL2RenderingContext, internalFormat: number, format: number, type: number,
): boolean {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let ok = false;
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 8, 8, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    ok = status === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      // Completeness is necessary and not sufficient — clear it and make sure
      // the driver did not raise on the way.
      drainErrors(gl);
      gl.viewport(0, 0, 8, 8);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      ok = gl.getError() === gl.NO_ERROR;
    }
  } catch {
    ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  return ok;
}

/**
 * A trial program shaped like the materials this game actually ships: a
 * struct-array light loop, derivatives, textureLod, a tangent frame and a full
 * varying set. If a driver is going to reject the PBR family — the leading
 * theory for the empty-world reports — it rejects this too, and it says why.
 */
const TRIAL_VERT = `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vNormal;
out vec3 vView;
out vec2 vUv;
out vec4 vShadowCoord;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  vShadowCoord = mv;
  gl_Position = projectionMatrix * mv;
}`;

const TRIAL_FRAG = `#version 300 es
precision highp float;
precision highp int;
struct TrialLight { vec3 direction; vec3 color; };
uniform TrialLight trialLights[4];
uniform sampler2D trialMap;
uniform sampler2D trialNormalMap;
uniform float trialRoughness;
in vec3 vNormal;
in vec3 vView;
in vec2 vUv;
in vec4 vShadowCoord;
out vec4 fragColor;
vec3 trialTangentNormal(vec3 n) {
  vec3 q0 = dFdx(vView), q1 = dFdy(vView);
  vec2 st0 = dFdx(vUv), st1 = dFdy(vUv);
  vec3 t = normalize(q0 * st1.t - q1 * st0.t);
  vec3 b = normalize(cross(n, t));
  vec3 m = texture(trialNormalMap, vUv).xyz * 2.0 - 1.0;
  return normalize(mat3(t, b, n) * m);
}
void main() {
  vec3 n = trialTangentNormal(normalize(vNormal));
  vec3 v = normalize(vView);
  vec3 base = textureLod(trialMap, vUv, 1.0).rgb;
  float rough = clamp(trialRoughness + fwidth(vUv.x), 0.04, 1.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; ++i) {
    vec3 l = normalize(trialLights[i].direction);
    vec3 h = normalize(l + v);
    float a = rough * rough;
    float d = max(dot(n, h), 0.0);
    float ggx = a * a / max(3.14159 * pow(d * d * (a * a - 1.0) + 1.0, 2.0), 1e-4);
    sum += trialLights[i].color * (max(dot(n, l), 0.0) * base + ggx);
  }
  sum += base * 0.02 * vShadowCoord.w;
  fragColor = vec4(sum, 1.0);
}`;

function trialCompile(gl: WebGL2RenderingContext): { ok: boolean; log: string } {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  const logs: string[] = [];
  let ok = false;
  try {
    if (vs === null || fs === null || prog === null) return { ok: false, log: 'could not create shader objects' };
    gl.shaderSource(vs, TRIAL_VERT);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) logs.push('vertex: ' + (gl.getShaderInfoLog(vs) || 'failed'));
    gl.shaderSource(fs, TRIAL_FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) logs.push('fragment: ' + (gl.getShaderInfoLog(fs) || 'failed'));
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    ok = gl.getProgramParameter(prog, gl.LINK_STATUS) === true && logs.length === 0;
    if (!ok) logs.push('link: ' + (gl.getProgramInfoLog(prog) || 'failed'));
  } catch (err) {
    logs.push('threw: ' + String(err));
    ok = false;
  }
  if (vs !== null) gl.deleteShader(vs);
  if (fs !== null) gl.deleteShader(fs);
  if (prog !== null) gl.deleteProgram(prog);
  return { ok, log: ok ? '' : logs.join('\n').slice(0, 900) };
}

const NO_GL: GLCapabilities = {
  webgl2: false, halfFloatExtension: false, halfFloatRenderable: false, byteRenderable: false,
  floatLinear: false, trialProgram: false, trialLog: 'no WebGL2 context',
  maxTextureSize: 0, maxRenderbufferSize: 0, maxSamples: 0,
  vendor: 'unknown', renderer: 'unknown', software: false,
};

let caps: GLCapabilities | null = null;

/** The one capability record. Probed on first call, then memoised. */
export function glCapabilities(): GLCapabilities {
  if (caps !== null) return caps;
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    gl = forcedFailure('webgl2')
      ? null
      : canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl === null) {
    caps = { ...NO_GL };
    logPipeline('probe', 'no WebGL2 context — the game cannot render');
    return caps;
  }

  // The extension has to be REQUESTED before RGBA16F is colour-renderable, so
  // this call is part of the experiment and not merely a question.
  const halfExt = forcedFailure('halffloat')
    ? false
    : gl.getExtension('EXT_color_buffer_half_float') !== null ||
      gl.getExtension('EXT_color_buffer_float') !== null;

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const vendor = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : '';

  const halfRenderable = halfExt &&
    !forcedFailure('halffloat') &&
    attachmentWorks(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  const byteRenderable = attachmentWorks(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const trial = forcedFailure('material')
    ? { ok: false, log: 'forced by ?glfail=material' }
    : trialCompile(gl);

  caps = {
    webgl2: true,
    halfFloatExtension: halfExt,
    halfFloatRenderable: halfRenderable,
    byteRenderable,
    floatLinear: gl.getExtension('OES_texture_float_linear') !== null,
    trialProgram: trial.ok,
    trialLog: trial.log,
    maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 0,
    maxRenderbufferSize: (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 0,
    maxSamples: (gl.getParameter(gl.MAX_SAMPLES) as number) || 0,
    vendor,
    renderer,
    software: /SwiftShader|llvmpipe|Software|Microsoft Basic|Mesa OffScreen|ANGLE \(Software/i.test(renderer),
  };

  // Everything that is not the happy path is written down, because the next
  // person to see it will be reading a console paste from a stranger.
  if (halfExt && !halfRenderable) {
    logPipeline('probe', 'EXT_color_buffer_half_float is advertised but an RGBA16F ' +
      'attachment is NOT complete — falling back to an 8-bit composer buffer');
  } else if (!halfExt) {
    logPipeline('probe', 'no renderable float colour buffer — 8-bit composer buffer');
  }
  if (!byteRenderable) logPipeline('probe', 'even an RGBA8 attachment is incomplete — off-screen targets are unusable');
  if (!trial.ok) logPipeline('probe', 'a representative material FAILED to compile/link: ' + trial.log);

  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return caps;
}

function detectQuality(dev: DeviceProfile): Quality {
  const gl = glCapabilities();
  if (!gl.webgl2) return Quality.Low;

  // A phone gets Low, and that is a deliberate change from the Medium this used
  // to hand out. Medium leaves shadows, motion blur and full-resolution render
  // targets on, and measured at 220 MB of texture memory against a budget of
  // 80 — the reported "crashes after ten seconds" on a real device. A 390 CSS-px
  // panel does not need any of it.
  if (dev.handheld) return Quality.Low;
  if (dev.touchPrimary) {
    // Tablet. More thermal and memory headroom than a phone, nowhere near a
    // discrete GPU. Weak ones (<= 4 cores, <= 4 GB) drop to Low with the phones.
    const weak = (dev.cores > 0 && dev.cores <= 4) || (dev.memoryGB > 0 && dev.memoryGB <= 4);
    return weak ? Quality.Low : Quality.Medium;
  }

  const name = gl.renderer;
  // Software rasterisers (SwiftShader / llvmpipe / ANGLE-on-CPU) show up in CI
  // and headless captures; they cannot take the full pipeline at speed but we
  // still want the full *look*, so they get High rather than Low.
  if (gl.software) return Quality.High;
  if (/Apple M[0-9]|RTX|Radeon RX|Arc A/i.test(name)) return Quality.Ultra;
  return Quality.High;
}

/**
 * Maximum texture edge length per tier, in texels.
 *
 * High and Ultra are set at or above the largest texture the game authors
 * (2048, the sign atlas), so the desktop look is bit-for-bit what it was. The
 * cap only ever bites on the two tiers a touch device can reach.
 *
 * The art bible's "minimum 1024² for anything the camera gets within 5 m of"
 * is a desktop standard and is met on the desktop tiers. THE MOBILE CLAUSE:
 * on a handheld, 1024² over a 3.5 m tile is 290 texels per metre against a
 * panel that is 390 CSS px tall — the texel density is an order of magnitude
 * past the pixel density, so every one of those texels is resolved by a mip
 * the hardware builds and then never samples the top of. 256² is the honest
 * number there, and it is the difference between a game and a crash.
 */
const TEXTURE_CAP: Record<Quality, number> = {
  [Quality.Low]: 256,
  [Quality.Medium]: 512,
  [Quality.High]: 2048,
  [Quality.Ultra]: Infinity,
};

const PRESETS: Record<Quality, Omit<Settings, 'quality' | 'masterVolume'>> = {
  [Quality.Low]: {
    // A phone at devicePixelRatio 3 rendering at renderScale 1 is drawing nine
    // times the pixels of its own CSS layout. Capping the ratio at 1 and taking
    // another 30% off is the single cheapest frame-time and bandwidth win on the
    // device, and at this panel size it is very hard to see.
    maxPixelRatio: 1, shadows: false, ssao: false, bloom: true, motionBlur: false,
    dof: false, renderScale: 0.7, volumetrics: false, reflections: false,
    particleDensity: 0.35, foliageDensity: 0.3,
  },
  [Quality.Medium]: {
    maxPixelRatio: 1.5, shadows: true, ssao: false, bloom: true, motionBlur: true,
    dof: false, renderScale: 1, volumetrics: false, reflections: false,
    particleDensity: 0.6, foliageDensity: 0.6,
  },
  [Quality.High]: {
    maxPixelRatio: 2, shadows: true, ssao: true, bloom: true, motionBlur: true,
    dof: true, renderScale: 1, volumetrics: true, reflections: true,
    particleDensity: 1, foliageDensity: 1,
  },
  [Quality.Ultra]: {
    maxPixelRatio: 2, shadows: true, ssao: true, bloom: true, motionBlur: true,
    dof: true, renderScale: 1, volumetrics: true, reflections: true,
    particleDensity: 1.4, foliageDensity: 1.35,
  },
};

let deviceProfile: DeviceProfile | null = null;

/** The classification `createSettings()` used. Systems may read it; none may write it. */
export function device(): DeviceProfile {
  return (deviceProfile ??= profileDevice());
}

export function createSettings(): Settings {
  const dev = (deviceProfile = profileDevice());
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const q: Quality = forced
    ? ({ low: Quality.Low, medium: Quality.Medium, high: Quality.High, ultra: Quality.Ultra }[forced] ??
       Quality.High)
    : detectQuality(dev);
  const s: Settings = { quality: q, masterVolume: 0.8, ...PRESETS[q] };
  // ?scale=0.75 etc. lets the screenshot harness trade resolution for time
  const scale = parseFloat(params.get('scale') || '');
  if (Number.isFinite(scale) && scale > 0) s.renderScale = scale;

  // ---- capability-driven degrade, before the first frame ------------------
  // Nothing below fires on hardware that passes the probe, so the desktop path
  // is untouched; every branch is a driver that has already told us it cannot
  // do the thing, and the alternative to acting on that is a black screen.
  const gl = glCapabilities();
  if (gl.webgl2 && !gl.halfFloatRenderable) {
    // N8AO allocates half-float depth/normal/AO targets of its own, and the
    // pipeline cannot see inside them. On a device that cannot render to a
    // float attachment those targets are incomplete, the pass composites over
    // undefined contents, and the result is the dark frame this whole round is
    // about. Measured with the float extensions withheld: the composed frame
    // came back 91% below display luma 12, against 9% on the same machine with
    // them present. Dropping the pass costs contact shadowing; keeping it costs
    // the picture.
    if (s.ssao) {
      s.ssao = false;
      logPipeline('settings', 'ambient occlusion off: this GPU cannot render to a float buffer');
    }
    // The bloom mip chain is 8-bit here too, so a high threshold has less to
    // work with; that is a look change, not a failure, and it stays.
  }
  // A rasteriser that cannot even complete an RGBA8 attachment has no
  // off-screen rendering at all: no composer, no AO, no shadow maps.
  if (gl.webgl2 && !gl.byteRenderable) {
    s.ssao = false;
    s.bloom = false;
    s.dof = false;
    s.motionBlur = false;
    s.shadows = false;
    logPipeline('settings', 'no usable off-screen targets: post-processing and shadows disabled');
  }
  if (gl.webgl2 && !gl.trialProgram) {
    // The representative material did not compile. Everything the world is made
    // of is that family, so the safest thing we can still do at THIS layer is
    // stop asking for the most shader-heavy tier; RenderPipeline takes it from
    // here with a simpler material variant.
    s.shadows = false;
    s.ssao = false;
    logPipeline('settings', 'trial material did not compile: shadows and AO disabled');
  }

  // Install the process-wide texture cap before any system exists, let alone
  // builds a texture. `createSettings()` is evaluated at module scope in
  // main.ts, which is the earliest point in the program that knows the tier.
  //
  // The belt-and-braces `handheld` clamp is deliberate: a phone that somehow
  // reaches Medium — a forced `?quality=medium`, a future tweak to the tier
  // rules, a device this classifier has not met — still gets the 256 cap.
  // Guessing high on a phone is the failure that kills the tab, so the cap is
  // pinned to the hardware and not only to the preset.
  let cap = TEXTURE_CAP[q];
  if (dev.handheld) cap = Math.min(cap, TEXTURE_CAP[Quality.Low]);
  else if (dev.touchPrimary) cap = Math.min(cap, TEXTURE_CAP[Quality.Medium]);
  // `?texcap=512`, or `?texcap=0` for uncapped. A diagnostic only — it is how
  // the before/after of this budget is measured on one tree — and it sits
  // alongside `?quality=` and `?scale=` as harness-only overrides.
  const forcedCap = parseFloat(params.get('texcap') || '');
  if (Number.isFinite(forcedCap)) cap = forcedCap > 0 ? forcedCap : Infinity;
  setTextureBudget(cap);

  return s;
}
