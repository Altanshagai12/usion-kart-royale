/**
 * Mobile stability gate.
 *
 *   node tools/mobile-soak.mjs [seconds]
 *
 * Emulates a phone, plays for real, and watches the things that actually kill a
 * tab on iOS: texture memory, JS heap growth, GPU object counts that never come
 * down, and WebGL context loss. iOS Safari jetsams a tab well under a desktop
 * heap limit, so "it works on my Mac" proves nothing — these numbers do.
 *
 * Exits non-zero if any budget is blown, so it can gate a workflow.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const SECONDS = parseFloat(process.argv[2] || '60');
const PORT = 5302;

// Budgets. iOS Safari commonly kills a tab somewhere between 300MB and 1GB of
// total process footprint depending on device and OS version, and textures are
// charged against that as well as against the GPU. These are deliberately
// conservative — a game that sits near the ceiling crashes on the older phone
// you did not test on.
const BUDGET = {
  textureMB: 80,
  heapGrowthMBPerMin: 40,
  heapPeakMB: 350,
  contextLosses: 0,
};

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: [
    '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--js-flags=--expose-gc',
    // Without this, `performance.memory.usedJSHeapSize` is quantised to a coarse
    // bucket and updated lazily, which is why identical code reported 202.2,
    // 227.9, 242.2 and 496.9 MB on four consecutive runs of this script. A gate
    // that swings 2.5x on a byte-identical build is not measuring the build.
    '--enable-precise-memory-info',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

// Forced GC before every heap sample, through the DevTools protocol. The budget
// below is about RETAINED memory — what iOS charges the tab and eventually
// jetsams it for — and an unswept heap is mostly garbage that has not been
// collected yet BECAUSE there is no memory pressure in a headless run. Sampled
// raw, this game reported up to 496.9MB against a 350MB budget while growing
// 0.0MB/min: a flat line half a gigabyte high is a measurement artefact, not a
// leak. Collected first, the same run reports its real footprint. Growth is
// still tracked, and a genuine leak still shows up — it survives the collection.
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');
const collect = async () => {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch { /* tab is gone */ }
};

const errors = [];
let crashed = false;
// A tab that is OOM-killed surfaces here, and every later evaluate() throws
// "detached Frame". That IS the bug we are hunting, so it must be reported as a
// result rather than escaping as a harness stack trace.
page.on('error', (e) => { crashed = true; errors.push('PAGE CRASHED: ' + String(e.message || e)); });
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Instrument context loss BEFORE the game can lose one.
await page.evaluate(() => {
  window.__ctxLost = 0;
  window.__ctxRestored = 0;
  const hook = () => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    c.addEventListener('webglcontextlost', () => { window.__ctxLost++; }, true);
    c.addEventListener('webglcontextrestored', () => { window.__ctxRestored++; }, true);
    return true;
  };
  if (!hook()) {
    const mo = new MutationObserver(() => { if (hook()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
});

await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const sample = async () => {
  await collect();
  return page.evaluate(() => {
  const ctx = window.__ctx, r = ctx?.renderer;
  const seen = new Set();
  let texBytes = 0;
  const walk = (t) => {
    if (!t?.isTexture || seen.has(t.uuid)) return;
    seen.add(t.uuid);
    const img = t.image || {};
    const w = img.width || 0, h = img.height || 0;
    if (w && h) texBytes += w * h * 4 * (t.generateMipmaps === false ? 1 : 1.334);
  };
  ctx?.scene?.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) for (const k in m) { const v = m[k]; if (v?.isTexture) walk(v); }
  });
  walk(ctx?.envMap);
  return {
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    heapLimitMB: performance.memory ? +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) : null,
    texMB: +(texBytes / 1048576).toFixed(1),
    glTextures: r?.info.memory.textures ?? 0,
    glGeometries: r?.info.memory.geometries ?? 0,
    programs: r?.info.programs?.length ?? 0,
    lost: window.__ctxLost, restored: window.__ctxRestored,
    quality: ctx?.settings?.quality,
    pixelRatio: r?.getPixelRatio?.() ?? 0,
  };
  });
};

// Start a race and play through it, exactly as a player would.
await page.evaluate(() => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.reset();
});

const t0 = Date.now();
const samples = [];
let frames = 0;
await page.evaluate(() => {
  window.__frames = 0;
  const tick = () => { window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

while ((Date.now() - t0) / 1000 < SECONDS && !crashed) {
  await new Promise((r) => setTimeout(r, 5000));
  let s;
  try {
    s = await sample();
  } catch (err) {
    crashed = true;
    errors.push('PAGE CRASHED (evaluate failed): ' + String(err).split('\n')[0]);
    break;
  }
  s.t = +((Date.now() - t0) / 1000).toFixed(0);
  try { s.frames = await page.evaluate(() => window.__frames); } catch { s.frames = 0; }
  samples.push(s);
  process.stdout.write(
    `  t=${String(s.t).padStart(3)}s  heap=${String(s.heapMB).padStart(6)}MB  ` +
    `tex=${String(s.texMB).padStart(6)}MB  glTex=${String(s.glTextures).padStart(4)}  ` +
    `geo=${String(s.glGeometries).padStart(4)}  prog=${String(s.programs).padStart(3)}  ` +
    `lost=${s.lost}\n`,
  );
}

if (!samples.length) {
  console.log('\nFAIL: the page died before the first sample');
  for (const e of errors.slice(0, 8)) console.log('   - ' + e.slice(0, 300));
  await browser.close(); srv.stop(); process.exit(1);
}
const first = samples[0], last = samples[samples.length - 1];
const minutes = (last.t - first.t) / 60 || 1;
const heapGrowth = last.heapMB != null ? (last.heapMB - first.heapMB) / minutes : 0;
const peakHeap = Math.max(...samples.map((s) => s.heapMB || 0));
const peakTex = Math.max(...samples.map((s) => s.texMB));
const fps = Math.round((last.frames - first.frames) / (last.t - first.t));

console.log('\n--- mobile soak ---');
console.log(`quality tier      : ${last.quality}  (0=Low 1=Medium 2=High 3=Ultra)`);
console.log(`pixel ratio       : ${last.pixelRatio}`);
console.log(`fps (software)    : ${fps}`);
console.log(`texture memory    : ${peakTex} MB      budget ${BUDGET.textureMB}`);
console.log(`heap peak         : ${peakHeap} MB     budget ${BUDGET.heapPeakMB}  (post-GC, retained)`);
console.log(`heap growth       : ${heapGrowth.toFixed(1)} MB/min  budget ${BUDGET.heapGrowthMBPerMin}`);
console.log(`GPU textures      : ${first.glTextures} -> ${last.glTextures}`);
console.log(`GPU geometries    : ${first.glGeometries} -> ${last.glGeometries}`);
console.log(`context lost      : ${last.lost}  restored: ${last.restored}`);
console.log(`page errors       : ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log('   - ' + e.slice(0, 200));

const fails = [];
if (peakTex > BUDGET.textureMB) fails.push(`texture memory ${peakTex}MB > ${BUDGET.textureMB}MB`);
if (peakHeap > BUDGET.heapPeakMB) fails.push(`heap peak ${peakHeap}MB > ${BUDGET.heapPeakMB}MB`);
if (heapGrowth > BUDGET.heapGrowthMBPerMin) fails.push(`heap growing ${heapGrowth.toFixed(1)}MB/min`);
if (last.lost > BUDGET.contextLosses) fails.push(`${last.lost} WebGL context losses`);
if (last.glGeometries > first.glGeometries * 1.5) fails.push(`GPU geometries growing ${first.glGeometries}->${last.glGeometries}`);
if (errors.length) fails.push(`${errors.length} page errors`);
if (crashed) fails.push('THE PAGE CRASHED — this is the mobile bug, reproduced');

console.log(fails.length ? '\nFAIL:\n  ' + fails.join('\n  ') : '\nPASS — within mobile budgets');
await browser.close();
srv.stop();
process.exit(fails.length ? 1 : 0);
