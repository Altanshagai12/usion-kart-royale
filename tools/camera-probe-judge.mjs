/**
 * JUDGE COPY of tools/camera-probe.mjs.
 *
 * Identical drive scripts, identical hook, identical statistics. Two differences:
 *   1. PORT is private (5399) and NOT 5313, because vite-server.mjs ADOPTS a
 *      server already bound to 5313 — and an orphan there serves a different
 *      worktree, which would silently measure the wrong candidate's camera.
 *   2. Extra diagnostics printed ALONGSIDE (never replacing) the original
 *      metrics: TRUE_* uses k.position.project(camera), the correct point
 *      transform, instead of the original's (kart - camera).project(camera).
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5399;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

async function trace(page, { steerScript, hz }) {
  return page.evaluate(async (script, hz) => {
    const ctx = window.__ctx;
    const race = ctx.race;
    const k = race.player;
    const V = k.position.constructor;

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

    for (let i = 0; i < Math.round(hz * 0.8); i++) await new Promise((r) => requestAnimationFrame(r));

    const out = [];
    let prevCam = yawOf(camDir());
    let prevT = performance.now();
    const frames = Math.round(hz * (script.length / 60));
    for (let i = 0; i < frames; i++) {
      steer = script[Math.min(script.length - 1, Math.floor(i * 60 / hz))];
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      const wallDt = Math.max(1e-4, (now - prevT) / 1000);

      const kYaw = yawOf(k.forward);
      const cYaw = yawOf(camDir());
      // ORIGINAL (broken) framing metric, reproduced exactly.
      const toKart = k.position.clone().sub(ctx.camera.position);
      const proj = toKart.clone().project(ctx.camera);
      // CORRECTED framing metric: project the kart's world position.
      const tp = k.position.clone().project(ctx.camera);
      // Is the subject actually in front of the lens?
      const fwd = ctx.camera.getWorldDirection(new V());
      const behind = k.position.clone().sub(ctx.camera.position).dot(fwd) < 0;

      out.push({
        t: +(i / hz).toFixed(3),
        lag: +(wrap(kYaw - cYaw) * 57.2958).toFixed(2),
        camRate: +(wrap(cYaw - prevCam) / dt * 57.2958).toFixed(1),
        wallRate: +(wrap(cYaw - prevCam) / wallDt * 57.2958).toFixed(1),
        offCentre: +proj.x.toFixed(3),
        trueX: +tp.x.toFixed(3),
        trueY: +tp.y.toFixed(3),
        behind: behind ? 1 : 0,
        wallDtMs: +(wallDt * 1000).toFixed(1),
        camY: +ctx.camera.position.y.toFixed(2),
        dist: +ctx.camera.position.distanceTo(k.position).toFixed(2),
      });
      prevCam = cYaw;
      prevT = now;
    }
    race.driveOverride = null;
    return out;
  }, steerScript, hz);
}

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const step = [
  ...Array(30).fill(0),
  ...Array(90).fill(1),
  ...Array(90).fill(0),
];
const weave = Array.from({ length: 240 }, (_, i) => Math.sin(i / 24) * 0.45);

const p95 = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const results = {};
for (const [name, script] of [['step', step], ['weave', weave]]) {
  const t = await trace(page, { steerScript: script, hz: 60 });
  const lags = t.map((s) => Math.abs(s.lag));
  const rates = t.map((s) => Math.abs(s.camRate));
  const wrates = t.map((s) => Math.abs(s.wallRate));
  const off = t.map((s) => Math.abs(s.offCentre));
  const tx = t.map((s) => Math.abs(s.trueX));
  const ty = t.map((s) => Math.abs(s.trueY));
  const release = Math.floor(t.length * 120 / 210);
  let settle = -1;
  for (let i = release; i < t.length; i++) {
    if (Math.abs(t[i].lag) < 3) { settle = +(t[i].t - t[release].t).toFixed(2); break; }
  }
  results[name] = {
    peakLagDeg: +Math.max(...lags).toFixed(1),
    meanLagDeg: +mean(lags).toFixed(1),
    peakSwingDegPerSec: +Math.max(...rates).toFixed(0),
    p95SwingDegPerSec: +p95(rates).toFixed(0),
    peakOffCentre: +Math.max(...off).toFixed(3),
    meanOffCentre: +mean(off).toFixed(3),
    settleSec: settle,
    framesPast35pct: +(off.filter((o) => o > 0.35).length / off.length * 100).toFixed(1),
    // --- corrected / honest diagnostics ---
    WALL_peakSwing: +Math.max(...wrates).toFixed(0),
    WALL_p95Swing: +p95(wrates).toFixed(0),
    worstFrameGapMs: +Math.max(...t.map((s) => s.wallDtMs)).toFixed(0),
    TRUE_peakOffCentre: +Math.max(...tx).toFixed(3),
    TRUE_meanOffCentre: +mean(tx).toFixed(3),
    TRUE_p95OffCentre: +p95(tx).toFixed(3),
    TRUE_framesPast35pct: +(tx.filter((o) => o > 0.35).length / tx.length * 100).toFixed(1),
    TRUE_peakOffCentreY: +Math.max(...ty).toFixed(3),
    TRUE_framesOffScreen: +(t.filter((s) => s.behind || Math.abs(s.trueX) > 1 || Math.abs(s.trueY) > 1).length / t.length * 100).toFixed(1),
    meanDist: +mean(t.map((s) => s.dist)).toFixed(2),
    minDist: +Math.min(...t.map((s) => s.dist)).toFixed(2),
  };
}

const fps = {};
for (const hz of [30, 60, 120]) {
  const t = await trace(page, { steerScript: step, hz });
  const wrates = t.map((s) => Math.abs(s.wallRate));
  fps[hz] = {
    peakLagDeg: +Math.max(...t.map((s) => Math.abs(s.lag))).toFixed(1),
    finalLagDeg: +t[t.length - 1].lag.toFixed(1),
    peakSwing: +Math.max(...t.map((s) => Math.abs(s.camRate))).toFixed(0),
    WALL_peakSwing: +Math.max(...wrates).toFixed(0),
    WALL_p95Swing: +p95(wrates).toFixed(0),
    nFrames: t.length,
  };
}
const spread = Math.max(...Object.values(fps).map((v) => v.peakLagDeg)) -
               Math.min(...Object.values(fps).map((v) => v.peakLagDeg));
const wallSpread = Math.max(...Object.values(fps).map((v) => v.WALL_peakSwing)) -
                   Math.min(...Object.values(fps).map((v) => v.WALL_peakSwing));

console.log('--- camera probe (JUDGE, port ' + PORT + ') ---');
for (const [k, v] of Object.entries(results)) {
  console.log(`\n[${k}]`);
  for (const [m, val] of Object.entries(v)) console.log(`  ${m.padEnd(22)} ${val}`);
}
console.log('\n[frame-rate independence]  (same script, three rates)');
for (const [hz, v] of Object.entries(fps)) console.log(`  ${hz}Hz`.padEnd(24) + JSON.stringify(v));
console.log(`  peak-lag spread across rates: ${spread.toFixed(1)} deg  ${spread < 3 ? 'OK' : '<-- RATE DEPENDENT'}`);
console.log(`  WALL peak-swing spread across rates: ${wallSpread.toFixed(0)} deg/s`);

await browser.close();
srv.stop();
