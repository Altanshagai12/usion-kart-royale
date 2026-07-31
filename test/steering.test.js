import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STEER_ACCEL, STEER_RATE_LOW,
} from '../shared/constants.js';
import {
  createPlayer, stepPlayer,
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

test('small analog input stays proportional instead of snapping to full lock', () => {
  const gentle = run(60, [[0.6, 0.25]]).state;
  const full = run(60, [[0.6, 1]]).state;
  assert.ok(gentle.rack > 0.15 && gentle.rack < 0.35);
  assert.ok(full.rack > gentle.rack * 2);
});
