// One-shot: writes minimal *working* placeholders for every module so the app
// boots end-to-end from minute one. Each specialist agent replaces its own file
// wholesale. Never run this again after the real implementations land.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = {};

files['src/core/Input.ts'] = `import type { Ctx, IInput, InputState } from '../types';

/** PLACEHOLDER — replaced by the input specialist. */
export class Input implements IInput {
  state: InputState = {
    steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false,
    itemPressed: false, lookBack: false, pausePressed: false, anyPressed: false,
  };
  touch = false;
  private keys = new Set<string>();

  init() {
    addEventListener('keydown', (e) => { this.keys.add(e.code); });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); });
  }

  update() {
    const k = this.keys;
    const s = this.state;
    s.steer = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    s.accel = k.has('ArrowUp') || k.has('KeyW') || k.has('Space') ? 1 : 0;
    s.brake = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    s.drift = k.has('ShiftLeft') || k.has('ShiftRight');
  }
}
`;

files['src/render/Sky.ts'] = `import * as THREE from 'three';
import type { Ctx, System } from '../types';

/** PLACEHOLDER — replaced by the sky & lighting specialist. */
export class Sky implements System {
  init(ctx: Ctx) {
    ctx.scene.background = new THREE.Color(0x86b7e8);
    ctx.scene.fog = new THREE.Fog(0x9fc5e8, 60, 600);
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a3a, 1.2);
    ctx.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.position.set(80, 120, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -120; c.right = 120; c.top = 120; c.bottom = -120; c.far = 400;
    ctx.scene.add(sun);
    ctx.sun = sun;
    ctx.sunDirection.copy(sun.position).normalize();
  }
}
`;

files['src/render/Materials.ts'] = `import * as THREE from 'three';
import type { Ctx, System } from '../types';

/** PLACEHOLDER — replaced by the procedural material specialist. */
export class Materials implements System {
  private cache = new Map<string, THREE.Material>();

  get(name: string): THREE.Material {
    let m = this.cache.get(name);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9, metalness: 0 });
      this.cache.set(name, m);
    }
    return m;
  }
}
`;

files['src/world/Track.ts'] = `import * as THREE from 'three';
import type { Ctx, ITrack, SurfaceProbe, System, TrackSample } from '../types';
import { Surface } from '../types';

/** PLACEHOLDER — replaced by the track specialist. A flat 200m oval. */
export class Track implements ITrack {
  length = 0;
  group = new THREE.Group();
  startGrid: { pos: THREE.Vector3; yaw: number }[] = [];
  checkpointCount = 8;
  bounds = new THREE.Box3();
  private curve: THREE.CatmullRomCurve3;

  constructor() {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 120, 0, Math.sin(a) * 80));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.length = this.curve.getLength();
    for (let i = 0; i < 12; i++) {
      const s = this.sample((i % 2) * 0.004 + 0.99 - Math.floor(i / 2) * 0.006);
      this.startGrid.push({
        pos: s.pos.clone().addScaledVector(s.binormal, i % 2 ? 4 : -4).setY(0.5),
        yaw: Math.atan2(s.tangent.x, s.tangent.z),
      });
    }
    this.bounds.setFromPoints([new THREE.Vector3(-140, -5, -100), new THREE.Vector3(140, 30, 100)]);
  }

  init(ctx: Ctx) {
    const road = new THREE.Mesh(
      new THREE.TorusGeometry(1, 1, 4, 4),
      new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.9 })
    );
    road.visible = false;
    this.group.add(road);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshStandardMaterial({ color: 0x4e7a3a, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);
    ctx.scene.add(this.group);
  }

  sample(t: number): TrackSample {
    t = ((t % 1) + 1) % 1;
    const pos = this.curve.getPointAt(t);
    const tangent = this.curve.getTangentAt(t).normalize();
    const normal = new THREE.Vector3(0, 1, 0);
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    return { pos, tangent, normal, binormal, halfWidth: 12, bank: 0, distance: t * this.length, t };
  }

  sampleByDistance(d: number) { return this.sample(d / this.length); }

  probe(p: THREE.Vector3, _hint: number): SurfaceProbe {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 200; i++) {
      const t = i / 200;
      const d = this.curve.getPointAt(t).distanceToSquared(p);
      if (d < bestD) { bestD = d; best = t; }
    }
    const s = this.sample(best);
    const lateral = p.clone().sub(s.pos).dot(s.binormal);
    const edgeRatio = Math.abs(lateral) / s.halfWidth;
    return {
      y: 0, normal: new THREE.Vector3(0, 1, 0),
      surface: edgeRatio <= 1 ? Surface.Road : Surface.Grass,
      lateral, t: best, edgeRatio,
    };
  }

  checkpointAt(t: number) { return Math.floor(t * this.checkpointCount) % this.checkpointCount; }
  collideWalls() { return null; }
  minimapPath(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) { const p = this.curve.getPointAt(i / n); out.push({ x: p.x, z: p.z }); }
    return out;
  }
}
`;

files['src/world/Scenery.ts'] = `import type { Ctx, System } from '../types';
/** PLACEHOLDER — replaced by the environment/scenery specialist. */
export class Scenery implements System { init(_ctx: Ctx) {} update() {} }
`;

files['src/kart/KartModel.ts'] = `import * as THREE from 'three';
import type { KartStats } from '../types';

/** PLACEHOLDER — replaced by the kart-model specialist. */
export function buildKart(stats: KartStats): { root: THREE.Group; wheels: THREE.Object3D[] } {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.5, 2.0),
    new THREE.MeshStandardMaterial({ color: stats.color, roughness: 0.4, metalness: 0.3 })
  );
  body.position.y = 0.35;
  body.castShadow = true;
  root.add(body);
  const wheels: THREE.Object3D[] = [];
  const wg = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 16);
  wg.rotateZ(Math.PI / 2);
  const wm = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.85 });
  for (const [x, z] of [[-0.72, 0.72], [0.72, 0.72], [-0.72, -0.78], [0.72, -0.78]]) {
    const w = new THREE.Mesh(wg, wm);
    w.position.set(x, 0.32, z);
    w.castShadow = true;
    root.add(w);
    wheels.push(w);
  }
  return { root, wheels };
}
`;

files['src/fx/Effects.ts'] = `import type { Ctx, System } from '../types';
/** PLACEHOLDER — replaced by the VFX specialist. */
export class Effects implements System { init(_ctx: Ctx) {} update() {} }
`;

files['src/game/Items.ts'] = `import type { Ctx, IItems, IKart, System } from '../types';
import { ItemKind } from '../types';

/** PLACEHOLDER — replaced by the items specialist. */
export class Items implements IItems {
  private map = new Map<number, { kind: ItemKind; count: number }>();
  init(_ctx: Ctx) {}
  update() {}
  roll() { return ItemKind.Mushroom; }
  held(k: IKart) { return this.map.get(k.id) ?? { kind: ItemKind.None, count: 0 }; }
  give(k: IKart, kind: ItemKind, count = 1) { this.map.set(k.id, { kind, count }); }
  use(k: IKart) {
    const h = this.held(k);
    if (h.kind === ItemKind.None) return false;
    k.applyBoost(1.5);
    this.map.delete(k.id);
    return true;
  }
  pickup(k: IKart) { this.give(k, ItemKind.Mushroom); }
}
`;

files['src/ui/HUD.ts'] = `import type { Ctx, System } from '../types';
/** PLACEHOLDER — replaced by the UI specialist. */
export class HUD implements System { init(_ctx: Ctx) {} lateUpdate() {} resize() {} }
`;

files['src/audio/Audio.ts'] = `import type { Ctx, System } from '../types';
/** PLACEHOLDER — replaced by the audio specialist. */
export class Audio implements System { init(_ctx: Ctx) {} update() {} }
`;

for (const [rel, src] of Object.entries(files)) {
  const p = join(root, rel);
  if (existsSync(p)) { console.log('skip (exists)', rel); continue; }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, src);
  console.log('wrote', rel);
}
