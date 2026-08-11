/**
 * Desktop item activation regression.
 *
 * A primary mouse click on a visible inventory slot must enter the same
 * one-frame Input edge as the existing keyboard shortcut. Space remains the
 * first-occupied-slot action; a clicked slot carries its exact index.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = Number(process.env.DESKTOP_ITEM_PORT || 5332);
const server = await startVite(PORT);
let browser;

try {
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(
    `http://127.0.0.1:${PORT}/?quality=low&prewarm=skip&render=skip`,
    { waitUntil: 'domcontentloaded', timeout: 90_000 },
  );
  await page.waitForFunction('window.__gameReady === true', { timeout: 120_000 });
  await page.evaluate(() => document.querySelector('.kr-s-select .kr-btn')?.click());
  await page.waitForFunction('window.__ctx.race.state !== 0', { timeout: 10_000 });

  await page.evaluate(() => {
    const ctx = window.__ctx;
    ctx.race._state = 2;
    const inventory = ctx.items.slots.get(ctx.race.player.id);
    Object.assign(inventory.items[1], { kind: 1, count: 1, arm: 0, carried: -1 });
    const input = window.__ctx.input;
    const original = input.update.bind(input);
    window.__itemEdges = [];
    input.update = (ctx, dt) => {
      original(ctx, dt);
      if (input.state.itemPressed) {
        window.__itemEdges.push({ slot: input.state.itemSlot, at: performance.now() });
      }
    };
  });
  await page.waitForFunction('document.querySelector(\'[data-item-slot="1"]\')?.classList.contains("has-item")');
  await page.waitForFunction(
    'getComputedStyle(document.querySelector(".kr-s-title")).visibility === "hidden"',
  );

  const target = await page.$('[data-item-slot="1"]');
  assert.ok(target, 'second desktop item slot exists');
  const box = await target.boundingBox();
  assert.ok(box && box.width >= 32 && box.height >= 32, 'desktop item slot has a visible hit target');
  const pointer = await page.$eval('[data-item-slot="1"]', (node) => ({
    pointerEvents: getComputedStyle(node).pointerEvents,
    cursor: getComputedStyle(node).cursor,
  }));
  assert.equal(pointer.pointerEvents, 'auto', 'desktop item slot accepts pointer input');
  assert.equal(pointer.cursor, 'pointer', 'desktop item slot advertises mouse interaction');

  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y);
    return {
      slot: node?.closest('[data-item-slot]')?.getAttribute('data-item-slot') ?? null,
      tag: node?.tagName ?? null,
      className: node?.className ?? null,
    };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  assert.equal(hit.slot, '1', `desktop pointer hit testing reached ${JSON.stringify(hit)}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction('window.__itemEdges?.some((edge) => edge.slot === 1)');
  await page.waitForFunction(() => window.__ctx.items.heldSlots(window.__ctx.race.player)[1].kind === 0);
  await page.evaluate(() => {
    const ctx = window.__ctx;
    const inventory = ctx.items.slots.get(ctx.race.player.id);
    Object.assign(inventory.items[0], { kind: 1, count: 1, arm: 0, carried: -1 });
  });
  await page.waitForFunction('document.querySelector(\'[data-item-slot="0"]\')?.classList.contains("has-item")');
  await page.keyboard.press('Space');
  await page.waitForFunction('window.__itemEdges?.some((edge) => edge.slot === -1)');
  await page.waitForFunction(() => window.__ctx.items.heldSlots(window.__ctx.race.player)[0].kind === 0);

  const edges = await page.evaluate(() => window.__itemEdges);
  assert.equal(edges.filter((edge) => edge.slot === 1).length, 1, 'one click emits one exact-slot edge');
  assert.equal(edges.filter((edge) => edge.slot === -1).length, 1, 'Space still emits one default-slot edge');
  console.log(JSON.stringify({ ok: true, pointer, edges }, null, 2));
} finally {
  await browser?.close();
  server.stop();
}
