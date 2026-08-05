import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ITEM_ENTITIES, MAX_PLAYERS, RECONNECT_GRACE_MS, SNAPSHOT_MAX_BYTES,
} from '../shared/constants.js';
import { Room } from '../server/Room.js';
import { ITEM_KIND } from '../server/item-runtime.js';
import { syncLegacyItem } from '../shared/item-inventory.js';

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}

function connection(id, room) {
  return {
    ws: new Socket(),
    userId: id,
    name: id,
    sessionId: `session-${id}`,
    spectator: false,
    room,
    lastSeenMs: Date.now(),
  };
}

test('authenticated connection keeps an empty room alive until its join frame arrives', () => {
  let destroys = 0;
  const room = new Room('pending-room', { onDestroy() { destroys += 1; } });
  const conn = connection('slow-boot', room);
  room.attachPending(conn);

  room.sweepConnections();
  assert.equal(room.destroyed, false);
  assert.equal(destroys, 0);

  room.join(conn);
  assert.equal(room.pendingConnections.size, 0);
  assert.equal(room.players[0].userId, 'slow-boot');
  room.destroy();
});

test('pre-join leave closes and fully detaches the authenticated socket', () => {
  const room = new Room('pending-leave-room', { onDestroy() {} });
  const conn = connection('leaving', room);
  room.attachPending(conn);

  room.handleMessage(conn, { type: 'leave', seq: 1 });

  assert.equal(conn.ws.readyState, 3);
  assert.equal(room.pendingConnections.has(conn), false);
  assert.equal(room.spectators.has(conn), false);
  assert.equal(room.connections.has(conn.userId), false);
  assert.equal(conn.joinTimer, null);
  room.destroy();
});

test('heartbeat cannot extend the authenticated join deadline', async () => {
  const room = new Room('pending-timeout-room', {
    onDestroy() {}, joinTimeoutMs: 20,
  });
  const conn = connection('heartbeat-only', room);
  room.attachPending(conn);
  conn.lastSeenMs = Date.now();
  room.handleMessage(conn, { type: 'heartbeat', seq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(conn.ws.readyState, 3);
  assert.equal(room.pendingConnections.has(conn), false);
  assert.equal(conn.joinTimer, null);
  room.destroy();
});

test('pending join capacity rejects excess authenticated sockets', () => {
  const room = new Room('pending-cap-room', {
    onDestroy() {}, maxPendingConnections: 1,
  });
  const first = connection('first-pending', room);
  const excess = connection('excess-pending', room);

  assert.equal(room.attachPending(first), true);
  assert.equal(room.attachPending(excess), false);
  assert.equal(room.pendingConnections.size, 1);
  assert.equal(excess.ws.readyState, 3);
  assert.equal(excess.joinTimer, undefined);
  room.destroy();
});

test('unicast join and resync keyframes never consume broadcast sequence', () => {
  const room = new Room('seq-room', { onDestroy() {} });
  const conn = connection('one', room);
  room.join(conn);
  assert.equal(room.snapSeq, 0);
  room.unicastKeyframe(conn);
  assert.equal(room.snapSeq, 0);
  room.netTickFrame();
  assert.equal(room.snapSeq, 1);
  room.destroy();
});

test('stale input is ignored and reconnect replaces the old transport', () => {
  const room = new Room('reconnect-room', { onDestroy() {} });
  const first = connection('one', room);
  room.join(first);
  room.phase = 'countdown';
  room.input(first, {
    action_type: 'drive',
    action_data: { steer: 0.4, accel: 1, iseq: 4 },
  });
  room.input(first, {
    action_type: 'drive',
    action_data: { steer: -1, accel: 0, iseq: 3 },
  });
  assert.equal(room.players[0].ackIseq, 4);
  assert.equal(room.players[0].input.steer, 0.4);

  const second = connection('one', room);
  room.join(second);
  assert.equal(first.ws.readyState, 3);
  assert.equal(room.connections.get('one'), second);
  assert.equal(room.players.length, 1);
  room.destroy();
});

test('waiting room requires guest readiness and an authorized host start', () => {
  const room = new Room('lobby-room', { onDestroy() {} });
  const host = connection('host', room);
  const guest = connection('guest', room);
  room.join(host);
  room.join(guest);

  assert.equal(room.phase, 'waiting');
  assert.equal(room.roster().find((row) => row.user_id === 'host').is_host, true);
  assert.equal(room.roster().find((row) => row.user_id === 'guest').ready, false);
  assert.equal(room.requestStart(guest), false, 'a guest must never start the room');
  assert.equal(room.requestStart(host), false, 'host must wait until guests are ready');

  room.input(guest, { action_type: 'lobby_ready', action_data: { ready: true } });
  assert.equal(room.roster().find((row) => row.user_id === 'guest').ready, true);
  assert.equal(room.requestStart(host), true);
  assert.equal(room.phase, 'countdown');

  const late = connection('late', room);
  room.join(late);
  assert.equal(late.spectator, true, 'the host start locks the race roster');
  room.destroy();
});

test('item actions are exactly-once and ignore client-authored item kinds', () => {
  const room = new Room('item-room', { onDestroy() {} });
  const conn = connection('one', room);
  room.join(conn);
  room.phase = 'playing';
  const player = room.players[0];
  Object.assign(player.itemSlots[0], { kind: ITEM_KIND.TRIPLE_MUSHROOM, count: 3, arm: 0 });
  Object.assign(player.itemSlots[1], { kind: ITEM_KIND.BOLT, count: 1, arm: 0 });
  syncLegacyItem(player);

  const action = {
    action_type: 'use_item',
    action_data: {
      item_seq: 1,
      item_revision: player.itemRevision,
      item_slot_revision: player.itemSlots[0].revision,
      expected_kind: player.itemKind,
      item_slot: 0,
      kind: ITEM_KIND.BOLT,
      hit_slot: 99,
    },
  };
  room.input(conn, action);
  room.input(conn, action);
  assert.equal(player.ackItemSeq, 1);
  assert.equal(player.itemKind, ITEM_KIND.TRIPLE_MUSHROOM);
  assert.equal(player.itemCount, 2);
  assert.equal(player.itemSlots[1].kind, ITEM_KIND.BOLT);
  assert.ok(player.boostTime > 0);
  const slotZeroRevision = player.itemSlots[0].revision;
  const staleGlobalRevision = player.itemRevision;
  player.itemSlots[0].arm = 0;
  player.itemSlots[1].revision += 1;
  player.itemRevision += 1;
  room.input(conn, {
    action_type: 'use_item',
    action_data: {
      item_seq: 2,
      item_revision: staleGlobalRevision,
      item_slot_revision: slotZeroRevision,
      expected_kind: ITEM_KIND.TRIPLE_MUSHROOM,
      item_slot: 0,
    },
  });
  assert.equal(player.itemSlots[0].count, 1, 'another slot revision must not reject this use');
  room.input(conn, {
    action_type: 'use_item',
    action_data: { item_seq: Number.POSITIVE_INFINITY },
  });
  assert.equal(player.ackItemSeq, 2);
  room.input(conn, {
    action_type: 'use_item',
    action_data: {
      item_seq: 3,
      item_revision: player.itemRevision,
      expected_kind: ITEM_KIND.BOLT,
      item_slot: 9,
    },
  });
  assert.equal(player.ackItemSeq, 3);
  assert.equal(player.itemSlots[1].kind, ITEM_KIND.BOLT, 'invalid slot is acked but not consumed');
  room.destroy();
});

test('maximum roster snapshot stays inside the JSON transport budget', () => {
  const room = new Room('size-room', { onDestroy() {} });
  for (let i = 0; i < MAX_PLAYERS; i++) room.join(connection(`player-${i}`, room));
  for (const box of room.items.boxes) box.cooldown = 2.5;
  room.items.entities = Array.from({ length: MAX_ITEM_ENTITIES }, (_, id) => ({
    id, kind: ITEM_KIND.GREEN_SHELL, distance: id * 10, lateral: id % 8,
  }));
  room.items.events = Array.from({ length: 32 }, (_, id) => ({
    id: id + 1, type: 'hit', slot: id % MAX_PLAYERS, kind: ITEM_KIND.GREEN_SHELL,
  }));
  const { json } = room.snapshot({ keyframe: true });
  assert.ok(Buffer.byteLength(json) < SNAPSHOT_MAX_BYTES);
  room.destroy();
});

test('slow clients skip obsolete snapshots without blocking the room', () => {
  const room = new Room('slow-room', { onDestroy() {} });
  const slow = connection('slow', room);
  room.join(slow);
  slow.ws.sent.length = 0;
  slow.ws.bufferedAmount = SNAPSHOT_MAX_BYTES * 9;
  room.netTickFrame();
  assert.equal(slow.ws.sent.length, 0);
  assert.equal(room.snapSeq, 1);
  room.destroy();
});

test('waiting-room cleanup preserves every surviving player slot', () => {
  const room = new Room('stable-slot-room', { onDestroy() {} });
  const first = connection('first', room);
  const second = connection('second', room);
  const third = connection('third', room);
  room.join(first);
  room.join(second);
  room.join(third);
  assert.equal(room.players.find((player) => player.userId === 'second').slot, 1);

  room.detach(second);
  room.players.find((player) => player.userId === 'second').disconnectedAt =
    Date.now() - RECONNECT_GRACE_MS - 1;
  room.sweepConnections();
  assert.equal(room.players.find((player) => player.userId === 'third').slot, 2);

  const replacement = connection('replacement', room);
  room.join(replacement);
  assert.equal(room.players.find((player) => player.userId === 'replacement').slot, 1);
  assert.equal(room.players.find((player) => player.userId === 'third').slot, 2);
  room.destroy();
});

test('host expiry closes the waiting room instead of silently migrating authority', () => {
  const room = new Room('host-left-room', { onDestroy() {} });
  const host = connection('host', room);
  const guest = connection('guest', room);
  room.join(host);
  room.join(guest);
  room.detach(host);
  room.players.find((player) => player.userId === 'host').disconnectedAt =
    Date.now() - RECONNECT_GRACE_MS - 1;
  room.sweepConnections();
  assert.equal(room.phase, 'finished');
  assert.ok(guest.ws.sent.some((message) => (
    message.type === 'match_end' && message.payload.reason === 'host_left'
      && message.payload.winner_ids.length === 0
  )));
  room.destroy();
});

test('guest readiness survives a reconnect inside the grace window', () => {
  const room = new Room('ready-reconnect-room', { onDestroy() {} });
  const host = connection('host', room);
  const guest = connection('guest', room);
  room.join(host);
  room.join(guest);
  room.setReady(guest, true);
  room.detach(guest);
  const reconnect = connection('guest', room);
  room.join(reconnect);
  assert.equal(room.roster().find((row) => row.user_id === 'guest').ready, true);
  assert.equal(room.requestStart(host), true);
  room.destroy();
});

test('race completion sends a final finished snapshot before match_end', () => {
  const room = new Room('finish-room', { onDestroy() {} });
  const conn = connection('winner', room);
  room.join(conn);
  conn.ws.sent.length = 0;
  room.phase = 'playing';
  room.finish('race_complete');
  assert.ok(['state_snapshot', 'state_delta'].includes(conn.ws.sent[0].type));
  assert.equal(conn.ws.sent[0].payload.phase, 'finished');
  assert.equal(conn.ws.sent[1].type, 'match_end');
  room.destroy();
});
