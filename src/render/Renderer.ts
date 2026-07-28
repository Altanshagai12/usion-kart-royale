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

  /**
   * False from the moment the GPU takes the context away until the rebuild
   * after `webglcontextrestored` has finished. NOTHING may draw while it is
   * false — every GL call in that window is a silent no-op, so a loop that
   * keeps calling `render()` is just burning CPU and queueing work that will
   * never be presented.
   */
  contextLost = false;

  /**
   * Raised as soon as the context is lost, before anything else. The frame loop
   * subscribes so it can stop simulating on the same tick.
   */
  onContextLost: (() => void) | null = null;
  /**
   * Raised after the composer, its render targets and the effect chain have
   * been rebuilt against the new context. Everything that owns GPU state three
   * cannot re-derive on its own — the PMREM environment probe above all, whose
   * texture comes back allocated but EMPTY — has to re-bake here. May be async;
   * the notice stays up until it settles.
   */
  onContextRestored: (() => void | Promise<void>) | null = null;

  private ctx!: Ctx;
  private device: DeviceProfile = { webgl2: false, halfFloat: false, software: false, name: '' };
  private usePost = false;
  private width = 1;
  private height = 1;
  private signature = -1;
  /** Last values `applyResolution` actually pushed at the GL side. */
  private appliedRatio = -1;
  private appliedW = -1;
  private appliedH = -1;
  private appliedSamples = -1;
  private notice: HTMLElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

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
      // False in normal play: keeping the drawing buffer costs a copy every
      // frame. But `?debug=frames` exists to read that buffer back, and with
      // this false the read returns DISCARDED contents — measured as all zeros
      // on a frame that presented perfectly — so the watchdog reports 100%
      // black on a healthy frame. An instrument that lies is worse than none.
      preserveDrawingBuffer:
        new URLSearchParams(location.search).get('debug') === 'frames',
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

    // ---- context loss ------------------------------------------------------
    // A mobile GPU under memory pressure takes the context away rather than
    // killing the tab, and until this round nothing in the game listened for
    // it: the canvas simply went black and stayed black, because there is no
    // automatic recovery for a scene's GPU resources.
    //
    // `preventDefault()` on the loss event is the whole ballgame. Without it
    // the browser never fires 'webglcontextrestored' at all, so recovery is not
    // merely unhandled, it is impossible. (three's own listener also calls it,
    // but relying on that is relying on an implementation detail of a library
    // we pin by caret; calling it here is one line and cannot be wrong.)
    //
    // Ours are registered AFTER three's, which is deliberate: on restore three
    // re-runs `initGLContext()` and throws away its WebGLProperties cache, so
    // by the time we are called the device is live again and every texture,
    // geometry and program will re-upload on next use. What does NOT come back
    // on its own is anything whose *contents* were baked once — see
    // `onContextRestored`.
    renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    renderer.domElement.addEventListener('webglcontextcreationerror', ((e: WebGLContextEvent) => {
      console.error('[render] context creation error:', e.statusMessage);
    }) as EventListener, false);

    this.renderer = renderer;
    try { this.gl = renderer.getContext(); } catch { this.gl = null; }
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
    if (this.contextLost) return;
    if (!this.usePost) {
      this.fx.dispose();
      // Nothing owns the default framebuffer's clear any more. See render().
      this.renderer.autoClear = true;
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
        // A brand-new composer starts at multisampling 0 and at whatever size
        // its constructor picked, so the `applyResolution` guard has no history
        // to compare against and must not skip the first push.
        this.invalidateResolutionCache();
      } catch (err) {
        console.warn('[render] composer unavailable, falling back to direct render', err);
        this.composer = null;
        this.usePost = false;
        this.renderer.autoClear = true;
        this.invalidateResolutionCache();
        this.applyResolution();
        return;
      }
    } else {
      this.fx.dispose();
      this.composer.removeAllPasses();
    }

    // The composer's input buffer is the only place the scene is rasterised,
    // so it is the only place multisampling can do anything.
    //
    // Assigned through the guard rather than directly: postprocessing's
    // `multisampling` setter DISPOSES the input buffer even when the value it
    // is handed is the one already in force, so a stream of no-op resizes —
    // which is exactly what iOS Safari produces while the URL bar animates —
    // reallocates a half-float MSAA HDR attachment tens of times a second.
    // See `applyResolution`.
    //
    // This used to read `ssao ? 0 : msaa`, on the belief that N8AOPostPass
    // re-renders the scene into a private target and discards the composer's
    // colour buffer. That is true of `N8AOPass`; `N8AOPostPass` reads the
    // composer's `inputBuffer` as its scene colour and composites onto it. So
    // zeroing this dropped MSAA on exactly the tier that asks for it — and the
    // line in PostFX that was supposed to take over threw on a missing field
    // and killed the whole effect chain with it (see PostFX.build).
    this.setMultisampling(this.msaaSamples());

    try {
      this.fx.build(this.ctx, this.composer, { software: this.device.software });
    } catch (err) {
      console.warn('[render] effect chain failed to build, falling back', err);
      this.fx.dispose();
      try {
        this.composer.removeAllPasses();
        this.composer.dispose();
      } catch { /* the composer is being abandoned either way */ }
      this.composer = null;
      this.usePost = false;
      // §6 of the brief: degrade, do not die. The direct path below is a real
      // frame — no grade, no bloom, but a legible game — and it needs the
      // renderer's own clear back, because the EffectComposer constructor
      // turned `autoClear` off on its way in and nothing else would ever turn
      // it on again. Without this the default framebuffer is never cleared and
      // whatever the previous frame left in the pixels the scene does not cover
      // stays on screen: a genuine partial-render, permanently.
      this.renderer.autoClear = true;
      this.invalidateResolutionCache();
      this.applyResolution();
      return;
    }

    this.applyResolution();
  }

  render(ctx: Ctx) {
    // Nothing may draw between 'webglcontextlost' and the rebuild that follows
    // 'webglcontextrestored'. Every GL call in that window is a silent no-op,
    // so continuing to render is pure waste — and on the device that just ran
    // out of memory, waste is the last thing to add.
    if (this.contextLost || this.renderer === undefined) return;

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
      // Explicit, not left to `autoClear`: this path is reached both from a
      // device that never had a composer (autoClear untouched, true) and from a
      // composer that failed to build (autoClear turned off by postprocessing's
      // constructor before it threw). One of those two clears the canvas and
      // the other does not, and the one that does not shows the previous frame
      // wherever the scene has no geometry — sky included, since the sky dome
      // is drawn but the HUD-side letterbox is not.
      this.renderer.clear(true, true, false);
      this.renderer.render(ctx.scene, ctx.camera);
    }

    // ------------------------------------------------------------------------
    // THE PARTIAL-FRAME ARTEFACT — what it actually is, measured.
    // ------------------------------------------------------------------------
    // tools/shot.mjs documents "roughly one capture in five comes back as a
    // vertical split, with the left band holding the previous frame and
    // everything right of the seam holding a scene buffer that was never drawn
    // into", and writes it off as a SwiftShader quirk. The player sees the same
    // thing on a real phone, so it was worth measuring properly rather than
    // retrying past. Three arms, one session, 50 captures each at 1920x1080,
    // scored with the harness's own dark-fraction test:
    //
    //     arm                       torn / 50     worst frame
    //     stock pipeline               12          50.1% dark
    //     + gl.finish() per frame       3          24.8% dark
    //     no post-processing at all     3          11.7% dark
    //
    // Read those together and the artefact is not a logic bug in the chain:
    //
    //  - `finish()` — which blocks until the GPU is idle — cuts it four-fold.
    //    So most torn frames are frames the compositor sampled while the
    //    rasteriser was still working through them. The dark region is not a
    //    buffer "that was never drawn into", it is one that had not been drawn
    //    into YET, with the grade pass's grain and vignette already composited
    //    over the part of it that was still black. Its boundary is a tile
    //    corner — a column seam AND a row seam in the same frame — not a
    //    scanline, which is what partial tile coverage looks like.
    //  - Removing the composer cuts the RATE by the same four-fold and the
    //    SEVERITY by more than four-fold. Post-processing does not introduce
    //    the race; it makes the window wider, because it multiplies the GPU
    //    work behind a single present.
    //  - Neither arm reaches zero, so a residue lives in the capture path
    //    itself and is genuinely not ours.
    //
    // Which means there is no line to add here. The lever is per-frame GPU
    // cost, and that is what the rest of this round is: the watchdog in
    // main.ts refuses to queue a second frame on top of an overrunning one, the
    // resize guard below stops the whole target set being reallocated mid
    // gesture, and the handheld tier ships without the passes it cannot afford.
    //
    // `gl.flush()` was the obvious cheap candidate and it is deliberately NOT
    // here: A/B'd on its own, 70 captures each, it measured 4 torn frames
    // without and 8 with. It does not help.
  }

  resize(w: number, h: number) {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw === this.width && nh === this.height) return;
    this.width = nw;
    this.height = nh;
    this.applyResolution();
  }

  dispose() {
    const el = this.renderer?.domElement;
    if (el !== undefined) {
      el.removeEventListener('webglcontextlost', this.handleContextLost, false);
      el.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    }
    this.fx.dispose();
    if (this.composer !== null) {
      this.composer.dispose();
      this.composer = null;
    }
    this.notice?.remove();
    this.notice = null;
    this.renderer?.dispose();
    if (el !== undefined && el.parentNode !== null) el.parentNode.removeChild(el);
  }

  /**
   * Give up on post-processing and run the direct path from here on.
   *
   * The chain already degrades when it cannot be *built*; this is the same
   * retreat for a chain that built fine and then started throwing at render
   * time, which is what a driver in trouble looks like from up here. A game
   * without a grade is a worse-looking game; a game that throws once per frame
   * is a black rectangle.
   */
  disablePostProcessing(reason: string): void {
    if (!this.usePost && this.composer === null) return;
    console.warn(`[render] disabling post-processing: ${reason}`);
    this.fx.dispose();
    try {
      this.composer?.removeAllPasses();
      this.composer?.dispose();
    } catch { /* going away regardless */ }
    this.composer = null;
    this.usePost = false;
    this.renderer.autoClear = true;
    this.invalidateResolutionCache();
    this.applyResolution();
  }

  /**
   * Put a line of text over the canvas, or take it away again with `null`.
   * The frame loop uses this for the one failure the pipeline cannot see from
   * in here: a renderer that keeps throwing without ever losing its context.
   */
  announce(title: string | null, detail = ''): void {
    if (title === null) this.hideNotice();
    else this.showNotice(title, detail);
  }

  /**
   * Test hook: drop the context on purpose, and optionally hand it back.
   *
   * Recovery code that has never been run is decoration, and the only way to
   * run this one is to ask the driver to take the context away. Exposed through
   * `__render` alongside the rest of the harness surface.
   */
  debugLoseContext(restoreAfterMs = 900): void {
    const ext = this.renderer.getContext().getExtension('WEBGL_lose_context');
    if (ext === null) {
      console.warn('[render] WEBGL_lose_context unavailable; cannot simulate a loss');
      return;
    }
    ext.loseContext();
    if (restoreAfterMs >= 0) setTimeout(() => ext.restoreContext(), restoreAfterMs);
  }

  // -------------------------------------------------------------------------
  //  Context loss / restore
  // -------------------------------------------------------------------------

  private handleContextLost = (event: Event) => {
    // THE ONE LINE. Without `preventDefault()` the browser will never fire
    // 'webglcontextrestored', so there is no recovery to write.
    event.preventDefault();
    if (this.contextLost) return;
    this.contextLost = true;
    console.warn('[render] WebGL context lost — pausing until it is restored');

    // Drop our references to the effect chain. Every GPU object behind them is
    // already gone; the dispose calls are only there to release the JS side,
    // and they are wrapped because postprocessing will happily issue GL calls
    // against a dead context on the way out.
    try { this.fx.dispose(); } catch { /* already gone with the context */ }
    try { this.composer?.dispose(); } catch { /* likewise */ }
    this.composer = null;

    this.showNotice('Graphics paused', 'The device reclaimed the renderer. Restoring…');
    try { this.onContextLost?.(); } catch (err) { console.error('[render] onContextLost threw', err); }
  };

  private handleContextRestored = () => {
    console.info('[render] WebGL context restored — rebuilding the pipeline');
    // three's own listener runs first (it is registered in the WebGLRenderer
    // constructor, ours in init) and has already re-run `initGLContext()`, so
    // the device is live and every texture, geometry and program will re-upload
    // the next time it is used. What is left to us is everything that wraps a
    // GL resource of our own.
    this.usePost = this.device.webgl2;
    this.composer = null;
    this.invalidateResolutionCache();
    this.signature = pipelineSignature(this.ctx.settings);

    try { this.gl = this.renderer.getContext(); } catch { this.gl = null; }
    this.renderer.shadowMap.enabled = this.ctx.settings.shadows;
    // Shadow maps come back as empty attachments; autoUpdate re-renders them on
    // the next frame, but only if nothing has latched `needsUpdate` off.
    this.renderer.shadowMap.needsUpdate = true;

    this.contextLost = false;
    this.applyResolution();
    this.rebuild();

    const done = () => {
      // A second loss can land while the first restore's pre-warm is still
      // running. If it has, the notice on screen belongs to that one and must
      // not be pulled down by a callback from the restore before it.
      if (this.contextLost) return;
      this.hideNotice();
      console.info('[render] pipeline restored');
    };
    try {
      const p = this.onContextRestored?.();
      if (p !== undefined && p !== null && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).then(done, (err) => {
          console.error('[render] onContextRestored failed', err);
          done();
        });
      } else {
        done();
      }
    } catch (err) {
      console.error('[render] onContextRestored threw', err);
      done();
    }
  };

  /**
   * A calm line of text over the frozen canvas. A black rectangle with no
   * explanation is the worst version of this; the frame underneath is stale but
   * it is still a picture of the game, so the notice sits on top of it rather
   * than replacing it.
   */
  private showNotice(title: string, detail: string): void {
    if (this.notice === null) {
      const el = document.createElement('div');
      el.id = 'gl-notice';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'inset:auto 0 0 0', 'z-index:120', 'display:flex',
        'flex-direction:column', 'align-items:center', 'gap:.35em',
        'padding:1.4em 1.2em calc(1.4em + env(safe-area-inset-bottom))',
        'font-family:system-ui,-apple-system,sans-serif', 'text-align:center',
        'color:#f3f6fb', 'pointer-events:none',
        'background:linear-gradient(180deg,rgba(8,11,22,0) 0%,rgba(8,11,22,.82) 46%,rgba(8,11,22,.94) 100%)',
        'opacity:0', 'transition:opacity .35s ease',
      ].join(';');
      el.innerHTML =
        '<b style="font-size:clamp(15px,2.4vmin,20px);font-weight:800;letter-spacing:.06em"></b>' +
        '<span style="font-size:clamp(12px,1.8vmin,15px);letter-spacing:.04em;color:rgba(233,240,250,.66)"></span>';
      document.body.appendChild(el);
      this.notice = el;
    }
    const [b, s] = [this.notice.querySelector('b'), this.notice.querySelector('span')];
    if (b !== null) b.textContent = title;
    if (s !== null) s.textContent = detail;
    // One frame of layout before the transition, or it snaps in.
    requestAnimationFrame(() => { if (this.notice !== null) this.notice.style.opacity = '1'; });
  }

  private hideNotice(): void {
    const el = this.notice;
    if (el === null) return;
    el.style.opacity = '0';
    setTimeout(() => { if (this.notice === el) { el.remove(); this.notice = null; } }, 420);
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
    const ratio = Math.min(dpr, cap) * scale;

    // Never ask for a buffer the driver cannot make.
    //
    // Every colour attachment in the chain is allocated at the drawing-buffer
    // size, and a render target whose edge exceeds `MAX_TEXTURE_SIZE` or
    // `MAX_RENDERBUFFER_SIZE` does not fail loudly — it comes back incomplete
    // and everything drawn into it is black, which is the most literal possible
    // version of the player's report. It is not hypothetical on a handheld: a
    // 2532 CSS-px landscape panel at devicePixelRatio 3 is 7596 drawing-buffer
    // pixels wide, and the WebGL2 floor for both limits is 2048. Clamping the
    // ratio costs sharpness on a device that had no chance of affording those
    // pixels anyway, and it costs nothing at all on the desktop tiers, where
    // the limit is 16384.
    const limit = Math.min(
      this.renderer?.capabilities?.maxTextureSize ?? 4096,
      this.maxRenderbufferSize(),
    );
    const longest = Math.max(this.width, this.height);
    if (longest * ratio > limit) return Math.max(0.25, limit / longest);
    return ratio;
  }

  private maxRenderbufferSize(): number {
    const gl = this.gl;
    if (gl === null) return 4096;
    try {
      return (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096;
    } catch {
      return 4096;
    }
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
    if (this.renderer === undefined || this.contextLost) return;

    const ratio = this.effectivePixelRatio();

    // NO-OP RESIZES ARE NOT FREE, AND ON A PHONE THERE ARE HUNDREDS OF THEM.
    //
    // `composer.setSize` reallocates the input and output buffers and calls
    // `setSize` on every registered pass, which reallocates the AO targets, the
    // whole bloom mip chain, the bokeh targets and the SMAA buffers. At a
    // handheld's drawing-buffer size that is on the order of 25-30 MB of GPU
    // allocation, and the driver frees the old attachments lazily, so the peak
    // is a multiple of the steady state.
    //
    // iOS Safari fires `resize` continuously while the URL bar collapses or
    // expands, on every rotation, and whenever the on-screen keyboard moves —
    // dozens of events for one gesture, most of which report a size we are
    // already at. Rebuilding every render target in the pipeline dozens of
    // times inside one animation is a memory spike on a device that is already
    // being killed for its footprint, and a stall long enough for the
    // compositor to present a half-drawn surface. Both of the player's reports
    // meet here.
    //
    // The guard compares what we would actually push at the GL side — the
    // drawing-buffer dimensions, not the CSS ones — so a ratio change with the
    // same CSS size still gets through, and a CSS change too small to move the
    // buffer does not.
    const bufW = Math.floor(this.width * ratio);
    const bufH = Math.floor(this.height * ratio);
    if (bufW === this.appliedW && bufH === this.appliedH && ratio === this.appliedRatio) {
      // The sample count can still move on its own (see below), so it is
      // checked even when the size has not.
      if (this.composer !== null) this.setMultisampling(this.msaaSamples());
      return;
    }
    this.appliedW = bufW;
    this.appliedH = bufH;
    this.appliedRatio = ratio;

    this.renderer.setPixelRatio(ratio);
    if (this.composer !== null) {
      // Re-evaluated here, not only in `rebuild`, because the sample count is a
      // function of the effective pixel ratio and `devicePixelRatio` can change
      // under us — dragging the window to a non-retina display fires a resize
      // and nothing else.
      this.setMultisampling(this.msaaSamples());
      // The composer resizes its own buffers and every registered pass from
      // the drawing buffer size, which already folds in the pixel ratio.
      this.composer.setSize(this.width, this.height, true);
    } else {
      this.renderer.setSize(this.width, this.height, true);
    }
  }

  /**
   * Assigns the composer's sample count only when it genuinely changes.
   *
   * The comment this replaces claimed "the setter is a no-op when the value is
   * unchanged". It is not: postprocessing's setter reads
   *
   *     if (multisampling > 0 && value > 0) { buffer.samples = value; buffer.dispose(); }
   *
   * — an unconditional `dispose()` of the input buffer whenever both the old
   * and the new value are non-zero, which is every assignment on every tier
   * above Low. `dispose()` releases the GPU-side attachment and marks the
   * target for reallocation on next use, so handing the setter the value it
   * already holds throws away a half-float MSAA HDR buffer and builds an
   * identical one. Once per quality change is nothing; once per resize event,
   * on a platform that fires resize events in bursts, is the difference between
   * a steady footprint and a sawtooth.
   */
  /** Forgets what was last pushed, so the next `applyResolution` pushes it all. */
  private invalidateResolutionCache(): void {
    this.appliedRatio = -1;
    this.appliedW = -1;
    this.appliedH = -1;
    this.appliedSamples = -1;
  }

  private setMultisampling(samples: number): void {
    if (this.composer === null || samples === this.appliedSamples) return;
    this.appliedSamples = samples;
    this.composer.multisampling = samples;
  }
}
