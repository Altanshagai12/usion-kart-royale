import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneItemSlots, ensureItemSlots } from '../shared/item-inventory.js';

test('valid item slots are sanitized in place without per-frame replacement', () => {
  const slots = [
    { kind: 1, count: 2, arm: 0.5, revision: 3 },
    { kind: 0, count: 0, arm: 0, revision: 0 },
    { kind: 8, count: 1, arm: 1, revision: 9 },
  ];
  const player = { itemSlots: slots };
  const identities = [...slots];
  assert.equal(ensureItemSlots(player), slots);
  assert.deepEqual(player.itemSlots, identities);
  for (let i = 0; i < identities.length; i++) assert.equal(player.itemSlots[i], identities[i]);

  const cloned = cloneItemSlots(player);
  assert.notEqual(cloned, slots);
  for (let i = 0; i < cloned.length; i++) assert.notEqual(cloned[i], slots[i]);
});

test('invalid slot fields are normalized without replacing an object slot', () => {
  const bad = { kind: 99, count: -4, arm: Number.NaN, revision: -1 };
  const player = { itemSlots: [bad, null, 'bad'] };
  ensureItemSlots(player);
  assert.equal(player.itemSlots[0], bad);
  assert.deepEqual(player.itemSlots, [
    { kind: 0, count: 0, arm: 0, revision: 0 },
    { kind: 0, count: 0, arm: 0, revision: 0 },
    { kind: 0, count: 0, arm: 0, revision: 0 },
  ]);
});
