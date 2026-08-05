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
    page.on('pageerror', (error) => console.error(`[browser:${player}] ${error.stack || error}`));
    await page.setViewport({
      width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    });
    // `hasTouch` updates viewport emulation, but some headless Linux builds do
    // not expose maxTouchPoints to the document before first navigation. Set
    // the CDP capability explicitly so production Input eagerly mounts its pad.
    const emulation = await page.createCDPSession();
    await emulation.send('Emulation.setTouchEmulationEnabled', {
      enabled: true, maxTouchPoints: 5,
    });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('https://usions.com/')) request.abort();
      else request.continue();
    });
    await page.goto(
      `http://127.0.0.1:${port}/?multiplayer=1&room=browser-room&player=${player}&quality=low&prewarm=skip&render=skip`,
      { waitUntil: 'domcontentloaded' },
    );
    return page;
  }));
  // Multiplayer readiness is the initialized authoritative replica, not eight
  // completed render frames; the latter makes two-page CI depend on SwiftShader.
  await waitFor(async () => {
    const ready = await Promise.all(pages.map((page) => page.evaluate(() => (
      window.__ctx?.race?.karts?.length >= 2 && window.__ctx.race.directMultiplayer === true
    ))));
    return ready.every(Boolean);
  }, 180_000);
  await waitFor(async () => {
    const visible = await Promise.all(pages.map((page) => page.evaluate(() => (
      !!document.querySelector('.kr-lobby:not([hidden])')
    ))));
    return visible.every(Boolean);
  }, 180_000);
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
  const guestSlot = lobbyBefore[guestIndex].ownSlot;
  await pages[guestIndex].evaluate(() => document.querySelector('.kr-lobby-action')?.click());
  await waitFor(async () => {
    const ready = await Promise.all(pages.map((page) => page.evaluate((slot) => (
      window.__multiplayer.roster.find((row) => row.slot === slot)?.ready === true
    ), guestSlot)));
    return ready.every(Boolean);
  }, 60_000);
  await waitFor(() => pages[hostIndex].evaluate(() => (
    document.querySelector('.kr-lobby-action')?.disabled === false
  )), 60_000);
  await waitFor(async () => {
    const behind = await Promise.all(pages.map((page) => page.evaluate(() => {
      const kart = window.__ctx.race.player;
      return window.__ctx.camera.position.clone().sub(kart.position).dot(kart.forward) < -1;
    })));
    return behind.every(Boolean);
  }, 60_000);
  const waitingFacing = await Promise.all(pages.map((page) => page.evaluate(() => {
    const ctx = window.__ctx;
    const kart = ctx.race.player;
    const view = ctx.camera.position.clone();
    ctx.camera.getWorldDirection(view);
    return {
      trackAlignment: kart.forward.dot(ctx.track.sample(kart.t).tangent),
      cameraBehind: ctx.camera.position.clone().sub(kart.position).dot(kart.forward),
      viewAlignment: view.dot(kart.forward),
      cameraOffset: ctx.camera.position.clone().sub(kart.position).normalize().toArray(),
      view: view.toArray(),
    };
  })));
  for (const pose of waitingFacing) {
    assert.ok(pose.trackAlignment > 0.9, `waiting heading reversed: ${pose.trackAlignment}`);
    assert.ok(pose.cameraBehind < -1, `waiting camera is in front: ${pose.cameraBehind}`);
    assert.ok(pose.viewAlignment > 0.7, `waiting camera looks backwards: ${pose.viewAlignment}`);
  }
  const startDispatch = await pages[hostIndex].evaluate(() => {
    const multiplayer = window.__multiplayer;
    const socket = multiplayer.localSocket;
    const sent = [];
    const original = socket.send;
    socket.send = function capture(type, payload) {
      sent.push(type);
      return original.call(this, type, payload);
    };
    const action = document.querySelector('.kr-lobby-action');
    const before = {
      disabled: action?.disabled,
      phase: multiplayer.phase,
      connection: multiplayer.connection,
      socketReady: socket.socket?.readyState,
      sequence: socket.sequence,
    };
    action?.click();
    const after = { sequence: socket.sequence };
    socket.send = original;
    return { before, after, sent };
  });
  assert.deepEqual({
    disabled: startDispatch.before.disabled,
    phase: startDispatch.before.phase,
    connection: startDispatch.before.connection,
  }, { disabled: false, phase: 'waiting', connection: 'connected' });
  assert.equal(startDispatch.before.socketReady, 1, 'host WebSocket must be open before start');
  assert.deepEqual(startDispatch.sent, ['lobby_start'], 'host button must dispatch one start frame');
  assert.equal(
    startDispatch.after.sequence,
    startDispatch.before.sequence + 1,
    'lobby_start must enter the open WebSocket envelope',
  );
  try {
    await waitFor(async () => {
      const started = await Promise.all(pages.map((page) => page.evaluate(() => (
        window.__multiplayer.phase !== 'waiting'
      ))));
      return started.every(Boolean);
    }, 60_000);
  } catch (error) {
    const replicas = await Promise.all(pages.map((page) => page.evaluate(() => ({
      phase: window.__multiplayer.phase,
      connection: window.__multiplayer.connection,
      socketReady: window.__multiplayer.localSocket?.socket?.readyState,
      roster: window.__multiplayer.roster,
      snapshotRoster: window.__multiplayer.latest?.roster,
    }))));
    throw new Error(`host start was not replicated: ${JSON.stringify({ startDispatch, replicas })}`, {
      cause: error,
    });
  }
  await waitFor(async () => {
    const countdown = await Promise.all(pages.map((page) => page.evaluate(() => (
      window.__ctx.race.state === 1
    ))));
    return countdown.every(Boolean);
  }, 60_000);
  const countdownFacing = await Promise.all(pages.map((page) => page.evaluate(() => {
    const ctx = window.__ctx;
    const kart = ctx.race.player;
    const view = ctx.camera.position.clone();
    ctx.camera.getWorldDirection(view);
    return {
      trackAlignment: kart.forward.dot(ctx.track.sample(kart.t).tangent),
      cameraBehind: ctx.camera.position.clone().sub(kart.position).dot(kart.forward),
      viewAlignment: view.dot(kart.forward),
      cameraOffset: ctx.camera.position.clone().sub(kart.position).normalize().toArray(),
      view: view.toArray(),
    };
  })));
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  for (let i = 0; i < countdownFacing.length; i++) {
    const pose = countdownFacing[i];
    assert.ok(pose.trackAlignment > 0.9, `countdown heading reversed: ${pose.trackAlignment}`);
    assert.ok(pose.cameraBehind < -1, `countdown camera is in front: ${pose.cameraBehind}`);
    assert.ok(pose.viewAlignment > 0.7, `countdown camera looks backwards: ${pose.viewAlignment}`);
    assert.ok(dot(waitingFacing[i].cameraOffset, pose.cameraOffset) > 0.8, 'camera crossed the kart at Start');
    assert.ok(dot(waitingFacing[i].view, pose.view) > 0.8, 'view direction flipped at Start');
  }
  await waitFor(async () => {
    const racing = await Promise.all(pages.map((page) => page.evaluate(() => (
      window.__ctx.race.state === 2
    ))));
    return racing.every(Boolean);
  }, 120_000);
  await waitFor(async () => {
    const behind = await Promise.all(pages.map((page) => page.evaluate(() => {
      const kart = window.__ctx.race.player;
      return window.__ctx.camera.position.clone().sub(kart.position).dot(kart.forward) < -1;
    })));
    return behind.every(Boolean);
  }, 60_000);
  const startFacing = await Promise.all(pages.map((page) => page.evaluate(() => {
    const kart = window.__ctx.race.player;
    const tangent = window.__ctx.track.sample(kart.t).tangent;
    return {
      trackAlignment: kart.forward.dot(tangent),
      cameraBehind: window.__ctx.camera.position.clone().sub(kart.position).dot(kart.forward),
    };
  })));
  for (const pose of startFacing) {
    assert.ok(pose.trackAlignment > 0.9, `start heading reversed: ${pose.trackAlignment}`);
    assert.ok(pose.cameraBehind < -1, `start camera crossed in front: ${pose.cameraBehind}`);
  }
  const directRacerMembership = await Promise.all(pages.map((page) => page.evaluate(() => ({
    standings: window.__ctx.race.standings.map((kart) => kart.id).sort((a, b) => a - b),
    visible: window.__ctx.race.karts.filter((kart) => kart.object.visible)
      .map((kart) => kart.id).sort((a, b) => a - b),
    roster: window.__multiplayer.roster.map((row) => row.slot).sort((a, b) => a - b),
  }))));
  for (const replica of directRacerMembership) {
    assert.deepEqual(replica.standings, replica.roster, 'minimap source is the authoritative roster');
    assert.deepEqual(replica.visible, replica.roster, 'non-roster bot karts stay hidden');
  }
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
  await pages[1].bringToFront();
  const serverBeforeTouch = await pages[1].evaluate(() => {
    const multiplayer = window.__multiplayer;
    const slot = multiplayer.ownSlot;
    return {
      sequence: multiplayer.latest?.s ?? -1,
      ack: multiplayer.latest?.ack?.[String(slot)] ?? -1,
    };
  });
  if (!(await pages[1].$('.tc-right'))) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 20, y: 20, id: 6, radiusX: 12, radiusY: 12, force: 1 }],
    });
    await delay(50);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await waitFor(() => pages[1].evaluate(() => !!document.querySelector('.tc-right')), 60_000);
  const rightButton = await pages[1].evaluate(() => {
    const rect = document.querySelector('.tc-right').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...rightButton, id: 7, radiusX: 12, radiusY: 12, force: 1 }],
  });
  await delay(900);
  const handlingProbe = await pages[1].evaluate(() => {
    const ctx = window.__ctx;
    const slot = window.__multiplayer.ownSlot;
    const kart = ctx.race.karts[slot];
    const predicted = window.__multiplayer.predictor?.view?.();
    const latest = window.__multiplayer.latest;
    const authoritative = latest?.players?.find((row) => row.slot === slot);
    const sample = ctx.track.sample(kart.t);
    const ground = ctx.track.probe(kart.position, kart.t);
    return {
      authoritativeDistance: authoritative?.distance ?? 0,
      authoritativeLateral: authoritative?.lateral ?? 0,
      authoritativeRack: authoritative?.rack ?? 0,
      renderTrackT: kart.t,
      authoritativeHeading: authoritative?.heading ?? 0,
      serverSequence: latest?.s ?? -1,
      serverAck: latest?.ack?.[String(slot)] ?? -1,
      predictedHeading: predicted?.heading ?? 0,
      touchSteer: ctx.input.state.steer,
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
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
      window.__multiplayer.latest?.items?.events?.some((event) => event.type === 'pickup')
        && window.__multiplayer.latest.players.some((row) => (
          row.item_slots.some(([kind, count]) => kind > 0 && count > 0)
        ))
    ));
  }, 60_000);
  await Promise.all(pages.map(async (page, index) => {
    if (steering[index]) await page.keyboard.up(steering[index]);
    await page.keyboard.up('ArrowUp');
  }));
  const inventorySignature = (replica) => replica.players.map((row) => ({
    slot: row.slot,
    slots: row.slots.map(([kind, count]) => [kind, count]),
  }));
  const readItemReplicas = () => Promise.all(pages.map((page) => page.evaluate(() => ({
    sequence: window.__multiplayer.latest.s,
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
  // A pickup can land between two page.evaluate calls. Compare replicas only
  // when both clients have consumed the same authoritative snapshot sequence.
  const itemReplicas = await waitFor(async () => {
    const replicas = await readItemReplicas();
    if (replicas[0].sequence !== replicas[1].sequence) return null;
    if (JSON.stringify(inventorySignature(replicas[0]))
        !== JSON.stringify(inventorySignature(replicas[1]))) return null;
    return replicas;
  }, 5000);
  assert.deepEqual(inventorySignature(itemReplicas[0]), inventorySignature(itemReplicas[1]));
  assert.ok(itemReplicas.every((replica) => (
    replica.players.every((row) => row.slots.length === 3)
  )), 'every authoritative racer snapshot must retain exactly three item slots');
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
      && row.slots.some(([kind, count]) => kind > 0 && count > 0))
  ));
  assert.ok(holderPage >= 0, 'at least one local player should own an authoritative item');
  const heldAtPickup = itemReplicas[holderPage].players
    .find((row) => row.slot === itemReplicas[holderPage].ownSlot);
  const selectedItemSlot = heldAtPickup.slots
    .findIndex(([kind, count]) => kind > 0 && count > 0);
  assert.ok(selectedItemSlot >= 0, 'the selected local inventory must contain an item');
  const itemKey = `Digit${selectedItemSlot + 1}`;
  await waitFor(() => pages[holderPage].evaluate((slot) => {
    const own = window.__multiplayer.ownSlot;
    const row = window.__multiplayer.latest.players.find((player) => player.slot === own);
    return row?.item_slots?.[slot]?.[2] === 0;
  }, selectedItemSlot), 10_000);
  const heldBefore = await pages[holderPage].evaluate(() => {
    const own = window.__multiplayer.ownSlot;
    const row = window.__multiplayer.latest.players.find((player) => player.slot === own);
    return {
      slot: row.slot,
      kind: row.item_kind,
      count: row.item_count,
      slots: row.item_slots,
      ack: row.ack_item_seq,
    };
  });
  await pages[holderPage].evaluate(() => window.__multiplayer.setConnection('reconnecting'));
  await pages[holderPage].bringToFront();
  await pages[holderPage].keyboard.down(itemKey);
  await waitFor(async () => pages[holderPage].evaluate(() => (
    !!window.__multiplayer.pendingItem
      && window.__multiplayer.connection === 'reconnecting'
  )), 2000);
  await delay(160);
  const bufferedDuplicates = await pages[holderPage].evaluate(() => (
    window.__multiplayer.queuedItems.length
  ));
  assert.equal(bufferedDuplicates, 0, 'one buffered tap must queue exactly one item action');
  const pendingBeforeSend = await pages[holderPage].evaluate(() => ({
    pending: { ...window.__multiplayer.pendingItem },
    latest: window.__multiplayer.latest.players.find(
      (row) => row.slot === window.__multiplayer.ownSlot,
    ),
  }));
  await pages[holderPage].keyboard.up(itemKey);
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
    heldAfter.item_slots[selectedItemSlot][0] !== heldBefore.slots[selectedItemSlot][0]
      || heldAfter.item_slots[selectedItemSlot][1] < heldBefore.slots[selectedItemSlot][1],
    `server must consume the directly selected slot after an acknowledged use: ${JSON.stringify({
      selectedItemSlot,
      heldBefore,
      heldAfter,
      pendingBeforeSend,
      events: itemReplicas[holderPage].events,
    })}`,
  );
  const stableInventory = (slots) => slots
    .filter((_, index) => index !== selectedItemSlot)
    .map(([kind, count]) => [kind, count]);
  assert.deepEqual(stableInventory(heldAfter.item_slots), stableInventory(heldBefore.slots));
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
    viewOne, viewTwo, diagnostics, countdownFacing, startFacing, handlingProbe, itemReplicas, heldAfter,
  }, null, 2));
  assert.ok(
    handlingProbe.touchSteer > 0.9,
    `mobile touch did not deliver full steering: ${handlingProbe.touchSteer}`,
  );
  assert.ok(
    handlingProbe.serverSequence > serverBeforeTouch.sequence
      && handlingProbe.serverAck > serverBeforeTouch.ack,
    `server did not acknowledge touch inputs: ${JSON.stringify({ serverBeforeTouch, handlingProbe })}`,
  );
  assert.ok(
    handlingProbe.authoritativeRack > 0.75,
    `server steering rack was too weak: ${handlingProbe.authoritativeRack}`,
  );
  assert.ok(
    handlingProbe.authoritativeHeading > 0.3,
    `mobile steering response was too weak: ${handlingProbe.authoritativeHeading}`,
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
    countdownFacing,
    startFacing,
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
