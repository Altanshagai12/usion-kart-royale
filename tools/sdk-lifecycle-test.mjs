import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = parseInt(process.env.SDK_LIFECYCLE_PORT || '5184', 10);
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--window-size=800,600'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.url().startsWith('https://usions.com/')) request.abort();
    else request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    const handlers = {};
    const events = [];
    const connects = [];
    let disconnects = 0;
    let rematches = 0;
    let leaves = 0;
    let exits = 0;
    const bind = (name) => (callback) => {
      handlers[name] = callback;
      events.push(`on:${name}`);
    };
    const config = {
      roomId: 'sdk-room',
      serviceId: 'kart-royale',
      language: 'en',
      mode: 'multiplayer',
    };
    window.ReactNativeWebView = { postMessage() {} };
    window.__usionMock = {
      handlers, events, connects, config,
      get disconnects() { return disconnects; },
      get rematches() { return rematches; },
      get leaves() { return leaves; },
      get exits() { return exits; },
    };
    window.Usion = {
      config,
      getLaunchParams: () => config,
      getLanguage: () => 'en',
      exit() { exits += 1; },
      init(callback) {
        events.push('init');
        callback(config);
      },
      user: {
        getName: () => 'SDK Racer',
      },
      game: {
        onJoined: bind('joined'),
        onPlayerJoined: bind('playerJoined'),
        onPlayerLeft: bind('playerLeft'),
        onRealtime: bind('realtime'),
        onGameFinished: bind('finished'),
        onRoomAssigned: bind('roomAssigned'),
        onConnectionState: bind('connectionState'),
        onReconnected: bind('reconnected'),
        onError: bind('error'),
        connectDirect(options) {
          events.push('connect');
          connects.push(options);
          return Promise.resolve();
        },
        realtime() {},
        requestSync() {},
        requestRematch() { rematches += 1; },
        leave() { leaves += 1; },
        disconnect() { disconnects += 1; },
      },
    };
  });

  await page.goto(`http://127.0.0.1:${PORT}/?quality=low&prewarm=skip`, { waitUntil: 'domcontentloaded' });
  // This test owns the SDK contract, not renderer warm-up. Waiting for eight
  // fully rendered frames makes it depend on SwiftShader throughput in CI.
  await page.waitForFunction('window.__usionMock.connects.length === 1', { timeout: 90_000 });
  const registration = await page.evaluate(() => ({
    events: window.__usionMock.events,
    connects: window.__usionMock.connects,
    handlers: Object.keys(window.__usionMock.handlers),
  }));
  const expected = [
    'joined', 'playerJoined', 'playerLeft', 'realtime', 'finished',
    'roomAssigned', 'connectionState', 'reconnected', 'error',
  ];
  for (const name of expected) assert.ok(registration.handlers.includes(name), `${name} not registered`);
  assert.equal(registration.connects.length, 1);
  const connectAt = registration.events.indexOf('connect');
  assert.ok(expected.every((name) => registration.events.indexOf(`on:${name}`) < connectAt));

  await page.evaluate(() => {
    const roster = [
      { slot: 0, user_id: 'user-1', name: 'SDK Racer', connected: true, is_host: true },
      { slot: 1, user_id: 'user-2', name: 'Guest Racer', connected: true, ready: true },
    ];
    const player = {
      slot: 0, user_id: 'user-1', name: 'SDK Racer', connected: true,
      distance: 0, lateral: 0, speed: 0, heading: 0, yaw_rate: 0,
      rack: 0, rack_velocity: 0, drifting: false, drift_dir: 0, drift_charge: 0,
      lap: 1, place: 1, finished: false, finish_ms: null,
    };
    const snapshot = {
      v: 1,
      s: 1,
      k: true,
      server_ts: Date.now(),
      elapsed_ms: 0,
      phase: 'playing',
      countdown_ms: 0,
      roster,
      ack: { 0: 0 },
      players: [player, {
        ...player, slot: 1, user_id: 'user-2', name: 'Guest Racer', place: 2,
      }],
    };
    window.__sdkSnapshot = snapshot;
    window.__usionMock.handlers.joined({
      room_id: 'sdk-room',
      slot: 0,
      spectator: false,
      roster,
      phase: 'playing',
      snapshot,
    });
  });

  // A sub-second transport recovery must not flash a warning over ordinary
  // mobile network handoffs. A persistent one still needs clear feedback.
  await page.evaluate(() => window.__usionMock.handlers.connectionState('disconnected'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.evaluate(() => window.__usionMock.handlers.connectionState('connected'));
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(await page.$eval('.kr-network', (el) => el.hidden), true);

  await page.evaluate(() => window.__usionMock.handlers.connectionState('disconnected'));
  await page.waitForFunction(
    "document.querySelector('.kr-network')?.hidden === false && document.querySelector('.kr-network')?.dataset.tone === 'warning'",
    { timeout: 10_000 },
  );
  assert.equal(await page.$eval('.kr-network', (el) => el.textContent), 'Reconnecting…');

  // The local direct racer is not necessarily slot 0. Kart.isPlayer is an
  // immutable solo-chassis flag, so the camera cut must follow Race.player.
  assert.equal(await page.evaluate(() => {
    const ctx = window.__ctx;
    ctx.race.configureDirectReplica(1, [0, 1], false);
    ctx.bus.emit({ type: 'camera-cut', kart: ctx.race.player });
    const registered = window.__camRig.subjectCutPending === true;
    ctx.race.configureDirectReplica(0, [0, 1], false);
    return registered;
  }), true, 'reconnect camera cut must follow a local racer in slot 1');

  // Rejoin resets prediction to a fresh authoritative row. Simulate a stalled
  // 50 ms mobile frame plus an 8 m correction: the camera must cut to the new
  // subject pose instead of staying behind and letting the kart run away.
  const cameraContinuity = await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < 4; i++) await frame();
    const ctx = window.__ctx;
    const before = ctx.camera.position.distanceTo(ctx.race.player.position);
    const rejoin = structuredClone(window.__sdkSnapshot);
    rejoin.s = 3;
    rejoin.server_ts = Date.now();
    rejoin.elapsed_ms = 2_000;
    rejoin.players[0].distance = 8;
    rejoin.players[0].speed = 31;
    window.__usionMock.handlers.joined({
      room_id: 'sdk-room', slot: 0, spectator: false,
      roster: rejoin.roster, phase: 'playing', snapshot: rejoin,
    });
    const stallUntil = performance.now() + 70;
    while (performance.now() < stallUntil) { /* mobile main-thread stall */ }
    await frame();
    const k = ctx.race.player;
    const toEye = ctx.camera.position.clone().sub(k.position);
    const ndc = k.position.clone().project(ctx.camera);
    return {
      before,
      after: toEye.length(),
      behind: toEye.dot(k.forward),
      ndcX: ndc.x,
      ndcY: ndc.y,
      visible: ndc.z >= -1 && ndc.z <= 1,
    };
  });
  assert.ok(cameraContinuity.behind < -1, `camera moved in front of kart: ${JSON.stringify(cameraContinuity)}`);
  assert.ok(Math.abs(cameraContinuity.after - cameraContinuity.before) < 2.5,
    `camera separated from kart on rejoin: ${JSON.stringify(cameraContinuity)}`);
  assert.ok(cameraContinuity.visible && Math.abs(cameraContinuity.ndcX) < 0.6 && Math.abs(cameraContinuity.ndcY) < 0.7,
    `kart left the reconnect frame: ${JSON.stringify(cameraContinuity)}`);

  await page.evaluate(() => window.__usionMock.handlers.connectionState('connected'));
  await page.evaluate(() => {
    const live = structuredClone(window.__sdkSnapshot);
    live.s = 4;
    live.players[0].distance = 8;
    live.elapsed_ms = 65_432;
    live.players[0].finished = true;
    live.players[0].finish_ms = 65_432;
    window.__usionMock.handlers.realtime(live);
  });
  assert.deepEqual(await page.evaluate(() => ({
    modal: document.querySelector('.kr-results')?.hidden === false,
    rows: [...document.querySelectorAll('.kr-results-row')].map((row) => (
      [...row.children].map((child) => child.textContent)
    )),
    rematch: {
      text: document.querySelector('.kr-results-rematch')?.textContent,
      disabled: document.querySelector('.kr-results-rematch')?.disabled,
    },
  })), {
    modal: true,
    rows: [['1', 'SDK Racer', '1:05.432'], ['2', 'Guest Racer', 'Racing…']],
    rematch: { text: 'Available when the race ends', disabled: true },
  });
  await page.evaluate(() => {
    window.__usionMock.handlers.finished({
      winner_ids: ['user-1'],
      reason: 'race_complete',
      placements: [
        { user_id: 'user-1', place: 1, finish_ms: 65_432 },
        { user_id: 'user-2', place: 2, finish_ms: null },
      ],
      rematch_user_ids: [],
    });
    window.__usionMock.handlers.roomAssigned();
  });
  const finished = await page.evaluate(() => ({
    phase: window.__multiplayer.phase,
    modal: document.querySelector('.kr-results')?.hidden === false,
    rows: [...document.querySelectorAll('.kr-results-row')].map((row) => (
      [...row.children].map((child) => child.textContent)
    )),
    buttons: [...document.querySelectorAll('.kr-results button')].map((button) => ({
      text: button.textContent, disabled: button.disabled,
    })),
    connects: window.__usionMock.connects.length,
    disconnects: window.__usionMock.disconnects,
  }));
  assert.deepEqual(finished, {
    phase: 'finished',
    modal: true,
    rows: [['1', 'SDK Racer', '1:05.432'], ['2', 'Guest Racer', 'DNF']],
    buttons: [
      { text: 'Race again', disabled: false },
      { text: 'Exit', disabled: false },
    ],
    connects: 1,
    disconnects: 0,
  });
  await page.evaluate(() => window.__usionMock.handlers.connectionState('disconnected'));
  assert.deepEqual(await page.evaluate(() => ({
    modalHidden: document.querySelector('.kr-results')?.hidden,
    text: document.querySelector('.kr-results-rematch')?.textContent,
    disabled: document.querySelector('.kr-results-rematch')?.disabled,
  })), { modalHidden: false, text: 'Reconnecting…', disabled: true });
  await page.$eval('.kr-results-rematch', (button) => button.click());
  assert.equal(await page.evaluate(() => window.__usionMock.rematches), 0);
  await page.evaluate(() => window.__usionMock.handlers.connectionState('connected'));
  assert.equal(await page.$eval('.kr-results-rematch', (button) => button.disabled), false);
  await page.$eval('.kr-results-rematch', (button) => button.click());
  assert.equal(await page.evaluate(() => window.__usionMock.rematches), 1);
  assert.equal(await page.$eval('.kr-results-rematch', (button) => button.disabled), true);
  await page.evaluate(() => {
    const reset = structuredClone(window.__sdkSnapshot);
    reset.s = 5;
    reset.phase = 'waiting';
    reset.roster[1].ready = false;
    window.__usionMock.handlers.realtime(reset);
  });
  assert.deepEqual(await page.evaluate(() => ({
    phase: window.__multiplayer.phase,
    modalHidden: document.querySelector('.kr-results')?.hidden,
    lobbyHidden: document.querySelector('.kr-lobby')?.hidden,
  })), { phase: 'waiting', modalHidden: true, lobbyHidden: false });

  await page.evaluate(() => window.__usionMock.handlers.finished({
    reason: 'race_complete',
    placements: [
      { user_id: 'user-1', place: 1, finish_ms: 65_432 },
      { user_id: 'user-2', place: 2, finish_ms: null },
    ],
  }));
  await page.$eval('.kr-results-exit', (button) => button.click());
  assert.deepEqual(await page.evaluate(() => ({
    leaves: window.__usionMock.leaves,
    disconnects: window.__usionMock.disconnects,
    exits: window.__usionMock.exits,
  })), { leaves: 1, disconnects: 1, exits: 1 });
  // Release the first WebGL context before booting the solo instance. Keeping
  // both worlds resident can starve GitHub's software renderer.
  await page.close();

  const soloPage = await browser.newPage();
  await soloPage.setViewport({ width: 800, height: 600 });
  await soloPage.setRequestInterception(true);
  soloPage.on('request', (request) => {
    if (request.url().startsWith('https://usions.com/')) request.abort();
    else request.continue();
  });
  await soloPage.evaluateOnNewDocument(() => {
    const handlers = {};
    const events = [];
    const connects = [];
    const bind = (name) => (callback) => {
      handlers[name] = callback;
      events.push(`on:${name}`);
    };
    const config = {
      roomId: 'host-created-solo-room',
      serviceId: 'kart-royale',
      language: 'en',
      mode: 'single',
    };
    window.ReactNativeWebView = { postMessage() {} };
    window.__usionMock = { handlers, events, connects, config };
    window.Usion = {
      config,
      getLaunchParams: () => config,
      getLanguage: () => 'en',
      init(callback) { events.push('init'); callback(config); },
      user: { getName: () => 'Solo Racer' },
      game: {
        onJoined: bind('joined'), onPlayerJoined: bind('playerJoined'),
        onPlayerLeft: bind('playerLeft'), onRealtime: bind('realtime'),
        onGameFinished: bind('finished'), onRoomAssigned: bind('roomAssigned'),
        onConnectionState: bind('connectionState'), onReconnected: bind('reconnected'),
        onError: bind('error'),
        connectDirect(options) { events.push('connect'); connects.push(options); return Promise.resolve(); },
        realtime() {}, requestSync() {},
      },
    };
  });
  await soloPage.goto(`http://127.0.0.1:${PORT}/?quality=low&prewarm=skip`, { waitUntil: 'domcontentloaded' });
  await soloPage.waitForFunction(
    'window.__ctx?.race?.karts?.length === 8 && (window.__ctx.race.state === 1 || window.__ctx.race.state === 2)',
    { timeout: 90_000 },
  );
  const solo = await soloPage.evaluate(() => ({
    state: window.__ctx.race.state,
    racers: window.__ctx.race.karts.length,
    local: window.__ctx.race.directMultiplayer === false,
    connects: window.__usionMock.connects.length,
    handlers: Object.keys(window.__usionMock.handlers),
  }));
  assert.ok(solo.state === 1 || solo.state === 2, 'Usion solo launches directly into the race');
  assert.deepEqual({ racers: solo.racers, local: solo.local, connects: solo.connects }, {
    racers: 8, local: true, connects: 0,
  });
  for (const name of expected) assert.ok(solo.handlers.includes(name), `${name} not registered in solo`);
  await soloPage.evaluate(() => {
    window.__usionMock.handlers.roomAssigned({ roomId: 'shared-room' });
  });
  const promoted = await soloPage.evaluate(() => window.__usionMock.connects[0]);
  assert.ok(promoted, 'roomAssigned must synchronously begin the direct-room connection');
  assert.equal(promoted.roomId, 'shared-room');

  console.log(JSON.stringify({
    ok: true, registration, cameraContinuity, finished, solo, promoted,
  }, null, 2));
} finally {
  await browser.close();
  server.stop();
}
