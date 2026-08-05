export const SHIELD_SECONDS = 7.4;

/** Shared by local and authoritative modes: Shield grants immunity only. */
export function activateShield(target, seconds = SHIELD_SECONDS) {
  target.starTime = Math.max(Number(target.starTime) || 0, seconds);
  return target.starTime;
}

/** Devil reverses steering only; every other drive command stays untouched. */
export function applyDevilSteering(steer, active) {
  return active ? -steer : steer;
}
