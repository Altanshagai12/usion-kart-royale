/**
 * The six items Kart Royale can award. Numeric IDs intentionally keep the
 * original wire values so old replays and in-flight snapshots remain readable.
 */
export const ACTIVE_ITEM_KINDS = Object.freeze([1, 3, 4, 5, 6, 7]);

/** leader / midfield / last-place weights */
export const ITEM_ROLL_WEIGHTS = Object.freeze({
  1: Object.freeze([14, 30, 20]), // Turbo
  3: Object.freeze([30, 18, 7]),  // Slow Disc
  4: Object.freeze([5, 22, 20]),  // Fly Ball
  5: Object.freeze([36, 14, 5]),  // Banana
  6: Object.freeze([10, 10, 20]), // Shield
  7: Object.freeze([5, 6, 16]),   // Devil
});

export function isActiveItemKind(kind) {
  return ACTIVE_ITEM_KINDS.includes(kind);
}
