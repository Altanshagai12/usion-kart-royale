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
/** how long to wait for a kart to drive onto its mark before giving up, seconds */
const APPROACH_TIMEOUT = 30;
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
const CAPTURE_ATTEMPTS = 6;
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
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
    const buf = await page.screenshot({ type: 'png' });
    const m = await measure(page, buf);
    const torn = m.darkFrac > TORN_DARK_FRAC;
    if (!best || m.darkFrac < best.darkFrac) best = { ...m, buf, attempts: attempt };
    if (!torn) {
      writeFileSync(file, buf);
      return { ...m, torn: false, attempts: attempt };
    }
    // Let the compositor produce a fresh frame before trying again.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await new Promise((r) => setTimeout(r, 120));
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
        const smp = track.sample(0);
        // signed offset from the centreline, in units of the road's half-width
        const offset = () => {
          track.sample(player.t, smp);
          const c =
            (player.position.x - smp.pos.x) * smp.binormal.x +
            (player.position.y - smp.pos.y) * smp.binormal.y +
            (player.position.z - smp.pos.z) * smp.binormal.z;
          return c / Math.max(1, smp.halfWidth);
        };
        race.driveOverride = (cmd) => {
          if (player.driftDir === 0) return;
          // Never voluntarily let go. Releasing is what cashes the mini-turbo,
          // and handing the button back the instant tier 2 landed did exactly
          // that: the AI dropped it, `releaseDrift` fired, and the shutter — a
          // round-trip later — opened on a boost flame behind a kart pointing
          // dead straight. Hold it until the frame is in the bag.
          cmd.drift = true;
          // Steering it is only needed while the charge is building; past tier
          // 2 the shot is banked and the lock would just start the circles.
          if (player.driftTier >= 2) return;

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
          const lock = Math.max(0, Math.min(1, (0.38 - beta) / 0.15)) * 0.5;

          const u = offset();
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
      const onCircuit = () => {
        const s = k.suspension?.dominantSurface;
        return s === 0 || s === 4;
      };

      // ...and on the kart being somewhere worth pointing a camera at. A slide
      // is a composition as much as a state: the rig deliberately throws the
      // kart toward the outside of frame while it is sideways, and on the wrong
      // half of the wrong corner that lands it in the bottom-right — which is
      // exactly where the speedo is, so the shot came back as an acre of empty
      // asphalt with the subject peeking out from behind the dial. The slide
      // that reads is the one where the kart is still in the frame's business,
      // so hold out for it: the hunt gets several corners, and the ones that
      // throw the kart the other way frame it properly.
      const framed = () => {
        const n = k.position.clone().project(ctx.camera);
        if (!(n.z < 1)) return false;                 // behind the camera
        if (Math.abs(n.x) > 0.5 || n.y < -0.72) return false;
        // the speedo's corner, in NDC
        return !(n.x > 0.3 && n.y < -0.45);
      };

      // Stop short by the distance the hold beat will cover, so the shutter
      // fires on the mark rather than just past it.
      const mark = ((s.t - (s.speed * hold) / len) % 1 + 1) % 1;
      const gap = (a, b) => Math.abs(((a - b + 0.5) % 1 + 1) % 1 - 0.5);

      // A failed hunt used to report only where it gave up, which says nothing
      // about why. Track what the kart actually managed so the warning can.
      const seen = { slides: 0, maxTier: 0, offRoadRejects: 0 };
      let sliding = false;

      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
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
              if (onCircuit() && framed()) return done({ ok: true, why: 'tier-2 slide' });
              seen.offRoadRejects++;
            }
          } else if (gap(k.t, mark) < 0.004) {
            return done({ ok: true, why: 'on mark' });
          }
        }
        if (elapsed > timeout) {
          const detail = s.drift
            ? ` (${seen.slides} slides, best tier ${seen.maxTier}, ${seen.offRoadRejects} rejected off-road)`
            : '';
          return done({ ok: false, why: `gave up after ${timeout}s at t=${k.t.toFixed(3)}${detail}` });
        }
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
