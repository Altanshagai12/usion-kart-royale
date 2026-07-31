import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 5186;
const width = 390;
const height = 844;
const server = await startVite(port);
let browser;

try {
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.setViewport({
    width, height, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await page.goto(`http://127.0.0.1:${port}/?quality=medium`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90_000 });

  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, index) => ({
      x: point.x, y: point.y, id: point.id ?? index,
      radiusX: 12, radiusY: 12, force: 1,
    })),
  });
  const frames = (count = 8) => page.evaluate((total) => new Promise((resolve) => {
    let frame = 0;
    const next = () => (++frame < total ? requestAnimationFrame(next) : resolve());
    requestAnimationFrame(next);
  }), count);

  const layout = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      logical: { width: window.__ctx.width, height: window.__ctx.height },
      canvasClient: { width: canvas.clientWidth, height: canvas.clientHeight },
      physicalRect: { width: rect.width, height: rect.height },
      blocker: !!document.querySelector('.tc-rotate'),
      controls: !!document.querySelector('.tc-root'),
    };
  });

  const stick = { x: 130, y: 170, id: 1 };
  await touch('touchStart', [stick]);
  await frames();
  // Clockwise body rotation: physical down is logical right.
  await touch('touchMove', [{ ...stick, y: stick.y + 72 }]);
  await frames(10);
  const steer = await page.evaluate(() => window.__ctx.input.state.steer);

  const drift = await page.evaluate(() => {
    const rect = document.querySelector('.tc-drift').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, id: 2 };
  });
  await touch('touchStart', [{ ...stick, y: stick.y + 72 }, drift]);
  await frames(8);
  const combined = await page.evaluate(() => ({
    steer: window.__ctx.input.state.steer,
    drift: window.__ctx.input.state.drift,
  }));
  const shots = join(root, 'shots', 'touch');
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'portrait-virtual-landscape.png') });
  await touch('touchEnd', []);
  await page.setViewport({
    width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  await frames(12);
  const resized = await page.evaluate(() => ({
    width: window.__ctx.width,
    height: window.__ctx.height,
  }));

  await page.setViewport({
    width: 500, height: 500, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  await frames(12);
  const squareStick = { x: 150, y: 180, id: 3 };
  await touch('touchStart', [squareStick]);
  await frames();
  await touch('touchMove', [{ ...squareStick, y: squareStick.y + 72 }]);
  await frames(10);
  const squareSteer = await page.evaluate(() => window.__ctx.input.state.steer);

  await touch('touchEnd', []);

  const ok = layout.logical.width > layout.logical.height
    && layout.canvasClient.width > layout.canvasClient.height
    && layout.physicalRect.height > layout.physicalRect.width
    && !layout.blocker
    && layout.controls
    && steer > 0.5
    && combined.steer > 0.5
    && combined.drift
    && resized.width === 915
    && resized.height === 412
    && squareSteer > 0.5;
  console.log(JSON.stringify({
    ok, layout, steer, combined, resized, squareSteer,
  }, null, 2));
  if (!ok) throw new Error('portrait virtual-landscape regression');
} finally {
  await browser?.close();
  server.stop();
}
