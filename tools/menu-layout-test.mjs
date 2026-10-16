import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const port = 5191;
const server = await startVite(port);
let browser;

try {
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const results = [];
  for (const mode of ['select', 'pause', 'results']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/?quality=low&prewarm=skip&ui=${mode}`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    await page.waitForFunction('window.__gameReady === true', { timeout: 90_000 });
    await page.evaluate(() => new Promise((resolve) => {
      let n = 0;
      const frame = () => (++n >= 5 ? resolve() : requestAnimationFrame(frame));
      requestAnimationFrame(frame);
    }));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const report = await page.evaluate((screen) => {
      const root = document.querySelector(`.kr-s-${screen}`);
      const controls = document.querySelector('.tc-root');
      const nodes = [...root.querySelectorAll('.kr-btn, .kr-card')];
      const rects = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          short: Math.min(rect.width, rect.height) };
      });
      const rows = [...root.querySelectorAll('.kr-row')];
      const controlHit = [...document.querySelectorAll('.tc-btn')].some((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === node || hit?.closest('.tc-root') === controls;
      });
      return {
        screen,
        active: root.classList.contains('on'),
        controlsHidden: getComputedStyle(controls).visibility === 'hidden'
          && getComputedStyle(controls).pointerEvents === 'none',
        controlHit,
        count: nodes.length,
        rects,
        rowCount: rows.length,
        rowsVisible: rows.every((row) => Number.parseFloat(getComputedStyle(row).opacity) > 0.99),
      };
    }, mode);
    results.push(report);
    await page.close();
  }

  console.log(JSON.stringify({ results }, null, 2));
  for (const result of results) {
    assert.equal(result.active, true, `${result.screen} did not become active`);
    assert.equal(result.controlsHidden, true, `touch controls visible on ${result.screen}`);
    assert.equal(result.controlHit, false, `touch controls intercept ${result.screen}`);
    assert.ok(result.count >= 2, `${result.screen} has no actionable controls`);
    for (const rect of result.rects) {
      assert.ok(rect.left >= -1 && rect.top >= -1 && rect.right <= 391 && rect.bottom <= 845,
        `${result.screen} action is clipped: ${JSON.stringify(rect)}`);
      assert.ok(rect.short >= 44, `${result.screen} action is under 44px: ${JSON.stringify(rect)}`);
    }
    if (result.screen !== 'select') {
      assert.ok(result.rowCount > 0, `${result.screen} standings are empty`);
      assert.equal(result.rowsVisible, true, `${result.screen} standings are transparent`);
    }
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser?.close();
  server.stop();
}
