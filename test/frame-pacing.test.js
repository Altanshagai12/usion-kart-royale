import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measureFrameCadence,
  normalizeFramePressure,
  stepLodGovernor,
  updateFrameIntervalEma,
} from '../shared/frame-pacing.js';

test('native 30, 40, 60, and 144 Hz cadence is equally healthy', () => {
  for (const hz of [30, 40, 60, 144]) {
    const interval = 1_000 / hz;
    assert.ok(Math.abs(normalizeFramePressure(interval * 0.7, interval, interval) - 1) < 1e-9);
    let governor = 1;
    for (let frame = 0; frame < hz * 8; frame++) {
      governor = stepLodGovernor(governor, 1, 1 / hz);
    }
    assert.equal(governor, 1, `${hz}Hz native cadence must retain full detail`);
  }
});

test('missed-vsync pressure degrades quickly and recovers deliberately', () => {
  const pressure = normalizeFramePressure(23, 25, 1_000 / 60);
  assert.ok(pressure > 1.4);
  let governor = 1;
  for (let frame = 0; frame < 120; frame++) governor = stepLodGovernor(governor, pressure, 1 / 60);
  assert.equal(governor, 0.55);
  for (let frame = 0; frame < 60; frame++) governor = stepLodGovernor(governor, 1, 1 / 60);
  assert.ok(governor > 0.6 && governor < 0.62);
});

test('cadence calibration is bounded even when every frame exceeds 50 ms', async () => {
  let now = 0;
  let callbacks = 0;
  const cadence = await measureFrameCadence((callback) => {
    callbacks += 1;
    now += 80;
    callback(now);
  });
  assert.equal(cadence, 50);
  assert.equal(callbacks, 13);

  now = 0;
  callbacks = 0;
  const fallback = await measureFrameCadence((callback) => {
    callbacks += 1;
    now += 250;
    callback(now);
  });
  assert.equal(fallback, 1000 / 60);
  assert.equal(callbacks, 30);
});

test('cadence calibration falls back when requestAnimationFrame never returns', async () => {
  const started = performance.now();
  const cadence = await measureFrameCadence(() => {}, 30, 5);
  assert.equal(cadence, 1000 / 60);
  assert.ok(performance.now() - started < 100);
});

test('sustained sub-10fps cadence is pressure but an isolated suspension gap is ignored', () => {
  const baseline = 1000 / 60;
  let ema = baseline;
  for (let frame = 0; frame < 90; frame++) {
    ema = updateFrameIntervalEma(ema, frame % 2 === 0 ? 125 : 150, baseline);
  }
  assert.ok(normalizeFramePressure(8, ema, baseline) > 7);
  const beforeGap = ema;
  ema = updateFrameIntervalEma(ema, 500, baseline);
  assert.equal(ema, beforeGap);
});
