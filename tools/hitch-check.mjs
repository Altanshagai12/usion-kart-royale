/**
 * Hunts the cause of mid-race black flashes.
 *
 * Hypothesis: they are shader-compilation stalls. Both reported triggers —
 * picking up an item, and turning into a new part of the circuit — put a
 * material on screen for the FIRST time, and three compiles a program lazily on
 * first render. A long synchronous compile blocks the GL thread, the browser
 * misses its compositing deadline and presents a partially-updated surface,
 * which reads as part of the screen going black for a beat.
 *
 * This samples every frame for a minute of real racing and correlates frame
 * spikes against `renderer.info.programs.length`. If the long frames land on
 * the frames where the program count grows, the hypothesis holds and the fix is
 * to pre-warm, not to chase the renderer.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5183;
const SECONDS = parseFloat(process.argv[2] || '60');

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

const out = await page.evaluate(async (seconds) => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.start();

  const renderer = ctx.renderer;
  const samples = [];
  let prevPrograms = renderer.info.programs?.length ?? 0;
  const startPrograms = prevPrograms;
  let last = performance.now();
  const t0 = last;

  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      const ms = now - last;
      last = now;
      const programs = renderer.info.programs?.length ?? 0;
      if (programs !== prevPrograms || ms > 24) {
        samples.push({
          t: +((now - t0) / 1000).toFixed(2),
          ms: +ms.toFixed(1),
          programs,
          newPrograms: programs - prevPrograms,
        });
      }
      prevPrograms = programs;
      if (now - t0 < seconds * 1000) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });

  return {
    startPrograms,
    endPrograms: prevPrograms,
    samples,
  };
}, SECONDS);

const compiles = out.samples.filter((s) => s.newPrograms > 0);
const spikes = out.samples.filter((s) => s.ms > 24);
const spikesWithCompile = spikes.filter((s) => s.newPrograms > 0);

console.log(`programs at boot : ${out.startPrograms}`);
console.log(`programs at end  : ${out.endPrograms}  (+${out.endPrograms - out.startPrograms} compiled DURING play)`);
console.log(`frames > 24ms    : ${spikes.length}`);
console.log(`  ...of which compiled a new program: ${spikesWithCompile.length}`);
if (spikes.length) {
  const worst = [...spikes].sort((a, b) => b.ms - a.ms).slice(0, 12);
  console.log('\nworst frames:');
  for (const s of worst) {
    console.log(`  t=${String(s.t).padStart(6)}s  ${String(s.ms).padStart(7)}ms  programs=${s.programs}${s.newPrograms > 0 ? `  <-- COMPILED ${s.newPrograms}` : ''}`);
  }
}
if (compiles.length) {
  console.log(`\nlate compiles (${compiles.length}):`);
  for (const c of compiles.slice(0, 20)) {
    console.log(`  t=${String(c.t).padStart(6)}s  +${c.newPrograms} program(s)  frame ${c.ms}ms`);
  }
}

const verdict = out.endPrograms > out.startPrograms
  ? 'CONFIRMED: programs are still compiling during play — pre-warm needed'
  : 'NOT CONFIRMED: no late compiles; the flashes have another cause';
console.log('\n' + verdict);

await browser.close();
srv.stop();
