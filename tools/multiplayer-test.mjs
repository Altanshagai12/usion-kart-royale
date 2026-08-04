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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
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
  await Promise.all(pages.map((page) => page.waitForSelector('.kr-lobby:not([hidden])')));
  const lobbyBefore = await Promise.all(pages.map((page) => page.evaluate(() => ({
    roster: [...document.querySelectorAll('.kr-lobby-player')].map((row) => row.textContent),
    action: document.querySelector('.kr-lobby-action')?.textContent,
    disabled: document.querySelector('.kr-lobby-action')?.disabled,
    ownSlot: window.__multiplayer.ownSlot,
    isHost: window.__multiplayer.roster
      .find((row) => row.slot === window.__multiplayer.ownSlot)?.is_host === true,
  }))));
  assert.equal(lobbyBefore[0].roster.length, 2);
  assert.equal(lobbyBefore[1].roster.length, 2);
  const hostIndex = lobbyBefore.findIndex((state) => state.isHost);
  const guestIndex = lobbyBefore.findIndex((state) => !state.isHost);
  assert.ok(hostIndex >= 0 && guestIndex >= 0, 'server assigns one immutable waiting-room host');
  assert.equal(lobbyBefore[hostIndex].disabled, true, 'host waits until every guest is ready');
  await pages[guestIndex].click('.kr-lobby-action');
  await pages[hostIndex].waitForFunction('document.querySelector(".kr-lobby-action")?.disabled === false');
  await pages[hostIndex].click('.kr-lobby-action');
  await Promise.all(pages.map((page) => page.waitForFunction(
    'window.__ctx.race.state === 2',
    { timeout: 20_000 },
  )));
  await Promise.all(pages.map((page) => page.evaluate(() => {
    window.__boxVanish = [];
    const original = window.__ctx.bus.emit.bind(window.__ctx.bus);
    window.__ctx.bus.emit = (event) => {
      if (event?.type === 'item-box-vanish') {
        const boxId = window.__ctx.items.boxes.findIndex((box) => (
          box.pos.distanceToSquared(event.position) < 1e-8
        ));
        window.__boxVanish.push(boxId);
      }
      return original(event);
    };
  })));

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
  // Keep the browser players on the road while they cross three item rows. A
  // fixed ArrowUp-only test eventually scrapes an edge on this curved circuit,
  // making inventory coverage depend on machine speed instead of netcode.
  const steering = pages.map(() => null);
  const driveOnRoad = async (page, index) => {
    const demand = await page.evaluate(() => {
      const own = window.__multiplayer.ownSlot;
      const row = window.__multiplayer.latest?.players?.find((player) => player.slot === own);
      if (!row) return 0;
      return Math.max(-1, Math.min(1, -row.heading * 3 - row.lateral * 0.18));
    });
    const next = demand < -0.06 ? 'ArrowLeft' : demand > 0.06 ? 'ArrowRight' : null;
    if (steering[index] === next) return;
    if (steering[index]) await page.keyboard.up(steering[index]);
    if (next) await page.keyboard.down(next);
    steering[index] = next;
  };
  await waitFor(async () => {
    await Promise.all(pages.map(driveOnRoad));
    return pages[0].evaluate(() => (
      window.__multiplayer.latest?.players?.some((row) => (
        row.item_slots.filter(([kind, count]) => kind > 0 && count > 0).length === 3
      ))
    ));
  }, 90_000);
  await Promise.all(pages.map(async (page, index) => {
    if (steering[index]) await page.keyboard.up(steering[index]);
  }));
  await waitFor(async () => {
    const fullCounts = await Promise.all(pages.map((page) => page.evaluate(() =>
      window.__multiplayer.latest?.players?.map((row) =>
        row.item_slots.filter(([kind, count]) => kind > 0 && count > 0).length))));
    return fullCounts.every((counts) => counts?.some((count) => count === 3));
  }, 5000);
  const itemReplicas = await Promise.all(pages.map((page) => page.evaluate(() => ({
    ownSlot: window.__multiplayer.ownSlot,
    unavailable: window.__multiplayer.latest.items.box_down.map(([id]) => id).sort((a, b) => a - b),
    players: window.__multiplayer.latest.players.map((row) => ({
      slot: row.slot,
      kind: row.item_kind,
      count: row.item_count,
      slots: row.item_slots,
      ack: row.ack_item_seq,
    })),
    visibleBoxes: window.__ctx.items.boxMesh.count,
    events: window.__multiplayer.latest.items.events,
    vanishBoxIds: window.__boxVanish,
  }))));
  const inventorySignature = (replica) => replica.players.map((row) => ({
    slot: row.slot,
    slots: row.slots.map(([kind, count]) => [kind, count]),
  }));
  assert.deepEqual(inventorySignature(itemReplicas[0]), inventorySignature(itemReplicas[1]));
  assert.ok(itemReplicas.every((replica) => (
    replica.unavailable.every((id, index, ids) => Number.isSafeInteger(id)
      && (index === 0 || ids[index - 1] !== id))
  )));
  assert.ok(itemReplicas.every((replica) => replica.visibleBoxes > 0));
  assert.ok(itemReplicas[0].events.some((event) => event.type === 'pickup'));
  for (const replica of itemReplicas) {
    const picked = new Set(replica.events
      .filter((event) => event.type === 'pickup')
      .map((event) => event.box_id));
    assert.ok(replica.vanishBoxIds.length > 0, 'pickup emits an anchored disappearance effect');
    assert.ok(replica.vanishBoxIds.every((id) => picked.has(id)), 'effect position matches box_id');
  }
  const holderPage = itemReplicas.findIndex((replica) => (
    replica.players.some((row) => row.slot === replica.ownSlot
      && row.slots.filter(([kind, count]) => kind > 0 && count > 0).length === 3)
  ));
  assert.ok(holderPage >= 0, 'at least one local player should fill all three authoritative slots');
  const heldBefore = itemReplicas[holderPage].players
    .find((row) => row.slot === itemReplicas[holderPage].ownSlot);
  await delay(1100);
  await pages[holderPage].evaluate(() => window.__multiplayer.setConnection('reconnecting'));
  await pages[holderPage].bringToFront();
  await pages[holderPage].keyboard.down('Digit3');
  await waitFor(async () => pages[holderPage].evaluate(() => (
    !!window.__multiplayer.pendingItem
      && window.__multiplayer.connection === 'reconnecting'
  )), 2000);
  await delay(160);
  const bufferedDuplicates = await pages[holderPage].evaluate(() => (
    window.__multiplayer.queuedItems.length
  ));
  assert.equal(bufferedDuplicates, 0, 'one buffered tap must queue exactly one item action');
  await pages[holderPage].keyboard.up('Digit3');
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
    heldAfter.item_slots[2][0] !== heldBefore.slots[2][0]
      || heldAfter.item_slots[2][1] < heldBefore.slots[2][1],
    'server must consume the directly selected third slot after an acknowledged use',
  );
  const stableInventory = (slots) => slots.slice(0, 2).map(([kind, count]) => [kind, count]);
  assert.deepEqual(stableInventory(heldAfter.item_slots), stableInventory(heldBefore.slots));
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
    Math.sign(handlingProbe.visualHeading) === Math.sign(handlingProbe.authoritativeHeading)
      && Math.abs(handlingProbe.visualHeading - handlingProbe.authoritativeHeading) < 0.12,
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
  assert.ok(
    trackPhaseError * TRACK_LENGTH < 2,
    `direct track phase drifted by ${(trackPhaseError * TRACK_LENGTH).toFixed(3)}m`,
  );
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
    () => window.__multiplayer.connection === 'reconnecting',
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
    ok: true, lobbyBefore,
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
