import assert from 'node:assert/strict';
import test from 'node:test';
import { TOTAL_LAPS, TRACK_LENGTH } from '../shared/constants.js';
import { createPlayer, stepPlayer, stepRace } from '../shared/race-sim.js';

test('finish crossing clamps at the line and prediction cannot drive beyond it', () => {
  const finishDistance = TRACK_LENGTH * TOTAL_LAPS;
  const row = createPlayer({ slot: 0, userId: 'driver', name: 'Driver' });
  Object.assign(row, {
    distance: finishDistance - 0.1,
    lateral: 1.25,
    speed: 30,
    heading: 0,
  });

  const finished = stepRace([row], 1 / 60)[0];
  assert.equal(finished.finished, true);
  assert.equal(finished.lap, TOTAL_LAPS);
  assert.equal(finished.distance, finishDistance);

  const pose = {
    distance: finished.distance,
    lateral: finished.lateral,
    heading: finished.heading,
  };
  let predicted = finished;
  let previousSpeed = predicted.speed;
  for (let frame = 0; frame < 600; frame++) {
    predicted = stepPlayer(predicted, { steer: 1, accel: 1, brake: 0, drift: true }, 1 / 60);
    assert.ok(predicted.speed <= previousSpeed, 'finished speed may only decay');
    previousSpeed = predicted.speed;
  }

  assert.equal(predicted.distance, pose.distance);
  assert.equal(predicted.lateral, pose.lateral);
  assert.equal(predicted.heading, pose.heading);
});
