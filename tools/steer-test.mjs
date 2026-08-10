/**
 * Ground truth for the steering sign.
 *
 * Drives the player kart with a fixed steer input and measures which way it
 * actually goes, in SCREEN terms: "right" is the direction the chase camera
 * shows on the right of frame, which for a view along `forward` with up = +Y
 * is `forward x up`. That is also the convention types.ts declares for
 * TrackSample.binormal, so it is the one the whole codebase is supposed to use.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5178;

const server = await startVite(PORT);

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--window-size=800,600'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (request.url().startsWith('https://usions.com/')) request.abort();
  else request.continue();
});
await page.goto(`http://127.0.0.1:${PORT}/?quality=low&prewarm=skip`, { waitUntil: 'domcontentloaded' });
// Steering only needs the authored track and the kart. Waiting for
// `__gameReady` also waits for the whole-world shader prewarm, which is both
// irrelevant here and nondeterministically slow on CI's software renderer.
await page.waitForFunction(
  'window.__ctx?.race?.player && typeof window.__ctx?.track?.sample === "function"',
  { timeout: 90_000 },
);

const result = await page.evaluate(() => {
  const ctx = window.__ctx;
  const k = ctx.race.player;
  const Vec3 = k.position.constructor;

  // Freeze the director so nothing else drives or repositions the kart.
  ctx.race.state = 2;
  ctx.race.autoDrive = false;

  const runs = {};
  for (const [name, steer] of [['steerRight_+1', 1], ['steerLeft_-1', -1]]) {
    // Put it on a straight, at speed, pointing along the track.
    const s = ctx.track.sample(0.05);
    k.placeAt(s.pos.clone(), Math.atan2(s.tangent.x, s.tangent.z), 0.05);
    k.velocity.copy(k.forward).multiplyScalar(18);

    const f0 = k.forward.clone();
    const p0 = k.position.clone();
    // screen-right for a camera looking along f0 with world up
    const screenRight = f0.clone().cross(new Vec3(0, 1, 0)).normalize();

    // This is a fixed-step physics test. Waiting for requestAnimationFrame here
    // lets headless software rendering throttle the test for minutes in CI.
    for (let i = 0; i < 90; i++) {
      k.step(ctx, 1 / 60, steer, 1, 0, false);
    }

    const drift = k.position.clone().sub(p0);
    runs[name] = {
      lateralAlongScreenRight: +drift.dot(screenRight).toFixed(3),
      headingTurnedToward: f0.clone().cross(k.forward).y > 0 ? 'screen-LEFT' : 'screen-RIGHT',
      wheelVisualYaw: +(k.wheels?.[0]?.rotation?.y ?? 0).toFixed(3),
    };
  }
  k.steerInput = 0;
  k.steerVelocity = 0;
  const response = [];
  for (const [frames, steer] of [[30, 1], [42, -1], [36, 0]]) {
    for (let i = 0; i < frames; i++) {
      k.updateSteerInput(1 / 60, steer);
      response.push({ rack: k.steerInput, velocity: k.steerVelocity });
    }
  }
  let maxRackStep = 0;
  let maxVelocityStep = 0;
  for (let i = 1; i < response.length; i++) {
    maxRackStep = Math.max(maxRackStep, Math.abs(response[i].rack - response[i - 1].rack));
    maxVelocityStep = Math.max(
      maxVelocityStep,
      Math.abs(response[i].velocity - response[i - 1].velocity),
    );
  }

  const input = ctx.input.state;
  const cameraRig = window.__camRig;
  const facing = () => {
    const sample = ctx.track.sample(k.t);
    const view = new Vec3();
    ctx.camera.getWorldDirection(view);
    return {
      trackAlignment: k.forward.dot(sample.tangent),
      cameraBehind: ctx.camera.position.clone().sub(k.position).dot(k.forward),
      viewAlignment: view.dot(k.forward),
    };
  };

  // Both touch AUTO and a deliberately held GAS/key/trigger must leave the
  // grid facing forward. AUTO used to look like a four-second over-rev, while
  // the burnout branch itself used a combat spin that turned real holds around.
  const runSoloStart = (accelHeld) => {
    ctx.race.start();
    Object.assign(input, {
      steer: 0, accel: 1, accelHeld, brake: 0, drift: false,
      driftPressed: false, itemPressed: false, itemSlot: -1,
      lookBack: false, pausePressed: false, anyPressed: false,
    });
    let countdownFacing = null;
    let startFacing = null;
    let racingFrames = 0;
    let maxStunTime = 0;
    let minTrackAlignment = 1;
    let startDistance = null;
    for (let frame = 0; frame < 420; frame++) {
      ctx.time += 1 / 60;
      ctx.race.update(ctx, 1 / 60);
      cameraRig.lateUpdate(ctx, 1 / 60);
      if (ctx.race.state === 1 && frame === 30) countdownFacing = facing();
      if (ctx.race.state === 2) {
        if (startDistance === null) startDistance = k.raceDistance;
        racingFrames += 1;
        maxStunTime = Math.max(maxStunTime, k.stunTime);
        minTrackAlignment = Math.min(minTrackAlignment, facing().trackAlignment);
        if (racingFrames === 10) startFacing = facing();
        if (racingFrames >= 75) break;
      }
    }
    return {
      countdownFacing,
      startFacing,
      maxStunTime,
      minTrackAlignment,
      progress: k.raceDistance - (startDistance ?? k.raceDistance),
    };
  };
  const soloStart = runSoloStart(false);
  const heldThrottleStart = runSoloStart(true);

  // Put the player naturally just before the third-lap line. The finish event
  // may trail the physical checker by one probe frame, but once flagged the
  // player must stay at the line while the remaining AI field is classified.
  ctx.race.start();
  ctx.race.state = 2;
  Object.assign(input, { steer: 0, accel: 1, accelHeld: true, brake: 0, drift: false });
  const finalSample = ctx.track.sample(0.9985);
  k.placeAt(finalSample.pos.clone(), Math.atan2(finalSample.tangent.x, finalSample.tangent.z), 0.9985);
  k.velocity.copy(k.forward).multiplyScalar(18);
  k.forwardSpeed = 18;
  const progress = ctx.race.prog[k.id];
  progress.lapIndex = 2;
  progress.cp = ctx.track.checkpointCount - 1;
  progress.lapStart = 0;
  progress.finishOrder = 0;
  progress.finishTime = 0;
  ctx.race.finishedCount = 0;
  let finishPosition = null;
  let finishDistance = null;
  let finishT = null;
  let maxPostFinishTravel = 0;
  for (let frame = 0; frame < 480; frame++) {
    ctx.time += 1 / 60;
    ctx.race.update(ctx, 1 / 60);
    if (k.finished && !finishPosition) {
      finishPosition = k.position.clone();
      finishDistance = k.raceDistance;
      finishT = k.t;
    } else if (finishPosition) {
      maxPostFinishTravel = Math.max(maxPostFinishTravel, k.position.distanceTo(finishPosition));
    }
    if (finishPosition && ctx.race.state === 4) break;
  }
  const soloFinish = {
    finished: k.finished,
    lap: k.lap,
    lineError: finishT === null ? Infinity : Math.min(finishT, 1 - finishT) * ctx.track.length,
    maxPostFinishTravel,
    raceDistanceDrift: finishDistance === null ? Infinity : k.raceDistance - finishDistance,
  };

  return {
    runs,
    soloStart,
    heldThrottleStart,
    soloFinish,
    response: {
      initialRack: response[0].rack,
      turnInRack: response[29].rack,
      counterRack: response[71].rack,
      releasedRack: response.at(-1).rack,
      maxRackStep,
      maxVelocityStep,
    },
  };
});

console.log(JSON.stringify(result, null, 2));
assert.ok(result.runs['steerRight_+1'].lateralAlongScreenRight > 2, 'positive steer must move right');
assert.ok(result.runs['steerLeft_-1'].lateralAlongScreenRight < -2, 'negative steer must move left');
assert.ok(Math.abs(result.response.initialRack) < 0.02, 'turn-in must not snap');
assert.ok(result.response.turnInRack < -0.5, 'turn-in must remain responsive');
assert.ok(result.response.counterRack > 0.5, 'counter-steer must cross the rack');
assert.ok(Math.abs(result.response.releasedRack) < 0.12, 'released rack must recenter');
assert.ok(result.response.maxRackStep < 0.105, 'rack position must remain continuous');
assert.ok(result.response.maxVelocityStep < 0.44, 'rack acceleration must remain bounded');
for (const [scenario, launch] of Object.entries({
  auto: result.soloStart,
  heldThrottle: result.heldThrottleStart,
})) {
  assert.ok(launch.countdownFacing, `${scenario} countdown pose was not sampled`);
  assert.ok(launch.startFacing, `${scenario} racing pose was not sampled`);
  for (const [phase, pose] of Object.entries({
    countdown: launch.countdownFacing,
    racing: launch.startFacing,
  })) {
    assert.ok(pose.trackAlignment > 0.9, `${scenario} ${phase} kart reversed: ${pose.trackAlignment}`);
    assert.ok(pose.cameraBehind < -1, `${scenario} ${phase} camera crossed in front: ${pose.cameraBehind}`);
    assert.ok(pose.viewAlignment > 0.7, `${scenario} ${phase} camera looks backwards: ${pose.viewAlignment}`);
  }
  assert.ok(launch.maxStunTime < 0.05, `${scenario} triggered a start spin: ${launch.maxStunTime}`);
  assert.ok(launch.minTrackAlignment > 0.8, `${scenario} launch turned backwards: ${launch.minTrackAlignment}`);
  assert.ok(launch.progress > 1, `${scenario} launch failed to advance: ${launch.progress}`);
}
assert.equal(result.soloFinish.finished, true, 'third-lap finish was not credited');
assert.equal(result.soloFinish.lap, 3, 'published lap did not reach 3');
assert.ok(result.soloFinish.lineError < 2, `finish credited ${result.soloFinish.lineError}m past the line`);
assert.ok(result.soloFinish.maxPostFinishTravel < 3, `finished player travelled ${result.soloFinish.maxPostFinishTravel}m`);
assert.ok(result.soloFinish.raceDistanceDrift < 3, `finished race distance drifted ${result.soloFinish.raceDistanceDrift}m`);
await browser.close();
server.stop();
