/**
 * Camera-feel measurement.
 *
 *   node tools/camera-probe.mjs
 *
 * Drives the PLAYER through `Race.driveOverride` — the sanctioned hook — rather
 * than calling `Kart.step` directly. Stepping the kart by hand while the race
 * director is also stepping it double-integrates the physics with conflicting
 * inputs, and produces numbers that look like the camera whipping 171 degrees
 * on a kart that turned 9. Every measurement below goes through the same path a
 * real player's thumb does.
 *
 * Reports the things a player actually feels:
 *   - LAG: how far behind the kart's heading the camera sits, in degrees, and
 *     how long it takes to catch up after a step input
 *   - SWING: peak angular velocity of the camera, deg/s — the nausea metric
 *   - OVERSHOOT: how far past the settled value the camera goes, and whether it
 *     rings
 *   - FRAMING: how far off centre the kart sits, 0 = centred, 1 = at the edge
 *   - STABILITY: frame-to-frame jitter while driving straight
 *   - FRAME-RATE INDEPENDENCE: the same input script at 30 / 60 / 120 fps must
 *     produce the same camera trajectory
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5313;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

/** Runs one input script at a simulated frame rate; returns the camera trace. */
async function trace(page, { steerScript, hz }) {
  return page.evaluate(async (script, hz) => {
    const ctx = window.__ctx;
    const race = ctx.race;
    const k = race.player;
    const V = k.position.constructor;

    // Put the field on a known straight, at a known speed, pointing forward.
    race.autoDrive = false;
    race.reset();
    race.state = 2;
    const s = ctx.track.sample(0.05);
    k.placeAt(s.pos.clone(), Math.atan2(s.tangent.x, s.tangent.z), 0.05);
    k.velocity.copy(k.forward).multiplyScalar(22);

    let steer = 0;
    race.driveOverride = (cmd) => { cmd.steer = steer; cmd.throttle = 1; cmd.brake = 0; cmd.drift = false; };

    const dt = 1 / hz;
    const yawOf = (v) => Math.atan2(v.x, v.z);
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const camDir = () => { const v = ctx.camera.getWorldDirection(new V()); v.y = 0; return v.normalize(); };

    // Settle before measuring.
    for (let i = 0; i < Math.round(hz * 0.8); i++) await new Promise((r) => requestAnimationFrame(r));

    const out = [];
    let prevCam = yawOf(camDir());
    const frames = Math.round(hz * (script.length / 60));
    for (let i = 0; i < frames; i++) {
      steer = script[Math.min(script.length - 1, Math.floor(i * 60 / hz))];
      await new Promise((r) => requestAnimationFrame(r));

      const kYaw = yawOf(k.forward);
      const cYaw = yawOf(camDir());
      // Where is the kart on screen? -1 left edge, +1 right edge.
      const toKart = k.position.clone().sub(ctx.camera.position);
      const proj = toKart.clone().project(ctx.camera);
      out.push({
        t: +(i / hz).toFixed(3),
        lag: +(wrap(kYaw - cYaw) * 57.2958).toFixed(2),
        camRate: +(wrap(cYaw - prevCam) / dt * 57.2958).toFixed(1),
        offCentre: +proj.x.toFixed(3),
        camY: +ctx.camera.position.y.toFixed(2),
        dist: +ctx.camera.position.distanceTo(k.position).toFixed(2),
      });
      prevCam = cYaw;
    }
    race.driveOverride = null;
    return out;
  }, steerScript, hz);
}

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

// 0.5s straight, 1.5s full lock right, 1.5s back to straight.
const step = [
  ...Array(30).fill(0),
  ...Array(90).fill(1),
  ...Array(90).fill(0),
];
// Gentle weave, the ordinary case a player spends most of a lap in.
const weave = Array.from({ length: 240 }, (_, i) => Math.sin(i / 24) * 0.45);

const results = {};
for (const [name, script] of [['step', step], ['weave', weave]]) {
  const t = await trace(page, { steerScript: script, hz: 60 });
  const lags = t.map((s) => Math.abs(s.lag));
  const rates = t.map((s) => Math.abs(s.camRate));
  const off = t.map((s) => Math.abs(s.offCentre));
  // Time for the lag to fall back under 3 degrees after the input stops.
  const release = Math.floor(t.length * 120 / 210);
  let settle = -1;
  for (let i = release; i < t.length; i++) {
    if (Math.abs(t[i].lag) < 3) { settle = +(t[i].t - t[release].t).toFixed(2); break; }
  }
  results[name] = {
    peakLagDeg: +Math.max(...lags).toFixed(1),
    meanLagDeg: +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1),
    peakSwingDegPerSec: +Math.max(...rates).toFixed(0),
    p95SwingDegPerSec: +rates.slice().sort((a, b) => a - b)[Math.floor(rates.length * 0.95)].toFixed(0),
    peakOffCentre: +Math.max(...off).toFixed(3),
    meanOffCentre: +(off.reduce((a, b) => a + b, 0) / off.length).toFixed(3),
    settleSec: settle,
    framesPast35pct: +(off.filter((o) => o > 0.35).length / off.length * 100).toFixed(1),
  };
}

// Frame-rate independence: the same script at three rates must agree.
const fps = {};
for (const hz of [30, 60, 120]) {
  const t = await trace(page, { steerScript: step, hz });
  fps[hz] = {
    peakLagDeg: +Math.max(...t.map((s) => Math.abs(s.lag))).toFixed(1),
    finalLagDeg: +t[t.length - 1].lag.toFixed(1),
    peakSwing: +Math.max(...t.map((s) => Math.abs(s.camRate))).toFixed(0),
  };
}
const spread = Math.max(...Object.values(fps).map((v) => v.peakLagDeg)) -
               Math.min(...Object.values(fps).map((v) => v.peakLagDeg));

console.log('--- camera probe ---');
for (const [k, v] of Object.entries(results)) {
  console.log(`\n[${k}]`);
  for (const [m, val] of Object.entries(v)) console.log(`  ${m.padEnd(22)} ${val}`);
}
console.log('\n[frame-rate independence]  (same script, three rates)');
for (const [hz, v] of Object.entries(fps)) console.log(`  ${hz}Hz`.padEnd(24) + JSON.stringify(v));
console.log(`  peak-lag spread across rates: ${spread.toFixed(1)} deg  ${spread < 3 ? 'OK' : '<-- RATE DEPENDENT'}`);

await browser.close();
srv.stop();
