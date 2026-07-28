/**
 * ============================================================================
 *  Self-diagnosis for "the HUD works but the world is missing".
 * ============================================================================
 *  Reported by several players on Chromium browsers while the same build runs
 *  fine elsewhere. The screenshot shows a live HUD — timer counting, minimap
 *  drawing, standings updating — over a flat dark page background. So the game
 *  loop is running and only the 3D scene is absent, which is a rendering
 *  failure, not a crash.
 *
 *  A silent failure is the worst kind to receive a bug report about: the player
 *  can only say "it's black", and every guess costs a round trip. Two things
 *  here, both aimed at making the next report actionable:
 *
 *  1. **A draw-call watchdog, always on.** If the scene pass submits
 *     essentially nothing for a sustained period while the game believes it is
 *     racing, the world is not being drawn. Say so on screen, with the reason,
 *     instead of presenting a void.
 *
 *  2. **`?debug=gl`** prints one copy-pasteable block: GPU string, context
 *     attributes, the extensions this renderer actually depends on, limits, and
 *     every shader that failed to compile or link. That is the report we need.
 *
 *  Shader compile failures are the leading theory. three logs them and then
 *  carries on with an object that never draws, so a driver that rejects one
 *  widely-used material can empty the frame while everything else looks healthy.
 * ============================================================================
 */
import type { Ctx } from '../types';

export interface GLReport {
  vendor: string;
  renderer: string;
  version: string;
  glsl: string;
  contextAttributes: WebGLContextAttributes | null;
  /** the ones this pipeline actually needs, and whether they are present */
  extensions: Record<string, boolean>;
  limits: Record<string, number>;
  quality: number;
  pixelRatio: number;
  drawCalls: number;
  programs: number;
  shaderErrors: string[];
  composer: boolean;
  userAgent: string;
}

/** Extensions the render pipeline genuinely leans on, and why. */
const NEEDED = [
  'EXT_color_buffer_half_float', // HDR composer buffer; without it the grade clips
  'EXT_color_buffer_float',
  'OES_texture_float_linear',    // smooth sampling of float targets (PMREM, AO)
  'EXT_texture_filter_anisotropic',
  'WEBGL_debug_renderer_info',
  'KHR_parallel_shader_compile', // only affects pre-warm speed
];

const QUIET_FRAMES = 90;
/** Below this many scene draws we assume nothing meaningful was submitted. */
const DEAD_CALLS = 4;

export class Diagnostics {
  private quiet = 0;
  private announced = false;
  private shaderErrors: string[] = [];

  init(ctx: Ctx) {
    (window as any).__gl = () => this.report(ctx);

    // Capture shader diagnostics: three logs them through console.error and
    // then continues with a mesh that silently never draws.
    const realError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
      if (/shader|glsl|program|compile|link/i.test(text) && this.shaderErrors.length < 40) {
        this.shaderErrors.push(text.slice(0, 600));
      }
      realError(...args);
    };

    if (new URLSearchParams(location.search).get('debug') === 'gl') {
      // Give the scene a few frames to build before reporting.
      setTimeout(() => this.print(ctx), 3000);
    }
    console.info(
      '%c[kart] if the world is missing but the HUD is visible, run __gl() and send the output.',
      'color:#8ab4ff',
    );
  }

  /** Called after each present with the draw-call count of the scene pass. */
  afterPresent(ctx: Ctx, sceneCalls: number) {
    if (this.announced) return;
    // Only meaningful once the game believes it is showing a world.
    if (ctx.frame < 120) return;
    this.quiet = sceneCalls <= DEAD_CALLS ? this.quiet + 1 : 0;
    if (this.quiet < QUIET_FRAMES) return;

    this.announced = true;
    const r = this.report(ctx);
    const why = r.shaderErrors.length
      ? 'Some shaders failed to compile on this GPU.'
      : !r.extensions['EXT_color_buffer_half_float'] && !r.extensions['EXT_color_buffer_float']
        ? 'This GPU cannot render to a floating-point buffer.'
        : 'The scene is not being submitted to the GPU.';
    console.error('[kart] THE WORLD IS NOT BEING DRAWN.', why, r);
    this.banner(why);
  }

  private banner(why: string) {
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); z-index:200;
      max-width:min(560px,86vw); padding:22px 26px; border-radius:16px; text-align:center;
      background:rgba(14,10,8,.93); border:1.5px solid rgba(255,190,120,.45); color:#f6efe4;
      font:500 15px/1.55 system-ui,-apple-system,sans-serif; box-shadow:0 18px 50px rgba(0,0,0,.6);
    `;
    el.innerHTML =
      `<div style="font-weight:800;font-size:18px;letter-spacing:.02em;margin-bottom:8px">
         Graphics could not start
       </div>
       <div style="opacity:.85">${why}</div>
       <div style="opacity:.6;margin-top:12px;font-size:13px">
         Open the console and run <code style="background:rgba(255,255,255,.1);padding:2px 6px;border-radius:5px">__gl()</code>,
         then send the output.
       </div>`;
    document.body.appendChild(el);
  }

  report(ctx: Ctx): GLReport {
    const renderer = ctx.renderer;
    const gl = renderer?.getContext() as WebGL2RenderingContext | undefined;
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const ext: Record<string, boolean> = {};
    for (const name of NEEDED) ext[name] = !!gl?.getExtension(name);

    const limits: Record<string, number> = {};
    if (gl) {
      limits.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      limits.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
      limits.maxVertexUniforms = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
      limits.maxFragmentUniforms = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
      limits.maxVaryings = gl.getParameter(gl.MAX_VARYING_VECTORS);
      limits.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
      limits.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    }

    return {
      vendor: dbg && gl ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : 'unknown',
      renderer: dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown',
      version: gl ? String(gl.getParameter(gl.VERSION)) : 'no context',
      glsl: gl ? String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)) : '-',
      contextAttributes: gl?.getContextAttributes() ?? null,
      extensions: ext,
      limits,
      quality: ctx.settings?.quality ?? -1,
      pixelRatio: renderer?.getPixelRatio?.() ?? 0,
      drawCalls: renderer?.info.render.calls ?? 0,
      programs: renderer?.info.programs?.length ?? 0,
      shaderErrors: this.shaderErrors,
      composer: !!(globalThis as any).__render?.composer,
      userAgent: navigator.userAgent,
    };
  }

  private print(ctx: Ctx) {
    const r = this.report(ctx);
    console.info('%c[kart] GL report — copy everything below', 'color:#ffb020;font-weight:bold');
    console.info(JSON.stringify(r, null, 2));
  }
}
