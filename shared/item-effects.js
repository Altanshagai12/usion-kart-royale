export const SHIELD_SECONDS = 7.4;

/** Shared by local and authoritative modes: Shield grants immunity only. */
export function activateShield(target, seconds = SHIELD_SECONDS) {
  target.starTime = Math.max(Number(target.starTime) || 0, seconds);
  return target.starTime;
}
