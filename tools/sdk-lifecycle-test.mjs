import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5184;
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
      handlers, events, connects, config, get disconnects() { return disconnects; },
    };
    window.Usion = {
      config,
      getLaunchParams: () => config,
      getLanguage: () => 'en',
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
        disconnect() { disconnects += 1; },
      },
    };
  });

  await page.goto(`http://127.0.0.1:${PORT}/?quality=low&prewarm=skip`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90_000 });
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
    const roster = [{ slot: 0, user_id: 'user-1', name: 'SDK Racer', connected: true }];
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
      players: [{
        slot: 0,
        user_id: 'user-1',
        name: 'SDK Racer',
        connected: true,
        distance: 0,
        lateral: 0,
        speed: 0,
        heading: 0,
        yaw_rate: 0,
        rack: 0,
        rack_velocity: 0,
        drifting: false,
        drift_dir: 0,
        drift_charge: 0,
        lap: 1,
        place: 1,
        finished: false,
        finish_ms: null,
      }],
    };
    window.__usionMock.handlers.joined({
      room_id: 'sdk-room',
      slot: 0,
      spectator: false,
      roster,
      phase: 'playing',
      snapshot,
    });
    window.__usionMock.handlers.finished({
      winner_ids: ['user-1'],
      reason: 'race_complete',
    });
    window.__usionMock.handlers.roomAssigned();
  });
  await page.waitForFunction(
    'window.__multiplayer.phase === "finished"',
    { timeout: 5000 },
  );
  const finished = await page.evaluate(() => ({
    phase: window.__multiplayer.phase,
    overlay: document.querySelector('.kr-network')?.textContent,
    connects: window.__usionMock.connects.length,
    disconnects: window.__usionMock.disconnects,
  }));
  assert.deepEqual(finished, {
    phase: 'finished',
    overlay: 'Race finished',
    connects: 1,
    disconnects: 1,
  });
  await page.evaluate(() => window.__usionMock.handlers.connectionState('disconnected'));
  assert.equal(
    await page.evaluate(() => document.querySelector('.kr-network')?.textContent),
    'Race finished',
  );
  await page.evaluate(() => window.__usionMock.handlers.finished({ reason: 'host_left' }));
  await page.waitForFunction(
    'document.querySelector(".kr-network")?.textContent === "Host left the room"',
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__usionMock.handlers.connectionState('disconnected'));
  assert.equal(
    await page.evaluate(() => document.querySelector('.kr-network')?.textContent),
    'Host left the room',
  );
  assert.equal(await page.evaluate(() => window.__usionMock.disconnects), 2);

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
  await soloPage.waitForFunction('window.__gameReady === true', { timeout: 90_000 });
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
  await soloPage.waitForFunction('window.__usionMock.connects.length === 1');
  const promoted = await soloPage.evaluate(() => window.__usionMock.connects[0]);
  assert.equal(promoted.roomId, 'shared-room');

  console.log(JSON.stringify({ ok: true, registration, finished, solo, promoted }, null, 2));
} finally {
  await browser.close();
  server.stop();
}
