import { Quality, type Settings } from '../types';
import { setTextureBudget } from '../render/Textures';

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

function detectQuality(dev: DeviceProfile): Quality {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return Quality.Low;

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

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : '') || '';
  // Software rasterisers (SwiftShader / llvmpipe / ANGLE-on-CPU) show up in CI
  // and headless captures; they cannot take the full pipeline at speed but we
  // still want the full *look*, so they get High rather than Low.
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic/i.test(name)) return Quality.High;
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
