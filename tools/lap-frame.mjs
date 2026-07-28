/**
 * Full AI-lap framing audit.
 *
 * The probe scripts drive a straight line and a gentle weave. The shot harness
 * showed the candidates differ most in real CORNERS, which neither probe script
 * contains. This drives a full AI lap and measures, every frame:
 *
 *   - where the SUBJECT actually is on screen (correct point projection)
 *   - whether the ROAD AHEAD is on screen: the centreline point 35 m in front of
 *     the kart, which is the thing behaviour 5 is about
 *   - camera roll about its own view axis vs the road bank (behaviour 2)
 *   - eye clearance: inside a wall / below ground (behaviour 4)
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = parseInt(process.argv[2] || '5411', 10);

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const data = await page.evaluate(async () => {
  const ctx = window.__ctx;
  const race = ctx.race;
  const k = race.player;
  const V = k.position.constructor;
  race.driveOverride = null;
  race.autoDrive = true;
  race.reset();
  race.state = 2;
  for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r));

  const out = [];
  const N = 3000;
  for (let i = 0; i < N; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const cam = ctx.camera;
    const sub = k.position.clone().project(cam);
    const fwd = cam.getWorldDirection(new V());
    const behind = k.position.clone().sub(cam.position).dot(fwd) < 0;

    // The road 35 m ahead of the kart, along the track, projected.
    let aheadOn = 0, aheadX = 0, aheadY = 0;
    try {
      const t = k.t;
      if (t !== null && t !== undefined) {
        const len = ctx.track.length || 1000;
        const s = ctx.track.sample((t + 35 / len) % 1);
        const p = s.pos.clone();
        p.y += 1.0;
        const pv = p.clone().project(cam);
        const inFront = p.clone().sub(cam.position).dot(fwd) > 0;
        aheadOn = (inFront && Math.abs(pv.x) <= 1 && Math.abs(pv.y) <= 1) ? 1 : 0;
        aheadX = pv.x; aheadY = pv.y;
      }
    } catch (e) { /* ignore */ }

    // Roll of the lens about its own view axis, degrees.
    const up = new V(0, 1, 0).applyQuaternion(cam.quaternion);
    const right = new V(1, 0, 0).applyQuaternion(cam.quaternion);
    const roll = Math.atan2(right.y, up.y) * 57.2958;

    // Clearance.
    let inWall = 0, belowGround = 0;
    try { inWall = ctx.track.collideWalls && ctx.track.collideWalls(cam.position.clone(), 0.35) ? 1 : 0; } catch (e) {}
    try { const g = ctx.track.probe(cam.position); if (g && cam.position.y < g.y + 0.05) belowGround = 1; } catch (e) {}

    out.push({
      x: +sub.x.toFixed(3), y: +sub.y.toFixed(3), behind: behind ? 1 : 0,
      aheadOn, aheadX: +aheadX.toFixed(2), aheadY: +aheadY.toFixed(2),
      roll: +roll.toFixed(2), inWall, belowGround,
      spd: +k.velocity.length().toFixed(1),
      dist: +cam.position.distanceTo(k.position).toFixed(2),
      camY: +cam.position.y.toFixed(2),
    });
  }
  race.autoDrive = false;
  return out;
});

await browser.close();
srv.stop();

const p = (a, q) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * q)];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ax = data.map((d) => Math.abs(d.x));
const ay = data.map((d) => d.y);
const rolls = data.map((d) => Math.abs(d.roll));
const fast = data.filter((d) => d.spd > 12);

console.log(JSON.stringify({
  frames: data.length,
  SUBJECT: {
    meanAbsX: +mean(ax).toFixed(3),
    p95AbsX: +p(ax, 0.95).toFixed(3),
    maxAbsX: +Math.max(...ax).toFixed(3),
    pctPast35: +(ax.filter((v) => v > 0.35).length / ax.length * 100).toFixed(1),
    pctPast60: +(ax.filter((v) => v > 0.60).length / ax.length * 100).toFixed(1),
    meanY: +mean(ay).toFixed(3),
    p05Y: +p(ay, 0.05).toFixed(3),
    pctBelowY60: +(ay.filter((v) => v < -0.60).length / ay.length * 100).toFixed(1),
    pctOffScreen: +(data.filter((d) => d.behind || Math.abs(d.x) > 1 || Math.abs(d.y) > 1).length / data.length * 100).toFixed(2),
  },
  ROAD_AHEAD_35m: {
    pctOnScreen: +(mean(data.map((d) => d.aheadOn)) * 100).toFixed(1),
    pctOnScreen_fast: +(mean(fast.map((d) => d.aheadOn)) * 100).toFixed(1),
  },
  ROLL: { meanAbs: +mean(rolls).toFixed(2), p95: +p(rolls, 0.95).toFixed(2), max: +Math.max(...rolls).toFixed(2) },
  CLEARANCE: {
    framesInWall: data.filter((d) => d.inWall).length,
    framesBelowGround: data.filter((d) => d.belowGround).length,
    minDist: +Math.min(...data.map((d) => d.dist)).toFixed(2),
    meanDist: +mean(data.map((d) => d.dist)).toFixed(2),
  },
}, null, 2));
