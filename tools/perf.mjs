/**
 * Draw-call / triangle instrumentation harness.
 *
 *   node tools/perf.mjs --only hero,wide,pack --settle 3 --w 1280 --h 720
 *
 * Drives the game to the same vantage points as tools/shot.mjs, but instead of
 * writing a PNG it reads renderer.info with `autoReset = false`, reset by hand
 * around the *scene* pass, and attributes every draw to an object via
 * `onBeforeRender` / `onBeforeShadow`.
 *
 * Why the manual reset: with autoReset on, three resets `info` at the top of
 * every `render()` call, and the composer's final fullscreen pass is the last
 * one — so anything reading `info.render.calls` after `composer.render()` sees
 * the quad and nothing else. That is the bug that hid 300 draw calls.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const OUT = join(root, arg('out', 'shots/perf'));
const W = parseInt(arg('w', '1280'), 10);
const H = parseInt(arg('h', '720'), 10);
const SETTLE = parseFloat(arg('settle', '3'));
const PORT = parseInt(arg('port', '5173'), 10);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const LABEL = arg('label', 'run');
/**
 * Undo every draw-call optimisation from inside the page, so a before/after can
 * be measured in one session at one resolution instead of across two checkouts.
 * Restores: the kart LOD director, the fifteen-mesh kart as its own shadow
 * caster, kerb shadows, and every scenery set that is now on the noCast list.
 */
const BASELINE = argv.includes('--baseline');

/**
 * The nine standard vantage points are all *clean* frames: the field is spread
 * out and nothing is going off. The draw-call peak of a real race is not there,
 * it is in the moments the shot list never reaches — the whole field nose to
 * tail, every kart at max drift tier with boost lit and a triple-mushroom orbit
 * up, which is every per-kart mesh visible at once on top of every FX pool.
 *
 * `stress: true` forces that state on every kart during the hold, so the number
 * reported is the worst frame the game can actually produce rather than the
 * worst frame the screenshot harness happens to catch.
 */
const STRESS_SHOTS = [
  { name: 'chaos-pack',  t: 0.74, speed: 26, ahead: 7, stress: 1 },
  { name: 'chaos-grid',  t: 0.995, speed: 0, settle: 1.1, hold_still: true, stress: 1 },
  { name: 'chaos-scene', t: 0.86, speed: 22, ahead: 7, stress: 1 },
];

const BASE_SHOTS = [
  { name: 'hero',    t: 0.06, speed: 24 },
  { name: 'grid',    t: 0.995, speed: 0, settle: 1.1, hold_still: true },
  { name: 'boost',   t: 0.40, speed: 32, boost: 1 },
  { name: 'corner',  t: 0.58, speed: 22 },
  { name: 'pack',    t: 0.74, speed: 25, ahead: 4 },
  { name: 'scenery', t: 0.86, speed: 20 },
  { name: 'wide',    t: 0.30, speed: 18, cam: 'wide' },
  { name: 'closeup', t: 0.50, speed: 14, cam: 'close' },
  { name: 'hud',     t: 0.14, speed: 28 },
];

const SHOTS = argv.includes('--stress') ? [...BASE_SHOTS, ...STRESS_SHOTS] : BASE_SHOTS;

const AI_CRUISE = 36;
const APPROACH_TIMEOUT = 30;
const HOLD = 0.62;

/**
 * Delegates to the shared helper, exactly as tools/shot.mjs does.
 *
 * This used to pre-check the port itself and return `null` when something was
 * already serving it, which teardown then dereferenced: every run that adopted
 * a server — a developer's own `npm run dev`, or simply a second harness run
 * against a still-warm port — did all its work, wrote its JSON, and then died
 * on `server.stop()` with "Cannot read properties of null". Exit code 1 and no
 * result line, on a run that had in fact succeeded.
 *
 * `startVite` already distinguishes the two cases and is the only thing that
 * should: it adopts a live port and hands back a no-op `stop()` so a server we
 * did not start is never killed. Asking the question twice, in two places, with
 * two different return shapes, is what produced the crash.
 */
async function ensureServer() {
  return startVite(PORT);
}

/** Installed in the page: hooks the renderer and attributes draws to objects. */
const INSTALL = () => {
  const ctx = window.__ctx;
  const renderer = ctx.renderer;
  renderer.info.autoReset = false;

  const bucketOf = (o) => {
    // Walk to the top-level child of the scene, collecting the most specific
    // named ancestor on the way.
    const names = [];
    let n = o;
    let top = o;
    while (n && n.parent) {
      if (n.name) names.push(n.name);
      if (n.parent === ctx.scene) top = n;
      n = n.parent;
    }
    const topName = top.name || top.type;
    return { top: topName, path: names.slice().reverse().join('/') || (o.name || o.type) };
  };

  const stats = new Map();
  const key = (o) => {
    const b = bucketOf(o);
    const mat = Array.isArray(o.material) ? o.material.map((m) => m.type).join('+') : (o.material && o.material.type);
    return b.top + ' | ' + b.path + ' | ' + o.type + ' | ' + (o.geometry && o.geometry.type) + ' | ' + mat;
  };

  const tris = (o) => {
    const g = o.geometry;
    if (!g) return 0;
    const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    let n = idx / 3;
    if (o.isInstancedMesh) n *= o.count;
    if (o.isPoints) n = 0;
    if (o.isLine) n = 0;
    return n;
  };

  const bump = (o, field) => {
    const k = key(o);
    let s = stats.get(k);
    if (!s) { s = { k, scene: 0, shadow: 0, tris: 0, instances: 0, frames: 0 }; stats.set(k, s); }
    s[field]++;
    if (field === 'scene') { s.tris += tris(o); s.instances += (o.isInstancedMesh ? o.count : 1); }
  };

  const hooked = new WeakSet();
  const hookAll = () => {
    ctx.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (hooked.has(o)) return;
      hooked.add(o);
      const prevR = o.onBeforeRender;
      o.onBeforeRender = function (...a) { bump(this, 'scene'); return prevR.apply(this, a); };
      const prevS = o.onBeforeShadow;
      o.onBeforeShadow = function (...a) { bump(this, 'shadow'); return prevS.apply(this, a); };
    });
  };

  // Frame totals, straddling the whole composer chain and the scene pass alone.
  const frames = [];
  const rawRender = renderer.render.bind(renderer);
  let sceneDelta = null;
  let passes = [];
  renderer.render = function (scene, camera) {
    const before = renderer.info.render.calls;
    const beforeT = renderer.info.render.triangles;
    rawRender(scene, camera);
    const d = renderer.info.render.calls - before;
    passes.push(d);
    // The biggest render() inside a composed frame is the scene pass; the
    // others are tiny helper renders (env probes, minimap).
    if (sceneDelta === null || d > sceneDelta.calls) {
      sceneDelta = { calls: d, tris: renderer.info.render.triangles - beforeT };
    }
    return undefined;
  };

  window.__perf = {
    hookAll,
    reset() { stats.clear(); frames.length = 0; },
    sample(n) {
      return new Promise((done) => {
        hookAll();
        stats.clear();
        frames.length = 0;
        let i = 0;
        const tick = () => {
          renderer.info.reset();
          sceneDelta = null;
          passes = [];
          requestAnimationFrame(() => {
            const inf = renderer.info;
            frames.push({
              passes: passes.slice(),
              total: inf.render.calls,
              triangles: inf.render.triangles,
              scene: sceneDelta ? sceneDelta.calls : 0,
              sceneTris: sceneDelta ? sceneDelta.tris : 0,
              programs: inf.programs ? inf.programs.length : 0,
              textures: inf.memory.textures,
              geometries: inf.memory.geometries,
            });
            if (++i < n) tick();
            else {
              const arr = [...stats.values()].map((s) => ({
                key: s.k, scene: s.scene / n, shadow: s.shadow / n,
                tris: s.tris / n, instances: s.instances / n,
              }));
              arr.sort((a, b) => (b.scene + b.shadow) - (a.scene + a.shadow));
              done({ frames, objects: arr, n });
            }
          });
        };
        tick();
      });
    },
  };
};

const main = async () => {
  const server = await ensureServer();
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-webgl',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${W},${H}`, '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

  await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });
  if (BASELINE) {
    await page.evaluate(() => {
      const ctx = window.__ctx;
      window.__drawBudget.enabled = false;
      for (const k of ctx.race.karts) {
        k.object.traverse((o) => {
          if (o.userData && o.userData.detailNodes) {
            for (const n of o.userData.detailNodes) n.visible = true;
          }
          if (!o.isMesh) return;
          if (o.name === 'kartImpostor') { o.visible = false; o.castShadow = false; return; }
          if (o.name === 'shadowBlob') return;
          o.castShadow = true;
        });
      }
      const restore = ['kerbs', 'marshalFlag', 'flag', 'rig0', 'rig1', 'net', 'lampGlow', 'glass'];
      for (const n of restore) {
        const m = ctx.scene.getObjectByName(n);
        if (m) m.castShadow = true;
      }
    });
  }
  await page.evaluate(INSTALL);

  const report = { label: LABEL, w: W, h: H, shots: [], errors };

  for (const shot of SHOTS) {
    if (ONLY.length && !ONLY.includes(shot.name)) continue;
    const hold = HOLD;

    await page.evaluate((s, hold) => {
      const ctx = window.__ctx;
      const race = ctx.race, track = ctx.track, player = race.player;
      race.autoDrive = true;
      race.driveOverride = null;
      const back = s.hold_still ? 0 : (s.cruise * (s.settle + hold) * 1.2) / track.length;
      race.karts.forEach((k, i) => {
        const t = ((s.t - i * 0.006 - back) % 1 + 1) % 1;
        const smp = track.sample(t);
        const lane = ((i % 2) * 2 - 1) * (2.6 + (i >> 1) * 0.4);
        const p = smp.pos.clone().addScaledVector(smp.binormal, lane);
        k.placeAt?.(p, Math.atan2(smp.tangent.x, smp.tangent.z), t);
        k.velocity.copy(k.forward).multiplyScalar(s.speed);
      });
      if (s.boost) player.applyBoost(3, 1.2);
      ctx.speedIntensity = Math.min(1.2, s.speed / 30);
      race.state = s.name === 'grid' ? 1 : 2;
      window.__camMode = s.cam || 'chase';
    }, { ...shot, settle: shot.settle ?? SETTLE, cruise: AI_CRUISE }, hold);

    const waited = await page.evaluate((s, hold, timeout) => new Promise((done) => {
      const ctx = window.__ctx, k = ctx.race.player, len = ctx.track.length;
      const t0 = performance.now();
      const mark = ((s.t - (s.speed * hold) / len) % 1 + 1) % 1;
      const gap = (a, b) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);
      const tick = () => {
        const e = (performance.now() - t0) / 1000;
        if (e >= s.settle) {
          if (s.hold_still) return done({ ok: true, why: 'stationary' });
          if (gap(k.t, mark) < 0.004) return done({ ok: true, why: 'on mark' });
        }
        if (e > timeout) return done({ ok: false, why: 'gave up at t=' + k.t.toFixed(3) });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), { ...shot, settle: shot.settle ?? SETTLE }, hold, APPROACH_TIMEOUT);

    await page.evaluate((s, hold) => new Promise((done) => {
      const ctx = window.__ctx, k = ctx.race.player;
      if (s.ahead) {
        const track = ctx.track;
        const others = ctx.race.karts.filter((x) => x !== k);
        for (let i = 0; i < s.ahead && i < others.length; i++) {
          const t = ((k.t + 0.004 + i * 0.0035) % 1 + 1) % 1;
          const smp = track.sample(t);
          const lane = ((i % 2) * 2 - 1) * (2.2 + (i >> 1) * 1.4);
          const p = smp.pos.clone().addScaledVector(smp.binormal, lane);
          others[i].placeAt?.(p, Math.atan2(smp.tangent.x, smp.tangent.z), t);
          others[i].velocity.copy(others[i].forward).multiplyScalar(s.speed);
        }
      }
      const until = performance.now() + hold * 1000;
      const tick = () => {
        if (!s.hold_still) {
          const cur = k.velocity.dot(k.forward);
          k.velocity.addScaledVector(k.forward, (s.speed - cur) * 0.25);
        }
        if (s.boost && k.boostTime < 0.6) k.applyBoost(1.2, 1.2);
        // Worst-case FX: hold the whole field at max drift tier with boost lit
        // and a triple-mushroom orbit up. Re-applied every frame because the
        // kart integrator decays all three.
        if (s.stress) {
          for (let i = 0; i < ctx.race.karts.length; i++) {
            const kk = ctx.race.karts[i];
            ctx.items.give(kk, 2 /* TripleMushroom */, 3);
            if (kk.boostTime < 0.6) kk.applyBoost(1.2, 1.25);
            kk.driftDir = i % 2 ? 1 : -1;
            kk.driftCharge = 1;
            kk.driftTier = 3;
          }
          ctx.speedIntensity = 1.2;
        }
        if (performance.now() < until) requestAnimationFrame(tick);
        else done(null);
      };
      requestAnimationFrame(tick);
    }), { ...shot, hold_still: !!shot.hold_still }, hold);

    const data = await page.evaluate(() => window.__perf.sample(30));
    const med = (a) => a[Math.floor(a.length / 2)];
    /**
     * Frame counts here are bimodal, and a plain median over the sample is not
     * a stable statistic: the far shadow cascade redraws one frame in three
     * (FAR_UPDATE_INTERVAL in render/Sky), and on that frame every shadow
     * caster in the world is submitted a second time. Depending on where the
     * 30-frame window lands relative to that cycle, the median can sit in
     * either cluster, which is worth ~40 draw calls and swamps the effect of
     * any change being measured.
     *
     * So split the sample at the midpoint of its own range and report both
     * populations: `typical` is the frame the budget actually governs, `cascade`
     * is the one-in-three refresh frame.
     */
    const split = (vals) => {
      const a = vals.slice().sort((x, y) => x - y);
      const mid = (a[0] + a[a.length - 1]) / 2;
      const lo = a.filter((v) => v < mid);
      const hi = a.filter((v) => v >= mid);
      return {
        typical: lo.length ? med(lo) : med(a),
        cascade: hi.length ? med(hi) : med(a),
        median: med(a), min: a[0], max: a[a.length - 1],
        cascadeShare: +(hi.length / a.length).toFixed(2),
      };
    };
    const calls = data.frames.map((f) => f.total);
    const scene = data.frames.map((f) => f.scene);
    const last = data.frames[data.frames.length - 1];
    report.shots.push({
      name: shot.name,
      reachedMark: waited.ok,
      totalCalls: split(calls),
      sceneCalls: split(scene),
      triangles: last.triangles,
      sceneTriangles: last.sceneTris,
      programs: last.programs,
      textures: last.textures,
      geometries: last.geometries,
      objects: data.objects,
    });
    const t = report.shots[report.shots.length - 1].totalCalls;
    process.stdout.write(
      `${shot.name.padEnd(11)} typical=${String(t.typical).padStart(3)}  ` +
      `cascade=${String(t.cascade).padStart(3)}  peak=${String(t.max).padStart(3)}  ` +
      `tris=${(last.triangles / 1000).toFixed(0)}k  progs=${last.programs} texs=${last.textures}\n`);
  }

  writeFileSync(join(OUT, `perf-${LABEL}.json`), JSON.stringify(report, null, 2));
  await browser.close();
  server.stop();
  if (errors.length) {
    console.log(`\n!! ${errors.length} console errors:`);
    for (const e of errors.slice(0, 10)) console.log('  - ' + e.slice(0, 300));
  }
  console.log(`\n-> ${join(OUT, `perf-${LABEL}.json`)}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
