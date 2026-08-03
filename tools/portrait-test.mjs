import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await startVite(5186);
let browser;

try {
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90_000 });
  await page.evaluate(() => document.querySelector('.kr-s-select .kr-btn')?.click());
  await page.waitForFunction('window.__ctx.race.state !== 0', { timeout: 10_000 });

  const frames = (count = 4) => page.evaluate((total) => new Promise((resolve) => {
    let frame = 0;
    const next = () => (++frame < total ? requestAnimationFrame(next) : resolve());
    requestAnimationFrame(next);
  }), count);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, index) => ({
      ...point, id: point.id ?? index, radiusX: 12, radiusY: 12, force: 1,
    })),
  });
  const center = (selector) => page.evaluate((query) => {
    const rect = document.querySelector(query).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const logical = { width: window.__ctx.width, height: window.__ctx.height };
    const logicalCenter = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      const physicalX = rect.left + rect.width / 2;
      const physicalY = rect.top + rect.height / 2;
      return { x: physicalY, y: window.innerWidth - physicalX };
    };
    return {
      logical,
      quality: window.__ctx.settings.quality,
      pixelRatio: window.__ctx.renderer.getPixelRatio(),
      buffer: { width: canvas.width, height: canvas.height },
      blocker: !!document.querySelector('.tc-rotate'),
      itemSlots: document.querySelectorAll('.kr-item-slot').length,
      controls: {
        left: logicalCenter('.tc-left'), right: logicalCenter('.tc-right'),
        brake: logicalCenter('.tc-brake'), gas: logicalCenter('.tc-gas'),
        drift: logicalCenter('.tc-drift'), item0: logicalCenter('[data-item-slot="0"]'),
      },
    };
  });

  const right = { ...(await center('.tc-right')), id: 1 };
  const brake = { ...(await center('.tc-brake')), id: 2 };
  const drift = { ...(await center('.tc-drift')), id: 3 };
  await touch('touchStart', [right, brake, drift]);
  await frames(4);
  const combined = await page.evaluate(() => ({
    steer: window.__ctx.input.state.steer,
    brake: window.__ctx.input.state.brake,
    drift: window.__ctx.input.state.drift,
  }));
  await touch('touchEnd', []);

  const item1Edge = await page.evaluate(() => {
    const rect = document.querySelector('[data-item-slot="1"]').getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2, id: 5 };
  });
  await touch('touchStart', [item1Edge]);
  const itemEdgeHit = await page.$$eval('.kr-item-slot', (nodes) => (
    nodes.map((node) => node.classList.contains('down'))
  ));
  await touch('touchEnd', []);

  const item2 = { ...(await center('[data-item-slot="2"]')), id: 4 };
  await touch('touchStart', [item2]);
  const itemHit = await page.evaluate(() => document.querySelector('[data-item-slot="2"]').classList.contains('down'));
  await touch('touchEnd', []);

  const shots = join(root, 'shots', 'touch');
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, 'portrait-mobile-hud.png') });

  await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await frames(12);
  const resized = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      logical: { width: window.__ctx.width, height: window.__ctx.height },
      buffer: { width: canvas.width, height: canvas.height },
      pixelRatio: window.__ctx.renderer.getPixelRatio(),
    };
  });

  const { logical, controls } = metrics;
  const ok = logical.width === 844 && logical.height === 390
    && metrics.quality === 0
    && metrics.pixelRatio >= 1.45
    && metrics.buffer.width >= logical.width && metrics.buffer.height >= logical.height
    && !metrics.blocker && metrics.itemSlots === 3
    && controls.left.x < logical.width * 0.25 && controls.right.x < logical.width * 0.35
    && controls.left.y > logical.height * 0.6 && controls.right.y > logical.height * 0.6
    && controls.brake.x > logical.width * 0.7 && controls.gas.x > logical.width * 0.7
    && controls.drift.x > logical.width * 0.55 && controls.item0.x > logical.width * 0.55
    && combined.steer > 0.5 && combined.brake === 1 && combined.drift
    && itemHit && itemEdgeHit.join(',') === 'false,true,false'
    && resized.logical.width === 800 && resized.logical.height === 360
    && resized.pixelRatio >= 1
    && resized.buffer.width >= 800 && resized.buffer.height >= 360;
  console.log(JSON.stringify({ ok, metrics, combined, itemHit, itemEdgeHit, resized }, null, 2));
  if (!ok) throw new Error('portrait sharpness/control-layout regression');
} finally {
  await browser?.close();
  server.stop();
}
