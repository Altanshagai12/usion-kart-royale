import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await startVite(5181);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await page.goto('http://127.0.0.1:5181/?quality=low', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90_000 });
  await page.evaluate(() => document.querySelector('.kr-s-select .kr-btn')?.click());
  await page.waitForFunction('window.__ctx.race.state !== 0', { timeout: 10_000 });
  const center = (selector) => page.evaluate((query) => {
    const rect = document.querySelector(query).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, index) => ({ ...point, id: point.id ?? index, radiusX: 12, radiusY: 12, force: 1 })),
  });
  const frames = (count = 5) => page.evaluate((total) => new Promise((resolve) => {
    let frame = 0;
    const next = () => (++frame < total ? requestAnimationFrame(next) : resolve());
    requestAnimationFrame(next);
  }), count);
  const read = () => page.evaluate(() => ({ ...window.__ctx.input.state }));

  const right = { ...(await center('.tc-right')), id: 1 };
  const drift = { ...(await center('.tc-drift')), id: 2 };
  await touch('touchStart', [right, drift]);
  await frames();
  const rightDrift = await read();
  await touch('touchEnd', []);
  const left = { ...(await center('.tc-left')), id: 3 };
  const brake = { ...(await center('.tc-brake')), id: 4 };
  await touch('touchStart', [left, brake]);
  await frames();
  const leftBrake = await read();
  await touch('touchEnd', []);
  await frames(12);
  const released = await read();
  const controls = await page.evaluate(() => ({
    lookControl: !!document.querySelector('.tc-look, [data-btn="look"]'),
    buttonIds: [...document.querySelectorAll('.tc-btn[data-btn]')]
      .map((node) => node.dataset.btn).sort(),
  }));
  await page.keyboard.down('q');
  await frames();
  const keyboardLookHeld = (await read()).lookBack;
  await page.keyboard.up('q');
  await frames();
  const keyboardLookReleased = (await read()).lookBack;
  const shots = join(root, 'shots', 'touch');
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'landscape-mobile-hud.png') });
  const slots = await page.$$eval('.kr-item-slot', (nodes) => nodes.length);
  const ok = rightDrift.steer > 0.5 && rightDrift.drift
    && leftBrake.steer < -0.5 && leftBrake.brake === 1 && !leftBrake.lookBack
    && released.steer === 0 && !released.drift && released.brake === 0
    && !controls.lookControl
    && controls.buttonIds.join(',') === 'brake,drift,gas,left,right'
    && keyboardLookHeld && !keyboardLookReleased
    && slots === 3;
  console.log(JSON.stringify({
    ok, rightDrift, leftBrake, released, controls,
    keyboardLookHeld, keyboardLookReleased, slots,
  }, null, 2));
  if (!ok) throw new Error('fixed touch controls regression');
} finally {
  await browser.close();
  server.stop();
}
