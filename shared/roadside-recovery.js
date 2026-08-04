export const VERGE_RECOVERY_SECONDS = 4.5;
export const VERGE_MIN_PROGRESS_MPS = 1.4;

/**
 * Long-grace recovery for driveable grass/sand verges.
 *
 * Water and true off-track surfaces keep the race director's fast watchdog.
 * This helper only catches the awkward middle case: the player is pressing a
 * pedal, the kart is technically moving, but it is making no useful progress
 * back toward the circuit. Brief shortcuts across grass never reach the limit.
 */
export function stepVergeRecovery(state, sample, dt) {
  const safeDt = Math.max(0, Number(dt) || 0);
  const distance = Number(sample.distance) || 0;
  const previous = Number.isFinite(state.lastDistance) ? state.lastDistance : distance;
  const progressMps = safeDt > 0 ? Math.abs(distance - previous) / safeDt : 0;
  let timer = Math.max(0, Number(state.timer) || 0);

  const trying = sample.onVerge === true
    && sample.stunned !== true
    && Number(sample.effort) > 0.15;
  if (!trying) timer = 0;
  else if (progressMps < VERGE_MIN_PROGRESS_MPS) timer += safeDt;
  else timer = Math.max(0, timer - safeDt * 0.75);

  return {
    timer,
    lastDistance: distance,
    progressMps,
    shouldRespawn: timer >= VERGE_RECOVERY_SECONDS,
  };
}
