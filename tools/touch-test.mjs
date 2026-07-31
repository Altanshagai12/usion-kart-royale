/**
 * Verifies the on-screen controls on an emulated phone: that the pad mounts,
 * that dragging the left thumb actually steers, that the action buttons latch,
 * and — the case a single-pointer implementation gets wrong — that steering and
 * drifting work SIMULTANEOUSLY as two live touch points.
 *
 * Writes shots/touch/landscape.png for a look at the layout.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5181;
const W = 844, H = 390; // iPhone 14-ish, landscape

const open = (p) => new Promise((r) => {
  const s = createConnection({ port: p, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
  setTimeout(() => { s.destroy(); r(false); }, 800);
});

const srv = await startVite(PORT);

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });

await page.goto(`http://127.0.0.1:${PORT}/?quality=medium`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
  });
const frames = (n = 6) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const t = () => (++i < k ? requestAnimationFrame(t) : res());
  requestAnimationFrame(t);
}), n);

const read = () => page.evaluate(() => {
  const s = window.__ctx.input.state;
  return {
    steer: +s.steer.toFixed(3), accel: s.accel, brake: s.brake,
    drift: s.drift, mounted: !!document.querySelector('.tc-root'),
    touchMode: window.__ctx.input.touch,
  };
});

const results = {};
results.onLoad = await read();

// --- steer right: thumb lands left-of-centre, drags right --------------------
const stick = { x: 150, y: 260, id: 1 };
await touch('touchStart', [stick]);
await frames();
await touch('touchMove', [{ ...stick, x: stick.x + 70 }]);
await frames(10);
results.dragRight = await read();

// --- add a second finger on DRIFT while still steering ----------------------
const driftBtn = await page.evaluate(() => {
  const r = document.querySelector('.tc-drift').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await touch('touchStart', [{ ...stick, x: stick.x + 70 }, { ...driftBtn, id: 2 }]);
await frames(10);
results.steerPlusDrift = await read();

await page.screenshot({ path: (mkdirSync(join(root, 'shots/touch'), { recursive: true }), join(root, 'shots/touch/landscape.png')) });

// --- drag left --------------------------------------------------------------
await touch('touchEnd', []);
await frames();
await touch('touchStart', [stick]);
await frames();
await touch('touchMove', [{ ...stick, x: stick.x - 70 }]);
await frames(10);
results.dragLeft = await read();

// --- release: steering must return to centre and buttons must not latch ------
await touch('touchEnd', []);
await frames(20);
results.released = await read();

console.log(JSON.stringify(results, null, 2));

const ok =
  results.onLoad.mounted && results.onLoad.touchMode &&
  results.onLoad.accel === 1 &&               // auto-accelerate on by default
  results.dragRight.steer > 0.5 &&
  results.dragLeft.steer < -0.5 &&
  results.steerPlusDrift.drift === true && results.steerPlusDrift.steer > 0.5 &&
  results.released.steer === 0 && results.released.drift === false;

console.log(ok ? '\nPASS — touch controls behave correctly' : '\nFAIL — see values above');
await browser.close();
srv.stop();
process.exit(ok ? 0 : 1);
