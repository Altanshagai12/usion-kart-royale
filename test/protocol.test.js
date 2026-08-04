import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ITEM_ENTITIES } from '../shared/constants.js';
import { normalizeSnapshot } from '../src/net/protocol.ts';

function legacySnapshot() {
  return {
    v: 1,
    s: 1,
    server_ts: Date.now(),
    elapsed_ms: 0,
    phase: 'playing',
    countdown_ms: 0,
    roster: [{ slot: 0, user_id: 'one', name: 'one' }],
    ack: { 0: 0 },
    players: [{
      slot: 0,
      user_id: 'one',
      name: 'one',
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
}

test('legacy v1 snapshots normalize to an empty authoritative item state', () => {
  const normalized = normalizeSnapshot(legacySnapshot());
  assert.ok(normalized);
  assert.deepEqual(normalized.items, { box_down: [], entities: [], events: [] });
  assert.equal(normalized.players[0].item_kind, 0);
  assert.equal(normalized.players[0].item_revision, 0);
  assert.deepEqual(normalized.players[0].item_slots, [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(normalized.players[0].item_slot_revisions, [0, 0, 0]);
});

test('snapshot parser accepts exactly three item slots and derives the legacy view', () => {
  const snapshot = legacySnapshot();
  snapshot.players[0].item_slots = [[0, 0, 0], [7, 1, 0.5], [3, 1, 0]];
  snapshot.players[0].item_slot_revisions = [2, 4, 6];
  const normalized = normalizeSnapshot(snapshot);
  assert.ok(normalized);
  assert.deepEqual(normalized.players[0].item_slots, snapshot.players[0].item_slots);
  assert.deepEqual(normalized.players[0].item_slot_revisions, [2, 4, 6]);
  assert.equal(normalized.players[0].item_kind, 7);
  assert.equal(normalized.players[0].item_count, 1);

  for (const bad of [
    [[1, 1, 0]],
    [[1, 1, 0], [0, 0, 0], [0, 0, Number.NaN]],
    [[1, 4, 0], [0, 0, 0], [0, 0, 0]],
    [[0, 1, 0], [0, 0, 0], [0, 0, 0]],
  ]) {
    const malformed = legacySnapshot();
    malformed.players[0].item_slots = bad;
    assert.equal(normalizeSnapshot(malformed), null);
  }
  for (const revisions of [[1], [0, -1, 2], [0, 1.5, 2]]) {
    const malformed = legacySnapshot();
    malformed.players[0].item_slot_revisions = revisions;
    assert.equal(normalizeSnapshot(malformed), null);
  }
});

test('snapshot parser rejects malformed, non-finite, oversized, and unknown data', () => {
  const malformedBox = {
    ...legacySnapshot(),
    items: { box_down: [['bad']], entities: [], events: [] },
  };
  assert.equal(normalizeSnapshot(malformedBox), null);

  const nanPlayer = legacySnapshot();
  nanPlayer.players[0].distance = Number.NaN;
  assert.equal(normalizeSnapshot(nanPlayer), null);

  const oversized = {
    ...legacySnapshot(),
    items: {
      box_down: [],
      events: [],
      entities: Array.from({ length: MAX_ITEM_ENTITIES + 1 }, (_, id) => ({
        id, kind: 3, distance: id, lateral: 0,
      })),
    },
  };
  assert.equal(normalizeSnapshot(oversized), null);
  assert.equal(normalizeSnapshot({ ...legacySnapshot(), v: 2 }), null);
});

test('pickup events carry a bounded item-box id for anchored disappearance effects', () => {
  const snapshot = legacySnapshot();
  snapshot.items = {
    box_down: [[7, 2.5]], entities: [],
    events: [{ id: 1, type: 'pickup', slot: 0, kind: 1, box_id: 7 }],
  };
  assert.ok(normalizeSnapshot(snapshot));

  for (const boxId of [undefined, -1, 64, 1.5, '7']) {
    const malformed = structuredClone(snapshot);
    if (boxId === undefined) delete malformed.items.events[0].box_id;
    else malformed.items.events[0].box_id = boxId;
    assert.equal(normalizeSnapshot(malformed), null);
  }
});

test('snapshot parser bounds every authoritative item-effect duration', () => {
  const effectFields = ['boost_time', 'stun_time', 'star_time', 'shrink_time'];
  const invalidValues = ['bad', Number.NaN, -0.01, 60.01, Number.POSITIVE_INFINITY];

  for (const field of effectFields) {
    for (const value of invalidValues) {
      const snapshot = legacySnapshot();
      snapshot.players[0][field] = value;
      assert.equal(
        normalizeSnapshot(snapshot),
        null,
        `${field} should reject ${String(value)}`,
      );
    }
  }
});
