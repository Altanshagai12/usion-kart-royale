import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayer } from '../shared/race-sim.js';
import { createItemBoxLayout, ITEM_BOX_RESPAWN } from '../shared/item-layout.js';
import {
  ITEM_KIND, createItemRuntime, stepItemRuntime, useItemRuntime,
} from '../server/item-runtime.js';
import { MAX_ITEM_ENTITIES } from '../shared/constants.js';

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

  first.itemKind = ITEM_KIND.NONE;
  first.itemCount = 0;
  stepItemRuntime(runtime, [first], ITEM_BOX_RESPAWN + 0.01);
  assert.notEqual(first.itemKind, ITEM_KIND.NONE);
});

test('authoritative item use consumes once and applies server effects', () => {
  const runtime = createItemRuntime(7);
  const user = createPlayer({ slot: 0, userId: 'one', name: 'one' });
  const target = createPlayer({ slot: 1, userId: 'two', name: 'two' });
  user.itemKind = ITEM_KIND.TRIPLE_MUSHROOM;
  user.itemCount = 3;
  user.itemArm = 0;
  assert.equal(useItemRuntime(runtime, user, [user, target]), true);
  assert.equal(user.itemCount, 2);
  assert.ok(user.boostTime > 1);
  assert.equal(useItemRuntime(runtime, user, [user, target]), false, 're-arm blocks duplicate use');

  user.itemKind = ITEM_KIND.BOLT;
  user.itemCount = 1;
  user.itemArm = 0;
  assert.equal(useItemRuntime(runtime, user, [user, target]), true);
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
  user.itemKind = ITEM_KIND.RED_SHELL;
  user.itemCount = 1;
  user.itemArm = 0;
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
  user.itemKind = ITEM_KIND.GREEN_SHELL;
  user.itemCount = 1;
  user.itemArm = 0;
  assert.equal(useItemRuntime(runtime, user, [user]), false);
  assert.equal(runtime.entities.length, MAX_ITEM_ENTITIES);
  assert.equal(user.itemKind, ITEM_KIND.GREEN_SHELL);
  assert.equal(user.itemCount, 1);
});
