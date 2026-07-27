import * as THREE from 'three';
import { Track } from './src/world/Track';
import { KERB_W, SEA_Y } from './src/world/TrackLayout';

const track: any = new (Track as any)();
const cl = track.cl;
const st = (t: number) => Math.floor((((t % 1) + 1) % 1) * cl.count) % cl.count;
const seaSide = (t: number) => (cl.farR[st(t)] < cl.farL[st(t)] ? 1 : -1);
const _p = new THREE.Vector3();

/** silhouette elevation (deg) of the terrain along a horizontal bearing */
function silhouette(ex: number, ey: number, ez: number, dx: number, dz: number, maxD = 1200) {
  let horizon = -90, hd = 0, water = false;
  for (let d = 1.2; d < maxD; d += d < 60 ? 0.5 : d < 240 ? 2.5 : 12) {
    const x = ex + dx * d, z = ez + dz * d;
    const gy = track.groundAt(x, z);
    const y = Math.max(gy, SEA_Y);
    const el = (Math.atan2(y - ey, d) * 180) / Math.PI;
    if (el > horizon) { horizon = el; hd = d; water = gy < SEA_Y - 0.05; }
  }
  return { horizon, hd, water };
}

/**
 * Frame audit at a shot station. Eye = racing-line lateral, 1.5 m above road.
 * Fan of bearings spanning the chase camera's horizontal FOV (50° vFov, 16:9
 * => ~78° hFov, so +-39° about forward).
 */
function audit(t: number, latFrac: number, label: string) {
  const i = st(t);
  const lat = latFrac * cl.half[i];
  track.crossPoint(i, lat, _p);
  const ex = _p.x, ey = _p.y + 1.5, ez = _p.z;
  const sea = seaSide(t);
  const rows: string[] = [];
  let emptySky = 0, n = 0, waterBearings = 0;
  for (let a = -39; a <= 39; a += 3) {
    const r = (a * Math.PI) / 180;
    // forward = tangent; +a swings toward the sea side
    const dx = cl.tx[i] * Math.cos(r) + sea * cl.hx[i] * Math.sin(r);
    const dz = cl.tz[i] * Math.cos(r) + sea * cl.hz[i] * Math.sin(r);
    const nn = Math.hypot(dx, dz);
    const s = silhouette(ex, ey, ez, dx / nn, dz / nn);
    n++;
    if (s.horizon < 2) emptySky++;
    if (s.water) waterBearings++;
    rows.push(`${a >= 0 ? '+' : ''}${a}:${s.horizon.toFixed(1)}${s.water ? 'w' : ''}`);
  }
  console.log(`${label} t=${t.toFixed(3)} lat=${lat.toFixed(1)} bank=${((cl.bank[i] * 180) / Math.PI).toFixed(1)}°`);
  console.log('  ' + rows.join(' '));
  console.log(`  bearings with silhouette < 2deg (empty sky above horizon): ${emptySky}/${n};  water on horizon: ${waterBearings}/${n}`);
  return { emptySky, n, waterBearings };
}

console.log('=== frame audit: bearing -> terrain silhouette elevation (deg), w = that bearing ends on water ===');
console.log('(+ bearings swing toward the sea side, - toward land)\n');
for (const t of [0.7757, 0.7821]) {
  for (const f of [-0.6, 0, 0.55]) audit(t, f, f < 0 ? 'inside-line ' : f === 0 ? 'centreline  ' : 'outside-line');
  console.log('');
}

console.log('=== landward (inside of the 180) terrain profile, q from kerb edge ===');
for (const t of [0.7757, 0.80, 0.82]) {
  const i = st(t), land = -seaSide(t);
  const rows: string[] = [];
  for (const q of [0, 4, 8, 12, 18, 26, 34, 46, 60, 80, 110, 150]) {
    const lat = land * (cl.half[i] + KERB_W + q);
    track.crossPoint(i, lat, _p);
    rows.push(`q${q}=${track.groundAt(_p.x, _p.z).toFixed(1)}`);
  }
  console.log(`t=${t.toFixed(3)} roadY=${cl.py[i].toFixed(1)}  ` + rows.join(' '));
}

console.log('\n=== seaward terrain profile, q from kerb edge ===');
for (const t of [0.7757, 0.80, 0.82]) {
  const i = st(t), sea = seaSide(t);
  const rows: string[] = [];
  for (const q of [0, 2, 4, 6, 8, 10, 12, 16, 22, 30, 40, 60]) {
    const lat = sea * (cl.half[i] + KERB_W + q);
    track.crossPoint(i, lat, _p);
    rows.push(`q${q}=${track.groundAt(_p.x, _p.z).toFixed(1)}`);
  }
  console.log(`t=${t.toFixed(3)} roadY=${cl.py[i].toFixed(1)}  ` + rows.join(' '));
}
