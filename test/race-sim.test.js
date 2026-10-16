import assert from 'node:assert/strict';
import test from 'node:test';
import { KART_RADIUS, TOTAL_LAPS, TRACK_LENGTH } from '../shared/constants.js';
import { createPlayer, halfWidthAt, stepPlayer, stepRace } from '../shared/race-sim.js';

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

function raceFor(players, seconds) {
  let rows = players;
  for (let frame = 0; frame < seconds * 60; frame++) rows = stepRace(rows, 1 / 60);
  return rows;
}

function movingPlayer(slot, lateral, distance = 1_000) {
  const player = createPlayer({ slot, userId: `driver-${slot}`, name: `Driver ${slot}` });
  Object.assign(player, {
    distance, lateral, speed: 25,
    input: { steer: 0, accel: 1, brake: 0, drift: false, iseq: 1 },
  });
  return player;
}

test('side-by-side contact separates karts without welding their forward speed', () => {
  const baseline = raceFor([movingPlayer(0, 0)], 3)[0];
  for (const gap of [1, 1.79]) {
    const pair = raceFor([
      movingPlayer(0, -gap / 2), movingPlayer(1, gap / 2),
    ], 3);
    assert.ok(Math.abs(pair[0].lateral - pair[1].lateral) >= 1.79);
    assert.ok(
      baseline.speed - pair[0].speed < 2,
      `side contact lost too much speed at ${gap} m: ${pair[0].speed} vs ${baseline.speed}`,
    );
    assert.ok(Math.abs(pair[0].speed - pair[1].speed) < 1e-6, 'contact must be symmetric');
  }
});

test('longitudinal contact costs more speed than a pure side scrape', () => {
  const side = stepRace([movingPlayer(0, -0.5), movingPlayer(1, 0.5)], 1 / 60);
  const diagonal = stepRace([
    movingPlayer(0, -0.5, 200), movingPlayer(1, 0.5, 201),
  ], 1 / 60);
  assert.ok(diagonal[0].speed < side[0].speed);
  assert.ok(diagonal.every((player) => Number.isFinite(player.speed) && player.speed >= 0));
});

test('finished karts are immutable and cannot obstruct racers at the line', () => {
  const finishDistance = TRACK_LENGTH * TOTAL_LAPS;
  const winner = movingPlayer(0, 0, finishDistance);
  Object.assign(winner, { finished: true, finishMs: 61_000, speed: 8, heading: 0.2 });
  const racer = movingPlayer(1, 0.3, finishDistance - 1);
  const out = stepRace([winner, racer], 1 / 60);

  assert.deepEqual(
    { distance: out[0].distance, lateral: out[0].lateral, heading: out[0].heading },
    { distance: finishDistance, lateral: 0, heading: 0.2 },
  );
  assert.ok(out[1].speed > 24, 'a finished row must not drain a live racer');
});

test('contact separation never pushes live karts beyond the road corridor', () => {
  for (const hz of [30, 60, 120]) {
    const distance = 1_000;
    const edge = halfWidthAt(distance) - KART_RADIUS;
    let rows = [
      movingPlayer(0, edge - 0.05, distance),
      movingPlayer(1, edge - 0.55, distance),
    ];
    for (let frame = 0; frame < hz; frame++) {
      rows = stepRace(rows, 1 / hz);
      for (const row of rows) {
        const limit = halfWidthAt(row.distance) - KART_RADIUS;
        assert.ok(Math.abs(row.lateral) <= limit + 1e-6, `${hz}Hz row left corridor`);
      }
    }
    assert.ok(Math.abs(rows[0].lateral - rows[1].lateral) >= 1.79);
  }
});
