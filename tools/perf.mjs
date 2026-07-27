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
import { createConnection } from 'node:net';
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

const SHOTS = [
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

const AI_CRUISE = 36;
const APPROACH_TIMEOUT = 30;
const HOLD = 0.62;

function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 800);
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) return null;
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
        if (performance.now() < until) requestAnimationFrame(tick);
        else done(null);
      };
      requestAnimationFrame(tick);
    }), { ...shot, hold_still: !!shot.hold_still }, hold);

    const data = await page.evaluate(() => window.__perf.sample(20));
    const calls = data.frames.map((f) => f.total).sort((a, b) => a - b);
    const scene = data.frames.map((f) => f.scene).sort((a, b) => a - b);
    const med = (a) => a[Math.floor(a.length / 2)];
    const last = data.frames[data.frames.length - 1];
    report.shots.push({
      name: shot.name,
      reachedMark: waited.ok,
      totalCalls: { median: med(calls), min: calls[0], max: calls[calls.length - 1] },
      sceneCalls: { median: med(scene), min: scene[0], max: scene[scene.length - 1] },
      triangles: last.triangles,
      sceneTriangles: last.sceneTris,
      programs: last.programs,
      textures: last.textures,
      geometries: last.geometries,
      objects: data.objects,
    });
    process.stdout.write(
      `${shot.name.padEnd(9)} total=${med(calls)}  scene=${med(scene)}  ` +
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
