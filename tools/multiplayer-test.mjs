import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer';
import { TRACK_LENGTH } from '../shared/constants.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

const port = await freePort();
const server = spawn(process.execPath, ['server/dev.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (bytes) => { serverLog += String(bytes); });
server.stderr.on('data', (bytes) => { serverLog += String(bytes); });

let browser;
try {
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });

  browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--window-size=800,600',
    ],
  });
  const pages = await Promise.all(['one', 'two'].map(async (player) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('https://usions.com/')) request.abort();
      else request.continue();
    });
    await page.goto(
      `http://127.0.0.1:${port}/?multiplayer=1&room=browser-room&player=${player}&quality=low`,
      { waitUntil: 'domcontentloaded' },
    );
    return page;
  }));
  await Promise.all(pages.map((page) => page.waitForFunction(
    'window.__gameReady === true && window.__ctx?.race?.directMultiplayer === true',
    { timeout: 90_000 },
  )));
  await Promise.all(pages.map((page) => page.waitForFunction(
    'window.__ctx.race.state === 2',
    { timeout: 20_000 },
  )));

  const cdp = await pages[1].createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 120,
    downloadThroughput: 128 * 1024,
    uploadThroughput: 64 * 1024,
    connectionType: 'cellular3g',
  });

  await pages[0].keyboard.down('ArrowUp');
  await pages[1].keyboard.down('ArrowUp');
  await pages[1].keyboard.down('ArrowRight');
  await delay(900);
  const handlingProbe = await pages[1].evaluate(() => {
    const ctx = window.__ctx;
    const slot = window.__multiplayer.ownSlot;
    const kart = ctx.race.karts[slot];
    const predicted = window.__multiplayer.predictor?.view?.();
    const sample = ctx.track.sample(kart.t);
    const ground = ctx.track.probe(kart.position, kart.t);
    return {
      authoritativeDistance: predicted?.distance ?? 0,
      renderTrackT: kart.t,
      authoritativeHeading: predicted?.heading ?? 0,
      visualHeading: Math.atan2(
        kart.forward.dot(sample.binormal),
        kart.forward.dot(sample.tangent),
      ),
      roadPlaneClearance: kart.position.y - ground.y,
      speed: kart.forwardSpeed,
      itemsVisible: ctx.items.group.visible,
      itemBoxes: ctx.items.boxMesh?.count ?? 0,
      itemSnapshot: window.__multiplayer.latest?.items,
    };
  });
  await pages[1].keyboard.up('ArrowRight');
  await delay(6000);
  await waitFor(async () => pages[0].evaluate(() => (
    window.__multiplayer.latest?.players?.some((row) => row.item_kind > 0)
  )), 20_000);
  const itemReplicas = await Promise.all(pages.map((page) => page.evaluate(() => ({
    ownSlot: window.__multiplayer.ownSlot,
    unavailable: window.__multiplayer.latest.items.box_down.map(([id]) => id).sort((a, b) => a - b),
    players: window.__multiplayer.latest.players.map((row) => ({
      slot: row.slot,
      kind: row.item_kind,
      count: row.item_count,
      ack: row.ack_item_seq,
    })),
    visibleBoxes: window.__ctx.items.boxMesh.count,
    events: window.__multiplayer.latest.items.events,
  }))));
  assert.deepEqual(itemReplicas[0].unavailable, itemReplicas[1].unavailable);
  assert.ok(itemReplicas.every((replica) => replica.visibleBoxes > 0));
  assert.ok(itemReplicas[0].events.some((event) => event.type === 'pickup'));
  const holderPage = itemReplicas.findIndex((replica) => (
    replica.players.some((row) => row.slot === replica.ownSlot && row.kind > 0)
  ));
  assert.ok(holderPage >= 0, 'at least one local player should receive an authoritative item');
  const heldBefore = itemReplicas[holderPage].players
    .find((row) => row.slot === itemReplicas[holderPage].ownSlot);
  await delay(1100);
  await pages[holderPage].evaluate(() => window.__multiplayer.setConnection('reconnecting'));
  await pages[holderPage].keyboard.press('Enter');
  await delay(100);
  const queuedAcrossReconnect = await pages[holderPage].evaluate(() => (
    !!window.__multiplayer.pendingItem
    && window.__multiplayer.connection === 'reconnecting'
  ));
  assert.equal(queuedAcrossReconnect, true, 'item press must remain pending during reconnect');
  await pages[holderPage].evaluate(() => window.__multiplayer.setConnection('connected'));
  await waitFor(async () => pages[holderPage].evaluate(() => {
    const own = window.__multiplayer.ownSlot;
    return window.__multiplayer.latest.players
      .some((row) => row.slot === own && row.ack_item_seq > 0);
  }), 5000);
  const heldAfter = await pages[holderPage].evaluate(() => {
    const own = window.__multiplayer.ownSlot;
    return window.__multiplayer.latest.players.find((row) => row.slot === own);
  });
  const useFeedback = await pages[holderPage].evaluate(() => (
    window.__multiplayer.latest.items.events.some((event) => event.type === 'use')
  ));
  assert.equal(useFeedback, true, 'authoritative use feedback must be replicated');
  assert.ok(
    heldAfter.item_kind !== heldBefore.kind || heldAfter.item_count < heldBefore.count,
    'server must consume the held item after an acknowledged use',
  );
  await pages[0].keyboard.up('ArrowUp');
  await pages[1].keyboard.up('ArrowUp');
  await delay(500);

  const readKarts = (page) => page.evaluate(() => window.__ctx.race.karts
    .slice(0, 2)
    .map((kart) => ({
      visible: kart.object.visible,
      x: kart.position.x,
      y: kart.position.y,
      z: kart.position.z,
      speed: kart.forwardSpeed,
    })));
  const [viewOne, viewTwo] = await Promise.all(pages.map(readKarts));
  const diagnostics = await Promise.all(pages.map((page) => page.evaluate(() => ({
    input: window.__ctx.input.state,
    connection: window.__multiplayer.connection,
    phase: window.__multiplayer.phase,
    latest: window.__multiplayer.latest?.players,
    ownSlot: window.__multiplayer.ownSlot,
    prediction: window.__multiplayer.predictor?.view?.(),
  }))));
  console.log(JSON.stringify({
    viewOne, viewTwo, diagnostics, handlingProbe, itemReplicas, heldAfter,
  }, null, 2));
  assert.ok(
    Math.abs(handlingProbe.authoritativeHeading) > 0.08,
    'steering probe should create a measurable heading',
  );
  assert.ok(
    Math.abs(handlingProbe.visualHeading - handlingProbe.authoritativeHeading) < 0.08,
    `visual heading ${handlingProbe.visualHeading} opposed authoritative heading `
      + `${handlingProbe.authoritativeHeading}`,
  );
  assert.ok(
    Math.abs(handlingProbe.roadPlaneClearance) < 0.08,
    `direct replica floats ${handlingProbe.roadPlaneClearance}m above the road plane`,
  );
  const expectedTrackT = (
    (handlingProbe.authoritativeDistance / TRACK_LENGTH) % 1 + 1
  ) % 1;
  const trackPhaseError = Math.min(
    Math.abs(handlingProbe.renderTrackT - expectedTrackT),
    1 - Math.abs(handlingProbe.renderTrackT - expectedTrackT),
  );
  assert.ok(trackPhaseError < 1e-6, `direct track phase drifted by ${trackPhaseError}`);
  assert.ok(handlingProbe.speed > 4, 'steering probe should be accelerating through the turn');
  assert.equal(handlingProbe.itemsVisible, true, 'direct multiplayer must not hide item presentation');
  assert.ok(handlingProbe.itemBoxes > 0, 'direct multiplayer must render item boxes');
  assert.ok(Array.isArray(handlingProbe.itemSnapshot?.box_down));
  for (const view of [viewOne, viewTwo]) {
    assert.equal(view.length, 2);
    assert.ok(view.every((kart) => kart.visible));
  }
  assert.ok(
    diagnostics[0].latest.some((row) => row.distance > -5),
    'authoritative karts should advance from the starting grid',
  );
  for (let slot = 0; slot < 2; slot++) {
    const a = viewOne[slot];
    const b = viewTwo[slot];
    const delta = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(delta < 12, `slot ${slot} diverged by ${delta.toFixed(2)}m`);
  }

  await pages[0].evaluate(() => window.__multiplayer.localSocket.socket.close());
  await waitFor(() => pages[0].evaluate(
    () => document.querySelector('.kr-network')?.textContent?.includes('Reconnecting'),
  ));
  await waitFor(() => pages[0].evaluate(
    () => window.__multiplayer.connection === 'connected',
  ), 20_000);
  const reconnectState = await pages[0].evaluate(() => ({
    active: window.__multiplayer.active,
    joined: window.__multiplayer.joined,
    state: window.__multiplayer.connection,
  }));
  assert.deepEqual(reconnectState, { active: true, joined: true, state: 'connected' });

  console.log(JSON.stringify({
    ok: true,
    adverseNetworkMs: 120,
    handlingProbe,
    views: [viewOne, viewTwo],
    items: { replicas: itemReplicas, heldAfter },
    reconnect: reconnectState,
  }, null, 2));
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
