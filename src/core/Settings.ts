import { Quality, type Settings } from '../types';

function detectQuality(): Quality {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return Quality.Low;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : '') || '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return Quality.Medium;
  // Software rasterisers (SwiftShader / llvmpipe / ANGLE-on-CPU) show up in CI
  // and headless captures; they cannot take the full pipeline at speed but we
  // still want the full *look*, so they get High rather than Low.
  if (/SwiftShader|llvmpipe|Software|Microsoft Basic/i.test(name)) return Quality.High;
  if (/Apple M[0-9]|RTX|Radeon RX|Arc A/i.test(name)) return Quality.Ultra;
  return Quality.High;
}

const PRESETS: Record<Quality, Omit<Settings, 'quality' | 'masterVolume'>> = {
  [Quality.Low]: {
    maxPixelRatio: 1, shadows: false, ssao: false, bloom: true, motionBlur: false,
    dof: false, renderScale: 0.85, volumetrics: false, reflections: false,
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

export function createSettings(): Settings {
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const q: Quality = forced
    ? ({ low: Quality.Low, medium: Quality.Medium, high: Quality.High, ultra: Quality.Ultra }[forced] ??
       Quality.High)
    : detectQuality();
  const s: Settings = { quality: q, masterVolume: 0.8, ...PRESETS[q] };
  // ?scale=0.75 etc. lets the screenshot harness trade resolution for time
  const scale = parseFloat(params.get('scale') || '');
  if (Number.isFinite(scale) && scale > 0) s.renderScale = scale;
  return s;
}
