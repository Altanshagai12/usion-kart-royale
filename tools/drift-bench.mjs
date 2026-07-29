/**
 * ============================================================================
 *  DRIFT BENCH — does a greedy line actually pay?
 * ============================================================================
 *
 *   node tools/drift-bench.mjs [--port N] [--laps 3] [--null] [--quality low]
 *
 * The whole game lives in the drift -> mini-turbo -> boost loop, and the loop is
 * only real if taking the risk is FASTER. Everything else about the feature —
 * sparks, flame, FOV punch, the sound — is decoration on top of that one fact.
 * If it is not faster, players will learn to stop doing it, and no amount of
 * decoration will bring them back.
 *
 * So this is the gate:
 *
 *     THE SAME LAP, DRIVEN BY THE SAME DRIVER, MUST BE FASTER WITH DRIFTS
 *     THAN WITHOUT THEM.  Otherwise this script exits non-zero.
 *
 * It also reports the numbers you need to tune the loop rather than guess at it:
 * per-section splits and exit speeds clean vs drifting, time-to-tier for each
 * mini-turbo tier, how often a tier-3 is actually held, and what the boost is
 * worth in metres and m/s per tier.
 *
 * ----------------------------------------------------------------------------
 *  HOW THE COMPARISON IS MADE FAIR
 * ----------------------------------------------------------------------------
 * The two conditions differ in exactly ONE bit: whether the drift button is
 * allowed to go down. The steering, throttle and braking all come from the same
 * AI driver, through `Race.driveOverride`, on the same racing line. Nothing
 * about the line is scripted by this harness, because a hand-written line would
 * only measure how well the author of the harness drives.
 *
 * Four things are held still so that one bit is the only difference:
 *
 *  1. **The field is frozen.** Seven rivals bouncing off the player is worth
 *     several seconds a lap — far more than the effect being measured — so they
 *     are parked far off the circuit with a no-op `step`. Their `forwardSpeed`
 *     and `surface` are pinned as well, because the director's stuck-kart
 *     watchdog would otherwise crane all seven back onto the racing line four
 *     and a half seconds later, right in front of the car under test.
 *
 *  2. **Items are off.** A mushroom in one condition and not the other is a
 *     bigger lap-time swing than the entire drift system.
 *
 *  3. **`Math.random` is seeded, and re-seeded identically per condition.** The
 *     driver model has jitter in it; this makes both conditions get the same
 *     jitter rather than an average of different jitter.
 *
 *  4. **The clock is fixed-step.** Every frame advances exactly 1/60 s, so the
 *     physics sees an identical delta in both runs and neither condition is
 *     quietly rewarded for being cheaper to render.
 *
 * ----------------------------------------------------------------------------
 *  --null : THE INSTRUMENT'S OWN CONTROL
 * ----------------------------------------------------------------------------
 * `--null` runs the "drifting" condition with drifting DISABLED, so both arms
 * are byte-for-byte the same experiment. The measured difference must then be
 * ~0. Anything else means the A/B rig itself has a bias — warm-up, ordering,
 * accumulated state between runs — and every number this tool prints in normal
 * mode is contaminated by that bias rather than caused by drifting. Two
 * harnesses in this repo have already shipped confident false readings; run the
 * null before believing this one.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

// ---------------------------------------------------------------------------
//  Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = parseInt(opt('--port', process.env.DRIFT_BENCH_PORT || '5341'), 10);
const QUALITY = opt('--quality', 'low');
const LAPS = parseInt(opt('--laps', '3'), 10);
const NULL_TEST = flag('--null');
const SEED = parseInt(opt('--seed', '20260729'), 10);

/** The drifting lap must beat the clean lap by at least this, as a fraction. */
const MIN_ADVANTAGE = 0.0;
/**
 * ...and by no more than this. Not a bug threshold — a design one. A loop that
 * hands back a third of the lap is not "rewarding"; it is the only way to
 * drive, and the game becomes a drift-spam simulator with a steering wheel
 * attached. Worth failing on so that a tuning pass has to argue for it.
 */
const MAX_ADVANTAGE = 0.30;

const SECTIONS = [
  { name: 'start straight', from: 0.00, to: 0.10 },
  { name: 'harbour sweep', from: 0.10, to: 0.22 },
  { name: 'village climb', from: 0.22, to: 0.38 },
  { name: 'cliff traverse', from: 0.38, to: 0.52 },
  { name: 'tunnel', from: 0.52, to: 0.60 },
  { name: 'beach descent', from: 0.60, to: 0.74 },
  { name: 'banked curve', from: 0.74, to: 0.86 },
  { name: 'bridge & return', from: 0.86, to: 1.00 },
];
const GATES = SECTIONS.map((s) => s.to);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const notes = [];
const consoleErrors = [];

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  // 30 s is the default and it is not enough on a machine running several
  // agents at once — observed failing to launch at a load average of 170.
  timeout: 120000,
  // Generous, because `waitForFunction` holds one CDP call open for the whole
  // boot and a loaded machine can take a minute over it. The wedged-page case
  // is caught by the sim/wall deadlines in `until()`, which give a legible
  // reason; this only stops a truly hung renderer from hanging the harness.
  protocolTimeout: 240000,
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });

// Vite's HMR client is answered with a stub. Agents work this tree in parallel,
// and a full reload triggered by somebody else's save drops the race back to
// the menu mid-measurement — see the same guard in tools/autoplay.mjs, where it
// cost a debugging session to find.
const HMR_STUB =
  'const noop = () => {};\n' +
  'export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, ' +
  'prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });\n' +
  'export const updateStyle = noop;\nexport const removeStyle = noop;\n' +
  'export const injectQuery = (url) => url;\nexport const ErrorOverlay = class {};\n';
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('/@vite/client')) {
    r.respond({ status: 200, contentType: 'application/javascript', body: HMR_STUB }).catch(() => {});
  } else r.continue().catch(() => {});
});
let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const evalIn = (expr) => page.evaluate(
  `(() => { const ctx = window.__ctx, race = ctx.race, D = window.__db; ${expr} })()`,
);

async function until(label, expr, { sim = 30, wallMs = 240000 } = {}) {
  const start = await evalIn('return ctx.time;');
  const w0 = Date.now();
  for (;;) {
    const r = await evalIn(`return { done: !!(${expr}), time: ctx.time };`);
    if (r.done) return { ok: true, sim: r.time - start };
    if (r.time - start > sim) return { ok: false, sim: r.time - start, reason: `${label}: ${sim}s of simulation elapsed and it never became true` };
    if (Date.now() - w0 > wallMs) return { ok: false, sim: r.time - start, reason: `${label}: ${(wallMs / 1000) | 0}s of wall clock for ${(r.time - start).toFixed(1)}s of simulation — the frame loop has stalled` };
    await sleep(80);
  }
}
const advance = (s) => until('advance', 'false', { sim: s });

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?quality=${QUALITY}&scale=0.5`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 180000 });
const navAtBoot = navigations;
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s  (quality=${QUALITY}, port=${PORT})` +
  (NULL_TEST ? '   *** NULL TEST: both arms drift-free ***' : ''));

// ---------------------------------------------------------------------------
//  Instrument
// ---------------------------------------------------------------------------
await page.evaluate((gates) => {
  const w = window;
  const ctx = w.__ctx;
  const race = ctx.race;

  // --- fixed-step clock (see tools/autoplay.mjs for why it is shaped this way)
  const queue = [];
  const cancelled = new Set();
  let idc = 0;
  let scheduled = false;
  w.__vt = performance.now();
  w.__step = 1000 / 60;
  w.requestAnimationFrame = (cb) => {
    const id = ++idc;
    queue.push({ id, cb });
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        w.__vt += w.__step;
        const batch = queue.splice(0, queue.length);
        for (const e of batch) {
          if (cancelled.has(e.id)) { cancelled.delete(e.id); continue; }
          try { e.cb(w.__vt); } catch (err) { setTimeout(() => { throw err; }, 0); }
        }
        const p = w.__dbProbe;
        if (p) p();
      }, 0);
    }
    return id;
  };
  w.cancelAnimationFrame = (id) => { cancelled.add(id); };

  // --- seeded RNG ----------------------------------------------------------
  w.__seed = 1;
  w.__reseed = (s) => { w.__seed = s >>> 0 || 1; };
  Math.random = () => {
    // LCG. Not a good generator; a perfectly adequate one for making two runs
    // of the same driver receive the same jitter.
    w.__seed = (Math.imul(w.__seed, 1664525) + 1013904223) >>> 0;
    return w.__seed / 4294967296;
  };

  // --- park the field ------------------------------------------------------
  // A no-op `step` alone is not enough. `Race.watchdogs` reads `forwardSpeed`
  // and `surface`, decides a kart with the throttle down and no speed is wedged
  // in a barrier, and cranes it back onto the racing line 4.5 s later — seven
  // karts materialising in front of the car being measured. Both fields are
  // therefore pinned to values the watchdog is happy with.
  w.__parkField = () => {
    for (const k of race.karts) {
      if (k.isPlayer) continue;
      const s = ctx.track.sample(0.5);
      k.placeAt(s.pos.clone().setY(s.pos.y - 600), 0, 0.5);
      // The velocity is cleared every frame as well as the position being
      // frozen: the director keeps applying its rubber-band `launch()` to a kart
      // it believes is racing, and with nothing integrating that away the stored
      // velocity climbs for the whole run.
      k.step = () => { k.velocity.set(0, 0, 0); k.forwardSpeed = 20; k.surface = 0; };
    }
  };

  // --- items off -----------------------------------------------------------
  w.__itemsOff = () => {
    ctx.items.reset();
    ctx.items.roll = () => 0;
    ctx.items.use = () => false;
    ctx.items.pickup = () => {};
  };

  // --- recorder ------------------------------------------------------------
  const D = {
    on: false,
    started: false,
    laps: [],
    cur: null,
    prevT: 0,
    lapIndex: 0,
    nextGate: 0,
    gates,
    // drift telemetry
    drifts: [],
    open: null,
    pending: null,
    prevDir: 0,
    respawns: 0,
    offTrackFrames: 0,
    frames: 0,
    // straight-line boost bench
    bench: null,
  };
  w.__db = D;

  ctx.bus.on((e) => {
    if (e.type === 'ui' && (e.name === 'respawn' || e.name === 'respawn-rival')) D.respawns++;
  });

  let lastFrame = -1;
  w.__dbProbe = () => {
    if (ctx.frame === lastFrame) return;
    lastFrame = ctx.frame;
    const k = race.player;

    // --- straight-line boost bench (independent of the lap recorder) --------
    const b = D.bench;
    // The window is closed IN the frame loop, not by the node-side poller: the
    // poller has ~250 ms of simulated granularity, which at 30 m/s is 7 m of
    // road — larger than some of the deltas being measured.
    if (b && b.elapsed < b.limit) {
      const dx = k.position.x - b.px, dy = k.position.y - b.py, dz = k.position.z - b.pz;
      b.dist += Math.sqrt(dx * dx + dy * dy + dz * dz);
      b.px = k.position.x; b.py = k.position.y; b.pz = k.position.z;
      if (k.forwardSpeed > b.peak) b.peak = k.forwardSpeed;
      b.sum += k.forwardSpeed;
      b.n++;
      b.elapsed += ctx.dt;
      if (k.boostTime > 0) b.boostFrames++;
    }

    // --- drift telemetry ---------------------------------------------------
    // Deliberately ABOVE the `D.on` gate. The mini-turbo ladder runs outside the
    // lap recorder, and with this below the gate it collected nothing at all —
    // the ladder reported "tier 3 reached" and then printed dashes for every
    // number about it, which is a tool confidently describing a measurement it
    // never took.
    const dir = k.driftDir;
    if (dir !== 0 && D.prevDir === 0) {
      D.open = { start: ctx.time, t: +k.t.toFixed(4), maxTier: 0, tierTime: [null, null, null], entrySpeed: +k.forwardSpeed.toFixed(2) };
    }
    if (D.open && k.driftTier > D.open.maxTier) {
      D.open.maxTier = k.driftTier;
      D.open.tierTime[k.driftTier - 1] = +(ctx.time - D.open.start).toFixed(4);
    }
    if (dir === 0 && D.prevDir !== 0 && D.open) {
      const o = D.open;
      o.hold = +(ctx.time - o.start).toFixed(4);
      o.releaseSpeed = +k.forwardSpeed.toFixed(2);
      // `releaseDrift` applies the mini-turbo inside the same step, so these are
      // read one frame later than the release — which is exactly when the boost
      // the drift actually earned is on the kart.
      o.boostGranted = +k.boostTime.toFixed(4);
      o.boostStrength = +(k.boostStrength ?? 0).toFixed(4);
      o.peakSpeed = +k.forwardSpeed.toFixed(2);
      D.drifts.push(o);
      D.pending = o;
      D.open = null;
    }
    if (D.pending) {
      if (k.forwardSpeed > D.pending.peakSpeed) D.pending.peakSpeed = +k.forwardSpeed.toFixed(2);
      if (k.boostTime <= 0) {
        D.pending.boostLasted = +(ctx.time - (D.pending.start + D.pending.hold)).toFixed(4);
        D.pending = null;
      }
    }
    D.prevDir = dir;

    if (!D.on) return;
    D.frames++;
    if (k.surface === 5 || k.surface === 6) D.offTrackFrames++;

    const t = k.t;
    if (D.started && t < D.prevT - 0.5) {
      D.lapIndex++;
    }
    // Arm on the first wrap so the run-up lap is not timed.
    if (!D.started && t < D.prevT - 0.5) {
      D.started = true;
      D.lapIndex = 0;
      D.nextGate = 0;
      D.cur = { start: ctx.time, splits: [], respawnsAtStart: D.respawns };
    }
    D.prevT = t;

    if (D.started) {
      // Gate crossings, in order, relative to the lap currently being timed.
      //
      // `rel` MUST be recomputed after a lap is pushed — it is measured against
      // `D.laps.length`, which the push just changed. Hoisting it out of the
      // loop (the obvious way to write this) leaves a stale value of ~1.0 that
      // still satisfies every gate, so the loop closes an unbounded number of
      // zero-length laps and the page hangs inside one animation frame.
      let rel = D.lapIndex + t - D.laps.length;
      let guard = 0;
      while (D.nextGate < D.gates.length && rel >= D.gates[D.nextGate] && guard++ < 64) {
        D.cur.splits.push({
          gate: D.gates[D.nextGate],
          time: +(ctx.time - D.cur.start).toFixed(4),
          speed: +k.forwardSpeed.toFixed(3),
        });
        D.nextGate++;
        if (D.nextGate >= D.gates.length) {
          D.cur.lapTime = +(ctx.time - D.cur.start).toFixed(4);
          D.cur.respawns = D.respawns - D.cur.respawnsAtStart;
          D.laps.push(D.cur);
          D.cur = { start: ctx.time, splits: [], respawnsAtStart: D.respawns };
          D.nextGate = 0;
          rel = D.lapIndex + t - D.laps.length;
        }
      }
    }
  };

  // --- run control ---------------------------------------------------------
  /**
   * Put the player on the line just before the start, at speed, and arm the
   * recorder. The run-up matters: starting the clock from a standstill would
   * make the first section a launch test rather than a lap.
   */
  w.__beginRun = (seed, driftMode) => {
    w.__reseed(seed);
    race.totalLaps = 999;            // nobody finishes; the recorder times laps
    race.autoDrive = true;
    race.state = 2;                  // Racing
    w.__parkField();
    w.__itemsOff();

    const k = race.player;
    const s = ctx.track.sample(0.90);
    k.placeAt(s.pos.clone().addScaledVector(s.normal, 0.6), Math.atan2(s.tangent.x, s.tangent.z), 0.90);
    k.velocity.copy(s.tangent).multiplyScalar(24);

    D.on = false;
    D.started = false;
    D.laps = [];
    D.cur = null;
    D.prevT = 0.90;
    D.lapIndex = 0;
    D.nextGate = 0;
    D.drifts = [];
    D.open = null;
    D.pending = null;
    D.prevDir = 0;
    D.respawns = 0;
    D.offTrackFrames = 0;
    D.frames = 0;

    // ONE bit of difference between the two conditions.
    //
    // The 'greedy' policy is hysteretic on purpose: commit at 0.30 of steering,
    // then hold the button until the driver has all but straightened up. The
    // first version of this used a single threshold, and the AI's steering
    // crosses it several times per corner — 0.325, 0.163, 0.296 on consecutive
    // frames through the harbour sweep — so the button chattered, the slide was
    // released and re-hopped 33 times a lap, and every single release charged
    // nothing. That measured a button-masher, not a drifter, and it is not what
    // a human's thumb does.
    race.driveOverride = (cmd) => {
      if (driftMode === 'off') cmd.drift = false;
      else if (driftMode === 'greedy') {
        const s = Math.abs(cmd.steer);
        cmd.drift = k.driftDir !== 0
          ? (s > 0.12 && k.forwardSpeed > 8)      // already sliding: hold it
          : (s > 0.30 && k.forwardSpeed > 10);    // straight: commit?
      }
      // 'ai' leaves the driver's own decision alone
      cmd.useItem = false;
    };
    D.on = true;
    return true;
  };

  /**
   * The mini-turbo ladder, measured in isolation.
   *
   * A real lap never answers "how long does tier 3 take?" — it answers "did any
   * corner on this circuit happen to last that long?", which is a different
   * question and, on Sunset Bay, the answer is no. So the ladder is climbed
   * deliberately: the AI keeps steering along the racing line, and the drift
   * button is pressed once in a corner and then never released. `bail` only
   * fires on release, a stall, a stun or a long flight, so the slide survives
   * the following straights and the charge clock keeps running.
   */
  w.__ladderBegin = (target) => {
    w.__reseed(w.__seed);
    race.totalLaps = 999;
    race.autoDrive = true;
    race.state = 2;
    w.__parkField();
    w.__itemsOff();
    const k = race.player;
    const s = ctx.track.sample(0.085);
    k.placeAt(s.pos.clone().addScaledVector(s.normal, 0.6), Math.atan2(s.tangent.x, s.tangent.z), 0.085);
    k.velocity.copy(s.tangent).multiplyScalar(24);
    D.drifts = [];
    D.open = null;
    D.pending = null;
    D.prevDir = 0;
    D.ladderEngaged = false;
    D.ladderHold = true;
    D.ladderTarget = target;
    race.driveOverride = (cmd) => {
      cmd.useItem = false;
      // Latch FIRST, then decide. The other order is a one-frame bug that took
      // a frame-by-frame trace to find: the slide engages inside `Kart.step`,
      // i.e. after this callback has already run, so on the very next frame the
      // latch is still false, the driver has eased off to 0.16 of steering, and
      // the button comes back up — releasing the slide on the frame after it
      // started, every time, for ever.
      if (k.driftDir !== 0) D.ladderEngaged = true;
      // The release is decided HERE and not by the node-side poller. A poll is
      // ~50 ms of simulated time away from the frame it is reacting to, and a
      // slide asked to stop at tier 1 kept charging through it into tier 2 — so
      // the tier-1 row was silently filled in with tier-2 numbers, and the
      // tier-1 row itself came out empty.
      if (D.ladderEngaged && k.driftTier >= D.ladderTarget) D.ladderHold = false;
      cmd.drift = D.ladderEngaged
        ? D.ladderHold
        // Press only where the driver is already turning: the slide engages off
        // the HOP, and the hop's 0.45 s window needs > 0.2 of steering in it.
        : Math.abs(cmd.steer) > 0.30;
    };
    return true;
  };
  w.__ladderEnd = () => {
    race.driveOverride = null;
    D.ladderHold = false;
    return { drifts: D.drifts, tier: race.player.driftTier, engaged: D.ladderEngaged };
  };
  w.__ladderState = () => ({
    engaged: D.ladderEngaged,
    tier: race.player.driftTier,
    dir: race.player.driftDir,
    speed: +race.player.forwardSpeed.toFixed(2),
    released: D.drifts.length,
  });

  w.__endRun = () => {
    D.on = false;
    race.driveOverride = null;
    return {
      laps: D.laps.map((l) => ({ lapTime: l.lapTime, respawns: l.respawns, splits: l.splits })),
      drifts: D.drifts,
      respawns: D.respawns,
      offTrackFrames: D.offTrackFrames,
      frames: D.frames,
    };
  };

  // --- straight-line boost bench ------------------------------------------
  /** Put the kart back at the top of the start straight and let it settle. */
  w.__benchSettle = () => {
    const k = race.player;
    const s = ctx.track.sample(0.005);
    k.placeAt(s.pos.clone().addScaledVector(s.normal, 0.6), Math.atan2(s.tangent.x, s.tangent.z), 0.005);
    k.velocity.copy(s.tangent).multiplyScalar(24);
    D.bench = null;
    return true;
  };
  /**
   * Open the measured window. The boost is applied on the SAME frame the window
   * opens — passing it in rather than calling `applyBoost` from node, because a
   * round trip is ~30 ms of simulated time and that is 1 m of the very thing
   * being measured.
   */
  w.__benchBegin = (limit, boostDur, boostStr) => {
    const k = race.player;
    if (boostDur > 0) k.applyBoost(boostDur, boostStr);
    D.bench = {
      px: k.position.x, py: k.position.y, pz: k.position.z,
      dist: 0, peak: 0, sum: 0, n: 0, elapsed: 0, boostFrames: 0, limit,
    };
    return true;
  };
  w.__benchEnd = () => {
    const b = D.bench;
    D.bench = null;
    if (!b) return null;
    return {
      dist: +b.dist.toFixed(2),
      peak: +b.peak.toFixed(2),
      mean: +(b.sum / Math.max(1, b.n)).toFixed(2),
      elapsed: +b.elapsed.toFixed(3),
      boostSeconds: +(b.boostFrames / 60).toFixed(3),
    };
  };
}, GATES);

// Clock sanity — everything below is denominated in this step.
{
  const w0 = Date.now();
  const a = await evalIn('return { t: ctx.time, f: ctx.frame };');
  await sleep(2500);
  const b = await evalIn('return { t: ctx.time, f: ctx.frame };');
  const stepMs = (b.t - a.t) / Math.max(1, b.f - a.f) * 1000;
  console.log(`clock: ${((b.t - a.t) / ((Date.now() - w0) / 1000)).toFixed(2)}x real time, ` +
    `${stepMs.toFixed(2)}ms per simulated frame (want 16.67)`);
  if (Math.abs(stepMs - 16.67) > 1.0) {
    fails.push(`instrument: the fixed-step clock is delivering ${stepMs.toFixed(2)}ms frames, not 16.67 — ` +
      `every time below is scaled by ${(stepMs / 16.67).toFixed(2)}x`);
  }
}

// ===========================================================================
//  Lap runs
// ===========================================================================
/**
 * The gated comparison is `clean` vs `drift`, and `drift` is the SCRIPTED
 * corner-entry policy — button down whenever the driver is turning meaningfully
 * and moving, released on the way out — not the shipped AI's own choices.
 *
 * That is deliberate, and it is one pre-registered comparison rather than a
 * best-of-N, which would quietly bias the result upward by however much the
 * run-to-run noise happens to be. The policy is what a competent human does
 * with the button, and "a competent drifting lap beats a clean one" is the
 * claim the round is actually making.
 *
 * `ai` is carried as a diagnostic, not as the gate. The two can disagree, and
 * when they do that is a finding about the driver model, not about the loop.
 */
const CONDITIONS = NULL_TEST
  ? [{ key: 'clean', label: 'clean (no drift)', mode: 'off' },
     { key: 'drift', label: 'NULL arm — also no drift', mode: 'off' }]
  : [{ key: 'clean', label: 'clean — drift button never pressed', mode: 'off' },
     { key: 'drift', label: 'drifting — button down through every corner', mode: 'greedy' },
     { key: 'ai', label: 'the shipped driver\'s own drift decisions (diagnostic)', mode: 'ai' }];

const runs = {};
for (const c of CONDITIONS) {
  process.stdout.write(`\n[${c.key}] ${c.label} — ${LAPS} lap${LAPS === 1 ? '' : 's'}`);
  await evalIn(`window.__beginRun(${SEED}, '${c.mode}'); return true;`);
  const done = await until(`${c.key} laps`, `D.laps.length >= ${LAPS}`, { sim: 60 + LAPS * 200, wallMs: 600000 });
  const r = await evalIn('return window.__endRun();');
  r.timedOut = !done.ok;
  runs[c.key] = r;
  if (!done.ok) {
    fails.push(`${c.key}: only completed ${r.laps.length} of ${LAPS} laps — ${done.reason}`);
    process.stdout.write(`   INCOMPLETE (${r.laps.length}/${LAPS})\n`);
  } else {
    const offPct = (100 * r.offTrackFrames / Math.max(1, r.frames)).toFixed(1);
    process.stdout.write(`   ${r.laps.map((l) => l.lapTime.toFixed(3)).join('  ')}   ` +
      `(${offPct}% of frames off the circuit)\n`);
    if (+offPct > 4) {
      notes.push(`${c.key}: ${offPct}% of frames were off the circuit — the driver is running wide, ` +
        `so this arm's lap times include recovery time that has nothing to do with the drift button`);
    }
  }
  if (r.respawns) notes.push(`${c.key}: ${r.respawns} respawn(s) during the run — those laps are contaminated`);
}

// ===========================================================================
//  Mini-turbo ladder — time to each tier, and what each tier grants
// ===========================================================================
console.log('\n[ladder] one held slide per tier, so every tier is measured whether or not a corner is long enough for it');
const ladder = [];
for (const target of [1, 2, 3]) {
  await evalIn(`window.__ladderBegin(${target}); return true;`);
  const engaged = await until(`ladder tier ${target} engage`, 'window.__ladderState().engaged', { sim: 16 });
  let released = { ok: false };
  if (engaged.ok) released = await until(`ladder tier ${target}`, 'window.__ladderState().released > 0', { sim: 16 });
  await advance(0.3);
  const out = await evalIn('return window.__ladderEnd();');
  const d = out.drifts[out.drifts.length - 1] || null;
  const reached = !!(released.ok && d && d.maxTier >= target);
  ladder.push({ target, engaged: engaged.ok, reached, drift: d });
  if (!engaged.ok) {
    console.log(`  tier ${target}: the slide never engaged — ${engaged.reason}`);
  } else if (!reached) {
    console.log(`  tier ${target}: engaged but only charged to tier ${d?.maxTier ?? '?'} ` +
      `in ${f2(d?.hold ?? NaN)}s of held slide`);
  } else {
    console.log(`  tier ${target}: reached after ${f2(d.tierTime[target - 1])}s of held slide; ` +
      `release granted ${f2(d.boostGranted)}s at x${d.boostStrength.toFixed(3)} ` +
      `(entry ${f1(d.entrySpeed)} -> release ${f1(d.releaseSpeed)} m/s)`);
  }
}

// ===========================================================================
//  Straight-line boost bench
// ===========================================================================
// What each tier's mini-turbo is actually worth, measured against the same
// stretch of road with no boost at all. The (duration, strength) pairs are read
// off measured releases rather than copied out of Kart.ts, so the bench cannot
// drift out of date with the constants it is describing. The ladder is the
// preferred source — it reaches every tier deliberately — with the racing laps
// as a fallback for tiers the ladder failed to reach.
const tierGrant = new Map();
for (const key of Object.keys(runs)) {
  for (const d of runs[key].drifts) {
    if (!d.maxTier || !d.boostGranted) continue;
    if (!tierGrant.has(d.maxTier)) tierGrant.set(d.maxTier, []);
    tierGrant.get(d.maxTier).push({ dur: d.boostGranted, str: d.boostStrength });
  }
}
for (const l of ladder) {
  if (!l.reached || !l.drift || !l.drift.boostGranted) continue;
  tierGrant.set(l.drift.maxTier, [{ dur: l.drift.boostGranted, str: l.drift.boostStrength }]);
}

/**
 * Measured window, seconds. Long enough to contain a whole tier-3 mini-turbo
 * (2.1 s) and short enough that a boosted kart is still on the start straight
 * at the end of it rather than braking for the harbour sweep.
 */
const BENCH_SECONDS = 2.6;
const BENCH_SETTLE = 1.2;

async function benchRun(dur, str) {
  await evalIn(`window.__reseed(${SEED}); race.autoDrive = true; race.state = 2;
    window.__parkField(); window.__itemsOff();
    race.driveOverride = (cmd) => { cmd.drift = false; cmd.useItem = false; };
    window.__benchSettle(); return true;`);
  await advance(BENCH_SETTLE);
  await evalIn(`window.__benchBegin(${BENCH_SECONDS}, ${dur || 0}, ${str || 1}); return true;`);
  // Overshoot deliberately: the window closes itself inside the frame loop.
  await advance(BENCH_SECONDS + 0.5);
  const out = await evalIn('return window.__benchEnd();');
  await evalIn('race.driveOverride = null; return true;');
  return out;
}

console.log('\n[boost bench] a fixed stretch of the start straight, with and without the mini-turbo');
const benchBase = await benchRun(0, 1);
console.log(`  no boost        : ${benchBase.dist.toFixed(1)} m in ${benchBase.elapsed.toFixed(2)}s, ` +
  `mean ${benchBase.mean.toFixed(1)} m/s, peak ${benchBase.peak.toFixed(1)} m/s`);

const benchTiers = [];
for (const tier of [1, 2, 3]) {
  const grants = tierGrant.get(tier) || [];
  if (!grants.length) {
    console.log(`  tier ${tier}          : never earned in any run — nothing to measure`);
    benchTiers.push({ tier, measured: false });
    continue;
  }
  const dur = grants.reduce((a, g) => a + g.dur, 0) / grants.length;
  const str = grants.reduce((a, g) => a + g.str, 0) / grants.length;
  const out = await benchRun(+dur.toFixed(4), +str.toFixed(4));
  const gain = out.dist - benchBase.dist;
  const dv = out.peak - benchBase.peak;
  benchTiers.push({ tier, measured: true, dur, str, ...out, gain, dv });
  console.log(`  tier ${tier}          : ${dur.toFixed(2)}s x${str.toFixed(3)}  ->  ` +
    `${out.dist.toFixed(1)} m (${gain >= 0 ? '+' : ''}${gain.toFixed(1)} m), ` +
    `peak ${out.peak.toFixed(1)} m/s (${dv >= 0 ? '+' : ''}${dv.toFixed(1)}), ` +
    `boost held ${out.boostSeconds.toFixed(2)}s`);
}

// ===========================================================================
//  Report
// ===========================================================================
const median = (a) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const best = (a) => (a.length ? Math.min(...a) : NaN);

function lapTimes(key) { return (runs[key]?.laps || []).map((l) => l.lapTime); }

/** Per-section split times, per condition. */
function sectionTimes(key) {
  const out = SECTIONS.map(() => []);
  for (const lap of runs[key]?.laps || []) {
    let prev = 0;
    for (let i = 0; i < lap.splits.length && i < SECTIONS.length; i++) {
      out[i].push(lap.splits[i].time - prev);
      prev = lap.splits[i].time;
    }
  }
  return out.map(median);
}
function exitSpeeds(key) {
  const out = SECTIONS.map(() => []);
  for (const lap of runs[key]?.laps || []) {
    for (let i = 0; i < lap.splits.length && i < SECTIONS.length; i++) out[i].push(lap.splits[i].speed);
  }
  return out.map(median);
}

console.log('\n' + '='.repeat(78));
console.log('LAP TIMES');
for (const c of CONDITIONS) {
  const t = lapTimes(c.key);
  console.log(`  ${c.key.padEnd(7)} median ${fmt(median(t))}   best ${fmt(best(t))}   ` +
    `laps [${t.map((x) => x.toFixed(2)).join(', ')}]`);
}

const cleanMed = median(lapTimes('clean'));
const driftMed = median(lapTimes('drift'));
const advantage = (cleanMed - driftMed) / cleanMed;

console.log('\nSECTION SPLITS  (median, seconds; negative delta = drifting is faster)');
const cs = sectionTimes('clean');
const ds = sectionTimes('drift');
const cv = exitSpeeds('clean');
const dv = exitSpeeds('drift');
console.log('  section            clean    drift     delta      exit m/s clean -> drift');
for (let i = 0; i < SECTIONS.length; i++) {
  const d = ds[i] - cs[i];
  console.log(`  ${SECTIONS[i].name.padEnd(17)} ${f2(cs[i]).padStart(6)}  ${f2(ds[i]).padStart(6)}  ` +
    `${(d >= 0 ? '+' : '') + f2(d)}`.padStart(9) +
    `      ${f1(cv[i]).padStart(5)} -> ${f1(dv[i]).padStart(5)}  ` +
    `(${(dv[i] - cv[i] >= 0 ? '+' : '') + f1(dv[i] - cv[i])})`);
}

// --- mini-turbo telemetry ---------------------------------------------------
const driftRun = runs.drift || { drifts: [] };
const attempts = driftRun.drifts.length;
const byTier = [0, 0, 0, 0];
for (const d of driftRun.drifts) byTier[d.maxTier]++;
const tierTimes = [[], [], []];
for (const d of driftRun.drifts) {
  for (let i = 0; i < 3; i++) if (d.tierTime[i] != null) tierTimes[i].push(d.tierTime[i]);
}
console.log('\nMINI-TURBO');
console.log(`  drift attempts     : ${attempts} over ${runs.drift?.laps.length ?? 0} laps ` +
  `(${(attempts / Math.max(1, runs.drift?.laps.length ?? 1)).toFixed(1)} per lap)`);
console.log(`  released at tier   : 0=${byTier[0]}  1=${byTier[1]}  2=${byTier[2]}  3=${byTier[3]}`);
console.log(`  tier-3 hold rate   : ${attempts ? (100 * byTier[3] / attempts).toFixed(1) : '--'}% of all attempts, ` +
  `${(byTier[1] + byTier[2] + byTier[3]) ? (100 * byTier[3] / (byTier[1] + byTier[2] + byTier[3])).toFixed(1) : '--'}% of charged ones`);
for (let i = 0; i < 3; i++) {
  const inLap = tierTimes[i].length ? `${f2(median(tierTimes[i]))}s in traffic (median of ${tierTimes[i].length})` : 'never reached on a lap';
  const l = ladder[i];
  const held = l && l.reached && l.drift ? `${f2(l.drift.tierTime[i])}s on a held slide` : 'not reached even when held';
  console.log(`  time to tier ${i + 1}     : ${held};  ${inLap}`);
}
const wasted = driftRun.drifts.filter((d) => d.maxTier === 0).length;
if (attempts) {
  const holdMed = median(driftRun.drifts.map((d) => d.hold));
  console.log(`  median hold        : ${f2(holdMed)}s   (${wasted} attempt(s) released with nothing charged)`);
}

console.log('\nBOOST DELIVERED  (against ' + benchBase.dist.toFixed(1) + ' m of unboosted road)');
for (const b of benchTiers) {
  if (!b.measured) { console.log(`  tier ${b.tier}: not earned in this run`); continue; }
  console.log(`  tier ${b.tier}: +${b.gain.toFixed(1)} m and +${b.dv.toFixed(1)} m/s peak over ${b.boostSeconds.toFixed(2)}s of boost ` +
    `(${b.dur.toFixed(2)}s granted, x${b.str.toFixed(3)} top speed)`);
}

console.log('\n' + '='.repeat(78));
console.log(`clean  median lap : ${fmt(cleanMed)}`);
console.log(`drift  median lap : ${fmt(driftMed)}`);
console.log(`advantage         : ${(advantage * 100).toFixed(2)}%  (${(cleanMed - driftMed).toFixed(3)}s per lap)`);
if (!NULL_TEST) {
  console.log('                    (an advantage is only meaningful against this rig\'s own noise floor —');
  console.log('                     re-measure it any time with `node tools/drift-bench.mjs --null`)');
}
if (runs.ai) {
  const g = median(lapTimes('ai'));
  const adv = ((cleanMed - g) / cleanMed) * 100;
  console.log(`AI's own drifting : ${fmt(g)}   (${adv >= 0 ? '+' : ''}${adv.toFixed(2)}% vs clean)  [diagnostic, not gated]`);
  const aiDrifts = runs.ai.drifts || [];
  const aiWasted = aiDrifts.filter((d) => d.maxTier === 0).length;
  console.log(`                    ${aiDrifts.length} attempts, ${aiWasted} of them charged nothing at all`);
  if (adv < 0) {
    notes.push(`the shipped driver's own drifting is ${(-adv).toFixed(2)}% SLOWER than not drifting at all ` +
      `(${aiWasted}/${aiDrifts.length} of its slides released with no charge). The rival field is losing ` +
      `time to a mechanic it is supposed to be exploiting.`);
  }
}

// ---------------------------------------------------------------------------
//  Gate
// ---------------------------------------------------------------------------
if (NULL_TEST) {
  // Both arms were identical. Anything but a dead heat is the rig's own bias.
  const bias = Math.abs(advantage);
  console.log(`\nNULL TEST: the two identical arms differed by ${(bias * 100).toFixed(2)}%`);
  if (bias > 0.01) {
    fails.push(`NULL TEST FAILED: two identical arms differed by ${(bias * 100).toFixed(2)}% ` +
      `(${(cleanMed - driftMed).toFixed(3)}s). The A/B rig is biased and every advantage this tool ` +
      `reports in normal mode is contaminated by at least that much.`);
  }
} else {
  if (!Number.isFinite(cleanMed) || !Number.isFinite(driftMed)) {
    fails.push('gate: one of the two conditions produced no complete laps, so there is nothing to compare');
  } else if (advantage <= MIN_ADVANTAGE) {
    fails.push(
      `GATE FAILED: drifting is NOT faster. Clean median ${cleanMed.toFixed(3)}s, drifting median ` +
      `${driftMed.toFixed(3)}s — drifting costs ${(driftMed - cleanMed).toFixed(3)}s a lap. ` +
      `The drift -> mini-turbo -> boost loop is the product; if a greedy line does not pay, players ` +
      `will learn to stop taking it and every spark, flame and FOV punch built on top of it is decoration ` +
      `on a mechanic nobody uses.`);
  } else if (advantage > MAX_ADVANTAGE) {
    fails.push(
      `GATE FAILED (the other way): drifting is worth ${(advantage * 100).toFixed(1)}% of the lap, over the ` +
      `${(MAX_ADVANTAGE * 100).toFixed(0)}% ceiling. At that point drifting is not a risky line that pays, ` +
      `it is the only way to drive, and the game is a drift-spam simulator. This is a design bound, not a ` +
      `crash — raise it deliberately if that is the intent.`);
  }
  // A drift system nobody can hold to tier 3 has a dead top end.
  if (attempts && byTier[3] === 0) {
    notes.push('tier 3 was never reached in the drifting run — the purple mini-turbo is unreachable ' +
      'on this circuit with this driver, so a third of the feature is unverified');
  }
}

if (consoleErrors.length) {
  console.log(`\nconsole errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 6)) console.log('   - ' + e.slice(0, 200));
  fails.push(`${consoleErrors.length} console error(s) during the run`);
}
if (navigations > navAtBoot) {
  fails.push(`the page reloaded ${navigations - navAtBoot} time(s) mid-run; every number above straddles ` +
    `a fresh page and means nothing. Re-run when the tree is still.`);
}
for (const n of notes) console.log(`note: ${n}`);

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails) console.log('  - ' + f);
} else if (NULL_TEST) {
  console.log('\nPASS — the two identical arms agree, so the A/B rig has no measurable bias of its own');
} else {
  console.log('\nPASS — a drifting lap is measurably faster than a clean one');
}

await browser.close();
srv.stop();
process.exit(fails.length ? 1 : 0);

// ---------------------------------------------------------------------------
function fmt(s) {
  if (!Number.isFinite(s)) return '--';
  const m = Math.floor(s / 60);
  return m ? `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}` : `${s.toFixed(3)}s`;
}
function f2(v) { return Number.isFinite(v) ? v.toFixed(2) : '--'; }
function f1(v) { return Number.isFinite(v) ? v.toFixed(1) : '--'; }
