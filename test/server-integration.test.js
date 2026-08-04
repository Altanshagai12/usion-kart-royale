import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function openClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (bytes) => messages.push(JSON.parse(String(bytes))));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages };
}

function send(client, seq, type, payload = {}) {
  client.ws.send(JSON.stringify({
    type,
    seq,
    ts: Date.now(),
    protocol_version: '2',
    payload,
  }));
}

test('direct server joins, starts, reconnects, and rejects unsafe frames', { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/dev.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (bytes) => { logs += String(bytes); });
  child.stderr.on('data', (bytes) => { logs += String(bytes); });
  t.after(() => child.kill());

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });
  assert.equal(child.exitCode, null, logs);

  const base = `ws://127.0.0.1:${port}/ws?token=`;
  const one = await openClient(`${base}dev:one:integration-room`);
  const two = await openClient(`${base}dev:two:integration-room`);
  t.after(() => {
    one.ws.close();
    two.ws.close();
  });
  send(one, 1, 'join');
  send(two, 1, 'join');
  const joinedOne = await waitFor(() => one.messages.find((message) => message.type === 'joined'));
  await waitFor(() => two.messages.find((message) => message.type === 'joined'));
  assert.equal(joinedOne.payload.slot, 0);
  await delay(5_200);
  assert.equal(
    one.messages.some((message) => message.payload?.phase === 'countdown'),
    false,
    'two racers must remain in the host-controlled waiting room',
  );
  send(two, 2, 'input', { action_type: 'lobby_ready', action_data: { ready: true } });
  await waitFor(() => one.messages.find((message) => (
    message.type === 'player_joined'
    && message.payload.roster?.find((row) => row.user_id === 'two')?.ready === true
  )));
  send(two, 3, 'input', { action_type: 'lobby_start', action_data: {} });
  await delay(100);
  assert.equal(
    one.messages.some((message) => message.payload?.phase === 'countdown'),
    false,
    'guest start must be ignored',
  );
  send(one, 2, 'input', { action_type: 'lobby_start', action_data: {} });
  await waitFor(() => one.messages.find(
    (message) => message.type === 'state_delta' && message.payload.phase === 'countdown',
  ), 8000);

  const replacement = await openClient(`${base}dev:one:integration-room`);
  t.after(() => replacement.ws.close());
  send(replacement, 1, 'join');
  const rejoined = await waitFor(() => replacement.messages.find((message) => message.type === 'joined'));
  assert.equal(rejoined.payload.slot, 0);
  await waitFor(() => one.ws.readyState === WebSocket.CLOSED);

  const badSequence = await openClient(`${base}dev:badseq:sequence-room`);
  t.after(() => badSequence.ws.close());
  send(badSequence, 0, 'join');
  const sequenceError = await waitFor(
    () => badSequence.messages.find((message) => message.payload?.code === 'BAD_SEQUENCE'),
  );
  assert.equal(sequenceError.type, 'error');

  const binary = await openClient(`${base}dev:binary:binary-room`);
  binary.ws.send(Buffer.from([1, 2, 3]));
  const closeCode = await new Promise((resolve) => binary.ws.once('close', resolve));
  assert.equal(closeCode, 1003);

  const oversized = await openClient(`${base}dev:oversized:oversized-room`);
  oversized.ws.send('x'.repeat(9000));
  const oversizedCode = await new Promise((resolve) => oversized.ws.once('close', resolve));
  assert.equal(oversizedCode, 1009);

  const flood = await openClient(`${base}dev:flood:flood-room`);
  await delay(100);
  for (let seq = 1; seq <= 12; seq++) send(flood, seq, 'heartbeat');
  const floodCode = await new Promise((resolve) => flood.ws.once('close', resolve));
  assert.equal(floodCode, 1005);
});
