/**
 * Desktop high-refresh motion regression.
 *
 * The direct multiplayer simulation advances at 60 Hz. A 144 Hz display must
 * still receive a fresh visual pose on every present; otherwise one frame in
 * six repeats and the next catches up, which reads as a kart bouncing over a
 * rough road. Mobile panels at 60 Hz hide that cadence because each present
 * normally contains one simulation tick.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = Number(process.env.DESKTOP_MOTION_PORT || 5331);
const server = await startVite(PORT);
let browser;

try {
  browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/`, {
    waitUntil: 'domcontentloaded', timeout: 90_000,
  });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120_000 });

  const result = await page.evaluate(async () => {
    const predictor = window.__multiplayer?.predictor;
    if (!predictor) throw new Error('Race predictor is not exposed');

    window.__ctx.race.autoDrive = true;
    window.__ctx.race.start();
    const cadence = await new Promise((resolve) => {
      const frames = [];
      let previous = performance.now();
      const started = previous;
      const tick = (now) => {
        frames.push(now - previous);
        previous = now;
        if (now - started < 4_000) requestAnimationFrame(tick);
        else {
          frames.sort((a, b) => a - b);
          resolve({
            median: frames[Math.floor(frames.length / 2)],
            p95: frames[Math.floor(frames.length * 0.95)],
            over24: frames.filter((ms) => ms > 24).length,
            frames: frames.length,
          });
        }
      };
      requestAnimationFrame(tick);
    });

    const initial = {
      slot: 0, user_id: 'desktop-motion', name: 'Desktop motion', connected: true,
      distance: 200, lateral: 0, speed: 20, heading: 0,
      yaw_rate: 0, rack: 0, rack_velocity: 0,
      drifting: false, drift_dir: 0, drift_charge: 0,
      boost_time: 0, stun_time: 0, star_time: 0, shrink_time: 0,
      item_slots: [], item_kind: 0, item_count: 0, item_arm: 0,
      lap: 1, place: 1, finished: false,
    };

    const sample = (hz) => {
      predictor.reset(initial);
      let now = 10_000;
      const distances = [];
      for (let frame = 0; frame < hz; frame++) {
        now += 1000 / hz;
        predictor.advance(now, { steer: 0, accel: 1, brake: 0, drift: false });
        distances.push(predictor.view().distance);
      }
      const deltas = distances.slice(1).map((value, i) => value - distances[i]);
      const steady = deltas.slice(Math.ceil(hz * 0.15));
      const repeated = steady.filter((delta) => delta <= 0.00001).length;
      const positive = steady.filter((delta) => delta > 0.00001);
      return {
        hz,
        repeated,
        samples: steady.length,
        min: Math.min(...positive),
        max: Math.max(...positive),
      };
    };

    const correction = (hz) => {
      predictor.reset(initial);
      const state = { ...predictor.core.state, finished: true };
      // A tiny deterministic stand-in for Usion Predictor's smoothing vault.
      // It makes the regression independent of whether the remote SDK loaded in
      // this local browser while still exercising RacePredictor.view(dt)'s rate.
      const core = {
        state,
        lastSeq: 0,
        error: 1,
        reset(next) { this.state = next; this.error = 1; },
        predict() { return this.state; },
        reconcile(next) { this.state = next; return next; },
        view(rate = 0.22) {
          this.error *= 1 - rate;
          return { ...this.state, distance: this.state.distance + this.error };
        },
      };
      predictor.core = core;
      predictor.initialized = true;
      predictor.accumulator = 0;
      const target = state.distance;
      const startError = Math.abs(predictor.view(0).distance - target);
      for (let frame = 0; frame < Math.round(hz * 0.2); frame++) {
        predictor.view(1 / hz);
      }
      const endError = Math.abs(predictor.view(0).distance - target);
      return endError / startError;
    };

    const trackNormals = (() => {
      const track = window.__ctx.track;
      let t = 0.18;
      let previous = null;
      let repeated = 0;
      let maxStepDeg = 0;
      for (let frame = 0; frame < 144; frame++) {
        const sample = track.sample(t);
        const normal = track.probe(sample.pos, t).normal.clone();
        if (previous) {
          const angle = Math.acos(Math.max(-1, Math.min(1, previous.dot(normal))));
          if (angle <= 1e-7) repeated++;
          maxStepDeg = Math.max(maxStepDeg, angle * 180 / Math.PI);
        }
        previous = normal;
        t += (30 / track.length) / 144;
      }
      return { repeated, maxStepDeg };
    })();

    const gl = window.__ctx.renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) || '')
      : String(gl.getParameter(gl.RENDERER) || '');

    const at60 = sample(60);
    const at144 = sample(144);
    const correction60 = correction(60);
    const correction144 = correction(144);

    return {
      quality: window.__ctx.settings.quality,
      rendererName,
      cadence,
      cadenceMs: window.__loopHealth().frameIntervalEma,
      trackNormals,
      correction60,
      correction144,
      at60,
      at144,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  const software = /SwiftShader|llvmpipe|Software|Microsoft Basic|Mesa OffScreen|ANGLE \(Software/i
    .test(result.rendererName);
  const lowEndRx = /Radeon RX\s*640(?:\D|$)/i.test(result.rendererName);
  if ((software || lowEndRx) && result.quality !== 0) {
    throw new Error(`constrained desktop selected quality tier ${result.quality}, expected Low`);
  }
  if (lowEndRx && result.cadence.median > 24) {
    throw new Error(`RX 640 median frame interval is still ${result.cadence.median.toFixed(1)}ms`);
  }
  if (result.at60.repeated !== 0) {
    throw new Error(`60 Hz baseline repeated ${result.at60.repeated} visual poses`);
  }
  if (result.at144.repeated !== 0) {
    throw new Error(`144 Hz repeated ${result.at144.repeated} visual poses`);
  }
  if (result.trackNormals.repeated !== 0) {
    throw new Error(`144 Hz repeated ${result.trackNormals.repeated} road normals`);
  }
  if (result.trackNormals.maxStepDeg > 0.2) {
    throw new Error(`road normal stepped ${result.trackNormals.maxStepDeg.toFixed(3)} degrees`);
  }
  if (Math.abs(result.correction60 - result.correction144) > 0.02) {
    throw new Error(
      `reconciliation differs by refresh rate: ${result.correction60} vs ${result.correction144}`,
    );
  }
} finally {
  await browser?.close();
  server.stop();
}
