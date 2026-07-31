import { TRACK_LENGTH } from './constants.js';
import { halfWidthAt } from './race-sim.js';

export const ITEM_BOX_RESPAWN = 2.5;
export const ITEM_BOX_PICKUP_RADIUS = 1.9;
export const ITEM_BOX_HEIGHT = 1.05;
export const ITEM_ARM_TIME = 1.05;

export const ITEM_BOX_ROWS = [
  0.052, 0.148, 0.246, 0.336, 0.428,
  0.505, 0.646, 0.712, 0.802, 0.906,
];

const ROW_MARGIN = 1.8;
const LANE_GAP = 3.1;
const MIN_LANES = 3;
const MAX_LANES = 8;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Stable track-space box IDs shared by the server authority and renderer.
 * Layout never depends on Three.js spline resampling.
 */
export function createItemBoxLayout() {
  const boxes = [];
  for (const t of ITEM_BOX_ROWS) {
    const distance = t * TRACK_LENGTH;
    const reach = Math.max(2.4, halfWidthAt(distance) - ROW_MARGIN);
    const lanes = clamp(
      Math.round((reach * 2) / LANE_GAP) + 1,
      MIN_LANES,
      MAX_LANES,
    );
    for (let lane = 0; lane < lanes; lane++) {
      boxes.push({
        id: boxes.length,
        distance,
        lateral: ((lane / (lanes - 1)) * 2 - 1) * reach,
      });
    }
  }
  return boxes;
}
