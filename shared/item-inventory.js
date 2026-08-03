export const ITEM_SLOT_COUNT = 3;

export function createItemSlots() {
  return Array.from({ length: ITEM_SLOT_COUNT }, () => ({
    kind: 0, count: 0, arm: 0, revision: 0,
  }));
}

export function cloneItemSlots(player) {
  return ensureItemSlots(player).map((slot) => ({ ...slot }));
}

export function ensureItemSlots(player) {
  if (!Array.isArray(player.itemSlots) || player.itemSlots.length !== ITEM_SLOT_COUNT) {
    player.itemSlots = createItemSlots();
  }
  for (let i = 0; i < ITEM_SLOT_COUNT; i++) {
    const raw = player.itemSlots[i] || {};
    player.itemSlots[i] = {
      kind: Number.isSafeInteger(raw.kind) && raw.kind >= 0 && raw.kind <= 8 ? raw.kind : 0,
      count: Number.isSafeInteger(raw.count) && raw.count >= 0 && raw.count <= 3 ? raw.count : 0,
      arm: Number.isFinite(raw.arm) && raw.arm >= 0 ? raw.arm : 0,
      revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    };
  }
  // Rolling compatibility for tests/old state that only carried the legacy
  // single-item fields. Once any real slot exists, the indexed inventory wins.
  if (!player.itemSlots.some((slot) => slot.kind > 0)
      && Number.isSafeInteger(player.itemKind) && player.itemKind > 0 && player.itemKind <= 8) {
    player.itemSlots[0] = {
      kind: player.itemKind,
      count: Math.max(1, Math.min(3, Number(player.itemCount) || 1)),
      arm: Math.max(0, Number(player.itemArm) || 0),
      revision: Number.isSafeInteger(player.itemRevision) && player.itemRevision >= 0
        ? player.itemRevision : 0,
    };
  }
  return player.itemSlots;
}

export function firstOccupiedItemSlot(player) {
  return ensureItemSlots(player).findIndex((slot) => slot.kind > 0 && slot.count > 0);
}

export function firstFreeItemSlot(player) {
  return ensureItemSlots(player).findIndex((slot) => slot.kind === 0 || slot.count <= 0);
}

export function syncLegacyItem(player) {
  const slots = ensureItemSlots(player);
  const index = slots.findIndex((slot) => slot.kind > 0 && slot.count > 0);
  const item = index >= 0 ? slots[index] : { kind: 0, count: 0, arm: 0 };
  player.itemKind = item.kind;
  player.itemCount = item.count;
  player.itemArm = item.arm;
  return index;
}
