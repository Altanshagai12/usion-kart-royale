import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayer } from '../shared/race-sim.js';
import { createItemBoxLayout, ITEM_BOX_RESPAWN } from '../shared/item-layout.js';
import {
  ACTIVE_ITEM_KINDS, ITEM_KIND, createItemRuntime, stepItemRuntime, useItemRuntime,
} from '../server/item-runtime.js';
import { MAX_ITEM_ENTITIES } from '../shared/constants.js';
import { syncLegacyItem } from '../shared/item-inventory.js';
import { activateShield, SHIELD_SECONDS } from '../shared/item-effects.js';

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
  assert.deepEqual(runtime.events.at(-1), {
    id: 1, type: 'pickup', slot: 0, kind: first.itemKind, box_id: box.id,
  });

  stepItemRuntime(runtime, [first], ITEM_BOX_RESPAWN + 0.01);
  assert.equal(first.itemSlots.filter((item) => item.kind > 0).length, 2);
});

test('roulette awards exactly the six Kart Royale items', () => {
  const awarded = new Set();
  for (let seed = 1; seed <= 800; seed++) {
    const runtime = createItemRuntime((seed * 2654435761) >>> 0);
    const box = runtime.boxes[0];
    const player = createPlayer({ slot: 0, userId: `p-${seed}`, name: 'racer' });
    player.distance = box.distance;
    player.lateral = box.lateral;
    player.place = 1 + (seed % 4);
    const field = [player, ...[1, 2, 3].map((slot) => {
      const rival = createPlayer({ slot, userId: `r-${seed}-${slot}`, name: 'rival' });
      rival.distance = box.distance + 100 + slot;
      rival.place = slot + 1;
      return rival;
    })];
    stepItemRuntime(runtime, field, 1 / 60);
    awarded.add(player.itemKind);
  }
  assert.deepEqual([...awarded].sort((a, b) => a - b), [...ACTIVE_ITEM_KINDS]);
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

test('Shield is pure damage immunity and never changes speed or boost state', () => {
  const target = createPlayer({ slot: 0, userId: 'shield', name: 'shield' });
  target.speed = 17;
  target.boostTime = 0;
  assert.equal(activateShield(target), SHIELD_SECONDS);
  assert.equal(target.speed, 17);
  assert.equal(target.boostTime, 0);

  const runtime = createItemRuntime(13);
  const attacker = createPlayer({ slot: 1, userId: 'attacker', name: 'attacker' });
  setItem(attacker, 0, ITEM_KIND.BOLT);
  assert.equal(useItemRuntime(runtime, attacker, [target, attacker]), true);
  assert.equal(target.stunTime, 0, 'Shield absorbs Devil damage');
  assert.equal(target.shrinkTime, 0, 'Shield absorbs Devil slowdown');
  assert.equal(target.speed, 17);
});

test('Shield absorbs every active track projectile instead of passing it through', () => {
  for (const kind of [ITEM_KIND.GREEN_SHELL, ITEM_KIND.RED_SHELL, ITEM_KIND.BANANA]) {
    const runtime = createItemRuntime(17 + kind);
    const target = createPlayer({ slot: 0, userId: `shield-${kind}`, name: 'shield' });
    const attacker = createPlayer({ slot: 1, userId: `attacker-${kind}`, name: 'attacker' });
    target.distance = 100;
    target.speed = 18;
    activateShield(target);
    runtime.entities.push({
      id: kind, kind, owner: attacker.slot, target: target.slot,
      distance: target.distance, lateral: target.lateral,
      direction: 1, speed: 0, ttl: 5, ownerLock: 0,
    });
    stepItemRuntime(runtime, [target, attacker], 1 / 60);
    assert.equal(runtime.entities.length, 0, `Shield must consume item ${kind}`);
    assert.equal(target.stunTime, 0);
    assert.equal(target.speed, 18);
  }
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
