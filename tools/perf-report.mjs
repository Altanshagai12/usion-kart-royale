/** Aggregates a perf-*.json into a subsystem breakdown. */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const only = process.argv[3];
const r = JSON.parse(readFileSync(file, 'utf8'));

const classify = (key) => {
  const [top, path] = key.split(' | ');
  const p = (path || '').toLowerCase();
  const t = (top || '').toLowerCase();
  if (t.includes('sky') || p.includes('sky') || p.includes('cloud') || p.includes('aurora') || p.includes('star')) return 'sky/atmos';
  if (t.includes('scenery') || p.includes('scenery')) {
    if (p.includes('foliage') || p.includes('tree') || p.includes('grass') || p.includes('palm') || p.includes('bush') || p.includes('flower') || p.includes('fern') || p.includes('reed')) return 'foliage';
    if (p.includes('crowd') || p.includes('spectator') || p.includes('marshal')) return 'crowd';
    if (p.includes('sea') || p.includes('water')) return 'water';
    return 'scenery props';
  }
  if (t.includes('track') || p.includes('track') || p.includes('kerb') || p.includes('road')) return 'track';
  if (t.includes('kart') || p.includes('kart') || p.includes('driver') || p.includes('wheel')) return 'karts';
  if (p.includes('particle') || p.includes('spark') || p.includes('smoke') || p.includes('trail') || t.includes('effects') || p.includes('fx')) return 'fx/particles';
  if (p.includes('decal')) return 'decals';
  return 'other:' + top;
};

for (const s of r.shots) {
  if (only && s.name !== only) continue;
  console.log(`\n=== ${s.name}  total=${s.totalCalls.median} scene=${s.sceneCalls.median} tris=${(s.triangles / 1e6).toFixed(2)}M progs=${s.programs} texs=${s.textures} geos=${s.geometries}`);
  const groups = new Map();
  for (const o of s.objects) {
    const g = classify(o.key);
    let e = groups.get(g);
    if (!e) { e = { scene: 0, shadow: 0, tris: 0, n: 0, items: [] }; groups.set(g, e); }
    e.scene += o.scene; e.shadow += o.shadow; e.tris += o.tris; e.n++;
    e.items.push(o);
  }
  const rows = [...groups.entries()].sort((a, b) => (b[1].scene + b[1].shadow) - (a[1].scene + a[1].shadow));
  for (const [g, e] of rows) {
    console.log(`  ${g.padEnd(16)} draws=${(e.scene + e.shadow).toFixed(1).padStart(6)}  (scene ${e.scene.toFixed(1)} + shadow ${e.shadow.toFixed(1)})  objs=${e.n}  tris=${(e.tris / 1e3).toFixed(0)}k`);
    e.items.sort((a, b) => (b.scene + b.shadow) - (a.scene + a.shadow));
    for (const it of e.items.slice(0, 14)) {
      if (it.scene + it.shadow < 0.5) break;
      console.log(`      ${(it.scene + it.shadow).toFixed(1).padStart(6)}  [${it.scene.toFixed(1)}+${it.shadow.toFixed(1)}] ${(it.tris / 1e3).toFixed(0)}k  ${it.key.slice(0, 150)}`);
    }
    if (e.items.length > 14) console.log(`      ... ${e.items.length - 14} more`);
  }
}
