import * as THREE from 'three';
import type { Ctx, System } from './types';
import { Bus } from './core/Bus';
import { createSettings } from './core/Settings';
import { Input } from './core/Input';
import { Recorder } from './core/Recorder';
import { prewarm } from './core/Prewarm';
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

const parent = document.getElementById('app')!;

const pipeline = new RenderPipeline(parent);
const input = new Input();
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

const ctx: Ctx = {
  renderer: null as any,
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, 3000),
  time: 0,
  dt: 0,
  frame: 0,
  width: innerWidth,
  height: innerHeight,
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
  pipeline, input, sky, materials, track, scenery, race, items, effects, camera, hud, audio,
  drawBudget,
];

/** Human-readable names for the boot progress readout, indexed with `systems`. */
const SYSTEM_LABELS = [
  'starting renderer', 'reading controls', 'raising the sun', 'mixing materials',
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
  addEventListener('resize', resize);
  resize();

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

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  // Clamp so a stalled tab or a breakpoint never teleports anything.
  // `__freeze` holds the simulation still while the screenshot harness retries a
  // torn capture: rendering continues, so the compositor can produce a clean
  // frame, but nothing advances — otherwise a retry lands seconds down the road
  // and the shot no longer shows what it was aimed at.
  const dt = (window as any).__freeze ? 0 : Math.min(raw, 1 / 20);
  ctx.dt = dt;
  ctx.time += dt;
  ctx.frame++;

  for (const s of systems) s.update?.(ctx, dt);
  for (const s of systems) s.lateUpdate?.(ctx, dt);
  pipeline.render(ctx);

  if (ctx.frame === 8) {
    (window as any).__gameReady = true;
    dismissBootScreen();
  }
}

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  ctx.width = w;
  ctx.height = h;
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
  for (const s of systems) s.resize?.(w, h);
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  document.body.innerHTML =
    `<pre style="color:#f66;padding:24px;font:13px ui-monospace">Boot failed:\n${err?.stack || err}</pre>`;
});

// Expose for the screenshot harness / debugging.
(window as any).__ctx = ctx;
// tools/perf.mjs turns this off to measure the un-LODed field for a before/after.
(window as any).__drawBudget = drawBudget;
