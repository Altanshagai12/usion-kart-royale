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
  { name: 'grid',        t: 0.995, speed: 0, settle: 1.1,  desc: 'Full grid at the start line during countdown' },
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
/**
 * How long to wait for a kart to drive onto its mark before giving up, seconds.
 *
 * A mark arrives once per lap, so this only has to cover a lap — but "a lap"
 * is not the lap time on the timing screen. The AI's pace through the slow,
 * congested sections runs as low as 10 m/s, and a kart that has been shuffled
 * off the racing line by the field placed behind it can take upwards of sixty
 * seconds to get round. Thirty covered a clean lap and nothing else, which
 * meant a single bad approach failed the shot outright rather than costing it
 * one more lap. This is a ceiling, not a cost: every shot that lands on its
 * mark first time (all of them, now that arrival is detected by crossing)
 * spends about five seconds here regardless.
 */
const APPROACH_TIMEOUT = 75;
/**
 * The drift shot gets its own, longer budget. It is not waiting on an approach
 * — a mark arrives once per lap and thirty seconds always covers one — it is
 * waiting on a *state*, and the only two corners on this circuit long enough to
 * charge a tier 2 come round once a lap between them. Thirty seconds bought
 * three attempts, and a slide that ends up off the road is correctly refused,
 * so the hunt could fail with the mechanism working perfectly.
 */
const DRIFT_TIMEOUT = 120;
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

/**
 * A capture is a screenshot plus a check that the screenshot is whole.
 *
 * `Page.captureScreenshot` reads the compositor's copy of the canvas, and on
 * SwiftShader that copy is not always a complete frame: roughly one capture in
 * five comes back as a vertical split, with the left band holding the previous
 * frame and everything right of the seam holding a scene buffer that was never
 * drawn into — grain, vignette and speed lines composited over black. It is not
 * a rendering bug (the same tear shows up on the pre-round tree, and the frame
 * is fine again the moment you re-shoot it), but the harness used to write it to
 * disk regardless and exit clean, which is the worst possible outcome: the
 * report says ten shots and one of them is a black rectangle.
 *
 * What separates the two cases is simply how much of the frame is unwritten.
 * Measured over 24 rapid captures plus both rounds of the shot set: every intact
 * frame sits between 0.0% and 1.4% of pixels below `DARK_LEVEL` (the 1.4% is
 * `closeup`, which is mostly kart in shadow), and every torn one between 11.5%
 * and 28.7%. An eight-fold gap with nothing in it is a threshold worth trusting,
 * so `TORN_DARK_FRAC` sits in the middle of the gap.
 *
 * A seam-detecting version of this was tried first — vertical bands, looking for
 * a step between neighbours — and caught two tears in five. The dark side of the
 * seam is not actually black (grain, vignette and speed lines lift it to ~20),
 * and when the tear takes most of the frame there is no bright band left to step
 * against. The plain area test caught all of them and false-positived on none of
 * the twenty known-good frames, so the seam test is gone rather than kept as a
 * second opinion that only ever weakens the first.
 *
 * If the art direction ever goes genuinely night-dark this threshold has to move
 * — that is what the recorded `darkFrac` in the report is for.
 */
const CAPTURE_ATTEMPTS = 12;
/** Fraction of the frame below `DARK_LEVEL` that marks a capture as torn. */
const TORN_DARK_FRAC = 0.05;
/** Brightness (0-255 mean of RGB) at or below which a pixel reads as unwritten. */
const DARK_LEVEL = 8;

/**
 * Decoding happens in the page because Node has no PNG decoder here. Note the
 * `Buffer.from` on the way in: puppeteer hands back a plain Uint8Array, and
 * `Uint8Array.prototype.toString` ignores its argument and returns
 * "137,80,78,71,...", which decodes to nothing and throws inside the page.
 */
async function measure(page, buf) {
  return page.evaluate(async (b64, darkLevel) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;

    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i] + d[i + 1] + d[i + 2]) / 3 <= darkLevel) dark++;
    }
    return { darkFrac: dark / (c.width * c.height) };
  }, Buffer.from(buf).toString('base64'), DARK_LEVEL);
}

async function capture(page, file) {
  let best = null;
  // Hold the simulation still for the whole retry loop. Without this a retry
  // re-fires the shutter while the sim runs on, so the kart has driven to a
  // different part of the circuit — three frames in one run were captured at
  // walking pace, or in the wrong section entirely, and read as rendering bugs.
  await page.evaluate(() => { window.__freeze = true; });
  try {
    return await captureAttempts(page, file);
  } finally {
    await page.evaluate(() => { window.__freeze = false; });
  }
}

async function captureAttempts(page, file) {
  let best = null;
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    const buf = await page.screenshot({ type: 'png' });
    const m = await measure(page, buf);
    const torn = m.darkFrac > TORN_DARK_FRAC;
    if (!best || m.darkFrac < best.darkFrac) best = { ...m, buf, attempts: attempt };
    if (!torn) {
      writeFileSync(file, buf);
      return { ...m, torn: false, attempts: attempt };
    }
    // Let the compositor produce a fresh frame before trying again — and make
    // sure it is genuinely fresh.
    //
    // Two frozen rAFs were not enough on their own: `corner` and `boost` each
    // came back torn after all six attempts in consecutive runs, the same
    // horizontal seam at the same place every time, which is not what an
    // independent one-in-five artefact looks like. Measured directly, a frozen
    // page tears far *less* than a running one (10 clean captures out of 10
    // frozen, against 2 torn out of 10 running), so the freeze is not the
    // cause — but it does mean every retry is compositing an identical scene,
    // and a wedged surface has no reason to resolve itself.
    //
    // Letting one real frame through between attempts gives the compositor new
    // content to push. It costs a single frame of simulation, about a metre of
    // road, which is inside the tolerance the mark is held to anyway — as
    // against the whole point of the freeze, which was to stop retries walking
    // the kart seconds down the circuit.
    await page.evaluate(() => new Promise((r) => {
      window.__freeze = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__freeze = true;
        requestAnimationFrame(r);
      }));
    }));
    await new Promise((r) => setTimeout(r, 150));
  }
  writeFileSync(file, best.buf);
  return { ...best, torn: true, attempts: CAPTURE_ATTEMPTS };
}

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

      /**
       * Is this kart actually on the circuit, with its wheels on it?
       *
       * Shared deliberately: the drift override uses it to decide a slide is
       * worth holding, and the accept gate uses it to decide a slide is worth
       * photographing. When those two disagreed, the override kept a slide
       * alive that the gate would never accept.
       *
       * The contact count is not belt-and-braces, it is the whole test.
       * `Suspension.update` assigns `dominantSurface = Surface.Road` as its
       * per-frame default and only overwrites it from a wheel that is actually
       * touching something, so a kart with no wheels on the ground reports
       * Road — the surface meaning "on the circuit". An airborne kart is
       * therefore indistinguishable from one on the racing line if you ask
       * `dominantSurface` alone, and this stretch of the circuit runs along a
       * seafront: a slide that ran wide there launched off the edge, reported
       * Road all the way out, kept its drift held and its tier-2 charge, and
       * was accepted. The shot came back as a kart flying over open sea with
       * the island skyline behind it and no road anywhere in frame — a frame
       * the report described as a tier-2 slide on the circuit.
       */
      window.__onCircuit = (k) => {
        const sus = k.suspension;
        if (!sus || !(sus.contacts > 0)) return false;
        const surf = sus.dominantSurface;
        return surf === 0 /* Road */ || surf === 4 /* Boost */;
      };

      /**
       * Signed distance from the centreline, in units of the road's half-width.
       * 0 is the middle, ±1 the road edge, ±1.3 out on the kerbs.
       */
      const _laneSmp = track.sample(0);
      window.__laneOffset = (k) => {
        track.sample(k.t, _laneSmp);
        const c =
          (k.position.x - _laneSmp.pos.x) * _laneSmp.binormal.x +
          (k.position.y - _laneSmp.pos.y) * _laneSmp.binormal.y +
          (k.position.z - _laneSmp.pos.z) * _laneSmp.binormal.z;
        return c / Math.max(1, _laneSmp.halfWidth);
      };

      // A drift cannot be set from out here: `updateDriftState` releases any
      // slide whose button is no longer held, and releasing a charged one fires
      // the mini-turbo — which is why writing `driftDir` produced a boost flame
      // and a kart travelling perfectly straight. The button is the only handle.
      //
      // But the button is all that should be touched, and only on the release
      // side. The AI already drifts every corner worth a mini-turbo, and its
      // entry is the part that is hard to fake: engaging needs a live hop
      // (0.45 s) landing on a genuinely loaded rack, which `updateDrift` sets
      // up by deliberately over-steering into the corner for half a second.
      // Driving the button on a blind pulse instead *overrode* that decision —
      // it stamped on the AI's entries at the corners and engaged slides out on
      // the straights, where a drift's built-in yaw bias (0.55 of lock toward
      // driftDir, with no corner to spend it on) simply drives the kart in a
      // circle. That is the frame it produced: a kart scribing loops on the
      // approach road, sideways in the corner of shot, tier stuck at 1.
      //
      // What the AI cannot do is hold one long enough. Tier 2 needs 2.0 s of
      // charge and the AI bails at ~1.3 s — not because the corner ends (the
      // two long ones here run 239 m and 191 m, ten seconds of road) but
      // because it runs wide and its own `wide` guard pulls the plug. It runs
      // wide because a slide halves its steering authority and offsets it by
      // 0.55 toward driftDir, and its PD gains are not tuned for that. So every
      // unaided slide on this circuit tops out at tier 1.
      //
      // Holding the button alone does not fix it — that was the first attempt,
      // and without the lock to hold the arc the kart just ran wider until it
      // was scribing circles on the exit road, backwards. What is missing is
      // the thing a player supplies and the AI does not: lock held into the
      // corner for the length of the slide. Bias its steer inward while the
      // charge builds and the kart holds the angle through the corner it is
      // already in. Hand it straight back at tier 2 — that is the frame, and
      // past it the corner runs out.
      //
      // The lock alone still put one slide in three into the scenery, charged
      // to tier 2 thirty-seven metres off the road, so the road gets a vote —
      // but only once the kart is genuinely leaving it. The correction is
      // deadbanded at the road edge deliberately: a lap of normal AI driving
      // sits a median 0.5 half-widths off the centreline and touches 1.3 on the
      // kerbs, because that is where the racing line *is*, and a term that
      // pulled from zero would just drag the kart off the apex and undo the
      // lock it is there to support. Note the sign — `Race.drive` hands the
      // override an *already negated* steer (the AI solves in the yaw frame,
      // the drive input is screen-right), so closing a +binormal offset here is
      // a negative steer, the opposite of the AI's own cross-track term.
      if (s.drift) {
        const offset = () => window.__laneOffset(player);
        // How long a live slide may sit off the circuit before the override
        // gives up on it, ms. Long enough that clipping a kerb — which the
        // racing line does on purpose — is not treated as leaving the road.
        const OFF_ROAD_GRACE = 350;
        let offSince = 0;

        race.driveOverride = (cmd) => {
          if (player.driftDir === 0) { offSince = 0; return; }

          // Abandon a slide that has left the circuit, rather than holding it
          // there.
          //
          // "Never let go" was right about the mini-turbo and wrong about the
          // barrier. The override held the button unconditionally, so a slide
          // that ran wide into the outside wall kept drifting *against* the
          // wall: the hunt logged the kart pinned at u = -1.37 half-widths on
          // grass, charging to tier 3, for forty seconds at a stretch, while
          // the accept gate correctly refused every frame of it. The steering
          // correction cannot recover that — the kart is held by a collision,
          // and a slide halves its steering authority anyway — so the hunt just
          // burned its whole budget on one dead slide. That is how the shot
          // failed with "10 slides, best tier 3, 57 rejected off-road": ten
          // entries, and the good ones never came round because the bad ones
          // never ended.
          //
          // Letting go does cash the mini-turbo, which is the thing the comment
          // below rightly refuses to do — but only for a slide that was never
          // going to be the shot. The AI recovers to the racing line within a
          // second or two and re-enters at the next corner, which turns one
          // 40-second dead end into several fresh attempts. Measured over the
          // same hunt, tier-2 frames went from 196-of-305 rejected for surface
          // to the first tier-2 slide being accepted outright.
          const now = performance.now();
          if (window.__onCircuit(player)) offSince = 0;
          else if (!offSince) offSince = now;
          if (offSince && now - offSince > OFF_ROAD_GRACE) { cmd.drift = false; return; }

          // Never voluntarily let go of a slide that is still on the road.
          // Releasing is what cashes the mini-turbo, and handing the button back
          // the instant tier 2 landed did exactly that: the AI dropped it,
          // `releaseDrift` fired, and the shutter — a round-trip later — opened
          // on a boost flame behind a kart pointing dead straight. Hold it until
          // the frame is in the bag.
          cmd.drift = true;

          // Lock in only until the slide is as sideways as charging actually
          // rewards. `driftCharge` saturates at 0.39 rad of slip and the drift
          // model's own slip target tops out at 0.42, so past that the lock
          // buys no charge at all — it just keeps yawing the kart. Held flat at
          // 0.5 it reached 0.95 rad, which is not a drift but a spin, and the
          // chase rig composes for the modelled envelope: it follows the travel
          // heading, so a chassis half a radian off it goes to the edge of
          // frame and then out of it. That is the shot that came back as an
          // empty road with the kart behind the speedo.
          const beta = Math.abs(player.driftBeta || 0);
          const u = offset();

          // The lock is subordinate to the road, and fades out before the road
          // does.
          //
          // Held at full strength it does not merely risk running wide, it
          // *settles* wide: the lock (up to 0.5 of steer toward driftDir) and
          // the road-edge correction below (gain 1.5 on the overshoot past one
          // half-width) are opposed linear terms, so they balance, and they
          // balance at |u| = 1 + 0.5/1.5 = 1.33 half-widths — which is past the
          // kerb and onto the grass. That equilibrium is the whole of the drift
          // shot's flakiness: the hunt logged the kart pinned at u = -1.37 on
          // surface Grass for seconds at a stretch, charging happily to tier 3
          // while `onCircuit()` refused every frame of it. 196 of 305 tier-2
          // frames in one hunt were rejected for surface, all of them from that
          // one parked position. It is not a slide that ran wide and would come
          // back; it is a slide the override was actively holding off the road.
          //
          // Fading the lock out leaves the correction unopposed before the kerb
          // is reached, so the only stable place for the kart is on the road.
          //
          // It is tempting to pull the balance point further in — the kerb is
          // not the prettiest place to photograph a slide — but the drift is
          // not a free variable. Moving the fade to 0.6-1.0 and the correction's
          // deadband to 0.85 to centre the kart on the asphalt destabilised the
          // slide instead of relocating it: the correction now opposes the lock
          // over most of its range, the two fight, and the tyre model answers
          // with slip running to 0.93 rad — a spin, not a drift. Measured, that
          // version produced 44 tier-2 frames in a 120-second hunt against 305,
          // and one usable frame against eighty. The kerb is where a two-second
          // charge on this circuit ends up; the gate's job is to catch the ones
          // that are still on the road and framed, not to relocate the physics.
          const road = Math.max(0, Math.min(1, (1.3 - Math.abs(u)) / 0.4));
          // Past tier 2 the shot is banked and the lock would only start the
          // circles, so it goes to zero there regardless. The road correction
          // does NOT: dropping the whole override at tier 2 is what let a slide
          // that reached tier 2 already off-road stay there, with nothing
          // steering it back and the accept gate refusing it until the AI gave
          // up the slide entirely.
          const lock = player.driftTier >= 2
            ? 0
            : Math.max(0, Math.min(1, (0.38 - beta) / 0.15)) * 0.5 * road;

          const wide = Math.max(0, Math.abs(u) - 1) * Math.sign(u);
          cmd.steer = Math.max(-1, Math.min(1,
            cmd.steer + player.driftDir * lock - Math.max(-1, Math.min(1, wide)) * 1.5));
          cmd.throttle = 1;
          cmd.brake = 0;
        };
      } else {
        race.driveOverride = null;
      }

      if (s.boost) player.applyBoost(3, 1.2);
      ctx.speedIntensity = Math.min(1.2, s.speed / 30);

      race.state = s.name === 'grid' ? 1 /* Countdown */ : 2 /* Racing */;
      window.__camMode = s.cam || 'chase';
    }, { ...shot, settle: shot.settle ?? SETTLE, cruise: AI_CRUISE, hold_still: shot.name === "grid" }, hold);

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

      // A slide can charge to tier 2 with the kart in the scenery — one came
      // back parked on the grass bank among the spectators, sparking away — so
      // `drift` waits on the kart being on the circuit as well as on the tier.
      //
      // Ask the physics rather than measuring metres. Two hand-tuned distance
      // gates were tried first and both were wrong, in opposite directions: the
      // racing line legitimately runs wide over the kerbs, so a tight gate
      // refused good frames (sixty-nine in one hunt, and the shot failed with
      // the mechanism working perfectly), and a loose enough gate to admit
      // those also admitted four metres of grass. `dominantSurface` is what the
      // handling model itself uses to decide the kart has left the road, which
      // makes it the same question the frame is really asking.
      //   0 Road, 4 Boost = on the circuit; Dirt/Grass/Sand/OffTrack/Water are not.
      //
      // ...but ask it about a kart that is actually touching the ground, which
      // is why this shares `__onCircuit` with the drift override rather than
      // reading `dominantSurface` itself. See the note on that helper: the
      // surface field's per-frame default is Road, so an airborne kart answers
      // this question "yes" no matter where it is flying.
      const onCircuit = () => window.__onCircuit(k);

      // ...and on the kart being somewhere worth pointing a camera at. A slide
      // is a composition as much as a state: the rig deliberately throws the
      // kart toward the outside of frame while it is sideways, and on the wrong
      // half of the wrong corner that lands it in the bottom-right — which is
      // exactly where the speedo is, so the shot came back as an acre of empty
      // asphalt with the subject peeking out from behind the dial. The slide
      // that reads is the one where the kart is still in the frame's business,
      // so hold out for it: the hunt gets several corners, and the ones that
      // throw the kart the other way frame it properly.
      //
      // The original bounds (±0.5 in x, -0.72 in y) only kept the kart on
      // screen, and "on screen" is not the same as "in shot": they still admit
      // the subject wedged into a bottom corner, which is precisely the frame
      // that came back — the kart tucked into the bottom-left behind the
      // barrier and the MARINA sign, three quarters of the image an empty
      // street. Pulling them in to ±0.42 and -0.62 asks for a slide the rig has
      // actually composed, and there is no shortage to choose from: the same
      // hunt logged eighty-odd frames that were on the circuit and framed, so
      // the budget can afford to be choosy about which one it takes.
      //
      // ±0.42 / -0.62 was still not choosy enough. It bought a slide that was
      // on the road and inside the frame and *behind the scenery*: down at the
      // road edge in the town section, with the verge grass and the kerb
      // between the lens and the kart, which is the "camera inside geometry"
      // failure by another route. The subject of a hero shot belongs in the
      // middle third, so that is what this asks for now — the tighter the
      // window, the further the hunt walks to find a corner that delivers it,
      // and the budget is there to be spent.
      const framed = () => {
        const n = k.position.clone().project(ctx.camera);
        if (!(n.z < 1)) return false;                 // behind the camera
        if (Math.abs(n.x) > 0.3 || n.y < -0.5) return false;
        // the speedo's corner, in NDC
        return !(n.x > 0.3 && n.y < -0.45);
      };

      // Stop short by the distance the hold beat will cover, so the shutter
      // fires on the mark rather than just past it.
      const mark = ((s.t - (s.speed * hold) / len) % 1 + 1) % 1;
      const gap = (a, b) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);

      // Arrival is a *crossing*, not a proximity.
      //
      // This used to be `gap(k.t, mark) < 0.004` — a 6.4 m window on this
      // circuit, tested once per animation frame. That is a race between the
      // window and the frame time, and the frame time wins often enough to
      // matter: the capture runs at ~30 fps on SwiftShader, which is 1 m of
      // road per frame at racing pace and perfectly safe, but single frames of
      // 170-250 ms are routine in the scenery-dense sections, and at 28 m/s
      // such a frame steps 5-7 m — straight over the window without ever
      // landing in it. That is exactly how `scenery` failed while the kart drove
      // right through its mark: the shot then chased the mark for the rest of
      // the lap, timed out, and fired the shutter wherever the kart happened to
      // be. It came back a duplicate of `wide`, two shots of the same town
      // corner in a set of ten, and nothing in the report said so beyond one
      // warning line.
      //
      // Testing whether the mark lies in the arc travelled since the previous
      // frame cannot miss it however long the frame took, and it fires within
      // one frame of the mark rather than up to 6.4 m early. The proximity test
      // is kept only as an OR for the degenerate case: a kart barely moving, or
      // one that spawned already inside the window, produces no arc to cross.
      //
      // A crossing is *travel*, though, and travel is bounded by how fast a
      // kart can move in one frame. `k.t` is not continuous: it comes from
      // `Track.probe`, whose hinted ±45 m search falls back to a global nearest
      // station when the kart strays far enough from the hint, and a kart that
      // ends up in the bay gets re-stationed somewhere else on the circuit
      // entirely. Instrumenting the tunnel section caught one directly —
      // t 0.7869 -> 0.9688 in a single frame, speed 0, surface Water — and an
      // unbounded crossing test counts that 0.18-lap teleport as travel, so any
      // mark inside the jump "arrives". That is what produced a `corner` shot
      // reported on-mark at t=0.788: the kart drowned, its station snapped
      // forward across the mark, and the shutter fired on a drowned kart with
      // the camera under the water. Sixty metres is about twice what the
      // fastest boost lap covers in the longest frame observed, and six times
      // under the smallest snap.
      const MAX_ARC = 60 / len;
      let prevT = k.t;
      const crossedMark = () => {
        const arc = ((k.t - prevT) % 1 + 1) % 1;
        // 0 is stationary; anything past MAX_ARC is a discontinuity, not a
        // crossing — which covers the backwards wrap of a respawn rewinding
        // `t` to `lastGoodT` as well as a forward re-station.
        if (arc === 0 || arc > MAX_ARC) return false;
        return ((mark - prevT) % 1 + 1) % 1 <= arc;
      };

      // A failed hunt used to report only where it gave up, which says nothing
      // about why. Track what the kart actually managed so the warning can.
      const seen = { slides: 0, maxTier: 0, offRoadRejects: 0, markPassesOffRoad: 0 };
      let sliding = false;
      let closest = 1;

      // Every shot wants a kart that is on the circuit, not only the drift one.
      // A kart in the bay or halfway up a bank crosses its mark exactly like a
      // kart on the racing line, and the shutter cannot tell the difference.
      //
      // Held over a short window rather than tested instantaneously, because
      // the circuit has crests and kerbs and a kart is legitimately airborne
      // for a few frames at a time — refusing those would throw away a good
      // mark and cost a whole lap of waiting. Half a second is longer than any
      // crest here and far shorter than a trip into the water.
      let lastOnCircuit = performance.now();
      const recentlyOnCircuit = () => performance.now() - lastOnCircuit < 500;

      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
        if (onCircuit()) lastOnCircuit = performance.now();
        if (k.driftDir !== 0) {
          if (!sliding) { sliding = true; seen.slides++; }
          if (k.driftTier > seen.maxTier) seen.maxTier = k.driftTier;
        } else sliding = false;

        if (elapsed >= s.settle) {
          // `grid` must not move at all; the drift shot is waiting on a state
          // rather than a place. Everything else waits for the mark.
          if (s.hold_still) return done({ ok: true, why: 'stationary' });
          if (s.drift) {
            if (k.driftDir !== 0 && k.driftTier >= 2) {
              // Margin, not just "on the road right now".
              //
              // A tier-2 slide is by definition travelling sideways and losing
              // ground to the outside of the corner, so a slide accepted with
              // its wheels on the last inch of asphalt is off the road a
              // fraction of a second later — and a fraction of a second is
              // exactly what separates the gate from the shutter, two page
              // round-trips away. That is how a hunt that logged "tier-2 slide,
              // on circuit" produced a frame of a kart in the grass verge
              // behind the MARINA sign, and it is the same off-road frame the
              // whole gate exists to refuse, just arriving a few frames late.
              //
              // The freeze below is the real remedy — it removes the latency
              // instead of budgeting for it — so this stays generous. It has to:
              // a tier-2 slide on this circuit genuinely sits at |u| ~ 1.25,
              // out on the kerb, because that is where a slide that has charged
              // for two seconds ends up. Tightening this to 1.05 to "leave room"
              // refused every slide in a 120-second hunt: twelve entries, tier 3
              // reached, forty-four rejections, no shot. Past the kerb is a
              // different matter, and that is all this now excludes.
              const margin = Math.abs(window.__laneOffset(k)) < 1.35;
              if (onCircuit() && margin && framed()) {
                // Stop the world here rather than at the start of the capture.
                // Everything between this instant and the shutter is latency —
                // the gate's own resolve, the hold beat's round-trip, then the
                // capture's — and a slide keeps sliding through all of it.
                // `capture()` sets this again and clears it when it is done.
                window.__freeze = true;
                return done({ ok: true, why: 'tier-2 slide' });
              }
              seen.offRoadRejects++;
            }
          } else {
            const d = gap(k.t, mark);
            if (d < closest) closest = d;
            if (crossedMark() || d < 0.004) {
              // Let it come round again rather than photograph it where it is.
              if (recentlyOnCircuit()) return done({ ok: true, why: 'on mark' });
              seen.markPassesOffRoad++;
            }
          }
        }
        if (elapsed > timeout) {
          const detail = s.drift
            ? ` (${seen.slides} slides, best tier ${seen.maxTier}, ${seen.offRoadRejects} rejected off-road)`
            : ` (mark ${mark.toFixed(3)}, closest approach ${closest.toFixed(4)} lap` +
              `, ${seen.markPassesOffRoad} mark passes rejected off-road)`;
          return done({ ok: false, why: `gave up after ${timeout}s at t=${k.t.toFixed(3)}${detail}` });
        }
        prevT = k.t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), { ...shot, settle: shot.settle ?? SETTLE, hold_still: shot.name === "grid" }, hold,
       shot.drift ? DRIFT_TIMEOUT : APPROACH_TIMEOUT);

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
        else done({
          t: k.t, driftDir: k.driftDir, driftTier: k.driftTier, speed: k.forwardSpeed,
          // Slip angle at the shutter. The chase rig follows the travel
          // heading, so this is also how far off frame centre the chassis is
          // rotated — a drift frame that reads wrong reads wrong here first.
          //
          // Only meaningful while a slide is live: `driftBeta` is written by
          // the drift branch of the tyre model and keeps its last value
          // otherwise, so reading it unconditionally reported a quarter radian
          // of slip on shots of a kart travelling perfectly straight.
          beta: k.driftDir !== 0 ? k.driftBeta || 0 : null,
          // Where the subject is standing at the instant the shutter opens, not
          // at the instant the gate accepted it — there are a couple of
          // round-trips between the two, and a kart that leaves the road inside
          // them produces a frame no gate ever saw. Recorded rather than
          // enforced so it shows up in the report either way.
          onCircuit: window.__onCircuit(k),
        });
      };
      requestAnimationFrame(tick);
    }), { ...shot, hold_still: shot.name === "grid" }, hold);

    const file = join(OUT, `${shot.name}.png`);
    const shutter = await capture(page, file);
    if (shutter.torn) {
      warnings.push(
        `${shot.name}: capture still torn after ${shutter.attempts} attempts ` +
        `(${(shutter.darkFrac * 100).toFixed(1)}% of the frame unwritten)`,
      );
    }
    report.shots.push({
      name: shot.name,
      file,
      desc: shot.desc,
      captureAttempts: shutter.attempts,
      // Fraction of the written frame that came back unwritten. Near zero on a
      // good capture; this is the number to re-tune TORN_DARK_FRAC against.
      darkFrac: +shutter.darkFrac.toFixed(4),
      // Where the kart actually was when the shutter fired, so a shot that
      // drifts off its mark is visible in the report instead of only in the
      // critic's confusion.
      targetT: shot.drift ? null : shot.t,
      actualT: arrived ? +arrived.t.toFixed(4) : null,
      driftTier: arrived ? arrived.driftTier : null,
      slipRad: arrived && arrived.beta !== null ? +arrived.beta.toFixed(3) : null,
      speed: arrived ? +arrived.speed.toFixed(1) : null,
      onCircuit: arrived ? arrived.onCircuit : null,
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
  console.log(`fps(headless capture): ${report.fps}`);
  if (errors.length) {
    console.log(`\n!! ${errors.length} console/page errors:`);
    for (const e of errors.slice(0, 20)) console.log('  - ' + e.slice(0, 400));
    process.exitCode = 1;
  } else {
    console.log('no console errors');
  }

  // A shot that never reached its mark is not a shot of what it says it is —
  // the shutter fired wherever the kart had got to, which on this circuit means
  // a different corner, and twice now it has meant a silent duplicate of another
  // frame in the set. That used to be a warning inside report.json and an exit
  // code of zero, so a set with a wrong frame in it looked exactly like a clean
  // one from the outside. It fails the run now, for the same reason a page
  // error does: the critics would be judging a frame that is not the shot.
  const missed = report.shots.filter((s) => !s.reachedMark);
  if (missed.length) {
    console.log(`\n!! ${missed.length} shot(s) never reached their mark:`);
    for (const s of missed) {
      console.log(`  - ${s.name}: wanted t=${s.targetT ?? '(slide)'}, fired at t=${s.actualT}`);
    }
    process.exitCode = 1;
  }

  const torn = report.shots.filter((s) => s.darkFrac > TORN_DARK_FRAC);
  if (torn.length) {
    console.log(`\n!! ${torn.length} shot(s) still torn after retries: ` +
      torn.map((s) => s.name).join(', '));
    process.exitCode = 1;
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
