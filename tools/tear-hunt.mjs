/**
 * Reproduces and diagnoses the "black partial render" the player sees on
 * DESKTOP Chrome.
 *
 * The iOS visual-viewport fix was a real bug but cannot explain a desktop
 * sighting, so this measures the artifact directly instead of theorising:
 * captures many frames back to back at desktop quality, finds the vertical seam
 * in any torn one, and — the part that matters — records what the renderer, the
 * canvas and the composer each believed their size was on the frame that tore.
 *
 *   node tools/tear-hunt.mjs [frames] [quality]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const FRAMES = parseInt(process.argv[2] || '60', 10);
const QUALITY = process.argv[3] || 'high';
const PORT = 5303;
const W = 1280, H = 720;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/?quality=${QUALITY}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

// Drive, so the frames under test are real gameplay frames.
await page.evaluate(() => { window.__ctx.race.autoDrive = true; window.__ctx.race.reset(); });
await new Promise((r) => setTimeout(r, 4000));

/** What every layer thinks the frame size is, sampled at capture time. */
const sizes = () => page.evaluate(() => {
  const ctx = window.__ctx;
  const r = ctx.renderer;
  const pipe = window.__render;
  const drawing = { w: r.domElement.width, h: r.domElement.height };
  const css = { w: r.domElement.clientWidth, h: r.domElement.clientHeight };
  const style = { w: r.domElement.style.width, h: r.domElement.style.height };
  let composer = null;
  try {
    const c = pipe?.composer;
    const rt = c?.inputBuffer;
    if (rt) composer = { w: rt.width, h: rt.height };
  } catch { /* ignore */ }
  return {
    drawing, css, style, composer,
    pixelRatio: r.getPixelRatio(),
    renderScale: ctx.settings.renderScale,
    vpW: innerWidth, vpH: innerHeight,
    appW: document.getElementById('app')?.clientWidth,
    appH: document.getElementById('app')?.clientHeight,
  };
});

/**
 * A torn frame is dark on one side of a vertical seam. Scan column means and
 * look for a step, rather than a whole-frame darkness test, so a legitimately
 * dark scene is not mistaken for a tear.
 */
const analyse = (b64) => page.evaluate(async (data) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + data;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const cols = new Float64Array(c.width);
  let dark = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      cols[x] += l;
      if (l <= 8) dark++;
    }
  }
  for (let x = 0; x < c.width; x++) cols[x] /= c.height;
  // biggest single-column step
  let seamX = -1, seamDrop = 0;
  for (let x = 1; x < c.width; x++) {
    const drop = cols[x - 1] - cols[x];
    if (Math.abs(drop) > Math.abs(seamDrop)) { seamDrop = drop; seamX = x; }
  }
  return {
    darkFrac: +(dark / (c.width * c.height)).toFixed(4),
    seamX, seamDrop: +seamDrop.toFixed(1),
    seamFrac: +(seamX / c.width).toFixed(3),
    meanLuma: +(cols.reduce((a, b) => a + b, 0) / c.width).toFixed(1),
  };
}, b64);

mkdirSync(join(root, 'shots/tear'), { recursive: true });
const torn = [];
let checked = 0;

for (let i = 0; i < FRAMES; i++) {
  const before = await sizes();
  const buf = await page.screenshot({ type: 'png' });
  const m = await analyse(Buffer.from(buf).toString('base64'));
  const after = await sizes();
  checked++;
  // A tear: a big dark region AND a hard vertical step. Either alone is normal.
  const isTorn = m.darkFrac > 0.05 && Math.abs(m.seamDrop) > 25;
  if (isTorn) {
    const file = join(root, `shots/tear/torn-${String(torn.length).padStart(2, '0')}.png`);
    writeFileSync(file, buf);
    torn.push({ i, ...m, before, after, file });
  }
  process.stdout.write(`\r  frame ${i + 1}/${FRAMES}  torn so far: ${torn.length}   `);
}
console.log();

console.log('\n--- tear hunt ---');
console.log(`quality      : ${QUALITY}`);
console.log(`frames       : ${checked}`);
console.log(`torn         : ${torn.length}  (${((torn.length / checked) * 100).toFixed(1)}%)`);
console.log(`page errors  : ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('   - ' + e.slice(0, 200));

const s = await sizes();
console.log('\nsizes (steady state):');
console.log(`  drawing buffer : ${s.drawing.w} x ${s.drawing.h}`);
console.log(`  canvas CSS     : ${s.css.w} x ${s.css.h}   (inline style: ${s.style.w} x ${s.style.h})`);
console.log(`  composer input : ${s.composer ? s.composer.w + ' x ' + s.composer.h : '(none)'}`);
console.log(`  #app           : ${s.appW} x ${s.appH}`);
console.log(`  window         : ${s.vpW} x ${s.vpH}`);
console.log(`  pixelRatio ${s.pixelRatio}  renderScale ${s.renderScale}`);
console.log(`  expected buffer: ${Math.round(s.appW * s.pixelRatio)} x ${Math.round(s.appH * s.pixelRatio)}`);

if (torn.length) {
  console.log('\ntorn frames:');
  for (const t of torn.slice(0, 10)) {
    console.log(`  #${t.i}  dark=${(t.darkFrac * 100).toFixed(1)}%  seam at x=${t.seamX} (${(t.seamFrac * 100).toFixed(0)}% across)  step=${t.seamDrop}  -> ${t.file}`);
    console.log(`        buffer ${t.before.drawing.w}x${t.before.drawing.h} composer ${t.before.composer ? t.before.composer.w + 'x' + t.before.composer.h : '-'}`);
  }
}

await browser.close();
srv.stop();
