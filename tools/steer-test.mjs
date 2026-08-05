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
await page.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

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
  return {
    runs,
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
await browser.close();
server.stop();
