import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PLAYERS, RECONNECT_GRACE_MS, SNAPSHOT_MAX_BYTES,
} from '../shared/constants.js';
import { Room } from '../server/Room.js';

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

test('maximum roster snapshot stays inside the JSON transport budget', () => {
  const room = new Room('size-room', { onDestroy() {} });
  for (let i = 0; i < MAX_PLAYERS; i++) room.join(connection(`player-${i}`, room));
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
  room.join(first);
  room.join(second);
  assert.equal(room.players.find((player) => player.userId === 'second').slot, 1);

  room.detach(first);
  room.players.find((player) => player.userId === 'first').disconnectedAt =
    Date.now() - RECONNECT_GRACE_MS - 1;
  room.sweepConnections();
  assert.equal(room.players.find((player) => player.userId === 'second').slot, 1);

  const replacement = connection('replacement', room);
  room.join(replacement);
  assert.equal(room.players.find((player) => player.userId === 'replacement').slot, 0);
  assert.equal(room.players.find((player) => player.userId === 'second').slot, 1);
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
