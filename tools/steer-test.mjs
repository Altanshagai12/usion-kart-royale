/**
 * Ground truth for the steering sign.
 *
 * Drives the player kart with a fixed steer input and measures which way it
 * actually goes, in SCREEN terms: "right" is the direction the chase camera
 * shows on the right of frame, which for a view along `forward` with up = +Y
 * is `forward x up`. That is also the convention types.ts declares for
 * TrackSample.binormal, so it is the one the whole codebase is supposed to use.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const PORT = 5178;

const portOpen = (port) => new Promise((res) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 800);
});

const server = await startVite(PORT);

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--window-size=800,600'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

const result = await page.evaluate(async () => {
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

    for (let i = 0; i < 90; i++) {
      k.step(ctx, 1 / 60, steer, 1, 0, false);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const drift = k.position.clone().sub(p0);
    runs[name] = {
      lateralAlongScreenRight: +drift.dot(screenRight).toFixed(3),
      headingTurnedToward: f0.clone().cross(k.forward).y > 0 ? 'screen-LEFT' : 'screen-RIGHT',
      wheelVisualYaw: +(k.wheels?.[0]?.rotation?.y ?? 0).toFixed(3),
    };
  }
  return runs;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.stop();
