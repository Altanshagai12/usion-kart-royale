/**
 * The iPadOS-in-desktop-mode case.
 *
 * Safari on iPad defaults to "Request Desktop Website", under which it reports
 * `pointer: fine` and `maxTouchPoints: 0` — it claims to be a Mac. Eager
 * detection therefore says "desktop" and the on-screen pad never appears, which
 * is precisely the bug a player hits. This boots with touch signals scrubbed to
 * desktop values, asserts the pad is correctly absent, then delivers one real
 * touch and asserts the pad appears and steers.
 *
 * Also checks that the page itself cannot be pinch-zoomed or scrolled.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import puppeteer from 'puppeteer';

const root = new URL('..', import.meta.url).pathname;
const PORT = 5182;
const W = 1024, H = 768;

const open = (p) => new Promise((r) => {
  const s = createConnection({ port: p, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
  setTimeout(() => { s.destroy(); r(false); }, 800);
});

const srv = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
for (let i = 0; i < 90 && !(await open(PORT)); i++) await new Promise((r) => setTimeout(r, 400));

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
// Desktop viewport, desktop UA, hasTouch explicitly OFF — exactly what an iPad
// in desktop mode presents to the page.
await page.setViewport({ width: W, height: H, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
});

const cdp = await page.createCDPSession();
await page.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

const frames = (n = 8) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const t = () => (++i < k ? requestAnimationFrame(t) : res());
  requestAnimationFrame(t);
}), n);

const state = () => page.evaluate(() => ({
  mounted: !!document.querySelector('.tc-root'),
  touchMode: window.__ctx.input.touch,
  steer: +window.__ctx.input.state.steer.toFixed(3),
  htmlTouchAction: getComputedStyle(document.documentElement).touchAction,
  bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
  userScalable: (document.querySelector('meta[name=viewport]') || {}).content || '',
}));

const before = await state();

// One real touch, dispatched at the CDP layer so it is indistinguishable from a
// finger regardless of what the page thinks it is running on.
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
});

const stick = { x: 220, y: 520, id: 1 };
await touch('touchStart', [stick]);
await frames();
const afterTouch = await state();

await touch('touchMove', [{ ...stick, x: stick.x + 90 }]);
await frames(12);
const afterDrag = await state();

await touch('touchEnd', []);
await frames();

console.log(JSON.stringify({ before, afterTouch, afterDrag }, null, 2));

const ok =
  before.mounted === false &&                 // correctly quiet on a real desktop
  afterTouch.mounted === true &&              // a real finger reveals it
  afterTouch.touchMode === true &&
  afterDrag.steer > 0.5 &&                    // and it actually steers
  before.htmlTouchAction === 'none' &&        // page cannot pan or pinch
  before.bodyOverscroll === 'none';           // no pull-to-refresh

console.log(ok ? '\nPASS — lazy mount + gesture lockout correct' : '\nFAIL — see values above');
await browser.close();
srv.kill();
process.exit(ok ? 0 : 1);
