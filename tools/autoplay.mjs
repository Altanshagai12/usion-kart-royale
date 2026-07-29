/**
 * ============================================================================
 *  AUTOPLAY — the standing gameplay gate.
 * ============================================================================
 *
 *   node tools/autoplay.mjs [--port N] [--quality low|high] [--realtime]
 *
 * Every gameplay bug this project has ever shipped — inverted steering, missing
 * touch controls, a pause menu that suspended the race for good — was found by a
 * human driving. Three rounds of art critics, judging still frames, found none
 * of them, because a still frame cannot show you that the race never ends.
 *
 * So this harness plays. It runs a full 3-lap race with all eight karts and
 * asserts on OUTCOMES:
 *
 *   - the race finishes, for everyone, with a sane classification
 *   - lap times land in a plausible band
 *   - nobody is stranded, stuck in reverse, or lapped absurdly
 *   - position and lap accounting stay coherent every single frame
 *   - a cut across the geometry earns nothing (checkpoints hold)
 *   - every ItemKind fires, connects, expires and returns its slot to the pool
 *   - countdown -> racing -> finished -> results, plus pause/resume and restart
 *   - no non-finite position, velocity, quaternion or race distance, ever
 *   - zero console errors from the first frame to the last
 *
 * Exits non-zero on any failure so it can gate a workflow.
 *
 * ----------------------------------------------------------------------------
 *  ON THE INSTRUMENT ITSELF
 * ----------------------------------------------------------------------------
 * Two harnesses in this repo have produced confident false readings (a camera
 * probe projecting a camera-relative vector as if it were a world point; a soak
 * test reporting half a gigabyte of "retained" heap that was uncollected
 * garbage). Assume this one can too. Three things are done about it:
 *
 *  1. **The clock is synthetic, and that is stated loudly.** A real-time race is
 *     ~3.5 minutes of wall clock per run, which is too slow to be a gate, so
 *     `requestAnimationFrame` is replaced with a fixed-step scheduler: every
 *     frame advances the page's animation clock by exactly 1/60 s regardless of
 *     how long it really took. The simulation therefore runs at whatever rate
 *     the CPU can manage (~3.4x real time here) while seeing a perfectly regular
 *     delta. `--realtime` disables this and runs against the browser's own
 *     vsync, which is the ground truth the fast path is checked against.
 *     THE TWO MUST AGREE ON LAP TIMES. If they ever stop agreeing, the fast
 *     path is lying and the numbers below are worthless.
 *
 *  2. **Two independent clocks are compared.** The harness times laps off the
 *     `lap` events on the bus using `ctx.time`; the director keeps its own
 *     `race.lapTimes` off `raceTime`. They are printed side by side. A harness
 *     that agrees with the thing it is measuring to the millisecond is at least
 *     not measuring something else.
 *
 *  3. **Unreachable state is reported, not skipped silently.** The projectile
 *     pool is a TypeScript `private` field; if a future refactor renames it, the
 *     leak check would quietly pass forever. It fails loudly instead.
 *
 * The rAF replacement is a faithful emulation, not a shim: callbacks queued
 * during one frame all receive the same timestamp and run in one batch, exactly
 * as the browser does it, and an exception in a callback is re-thrown out of
 * band so it still reaches `window.onerror` and shows up as a page error.
 * Getting that wrong is how you end up measuring a game running at 1/30 s per
 * frame and calling it 60 fps.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

// ---------------------------------------------------------------------------
//  Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

/**
 * Unique port. Every harness in this directory hard-codes one and `startVite`
 * adopts whatever already holds it; a stale sibling worktree's server once made
 * a probe measure a different checkout entirely. `startVite` now refuses a
 * foreign tree, and this flag is the escape hatch when the port is squatted.
 */
const PORT = parseInt(opt('--port', process.env.AUTOPLAY_PORT || '5327'), 10);
const QUALITY = opt('--quality', 'low');
const REALTIME = flag('--realtime');

// ---------------------------------------------------------------------------
//  Budgets
// ---------------------------------------------------------------------------
/**
 * Plausible lap band, seconds.
 *
 * Sunset Bay is ~1600 m of centreline and `BASE_TOP_SPEED` is 30 m/s, so a
 * physically perfect lap is 53 s and nothing can ever go below it. The AI field
 * measures ~62-68 s. The band is deliberately wide — this gate exists to catch
 * "the lap counter fired eight times in a second" and "nobody ever finished",
 * not to police balance, and a tight band would fail every time somebody tunes
 * the drift boost.
 */
const LAP_MIN = 35;
const LAP_MAX = 140;
/** continuous seconds a kart may sit motionless mid-race before it is stranded */
const STALL_LIMIT = 5.0;
/** continuous seconds a kart may travel backwards before it is stuck in reverse */
const REVERSE_LIMIT = 3.0;
/** the last finisher may take at most this multiple of the winner's time */
const SPREAD_LIMIT = 1.6;
/** a cut may not credit more than this much unearned distance, metres */
const CUT_CREDIT_LIMIT = 140;

const RACE_STATE = ['Menu', 'Countdown', 'Racing', 'Finished', 'Results', 'Paused'];
const ITEM_NAME = ['None', 'Mushroom', 'TripleMushroom', 'GreenShell', 'RedShell', 'Banana', 'Star', 'Bolt', 'Bomb'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
const fails = [];
const notes = [];
const consoleErrors = [];
let crashed = false;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  // 30 s is the default and it is not enough on a machine running several
  // agents at once — observed failing to launch at a load average of 170.
  timeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });

/**
 * Neuter Vite's HMR client.
 *
 * This is not tidiness, it is correctness, and it cost a debugging session to
 * find. Agents work this tree in parallel, and a dev server watching `src/`
 * issues a FULL RELOAD to every connected page the instant somebody else saves
 * a file. Mid-run that silently drops the race back to `Menu` with the clock at
 * zero — and the harness, which is asking questions like "has everyone
 * finished?", would happily go on asking them of a brand new page and report
 * whatever the second, third and fourth incarnations happened to be doing.
 * Observed live: five reloads inside one 60-second race.
 *
 * The client is answered with a stub exporting the names Vite's transform can
 * reference, so no websocket is opened and no module fails to resolve. Any
 * navigation that happens anyway is counted below and fails the run outright —
 * a reload invalidates every measurement taken across it, so it must never be
 * something the harness merely survives.
 */
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
  } else {
    r.continue().catch(() => {});
  }
});

let navigations = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

page.on('error', (e) => { crashed = true; consoleErrors.push('PAGE CRASHED: ' + String(e.message || e)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console.error: ' + m.text()); });

/**
 * Evaluate a body in the page with `ctx`, `race` and the probe state `S` in
 * scope. The body must `return` something JSON-serialisable.
 */
const evalIn = (expr) => page.evaluate(
  `(() => { const ctx = window.__ctx, race = ctx.race, S = window.__ap; ${expr} })()`,
);

/** Poll until `expr` is truthy in the page, bounded by BOTH clocks. */
async function until(label, expr, { sim = 30, wallMs = 180000 } = {}) {
  const start = await evalIn('return ctx.time;');
  const w0 = Date.now();
  for (;;) {
    let r;
    try {
      r = await evalIn(`return { done: !!(${expr}), time: ctx.time, state: race.state };`);
    } catch (err) {
      crashed = true;
      return { ok: false, reason: `the page stopped responding (${String(err).split('\n')[0]})` };
    }
    if (r.done) return { ok: true, sim: r.time - start, wallMs: Date.now() - w0, state: r.state };
    if (r.time - start > sim) {
      return {
        ok: false, sim: r.time - start, state: r.state,
        reason: `${label}: never became true within ${sim}s of simulated time ` +
                `(state stayed ${RACE_STATE[r.state] ?? r.state})`,
      };
    }
    if (Date.now() - w0 > wallMs) {
      return {
        ok: false, sim: r.time - start, state: r.state,
        reason: `${label}: ${(wallMs / 1000) | 0}s of wall clock with only ` +
                `${(r.time - start).toFixed(1)}s of simulation — the frame loop has stalled or stopped`,
      };
    }
    await sleep(100);
  }
}

/** Let the simulation run forward by `seconds` of simulated time. */
async function advance(seconds, wallMs = 120000) {
  const r = await until('advance', 'false', { sim: seconds, wallMs });
  if (r.ok === false && r.reason && r.reason.includes('wall clock')) throw new Error(r.reason);
  return r.sim;
}

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?quality=${QUALITY}&scale=0.5`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 180000 });
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s  (quality=${QUALITY}, port=${PORT})`);
const navAtBoot = navigations;

// ---------------------------------------------------------------------------
//  Instrument
// ---------------------------------------------------------------------------
await page.evaluate((realtime) => {
  const w = window;
  const ctx = w.__ctx;
  const race = ctx.race;
  const N = race.karts.length;

  // --- fixed-step clock ----------------------------------------------------
  // Faithful rAF emulation, not a shim. All callbacks queued during one frame
  // receive the SAME timestamp and run in one batch, because that is what the
  // browser does — hand each queued callback its own advanced timestamp and the
  // main loop's delta silently becomes a multiple of the step, which is how you
  // end up measuring a game running at half speed and reporting 60 fps.
  if (!realtime) {
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
            // Isolate like the browser does, but re-throw out of band so the
            // failure still reaches window.onerror and the harness sees it.
            try { e.cb(w.__vt); } catch (err) { setTimeout(() => { throw err; }, 0); }
          }
          const p = w.__apProbe;
          if (p) p();
        }, 0);
      }
      return id;
    };
    w.cancelAnimationFrame = (id) => { cancelled.add(id); };
  } else {
    // Real-clock mode has no scheduler to hang the probe off, so it gets its own
    // rAF loop. Without this the entire per-frame instrument is DEAD in
    // `--realtime` and the harness reports "worst stall 0.0s, top speed 0.0 m/s,
    // zero state transitions" — a flawless-looking set of numbers produced by
    // never having looked. That is precisely the failure mode this file's header
    // warns about, and it shipped in the first version of this file.
    const tick = () => {
      w.requestAnimationFrame(tick);
      const p = w.__apProbe;
      if (p) p();
    };
    w.requestAnimationFrame(tick);
  }

  // --- probe state ---------------------------------------------------------
  const K = [];
  for (let i = 0; i < N; i++) {
    K.push({
      name: race.karts[i].stats.name,
      stallT: 0, stallMax: 0, revT: 0, revMax: 0, maxSpeed: 0,
      lapDrops: 0, lastLap: 0, nonFinite: 0,
    });
  }

  const S = {
    frames: 0,
    strict: false,
    kart: K,
    states: [],
    placeBadFrames: 0,
    liveProj: 0,
    liveProjMax: 0,
    // Frames each ItemKind spent live in the pool, counted IN the frame loop.
    // Polling this from node instead misses short-lived projectiles entirely: a
    // green shell fired at a kart 14 m away is gone in a third of a second, and
    // a poll that arrives after it reports, with total confidence, that no
    // projectile was ever allocated.
    projFrames: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    projReachable: false,
    projNote: '',
    events: Object.create(null),
    lap: [],
    finish: [],
    hits: [],
    itemUse: [],
    boosts: [],
    nonFinite: [],
  };
  w.__ap = S;

  ctx.bus.on((e) => {
    S.events[e.type] = (S.events[e.type] | 0) + 1;
    const t = +ctx.time.toFixed(3);
    const rt = +race.raceTime.toFixed(3);
    if (e.type === 'lap') S.lap.push({ id: e.kart.id, lap: e.lap, time: t, raceTime: rt });
    else if (e.type === 'finish') S.finish.push({ id: e.kart.id, place: e.place, time: t, raceTime: rt });
    else if (e.type === 'hit') S.hits.push({ id: e.kart.id, kind: e.kind, time: t });
    else if (e.type === 'item-use') S.itemUse.push({ id: e.kart.id, kind: e.kind, time: t });
    else if (e.type === 'boost') S.boosts.push({ id: e.kart.id, tier: e.tier, time: t });
  });

  // The projectile pool is `private` in TypeScript, which is a compile-time
  // fiction — but a rename would make the leak check silently pass forever, so
  // its absence is recorded as a failure rather than skipped.
  const proj = ctx.items && ctx.items.proj;
  if (proj && Array.isArray(proj.pool) && proj.pool.length) S.projReachable = true;
  else S.projNote = 'ctx.items.proj.pool is not reachable — the projectile leak check cannot run';

  const fin3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

  let lastFrame = -1;
  w.__apProbe = () => {
    // One sample per SIMULATION frame, whatever the rAF traffic looks like.
    if (ctx.frame === lastFrame) return;
    lastFrame = ctx.frame;
    S.frames++;

    const st = race.state;
    const last = S.states.length ? S.states[S.states.length - 1] : null;
    if (!last || last.state !== st) {
      S.states.push({ state: st, time: +ctx.time.toFixed(2), raceTime: +race.raceTime.toFixed(2) });
    }

    const dt = ctx.dt;
    const racing = st === 2;
    let placeMask = 0;
    let placeCount = 0;

    for (let i = 0; i < N; i++) {
      const k = race.karts[i];
      const s = K[i];
      const p = k.position, v = k.velocity, q = k.quaternion;
      if (!fin3(p) || !fin3(v) ||
          !Number.isFinite(q.x) || !Number.isFinite(q.y) ||
          !Number.isFinite(q.z) || !Number.isFinite(q.w) ||
          !Number.isFinite(k.raceDistance) || !Number.isFinite(k.t) ||
          !Number.isFinite(k.forwardSpeed)) {
        s.nonFinite++;
        if (S.nonFinite.length < 10) {
          S.nonFinite.push({
            id: i, name: s.name, time: +ctx.time.toFixed(2), state: st,
            pos: [p.x, p.y, p.z], vel: [v.x, v.y, v.z], quat: [q.x, q.y, q.z, q.w],
            t: k.t, raceDistance: k.raceDistance, forwardSpeed: k.forwardSpeed,
          });
        }
      }

      const fs = k.forwardSpeed;
      const afs = Math.abs(fs);
      if (afs > s.maxSpeed && Number.isFinite(afs)) s.maxSpeed = afs;

      if (S.strict) {
        // Stranded: not moving, while the race is live, while not spun out.
        // A stunned kart is legitimately stationary and is not a bug.
        if (racing && !k.finished && k.stunTime <= 0 && afs < 1.0) {
          s.stallT += dt;
          if (s.stallT > s.stallMax) s.stallMax = s.stallT;
        } else s.stallT = 0;

        if (racing && fs < -2) {
          s.revT += dt;
          if (s.revT > s.revMax) s.revMax = s.revT;
        } else s.revT = 0;

        if (k.lap < s.lastLap) s.lapDrops++;
        s.lastLap = k.lap;

        const pl = k.place;
        if (pl >= 1 && pl <= N) { placeMask |= 1 << (pl - 1); placeCount++; }
      }
    }

    if (S.strict && (placeCount !== N || placeMask !== (1 << N) - 1)) S.placeBadFrames++;

    if (S.projReachable) {
      const pool = proj.pool;
      let live = 0;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].state === 0) continue;
        live++;
        const kind = pool[i].kind;
        if (kind >= 0 && kind < S.projFrames.length) S.projFrames[kind]++;
      }
      S.liveProj = live;
      if (live > S.liveProjMax) S.liveProjMax = live;
    }
  };
}, REALTIME);

const setup = await evalIn('return { projReachable: S.projReachable, projNote: S.projNote, karts: race.karts.length, laps: race.totalLaps, checkpoints: ctx.track.checkpointCount, trackLength: +ctx.track.length.toFixed(0) };');
console.log(`track ${setup.trackLength} m, ${setup.checkpoints} checkpoints, ` +
  `${setup.karts} karts, ${setup.laps} laps` + (REALTIME ? '  [REAL-TIME CLOCK]' : '  [fixed-step clock]'));
if (!setup.projReachable) fails.push(`instrument: ${setup.projNote}`);

// Sanity-check the clock replacement before trusting anything it produces.
if (!REALTIME) {
  const w0 = Date.now();
  const before = await evalIn('return { t: ctx.time, f: ctx.frame };');
  await sleep(3000);
  const after = await evalIn('return { t: ctx.time, f: ctx.frame };');
  const wall = (Date.now() - w0 - 0) / 1000;
  const simRate = (after.t - before.t) / wall;
  const stepMs = (after.t - before.t) / Math.max(1, after.f - before.f) * 1000;
  console.log(`clock check: ${simRate.toFixed(2)}x real time, ${stepMs.toFixed(2)}ms per simulated frame ` +
    `(want 16.67)`);
  if (Math.abs(stepMs - 16.67) > 1.0) {
    fails.push(`instrument: the fixed-step clock is delivering ${stepMs.toFixed(2)}ms frames, not 16.67 — ` +
      `every duration this harness reports is scaled by ${(stepMs / 16.67).toFixed(2)}x and cannot be trusted`);
  }
  if (simRate < 0.5) {
    notes.push(`the page is only simulating ${simRate.toFixed(2)}x real time; the run will be slow but valid`);
  }
}

// ===========================================================================
//  PHASE 1 — a full race, start to results
// ===========================================================================
console.log('\n[1] full race');
await evalIn('race.autoDrive = true; race.reset(); S.strict = true; return true;');

const sawCountdown = await until('countdown', 'race.state === 1', { sim: 6 });
if (!sawCountdown.ok) fails.push(`state machine: ${sawCountdown.reason}`);

const sawRacing = await until('racing', 'race.state === 2', { sim: 20 });
if (!sawRacing.ok) fails.push(`state machine: ${sawRacing.reason}`);
else console.log(`  lights out after ${sawRacing.sim.toFixed(2)}s of countdown`);

// --- pause / resume, mid-race ----------------------------------------------
// This is the bug class that shipped: the pause SCREEN cleared its own flag and
// the director stayed paused for good. Assert on the director's clock, not on
// the menu's opinion of itself.
await advance(12);
const pauseCheck = await (async () => {
  const before = await evalIn('race.setPaused(true); return { state: race.state, raceTime: race.raceTime, time: ctx.time };');
  await advance(2);
  const during = await evalIn('return { state: race.state, raceTime: race.raceTime, time: ctx.time };');
  await evalIn('race.setPaused(false); return true;');
  const resumed = await until('resume', 'race.state === 2', { sim: 3 });
  await advance(2);
  const after = await evalIn('return { state: race.state, raceTime: race.raceTime };');
  return { before, during, resumed, after };
})();
{
  const p = pauseCheck;
  const froze = Math.abs(p.during.raceTime - p.before.raceTime) < 0.05;
  const ranAgain = p.after.raceTime - p.during.raceTime > 1.0;
  console.log(`  pause: state ${RACE_STATE[p.before.state]} -> raceTime ` +
    `${p.before.raceTime.toFixed(2)} -> ${p.during.raceTime.toFixed(2)} (frozen: ${froze}) ` +
    `-> resumed ${RACE_STATE[p.after.state]} at ${p.after.raceTime.toFixed(2)}`);
  if (p.before.state !== 5) fails.push(`pause: setPaused(true) left the director in ${RACE_STATE[p.before.state]}, not Paused`);
  if (!froze) fails.push(`pause: the race clock kept running while paused (${p.before.raceTime.toFixed(2)} -> ${p.during.raceTime.toFixed(2)})`);
  if (!p.resumed.ok) fails.push(`pause: setPaused(false) did not resume racing — ${p.resumed.reason}. This is the deadlock that shipped.`);
  if (!ranAgain) fails.push(`pause: the race clock did not restart after resuming`);
}

// --- run it out -------------------------------------------------------------
const allHome = await until('all karts finish',
  'race.karts.every((k) => k.finished)', { sim: 420, wallMs: 300000 });
if (!allHome.ok) fails.push(`race: ${allHome.reason}`);

const reachedResults = await until('results', 'race.state === 4', { sim: 30 });
if (!reachedResults.ok) fails.push(`state machine: ${reachedResults.reason}`);

await evalIn('S.strict = false; return true;');

const race1 = await evalIn(`
  return {
    state: race.state,
    raceTime: +race.raceTime.toFixed(3),
    lapTimes: race.lapTimes.map((t) => +t.toFixed(3)),
    bestLap: Number.isFinite(race.bestLap) ? +race.bestLap.toFixed(3) : null,
    standings: race.standings.map((k) => ({ id: k.id, name: k.stats.name, place: k.place, lap: k.lap, finished: k.finished, dist: +k.raceDistance.toFixed(1) })),
    karts: race.karts.map((k) => ({ id: k.id, name: k.stats.name, lap: k.lap, place: k.place, finished: k.finished })),
    probe: {
      frames: S.frames,
      states: S.states,
      placeBadFrames: S.placeBadFrames,
      kart: S.kart,
      lap: S.lap,
      finish: S.finish,
      events: S.events,
      nonFinite: S.nonFinite,
      liveProjMax: S.liveProjMax,
      liveProj: S.liveProj,
    },
  };
`);

// ---------------------------------------------------------------------------
//  Phase 1 assertions
// ---------------------------------------------------------------------------
const P = race1.probe;

// -- classification ----------------------------------------------------------
{
  const unfinished = race1.karts.filter((k) => !k.finished);
  if (unfinished.length) {
    fails.push(`classification: ${unfinished.length} kart(s) never finished — ` +
      unfinished.map((k) => `${k.name} on lap ${k.lap}`).join(', '));
  }
  const places = race1.karts.map((k) => k.place).sort((a, b) => a - b);
  const wantPlaces = race1.karts.map((_, i) => i + 1);
  if (places.join(',') !== wantPlaces.join(',')) {
    fails.push(`classification: finishing places are not a permutation of 1..${race1.karts.length} — got [${places.join(',')}]`);
  }
  const fin = P.finish.slice().sort((a, b) => a.place - b.place);
  for (let i = 1; i < fin.length; i++) {
    if (fin[i].raceTime < fin[i - 1].raceTime - 0.001) {
      fails.push(`classification: ${race1.karts[fin[i].id].name} finished ${fin[i].place}${nth(fin[i].place)} ` +
        `at ${fin[i].raceTime.toFixed(2)}s, BEFORE the kart classified ahead of it ` +
        `(${fin[i - 1].raceTime.toFixed(2)}s) — the order and the clock disagree`);
    }
  }
  if (fin.length) {
    const winner = fin[0].raceTime;
    const lastHome = fin[fin.length - 1].raceTime;
    if (lastHome > winner * SPREAD_LIMIT) {
      fails.push(`classification: the last kart home took ${lastHome.toFixed(1)}s against the winner's ` +
        `${winner.toFixed(1)}s (${(lastHome / winner).toFixed(2)}x, limit ${SPREAD_LIMIT}) — somebody was lapped absurdly`);
    }
    console.log(`  winner ${race1.karts[fin[0].id].name} ${fmt(winner)}, last home ${fmt(lastHome)} ` +
      `(${(lastHome / winner).toFixed(2)}x)`);
  }
}

// -- lap times ---------------------------------------------------------------
{
  // Every kart's every lap, timed off the bus, independently of race.lapTimes.
  const perKart = new Map();
  for (const e of P.lap) {
    if (!perKart.has(e.id)) perKart.set(e.id, []);
    perKart.get(e.id).push(e.raceTime);
  }
  const all = [];
  for (const [id, stamps] of perKart) {
    let prev = 0;
    for (const s of stamps) { all.push({ id, t: s - prev }); prev = s; }
  }
  const bad = all.filter((l) => l.t < LAP_MIN || l.t > LAP_MAX);
  const times = all.map((l) => l.t).sort((a, b) => a - b);
  const median = times.length ? times[times.length >> 1] : NaN;
  console.log(`  ${all.length} laps timed: fastest ${fmt(times[0])}, median ${fmt(median)}, slowest ${fmt(times[times.length - 1])}`);
  if (bad.length) {
    fails.push(`lap times: ${bad.length} of ${all.length} laps fell outside the plausible band ` +
      `${LAP_MIN}-${LAP_MAX}s — e.g. ${race1.karts[bad[0].id].name} ${bad[0].t.toFixed(2)}s`);
  }
  if (all.length !== race1.karts.length * setup.laps) {
    fails.push(`lap accounting: expected ${race1.karts.length * setup.laps} lap events ` +
      `(${race1.karts.length} karts x ${setup.laps} laps), saw ${all.length}`);
  }

  // The two clocks, side by side. See the header.
  const mine = perKart.get(0) || [];
  const dir = race1.lapTimes;
  const mineSplits = mine.map((s, i) => s - (i ? mine[i - 1] : 0));
  const drift = dir.map((t, i) => Math.abs(t - (mineSplits[i] ?? NaN)));
  const worst = drift.length ? Math.max(...drift) : NaN;
  console.log(`  player laps: director [${dir.map((t) => t.toFixed(3)).join(', ')}]`);
  console.log(`               harness  [${mineSplits.map((t) => t.toFixed(3)).join(', ')}]  worst disagreement ${worst.toFixed(4)}s`);
  if (dir.length !== setup.laps) {
    fails.push(`lap accounting: race.lapTimes holds ${dir.length} entries for a ${setup.laps}-lap race`);
  }
  if (Number.isFinite(worst) && worst > 0.05) {
    fails.push(`instrument: the harness's lap clock and the director's disagree by ${worst.toFixed(3)}s — ` +
      `one of the two is wrong and neither number below can be trusted`);
  }
}

// -- per-frame accounting ----------------------------------------------------
if (P.placeBadFrames > 0) {
  fails.push(`position accounting: on ${P.placeBadFrames} of ${P.frames} frames the eight places were not ` +
    `a permutation of 1..8 (duplicates or gaps)`);
}
for (const k of P.kart) {
  if (k.lapDrops > 0) fails.push(`lap accounting: ${k.name}'s published lap counter went backwards ${k.lapDrops} time(s)`);
  if (k.stallMax > STALL_LIMIT) {
    fails.push(`stranded: ${k.name} sat motionless for ${k.stallMax.toFixed(1)}s mid-race (limit ${STALL_LIMIT}s)`);
  }
  if (k.revMax > REVERSE_LIMIT) {
    fails.push(`stuck reversing: ${k.name} travelled backwards for ${k.revMax.toFixed(1)}s continuously (limit ${REVERSE_LIMIT}s)`);
  }
  if (k.maxSpeed > 120) {
    fails.push(`physics: ${k.name} reached ${k.maxSpeed.toFixed(0)} m/s — nothing on this circuit should exceed ~45`);
  }
}
console.log(`  worst stall ${Math.max(...P.kart.map((k) => k.stallMax)).toFixed(1)}s, ` +
  `worst reverse ${Math.max(...P.kart.map((k) => k.revMax)).toFixed(1)}s, ` +
  `top speed ${Math.max(...P.kart.map((k) => k.maxSpeed)).toFixed(1)} m/s`);

if (P.nonFinite.length) {
  const n = P.nonFinite[0];
  fails.push(`non-finite state: ${n.name} at t=${n.time}s had pos=[${n.pos}] vel=[${n.vel}] ` +
    `quat=[${n.quat}] t=${n.t} raceDistance=${n.raceDistance}`);
}

// -- state machine -----------------------------------------------------------
{
  const seq = P.states.map((s) => s.state);
  const names = P.states.map((s) => `${RACE_STATE[s.state]}@${s.time}`);
  console.log(`  states: ${names.join(' -> ')}`);
  for (const want of [1, 2, 3, 4]) {
    if (!seq.includes(want)) fails.push(`state machine: never entered ${RACE_STATE[want]}`);
  }
  if (!seq.includes(5)) fails.push('state machine: the pause state was never observed');
  const iRacing = seq.indexOf(2);
  const iFinished = seq.indexOf(3);
  const iResults = seq.indexOf(4);
  if (iFinished > -1 && iResults > -1 && iResults < iFinished) {
    fails.push('state machine: Results was entered before Finished');
  }
  if (iRacing > -1 && iFinished > -1 && iFinished < iRacing) {
    fails.push('state machine: Finished was entered before Racing');
  }
}

// ===========================================================================
//  PHASE 2 — restart
// ===========================================================================
console.log('\n[2] restart from the results screen');
await evalIn('race.reset(); return true;');
const restartCountdown = await until('restart countdown', 'race.state === 1', { sim: 5 });
if (!restartCountdown.ok) fails.push(`restart: ${restartCountdown.reason}`);
const restartRacing = await until('restart racing', 'race.state === 2', { sim: 20 });
if (!restartRacing.ok) fails.push(`restart: ${restartRacing.reason}`);
const restartState = await evalIn(`
  return {
    raceTime: +race.raceTime.toFixed(2),
    lapTimes: race.lapTimes.length,
    laps: race.karts.map((k) => k.lap),
    finished: race.karts.filter((k) => k.finished).length,
    onGrid: race.karts.every((k) => k.raceDistance < 400),
  };
`);
if (restartState.lapTimes !== 0) fails.push(`restart: race.lapTimes still holds ${restartState.lapTimes} entries from the previous race`);
if (restartState.finished !== 0) fails.push(`restart: ${restartState.finished} kart(s) are still flagged finished`);
if (restartState.laps.some((l) => l !== 0)) fails.push(`restart: lap counters were not cleared — [${restartState.laps.join(',')}]`);
if (!restartState.onGrid) fails.push('restart: the field was not returned to the grid (raceDistance did not reset)');
// A restart that reaches Racing but never completes a lap is a subtler deadlock.
const restartLap = await until('restart first lap', 'race.karts.some((k) => k.lap >= 1)', { sim: 150 });
if (!restartLap.ok) fails.push(`restart: ${restartLap.reason} — the restarted race never completed a lap`);
else console.log(`  restarted cleanly; first lap completed after ${restartLap.sim.toFixed(1)}s`);

// ===========================================================================
//  PHASE 3 — checkpoints cannot be cheated
// ===========================================================================
// From a fresh grid: teleport the player half a lap forward without crossing
// anything, then drive it back round to the start line. Progress is validated,
// not measured — the checkpoint anchor must refuse to move, the credited
// distance must stay capped, and the line crossing must NOT award a lap.
//
// The reset matters. Doing this mid-race is ambiguous: a kart already at
// checkpoint N-1 that jumps back to mid-lap and drives forward has, between the
// two, covered every metre of the circuit, so awarding it the lap is arguably
// correct and the test would be measuring nothing. From the grid there is no
// such reading — the player has covered half a lap of geometry and no more.
console.log('\n[3] shortcut resistance');
await evalIn('race.reset(); return true;');
{
  const r = await until('racing for the cut test', 'race.state === 2', { sim: 20 });
  if (!r.ok) fails.push(`shortcut: ${r.reason}`);
}
await advance(3);

const cut = await (async () => {
  const before = await evalIn(`
    const k = race.player;
    return { t: k.t, lap: k.lap, dist: +k.raceDistance.toFixed(1), place: k.place };
  `);
  const jumped = await evalIn(`
    const k = race.player;
    const target = (k.t + 0.5) % 1;
    const s = ctx.track.sample(target);
    k.placeAt(s.pos.clone().addScaledVector(s.normal, 0.7), Math.atan2(s.tangent.x, s.tangent.z), target);
    return { t: k.t };
  `);
  // One frame is enough for updateProgress to run; give it a few.
  await advance(0.5);
  const afterJump = await evalIn(`
    const k = race.player;
    return { t: k.t, lap: k.lap, dist: +k.raceDistance.toFixed(1) };
  `);
  // Now drive on until the player reaches the start line it never earned.
  const wrapped = await until('line crossing after the cut',
    'race.player.t < 0.06', { sim: 120 });
  await advance(1.5);
  const afterLine = await evalIn(`
    const k = race.player;
    return { t: k.t, lap: k.lap, dist: +k.raceDistance.toFixed(1) };
  `);
  return { before, jumped, afterJump, wrapped, afterLine };
})();
{
  const credited = cut.afterJump.dist - cut.before.dist;
  console.log(`  teleported t ${cut.before.t.toFixed(3)} -> ${cut.jumped.t.toFixed(3)} ` +
    `(${(setup.trackLength * 0.5).toFixed(0)} m of geometry skipped)`);
  console.log(`  credited distance: ${credited.toFixed(1)} m (cap ${CUT_CREDIT_LIMIT} m); ` +
    `lap ${cut.before.lap} -> ${cut.afterLine.lap} after driving back round to the line`);
  if (credited > CUT_CREDIT_LIMIT) {
    fails.push(`shortcut: skipping ${(setup.trackLength * 0.5).toFixed(0)} m of track credited ` +
      `${credited.toFixed(0)} m of race distance — checkpoints are not holding`);
  }
  if (!cut.wrapped.ok) {
    notes.push(`shortcut: the player did not reach the start line again within 120 sim s ` +
      `(${cut.wrapped.reason}); the credited-distance cap above still held, the lap check did not run`);
  } else if (cut.afterLine.lap > cut.before.lap) {
    fails.push(`shortcut: crossing the start line after skipping half the circuit awarded a lap ` +
      `(${cut.before.lap} -> ${cut.afterLine.lap}) — the checkpoint gate can be cut`);
  }
}

// ===========================================================================
//  PHASE 4 — every item fires, connects, expires and cleans up
// ===========================================================================
// The field keeps racing, but the item ROULETTE is switched off and every slot
// emptied first. Otherwise an AI's own green shell is indistinguishable from
// the one under test, and "the pool still holds a live shell" would be a
// coin flip rather than a leak.
console.log('\n[4] items');
await evalIn('race.reset(); return true;');
{
  const r = await until('racing for items', 'race.state === 2', { sim: 20 });
  if (!r.ok) fails.push(`items: ${r.reason}`);
}
await advance(4);
// Empty every slot, switch the roulette off, and take the trigger away from the
// AI driving the player.
//
// That last one is not optional. The player is on `autoDrive`, and the AI spends
// an item the moment it likes the look of the road — so the harness's own
// `use()` call kept arriving at an empty slot and returning false while the
// effect it was looking for had already happened a second earlier. Six of eight
// items "never fired" and all six had in fact fired. The real `Items.use` is
// still the thing under test; it is only gated so that the harness is the one
// pulling the trigger.
await evalIn(`
  ctx.items.reset();
  ctx.items.roll = () => 0;
  const realUse = ctx.items.use.bind(ctx.items);
  window.__allowUse = false;
  ctx.items.use = (k, backwards) =>
    (window.__allowUse || k !== race.player) ? realUse(k, backwards) : false;
  return true;
`);
await advance(1);

const ITEM_KINDS = [1, 2, 3, 4, 5, 6, 7, 8];

for (const kind of ITEM_KINDS) {
  const r = await testItem(kind);
  const line = `  ${ITEM_NAME[kind].padEnd(15)} fire=${r.fired ? 'y' : 'N'}  ` +
    `effect=${r.effect ? 'y' : 'N'}  hit=${r.hit ? 'y' : 'N'}  ` +
    `liveFrames=${r.spawned}  cleaned=${r.cleaned ? 'y' : 'N'}  ` +
    `contact=${r.contact}` + (r.note ? `   ${r.note}` : '');
  console.log(line);
  if (!r.fired) fails.push(`items: ${ITEM_NAME[kind]} — Items.use() returned false; the item never fired`);
  if (!r.effect) fails.push(`items: ${ITEM_NAME[kind]} — fired but produced no observable effect (${r.expected})`);
  if (r.needsHit && !r.hit) fails.push(`items: ${ITEM_NAME[kind]} — fired but never connected with anything`);
  // A recorded hit of this kind is itself proof a projectile existed, so it
  // satisfies the allocation check on its own. The frame counter can legitimately
  // read zero: the player is teleported into a bunched field and a red shell that
  // connects 1.4 m from the muzzle can be born and dead inside one frame.
  if (r.spawnsProjectile && r.spawned === 0 && !r.hit) {
    fails.push(`items: ${ITEM_NAME[kind]} — no projectile was ever allocated from the pool, and nothing was hit`);
  }
  if (!r.cleaned) fails.push(`items: ${ITEM_NAME[kind]} — the projectile pool never returned to its baseline; ` +
    `${r.liveAtEnd} slot(s) still live after ${r.waited.toFixed(0)}s. This is a leak.`);
}

/**
 * One item, end to end.
 *
 * The kinds do genuinely different things, so the expectation is per-kind
 * rather than one blanket assertion. Where a hit has to be forced it is forced
 * physically — by putting a kart where the projectile is going — not by
 * calling the strike path directly, because the point is to prove the contact
 * test works, not that `spinOut` works.
 */
async function testItem(kind) {
  const name = ITEM_NAME[kind];
  const spawnsProjectile = kind === 3 || kind === 4 || kind === 5 || kind === 8;
  const needsHit = kind === 3 || kind === 4 || kind === 5 || kind === 7 || kind === 8;

  // Baseline pool occupancy — other karts are racing and firing their own.
  const base = await evalIn(`return { live: S.liveProj, hits: S.hits.length, uses: S.itemUse.length, time: ctx.time, projFrames: S.projFrames[${kind}] };`);

  // Give it, wait out ARM_TIME (1.05s), then set the geometry up and fire.
  await evalIn(`ctx.items.give(race.player, ${kind}, ${kind === 2 ? 3 : 1}); return true;`);
  await advance(1.3);

  // Tuck the player in behind the kart it is chasing so a forward-fired shell
  // has something to hit, and match its speed — `placeAt` zeroes the velocity,
  // and a shell inherits 0.35 of its thrower's, so firing from a standstill
  // costs the shell ~9 m/s of closing speed against a rival doing 25.
  let victimId = -1;
  if (kind === 3 || kind === 4 || kind === 8) {
    victimId = await evalIn(`
      const me = race.player;
      const idx = race.standings.indexOf(me);
      let v = null;
      for (let i = idx - 1; i >= 0; i--) if (!race.standings[i].finished) { v = race.standings[i]; break; }
      if (!v) for (let i = idx + 1; i < race.standings.length; i++) if (!race.standings[i].finished) { v = race.standings[i]; break; }
      if (!v) return -1;
      const back = v.forward.clone().multiplyScalar(${kind === 8 ? -9 : -14});
      me.placeAt(v.position.clone().add(back), Math.atan2(v.forward.x, v.forward.z), v.t);
      me.velocity.copy(v.velocity);
      return v.id;
    `);
  }

  const before = await evalIn(`
    const k = race.player;
    return { boost: k.boostTime, star: k.starTime, stuns: race.karts.map((x) => x.stunTime) };
  `);
  // The trigger is handed back for exactly one call, so the AI cannot spend the
  // item first (see the gate installed above this loop).
  const fired = await evalIn(
    `window.__allowUse = true; const r = ctx.items.use(race.player, false); window.__allowUse = false; return r;`,
  );

  // Watch what happened.
  let spawned = 0;
  let effect = false;
  let hit = false;
  let note = '';

  if (kind === 1 || kind === 2) {
    // A mushroom is its own effect: the boost has to actually appear.
    const after = await evalIn('return race.player.boostTime;');
    effect = after > before.boost + 0.5;
    note = `boostTime ${before.boost.toFixed(2)} -> ${after.toFixed(2)}`;
  } else if (kind === 6) {
    const after = await evalIn('return { star: race.player.starTime, boost: race.player.boostTime };');
    effect = after.star > before.star + 1;
    note = `starTime ${before.star.toFixed(2)} -> ${after.star.toFixed(2)}`;
  } else if (kind === 7) {
    // The bolt has no projectile — it is instantaneous and hits everybody.
    const after = await evalIn(`
      return {
        stunned: race.karts.filter((k) => k.stunTime > 0 && !k.isPlayer).length,
        hits: S.hits.filter((h) => h.time > ${base.time} && h.kind === 7).length,
      };
    `);
    effect = after.stunned > 0;
    hit = after.hits > 0;
    note = `${after.stunned} rivals squashed, ${after.hits} hit events`;
  }

  // --- connect --------------------------------------------------------------
  // First the natural way: the projectile is left alone to find its own target.
  // That is the interesting case — a shell that sinks into the bay on frame
  // three would sail through any test that put a kart under it by hand — so it
  // gets first refusal, and whether it connected on its own is reported.
  const hitExpr = `S.hits.filter((h) => h.time > ${base.time} && h.kind === ${kind}).length > 0`;
  const liveExpr = `ctx.items.proj.pool.filter((p) => p.state !== 0 && p.kind === ${kind}).length`;
  let contact = 'n/a';
  if (needsHit && kind !== 7) {
    // How long the projectile is given to find its own target before the
    // geometry is forced. Per-kind, because a bomb's whole existence is shorter
    // than a shell's patience: it is a 0.9 s ballistic arc that detonates on
    // landing, so a 3 s natural window means the forced fallback arrives to find
    // "gone" every time — which is exactly what it reported.
    const naturalWindow = { 3: 5.5, 4: 5.5, 5: 4.0, 8: 0.5 }[kind] ?? 4.0;
    const natural = await until(`${name} natural hit`, hitExpr, { sim: naturalWindow });
    if (natural.ok) {
      hit = true;
      contact = `natural after ${natural.sim.toFixed(1)}s`;
    } else {
      // It missed, or its owner lock outlived it. Put a rival where it is and
      // prove the CONTACT path — deliberately a rival and not the player,
      // because owner immunity would make the player's own bomb a no-op and the
      // test would pass on a technicality.
      const forced = await evalIn(`
        const p = ctx.items.proj.pool.find((q) => q.state === 2 && q.kind === ${kind});
        if (!p) return 'gone';
        const v = race.karts.find((k) => !k.isPlayer && !k.finished && k.starTime <= 0 && k.stunTime <= 0);
        if (!v) return 'no victim';
        const s = ctx.track.probe(p.pos, v.t);
        v.placeAt(p.pos.clone().setY(s.y + 0.4), Math.atan2(v.forward.x, v.forward.z), s.t);
        return 'placed';
      `);
      const after = await until(`${name} forced hit`, hitExpr, { sim: 3 });
      hit = after.ok;
      contact = after.ok ? `forced (${forced})` : `MISSED (${forced})`;
    }
  }

  // Let it play out: shells have 9-12s of life, a bomb 2.7s, a banana 55s.
  // A banana that nobody drives over sits there for the best part of a minute
  // by design, so a live one is only a leak once it has been hit.
  const waited = 20;
  const settle = await until(`${name} cleanup`, `${liveExpr} === 0`, { sim: waited });

  const end = await evalIn(`
    return {
      live: S.liveProj,
      liveOfKind: ctx.items.proj ? ctx.items.proj.pool.filter((p) => p.state !== 0 && p.kind === ${kind}).length : -1,
      hits: S.hits.filter((h) => h.time > ${base.time} && h.kind === ${kind}).length,
      uses: S.itemUse.filter((u) => u.time > ${base.time} && u.kind === ${kind}).length,
      projFrames: S.projFrames[${kind}],
    };
  `);
  if (spawnsProjectile) {
    // Frames this kind spent live since the item was handed over — a count, not
    // a snapshot, so a projectile that lived for a third of a second still
    // registers.
    spawned = end.projFrames - base.projFrames;
    effect = effect || spawned > 0;
  }
  if (!hit) hit = end.hits > 0;
  const cleaned = end.liveOfKind === 0;
  // `effect` for a projectile kind is "a slot left the pool"; the item-use event
  // is a weaker corroboration and is only consulted when the direct read missed
  // the one frame the projectile existed for.
  if (!effect && end.uses > 0) effect = true;

  return {
    kind, name, fired: !!fired, effect, hit, spawned, spawnsProjectile, needsHit,
    cleaned, liveAtEnd: end.liveOfKind, waited: settle.ok ? settle.sim : waited,
    contact: victimId >= 0 ? `${contact} vs kart ${victimId}` : contact,
    note: note || (end.hits ? `${end.hits} hit event(s)` : ''),
    expected: kind === 1 || kind === 2 ? 'a boost' : kind === 6 ? 'star time' : kind === 7 ? 'squashed rivals' : 'a projectile in the pool',
  };
}

// -- pool must drain ---------------------------------------------------------
{
  await advance(6);
  const drained = await evalIn('ctx.items.reset(); return true;');
  await advance(0.5);
  const post = await evalIn('return { live: S.liveProj, max: S.liveProjMax };');
  console.log(`  pool: peak ${post.max} live projectiles, ${post.live} after items.reset()`);
  if (post.live !== 0) {
    fails.push(`items: ${post.live} projectile(s) survived Items.reset() — the pool is leaking across races`);
  }
  if (post.max > 16) {
    fails.push(`items: ${post.max} projectiles were live at once against a pool of 16 — the pool overflowed`);
  }
  void drained;
}

// ===========================================================================
//  Report
// ===========================================================================
const finalProbe = await evalIn(`
  return {
    frames: S.frames,
    events: S.events,
    nonFinite: S.nonFinite.length,
    nonFiniteFirst: S.nonFinite[0] || null,
  };
`);

if (finalProbe.nonFinite > 0 && !P.nonFinite.length) {
  const n = finalProbe.nonFiniteFirst;
  fails.push(`non-finite state after the race: ${n.name} at t=${n.time}s pos=[${n.pos}] vel=[${n.vel}] quat=[${n.quat}]`);
}

console.log('\n--- autoplay ---');
console.log(`simulated frames  : ${finalProbe.frames}`);
console.log(`wall clock        : ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`events seen       : ${Object.entries(finalProbe.events).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`console errors    : ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 10)) console.log('   - ' + e.slice(0, 240));

if (consoleErrors.length) fails.push(`${consoleErrors.length} console error(s) during the run — first: ${consoleErrors[0].slice(0, 160)}`);
if (crashed) fails.push('THE PAGE CRASHED');
if (navigations > navAtBoot) {
  fails.push(`the page navigated ${navigations - navAtBoot} time(s) AFTER booting. Everything above was ` +
    `measured across a reload and none of it means anything. The usual cause is a source file changing ` +
    `under a running dev server; re-run when the tree is still.`);
}

for (const n of notes) console.log(`note: ${n}`);

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails) console.log('  - ' + f);
} else {
  console.log('\nPASS — a full race completed cleanly and every assertion held');
}

await browser.close();
srv.stop();
process.exit(fails.length ? 1 : 0);

// ---------------------------------------------------------------------------
function fmt(s) {
  if (!Number.isFinite(s)) return '--';
  const m = Math.floor(s / 60);
  return m ? `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`;
}
function nth(n) {
  return n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
}
