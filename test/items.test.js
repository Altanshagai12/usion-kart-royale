import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayer } from '../shared/race-sim.js';
import { createItemBoxLayout, ITEM_BOX_RESPAWN } from '../shared/item-layout.js';
import {
  ITEM_KIND, createItemRuntime, stepItemRuntime, useItemRuntime,
} from '../server/item-runtime.js';
import { MAX_ITEM_ENTITIES } from '../shared/constants.js';
import { syncLegacyItem } from '../shared/item-inventory.js';

function setItem(player, slot, kind, count = 1, arm = 0) {
  Object.assign(player.itemSlots[slot], { kind, count, arm });
  syncLegacyItem(player);
}

test('shared item-box layout is stable, unique, and covers every authored row', () => {
  const a = createItemBoxLayout();
  const b = createItemBoxLayout();
  assert.deepEqual(a, b);
  assert.ok(a.length >= 30);
  assert.deepEqual(a.map((box) => box.id), a.map((_, id) => id));
  assert.equal(new Set(a.map((box) => box.distance)).size, 10);
});

test('server owns pickup exclusivity and box respawn', () => {
  const runtime = createItemRuntime(123);
  const box = runtime.boxes[0];
  const first = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  const second = createPlayer({ slot: 1, userId: 'two', name: 'two' });
  for (const player of [first, second]) {
    player.distance = box.distance;
    player.lateral = box.lateral;
  }

  stepItemRuntime(runtime, [first, second], 1 / 60);
  assert.notEqual(first.itemKind, ITEM_KIND.NONE);
  assert.equal(second.itemKind, ITEM_KIND.NONE);
  assert.ok(box.cooldown > ITEM_BOX_RESPAWN - 0.1);

  stepItemRuntime(runtime, [first], ITEM_BOX_RESPAWN + 0.01);
  assert.equal(first.itemSlots.filter((item) => item.kind > 0).length, 2);
});

test('three stable inventory slots fill independently and a full inventory leaves boxes live', () => {
  const runtime = createItemRuntime(321);
  const player = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  for (let i = 0; i < 3; i++) {
    const box = runtime.boxes[i];
    player.distance = box.distance;
    player.lateral = box.lateral;
    stepItemRuntime(runtime, [player], 1 / 60);
  }
  assert.equal(player.itemSlots.filter((item) => item.kind > 0).length, 3);
  const untouched = runtime.boxes[3];
  player.distance = untouched.distance;
  player.lateral = untouched.lateral;
  stepItemRuntime(runtime, [player], 1 / 60);
  assert.equal(untouched.cooldown, 0);
});

test('authoritative item use consumes once and applies server effects', () => {
  const runtime = createItemRuntime(7);
  const user = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  const target = createPlayer({ slot: 1, userId: 'two', name: 'two' });
  setItem(user, 0, ITEM_KIND.TRIPLE_MUSHROOM, 3);
  setItem(user, 1, ITEM_KIND.BOLT);
  assert.equal(useItemRuntime(runtime, user, [user, target]), true);
  assert.equal(user.itemSlots[0].count, 2);
  assert.equal(user.itemSlots[1].kind, ITEM_KIND.BOLT);
  assert.ok(user.boostTime > 1);
  assert.equal(useItemRuntime(runtime, user, [user, target]), false, 're-arm blocks duplicate use');

  assert.equal(useItemRuntime(runtime, user, [user, target], false, 1), true);
  assert.equal(user.itemSlots[0].count, 2, 'selected slot use leaves neighbours unchanged');
  assert.equal(user.itemSlots[1].kind, ITEM_KIND.NONE);
  assert.ok(target.stunTime > 0);
  assert.ok(target.shrinkTime > 0);
});

test('server projectile state, not client hit claims, decides shell hits', () => {
  const runtime = createItemRuntime(9);
  const user = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  const target = createPlayer({ slot: 1, userId: 'two', name: 'two' });
  user.distance = 100;
  target.distance = 112;
  user.lateral = target.lateral = 0;
  setItem(user, 0, ITEM_KIND.RED_SHELL);
  assert.equal(useItemRuntime(runtime, user, [user, target]), true);
  assert.equal(runtime.entities.length, 1);
  for (let i = 0; i < 60 && target.stunTime === 0; i++) {
    stepItemRuntime(runtime, [user, target], 1 / 60);
  }
  assert.ok(target.stunTime > 0);
  assert.equal(runtime.entities.length, 0);
});

test('authoritative entity cap never creates an invisible extra hazard', () => {
  const runtime = createItemRuntime(11);
  runtime.entities = Array.from({ length: MAX_ITEM_ENTITIES }, (_, id) => ({
    id, kind: ITEM_KIND.BANANA, owner: id % 4, target: -1,
    distance: id * 3, lateral: 0, direction: 1, speed: 0, ttl: 30, ownerLock: 0,
  }));
  const user = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  setItem(user, 0, ITEM_KIND.GREEN_SHELL);
  assert.equal(useItemRuntime(runtime, user, [user]), false);
  assert.equal(runtime.entities.length, MAX_ITEM_ENTITIES);
  assert.equal(user.itemKind, ITEM_KIND.GREEN_SHELL);
  assert.equal(user.itemCount, 1);
});
