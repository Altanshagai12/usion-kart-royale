import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KART_RADIUS, MAX_LATERAL_ACCEL, STEER_ACCEL, STEER_RATE_LOW,
} from '../shared/constants.js';
import {
  createPlayer, halfWidthAt, stepPlayer,
} from '../shared/race-sim.js';

function run(hz, segments, speed = 20) {
  let state = { ...createPlayer({ slot: 0, userId: 'p1', name: 'P1' }), speed };
  const samples = [];
  for (const [seconds, steer] of segments) {
    for (let i = 0; i < Math.round(seconds * hz); i++) {
      state = stepPlayer(state, { steer, accel: 1 }, 1 / hz);
      samples.push({ rack: state.rack, velocity: state.rackVelocity });
    }
  }
  return { state, samples };
}

test('steering rack is continuous during turn-in and counter-steer', () => {
  const { samples } = run(60, [[0.5, 1], [0.7, -1]]);
  for (let i = 1; i < samples.length; i++) {
    const rackStep = Math.abs(samples[i].rack - samples[i - 1].rack);
    const velocityStep = Math.abs(samples[i].velocity - samples[i - 1].velocity);
    assert.ok(rackStep <= STEER_RATE_LOW / 60 + 0.002, `rack jumped ${rackStep}`);
    assert.ok(velocityStep <= STEER_ACCEL / 60 + 0.002, `velocity jumped ${velocityStep}`);
  }
  assert.ok(samples[29].rack > 0.5, 'turn-in should still feel responsive');
  assert.ok(samples.at(-1).rack < -0.5, 'counter-steer should cross the rack');
});

test('steering response is stable at 30, 60, and 120 Hz', () => {
  const results = [30, 60, 120].map((hz) => run(hz, [
    [0.5, 1], [0.5, -1], [0.5, 0],
  ]).state);
  for (const key of ['rack', 'rackVelocity', 'heading', 'lateral']) {
    const values = results.map((row) => row[key]);
    assert.ok(Math.max(...values) - Math.min(...values) < 0.12, `${key}: ${values}`);
  }
  for (const row of results) assert.ok(Math.abs(row.rack) < 0.12, 'rack should recenter');
});

test('full steering is slightly softer without weakening rack response', () => {
  const results = [30, 60, 120].map((hz) => {
    let state = {
      ...createPlayer({ slot: 0, userId: `calibration-${hz}`, name: 'Calibration' }),
      lateral: 0,
      speed: 20,
    };
    for (let i = 0; i < hz * 0.5; i++) {
      state = stepPlayer(state, { steer: 1, accel: 0 }, 1 / hz);
    }
    return state;
  });
  const lateral = results.map((row) => row.lateral);
  for (const row of results) {
    assert.ok(row.rack > 0.9, `rack response weakened to ${row.rack}`);
    assert.ok(row.lateral > 0.62 && row.lateral < 0.66, `turn escaped calibrated range: ${row.lateral}`);
  }
  assert.ok(Math.max(...lateral) - Math.min(...lateral) < 0.02, `lateral spread: ${lateral}`);
});

test('Devil mirrors authoritative steering with equal rack travel', () => {
  const normal = createPlayer({ slot: 0, userId: 'normal', name: 'Normal' });
  const devil = { ...createPlayer({ slot: 1, userId: 'devil', name: 'Devil' }), shrinkTime: 1 };
  const normalLeft = stepPlayer(normal, { steer: -0.72, accel: 1, brake: 0, drift: false }, 1 / 60);
  const devilRight = stepPlayer(devil, { steer: 0.72, accel: 1, brake: 0, drift: false }, 1 / 60);
  assert.equal(devilRight.rack, normalLeft.rack);
  assert.equal(devilRight.rackVelocity, normalLeft.rackVelocity);

  const devilLeft = stepPlayer(devil, { steer: -0.72, accel: 1, brake: 0, drift: false }, 1 / 60);
  assert.equal(devilLeft.rack, -devilRight.rack);
  assert.equal(devilLeft.rackVelocity, -devilRight.rackVelocity);
});

test('small analog input stays proportional instead of snapping to full lock', () => {
  const gentle = run(60, [[0.6, 0.25]]).state;
  const full = run(60, [[0.6, 1]]).state;
  assert.ok(gentle.rack > 0.15 && gentle.rack < 0.35);
  assert.ok(full.rack > gentle.rack * 2);
});

test('full steering at race speed stays grip-limited and controllable', () => {
  let state = {
    ...createPlayer({ slot: 0, userId: 'p1', name: 'P1' }),
    lateral: 0,
    speed: 20,
  };
  let peakLateralAccel = 0;
  for (let i = 0; i < 60; i++) {
    state = stepPlayer(state, { steer: 1, accel: 0 }, 1 / 60);
    peakLateralAccel = Math.max(
      peakLateralAccel,
      Math.abs(state.yawRate * state.speed),
    );
  }
  assert.ok(
    peakLateralAccel <= MAX_LATERAL_ACCEL + 0.2,
    `lateral acceleration escaped grip limit: ${peakLateralAccel}`,
  );
  assert.ok(
    state.lateral > 4 && state.lateral < 5.5,
    `full lock response escaped the usable window: ${state.lateral}m in one second`,
  );
  assert.ok(state.speed > 14, 'a one-second turn must not slam the kart into the edge');
});

test('full steering retains correction authority in the tightest bend at top speed', () => {
  let state = {
    ...createPlayer({ slot: 0, userId: 'tight-left', name: 'Tight left' }),
    distance: 1214,
    lateral: 0,
    speed: 30,
  };
  for (let i = 0; i < 60; i++) {
    state = stepPlayer(state, { steer: -1, accel: 1 }, 1 / 60);
  }
  assert.ok(
    state.heading < 0,
    `full lock never overcame the bend's outward heading: ${state.heading}`,
  );
  assert.ok(
    state.lateral < 1.8,
    `full lock left the kart drifting outward by ${state.lateral}m`,
  );
});

test('releasing steering settles the travel heading without an edge snap', () => {
  let state = {
    ...createPlayer({ slot: 0, userId: 'p1', name: 'P1' }),
    lateral: 0,
  };
  for (let i = 0; i < 54; i++) {
    state = stepPlayer(state, { steer: 1, accel: 1 }, 1 / 60);
  }
  for (let i = 0; i < 96; i++) {
    state = stepPlayer(state, { steer: 0, accel: 1 }, 1 / 60);
  }
  assert.ok(Math.abs(state.heading) < 0.12, `released heading stayed at ${state.heading}`);
  const safeEdge = halfWidthAt(state.distance) - KART_RADIUS - 0.4;
  assert.ok(
    Math.abs(state.lateral) < safeEdge,
    `released kart reached the road edge at ${state.lateral}`,
  );
  assert.ok(state.speed > 16, 'steering release should preserve forward momentum');
});

test('road edge recovery is smooth, frame-rate stable, and cannot trap the kart', () => {
  const outcomes = [30, 60, 120].map((hz) => {
    const distance = 420;
    const edge = halfWidthAt(distance) - KART_RADIUS;
    let state = {
      ...createPlayer({ slot: 0, userId: `edge-${hz}`, name: 'Edge' }),
      distance,
      lateral: edge + 0.8,
      speed: 12,
      heading: 0.55,
      yawRate: 0.45,
    };
    let largestHeadingStep = 0;
    for (let i = 0; i < hz * 2; i++) {
      const before = state.heading;
      state = stepPlayer(state, { steer: 0, accel: 1 }, 1 / hz);
      largestHeadingStep = Math.max(largestHeadingStep, Math.abs(state.heading - before));
    }
    assert.ok(Math.abs(state.lateral) < edge - 0.15, `${hz} Hz stayed pinned at ${state.lateral}`);
    assert.ok(state.speed > 8, `${hz} Hz edge recovery killed momentum (${state.speed})`);
    assert.ok(largestHeadingStep < 0.12, `${hz} Hz heading snapped by ${largestHeadingStep}`);
    return state;
  });
  const lateral = outcomes.map((row) => row.lateral);
  const speed = outcomes.map((row) => row.speed);
  assert.ok(Math.max(...lateral) - Math.min(...lateral) < 0.25, `lateral: ${lateral}`);
  assert.ok(Math.max(...speed) - Math.min(...speed) < 0.25, `speed: ${speed}`);
});
