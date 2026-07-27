/** Do the AI drivers still get round the circuit? Progress, off-track time and respawns. */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import puppeteer from 'puppeteer';
const root = new URL('..', import.meta.url).pathname, PORT = 5179;
const open = (p) => new Promise((r) => { const s = createConnection({ port: p, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); setTimeout(() => { s.destroy(); r(false); }, 800); });
const srv = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
for (let i = 0; i < 90 && !(await open(PORT)); i++) await new Promise((r) => setTimeout(r, 400));
const b = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'] });
const pg = await b.newPage();
await pg.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction('window.__gameReady === true', { timeout: 90000 });
const out = await pg.evaluate(async () => {
  const ctx = window.__ctx, race = ctx.race;
  race.autoDrive = true; race.start();
  const off = new Map(), t0 = performance.now();
  while (performance.now() - t0 < 45000) {
    for (const k of race.karts) if (k.surface === 5 /* OffTrack */ || k.surface === 6) off.set(k.id, (off.get(k.id) || 0) + 1);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return race.karts.map((k) => ({
    name: k.stats.name, lap: k.lap, dist: Math.round(k.raceDistance),
    kmh: Math.round(k.forwardSpeed * 3.6), offFrames: off.get(k.id) || 0,
  }));
});
console.log(JSON.stringify(out, null, 1));
await b.close(); srv.kill();
