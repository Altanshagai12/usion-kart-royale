/**
 * Headless capture harness.
 *
 *   node tools/shot.mjs                     # default shot set -> shots/
 *   node tools/shot.mjs --out shots/r3      # into a round folder
 *   node tools/shot.mjs --w 2560 --h 1440   # resolution
 *   node tools/shot.mjs --only hero,drift   # subset
 *   node tools/shot.mjs --settle 4          # seconds of real-time sim per shot
 *
 * Boots vite itself if nothing is listening on the port, waits for the game to
 * report ready, drives it to a set of scripted vantage points, and writes PNGs
 * plus a JSON report of console errors and frame timings. Any page error is a
 * hard failure — a shot of a broken scene is worse than no shot.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const root = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = join(root, arg('out', 'shots'));
const W = parseInt(arg('w', '1920'), 10);
const H = parseInt(arg('h', '1080'), 10);
const SETTLE = parseFloat(arg('settle', '3'));
const PORT = parseInt(arg('port', '5173'), 10);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);

/**
 * Each shot positions the player, optionally overrides the camera, and names
 * itself. These are the frames the art critic judges, so they must cover the
 * range a player actually sees: the start grid, open straights, hard corners,
 * scenery-dense sections, and the high-energy boost/drift moments where the
 * effects stack up.
 *
 * `t` is normalised track progress, and it is where the kart should be WHEN THE
 * SHUTTER FIRES, not where it is
 * dropped. The field is placed upstream and then *driven* onto the mark: the
 * harness waits for the kart to arrive rather than assuming the settle put it
 * there. Assuming was wrong by about six percent of a lap, which on this
 * circuit is the difference between a corner and the straight after it.
 *
 * `ahead` is how many of the other seven karts start in front of the player —
 * the chase camera looks forward, so a shot that wants traffic in frame has to
 * put traffic there.
 *
 * `drift` waits for a real tier-2 slide instead of a position (see below), so
 * its `t` is only where the hunt starts.
 */
const SHOTS = [
  { name: 'hero',        t: 0.06, speed: 24, desc: 'Signature chase shot on a scenic straight' },
  { name: 'grid',        t: 0.995, speed: 0,  desc: 'Full grid at the start line during countdown' },
  { name: 'drift',       t: 0.74, speed: 26, drift: 1, desc: 'Mid-drift with sparks at tier 2' },
  { name: 'boost',       t: 0.40, speed: 32, boost: 1, desc: 'Boost active — speed lines, bloom, FOV punch' },
  { name: 'corner',      t: 0.58, speed: 22, desc: 'Hard banked corner showing track geometry' },
  { name: 'pack',        t: 0.74, speed: 25, ahead: 4, desc: 'Mid-pack traffic, several karts in frame' },
  { name: 'scenery',     t: 0.86, speed: 20, desc: 'Environment-dense section' },
  { name: 'wide',        t: 0.30, speed: 18, cam: 'wide', desc: 'High wide establishing shot of the circuit' },
  { name: 'closeup',     t: 0.50, speed: 14, cam: 'close', desc: 'Close on the kart — model and material detail' },
  { name: 'hud',         t: 0.14, speed: 28, desc: 'Gameplay frame judged for HUD composition' },
];

/** seconds of pinned running after the mark is reached, before the shutter */
const HOLD = 0.62;
/** how long to wait for a kart to drive onto its mark before giving up, seconds */
const APPROACH_TIMEOUT = 30;
/**
 * Upper bound on the pace the AI actually holds, m/s, used to size the run-up.
 *
 * A shot's `speed` is a *look* — what the speedo, the speed lines and the lens
 * should read at the shutter — not the pace the field drives at. Sizing the
 * run-up off it put `closeup` (a 14 m/s look) barely 45 m behind its mark, the
 * AI covered that in under two seconds of a three second settle, and the shot
 * then had to chase the mark most of the way round the lap. Sizing it off the
 * fastest the AI could plausibly be going instead guarantees the one thing that
 * has to be true: the mark is still ahead when the settle expires.
 */
const AI_CRUISE = 36;

function portOpen(port) {
  return new Promise((res) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, 800);
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('vite did not come up on port ' + PORT);
}

const main = async () => {
  const server = await ensureServer();
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      `--window-size=${W},${H}`,
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(m.text());
    else if (t === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

  await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });
  } catch {
    errors.push('TIMEOUT: window.__gameReady never became true — the game did not boot.');
  }

  const report = { shots: [], errors, warnings, fps: null };

  for (const shot of SHOTS) {
    if (ONLY.length && !ONLY.includes(shot.name)) continue;

    // The drift shot takes no pinned beat. The beat exists to populate VFX and
    // settle the speedo, and a slide that has already charged to tier 2 has its
    // sparks; spending another 0.6 s just gives the drift time to end, which is
    // exactly what it did — the shutter caught the mini-turbo after the slide
    // rather than the slide.
    const hold = shot.drift ? 0 : HOLD;

    await page.evaluate((s, hold) => {
      const ctx = window.__ctx;
      if (!ctx?.race?.player) return;
      const race = ctx.race;
      const track = ctx.track;
      const player = race.player;

      // There is no keyboard in here, so the player's kart is driven by the AI
      // for the duration of the capture. Without this it just sits on the grid.
      race.autoDrive = true;

      // Drop the field upstream of the mark by a settle's worth of road plus a
      // margin. The margin matters in one direction only: the settle has to
      // finish while the mark is still AHEAD of the kart, or the wait for it
      // sits through most of another lap. Overshooting the run-up costs a second
      // of extra driving; undershooting costs half a lap.
      const back = s.hold_still ? 0 : (s.cruise * (s.settle + hold) * 1.2) / track.length;

      race.karts.forEach((k, i) => {
        // i === 0 is the player, the rest queue up behind it — which is also the
        // start-grid formation `grid` wants. Shots that need traffic in front
        // get it placed just before the shutter instead; putting it here only
        // means the player rear-ends the queue on the way to its mark.
        const t = ((s.t - i * 0.006 - back) % 1 + 1) % 1;
        const smp = track.sample(t);
        const lane = ((i % 2) * 2 - 1) * (2.6 + (i >> 1) * 0.4);
        const p = smp.pos.clone().addScaledVector(smp.binormal, lane);
        k.placeAt?.(p, Math.atan2(smp.tangent.x, smp.tangent.z), t);
        // `forwardSpeed` is derived from `velocity` every substep, so seeding
        // the velocity is the only way to start a kart already at speed.
        k.velocity.copy(k.forward).multiplyScalar(s.speed);
      });

      // A drift cannot be set from out here: `updateDriftState` releases any
      // slide whose button is no longer held, and releasing a charged one fires
      // the mini-turbo — which is why writing `driftDir` produced a boost flame
      // and a kart travelling perfectly straight. Hold the button instead and
      // let the kart drift itself. While the slide has not caught yet, pulse
      // the button: engaging needs a live hop (0.45 s) coinciding with real
      // steering lock, so one press on the approach straight is simply missed.
      //
      // Throttle and brake are deliberately left alone. Overriding them takes
      // the corner away from the AI, and a kart held at full throttle through
      // the seafront corner leaves the circuit entirely.
      if (s.drift) {
        let phase = 0;
        race.driveOverride = (cmd) => {
          // ~2 presses a second while hunting, so each hop is allowed to play
          // out rather than the kart pogoing down the approach straight.
          cmd.drift = player.driftDir !== 0 ? true : phase++ % 32 < 16;
        };
      } else {
        race.driveOverride = null;
      }

      if (s.boost) player.applyBoost(3, 1.2);
      ctx.speedIntensity = Math.min(1.2, s.speed / 30);

      race.state = s.name === 'grid' ? 1 /* Countdown */ : 2 /* Racing */;
      window.__camMode = s.cam || 'chase';
    }, { ...shot, settle: SETTLE, cruise: AI_CRUISE, hold_still: shot.name === "grid" }, hold);

    // Free running, until the kart is both settled and on its mark. Nothing is
    // forced here, so it stays on the racing line and on the road.
    //
    // The settle is a *minimum*, not the whole wait: it exists so springs,
    // particles and temporal effects converge, and the kart is placed far enough
    // back that the mark is still ahead when it expires. Watching for arrival
    // rather than assuming it is what makes each frame match its description —
    // the AI does not run at exactly the scripted speed, so any prediction
    // drifts by metres per second of settle, and six percent of a lap on this
    // circuit is the difference between a corner and the straight after it.
    const waited = await page.evaluate((s, hold, timeout) => new Promise((done) => {
      const ctx = window.__ctx;
      if (!ctx?.race?.player) return done({ ok: false, why: 'no player' });
      const k = ctx.race.player;
      const len = ctx.track.length;
      const t0 = performance.now();

      // Stop short by the distance the hold beat will cover, so the shutter
      // fires on the mark rather than just past it.
      const mark = ((s.t - (s.speed * hold) / len) % 1 + 1) % 1;
      const gap = (a, b) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);

      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed >= s.settle) {
          // `grid` must not move at all; the drift shot is waiting on a state
          // rather than a place. Everything else waits for the mark.
          if (s.hold_still) return done({ ok: true, why: 'stationary' });
          if (s.drift) {
            if (k.driftDir !== 0 && k.driftTier >= 2) return done({ ok: true, why: 'tier-2 slide' });
          } else if (gap(k.t, mark) < 0.004) {
            return done({ ok: true, why: 'on mark' });
          }
        }
        if (elapsed > timeout) return done({ ok: false, why: `gave up after ${timeout}s at t=${k.t.toFixed(3)}` });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), { ...shot, settle: SETTLE, hold_still: shot.name === "grid" }, hold, APPROACH_TIMEOUT);

    if (!waited.ok) {
      warnings.push(`shot "${shot.name}" never reached its mark: ${waited.why}`);
    }

    // A short pinned beat so the frame reads at the scripted speed and
    // the boost/spark VFX are populated. Kept brief: this fights the physics, so
    // holding it any longer walks the kart off the racing line.
    const arrived = await page.evaluate((s, hold) => new Promise((done) => {
      const ctx = window.__ctx;
      if (!ctx?.race?.player) return done(null);
      const k = ctx.race.player;

      // Traffic is placed relative to the player at the last moment, not raced
      // into position over the settle. Racing it there does not work: the
      // player's kart is the quickest on the grid, so it drives straight past
      // whatever was put in front of it and the shot comes back with an empty
      // road. The hold beat is long enough for the moved karts to settle onto
      // their suspension before the shutter.
      if (s.ahead) {
        const track = ctx.track;
        const others = ctx.race.karts.filter((x) => x !== k);
        for (let i = 0; i < s.ahead && i < others.length; i++) {
          const t = ((k.t + 0.004 + i * 0.0035) % 1 + 1) % 1;
          const smp = track.sample(t);
          const lane = ((i % 2) * 2 - 1) * (2.2 + (i >> 1) * 1.4);
          const p = smp.pos.clone().addScaledVector(smp.binormal, lane);
          others[i].placeAt?.(p, Math.atan2(smp.tangent.x, smp.tangent.z), t);
          others[i].velocity.copy(others[i].forward).multiplyScalar(s.speed);
        }
      }

      const until = performance.now() + hold * 1000;
      const tick = () => {
        // Nudge the road speed toward the scripted figure without touching the
        // lateral component, so the kart keeps the attitude the physics gave it.
        // A nudge, not a snap — snapping overrides collisions and cornering.
        if (!s.hold_still) {
          const cur = k.velocity.dot(k.forward);
          k.velocity.addScaledVector(k.forward, (s.speed - cur) * 0.25);
        }
        if (s.boost && k.boostTime < 0.6) k.applyBoost(1.2, 1.2);
        if (performance.now() < until) requestAnimationFrame(tick);
        else done({ t: k.t, driftDir: k.driftDir, driftTier: k.driftTier, speed: k.forwardSpeed });
      };
      requestAnimationFrame(tick);
    }), { ...shot, hold_still: shot.name === "grid" }, hold);

    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, type: 'png' });
    report.shots.push({
      name: shot.name,
      file,
      desc: shot.desc,
      // Where the kart actually was when the shutter fired, so a shot that
      // drifts off its mark is visible in the report instead of only in the
      // critic's confusion.
      targetT: shot.drift ? null : shot.t,
      actualT: arrived ? +arrived.t.toFixed(4) : null,
      driftTier: arrived ? arrived.driftTier : null,
      speed: arrived ? +arrived.speed.toFixed(1) : null,
      reachedMark: waited.ok,
    });
    process.stdout.write(
      `captured ${shot.name.padEnd(8)} t=${arrived ? arrived.t.toFixed(3) : '?'}` +
      ` target=${shot.drift ? '(slide)' : shot.t}` +
      ` tier=${arrived ? arrived.driftTier : '?'}  ${waited.why}\n`,
    );
  }

  await page.evaluate(() => { const r = window.__ctx?.race; if (r) r.driveOverride = null; });

  report.fps = await page.evaluate(() => {
    return new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => {
        if (++n < 90) requestAnimationFrame(tick);
        else res(Math.round((n * 1000) / (performance.now() - t0)));
      };
      requestAnimationFrame(tick);
    });
  }).catch(() => null);

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  if (server) server.kill();

  console.log(`\n${report.shots.length} shots -> ${OUT}`);
  console.log(`fps(swiftshader, not indicative of real hw): ${report.fps}`);
  if (errors.length) {
    console.log(`\n!! ${errors.length} console/page errors:`);
    for (const e of errors.slice(0, 20)) console.log('  - ' + e.slice(0, 400));
    process.exitCode = 1;
  } else {
    console.log('no console errors');
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
