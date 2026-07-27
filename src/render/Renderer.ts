/**
 * ============================================================================
 *  RenderPipeline — owns the WebGLRenderer and the post-processing composer.
 * ============================================================================
 *  This is the only object in the game permitted to call `renderer.render()`
 *  or `composer.render()`. Everything else draws by putting objects in the
 *  scene graph.
 *
 *  The chain itself lives in PostFX; this file is responsible for the device,
 *  the buffers, the resolution policy, and for degrading all of it gracefully
 *  when the hardware — or a software rasteriser under a screenshot harness —
 *  cannot take the full stack.
 * ============================================================================
 */
import * as THREE from 'three';
import { EffectComposer } from 'postprocessing';
import { Quality, type Ctx, type Settings, type System } from '../types';
import { PostFX } from './PostFX';

interface DeviceProfile {
  webgl2: boolean;
  /** RGBA16F is colour-renderable — required for an HDR composer buffer */
  halfFloat: boolean;
  /** SwiftShader / llvmpipe / ANGLE-on-CPU, i.e. a headless capture or CI */
  software: boolean;
  name: string;
}

/**
 * Probes capabilities on a throwaway context so the real renderer can be
 * constructed with the right attributes first time. Discovering afterwards
 * that we need a different context means replacing the canvas, and by then
 * every other system has already captured `ctx.renderer`.
 */
function probeDevice(): DeviceProfile {
  const profile: DeviceProfile = { webgl2: false, halfFloat: false, software: false, name: '' };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (gl === null) return profile;
    profile.webgl2 = true;
    profile.halfFloat =
      gl.getExtension('EXT_color_buffer_half_float') !== null ||
      gl.getExtension('EXT_color_buffer_float') !== null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    profile.name = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    profile.software =
      /SwiftShader|llvmpipe|Software|Microsoft Basic|Mesa OffScreen|ANGLE \(Software/i.test(profile.name);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    /* A blocked or exhausted context just means we take the safe path. */
  }
  return profile;
}

/** Packs the settings the pipeline actually reacts to into one comparable int. */
function pipelineSignature(s: Settings): number {
  return (s.quality & 3) |
    (s.shadows ? 1 << 2 : 0) |
    (s.ssao ? 1 << 3 : 0) |
    (s.bloom ? 1 << 4 : 0) |
    (s.motionBlur ? 1 << 5 : 0) |
    (s.dof ? 1 << 6 : 0) |
    (Math.round(THREE.MathUtils.clamp(s.renderScale, 0.25, 2) * 64) << 7) |
    (Math.round(THREE.MathUtils.clamp(s.maxPixelRatio, 0.5, 4) * 8) << 16);
}

export class RenderPipeline implements System {
  renderer!: THREE.WebGLRenderer;
  /** Public so debug tooling and a quality menu can reach into the chain. */
  composer: EffectComposer | null = null;
  readonly fx = new PostFX();

  private ctx!: Ctx;
  private device: DeviceProfile = { webgl2: false, halfFloat: false, software: false, name: '' };
  private usePost = false;
  private width = 1;
  private height = 1;
  private signature = -1;

  constructor(private readonly canvasParent: HTMLElement) {}

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.device = probeDevice();
    this.usePost = this.device.webgl2;

    const renderer = new THREE.WebGLRenderer({
      // With the composer running, MSAA lives on the composer's render target
      // and the default framebuffer only ever receives one fullscreen triangle.
      // Without a composer, the driver's MSAA is the only edge treatment left.
      antialias: !this.usePost,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The grade shader inside the composer does the actual tone map — three
    // skips its own whenever it renders into a render target. Setting it here
    // anyway keeps the no-composer fallback looking identical rather than
    // blowing out to white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    renderer.shadowMap.enabled = ctx.settings.shadows;
    // PCF over VSM: the cascade rig is authored elsewhere, and VSM light bleed
    // through thin kerb, railing and fence geometry costs more than the softer
    // penumbra buys with the sun this low.
    //
    // Explicitly PCFShadowMap, not PCFSoftShadowMap: three r185 deprecated the
    // latter and silently substitutes this one anyway, while logging a warning
    // on every boot — which the capture harness records as a frame warning.
    // Asking for what we actually get also stops `DirectionalLightShadow.radius`
    // reading as if it did something (PCF ignores it), so the softness has to
    // come from map resolution and cascade extent, where it really lives.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;

    renderer.domElement.setAttribute('aria-hidden', 'true');
    this.canvasParent.appendChild(renderer.domElement);

    this.renderer = renderer;
    ctx.renderer = renderer;
    // Same contract as `window.__drawBudget`: the capture and perf harnesses
    // need to read the device profile and reach into the effect chain (which
    // is deliberately not on Ctx) to A/B a single pass.
    (globalThis as unknown as { __render?: RenderPipeline }).__render = this;

    this.width = Math.max(1, ctx.width);
    this.height = Math.max(1, ctx.height);
    this.signature = pipelineSignature(ctx.settings);
    this.applyResolution();
    this.rebuild();
  }

  /**
   * Tears the effect chain down and reassembles it against the current
   * settings. Safe to call at any time — quality may change mid-race.
   */
  rebuild(): void {
    if (!this.usePost) {
      this.fx.dispose();
      return;
    }

    if (this.composer === null) {
      try {
        this.composer = new EffectComposer(this.renderer, {
          depthBuffer: true,
          stencilBuffer: false,
          multisampling: 0,
          // Half float is what makes a high bloom threshold and our own tone
          // map meaningful; without it the scene clips to white before there
          // is anything left to grade.
          frameBufferType: this.device.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
        });
      } catch (err) {
        console.warn('[render] composer unavailable, falling back to direct render', err);
        this.composer = null;
        this.usePost = false;
        return;
      }
    } else {
      this.fx.dispose();
      this.composer.removeAllPasses();
    }

    // The composer's input buffer is the only place the scene is rasterised,
    // so it is the only place multisampling can do anything.
    //
    // This used to read `ssao ? 0 : msaa`, on the belief that N8AOPostPass
    // re-renders the scene into a private target and discards the composer's
    // colour buffer. That is true of `N8AOPass`; `N8AOPostPass` reads the
    // composer's `inputBuffer` as its scene colour and composites onto it. So
    // zeroing this dropped MSAA on exactly the tier that asks for it — and the
    // line in PostFX that was supposed to take over threw on a missing field
    // and killed the whole effect chain with it (see PostFX.build).
    this.composer.multisampling = this.msaaSamples();

    try {
      this.fx.build(this.ctx, this.composer, { software: this.device.software });
    } catch (err) {
      console.warn('[render] effect chain failed to build, falling back', err);
      this.fx.dispose();
      this.composer.removeAllPasses();
      this.composer.dispose();
      this.composer = null;
      this.usePost = false;
      return;
    }

    this.applyResolution();
  }

  render(ctx: Ctx) {
    // Quality can change at runtime; react without anyone having to tell us.
    const sig = pipelineSignature(ctx.settings);
    if (sig !== this.signature) {
      this.signature = sig;
      this.renderer.shadowMap.enabled = ctx.settings.shadows;
      this.rebuild();
      this.applyResolution();
    }

    if (this.composer !== null) {
      this.fx.sync(ctx, ctx.dt);
      this.composer.render(ctx.dt);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(ctx.scene, ctx.camera);
    }
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.applyResolution();
  }

  dispose() {
    this.fx.dispose();
    if (this.composer !== null) {
      this.composer.dispose();
      this.composer = null;
    }
    const el = this.renderer?.domElement;
    this.renderer?.dispose();
    if (el !== undefined && el.parentNode !== null) el.parentNode.removeChild(el);
  }

  // -------------------------------------------------------------------------

  /**
   * The pixel ratio the internal buffers are actually allocated at, which is
   * what every per-sample cost in the chain scales with. Not the same thing as
   * `devicePixelRatio`: `maxPixelRatio` caps it, `renderScale` scales it, and a
   * software rasteriser is pinned to 1.
   */
  private effectivePixelRatio(): number {
    const s = this.ctx.settings;
    const cap = this.device.software ? 1 : Math.max(0.5, s.maxPixelRatio);
    const scale = THREE.MathUtils.clamp(s.renderScale, 0.25, 2);
    const dpr = THREE.MathUtils.clamp(globalThis.devicePixelRatio || 1, 0.5, 4);
    return Math.min(dpr, cap) * scale;
  }

  private msaaSamples(): number {
    if (!this.device.webgl2) return 0;
    const q = this.ctx.settings.quality;
    // A software rasteriser pays for every sample of every fragment, so SMAA
    // carries the edges there. Quality.Low relies on SMAA alone by design.
    if (this.device.software) return q >= Quality.High ? 2 : 0;
    if (q < Quality.Medium) return 0;
    if (q === Quality.Medium) return 2;

    // MSAA SAMPLES AND RENDER RESOLUTION BUY THE SAME THING, AND WE WERE PAYING
    // FOR BOTH AT FULL PRICE. §8's budget is 60 fps at 1080p, but `High` and
    // `Ultra` both ship `maxPixelRatio: 2`, so on the retina Mac the budget is
    // written against the composer's input buffer is 3840x2160 — and it is
    // RGBA16F, because the whole grade depends on a half-float HDR buffer. At
    // 4x MSAA that single attachment is 3840 * 2160 * 8 bytes * 4 samples =
    // 265 MB, and every fragment of every opaque draw is resolved out of it.
    // Dropping to 2x halves that bandwidth for the entire scene pass, which is
    // the largest single line item in the frame, and it is very close to free
    // visually: at an effective ratio of 1.5 or more each CSS pixel already
    // receives at least 2.25 geometric samples before MSAA is applied at all,
    // and SMAA still runs last on top of the resolve.
    //
    // Below 1.5 there is no supersampling to lean on and the 4 samples are
    // doing real work on the kerb stripes, the railings and the fence posts —
    // §9.6's "aliasing crawl on thin geometry" — so they stay.
    return this.effectivePixelRatio() >= 1.5 ? 2 : 4;
  }

  /**
   * Resolution policy. `renderScale` folds into the device pixel ratio, so the
   * canvas keeps its full CSS size and the compositor does the upscale on
   * present — while the internal buffers, the AO targets, the bloom mip chain
   * and the bokeh targets all shrink together.
   */
  private applyResolution(): void {
    if (this.renderer === undefined) return;

    this.renderer.setPixelRatio(this.effectivePixelRatio());
    if (this.composer !== null) {
      // Re-evaluated here, not only in `rebuild`, because the sample count is a
      // function of the effective pixel ratio and `devicePixelRatio` can change
      // under us — dragging the window to a non-retina display fires a resize
      // and nothing else. The setter is a no-op when the value is unchanged.
      this.composer.multisampling = this.msaaSamples();
      // The composer resizes its own buffers and every registered pass from
      // the drawing buffer size, which already folds in the pixel ratio.
      this.composer.setSize(this.width, this.height, true);
    } else {
      this.renderer.setSize(this.width, this.height, true);
    }
  }
}
