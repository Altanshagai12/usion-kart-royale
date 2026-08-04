import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VERGE_RECOVERY_SECONDS, stepVergeRecovery,
} from '../shared/roadside-recovery.js';

function simulate({ seconds, speed, onVerge = true }) {
  const hz = 60;
  let distance = 100;
  let state = { timer: 0, lastDistance: distance };
  for (let i = 0; i < seconds * hz; i++) {
    distance += speed / hz;
    state = stepVergeRecovery(state, {
      onVerge, effort: 1, stunned: false, distance,
    }, 1 / hz);
  }
  return state;
}

test('brief verge contact does not crane a moving player back to the road', () => {
  const state = simulate({ seconds: VERGE_RECOVERY_SECONDS - 1, speed: 0.8 });
  assert.equal(state.shouldRespawn, false);
});

test('sustained ineffective verge progress requests recovery', () => {
  const state = simulate({ seconds: VERGE_RECOVERY_SECONDS + 0.2, speed: 0.8 });
  assert.equal(state.shouldRespawn, true);
});

test('useful progress and returning to the road clear the verge timer', () => {
  let state = simulate({ seconds: 3, speed: 0.4 });
  assert.ok(state.timer > 2.9);
  state = stepVergeRecovery(state, {
    onVerge: true, effort: 1, stunned: false,
    distance: state.lastDistance + 4 / 60,
  }, 1 / 60);
  assert.ok(state.timer < 3);
  state = stepVergeRecovery(state, {
    onVerge: false, effort: 1, stunned: false, distance: state.lastDistance,
  }, 1 / 60);
  assert.equal(state.timer, 0);
  assert.equal(state.shouldRespawn, false);
});
