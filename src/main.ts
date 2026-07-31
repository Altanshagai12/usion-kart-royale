import * as THREE from 'three';
import type { Ctx, System } from './types';
import { Bus } from './core/Bus';
import { createSettings } from './core/Settings';
import { Input } from './core/Input';
import { Recorder } from './core/Recorder';
import { prewarm } from './core/Prewarm';
import { FrameWatch } from './core/FrameWatch';
import { Diagnostics } from './core/Diagnostics';
import { installFeel } from './core/Feel';
import { surfaceSize } from './core/Viewport';
import { RenderPipeline } from './render/Renderer';
import { DrawBudget } from './render/DrawBudget';
import { Sky } from './render/Sky';
import { Materials } from './render/Materials';
import { Track } from './world/Track';
import { Scenery } from './world/Scenery';
import { Effects } from './fx/Effects';
import { Items } from './game/Items';
import { Race } from './game/Race';
import { ChaseCamera } from './game/Camera';
import { HUD } from './ui/HUD';
import { Audio } from './audio/Audio';
import { DirectMultiplayer } from './net/DirectMultiplayer';

const parent = document.getElementById('app')!;

/**
 * The size the canvas will actually be displayed at, in CSS pixels.
 *
 * Measured off `#app` (which is `position: fixed; inset: 0`) rather than read
 * from `innerWidth`/`innerHeight`, and that is a mobile correctness fix, not a
 * tidy-up. On iOS Safari `innerHeight` tracks the VISUAL viewport — it shrinks
 * and grows as the URL bar collapses, mid-gesture, by ~60 px — while a
 * `position: fixed` element is laid out against the LAYOUT viewport and does
 * not move. `renderer.setSize(w, h, true)` writes inline `style.width/height`
 * in pixels, which beats the stylesheet's `width: 100%`, so sizing from
 * `innerHeight` pinned the canvas to the smaller of the two and left an
 * unpainted strip along the bottom of the screen: a black band across part of
 * the frame, appearing and disappearing as the player scrolled their thumb.
 * That is one of the "black partial renders", and it is invisible on desktop
 * because there the two viewports are the same thing.
 *
 * Measuring the element we are about to fill has no such ambiguity, and on
 * desktop it returns exactly what `innerWidth`/`innerHeight` did.
 *
 * It does, however, introduce a failure the window never had: an ELEMENT can
 * measure zero. A `display:none` ancestor, a collapsed pane, a tab in the
 * background, or simply being read mid-layout all return 0, and the old
 * `Math.max(1, ...)` dutifully turned that into a 1x1 canvas — resizing the
 * drawing buffer AND every composer render target down to a single pixel.
 * Observed live: `canvas 2x2, css 1x1`. Coming back from that costs at least
 * one presented frame sourced from a one-pixel buffer, which is a black or
 * part-black flash. A `ResizeObserver` on the element fires on every one of
 * those transitions, so it happens often.
 *
 * So a degenerate measurement is not a size — it is the absence of one. Return
 * null and let the caller keep what it had.
 */
const MIN_SURFACE = 16;

function viewportSize(): { w: number; h: number } | null {
  let w = Math.round(parent.clientWidth || 0);
  let h = Math.round(parent.clientHeight || 0);
  // The element measuring zero does not mean the window has; fall back before
  // giving up, which covers being read mid-layout.
  if (w < MIN_SURFACE || h < MIN_SURFACE) {
    const fallback = surfaceSize(innerWidth || 0, innerHeight || 0);
    w = Math.round(fallback.w);
    h = Math.round(fallback.h);
  }
  if (w < MIN_SURFACE || h < MIN_SURFACE) return null;
  return { w, h };
}

const pipeline = new RenderPipeline(parent);
const input = new Input();
const multiplayer = new DirectMultiplayer();
const sky = new Sky();
const materials = new Materials();
const track = new Track();
const scenery = new Scenery();
const effects = new Effects();
const items = new Items();
const race = new Race();
const camera = new ChaseCamera();
const hud = new HUD();
const audio = new Audio();
const drawBudget = new DrawBudget();
const frameWatch = new FrameWatch();
const diagnostics = new Diagnostics();

// At module scope the element may not be laid out yet, and viewportSize()
// correctly refuses to invent a size. A real one arrives from `resize(true)`
// during boot; this only has to be non-degenerate so the camera can be built.
const fallbackView = surfaceSize(innerWidth || 1280, innerHeight || 720);
const view0 = viewportSize() ?? {
  w: Math.max(MIN_SURFACE, fallbackView.w),
  h: Math.max(MIN_SURFACE, fallbackView.h),
};

const ctx: Ctx = {
  renderer: null as any,
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(62, view0.w / view0.h, 0.2, 3000),
  time: 0,
  dt: 0,
  frame: 0,
  width: view0.w,
  height: view0.h,
  settings: createSettings(),
  bus: new Bus(),
  input,
  track,
  race,
  items,
  envMap: null,
  sun: null,
  sunDirection: new THREE.Vector3(0.4, 0.8, 0.3).normalize(),
  shake: (a, s = 0.3) => camera.addShake(a, s),
  speedIntensity: 0,
  fovPunch: 0,
};

// `Ctx` has no slot for the shared material library, so every visual system
// reaches it through the `getMaterials()` module singleton that `Materials`
// registers in its constructor. That works, but it is invisible from the
// contract, so the instance is also published here — one place to look, and a
// safe target for a future `materials` field on `Ctx`.
(ctx as any).materials = materials;

// Init order matters and is load-bearing:
//   pipeline  — sets ctx.renderer; everything that compiles a shader or reads
//               GPU capabilities needs it first.
//   sky       — bakes the PMREM env map into ctx.envMap and sets ctx.sun /
//               ctx.sunDirection, all of which materials, scenery, water and
//               the particle lighting read at their own init.
//   materials — the shared texture/material cache; track and scenery pull from
//               it, so it has to exist (and have seen the env map) first.
//   track     — the world the rest of the game is placed on.
//   scenery   — surveys the finished track to dress it.
//   race      — builds the karts and the racing line; must be after the track.
//   items     — reads ctx.race.karts to allocate an item slot per kart, so it
//               must be after race (Race in turn only takes live references
//               off Items — the hazard array and the racing line — which are
//               valid before Items.init runs).
//   effects / camera / hud / audio — all consume the karts.
//   drawBudget — LOD and shadow culling, measured from the posed camera, so it
//               must be last: its lateUpdate has to run after the chase rig's.
const systems: System[] = [
  pipeline, input, multiplayer, sky, materials, track, scenery, race, items, effects, camera, hud, audio,
  drawBudget,
];

/** Human-readable names for the boot progress readout, indexed with `systems`. */
const SYSTEM_LABELS = [
  'starting renderer', 'reading controls', 'connecting racers', 'raising the sun', 'mixing materials',
  'laying the circuit', 'dressing the bay', 'rolling out the grid', 'loading item boxes',
  'lighting the effects', 'mounting the camera', 'drawing the hud', 'tuning the engines',
  'balancing the frame',
];

function bootProgress(frac: number, label: string) {
  const bar = document.querySelector<HTMLElement>('.boot-bar i');
  const step = document.querySelector<HTMLElement>('.boot-step');
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  if (step) step.textContent = label;
}

async function boot() {
  for (let i = 0; i < systems.length; i++) {
    bootProgress(i / (systems.length + 1), SYSTEM_LABELS[i] ?? 'loading');
    // Yield to the compositor so the bar actually repaints between steps —
    // without this the whole loop runs inside one frame and the player sees a
    // frozen bar, which looks worse than no bar at all.
    await new Promise((r) => requestAnimationFrame(r));
    await systems[i].init?.(ctx);
  }
  frameWatch.init(ctx);
  diagnostics.init(ctx);
  installFeel();
  installResizeListeners();
  installContextRecovery();
  resize(true);

  // Compile every shader before the first frame is presented. Doing it here
  // costs a moment of boot; not doing it costs a dropped frame mid-race every
  // time a new material first appears, which reads as the screen flashing black.
  bootProgress(systems.length / (systems.length + 1), 'compiling shaders');
  await new Promise((r) => requestAnimationFrame(r));
  const warm = await prewarm(ctx);
  console.info(
    `[prewarm] ${warm.programsBefore} -> ${warm.programsAfter} programs ` +
    `(${warm.objectsRevealed} hidden objects included) in ${warm.ms}ms`,
  );

  // Deliberately NOT race.start(): the director already sits in RaceState.Menu,
  // which is what puts the title screen and character select on screen. Booting
  // straight into a countdown skipped the entire front end — it dated from the
  // original scaffold, written before there was a front end to skip.
  bootProgress(1, 'ready');

  // Press R to record. Deliberately not a System: it owns no scene state and
  // must keep working while the game is paused or on a menu.
  new Recorder().install();
  requestAnimationFrame(frame);
  (window as any).__gameReady = false;
}

/** Fades the boot curtain once a real frame is actually on screen. */
function dismissBootScreen() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 700);
}

// ---------------------------------------------------------------------------
//  Render-loop watchdog
// ---------------------------------------------------------------------------
/**
 * WebGL is not synchronous. `composer.render()` returns as soon as the frame's
 * commands are queued, not when the GPU has drawn them, so a loop that keeps
 * calling it regardless of how long the last frame actually took does not
 * "run slowly" — it runs *ahead*, piling driver-side command buffers on a
 * device that is already behind. That is how a stall turns into a crash: the
 * queue is memory, and on a phone the memory is what the browser kills the tab
 * over. It is also how a frame ends up on screen half-drawn, because the
 * compositor will present whatever surface is available when its deadline
 * arrives whether or not the rasteriser has finished with it.
 *
 * So the loop is allowed to skip a present. Skipping is cheap and it is
 * self-correcting: one skipped frame hands the GPU an entire frame's worth of
 * time with no new work, which is exactly what a backlog needs.
 */
/** A single frame this long has already missed a dozen vsyncs. Let it drain. */
const STALL_MS = 220;
/**
 * Sustained cost above this (~22 fps) means the GPU cannot afford the frame at
 * the current resolution. The answer is FEWER PIXELS, not fewer presents.
 *
 * This used to halve the present rate, and that was the wrong trade for a
 * racing game. Presenting every other frame does not reduce the work per frame
 * at all — it just shows half of it, so a 45ms frame becomes a 90ms *picture*
 * while the simulation carries on underneath. The player reported exactly what
 * that produces: "the frame rate or something seems slower... it doesn't feel
 * as fast as the odometer". Present cadence is what the eye reads as motion.
 * Dropping internal resolution instead makes the frame genuinely cheaper and
 * keeps every frame on screen.
 */
const SLOW_MS = 45;
/** Hysteresis, so the scale does not chatter around the threshold. */
const RECOVER_MS = 26;
/** Resolution rungs. Each is ~30% fewer pixels than the one above. */
const SCALE_RUNGS = [1, 0.85, 0.72, 0.6, 0.5];
/**
 * Frames between resolution changes. Every change reallocates the composer's
 * buffers, so reacting instantly to a transient would cost more than the
 * transient did.
 */
const SCALE_COOLDOWN = 90;
/** The watchdog stays out of the way until the scene has settled. */
const WATCHDOG_FROM_FRAME = 30;

/** EMA of the cost of frames we actually presented, milliseconds. */
let renderCostEma = 16.7;
/** Frames still to skip presenting. */
let skipRender = 0;
/** Index into SCALE_RUNGS; 0 is full resolution. */
let scaleRung = 0;
let scaleCooldown = 0;
let stallCount = 0;
let renderFailures = 0;
/** Set between context loss and a completed restore; nothing runs meanwhile. */
let suspended = false;

/**
 * Draw calls attributable to the SCENE, not the post chain.
 *
 * `renderer.info.render.calls` is reset by three at the top of every
 * `render()`, and the composer's final fullscreen pass is the last one in the
 * frame — so sampling after `composer.render()` reports the quad and nothing
 * else. The pipeline records the scene-pass count for us; fall back to the raw
 * counter when there is no composer.
 */
function sceneDrawCalls(): number {
  const recorded = (pipeline as unknown as { lastSceneCalls?: number }).lastSceneCalls;
  if (typeof recorded === 'number') return recorded;
  return ctx.renderer?.info.render.calls ?? 0;
}

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);

  const raw = (now - last) / 1000;
  last = now;

  // Context gone, or the tab is not being composited. Do not simulate, do not
  // draw, do not allocate — just keep the rAF alive so we notice when the world
  // comes back. (A hidden tab on iOS is the single most likely moment for the
  // GPU to reclaim our context, and continuing to queue frames into a surface
  // nobody is presenting is the worst possible way to spend that window.)
  if (suspended || document.hidden || pipeline.contextLost) return;

  // Clamp so a stalled tab or a breakpoint never teleports anything.
  // `__freeze` holds the simulation still while the screenshot harness retries a
  // torn capture: rendering continues, so the compositor can produce a clean
  // frame, but nothing advances — otherwise a retry lands seconds down the road
  // and the shot no longer shows what it was aimed at.
  const frozen = (window as any).__freeze === true;
  const dt = frozen ? 0 : Math.min(raw, 1 / 20);
  ctx.dt = dt;
  ctx.time += dt;
  ctx.frame++;

  const t0 = performance.now();

  for (const s of systems) s.update?.(ctx, dt);
  for (const s of systems) s.lateUpdate?.(ctx, dt);

  // The harness is entitled to a present on every frozen frame — retrying a
  // torn capture is the whole reason `__freeze` exists — and so are the first
  // few frames, which is where `__gameReady` and the boot curtain are decided.
  const maySkip = !frozen && ctx.frame > WATCHDOG_FROM_FRAME;
  let presented = false;
  // Nothing usable can be presented onto a surface that is hidden or collapsed,
  // and attempting it is how a one-pixel buffer reaches the compositor. The
  // simulation keeps running; only the present is withheld.
  if (!surfaceValid && maySkip) {
    // no present this frame
  } else if (skipRender > 0 && maySkip) {
    skipRender--;
  } else {
    presented = true;
    try {
      pipeline.render(ctx);
      renderFailures = 0;
      frameWatch.afterPresent(ctx);
      // Scene draws only — the post chain's fullscreen quads always run, so
      // counting everything would mask exactly the failure we are watching for.
      diagnostics.afterPresent(ctx, sceneDrawCalls());
    } catch (err) {
      renderFailures++;
      console.error(`[frame] render threw (${renderFailures} in a row)`, err);
      // A chain that throws once per frame is a black rectangle with a busy
      // CPU. Retreat to the direct render — which is a real, legible frame —
      // rather than keep failing in a more sophisticated way.
      if (renderFailures === 4) pipeline.disablePostProcessing('render threw four frames running');
      if (renderFailures >= 24) {
        console.error('[frame] renderer is not recoverable; suspending the loop');
        // The last frame that did draw stays on screen underneath. A stale
        // picture of the game with an explanation over it is a far better
        // failure than a black rectangle and a pegged CPU.
        pipeline.announce('Graphics stopped', 'Reload the page to start again.');
        suspended = true;
      }
    }
  }

  if (presented) {
    const cost = performance.now() - t0;
    renderCostEma += (cost - renderCostEma) * 0.12;
    if (cost > STALL_MS) {
      stallCount++;
      // Log the first few and then go quiet — a stall storm must not turn into
      // a console-write storm, which is itself a stall.
      if (stallCount <= 5) {
        console.warn(`[frame] ${Math.round(cost)}ms frame; skipping the next present to drain`);
      }
      skipRender = 1;
    } else if (ctx.frame <= WATCHDOG_FROM_FRAME) {
      // Boot frames are enormous — shader pre-warm, first-use uploads, the
      // PMREM bake — and they poison the average. Measured: the scaler dropped
      // a rung at frame 9 off a 56ms EMA that was entirely startup cost, on a
      // machine that then ran at 8ms. Hold the EMA at the target until the
      // scene has actually settled.
      renderCostEma = 16.7;
    } else if (scaleCooldown > 0) {
      scaleCooldown--;
    } else if (renderCostEma > SLOW_MS && scaleRung < SCALE_RUNGS.length - 1) {
      scaleRung++;
      scaleCooldown = SCALE_COOLDOWN;
      pipeline.setDynamicScale(SCALE_RUNGS[scaleRung]);
      console.warn(
        `[frame] sustained ${Math.round(renderCostEma)}ms frames; ` +
        `render scale -> ${SCALE_RUNGS[scaleRung]} (every frame still presented)`,
      );
    } else if (renderCostEma < RECOVER_MS && scaleRung > 0) {
      scaleRung--;
      scaleCooldown = SCALE_COOLDOWN;
      pipeline.setDynamicScale(SCALE_RUNGS[scaleRung]);
      console.info(`[frame] recovered; render scale -> ${SCALE_RUNGS[scaleRung]}`);
    }
  }

  if (ctx.frame === 8) {
    (window as any).__gameReady = true;
    dismissBootScreen();
  }
}

// ---------------------------------------------------------------------------
//  Resize
// ---------------------------------------------------------------------------
/**
 * Resize events are coalesced to one per animation frame and dropped entirely
 * when the size has not moved.
 *
 * iOS Safari fires `resize` continuously — dozens of events — while the URL bar
 * animates, on rotation, and whenever the on-screen keyboard appears. Each one
 * used to reach `composer.setSize`, which reallocates the HDR input and output
 * buffers, the AO targets, the entire bloom mip chain, the bokeh targets and
 * the SMAA buffers. Tens of megabytes of GPU allocation, tens of times, inside
 * one thumb gesture, on the device the player says crashes after ten seconds.
 *
 * `visualViewport` is listened to as well as `window`, because on iOS it is the
 * one that reports the URL-bar movement — and a `ResizeObserver` on `#app`
 * catches anything neither of them announces.
 */
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
}

function installResizeListeners() {
  addEventListener('resize', queueResize);
  addEventListener('orientationchange', queueResize);
  visualViewport?.addEventListener('resize', queueResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(queueResize).observe(parent);
}

/**
 * @param force push the size through even when it has not changed. Boot needs
 *   this: `ctx.width`/`ctx.height` are seeded from the same measurement, so an
 *   unconditional early-out would mean no system ever received its first
 *   `resize()` and every layout that is only computed there — the HUD's safe
 *   area, the minimap box — would keep whatever it guessed at construction.
 */
/**
 * True while the display surface is unusable (hidden pane, background tab,
 * mid-layout). The frame loop skips presenting rather than pushing a frame
 * built from stale or degenerate buffers.
 */
let surfaceValid = true;

function resize(force = false) {
  const size = viewportSize();
  if (size === null) {
    // Hidden or collapsed. Deliberately do NOT resize: tearing the buffers down
    // to 1x1 is what produced the black flash. Keep everything as it is and
    // wait to be shown again.
    surfaceValid = false;
    return;
  }
  const { w, h } = size;
  const wasInvalid = !surfaceValid;
  surfaceValid = true;
  if (!force && !wasInvalid && w === ctx.width && h === ctx.height) return;
  ctx.width = w;
  ctx.height = h;
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  for (const s of systems) s.resize?.(w, h);
}

// ---------------------------------------------------------------------------
//  WebGL context loss
// ---------------------------------------------------------------------------
/**
 * `RenderPipeline` handles the GL side — `preventDefault()` on the loss event
 * (without which the browser never offers a restore at all), tearing down the
 * composer, and rebuilding it against the new context. What is left here is
 * everything above the pipeline:
 *
 *   - the frame loop, which must stop on the same tick the context goes;
 *   - the PMREM environment probe, which is the one GPU resource in the game
 *     three cannot re-derive. Its texture is reallocated automatically but
 *     comes back EMPTY, because its contents were rendered once at boot: every
 *     metal, every clearcoat and every water surface in the game would have
 *     come back reflecting black;
 *   - the shader pre-warm, because the program cache died with the context and
 *     without it the first thirty seconds after a restore hitch exactly the way
 *     the first thirty seconds after a cold boot used to.
 */
function installContextRecovery() {
  pipeline.onContextLost = () => {
    suspended = true;
  };
  pipeline.onContextRestored = async () => {
    // Re-bake the sky into the environment probe. Costs a six-face render plus
    // a PMREM chain — the same price it pays at boot, and for the same reason.
    //
    // The `envRT` clear is a workaround for a latent bug in Sky.ts, which this
    // round is the first thing ever to call `refreshEnvironment()` on and which
    // therefore threw the first time it was asked to:
    //
    //   `PMREMGenerator._fromTexture` reads
    //     `const cubeUVRenderTarget = renderTarget || this._allocateTargets();`
    //   and `_allocateTargets()` is what creates `_lodMeshes`, `_blurMaterial`,
    //   `_ggxMaterial` and the ping-pong target. `Sky.buildEnvironment` builds a
    //   FRESH `PMREMGenerator` on every call and hands it the target from last
    //   time, so on the second call the allocation is skipped and
    //   `_textureToCubeUV` runs `this._lodMeshes[0].material = material` against
    //   an empty array — "Cannot set properties of undefined (setting
    //   'material')", which is exactly what the restore path logged.
    //
    // Dropping the cached target makes the generator allocate, which is the
    // right thing on this path anyway: the old target's GPU allocation died
    // with the context. The proper fix is in Sky.ts (reuse the generator, or
    // stop reusing the target) and belongs to whoever owns that file.
    try {
      (sky as unknown as { envRT: THREE.WebGLRenderTarget | null }).envRT = null;
      sky.refreshEnvironment(ctx);
    } catch (err) {
      console.error('[restore] environment re-bake failed', err);
    }

    try {
      const warm = await prewarm(ctx);
      console.info(`[restore] re-warmed ${warm.programsBefore} -> ${warm.programsAfter} programs in ${warm.ms}ms`);
    } catch (err) {
      console.error('[restore] pre-warm failed; expect compile hitches', err);
    }

    // Hand the simulation a fresh clock. Without this the first frame back sees
    // however many seconds the restore took as its delta — the clamp in the
    // loop stops it teleporting anything, but the watchdog would read that one
    // frame as a catastrophic stall and start skipping presents on a pipeline
    // that is in fact perfectly healthy.
    last = performance.now();
    renderCostEma = 16.7;
    skipRender = 0;
    scaleRung = 0;
    scaleCooldown = 0;
    pipeline.setDynamicScale(1);
    renderFailures = 0;
    suspended = false;
  };
}

multiplayer.start().then(() => boot()).catch((err) => {
  console.error('[boot] failed', err);
  document.body.innerHTML =
    `<pre style="color:#f66;padding:24px;font:13px ui-monospace">Boot failed:\n${err?.stack || err}</pre>`;
});

// Expose for the screenshot harness / debugging.
(window as any).__ctx = ctx;
// tools/perf.mjs turns this off to measure the un-LODed field for a before/after.
(window as any).__drawBudget = drawBudget;
(window as any).__camRig = camera; // TEMP-PROBE
(window as any).__multiplayer = multiplayer;
// Watchdog state, for the perf and soak harnesses: how many frames overran, and
// what resolution rung the adaptive scaler has settled on.
(window as any).__loopHealth = () => ({
  frame: ctx.frame,
  renderCostEma: +renderCostEma.toFixed(2),
  renderScale: SCALE_RUNGS[scaleRung],
  scaleRung,
  stalls: stallCount,
  renderFailures,
  suspended,
  contextLost: pipeline.contextLost,
});
