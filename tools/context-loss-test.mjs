/**
 * Context-loss recovery gate.
 *
 *   node tools/context-loss-test.mjs
 *
 * A context-loss handler that has never been exercised is not a handler. This
 * boots the real game, takes the WebGL context away with WEBGL_lose_context —
 * the same way a phone does when the OS reclaims the GPU — hands it back, and
 * then insists on evidence that the game came back:
 *
 *   1. 'webglcontextlost' fired and was preventDefault()ed (without that the
 *      browser never offers a restore at all);
 *   2. 'webglcontextrestored' fired;
 *   3. the composer object is a NEW one (rebuilt, not the corpse of the old);
 *   4. rAF is running again and the frame counter is climbing;
 *   5. the canvas is not black — sampled from a real screenshot, because
 *      "frames are being submitted" and "pixels are arriving" are different
 *      claims and only the second one is what the player sees.
 *
 * Exits non-zero if any of those is missing.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5395;
const RESTORE_AFTER_MS = 1200;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message || e)));
page.on('error', (e) => errors.push('CRASH: ' + String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Instrument before the game can lose anything. `defaultPrevented` is read on
// the SAME event object the app's listener saw, which is the only way to prove
// preventDefault() was actually called rather than merely present in source.
await page.evaluate(() => {
  const w = window;
  w.__cl = { lost: 0, restored: 0, prevented: 0, frames: 0 };
  const hook = () => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    // Bubble phase: runs after the app's own (non-capture) listener, so
    // defaultPrevented reflects what the app did.
    c.addEventListener('webglcontextlost', (e) => {
      w.__cl.lost++;
      if (e.defaultPrevented) w.__cl.prevented++;
    }, false);
    c.addEventListener('webglcontextrestored', () => { w.__cl.restored++; }, false);
    return true;
  };
  if (!hook()) {
    const mo = new MutationObserver(() => { if (hook()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  const tick = () => { w.__cl.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
await page.evaluate(() => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.reset();
});
await new Promise((r) => setTimeout(r, 2500));

/**
 * Decoded in the page: Node has no PNG decoder here, and `Buffer.from` on the
 * way in matters — puppeteer returns a plain Uint8Array whose toString ignores
 * 'base64' and yields "137,80,78,...".
 */
const shot = async (name) => {
  const buf = await page.screenshot({ type: 'png' });
  const m = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, dark = 0;
    const n = c.width * c.height;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l <= 8) dark++;
    }
    return { luma: +(sum / n).toFixed(1), darkFrac: +(dark / n).toFixed(4) };
  }, Buffer.from(buf).toString('base64'));
  return { name, ...m };
};

const before = await shot('before');
const stateBefore = await page.evaluate(() => {
  const r = window.__render;
  return {
    composerId: r?.composer ? (r.composer.__probeId ??= Math.random().toString(36).slice(2)) : null,
    hasComposer: !!r?.composer,
    contextLost: r?.contextLost,
    programs: r?.renderer?.info?.programs?.length ?? 0,
    frames: window.__cl.frames,
  };
});
console.log('before loss :', JSON.stringify({ ...before, ...stateBefore }));

// --- take the context away -------------------------------------------------
// Straight through the extension, not through the app's own debug helper, so
// this exercises the listeners exactly as a real driver reset would.
const lostOk = await page.evaluate((ms) => {
  const gl = window.__render.renderer.getContext();
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return false;
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), ms);
  return true;
}, RESTORE_AFTER_MS);
if (!lostOk) {
  console.log('\nINCONCLUSIVE: WEBGL_lose_context not exposed by this GL backend');
  await browser.close(); srv.stop(); process.exit(2);
}

// While it is down: the page must not be a black rectangle. The last good frame
// stays on the canvas and a notice sits over it.
await new Promise((r) => setTimeout(r, 600));
const during = await shot('during');
const stateDuring = await page.evaluate(() => ({
  contextLost: window.__render?.contextLost,
  hasComposer: !!window.__render?.composer,
  notice: document.getElementById('gl-notice')?.textContent?.slice(0, 60) ?? null,
  lost: window.__cl.lost, prevented: window.__cl.prevented, restored: window.__cl.restored,
}));
console.log('during loss :', JSON.stringify({ ...during, ...stateDuring }));

// --- and back --------------------------------------------------------------
const deadline = Date.now() + 25000;
let restored = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await page.evaluate(() => ({
    restored: window.__cl.restored,
    contextLost: window.__render?.contextLost,
    hasComposer: !!window.__render?.composer,
    notice: !!document.getElementById('gl-notice'),
  }));
  if (s.restored > 0 && s.contextLost === false && s.hasComposer && !s.notice) { restored = true; break; }
}

// Let it draw for a while so the "is it rendering" answer is about steady state.
const framesAtRestore = await page.evaluate(() => window.__cl.frames);
await new Promise((r) => setTimeout(r, 3000));

const after = await shot('after');
const stateAfter = await page.evaluate(() => {
  const r = window.__render;
  return {
    composerId: r?.composer ? (r.composer.__probeId ??= Math.random().toString(36).slice(2)) : null,
    hasComposer: !!r?.composer,
    contextLost: r?.contextLost,
    programs: r?.renderer?.info?.programs?.length ?? 0,
    frames: window.__cl.frames,
    notice: !!document.getElementById('gl-notice'),
    lost: window.__cl.lost, prevented: window.__cl.prevented, restoredCount: window.__cl.restored,
  };
});
console.log('after       :', JSON.stringify({ ...after, ...stateAfter }));

const fps = Math.round((stateAfter.frames - framesAtRestore) / 3);

console.log('\n--- context loss recovery ---');
console.log(`webglcontextlost fired      : ${stateAfter.lost}`);
console.log(`  ...and preventDefault()ed : ${stateAfter.prevented}`);
console.log(`webglcontextrestored fired  : ${stateAfter.restoredCount}`);
console.log(`composer rebuilt (new obj)  : ${stateBefore.composerId !== stateAfter.composerId} (${stateBefore.composerId} -> ${stateAfter.composerId})`);
console.log(`programs                    : ${stateBefore.programs} -> ${stateAfter.programs}`);
console.log(`fps after restore           : ${fps}`);
console.log(`notice cleared              : ${!stateAfter.notice}`);
console.log(`luma  before/during/after   : ${before.luma} / ${during.luma} / ${after.luma}`);
console.log(`dark% before/during/after   : ${(before.darkFrac * 100).toFixed(2)} / ${(during.darkFrac * 100).toFixed(2)} / ${(after.darkFrac * 100).toFixed(2)}`);
console.log(`page errors                 : ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('   - ' + e.slice(0, 220));

const fails = [];
if (stateAfter.lost < 1) fails.push('webglcontextlost never fired');
if (stateAfter.prevented < 1) fails.push('webglcontextlost was NOT preventDefault()ed — restore can never happen');
if (stateAfter.restoredCount < 1) fails.push('webglcontextrestored never fired');
if (!restored) fails.push('pipeline never reported itself restored');
if (stateAfter.contextLost !== false) fails.push('renderer still flagged contextLost');
if (!stateAfter.hasComposer) fails.push('composer was not rebuilt');
if (stateBefore.composerId === stateAfter.composerId) fails.push('composer is the same object — not rebuilt');
if (during.darkFrac > 0.9) fails.push('page went black during the outage');
if (after.darkFrac > 0.5 || after.luma < 12) fails.push(`frame after restore is black (luma ${after.luma}, dark ${(after.darkFrac * 100).toFixed(1)}%)`);
if (fps < 10) fails.push(`rendering did not resume (${fps} fps)`);
if (stateAfter.notice) fails.push('the "graphics paused" notice was never taken down');
if (errors.length) fails.push(`${errors.length} page errors`);

console.log(fails.length ? '\nFAIL:\n  ' + fails.join('\n  ') : '\nPASS — context loss recovers');
await browser.close();
srv.stop();
process.exit(fails.length ? 1 : 0);
