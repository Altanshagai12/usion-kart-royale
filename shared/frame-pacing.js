const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function normalizeFramePressure(renderMs, intervalMs, displayFrameMs) {
  const baseline = Number.isFinite(displayFrameMs)
    ? clamp(displayFrameMs, 4, 50)
    : 1000 / 60;
  const render = Number.isFinite(renderMs) ? Math.max(0, renderMs) : baseline;
  const interval = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : baseline;
  return Math.max(render, interval) / baseline;
}

export async function measureFrameCadence(requestFrame, maxCallbacks = 30, timeoutMs = 1500) {
  const samples = [];
  let previous = null;
  let callbacks = 0;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const sample = (now) => {
      if (settled) return;
      callbacks += 1;
      if (previous !== null) {
        const interval = now - previous;
        if (interval >= 4 && interval <= 100) samples.push(interval);
      }
      previous = now;
      if (samples.length >= 12 || callbacks >= maxCallbacks) finish();
      else requestFrame(sample);
    };
    const timer = setTimeout(finish, timeoutMs);
    requestFrame(sample);
  });
  if (!samples.length) return 1000 / 60;
  samples.sort((a, b) => a - b);
  return clamp(samples[Math.floor(samples.length / 2)], 4, 50);
}

export function updateFrameIntervalEma(current, intervalMs, baselineMs, weight = 0.08) {
  const baseline = Number.isFinite(baselineMs) ? clamp(baselineMs, 4, 50) : 1000 / 60;
  const previous = Number.isFinite(current) ? current : baseline;
  // Sustained low cadence is real pressure, including sub-10fps WebViews.
  // A single debugger/background suspension gap is not, so reject only gaps
  // long enough to be discontinuities rather than rendered gameplay.
  if (!Number.isFinite(intervalMs) || intervalMs < 4 || intervalMs >= 250) return previous;
  return previous + (intervalMs - previous) * clamp(weight, 0, 1);
}

export function stepLodGovernor(governor, pressure, dt, floor = 0.55) {
  let next = clamp(Number(governor) || 1, floor, 1);
  const p = Number.isFinite(pressure) ? pressure : 1;
  const seconds = Math.max(0, Number(dt) || 0);
  if (p > 1.18) next = Math.max(floor, next - seconds * 0.8);
  else if (p < 1.05) next = Math.min(1, next + seconds * 0.06);
  return next;
}
