/**
 * ============================================================================
 *  Props — the scenery toolbox.
 * ============================================================================
 *  Everything the world-dressing layer is built from lives here: procedural
 *  texture generation, chamfered/beveled geometry primitives, a merge
 *  accumulator, an instancing accumulator, the shader-patch system that gives
 *  us wind / bob / crowd / flag motion for free on the GPU, the shared
 *  material library, and the individual prop generators.
 *
 *  Two rules govern this file:
 *    1. Nothing here allocates during `update()`. All of it runs at init.
 *    2. Nothing here ships a flat material. Every surface gets albedo +
 *       normal + roughness, generated into a canvas.
 * ============================================================================
 */
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { getMaterials } from '../render/Materials';

// ---------------------------------------------------------------------------
// Palette (ART_DIRECTION.md §3) and small math helpers
// ---------------------------------------------------------------------------

export const PAL = {
  sand: 0xe3c893,
  grass: 0x6f9b47,
  grassTip: 0x87b356,
  seaDeep: 0x0d5a7a,
  seaShallow: 0x3fc9c4,
  foam: 0xeefaff,
  stone: 0xa8927a,
  roofTile: 0xb5643f,
  skyWarm: 0xffd0a0,
  kerbRed: 0xe0453f,
  kerbWhite: 0xf2ece0,
  pastels: [0xf2c9a0, 0xe8a5a0, 0xf5e2b0, 0xa9c8d4, 0xdcb8d8, 0xf0d9bf, 0xcfd9c0],
  shutters: [0x3f6b74, 0x2f5d43, 0x8a4433, 0x5a5f8a, 0x77502f],
  boatHulls: [0xf2ece0, 0xe0453f, 0x2f6ba0, 0x2f5d43, 0xf5e2b0, 0x3f3f4a],
  clothes: [0xf2ece0, 0xa9c8d4, 0xe8a5a0, 0xf5e2b0, 0xdcb8d8, 0x9fc0a8],
  crowd: [0xe0453f, 0x4fc3ff, 0xff9d2e, 0xc05cff, 0xf2ece0, 0x6f9b47, 0xf5e2b0, 0xe8a5a0, 0x2f6ba0, 0xdcb8d8],
  skin: [0xf0c8a0, 0xd9a578, 0xa9713f, 0x6f4426, 0xf7d9bd],
};

export type RNG = () => number;

/** Deterministic 32-bit PRNG — the whole world must rebuild identically. */
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** pick with an RNG */
export const pick = <T>(rng: RNG, arr: T[]): T => arr[(rng() * arr.length) | 0];

// ---------------------------------------------------------------------------
// Canvas texture generation
// ---------------------------------------------------------------------------

function cv(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  return [c, g];
}

function finish(c: HTMLCanvasElement, srgb: boolean, aniso: number, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Integer-lattice value noise with an explicit period per axis, so every
 * texture wraps exactly and can have anisotropic grain (wood stretches along
 * the plank, plaster streaks with the trowel). Simplex would look marginally
 * better here but cost roughly five times as much, and at 1024² across eight
 * material sets that is seconds of boot time for detail nobody can resolve.
 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(u: number, v: number, px: number, py: number, seed: number): number {
  const x = u * px,
    y = v * py;
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = x - xi,
    yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px,
    x1 = (x0 + 1) % px;
  const y0 = ((yi % py) + py) % py,
    y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed),
    b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed),
    d = hash2(x1, y1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** fbm in [-1,1]; periods double each octave so the wrap survives. */
function fbm(seed: number, u: number, v: number, px: number, py: number, oct: number, gain = 0.5): number {
  let amp = 1,
    sum = 0,
    norm = 0,
    a = px,
    b = py;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u, v, a | 0, b | 0, seed + o * 131);
    norm += amp;
    amp *= gain;
    a *= 2;
    b *= 2;
  }
  return (sum / norm) * 2 - 1;
}

/** Central-difference normal map out of a height field. */
function normalFromHeight(h: Float32Array, size: number, strength: number, aniso: number): THREE.CanvasTexture {
  const [c, g] = cv(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  const w = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (w(x + 1, y) - w(x - 1, y)) * strength;
      const dy = (w(x, y + 1) - w(x, y - 1)) * strength;
      // normalize(-dx, -dy, 1)
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      d[i] = (-dx * l * 0.5 + 0.5) * 255;
      d[i + 1] = (-dy * l * 0.5 + 0.5) * 255;
      d[i + 2] = (l * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, false, aniso);
}

/** Grey texture from a float field — used for roughness (three reads .g). */
function greyFromField(f: Float32Array, size: number, aniso: number): THREE.CanvasTexture {
  const [c, g] = cv(size);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = clamp(f[i], 0, 1) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, false, aniso);
}

export interface MatMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * The procedural texture library. Every generator returns albedo + normal +
 * roughness; the roughness field always *varies spatially* (§4 of the bible —
 * constant roughness is the #1 amateur tell).
 */
export class TexLib {
  private cache = new Map<string, MatMaps>();
  readonly aniso: number;

  constructor(renderer: THREE.WebGLRenderer) {
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  private memo(key: string, gen: () => MatMaps): MatMaps {
    let m = this.cache.get(key);
    if (!m) {
      m = gen();
      this.cache.set(key, m);
    }
    return m;
  }

  // -- stucco / lime plaster: the village walls -----------------------------
  plaster(size = 1024): MatMaps {
    return this.memo('plaster', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const grain = fbm(11, u, v, 192, 192, 4);
          const trowel = fbm(23, u, v, 8, 26, 3) * 0.9;
          const blotch = fbm(37, u, v, 4, 4, 2);
          const i = y * size + x;
          h[i] = grain * 0.55 + trowel * 0.45;
          // Base is a warm off-white; per-house pastel arrives as vertex colour.
          const t = 0.5 + h[i] * 0.5;
          const damp = smoothstep(0.12, 0.34, blotch) * 0.14;
          const rr = lerp(0.90, 1.0, t) - damp * 0.9;
          const gg = lerp(0.875, 0.985, t) - damp * 0.75;
          const bb = lerp(0.83, 0.95, t) - damp * 0.5;
          const o = i * 4;
          d[o] = rr * 255;
          d[o + 1] = gg * 255;
          d[o + 2] = bb * 255;
          d[o + 3] = 255;
          r[i] = 0.62 + trowel * 0.16 + grain * 0.1 + damp * 1.2;
        }
      }
      g.putImageData(img, 0, 0);
      // hairline cracks: a few random walks, darkened + carved into the height
      const rng = mulberry32(7717);
      g.lineCap = 'round';
      for (let k = 0; k < 26; k++) {
        let x = rng() * size,
          y = rng() * size,
          a = rng() * Math.PI * 2;
        g.strokeStyle = `rgba(120,105,92,${0.18 + rng() * 0.22})`;
        g.lineWidth = 0.7 + rng() * 1.3;
        g.beginPath();
        g.moveTo(x, y);
        const steps = 12 + ((rng() * 26) | 0);
        for (let s = 0; s < steps; s++) {
          a += (rng() - 0.5) * 0.9;
          x += Math.cos(a) * 6;
          y += Math.sin(a) * 6;
          g.lineTo(x, y);
          const ix = ((x | 0) + size) % size,
            iy = ((y | 0) + size) % size;
          h[iy * size + ix] -= 0.5;
        }
        g.stroke();
      }
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 26, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- terracotta barrel roof tiles ----------------------------------------
  roofTile(size = 1024): MatMaps {
    return this.memo('roof', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const cols = 8; // tiles across
      const rows = 10; // courses down
      const rng = mulberry32(4242);
      const jitter = new Float32Array(cols * rows * 3);
      for (let i = 0; i < jitter.length; i++) jitter[i] = rng();
      for (let y = 0; y < size; y++) {
        const fv = y / size;
        const rowF = fv * rows;
        const row = Math.floor(rowF);
        const rowT = rowF - row; // 0 at the top of a course (lapped by the one above)
        for (let x = 0; x < size; x++) {
          const fu = x / size;
          // Alternate courses offset half a tile.
          const off = row & 1 ? 0.5 : 0;
          const colF = fu * cols + off;
          const col = Math.floor(colF) % cols;
          const ct = colF - Math.floor(colF);
          // Barrel profile: half-round ridge, so height peaks mid-tile.
          const barrel = Math.sin(ct * Math.PI);
          const lap = smoothstep(0.0, 0.10, rowT); // shadowed lap line at the top
          const gap = smoothstep(0.5, 0.0, Math.abs(ct - 0.5) * 2) * 0.0 + Math.pow(barrel, 0.6);
          const ji = (row % rows) * cols * 3 + col * 3;
          const j0 = jitter[ji],
            j1 = jitter[ji + 1],
            j2 = jitter[ji + 2];
          const i = y * size + x;
          h[i] = gap * 0.9 + lap * 0.35 - (1 - lap) * 0.5 + fbm(41, fu, fv, 256, 256, 3) * 0.09;
          const shade = (0.55 + 0.45 * gap) * (0.72 + 0.28 * lap);
          // terracotta with per-tile hue drift + moss in the valleys
          const hueT = j0 * 0.5 + j1 * 0.2;
          let rr = lerp(0.62, 0.80, hueT) * shade;
          let gg = lerp(0.30, 0.42, hueT) * shade;
          let bb = lerp(0.21, 0.28, hueT * 0.8) * shade;
          const moss = clamp((1 - barrel) * 1.4 - 0.55, 0, 1) * (0.25 + j2 * 0.5) * smoothstep(0.15, 0.6, fbm(53, fu, fv, 8, 8, 2) + 0.5);
          rr = lerp(rr, 0.34, moss * 0.55);
          gg = lerp(gg, 0.38, moss * 0.55);
          bb = lerp(bb, 0.24, moss * 0.55);
          const o = i * 4;
          d[o] = clamp(rr, 0, 1) * 255;
          d[o + 1] = clamp(gg, 0, 1) * 255;
          d[o + 2] = clamp(bb, 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.55 + (1 - barrel) * 0.3 + j1 * 0.12 + moss * 0.15;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 34, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- painted timber: shutters, doors, jetties, hulls, crates --------------
  wood(size = 1024): MatMaps {
    return this.memo('wood', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const planks = 6;
      const rng = mulberry32(9091);
      const pj = new Float32Array(planks * 2);
      for (let i = 0; i < pj.length; i++) pj[i] = rng();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const pf = u * planks;
          const p = Math.floor(pf) % planks;
          const pt = pf - Math.floor(pf);
          const edge = smoothstep(0.0, 0.035, pt) * smoothstep(1.0, 0.965, pt);
          // grain: fbm heavily stretched along the plank
          const grain = fbm(61 + p * 7, u, v, 96, 6, 4);
          const fine = fbm(71 + p * 5, u, v, 256, 24, 2);
          const i2 = y * size + x;
          const gr = grain * 0.7 + fine * 0.3;
          h[i2] = gr * 0.5 + (edge - 1) * 1.1;
          const base = 0.86 + gr * 0.14;
          // per-plank value jitter, widened: every plank on a start arch being
          // identical in both albedo and gloss is a dead giveaway
          const bright = base * lerp(0.76, 1.08, pj[p * 2]) * lerp(0.55, 1.0, edge);
          const o = i2 * 4;
          d[o] = clamp(bright, 0, 1) * 255;
          d[o + 1] = clamp(bright * (0.97 - gr * 0.05), 0, 1) * 255;
          d[o + 2] = clamp(bright * (0.93 - gr * 0.09), 0, 1) * 255;
          d[o + 3] = 255;
          // weathered grey 0.9 vs resin-sealed 0.6, decided per plank
          const sealed = pj[p * 2 + 1] < 0.42 ? 0.58 : 0.9;
          r[i2] = sealed + Math.abs(gr) * 0.22 + (1 - edge) * 0.18 - 0.12;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 22, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- weathered ashlar: quay walls, lighthouse base, plinths ---------------
  stone(size = 1024): MatMaps {
    return this.memo('stone', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const rows = 7;
      const rng = mulberry32(3313);
      const rowOff: number[] = [];
      const blockJ: number[][] = [];
      for (let y = 0; y < rows; y++) {
        rowOff.push(rng());
        const cols = 4 + ((rng() * 3) | 0);
        const js: number[] = [];
        for (let i = 0; i < cols * 3; i++) js.push(rng());
        js.push(cols);
        blockJ.push(js);
      }
      for (let y = 0; y < size; y++) {
        const v = y / size;
        const rf = v * rows;
        const row = Math.floor(rf) % rows;
        const rt = rf - Math.floor(rf);
        const js = blockJ[row];
        const cols = js[js.length - 1];
        for (let x = 0; x < size; x++) {
          const u = x / size;
          const cf = u * cols + rowOff[row];
          const col = Math.floor(cf) % cols;
          const ct = cf - Math.floor(cf);
          const m = 0.028; // mortar width
          const inBlock = smoothstep(0, m, ct) * smoothstep(1, 1 - m, ct) * smoothstep(0, m * rows / cols, rt) * smoothstep(1, 1 - (m * rows) / cols, rt);
          const j0 = js[col * 3] ?? 0.5,
            j1 = js[col * 3 + 1] ?? 0.5,
            j2 = js[col * 3 + 2] ?? 0.5;
          const rough = fbm(83 + col * 13 + row * 29, u, v, 128, 128, 4);
          const wide = fbm(97, u, v, 6, 6, 3);
          const i = y * size + x;
          // Deeper joints: at a 14° key the coursing has to self-shadow, and a
          // shallow height step gives no raking micro-shadow at all.
          h[i] = inBlock * 1.85 - 0.6 + rough * 0.35 * inBlock;
          const tone = lerp(0.72, 1.0, j0) * (0.9 + rough * 0.2) * lerp(0.72, 1.0, inBlock);
          // #a8927a base, greened where damp
          let rr = 0.66 * tone,
            gg = 0.575 * tone,
            bb = 0.48 * tone;
          const damp = clamp(wide * 1.6 + 0.25 - v * 0.7, 0, 1) * 0.35 * j1;
          rr = lerp(rr, 0.32, damp);
          gg = lerp(gg, 0.38, damp);
          bb = lerp(bb, 0.28, damp);
          const o = i * 4;
          d[o] = clamp(rr, 0, 1) * 255;
          d[o + 1] = clamp(gg, 0, 1) * 255;
          d[o + 2] = clamp(bb, 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.7 + rough * 0.2 + (1 - inBlock) * 0.2 - j2 * 0.12 + damp * 0.2;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 40, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- painted / lacquered metal: bollards, rails, lamp posts, tyres --------
  paintedMetal(size = 512): MatMaps {
    return this.memo('metal', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const orange = fbm(101, u, v, 96, 96, 4); // orange-peel in the paint
          const chip = clamp(fbm(103, u, v, 24, 24, 3) * 2.4 - 0.85, 0, 1);
          const i = y * size + x;
          h[i] = orange * 0.5 - chip * 1.6;
          const base = 0.94 + orange * 0.06;
          const rust = chip * 0.8;
          const o = i * 4;
          d[o] = clamp(lerp(base, 0.45, rust), 0, 1) * 255;
          d[o + 1] = clamp(lerp(base, 0.26, rust), 0, 1) * 255;
          d[o + 2] = clamp(lerp(base, 0.18, rust), 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.3 + orange * 0.14 + rust * 0.55;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 16, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /**
   * 4x4 atlas of striped awning / parasol / sail canvas. Per-instance UV
   * transform picks a cell, so all fabric in the world is one draw call and
   * still shows six different stripe schemes.
   */
  fabricAtlas(size = 1024): MatMaps {
    return this.memo('fabric', () => {
      const [c, g] = cv(size);
      const cell = size / 4;
      const rng = mulberry32(5150);
      const schemes: [string, string][] = [
        ['#f2ece0', '#e0453f'],
        ['#f2ece0', '#3f6b74'],
        ['#f5e2b0', '#b5643f'],
        ['#f2ece0', '#2f6ba0'],
        ['#eaf0ea', '#2f5d43'],
        ['#f2ece0', '#ff9d2e'],
        ['#f0e4f0', '#dcb8d8'],
        ['#f2ece0', '#f2ece0'],
      ];
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const idx = cy * 4 + cx;
          const [a, b] = schemes[idx % schemes.length];
          const x0 = cx * cell,
            y0 = cy * cell;
          g.fillStyle = a;
          g.fillRect(x0, y0, cell, cell);
          const bands = 4 + (idx % 4);
          g.fillStyle = b;
          for (let i = 0; i < bands; i++) {
            const w = cell / (bands * 2);
            g.fillRect(x0 + (i * cell) / bands + w * 0.5, y0, w, cell);
          }
          // dirt at the bottom hem + a soft sag gradient so it isn't flat
          const grad = g.createLinearGradient(x0, y0, x0, y0 + cell);
          grad.addColorStop(0, 'rgba(255,240,215,0.22)');
          grad.addColorStop(0.65, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(60,45,35,0.20)');
          g.fillStyle = grad;
          g.fillRect(x0, y0, cell, cell);
          for (let k = 0; k < 40; k++) {
            g.fillStyle = `rgba(90,72,55,${rng() * 0.05})`;
            g.beginPath();
            g.arc(x0 + rng() * cell, y0 + cell * (0.6 + rng() * 0.4), rng() * 9, 0, 7);
            g.fill();
          }
        }
      }
      // weave normal + roughness
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const weave = Math.sin(x * 1.9) * Math.sin(y * 1.9) * 0.4 + fbm(107, x / size, y / size, 256, 256, 2) * 0.6;
          h[i] = weave;
          r[i] = 0.78 + weave * 0.12;
        }
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 8, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** 2 x 4 atlas of trackside sponsor boards. */
  /**
   * The start-line banner: course name, chequer flashes and a sponsor rule.
   * §1 asks for a banner arch over the start line and a bare timber gantry is
   * not one. 4:1 so the lettering is legible across the road.
   */
  bannerCloth(size = 1024): MatMaps {
    return this.memo('bannercloth', () => {
      const [c, g] = cv(size);
      const hh = size / 4;
      g.fillStyle = '#e0453f';
      g.fillRect(0, 0, size, hh);
      // chequer flashes at both ends
      const q = hh / 4;
      for (let bx = 0; bx < 3; bx++)
        for (let by = 0; by < 4; by++) {
          if ((bx + by) % 2) continue;
          for (const side of [0, 1]) {
            g.fillStyle = '#f2ece0';
            g.fillRect(side ? size - (bx + 1) * q : bx * q, by * q, q, q);
          }
        }
      // sponsor rule along the bottom
      g.fillStyle = '#2f3340';
      g.fillRect(0, hh * 0.8, size, hh * 0.2);
      g.fillStyle = '#f5e2b0';
      g.font = `700 ${hh * 0.13}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.letterSpacing = '6px';
      g.fillText('NITRO  ·  AMALFI OIL  ·  BOOST CO.  ·  MARINA', size / 2, hh * 0.9);
      // course name
      g.fillStyle = '#f2ece0';
      g.font = `900 ${hh * 0.42}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      g.letterSpacing = '10px';
      g.strokeStyle = 'rgba(60,20,16,0.55)';
      g.lineWidth = 7;
      g.strokeText('SUNSET BAY', size / 2, hh * 0.4);
      g.fillText('SUNSET BAY', size / 2, hh * 0.4);
      // the rest of the sheet is plain cloth for the fold-over
      g.fillStyle = '#c8382f';
      g.fillRect(0, hh, size, size - hh);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const weave = Math.sin(x * 2.1) * Math.sin(y * 2.1) * 0.35 + fbm(211, x / size, y / size, 220, 220, 2) * 0.65;
          // slack ripples running down the drop
          h[i] = weave * 0.5 + Math.sin(x * 0.055 + fbm(213, x / size, y / size, 6, 6, 2) * 4) * 0.5;
          r[i] = 0.74 + weave * 0.12;
        }
      return {
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(h, size, 12, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  sponsorAtlas(size = 1024): MatMaps {
    return this.memo('sponsor', () => {
      const [c, g] = cv(size);
      const w = size / 2,
        h0 = size / 4;
      const boards: [string, string, string][] = [
        ['#e0453f', '#f2ece0', 'SUNSET BAY'],
        ['#2f6ba0', '#f5e2b0', 'TURBO'],
        ['#f5e2b0', '#b5643f', 'AMALFI OIL'],
        ['#2f5d43', '#f2ece0', 'MARINA'],
        ['#ff9d2e', '#3f3f4a', 'NITRO'],
        ['#3f3f4a', '#4fc3ff', 'KART ROYALE'],
        ['#dcb8d8', '#3f3f4a', 'GOLDEN HR'],
        ['#4fc3ff', '#f2ece0', 'BOOST CO.'],
      ];
      for (let i = 0; i < 8; i++) {
        const cx = (i % 2) * w,
          cy = ((i / 2) | 0) * h0;
        const [bg, fg, text] = boards[i];
        g.fillStyle = bg;
        g.fillRect(cx, cy, w, h0);
        // chevron furniture so a board still reads when the text is small
        g.save();
        g.beginPath();
        g.rect(cx, cy, w, h0);
        g.clip();
        g.globalAlpha = 0.16;
        g.fillStyle = fg;
        for (let k = -2; k < 10; k++) {
          g.beginPath();
          g.moveTo(cx + k * 60, cy + h0);
          g.lineTo(cx + k * 60 + 34, cy + h0);
          g.lineTo(cx + k * 60 + 34 + h0 * 0.5, cy);
          g.lineTo(cx + k * 60 + h0 * 0.5, cy);
          g.closePath();
          g.fill();
        }
        g.globalAlpha = 1;
        g.fillStyle = fg;
        g.font = `800 ${h0 * 0.42}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.letterSpacing = '2px';
        g.fillText(text, cx + w / 2, cy + h0 / 2, w * 0.86);
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.lineWidth = 6;
        g.strokeRect(cx + 3, cy + 3, w - 6, h0 - 6);
        g.restore();
      }
      const hf = new Float32Array(size * size);
      const rf = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const n = fbm(109, x / size, y / size, 192, 192, 3);
          hf[i] = n;
          rf[i] = 0.34 + n * 0.16 + (Math.sin(y * 0.02) * 0.5 + 0.5) * 0.06;
        }
      return {
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(hf, size, 5, this.aniso),
        roughnessMap: greyFromField(rf, size, this.aniso),
      };
    });
  }

  /** Palm / pine bark: stacked leaf-scar rings for palms, plated for pines. */
  bark(kind: 'palm' | 'pine' = 'palm', size = 512): MatMaps {
    return this.memo('bark' + kind, () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const palm = kind === 'palm';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          let hh: number, tone: number;
          if (palm) {
            // diamond leaf scars: two interleaved ring families
            const ring = Math.abs(((v * 22 + Math.sin(u * 6.283 * 2) * 0.18) % 1) - 0.5) * 2;
            const stagger = Math.abs(((u * 11 + Math.floor(v * 22) * 0.5) % 1) - 0.5) * 2;
            const scar = smoothstep(0.75, 0.22, ring) * smoothstep(0.85, 0.3, stagger);
            const fibre = fbm(113, u, v, 192, 48, 3);
            hh = scar * 0.9 - 0.4 + fibre * 0.3;
            tone = 0.52 + scar * 0.3 + fibre * 0.2;
          } else {
            // pine: irregular plates with deep fissures
            const plate = fbm(127, u, v, 14, 20, 3);
            const fissure = smoothstep(0.06, -0.02, Math.abs(plate));
            const grain = fbm(131, u, v, 192, 40, 3);
            hh = (1 - fissure) * 0.8 - 0.4 + grain * 0.35;
            tone = 0.44 + (1 - fissure) * 0.34 + grain * 0.2;
          }
          const moss = clamp(fbm(137, u, v, 10, 10, 2) * 2.0 - 0.5, 0, 1) * 0.4;
          h[i] = hh;
          const o = i * 4;
          d[o] = clamp(lerp(tone * (palm ? 0.72 : 0.58), 0.28, moss), 0, 1) * 255;
          d[o + 1] = clamp(lerp(tone * (palm ? 0.62 : 0.45), 0.34, moss), 0, 1) * 255;
          d[o + 2] = clamp(lerp(tone * (palm ? 0.46 : 0.36), 0.22, moss), 0, 1) * 255;
          d[o + 3] = 255;
          r[i] = 0.74 + Math.abs(hh) * 0.16 + moss * 0.1;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, palm ? 30 : 38, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** Radial soft blob for prop contact shadows. */
  contactShadow(size = 256): THREE.Texture {
    const key = '__cs';
    const cached = (this as any)[key];
    if (cached) return cached;
    const [c, g] = cv(size);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.82)');
    grad.addColorStop(0.78, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // break the perfect circle so it doesn't read as a decal stamp
    g.globalCompositeOperation = 'destination-out';
    const rng = mulberry32(31337);
    for (let i = 0; i < 26; i++) {
      const a = rng() * 7,
        r = size * (0.32 + rng() * 0.2);
      g.fillStyle = `rgba(0,0,0,${0.1 + rng() * 0.25})`;
      g.beginPath();
      g.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, size * (0.06 + rng() * 0.1), 0, 7);
      g.fill();
    }
    const t = finish(c, false, 1, false);
    (this as any)[key] = t;
    return t;
  }

  /**
   * Verge transition strip: the scuffed dirt/gravel band where a kerb meets
   * grass. Grass butting straight against tarmac on a razor line is one of the
   * loudest "generated" tells in a road scene, and the fix is not a shader —
   * it is the metre of trodden dirt that exists at the edge of every real
   * road. U runs ACROSS the strip (0 = kerb side, 1 = grass side); V runs
   * along the road, and carries the ragged edge so the band never reads as a
   * ruled offset of the kerb.
   */
  vergeScuff(size = 512): MatMaps {
    return this.memo('vergescuff', () => {
      const [c, g] = cv(size);
      const img = g.createImageData(size, size);
      const d = img.data;
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          // Ragged inner/outer edges: two independent 1-D fields along the road.
          const edge = fbm(41, v, 0.5, 24, 1, 3) * 0.5 + 0.5;
          const grit = fbm(59, u, v, 96, 96, 4) * 0.5 + 0.5;
          const patch = fbm(73, u, v, 6, 14, 2) * 0.5 + 0.5;
          // Solid for the first ~20 cm-equivalent, gone by the outer lip, with
          // the falloff position wandering along the road.
          const reach = 0.34 + edge * 0.5;
          let a = 1 - smoothstep(reach * 0.35, reach, u);
          // gravel spatter beyond the solid band, so the outer edge dissolves
          a = Math.max(a, smoothstep(0.62, 0.86, grit) * (1 - smoothstep(reach, 1.0, u)) * 0.85);
          a *= 0.55 + patch * 0.65;
          // Warm road grit near the kerb, drier pale dust further out.
          const tone = 0.62 + grit * 0.3 + patch * 0.12;
          const dry = smoothstep(0.1, 0.8, u);
          const o = i * 4;
          d[o] = clamp(tone * lerp(0.80, 1.0, dry), 0, 1) * 255;
          d[o + 1] = clamp(tone * lerp(0.70, 0.93, dry), 0, 1) * 255;
          d[o + 2] = clamp(tone * lerp(0.58, 0.80, dry), 0, 1) * 255;
          d[o + 3] = clamp(a, 0, 1) * 255;
          h[i] = grit * 0.7 + patch * 0.3;
          r[i] = 0.82 + grit * 0.14;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        // Clamped, not repeated: the quad's UVs are exactly 0..1, and with
        // RepeatWrapping the coarse mips bleed the opaque kerb-side column into
        // the transparent outer edge, which puts a hard band along the band.
        map: finish(c, true, this.aniso, false),
        normalMap: normalFromHeight(h, size, 3.2, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  // -- foliage alpha sheets -------------------------------------------------

  /** A single pinnate palm frond, rachis running along +U. */
  palmFrond(size = 512): THREE.Texture {
    return this.alpha('frond', size, (g, s) => {
      const rng = mulberry32(606);
      const midY = s * 0.5;
      // leaflets
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 46; i++) {
          const t = i / 46;
          const x = s * (0.06 + t * 0.9);
          const len = s * 0.44 * Math.sin(Math.pow(t, 0.55) * Math.PI) * (0.82 + rng() * 0.36);
          const droop = Math.pow(t, 1.6) * s * 0.06;
          const ang = side * (0.42 + t * 0.5) + (rng() - 0.5) * 0.18;
          const g0 = 0.22 + t * 0.16 + rng() * 0.08;
          g.strokeStyle = `rgb(${(70 + g0 * 120) | 0},${(120 + g0 * 190) | 0},${(46 + g0 * 70) | 0})`;
          g.lineWidth = s * 0.017 * (0.7 + rng() * 0.6);
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(x, midY + droop);
          g.quadraticCurveTo(x + Math.cos(ang) * len * 0.5 + len * 0.25, midY + droop + Math.sin(ang) * len * 0.45, x + Math.cos(ang) * len * 0.4 + len * 0.5, midY + droop + Math.sin(ang) * len);
          g.stroke();
        }
      }
      // rachis
      const grad = g.createLinearGradient(0, 0, s, 0);
      grad.addColorStop(0, '#7a6a3a');
      grad.addColorStop(0.5, '#8fa348');
      grad.addColorStop(1, '#c8cf72');
      g.strokeStyle = grad;
      g.lineWidth = s * 0.022;
      g.beginPath();
      g.moveTo(s * 0.02, midY);
      g.quadraticCurveTo(s * 0.5, midY + s * 0.02, s * 0.99, midY + s * 0.06);
      g.stroke();
      void rng;
    });
  }

  /** Umbrella-pine needle cluster. */
  pineCluster(size = 512): THREE.Texture {
    return this.alpha('pine', size, (g, s) => {
      const rng = mulberry32(808);
      for (let i = 0; i < 260; i++) {
        const cx = s * (0.08 + rng() * 0.84);
        const cy = s * (0.12 + rng() * 0.76);
        const spread = s * (0.05 + rng() * 0.1);
        const base = 0.3 + rng() * 0.6;
        g.strokeStyle = `rgb(${(38 + base * 60) | 0},${(78 + base * 105) | 0},${(40 + base * 46) | 0})`;
        g.lineWidth = s * 0.006;
        for (let k = 0; k < 9; k++) {
          const a = rng() * Math.PI * 2;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(cx + Math.cos(a) * spread, cy + Math.sin(a) * spread);
          g.stroke();
        }
      }
    });
  }

  /** Broadleaf shrub / hedge mass. */
  shrubLeaves(size = 512): THREE.Texture {
    return this.alpha('shrub', size, (g, s) => {
      const rng = mulberry32(1212);
      for (let i = 0; i < 340; i++) {
        const cx = s * (0.06 + rng() * 0.88);
        const cy = s * (0.08 + rng() * 0.88);
        const rr = s * (0.018 + rng() * 0.034);
        const edge = 1 - Math.max(Math.abs(cx / s - 0.5), Math.abs(cy / s - 0.5)) * 2;
        if (rng() > edge * 1.5 + 0.25) continue;
        const base = 0.25 + rng() * 0.75;
        g.fillStyle = `rgb(${(46 + base * 78) | 0},${(84 + base * 106) | 0},${(38 + base * 52) | 0})`;
        g.save();
        g.translate(cx, cy);
        g.rotate(rng() * 7);
        g.beginPath();
        g.ellipse(0, 0, rr * 1.5, rr, 0, 0, 7);
        g.fill();
        g.restore();
      }
    });
  }

  /** Tuft of grass blades, rooted at the bottom edge. */
  grassBlades(size = 256): THREE.Texture {
    return this.alpha('grass', size, (g, s) => {
      const rng = mulberry32(2424);
      for (let i = 0; i < 26; i++) {
        const x = s * (0.08 + rng() * 0.84);
        const hgt = s * (0.45 + rng() * 0.5);
        const bend = (rng() - 0.5) * s * 0.42;
        const t = rng();
        g.strokeStyle = `rgb(${(88 + t * 52) | 0},${(126 + t * 62) | 0},${(58 + t * 34) | 0})`;
        g.lineWidth = s * (0.016 + rng() * 0.014);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, s);
        g.quadraticCurveTo(x + bend * 0.3, s - hgt * 0.55, x + bend, s - hgt);
        g.stroke();
      }
    });
  }

  /** Geranium / bougainvillea blossom cluster for window boxes. */
  flowers(size = 256): THREE.Texture {
    return this.alpha('flowers', size, (g, s) => {
      const rng = mulberry32(3636);
      const cols = ['#e0453f', '#ff6f8a', '#dcb8d8', '#f5e2b0', '#f2ece0', '#ff9d2e'];
      for (let i = 0; i < 90; i++) {
        const cx = s * (0.1 + rng() * 0.8);
        const cy = s * (0.12 + rng() * 0.76);
        const rr = s * (0.02 + rng() * 0.03);
        g.fillStyle = rng() < 0.42 ? `rgb(${(52 + rng() * 40) | 0},${(104 + rng() * 50) | 0},${(44 + rng() * 26) | 0})` : cols[(rng() * cols.length) | 0];
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2 + rng();
          g.beginPath();
          g.arc(cx + Math.cos(a) * rr * 0.8, cy + Math.sin(a) * rr * 0.8, rr * 0.72, 0, 7);
          g.fill();
        }
      }
    });
  }

  /**
   * Opaque needle surface for the cypress spindle. It has to be opaque: the
   * cypress is a solid form, and wrapping it in a cut-out leaf sheet would
   * either punch holes into a hollow interior or (with alphaTest off) paint it
   * with the transparent canvas's black.
   */
  needleSurface(size = 512): MatMaps {
    return this.memo('needle', () => {
      const [c, g] = cv(size);
      const h = new Float32Array(size * size);
      const r = new Float32Array(size * size);
      const img = g.createImageData(size, size);
      const d = img.data;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = x / size,
            v = y / size;
          const i = y * size + x;
          // sprays: fine vertical streaks broken by clumps
          const spray = fbm(211, u, v, 128, 26, 4);
          const clump = fbm(223, u, v, 14, 10, 3);
          const shade = 0.5 + spray * 0.32 + clump * 0.28;
          h[i] = spray * 0.75 + clump * 0.4;
          const dark = clamp(shade, 0, 1);
          const o = i * 4;
          d[o] = (0.10 + dark * 0.20) * 255;
          d[o + 1] = (0.17 + dark * 0.34) * 255;
          d[o + 2] = (0.08 + dark * 0.16) * 255;
          d[o + 3] = 255;
          r[i] = 0.72 + Math.abs(spray) * 0.2 + clump * 0.08;
        }
      }
      g.putImageData(img, 0, 0);
      return {
        map: finish(c, true, this.aniso),
        normalMap: normalFromHeight(h, size, 26, this.aniso),
        roughnessMap: greyFromField(r, size, this.aniso),
      };
    });
  }

  /** Knotted fishing net — a diamond weave with slack, frayed strands. */
  netWeave(size = 256): THREE.Texture {
    return this.alpha('net', size, (g, s) => {
      const rng = mulberry32(1717);
      g.strokeStyle = '#cbb894';
      g.lineCap = 'round';
      for (let k = 0; k < 2; k++) {
        const dir = k ? 1 : -1;
        for (let i = -8; i < 16; i++) {
          g.lineWidth = s * (0.008 + rng() * 0.006);
          g.beginPath();
          const x0 = (i / 8) * s;
          g.moveTo(x0, 0);
          for (let y = 0; y <= 8; y++) {
            const t = y / 8;
            g.lineTo(x0 + dir * t * s + Math.sin(t * 9 + i) * s * 0.012, t * s);
          }
          g.stroke();
        }
      }
      // knots
      g.fillStyle = '#b8a480';
      for (let i = 0; i < 130; i++) {
        const x = ((rng() * 8) | 0) * (s / 8) + (rng() - 0.5) * 3;
        const y = ((rng() * 8) | 0) * (s / 8) + (rng() - 0.5) * 3;
        g.beginPath();
        g.arc(x, y, s * 0.012, 0, 7);
        g.fill();
      }
    });
  }

  /** Laundry: shirts and sheets on a line, as an alpha strip of 4 cells. */
  laundry(size = 512): THREE.Texture {
    return this.alpha('laundry', size, (g, s) => {
      const cell = s / 4;
      const cols = ['#f2ece0', '#a9c8d4', '#e8a5a0', '#f5e2b0'];
      for (let i = 0; i < 4; i++) {
        const x0 = i * cell;
        g.fillStyle = cols[i];
        g.save();
        g.translate(x0 + cell * 0.5, 0);
        if (i === 0 || i === 2) {
          // shirt
          g.beginPath();
          g.moveTo(-cell * 0.3, cell * 0.06);
          g.lineTo(-cell * 0.42, cell * 0.3);
          g.lineTo(-cell * 0.28, cell * 0.36);
          g.lineTo(-cell * 0.26, s * 0.88);
          g.lineTo(cell * 0.26, s * 0.88);
          g.lineTo(cell * 0.28, cell * 0.36);
          g.lineTo(cell * 0.42, cell * 0.3);
          g.lineTo(cell * 0.3, cell * 0.06);
          g.closePath();
          g.fill();
        } else {
          // sheet / towel with a soft wavy hem
          g.beginPath();
          g.moveTo(-cell * 0.4, cell * 0.04);
          g.lineTo(cell * 0.4, cell * 0.04);
          g.lineTo(cell * 0.36, s * 0.9);
          for (let k = 1; k >= 0; k -= 0.1) g.lineTo(-cell * 0.4 + k * cell * 0.76, s * (0.9 + Math.sin(k * 9) * 0.02));
          g.closePath();
          g.fill();
        }
        g.restore();
        // shading so it isn't a flat silhouette
        const grad = g.createLinearGradient(x0, 0, x0 + cell, 0);
        grad.addColorStop(0, 'rgba(40,30,25,0.30)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.12)');
        grad.addColorStop(1, 'rgba(40,30,25,0.24)');
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = grad;
        g.fillRect(x0, 0, cell, s);
        g.globalCompositeOperation = 'source-over';
      }
    });
  }

  private alphaCache = new Map<string, THREE.Texture>();
  private alpha(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
    let t = this.alphaCache.get(key);
    if (t) return t;
    const [c, g] = cv(size);
    g.clearRect(0, 0, size, size);
    draw(g, size);
    t = finish(c, true, this.aniso, false);
    // premultiply-free alpha edges: keep default; alphaTest handles the cut.
    this.alphaCache.set(key, t);
    return t;
  }
}

// ---------------------------------------------------------------------------
// Geometry construction
// ---------------------------------------------------------------------------

/**
 * Box with flat chamfers on every edge and corner. Hard 90° edges catch no
 * specular and are the second-biggest amateur tell (§5) — this is what the
 * entire built world is made from.
 * UVs are planar per dominant axis so a single tiling texture never stretches.
 */
export function bevelBox(w: number, h: number, d: number, c = 0.035, uvScale = 1): THREE.BufferGeometry {
  const hx = w / 2,
    hy = h / 2,
    hz = d / 2;
  c = Math.min(c, hx * 0.45, hy * 0.45, hz * 0.45);
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const corner = (sx: number, sy: number, sz: number, axis: number) => {
    const x = sx * (axis === 0 ? hx : hx - c);
    const y = sy * (axis === 1 ? hy : hy - c);
    const z = sz * (axis === 2 ? hz : hz - c);
    return [x, y, z] as [number, number, number];
  };
  const tri = (a: number[], b: number[], cc: number[]) => {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = cc[0] - a[0],
      vy = cc[1] - a[1],
      vz = cc[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    // The box is convex and centred on the origin, so "outward" is simply the
    // face centroid direction. Self-orienting here beats hand-deriving the
    // winding for twelve edge quads and eight corner triangles.
    if (nx * (a[0] + b[0] + cc[0]) + ny * (a[1] + b[1] + cc[1]) + nz * (a[2] + b[2] + cc[2]) < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      const t = b;
      b = cc;
      cc = t;
    }
    const ax = Math.abs(nx),
      ay = Math.abs(ny),
      az = Math.abs(nz);
    for (const p of [a, b, cc]) {
      P.push(p[0], p[1], p[2]);
      N.push(nx, ny, nz);
      if (ax >= ay && ax >= az) U.push(p[2] * uvScale, p[1] * uvScale);
      else if (ay >= az) U.push(p[0] * uvScale, p[2] * uvScale);
      else U.push(p[0] * uvScale, p[1] * uvScale);
    }
  };
  const quad = (a: number[], b: number[], cc: number[], dd: number[]) => {
    tri(a, b, cc);
    tri(a, cc, dd);
  };
  // 6 faces
  for (let axis = 0; axis < 3; axis++) {
    for (let s = -1; s <= 1; s += 2) {
      const pts: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const a = i === 0 || i === 3 ? -1 : 1;
        const b = i < 2 ? -1 : 1;
        pts.push(axis === 0 ? corner(s, a * s, b, 0) : axis === 1 ? corner(a, s, b * s, 1) : corner(a * s, b, s, 2));
      }
      quad(pts[0], pts[1], pts[2], pts[3]);
    }
  }
  // 12 edge quads + 8 corner triangles
  for (const [a1, a2] of [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as [number, number][]) {
    const a3 = 3 - a1 - a2;
    for (let s1 = -1; s1 <= 1; s1 += 2)
      for (let s2 = -1; s2 <= 1; s2 += 2) {
        const mk = (s3: number, axis: number) => {
          const s = [0, 0, 0];
          s[a1] = s1;
          s[a2] = s2;
          s[a3] = s3;
          return corner(s[0], s[1], s[2], axis);
        };
        const p0 = mk(-1, a1),
          p1 = mk(-1, a2),
          p2 = mk(1, a2),
          p3 = mk(1, a1);
        // winding depends on the sign product so normals always face out
        if (s1 * s2 * (a1 === 0 && a2 === 1 ? 1 : a1 === 1 && a2 === 2 ? 1 : -1) > 0) quad(p0, p1, p2, p3);
        else quad(p3, p2, p1, p0);
      }
  }
  for (let sx = -1; sx <= 1; sx += 2)
    for (let sy = -1; sy <= 1; sy += 2)
      for (let sz = -1; sz <= 1; sz += 2) {
        const px = corner(sx, sy, sz, 0),
          py = corner(sx, sy, sz, 1),
          pz = corner(sx, sy, sz, 2);
        if (sx * sy * sz > 0) tri(px, py, pz);
        else tri(px, pz, py);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return g;
}

/**
 * Unchamfered 12-triangle box with the same planar UV convention as
 * `bevelBox`. Reserved for parts small enough that a chamfer cannot be
 * resolved on screen — shutter louvres, balusters, tyre tread — where paying
 * 52 triangles times a thousand instances buys nothing.
 */
export function plainBox(w: number, h: number, d: number, uvScale = 1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)),
      ny = Math.abs(nor.getY(i));
    const px = pos.getX(i),
      py = pos.getY(i),
      pz = pos.getZ(i);
    if (nx > 0.5) uv.setXY(i, pz * uvScale, py * uvScale);
    else if (ny > 0.5) uv.setXY(i, px * uvScale, pz * uvScale);
    else uv.setXY(i, px * uvScale, py * uvScale);
  }
  uv.needsUpdate = true;
  return g;
}

export interface Opening {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A facade panel in local XY (outward face at z=0, wall thickness toward -z)
 * with real cut openings and real reveals — windows in this game are recessed
 * geometry, not painted rectangles.
 */
export function wallWithOpenings(w: number, h: number, openings: Opening[], depth = 0.20, uvScale = 0.5): THREE.BufferGeometry {
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const C: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c = 1) => {
    P.push(x, y, z);
    N.push(nx, ny, nz);
    U.push(u, v);
    C.push(c, c, c);
  };
  const quad = (pts: number[][], n: number[], uvs: number[][], cols?: number[]) => {
    for (const i of [0, 1, 2, 0, 2, 3]) push(pts[i][0], pts[i][1], pts[i][2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], cols ? cols[i] : 1);
  };
  // Occlusion baked into the reveal: a 22 cm recess only reads at 40 m if the
  // returns are visibly darker than the face. Head darkest, then the jambs,
  // with the sill catching the low sun.
  const AO_FACE = 1.0;
  const AO_JAMB_LIP = 0.78;
  const AO_JAMB_BACK = 0.34;
  const AO_HEAD_LIP = 0.55;
  const AO_HEAD_BACK = 0.20;
  const AO_SILL_LIP = 0.98;
  const AO_SILL_BACK = 0.62;
  // Grid lines from every opening edge, so the front face tessellates into
  // cells that are either fully solid or fully hole.
  const xs = new Set<number>([0, w]);
  const ys = new Set<number>([0, h]);
  for (const o of openings) {
    xs.add(clamp(o.x, 0, w));
    xs.add(clamp(o.x + o.w, 0, w));
    ys.add(clamp(o.y, 0, h));
    ys.add(clamp(o.y + o.h, 0, h));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  for (let i = 0; i < X.length - 1; i++) {
    for (let j = 0; j < Y.length - 1; j++) {
      const x0 = X[i],
        x1 = X[i + 1],
        y0 = Y[j],
        y1 = Y[j + 1];
      const cx = (x0 + x1) / 2,
        cy = (y0 + y1) / 2;
      if (openings.some((o) => cx > o.x && cx < o.x + o.w && cy > o.y && cy < o.y + o.h)) continue;
      if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) continue;
      quad(
        [
          [x0, y0, 0],
          [x1, y0, 0],
          [x1, y1, 0],
          [x0, y1, 0],
        ],
        [0, 0, 1],
        [
          [x0 * uvScale, y0 * uvScale],
          [x1 * uvScale, y0 * uvScale],
          [x1 * uvScale, y1 * uvScale],
          [x0 * uvScale, y1 * uvScale],
        ]
      );
    }
  }
  // Reveals: four inward-facing strips per opening.
  for (const o of openings) {
    const x0 = o.x,
      x1 = o.x + o.w,
      y0 = o.y,
      y1 = o.y + o.h,
      z = -depth;
    // left (+x normal), right (-x), bottom/sill (+y), head (-y)
    quad(
      [
        [x0, y0, 0],
        [x0, y0, z],
        [x0, y1, z],
        [x0, y1, 0],
      ],
      [1, 0, 0],
      [
        [y0 * uvScale, 0],
        [y0 * uvScale, depth * uvScale],
        [y1 * uvScale, depth * uvScale],
        [y1 * uvScale, 0],
      ],
      [AO_JAMB_LIP, AO_JAMB_BACK, AO_JAMB_BACK * 0.75, AO_JAMB_LIP * 0.8]
    );
    quad(
      [
        [x1, y1, 0],
        [x1, y1, z],
        [x1, y0, z],
        [x1, y0, 0],
      ],
      [-1, 0, 0],
      [
        [y1 * uvScale, 0],
        [y1 * uvScale, depth * uvScale],
        [y0 * uvScale, depth * uvScale],
        [y0 * uvScale, 0],
      ],
      [AO_JAMB_LIP * 0.8, AO_JAMB_BACK * 0.75, AO_JAMB_BACK, AO_JAMB_LIP]
    );
    quad(
      [
        [x1, y0, 0],
        [x1, y0, z],
        [x0, y0, z],
        [x0, y0, 0],
      ],
      [0, 1, 0],
      [
        [x1 * uvScale, 0],
        [x1 * uvScale, depth * uvScale],
        [x0 * uvScale, depth * uvScale],
        [x0 * uvScale, 0],
      ],
      [AO_SILL_LIP, AO_SILL_BACK, AO_SILL_BACK, AO_SILL_LIP]
    );
    quad(
      [
        [x0, y1, 0],
        [x0, y1, z],
        [x1, y1, z],
        [x1, y1, 0],
      ],
      [0, -1, 0],
      [
        [x0 * uvScale, 0],
        [x0 * uvScale, depth * uvScale],
        [x1 * uvScale, depth * uvScale],
        [x1 * uvScale, 0],
      ],
      [AO_HEAD_LIP, AO_HEAD_BACK, AO_HEAD_BACK, AO_HEAD_LIP]
    );
  }
  void AO_FACE;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}

/**
 * Lofts a closed cross-section along a path. Used for palm trunks, boat hulls,
 * mooring ropes and the lighthouse. `radius(t, i)` lets a cross-section breathe
 * along the run so nothing is a plain cylinder.
 */
export function loft(
  path: (t: number, out: THREE.Vector3) => void,
  rings: number,
  sides: number,
  radius: (t: number, ang: number) => number,
  uvRepeat = 1,
  capStart = false,
  capEnd = false
): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3(),
    pPrev = new THREE.Vector3(),
    tan = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const nrmA = new THREE.Vector3(),
    nrmB = new THREE.Vector3();
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    path(t, p);
    path(Math.min(1, t + 1e-3), pPrev);
    tan.subVectors(pPrev, p);
    if (tan.lengthSq() < 1e-9) {
      path(Math.max(0, t - 1e-3), pPrev);
      tan.subVectors(p, pPrev);
    }
    tan.normalize();
    nrmA.copy(Math.abs(tan.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).cross(tan).normalize();
    nrmB.crossVectors(tan, nrmA).normalize();
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const rr = radius(t, a);
      pos.push(p.x + (nrmA.x * Math.cos(a) + nrmB.x * Math.sin(a)) * rr, p.y + (nrmA.y * Math.cos(a) + nrmB.y * Math.sin(a)) * rr, p.z + (nrmA.z * Math.cos(a) + nrmB.z * Math.sin(a)) * rr);
      uv.push((s / sides) * uvRepeat, t * uvRepeat);
    }
  }
  const stride = sides + 1;
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sides; s++) {
      // Wound so the surface normal points away from the path — otherwise
      // every trunk, hull and tower in the game renders inside-out.
      const a = r * stride + s,
        b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const capOf = (ring: number, flip: boolean) => {
    const base = pos.length / 3;
    path(ring === 0 ? 0 : 1, p);
    pos.push(p.x, p.y, p.z);
    uv.push(0.5, 0.5);
    const off = ring * stride;
    for (let s = 0; s < sides; s++) {
      const a = off + s,
        b = off + s + 1;
      if (flip) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  };
  if (capStart) capOf(0, true);
  if (capEnd) capOf(rings, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A single quad in XY, pivot at the bottom centre, for alpha cards. */
export function card(w: number, h: number, uOff = 0, uScale = 1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 1, 3);
  g.translate(0, h / 2, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uOff + uv.getX(i) * uScale);
  uv.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// Merge + instance accumulators — the entire draw-call budget lives here
// ---------------------------------------------------------------------------

const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** Collects transformed geometries into one buffer. Vertex colours carry tint + baked AO. */
export class GeoAccum {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private vcount = 0;
  count = 0;

  /** `aoFn(localY)` bakes contact darkening at the foot of every wall. */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color?: THREE.Color, aoFn?: (x: number, y: number, z: number) => number, uvOff?: THREE.Vector2) {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const u = geo.getAttribute('uv') as THREE.BufferAttribute;
    // Sub-assemblies are built in their own accumulator and folded into a
    // bigger one; their baked tint has to survive that.
    const c0 = geo.getAttribute('color') as THREE.BufferAttribute;
    const index = geo.getIndex();
    _nm.getNormalMatrix(m);
    const base = this.vcount;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      const lx = _v.x,
        ly = _v.y,
        lz = _v.z;
      _v.applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      if (n) {
        _v.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
        this.nrm.push(_v.x, _v.y, _v.z);
      } else this.nrm.push(0, 1, 0);
      if (u) this.uv.push(u.getX(i) + (uvOff ? uvOff.x : 0), u.getY(i) + (uvOff ? uvOff.y : 0));
      else this.uv.push(0, 0);
      const ao = aoFn ? aoFn(lx, ly, lz) : 1;
      const br = c0 ? c0.getX(i) : 1;
      const bg = c0 ? c0.getY(i) : 1;
      const bb = c0 ? c0.getZ(i) : 1;
      if (color) this.col.push(color.r * br * ao, color.g * bg * ao, color.b * bb * ao);
      else this.col.push(br * ao, bg * ao, bb * ao);
    }
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    this.vcount += p.count;
    this.count++;
  }

  build(): THREE.BufferGeometry | null {
    if (!this.vcount) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    // free the JS-side scratch; these arrays are megabytes for the village
    this.pos = this.nrm = this.uv = this.col = this.idx = [];
    return g;
  }
}

export interface InstOpts {
  color?: THREE.Color;
  /** uv scale.xy / offset.xy for atlases and per-instance tiling */
  uv?: THREE.Vector4;
  /** wind: phase, stiffness exponent, reference height, flutter amplitude */
  wind?: THREE.Vector4;
  /** distance in metres past which this instance collapses; 0 = never */
  lod?: number;
  /** bob: amplitude, phase, roll amplitude, unused */
  bob?: THREE.Vector4;
}

/** Accumulates instance transforms; emits one InstancedMesh. */
export class InstSet {
  private mats: THREE.Matrix4[] = [];
  private cols: number[] = [];
  private uvs: number[] = [];
  private winds: number[] = [];
  private lods: number[] = [];
  private bobs: number[] = [];
  private useCol = false;
  private useUv = false;
  private useWind = false;
  private useLod = false;
  private useBob = false;

  constructor(readonly geo: THREE.BufferGeometry, readonly mat: THREE.Material, readonly name: string) {}

  get count() {
    return this.mats.length;
  }

  add(m: THREE.Matrix4, o?: InstOpts) {
    this.mats.push(m.clone());
    if (o?.color) {
      this.useCol = true;
      this.cols.push(o.color.r, o.color.g, o.color.b);
    } else this.cols.push(1, 1, 1);
    if (o?.uv) {
      this.useUv = true;
      this.uvs.push(o.uv.x, o.uv.y, o.uv.z, o.uv.w);
    } else this.uvs.push(1, 1, 0, 0);
    if (o?.wind) {
      this.useWind = true;
      this.winds.push(o.wind.x, o.wind.y, o.wind.z, o.wind.w);
    } else this.winds.push(0, 0, 0, 0);
    if (o?.lod) {
      this.useLod = true;
      this.lods.push(o.lod);
    } else this.lods.push(0);
    if (o?.bob) {
      this.useBob = true;
      this.bobs.push(o.bob.x, o.bob.y, o.bob.z, o.bob.w);
    } else this.bobs.push(0, 0, 0, 0);
  }

  build(castShadow = true, receiveShadow = true): THREE.InstancedMesh | null {
    const n = this.mats.length;
    if (!n) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, n);
    mesh.name = this.name;
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, this.mats[i]);
    mesh.instanceMatrix.needsUpdate = true;
    const attr = (arr: number[], size: number, name: string) => mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(arr), size));
    if (this.useCol) attr(this.cols, 3, 'aTint');
    if (this.useUv) attr(this.uvs, 4, 'aUv');
    if (this.useWind) attr(this.winds, 4, 'aWind');
    if (this.useLod) attr(this.lods, 1, 'aLod');
    if (this.useBob) attr(this.bobs, 4, 'aBob');
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.computeBoundingSphere();
    this.mats = [];
    this.cols = this.uvs = this.winds = this.lods = this.bobs = [];
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// Shared uniforms + shader patch system
// ---------------------------------------------------------------------------

export interface Shared {
  uTime: { value: number };
  uCam: { value: THREE.Vector3 };
  uWindDir: { value: THREE.Vector2 };
  uWindAmp: { value: number };
  uSunView: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  uCheer: { value: number };
  uSeaLevel: { value: number };
}

export function makeShared(): Shared {
  return {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uWindDir: { value: new THREE.Vector2(0.86, 0.51) },
    uWindAmp: { value: 1 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(0xffd9a8) },
    uCheer: { value: 0 },
    uSeaLevel: { value: 0 },
  };
}

type PatchFn = (sh: any, renderer?: any) => void;
interface PatchEntry {
  keys: string[];
  fns: PatchFn[];
}
const PATCHES = new WeakMap<THREE.Material, PatchEntry>();

/**
 * Composable onBeforeCompile. Keys feed customProgramCacheKey.
 *
 * Materials handed to us by the shared library already carry their own
 * onBeforeCompile — that is where its tiling-breakup injection lives. Simply
 * assigning ours would silently drop it and reintroduce a visible one-tile
 * repeat, so the incumbent handler is captured and run first.
 */
export function patch(mat: THREE.Material, key: string, fn: PatchFn) {
  let e = PATCHES.get(mat);
  if (!e) {
    const prior = mat.onBeforeCompile;
    const priorCacheKey = mat.customProgramCacheKey;
    const hasPrior = typeof prior === 'function' && prior !== THREE.Material.prototype.onBeforeCompile;
    let baseKey = '';
    if (hasPrior && typeof priorCacheKey === 'function') {
      try {
        baseKey = 'base:' + priorCacheKey.call(mat);
      } catch {
        baseKey = 'base';
      }
    }
    e = { keys: hasPrior ? [baseKey || 'base'] : [], fns: hasPrior ? [(sh: any, r: any) => (prior as any).call(mat, sh, r)] : [] };
    PATCHES.set(mat, e);
    const entry = e;
    mat.onBeforeCompile = (sh, renderer) => {
      for (const f of entry.fns) f(sh, renderer);
    };
    mat.customProgramCacheKey = () => entry.keys.join('|');
  }
  if (e.keys.indexOf(key) >= 0) return;
  e.keys.push(key);
  e.fns.push(fn);
  mat.needsUpdate = true;
}

const insertBefore = (src: string, token: string, code: string) => src.replace(token, code + '\n' + token);

/** Per-instance UV transform (atlas cells + per-instance tiling density). */
export function patchInstUv(mat: THREE.Material) {
  patch(mat, 'iuv', (sh) => {
    sh.vertexShader = 'attribute vec4 aUv;\n' + sh.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = vMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_NORMALMAP
        vNormalMapUv = vNormalMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_ROUGHNESSMAP
        vRoughnessMapUv = vRoughnessMapUv * aUv.xy + aUv.zw;
      #endif
      #ifdef USE_ALPHAMAP
        vAlphaMapUv = vAlphaMapUv * aUv.xy + aUv.zw;
      #endif`
    );
  });
}

/**
 * Per-instance tint, multiplied over albedo (independent of three's
 * instanceColor so it can be masked). With `maskFromUvX`, only vertices whose
 * uv.x is 1 take the tint — that is how one spectator mesh gets a coloured
 * shirt without repainting the skin.
 */
export function patchTint(mat: THREE.Material, maskFromUvX = false) {
  patch(mat, 'tint' + (maskFromUvX ? 'M' : ''), (sh) => {
    sh.vertexShader =
      'attribute vec3 aTint;\nvarying vec3 vTintI;\n' +
      (maskFromUvX ? 'varying float vTintMask;\n' : '') +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTintI = aTint;' + (maskFromUvX ? '\n  vTintMask = clamp(uv.x, 0.0, 1.0);' : ''));
    sh.fragmentShader =
      'varying vec3 vTintI;\n' +
      (maskFromUvX ? 'varying float vTintMask;\n' : '') +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        maskFromUvX
          ? `#include <color_fragment>
           diffuseColor.rgb *= mix(vec3(1.0), vTintI, vTintMask);`
          : `#include <color_fragment>
           diffuseColor.rgb *= vTintI;`
      );
  });
}

/** Per-instance opacity, for the contact-shadow decals. */
export function patchInstAlpha(mat: THREE.Material) {
  patch(mat, 'ialpha', (sh) => {
    sh.vertexShader = 'attribute vec3 aTint;\nvarying float vIAlpha;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vIAlpha = aTint.r;');
    sh.fragmentShader = 'varying float vIAlpha;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vIAlpha;');
  });
}

/** LOD collapse: instances past `aLod` metres from the camera become degenerate. */
export function patchLod(mat: THREE.Material, u: Shared) {
  patch(mat, 'lod', (sh) => {
    sh.uniforms.uCam = u.uCam;
    sh.vertexShader = 'attribute float aLod;\nuniform vec3 uCam;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         if (aLod > 0.0) {
           vec3 iOrigin = (modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
           float dCam = distance(iOrigin, uCam);
           // fade the last 15% of the range by shrinking, then collapse
           transformed *= 1.0 - smoothstep(aLod * 0.86, aLod, dCam);
         }
       #endif`
    );
  });
}

/**
 * Wind sway. aWind = (phase, stiffness exponent, reference height, flutter).
 * Trunks and their fronds evaluate the identical curve so a palm crown and the
 * fronds attached to it never separate.
 */
export function patchWind(mat: THREE.Material, u: Shared, flutterAxis = 0) {
  patch(mat, 'wind' + flutterAxis, (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uWindDir = u.uWindDir;
    sh.uniforms.uWindAmp = u.uWindAmp;
    sh.vertexShader =
      `attribute vec4 aWind;
       uniform float uTime; uniform vec2 uWindDir; uniform float uWindAmp;
       float kartSway(float phase, float h, float stiff){
         float t = uTime * 1.15 + phase;
         float a = sin(t) * 0.62 + sin(t * 1.73 + 1.3) * 0.27 + sin(t * 3.31 + 2.1) * 0.11;
         return a * pow(max(h, 0.0), stiff) * uWindAmp;
       }\n` +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           float instS = 1.0;
           #ifdef USE_INSTANCING
             instS = length(instanceMatrix[1].xyz);
           #endif
           // A positive reference height lets a detached part (a frond) inherit
           // the sway its parent (the trunk) has at the attachment point. Both
           // work in WORLD metres, and the offset is divided back out through
           // the instance scale, so a crown and its fronds never separate.
           float hRef = aWind.z > 0.0 ? aWind.z : transformed.y * instS;
           float s = kartSway(aWind.x, hRef, max(aWind.y, 0.001)) * 0.09;
           transformed.xz += uWindDir * s / max(instS, 0.001);
           // flutter: high-frequency ripple along the leaf's own length
           float fl = aWind.w * 0.055 * sin(uTime * 5.4 + aWind.x * 3.0 + transformed.${flutterAxis === 0 ? 'x' : 'z'} * 2.6);
           transformed.y += fl;
           transformed.${flutterAxis === 0 ? 'z' : 'x'} += fl * 0.6;
         }`
      );
  });
}

/**
 * Backlit leaf translucency — the low sun through palm fronds (§4: "palms
 * backlit at golden hour is a hero moment, do not waste it").
 *
 * Three terms, and all three matter:
 *   • wrap diffuse `(NdotL + w)/(1 + w)` with w = 0.5, so the terminator wraps
 *     around a one-sided blade instead of clipping at NdotL = 0. This is what
 *     stops a canopy reading as one flat value.
 *   • a back-scatter lobe on `dot(-viewDir, lightDir)^4` — light that has
 *     travelled THROUGH the blade toward the eye.
 *   • a thickness term from the card's own UV: the rachis is opaque, the tips
 *     and the leaflet edges are one cell thick and light up first.
 * Transmitted light is tinted hard toward #b8d84a: chlorophyll absorbs far
 * less in the yellow-green, so a backlit leaf is never just a brighter version
 * of its own albedo.
 */
export function patchTranslucency(mat: THREE.Material, u: Shared, strength = 1.0) {
  patch(mat, 'trans', (sh) => {
    sh.uniforms.uSunView = u.uSunView;
    sh.uniforms.uSunCol = u.uSunCol;
    sh.uniforms.uTransStrength = { value: strength };
    sh.vertexShader = 'varying vec2 vLeafUv;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vLeafUv = uv;');
    sh.fragmentShader =
      'uniform vec3 uSunView; uniform vec3 uSunCol; uniform float uTransStrength;\nvarying vec2 vLeafUv;\n' +
      sh.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           vec3 V = normalize(vViewPosition);
           const float W = 0.5;
           float wrap = clamp((dot(normal, uSunView) + W) / (1.0 + W), 0.0, 1.0);
           float back = pow(clamp(dot(-V, uSunView), 0.0, 1.0), 4.0);
           // clamped so solid-geometry foliage (uv tiles past 1) stays neutral
           float lu = clamp(vLeafUv.x, 0.0, 1.0);
           float lv = clamp(vLeafUv.y, 0.0, 1.0);
           float thin = mix(0.42, 1.0, lu) * mix(0.55, 1.0, abs(lv - 0.5) * 2.0);
           vec3 sap = mix(diffuseColor.rgb, vec3(0.722, 0.847, 0.290), 0.55);
           reflectedLight.directDiffuse += uSunCol * sap * back * 2.2 * thin * uTransStrength;
           reflectedLight.directDiffuse += uSunCol * diffuseColor.rgb * wrap * 0.34 * uTransStrength;
         }`
      );
  });
}

/**
 * Spatially varying roughness (§4: "a constant roughness value reads as plastic
 * and is the #1 tell of an amateur real-time scene"). A texture's roughness map
 * repeats with its own tile; this modulates it with a low-frequency world-space
 * field so one wall is sun-baked and polished and the next is chalky, and the
 * patches do not line up with the texture repeat.
 */
export function patchRoughVary(mat: THREE.Material, lo = 0.72, hi = 1.22, scale = 7.0) {
  patch(mat, 'roughvary' + lo.toFixed(2) + hi.toFixed(2), (sh) => {
    sh.uniforms.uRvScale = { value: 1 / scale };
    sh.uniforms.uRvRange = { value: new THREE.Vector2(lo, hi) };
    sh.vertexShader =
      'varying vec3 vRvPos;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 rvW = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             rvW = instanceMatrix * rvW;
           #endif
           vRvPos = (modelMatrix * rvW).xyz;
         }`
      );
    sh.fragmentShader =
      `varying vec3 vRvPos; uniform float uRvScale; uniform vec2 uRvRange;
       float rvHash(vec2 p){ p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 34.7); return fract(p.x * p.y); }
       float rvNoise(vec2 p){
         vec2 i = floor(p), f = fract(p);
         f = f * f * (3.0 - 2.0 * f);
         return mix(mix(rvHash(i), rvHash(i + vec2(1.0, 0.0)), f.x),
                    mix(rvHash(i + vec2(0.0, 1.0)), rvHash(i + vec2(1.0, 1.0)), f.x), f.y);
       }\n` +
      // Anchored on metalnessmap_fragment, not roughnessmap_fragment: the
      // shared library REPLACES the latter outright for its tiling breakup, so
      // that token no longer exists by the time we run. roughnessFactor is in
      // scope either way, and metalness is the next include along.
      sh.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        `{
           vec2 rp = vRvPos.xz * uRvScale + vRvPos.y * uRvScale * 0.31;
           float rn = rvNoise(rp) * 0.62 + rvNoise(rp * 2.37 + 11.3) * 0.38;
           roughnessFactor = clamp(roughnessFactor * mix(uRvRange.x, uRvRange.y, rn), 0.05, 1.0);
         }
         #include <metalnessmap_fragment>`
      );
  });
}

/** Boats: vertical bob + roll about the instance origin, on the GPU. */
export function patchBob(mat: THREE.Material, u: Shared) {
  patch(mat, 'bob', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = 'attribute vec4 aBob;\nuniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float t = uTime * 0.9 + aBob.y;
         float heave = (sin(t) * 0.7 + sin(t * 1.62 + 1.1) * 0.3) * aBob.x;
         float roll  = sin(t * 0.83 + 0.6) * aBob.z;
         float pitch = sin(t * 1.21 + 2.4) * aBob.z * 0.55;
         float cr = cos(roll), sr = sin(roll);
         float cp = cos(pitch), sp = sin(pitch);
         vec3 q = transformed;
         q = vec3(q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z);
         q = vec3(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
         transformed = q + vec3(0.0, heave, 0.0);
       }`
    );
  });
}

/** Crowd idle + cheer. aWind.x is the per-spectator phase. */
export function patchCrowd(mat: THREE.Material, u: Shared) {
  patch(mat, 'crowd', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uCheer = u.uCheer;
    sh.vertexShader = 'attribute vec4 aWind;\nuniform float uTime; uniform float uCheer;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float ph = aWind.x;
         float idle = sin(uTime * 1.7 + ph) * 0.018 + sin(uTime * 2.9 + ph * 1.7) * 0.008;
         // cheer: a sharp hop, staggered so the stand ripples instead of pulsing
         float ct = fract(uTime * 0.7 + ph * 0.11);
         float hop = max(0.0, sin(ct * 3.14159)) * uCheer * (0.25 + aWind.w * 0.35);
         float sway = sin(uTime * 1.1 + ph * 0.7) * 0.035 * (0.4 + uCheer);
         transformed.y += idle + hop;
         transformed.x += sway * smoothstep(0.4, 1.6, transformed.y);
         // arms up when cheering: the arm verts are flagged via uv.y > 0.92
         transformed.y += step(0.92, uv.y) * uCheer * 0.34;
       }`
    );
  });
}

/** Cloth wave for flags, banners and laundry. */
export function patchCloth(mat: THREE.Material, u: Shared, amp = 1) {
  patch(mat, 'cloth' + amp.toFixed(2), (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uWindAmp = u.uWindAmp;
    sh.uniforms.uClothAmp = { value: amp };
    sh.vertexShader = 'attribute vec4 aWind;\nuniform float uTime; uniform float uWindAmp; uniform float uClothAmp;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         float u0 = uv.x;                     // 0 at the mast / line, 1 at the free edge
         float ph = aWind.x;
         float w = sin(u0 * 7.0 - uTime * 4.2 + ph) * 0.5 + sin(u0 * 12.0 - uTime * 6.7 + ph * 1.7) * 0.22;
         float g = u0 * u0;                   // rooted edge stays put
         transformed.z += w * g * 0.30 * uClothAmp * uWindAmp;
         transformed.y += sin(u0 * 5.0 - uTime * 3.1 + ph) * g * 0.07 * uClothAmp * uWindAmp;
         transformed.x -= g * 0.035 * uClothAmp * abs(w);
       }`
    );
  });
}

/** Gulls: each instance flies its own circle, wings flap. Zero CPU. */
export function patchBird(mat: THREE.Material, u: Shared) {
  patch(mat, 'bird', (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = 'attribute vec4 aBob;\nuniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       {
         // aBob = (orbit radius, angular speed, phase, flap rate)
         float a = uTime * aBob.y + aBob.z;
         float flap = sin(uTime * aBob.w + aBob.z * 3.0);
         // wing dihedral from |uv.x - 0.5|, the span coordinate
         float span = abs(uv.x - 0.5) * 2.0;
         transformed.y += flap * span * span * 0.42;
         transformed.z -= flap * span * 0.06;
         float ca = cos(a), sa = sin(a);
         vec3 q = vec3(transformed.x * ca - transformed.z * sa, transformed.y, transformed.x * sa + transformed.z * ca);
         transformed = q + vec3(sa * aBob.x, sin(a * 2.0 + aBob.z) * 1.6, -ca * aBob.x);
       }`
    );
  });
}

/**
 * Aerial perspective for the distant backdrop. Scene fog is owned by the sky
 * agent and its far plane may be short; the horizon must never go empty, so the
 * backdrop applies its own haze toward the warm horizon colour.
 */
export function patchAerial(mat: THREE.Material, u: Shared, near = 620, far = 2900) {
  patch(mat, 'aerial', (sh) => {
    sh.uniforms.uCam = u.uCam;
    sh.uniforms.uAerial = { value: new THREE.Vector2(near, far) };
    sh.uniforms.uHaze = { value: new THREE.Color(PAL.skyWarm) };
    sh.vertexShader = 'varying vec3 vWorldA;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWorldA = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader =
      'varying vec3 vWorldA; uniform vec3 uCam; uniform vec2 uAerial; uniform vec3 uHaze;\n' +
      sh.fragmentShader.replace(
        '#include <dithering_fragment>',
        `{
           float d = distance(vWorldA, uCam);
           float h = smoothstep(uAerial.x, uAerial.y, d);
           // haze thickens toward the waterline, thins with altitude
           h *= mix(1.0, 0.55, clamp((vWorldA.y - uCam.y) / 220.0, 0.0, 1.0));
           gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze * 1.05, h * 0.78);
         }
         #include <dithering_fragment>`
      );
  });
}

// ---------------------------------------------------------------------------
// Material library
// ---------------------------------------------------------------------------

export class MatLib {
  readonly tex: TexLib;
  private env: THREE.Texture | null = null;
  private all: THREE.Material[] = [];

  wall!: THREE.MeshStandardMaterial;
  roof!: THREE.MeshStandardMaterial;
  trim!: THREE.MeshStandardMaterial;
  wood!: THREE.MeshStandardMaterial;
  woodInst!: THREE.MeshStandardMaterial;
  stone!: THREE.MeshStandardMaterial;
  stoneInst!: THREE.MeshStandardMaterial;
  metal!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshPhysicalMaterial;
  fabric!: THREE.MeshStandardMaterial;
  sponsor!: THREE.MeshStandardMaterial;
  rubber!: THREE.MeshStandardMaterial;
  crowd!: THREE.MeshStandardMaterial;
  cloth!: THREE.MeshStandardMaterial;
  banner!: THREE.MeshStandardMaterial;
  bunting!: THREE.MeshStandardMaterial;
  laundry!: THREE.MeshStandardMaterial;
  rope!: THREE.MeshStandardMaterial;
  backdrop!: THREE.MeshStandardMaterial;
  shadowDecal!: THREE.MeshBasicMaterial;
  vergeDecal!: THREE.MeshStandardMaterial;
  lamp!: THREE.MeshStandardMaterial;
  bird!: THREE.MeshStandardMaterial;
  flowerMat!: THREE.MeshStandardMaterial;
  netMat!: THREE.MeshStandardMaterial;

  constructor(renderer: THREE.WebGLRenderer, readonly u: Shared) {
    this.tex = new TexLib(renderer);
    this.build();
  }

  /**
   * Pull a surface from the material specialist's shared cache. `Ctx` has no
   * slot for that system, so it publishes a module singleton; `variant()` hands
   * back a private clone that shares the texture set, which is the only safe
   * thing to patch. Falls back to our own generator if the call fails — the
   * scenery must not refuse to boot because another module moved underneath it.
   */
  private sharedDown = false;
  private shared(name: string, key: string, tweak?: (m: any) => void): THREE.MeshStandardMaterial | null {
    if (this.sharedDown) return null;
    try {
      const m = getMaterials().variant(name, { key }) as THREE.MeshStandardMaterial;
      if (!m || !(m as any).isMaterial) return null;
      tweak?.(m);
      this.all.push(m);
      return m;
    } catch (e) {
      // One failure means the shared cache cannot build here at all; retrying
      // for every surface would repeat its texture work a dozen times over.
      this.sharedDown = true;
      console.warn('[scenery] shared materials unavailable, using local set', e);
      return null;
    }
  }

  private std(maps: MatMaps, o: Partial<THREE.MeshStandardMaterialParameters> = {}, normalScale = 1): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1.0,
      ...o,
    });
    m.normalScale.set(normalScale, normalScale);
    this.all.push(m);
    return m;
  }

  private build() {
    const T = this.tex;

    // A 14° key on rough plaster, coursed stone or sawn timber should throw a
    // strong micro-shadow. The shared library is tuned for a higher sun; these
    // are OUR clones of it, so raising the normal scale here is safe and is the
    // difference between a painted box and a raked surface.
    const vcN = (n: number) => (m: any) => {
      m.vertexColors = true;
      if (m.normalScale) m.normalScale.set(n, n);
    };
    const nOnly = (n: number) => (m: any) => {
      if (m.normalScale) m.normalScale.set(n, n);
    };
    this.wall = this.shared('stucco', 'scenery-wall', vcN(2.1)) ?? this.std(T.plaster(), { vertexColors: true }, 2.1);
    this.roof = this.shared('roof-tile', 'scenery-roof', vcN(1.9)) ?? this.std(T.roofTile(), { vertexColors: true }, 1.9);
    this.trim = this.shared('marble', 'scenery-trim', vcN(1.5)) ?? this.std(T.stone(), { vertexColors: true }, 1.5);
    patchRoughVary(this.wall, 0.62, 1.28, 8.5);
    patchRoughVary(this.roof, 0.8, 1.15, 6.0);

    this.wood = this.shared('wood-plank', 'scenery-wood', vcN(2.2)) ?? this.std(T.wood(), { vertexColors: true }, 2.2);
    patchRoughVary(this.wood, 0.66, 1.3, 3.2);
    this.woodInst = this.woodVariant();

    this.stone = this.shared('stone-wall', 'scenery-stone', vcN(2.6)) ?? this.std(T.stone(), { vertexColors: true }, 2.6);
    this.stoneInst = this.shared('stone-wall', 'scenery-stone-inst', nOnly(2.6)) ?? this.std(T.stone(), {}, 2.6);
    patchRoughVary(this.stone, 0.7, 1.25, 5.0);
    patchInstUv(this.stoneInst);
    patchTint(this.stoneInst);
    patchLod(this.stoneInst, this.u);

    this.metal = this.shared('metal-painted', 'scenery-metal') ?? this.std(T.paintedMetal(), {}, 0.6);
    patchInstUv(this.metal);
    patchTint(this.metal);
    patchLod(this.metal, this.u);

    // Recessed panes: dark, smooth, and they must catch the env — never a
    // painted rectangle. Slight metalness keeps the reflection crisp.
    this.glass =
      (this.shared('glass', 'scenery-glass', (m: any) => {
        // Recessed panes read as near-black mirrors under a low sun.
        m.color.set(0x1b2b33);
        m.roughness = 0.08;
        m.envMapIntensity = 2.2;
      }) as unknown as THREE.MeshPhysicalMaterial) ??
      new THREE.MeshPhysicalMaterial({
        color: 0x1b2b33,
        roughness: 0.08,
        metalness: 0.25,
        envMapIntensity: 2.2,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
      });
    if (this.all.indexOf(this.glass) < 0) this.all.push(this.glass);
    patchLod(this.glass, this.u);

    this.fabric = this.std(T.fabricAtlas(), { side: THREE.DoubleSide }, 0.5);
    patchInstUv(this.fabric);
    patchLod(this.fabric, this.u);

    this.sponsor = this.std(T.sponsorAtlas(), { side: THREE.FrontSide, vertexColors: true }, 0.4);
    patchInstUv(this.sponsor);
    patchLod(this.sponsor, this.u);

    this.rubber = this.shared('rubber', 'scenery-rubber') ?? this.std(T.paintedMetal(), { color: 0x2b2b30 }, 1.4);
    patchInstUv(this.rubber);
    patchTint(this.rubber);
    patchLod(this.rubber, this.u);

    this.crowd = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
    this.all.push(this.crowd);
    patchTint(this.crowd, true);
    patchCrowd(this.crowd, this.u);
    patchLod(this.crowd, this.u);

    this.cloth = this.std(T.fabricAtlas(), { side: THREE.DoubleSide }, 0.5);
    patchInstUv(this.cloth);
    patchCloth(this.cloth, this.u, 1);
    patchLod(this.cloth, this.u);

    // Start-line banner: its own printed sheet, not a stripe from the atlas.
    this.banner = this.std(T.bannerCloth(), { side: THREE.DoubleSide }, 1.1);
    patchCloth(this.banner, this.u, 1.15);

    // Bunting: one triangle per flag, tinted per instance, strung on a rope.
    this.bunting = new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0, side: THREE.DoubleSide });
    this.all.push(this.bunting);
    patchTint(this.bunting);
    patchCloth(this.bunting, this.u, 0.85);
    patchLod(this.bunting, this.u);

    const lt = T.laundry();
    this.laundry = new THREE.MeshStandardMaterial({ map: lt, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
    this.all.push(this.laundry);
    patchInstUv(this.laundry);
    patchCloth(this.laundry, this.u, 0.5);
    patchLod(this.laundry, this.u);

    this.rope = new THREE.MeshStandardMaterial({ color: 0xc7b088, roughness: 0.95, metalness: 0 });
    this.all.push(this.rope);

    this.backdrop = this.std(T.stone(), { vertexColors: true, roughness: 1 }, 0.35);
    patchAerial(this.backdrop, this.u);

    this.shadowDecal = new THREE.MeshBasicMaterial({
      map: T.contactShadow(),
      transparent: true,
      opacity: 0.44,
      color: 0x33241c,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      fog: true,
      toneMapped: false,
    });
    this.all.push(this.shadowDecal);
    patchInstUv(this.shadowDecal);
    patchInstAlpha(this.shadowDecal);
    patchLod(this.shadowDecal, this.u);

    // Verge transition band. Lit, not unlit: a dirt strip that ignores the key
    // would sit at one value through shadow and sun and read as a painted
    // decal. depthWrite off + polygon offset so it lies on the terrain without
    // fighting it, and it never casts.
    this.vergeDecal = this.std(T.vergeScuff(), { transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -5 }, 1.8);
    patchLod(this.vergeDecal, this.u);

    this.flowerMat = this.foliage(T.flowers(), { alphaTest: 0.4, trans: 0.9, wind: true });
    this.netMat = new THREE.MeshStandardMaterial({ map: T.netWeave(), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
    this.all.push(this.netMat);
    patchTint(this.netMat);
    patchLod(this.netMat, this.u);

    this.lamp = new THREE.MeshStandardMaterial({ color: 0xfff0cc, emissive: 0xffc46b, emissiveIntensity: 3.2, roughness: 0.4, metalness: 0 });
    this.all.push(this.lamp);
    patchLod(this.lamp, this.u);

    this.bird = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
    this.all.push(this.bird);
    patchBird(this.bird, this.u);
    patchTint(this.bird);
  }

  /**
   * A fresh instanced-timber material. Callers that need extra vertex work
   * (the moored boats bob on the GPU) must not patch the shared one.
   */
  woodVariant(key = 'scenery-wood-inst-' + this.variantSeq++): THREE.MeshStandardMaterial {
    const m =
      this.shared('wood-plank', key, (mm: any) => {
        if (mm.normalScale) mm.normalScale.set(2.2, 2.2);
      }) ?? this.std(this.tex.wood(), {}, 2.2);
    patchInstUv(m);
    patchTint(m);
    // resin-sealed vs weathered-grey: a plank-scale roughness split so the
    // start arch is not one uniform gloss (§4)
    patchRoughVary(m, 0.62, 1.34, 2.4);
    patchLod(m, this.u);
    return m;
  }

  private variantSeq = 0;

  /** Foliage materials are built on demand because Foliage owns their textures. */
  foliage(map: THREE.Texture, opts: { alphaTest?: number; trans?: number; wind?: boolean; lod?: boolean; color?: number } = {}): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      map,
      color: opts.color ?? 0xffffff,
      alphaTest: opts.alphaTest ?? 0.42,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0,
      // Leaves are thin: flipping the normal on backfaces keeps them lit from
      // whichever side the sun is actually on.
      shadowSide: THREE.DoubleSide,
    });
    this.all.push(m);
    patchTint(m);
    patchTranslucency(m, this.u, opts.trans ?? 1);
    if (opts.wind !== false) patchWind(m, this.u);
    if (opts.lod !== false) patchLod(m, this.u);
    return m;
  }

  register(m: THREE.Material) {
    this.all.push(m);
  }

  /** Sky agent produces the env map after us on some quality paths; adopt it late. */
  setEnv(env: THREE.Texture | null) {
    if (env === this.env) return;
    this.env = env;
    for (const m of this.all) {
      const a = m as any;
      if ('envMap' in a) {
        a.envMap = env;
        a.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const m of this.all) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Prop generators
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export function trs(px: number, py: number, pz: number, ry: number, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): THREE.Matrix4 {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  return _m.compose(_v.set(px, py, pz), _q, _s.set(sx, sy, sz)).clone();
}

// --- village house ---------------------------------------------------------

export interface HouseParts {
  walls: GeoAccum;
  roof: GeoAccum;
  trim: GeoAccum;
  shutters: { m: THREE.Matrix4; color: THREE.Color; uv: THREE.Vector4 }[];
  glass: THREE.Matrix4[];
  balcony: THREE.Matrix4[];
  flowerbox: { m: THREE.Matrix4; color: THREE.Color }[];
  awning: { m: THREE.Matrix4; uv: THREE.Vector4 }[];
  door: { m: THREE.Matrix4; color: THREE.Color }[];
  lamp: THREE.Matrix4[];
  /** world anchors for laundry lines: (position, height) */
  lineAnchors: THREE.Vector3[];
}

/** Pass the shared accumulators so a whole street merges into three meshes. */
export function newHouseParts(walls?: GeoAccum, roof?: GeoAccum, trim?: GeoAccum): HouseParts {
  return {
    walls: walls ?? new GeoAccum(),
    roof: roof ?? new GeoAccum(),
    trim: trim ?? new GeoAccum(),
    shutters: [],
    glass: [],
    balcony: [],
    flowerbox: [],
    awning: [],
    door: [],
    lamp: [],
    lineAnchors: [],
  };
}

/**
 * Wall AO for a building of known height: contact darkening at the base AND an
 * eave shadow under the roof overhang. Without the second term the roofline is
 * a hard line and the roof reads as pasted onto the wall (§9.4).
 */
const wallAOFor = (h: number) => (_x: number, y: number, _z: number) =>
  lerp(0.42, 1, smoothstep(0, 1.6, y)) * lerp(0.5, 1, smoothstep(h, h - 1.0, y));

/**
 * Gable end: the triangle between the wall head and the underside of the two
 * roof slopes, extruded `thick` along X. Without this the roof is two floating
 * slabs with an open triangular void at each end, which is precisely what
 * makes a hipped-box village read as flat planes hovering over the walls.
 */
function gableWedge(halfZ: number, rise: number, thick: number): THREE.BufferGeometry {
  const hx = thick / 2;
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const idx: number[] = [];
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    const base = P.length / 3;
    for (const v of [a, b, c]) {
      P.push(v[0], v[1], v[2]);
      N.push(n[0], n[1], n[2]);
      // planar UV off the ZY plane so the plaster does not stretch
      U.push(v[2] * 0.42, v[1] * 0.42);
    }
    idx.push(base, base + 1, base + 2);
  };
  for (const s of [-1, 1]) {
    const x = s * hx;
    const a = [x, 0, -halfZ];
    const b = [x, 0, halfZ];
    const c = [x, rise, 0];
    if (s > 0) tri(a, b, c, [1, 0, 0]);
    else tri(b, a, c, [-1, 0, 0]);
  }
  // two sloping faces closing the wedge sides, and the flat bottom
  const q = (a: number[], b: number[], c: number[], dd: number[], n: number[]) => {
    tri(a, b, c, n);
    tri(a, c, dd, n);
  };
  const sl = Math.hypot(halfZ, rise);
  q([-hx, 0, halfZ], [hx, 0, halfZ], [hx, rise, 0], [-hx, rise, 0], [0, halfZ / sl, rise / sl]);
  q([hx, 0, -halfZ], [-hx, 0, -halfZ], [-hx, rise, 0], [hx, rise, 0], [0, halfZ / sl, -rise / sl]);
  q([-hx, 0, -halfZ], [hx, 0, -halfZ], [hx, 0, halfZ], [-hx, 0, halfZ], [0, -1, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  return g;
}

/** Warm terracotta multipliers for the roof map — never the wall pastel. */
const ROOF_MULT: [number, number, number][] = [
  [0.040, 0.16, 0.86],
  [0.028, 0.24, 0.74],
  [0.055, 0.13, 0.94],
  [0.020, 0.28, 0.66],
  [0.045, 0.20, 0.80],
];

/**
 * Terraced Mediterranean house. Emits merged wall/roof/trim geometry into the
 * shared accumulators and pushes its fittings into shared instance lists, so a
 * street of thirty houses is still a dozen draw calls.
 *
 * `xform` places the house: +Z is the street-facing facade.
 */
export function buildHouse(out: HouseParts, rng: RNG, xform: THREE.Matrix4, w: number, d: number, floors: number, tint: THREE.Color) {
  const floorH = 3.05 + rng() * 0.35;
  const h = floorH * floors + 0.45;
  const wAO = wallAOFor(h);
  const openings: Opening[] = [];
  const winW = 0.95 + rng() * 0.25;
  const winH = 1.55 + rng() * 0.3;
  const cols = Math.max(2, Math.round((w - 1.0) / 2.3));
  const doorCol = (rng() * cols) | 0;
  const winPos: { x: number; y: number; f: number; c: number }[] = [];
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + 0.5) / cols) * w - w / 2;
      if (f === 0 && c === doorCol) {
        // a door instead of a window
        openings.push({ x: x - 0.55, y: 0.02, w: 1.1, h: 2.3 });
        continue;
      }
      const y = f * floorH + 1.05;
      openings.push({ x: x - winW / 2, y, w: winW, h: winH });
      winPos.push({ x, y, f, c });
    }
  }
  // Facade with real reveals + three plain sides.
  const facade = wallWithOpenings(w, h, openings.map((o) => ({ x: o.x + w / 2, y: o.y, w: o.w, h: o.h })), 0.22, 0.42);
  facade.translate(-w / 2, 0, d / 2);
  const rearAndSides = new GeoAccum();
  const back = bevelBox(w, h, 0.3, 0.05, 0.42);
  rearAndSides.add(back, trs(0, h / 2, -d / 2 + 0.15, 0), undefined, wAO);
  const side = bevelBox(0.3, h, d - 0.3, 0.05, 0.42);
  rearAndSides.add(side, trs(-w / 2 + 0.15, h / 2, 0, 0), undefined, wAO);
  rearAndSides.add(side, trs(w / 2 - 0.15, h / 2, 0, 0), undefined, wAO);
  // interior floor slab so you never see through an opening into nothing
  rearAndSides.add(bevelBox(w - 0.4, 0.2, d - 0.4, 0.02, 0.42), trs(0, h - 0.4, 0, 0), undefined, () => 0.32);

  out.walls.add(facade, xform, tint, wAO);
  const rs = rearAndSides.build();
  if (rs) out.walls.add(rs, xform, tint, undefined);

  // --- roof: two real slabs with thickness, closed gables and capped eaves.
  // The eave overhang runs front/back only; the gable overhang is deliberately
  // tiny so a terrace of houses at 0.5 m centres never has one roof punching
  // through its neighbour's wall.
  const pitch = 0.38 + rng() * 0.14;
  const overZ = 0.46;
  const overX = 0.13;
  const halfZ = d / 2 + overZ;
  const rise = halfZ * pitch;
  const slopeLen = Math.hypot(halfZ, rise);
  const thick = 0.3;
  const rm = ROOF_MULT[(rng() * ROOF_MULT.length) | 0];
  const roofCol = new THREE.Color().setHSL(rm[0], rm[1] * (0.7 + rng() * 0.6), rm[2] * (0.82 + rng() * 0.26));
  // Gable ends first: they close the triangular void the two slopes leave.
  const gab = gableWedge(halfZ - 0.04, rise, 0.26);
  for (const s of [-1, 1]) out.walls.add(gab, _m.multiplyMatrices(xform, trs((s * w) / 2, h, 0, 0)).clone(), tint, () => 0.62);
  // Slopes. Sitting the slab so its UNDERSIDE meets the wall head means the
  // fascia thickness reads at the eave instead of a zero-thickness edge.
  //
  // SIGN MATTERS. Rx(+t) sends local +Z to (0, -sin t, cos t), so the slab on
  // the +Z side needs Rx(+ang) to fall AWAY from the ridge. With the sign
  // inverted the pair slopes up toward the eaves instead of down: a butterfly
  // roof, with the ridge cap and the gable wedge both two metres out of place —
  // which is exactly the "flat planes hovering over the wall tops" read.
  const slab = bevelBox(w + overX * 2, thick, slopeLen, 0.04, 0.9);
  const ang = Math.atan2(rise, halfZ);
  for (const s of [-1, 1]) {
    const mm = new THREE.Matrix4().compose(
      new THREE.Vector3(0, h + rise / 2 + (thick / 2) * Math.cos(ang), (s * halfZ) / 2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(s * ang, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    );
    // darken toward the eave: the underside of the overhang is in shadow and
    // the ridge catches the low sun
    out.roof.add(slab, _m.multiplyMatrices(xform, mm).clone(), roofCol, (_x, y) => lerp(0.68, 1.0, smoothstep(-thick * 0.5, thick * 0.5, y)));
  }
  // Ridge cap, straddling the seam where the two slab TOP faces meet. A slab of
  // perpendicular thickness `thick` laid at `ang` puts its top surface
  // thick/cos(ang) above the underside plane at the ridge, so a cap parked at
  // rise + thick/2 is buried inside the roof and the seam shows through.
  const halfWr = w / 2 + overX;
  const ridgeY = h + rise + thick / Math.cos(ang) + 0.03;
  const ridge = loft((t, o) => o.set(-halfWr + t * halfWr * 2, 0, 0), 3, 8, () => 0.17, 1.4, true, true);
  out.roof.add(ridge, _m.multiplyMatrices(xform, trs(0, ridgeY, 0, 0)).clone(), roofCol.clone().multiplyScalar(1.08));
  // Stone eave band at the wall head. It is narrower than the roof and warm,
  // not white — a white slab wider than the roof is what read as a floating
  // plate in round 1.
  const corn = bevelBox(w + 0.18, 0.15, d + 0.18, 0.035, 0.7);
  out.trim.add(corn, _m.multiplyMatrices(xform, trs(0, h - 0.075, 0, 0)).clone(), new THREE.Color(0xd7c9b0), (_x, y) => lerp(0.55, 1.0, smoothstep(-0.075, 0.02, y)));

  // --- chimney, standing on the ridge so it reads against the sky
  if (rng() < 0.75) {
    const cw = 0.5 + rng() * 0.22;
    const cx = (rng() - 0.5) * (w - 1.6);
    const ch = 1.1 + rng() * 1.0;
    const cy = h + rise * 0.86;
    out.walls.add(bevelBox(cw, ch, cw, 0.04, 0.9), _m.multiplyMatrices(xform, trs(cx, cy + ch / 2 - 0.25, 0.12, 0)).clone(), tint, () => 0.85);
    out.trim.add(bevelBox(cw + 0.2, 0.14, cw + 0.2, 0.03, 1.2), _m.multiplyMatrices(xform, trs(cx, cy + ch - 0.28, 0.12, 0)).clone(), new THREE.Color(0xd9c9b2));
  }

  // --- window fittings
  const shutterCol = new THREE.Color(pick(rng, PAL.shutters));
  // Stains and cast shadows keep the wall's own hue — a neutral grey smear on
  // a pink wall reads as a decal, not as weathering.
  const DRIP = tint.clone().multiplyScalar(0.8).lerp(new THREE.Color(0x9a8b76), 0.42);
  const HEADSHADE = tint.clone().multiplyScalar(0.55).lerp(new THREE.Color(0x5f6070), 0.34);
  for (const wp of winPos) {
    const z = d / 2 + 0.01;
    // Head shadow: a 22 cm strip immediately under the lintel. A 22 cm reveal
    // cannot self-shadow at 60 m, so the shadow it WOULD cast is painted.
    const hs = new THREE.PlaneGeometry(winW + 0.08, 0.24, 1, 1);
    out.walls.add(hs, _m.multiplyMatrices(xform, trs(wp.x, wp.y + winH + 0.12, z + 0.004, 0)).clone(), HEADSHADE, (_x, y) => lerp(1.0, 0.42, smoothstep(-0.12, 0.12, y)));
    // Sill drip stain: runoff tracks off the two sill ends, never a rectangle.
    for (const s of [-1, 1]) {
      const dg = new THREE.PlaneGeometry(0.2, 1.05, 1, 1);
      out.walls.add(dg, _m.multiplyMatrices(xform, trs(wp.x + s * (winW / 2 + 0.11), wp.y - 0.62, z + 0.004, 0)).clone(), DRIP, (_x, y) => lerp(0.66, 1.0, smoothstep(-0.52, 0.5, -y)) * 0.96);
    }
    // stone sill, with a 8 cm drip lip the low sun catches
    out.trim.add(bevelBox(winW + 0.34, 0.1, 0.3, 0.02, 1.4), _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.06, z + 0.06, 0)).clone(), new THREE.Color(0xe8dfce));
    out.trim.add(bevelBox(winW + 0.4, 0.06, 0.08, 0.015, 2.2), _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.13, z + 0.19, 0)).clone(), new THREE.Color(0xdccfba));
    // recessed glass, sitting at the back of the reveal
    out.glass.push(_m.multiplyMatrices(xform, trs(wp.x, wp.y + winH / 2, z - 0.20, 0, winW * 0.94, winH * 0.94, 1)).clone());
    // shutters, one per side, occasionally swung open
    const openA = rng() < 0.4 ? 0.6 + rng() * 0.7 : 0.02;
    for (const s of [-1, 1]) {
      const hingeX = wp.x + s * (winW / 2 + 0.02);
      const mm = new THREE.Matrix4()
        .compose(new THREE.Vector3(hingeX, wp.y + winH / 2, z + 0.03), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -s * openA, 0)), new THREE.Vector3(1, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation((-s * winW) / 4, 0, 0))
        .multiply(new THREE.Matrix4().makeScale(winW / 2, winH, 1));
      out.shutters.push({ m: _m.multiplyMatrices(xform, mm).clone(), color: shutterCol, uv: new THREE.Vector4(0.5, 1, 0, 0) });
    }
    // flower box on the ground and first floors
    if (wp.f < 2 && rng() < 0.62) {
      out.flowerbox.push({ m: _m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.02, z + 0.16, 0, winW / 1.0, 1, 1)).clone(), color: new THREE.Color(pick(rng, [0x8a5a3a, 0x6d6f57, 0xa8927a])) });
    }
    // balcony on upper floors
    if (wp.f >= 1 && rng() < 0.45) {
      out.balcony.push(_m.multiplyMatrices(xform, trs(wp.x, wp.y - 0.06, z + 0.05, 0, Math.max(1, winW + 0.6), 1, 1)).clone());
      if (rng() < 0.6) out.lineAnchors.push(new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(xform, trs(wp.x, wp.y + winH, z + 0.6, 0)).clone()));
    }
  }
  // doors + awning + lamp
  const dx = ((doorCol + 0.5) / cols) * w - w / 2;
  out.door.push({ m: _m.multiplyMatrices(xform, trs(dx, 0.02, d / 2 - 0.06, 0, 1.06, 2.24, 1)).clone(), color: new THREE.Color(pick(rng, PAL.shutters)) });
  out.trim.add(bevelBox(1.5, 0.16, 0.34, 0.03, 1.3), _m.multiplyMatrices(xform, trs(dx, 2.36, d / 2 + 0.1, 0)).clone(), new THREE.Color(0xe8dfce));
  if (rng() < 0.45) {
    const cell = (rng() * 4) | 0;
    out.awning.push({ m: _m.multiplyMatrices(xform, trs(dx, 2.6, d / 2 + 0.02, 0, 1.9 + rng() * 0.8, 1, 1)).clone(), uv: new THREE.Vector4(0.25, 0.25, cell * 0.25, ((rng() * 4) | 0) * 0.25) });
  }
  if (rng() < 0.5) out.lamp.push(_m.multiplyMatrices(xform, trs(dx + 0.95, 2.9, d / 2 + 0.06, 0)).clone());
  // front steps where the door sits above grade
  out.trim.add(bevelBox(1.7, 0.16, 0.4, 0.02, 1.1), _m.multiplyMatrices(xform, trs(dx, -0.06, d / 2 + 0.2, 0)).clone(), new THREE.Color(0xd6cbb6));
  out.trim.add(bevelBox(2.0, 0.16, 0.6, 0.02, 1.1), _m.multiplyMatrices(xform, trs(dx, -0.2, d / 2 + 0.42, 0)).clone(), new THREE.Color(0xd6cbb6));

  if (rng() < 0.5) out.lineAnchors.push(new THREE.Vector3().setFromMatrixPosition(_m.multiplyMatrices(xform, trs((rng() - 0.5) * w * 0.7, h - 1.2, d / 2 + 0.25, 0)).clone()));
}

// --- reusable prop geometries ---------------------------------------------

/** Louvred shutter, unit sized (1 x 1) so instances can scale it to any window. */
export function shutterGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  // The panel is the only part big enough for a chamfer to read; the louvres
  // are 7 cm deep and there are nearly a thousand of these in the village.
  acc.add(bevelBox(1, 1, 0.06, 0.012, 1.6), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  const slat = plainBox(0.88, 0.08, 0.05, 3);
  for (let i = 0; i < 5; i++) {
    const y = -0.4 + (i / 4) * 0.8;
    acc.add(slat, trs(0, y, 0.045, 0, 1, 1, 1, -0.34), new THREE.Color(0.88, 0.88, 0.88));
  }
  const rail = plainBox(0.94, 0.07, 0.075, 3);
  acc.add(rail, trs(0, 0.46, 0.02, 0), new THREE.Color(1, 1, 1));
  acc.add(rail, trs(0, -0.46, 0.02, 0), new THREE.Color(1, 1, 1));
  return acc.build()!;
}

export function doorGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(bevelBox(1, 1, 0.08, 0.014, 1.4).translate(0, 0.5, 0), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  for (const y of [0.28, 0.68]) {
    acc.add(bevelBox(0.66, 0.28, 0.045, 0.012, 3), trs(0, y, 0.05, 0), new THREE.Color(0.82, 0.82, 0.82));
  }
  return acc.build()!;
}

export function balconyGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(1, 0.09, 0.72, 0.02, 1.6), trs(0, 0, 0.3, 0), white); // slab
  acc.add(bevelBox(1, 0.055, 0.055, 0.014, 4), trs(0, 0.92, 0.64, 0), white); // handrail
  const lowRail = plainBox(1, 0.04, 0.04, 4);
  acc.add(lowRail, trs(0, 0.3, 0.64, 0), white);
  const post = plainBox(0.045, 0.94, 0.045, 4);
  const baluster = plainBox(0.03, 0.9, 0.03, 6);
  for (const s of [-1, 1]) {
    acc.add(post, trs(s * 0.47, 0.47, 0.64, 0), white);
    acc.add(post, trs(s * 0.47, 0.46, 0.02, 0), white);
    acc.add(plainBox(0.045, 0.05, 0.66, 4), trs(s * 0.47, 0.92, 0.32, 0), white);
    acc.add(plainBox(0.1, 0.22, 0.3, 3), trs(s * 0.4, -0.14, 0.14, 0), white); // corbel
  }
  for (let i = 0; i < 7; i++) acc.add(baluster, trs(-0.42 + (i / 6) * 0.84, 0.46, 0.64, 0), white);
  return acc.build()!;
}

export function flowerBoxGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(bevelBox(1, 0.26, 0.28, 0.02, 2.4), trs(0, 0.13, 0, 0), new THREE.Color(1, 1, 1));
  return acc.build()!;
}

export function awningGeo(): THREE.BufferGeometry {
  // Slightly scalloped, sagging canvas — never a flat plane.
  const segs = 10;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const rows = 4;
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const scallop = j === rows ? Math.sin(u * Math.PI * 5) * 0.05 : 0;
      const sag = Math.sin(u * Math.PI) * 0.06 * v;
      pos.push((u - 0.5) * 1.0, -v * 0.62 - sag + scallop * 0.3, v * 0.95);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + segs + 1, a + 1, a + 1, a + segs + 1, a + segs + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function lampGeo(): { arm: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(0.06, 0.06, 0.5, 0.015, 6), trs(0, 0, 0.24, 0), w);
  acc.add(bevelBox(0.05, 0.3, 0.05, 0.012, 6), trs(0, -0.16, 0.46, 0), w);
  acc.add(bevelBox(0.26, 0.06, 0.26, 0.015, 5), trs(0, -0.02, 0.46, 0), w);
  return { arm: acc.build()!, glow: bevelBox(0.17, 0.24, 0.17, 0.05, 4).translate(0, -0.44, 0.46) };
}

// --- harbour ---------------------------------------------------------------

/** Lofted boat hull: real cross-sections, rounded chine, sheer line. */
export function hullGeo(len: number, beam: number, depth: number, kind: number): THREE.BufferGeometry {
  const rings = 22,
    sides = 14;
  return loft(
    (t, o) => {
      const z = (t - 0.5) * len;
      // sheer: the deck line rises toward bow and stern
      const sheer = Math.pow(Math.abs(t - 0.5) * 2, 2.2) * depth * 0.28;
      o.set(0, sheer, z);
    },
    rings,
    sides,
    (t, a) => {
      // waterline plan: fine bow, full midships, transom aft
      const bow = smoothstep(1.0, 0.72, t);
      const stern = kind === 0 ? smoothstep(0.0, 0.16, t) : smoothstep(0.0, 0.30, t);
      const plan = Math.pow(Math.sin(clamp(t, 0, 1) * Math.PI), 0.42) * bow * stern;
      // cross-section: rounded V, deeper amidships
      const s = Math.sin(a),
        c = Math.cos(a);
      const vShape = 1 - Math.pow(clamp(-s, 0, 1), 1.7) * 0.35;
      const r = plan * (0.5 + 0.5 * Math.abs(c)) * beam * 0.5 * vShape;
      const rv = plan * depth * 0.5 * (s < 0 ? 1.0 : 0.72);
      return Math.hypot(r * c, rv * s) * 0.5 + (r * 0.5 + Math.abs(rv) * 0.5) * 0.5;
    },
    2,
    true,
    true
  );
}

export function boatGeo(rng: RNG, kind: number): { hull: THREE.BufferGeometry; rig: THREE.BufferGeometry } {
  const len = kind === 0 ? 6.4 + rng() * 2.6 : 9.5 + rng() * 4.0;
  const beam = len * (0.3 + rng() * 0.06);
  const depth = len * 0.19;
  const hullAcc = new GeoAccum();
  const h = hullGeo(len, beam, depth, kind);
  hullAcc.add(h, trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  // gunwale rubbing strake
  const strake = loft(
    (t, o) => {
      const z = (t - 0.5) * len * 0.98;
      o.set(0, Math.pow(Math.abs(t - 0.5) * 2, 2.2) * depth * 0.28 + depth * 0.34, z);
    },
    18,
    6,
    (t) => 0.06 * Math.pow(Math.sin(clamp(t, 0, 1) * Math.PI), 0.3),
    2
  );
  void strake;
  const rigAcc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  // deck
  hullAcc.add(bevelBox(beam * 0.82, 0.08, len * 0.72, 0.02, 1.6), trs(0, depth * 0.36, 0, 0), new THREE.Color(0.82, 0.78, 0.7));
  if (kind === 0) {
    // open launch: thwarts, small cuddy, outboard
    for (let i = 0; i < 3; i++) rigAcc.add(bevelBox(beam * 0.7, 0.07, 0.28, 0.015, 3), trs(0, depth * 0.42, (i - 1) * len * 0.2, 0), w);
    rigAcc.add(bevelBox(beam * 0.62, 0.62, len * 0.2, 0.04, 1.2), trs(0, depth * 0.36 + 0.31, len * 0.24, 0), w);
    rigAcc.add(bevelBox(0.22, 0.5, 0.34, 0.05, 3), trs(0, depth * 0.3, -len * 0.46, 0), new THREE.Color(0.35, 0.35, 0.38));
  } else {
    // cabin cruiser / fishing boat: wheelhouse, mast, boom, davits
    rigAcc.add(bevelBox(beam * 0.66, 1.15, len * 0.26, 0.05, 1.1), trs(0, depth * 0.36 + 0.58, len * 0.06, 0), w);
    rigAcc.add(bevelBox(beam * 0.5, 0.1, len * 0.22, 0.02, 1.6), trs(0, depth * 0.36 + 1.2, len * 0.06, 0), new THREE.Color(0.88, 0.86, 0.8));
    const mast = loft((t, o) => o.set(0, t * (len * 0.62), 0), 4, 7, (t) => 0.075 * (1 - t * 0.45), 2, true, true);
    rigAcc.add(mast, trs(0, depth * 0.42, -len * 0.06, 0), w);
    rigAcc.add(bevelBox(0.09, 0.09, len * 0.34, 0.02, 4), trs(0, depth * 0.42 + len * 0.2, -len * 0.2, 0), w);
  }
  return { hull: hullAcc.build()!, rig: rigAcc.build()! };
}

export function bollardGeo(): THREE.BufferGeometry {
  // Cast-iron mooring bollard: chamfered, mushroom head, base flange.
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const body = loft((t, o) => o.set(0, t * 0.62, 0), 6, 12, (t) => 0.16 - t * 0.035 + Math.pow(t, 6) * 0.02, 1.4, true, false);
  acc.add(body, trs(0, 0, 0, 0), w);
  const head = loft((t, o) => o.set(0, 0.6 + t * 0.16, 0), 5, 12, (t) => 0.145 + Math.sin(t * Math.PI) * 0.075, 1.2, false, true);
  acc.add(head, trs(0, 0, 0, 0), w);
  acc.add(loft((t, o) => o.set(0, t * 0.07, 0), 2, 12, () => 0.24, 1, true, true), trs(0, 0, 0, 0), new THREE.Color(0.85, 0.85, 0.85));
  return acc.build()!;
}

export function crateGeo(rng: RNG): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const w = 0.6 + rng() * 0.35,
    h = 0.42 + rng() * 0.3,
    d = 0.5 + rng() * 0.3;
  acc.add(bevelBox(w, h, d, 0.02, 1.8), trs(0, h / 2, 0, 0), new THREE.Color(1, 1, 1));
  // batten frame
  const c2 = new THREE.Color(0.86, 0.82, 0.74);
  for (const s of [-1, 1]) {
    acc.add(bevelBox(w + 0.03, 0.07, 0.06, 0.012, 4), trs(0, h * (0.5 + s * 0.34), d / 2, 0), c2);
    acc.add(bevelBox(0.06, h, 0.06, 0.012, 4), trs(s * (w / 2 - 0.04), h / 2, d / 2, 0), c2);
  }
  return acc.build()!;
}

export function barrelGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(loft((t, o) => o.set(0, t * 0.82, 0), 8, 14, (t) => 0.26 + Math.sin(t * Math.PI) * 0.055, 2, true, true), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  for (const y of [0.16, 0.41, 0.66]) acc.add(loft((t, o) => o.set(0, y + t * 0.05, 0), 1, 14, () => 0.29, 1.5), trs(0, 0, 0, 0), new THREE.Color(0.5, 0.44, 0.36));
  return acc.build()!;
}

/** Draped fishing net: a sagging quad grid with a wide alpha weave. */
export function netGeo(w: number, h: number): THREE.BufferGeometry {
  const nx = 8,
    ny = 6;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const u = i / nx,
        v = j / ny;
      const sag = Math.sin(u * Math.PI) * 0.25 * v;
      pos.push((u - 0.5) * w, -v * h - sag, Math.sin(u * Math.PI * 2) * 0.12 * v);
      uv.push(u * 3, v * 3);
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Catenary rope between two points, as a real tube. */
export function ropeGeo(a: THREE.Vector3, b: THREE.Vector3, sag: number, radius = 0.035): THREE.BufferGeometry {
  return loft(
    (t, o) => {
      o.lerpVectors(a, b, t);
      o.y -= Math.sin(t * Math.PI) * sag;
    },
    10,
    5,
    () => radius,
    1
  );
}

export function tyreGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const tor = new THREE.TorusGeometry(0.34, 0.13, 6, 14);
  tor.rotateX(Math.PI / 2);
  acc.add(tor, trs(0, 0.13, 0, 0), new THREE.Color(1, 1, 1));
  // tread band so it isn't a smooth donut
  const block = plainBox(0.06, 0.055, 0.16, 6);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    acc.add(block, trs(Math.cos(a) * 0.46, 0.13, Math.sin(a) * 0.46, -a), new THREE.Color(0.8, 0.8, 0.8));
  }
  return acc.build()!;
}

export function parasolGeo(): { pole: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const pole = loft((t, o) => o.set(0, t * 2.3, 0), 3, 7, (t) => 0.045 - t * 0.012, 1, true, true);
  // scalloped cone with visible rib creases
  const segs = 16,
    rows = 3;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = u * Math.PI * 2;
      const rib = Math.abs(((u * 8) % 1) - 0.5) * 2;
      const r = v * 1.35 * (1 + (1 - rib) * 0.035 * v);
      pos.push(Math.cos(a) * r, 2.3 - v * v * 0.44 - (1 - rib) * 0.05 * v, Math.sin(a) * r);
      uv.push(u * 2, v);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + 1, a + segs + 1, a + 1, a + segs + 2, a + segs + 1);
    }
  const canopy = new THREE.BufferGeometry();
  canopy.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  canopy.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  canopy.setIndex(idx);
  canopy.computeVertexNormals();
  return { pole, canopy };
}

export function deckchairGeo(): { frame: THREE.BufferGeometry; cloth: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  for (const s of [-1, 1]) {
    acc.add(bevelBox(0.05, 1.06, 0.05, 0.012, 6), trs(s * 0.28, 0.44, -0.16, 0, 1, 1, 1, -0.5), w);
    acc.add(bevelBox(0.05, 0.92, 0.05, 0.012, 6), trs(s * 0.28, 0.3, 0.22, 0, 1, 1, 1, 0.66), w);
  }
  acc.add(bevelBox(0.62, 0.05, 0.05, 0.012, 6), trs(0, 0.02, -0.42, 0), w);
  acc.add(bevelBox(0.62, 0.05, 0.05, 0.012, 6), trs(0, 0.02, 0.42, 0), w);
  const clothG = new THREE.PlaneGeometry(0.56, 1.25, 1, 5);
  const p = clothG.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i) / 1.25 + 0.5;
    p.setXYZ(i, p.getX(i), 0.16 + v * 0.62 - Math.sin(v * Math.PI) * 0.06, -0.42 + v * 0.72);
  }
  clothG.computeVertexNormals();
  return { frame: acc.build()!, cloth: clothG };
}

/** Marshal post: a booth, a pole and a flag socket. */
export function marshalGeo(): { post: THREE.BufferGeometry; flag: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(0.9, 1.1, 0.7, 0.04, 1.2), trs(0, 0.55, 0, 0), w);
  acc.add(bevelBox(1.06, 0.09, 0.86, 0.02, 1.6), trs(0, 1.14, 0, 0), new THREE.Color(0.85, 0.85, 0.85));
  acc.add(loft((t, o) => o.set(0, t * 2.5, 0), 3, 7, () => 0.045, 1, true, true), trs(0.5, 1.1, 0.28, 0), w);
  const flag = new THREE.PlaneGeometry(1.0, 0.62, 8, 3);
  flag.translate(0.5, 0, 0);
  flag.rotateY(Math.PI / 2);
  flag.translate(0.5, 3.3, 0.28);
  return { post: acc.build()!, flag };
}

/** Banner arch spanning the road. `span` is the clear width. */
export function bannerArchGeo(span: number, height: number): { struct: THREE.BufferGeometry; banner: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  for (const s of [-1, 1]) {
    const x = (s * span) / 2;
    acc.add(bevelBox(0.75, height, 0.75, 0.05, 1.0), trs(x, height / 2, 0, 0), w);
    acc.add(bevelBox(1.15, 0.24, 1.15, 0.04, 1.2), trs(x, 0.12, 0, 0), new THREE.Color(0.86, 0.86, 0.86));
    acc.add(bevelBox(1.0, 0.2, 1.0, 0.04, 1.2), trs(x, height + 0.1, 0, 0), new THREE.Color(0.9, 0.9, 0.9));
    // diagonal brace
    acc.add(bevelBox(0.16, 2.2, 0.16, 0.03, 3), trs(x - s * 0.7, height - 1.0, 0, 0, 1, 1, 1, 0, s * 0.5), w);
  }
  acc.add(bevelBox(span + 1.6, 0.42, 0.55, 0.05, 0.35), trs(0, height + 0.4, 0, 0), w);
  acc.add(bevelBox(span + 1.2, 0.2, 0.4, 0.03, 2), trs(0, height + 1.55, 0, 0), new THREE.Color(0.9, 0.9, 0.9));
  const banner = new THREE.PlaneGeometry(span + 1.2, 1.05, 12, 2);
  banner.translate(0, height + 1.0, 0.05);
  // banner uv.x must run 0..1 from the top rail for the cloth patch
  const uvB = banner.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uvB.count; i++) uvB.setXY(i, 1 - uvB.getY(i), uvB.getX(i));
  return { struct: acc.build()!, banner };
}

/** Tiered grandstand with a canopy; returns structure + the crowd row anchors. */
export function grandstandGeo(len: number, rows: number): { struct: THREE.BufferGeometry; seats: { x: number; y: number; z: number }[] } {
  const acc = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const seats: { x: number; y: number; z: number }[] = [];
  const rowH = 0.52,
    rowD = 0.82;
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const z = -r * rowD;
    acc.add(bevelBox(len, rowH, rowD, 0.03, 0.35), trs(0, y + rowH / 2, z, 0), r % 2 ? new THREE.Color(0.92, 0.9, 0.86) : new THREE.Color(0.84, 0.82, 0.78));
    acc.add(bevelBox(len, 0.34, 0.09, 0.02, 0.9), trs(0, y + rowH + 0.17, z - rowD * 0.44, 0), new THREE.Color(0.78, 0.8, 0.84));
    seats.push({ x: 0, y: y + rowH, z });
  }
  const totalD = rows * rowD;
  // back wall + roof canopy on columns
  acc.add(bevelBox(len + 0.6, rows * rowH + 1.4, 0.35, 0.05, 0.4), trs(0, (rows * rowH + 1.4) / 2, -totalD - 0.1, 0), w);
  const capH = rows * rowH + 3.4;
  for (let i = 0; i <= 6; i++) {
    const x = -len / 2 + (i / 6) * len;
    acc.add(bevelBox(0.22, capH, 0.22, 0.03, 3), trs(x, capH / 2, 0.5, 0), w);
  }
  acc.add(bevelBox(len + 1.2, 0.22, totalD + 1.6, 0.04, 0.45), trs(0, capH + 0.6, -totalD / 2 + 0.4, 0, 1, 1, 1, 0.08), new THREE.Color(0.9, 0.88, 0.84));
  acc.add(bevelBox(len + 1.2, 0.34, 0.24, 0.03, 2), trs(0, capH + 0.42, 0.9, 0), new THREE.Color(0.86, 0.4, 0.36));
  // side walls
  for (const s of [-1, 1]) acc.add(bevelBox(0.3, rows * rowH + 0.6, totalD, 0.04, 0.45), trs((s * len) / 2, (rows * rowH) / 2, -totalD / 2, 0), w);
  return { struct: acc.build()!, seats };
}

/**
 * Campanile / bell tower — the landmark that gives the village a silhouette
 * apex. Returns the three material streams the terrace builder already merges.
 */
export function bellTowerGeo(rng: RNG, base: number, h: number): { wall: THREE.BufferGeometry; trim: THREE.BufferGeometry; roof: THREE.BufferGeometry; height: number } {
  const wall = new GeoAccum();
  const trim = new GeoAccum();
  const roof = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const shaftH = h * 0.74;
  // shaft, very slightly battered so it does not read as an extrusion
  wall.add(bevelBox(base, shaftH, base, 0.07, 0.42), trs(0, shaftH / 2, 0, 0), white, (_x, y) => lerp(0.4, 1, smoothstep(0, 2.2, y)));
  // string courses breaking the shaft into stages
  for (let i = 1; i <= 3; i++) {
    const y = (shaftH * i) / 4;
    trim.add(bevelBox(base + 0.22, 0.16, base + 0.22, 0.035, 0.9), trs(0, y, 0, 0), new THREE.Color(0xdfd3bc));
  }
  // narrow slit windows up the shaft
  for (let i = 0; i < 3; i++) {
    const y = shaftH * (0.24 + i * 0.22);
    for (const s of [-1, 1]) {
      wall.add(new THREE.PlaneGeometry(0.28, 1.0, 1, 1), trs((s * base) / 2 + s * 0.006, y, 0, s > 0 ? Math.PI / 2 : -Math.PI / 2), new THREE.Color(0x2a2a30));
      wall.add(new THREE.PlaneGeometry(0.28, 1.0, 1, 1), trs(0, y, (s * base) / 2 + s * 0.006, s > 0 ? 0 : Math.PI), new THREE.Color(0x2a2a30));
    }
  }
  // belfry: open arched stage, deliberately wider than the shaft
  const belH = h * 0.16;
  const belW = base + 0.5;
  const py = shaftH;
  trim.add(bevelBox(belW + 0.3, 0.2, belW + 0.3, 0.04, 0.9), trs(0, py + 0.1, 0, 0), new THREE.Color(0xe4d9c2));
  // four corner piers leave the openings
  const pier = 0.42;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      wall.add(bevelBox(pier, belH, pier, 0.04, 0.9), trs((sx * (belW - pier)) / 2, py + belH / 2 + 0.2, (sz * (belW - pier)) / 2, 0), white, () => 0.9);
    }
  // dark void behind the arches so the belfry reads as open, not solid
  for (const s of [-1, 1]) {
    wall.add(new THREE.PlaneGeometry(belW - pier * 1.4, belH * 0.82, 1, 1), trs(0, py + belH * 0.55, (s * (belW - pier)) / 2 - s * 0.02, s > 0 ? 0 : Math.PI), new THREE.Color(0x241f22));
    wall.add(new THREE.PlaneGeometry(belW - pier * 1.4, belH * 0.82, 1, 1), trs((s * (belW - pier)) / 2 - s * 0.02, py + belH * 0.55, 0, (s * Math.PI) / 2), new THREE.Color(0x241f22));
  }
  // bell
  wall.add(loft((t, o) => o.set(0, -t * 0.5, 0), 4, 8, (t) => 0.1 + Math.pow(t, 1.6) * 0.2, 1, false, true), trs(0, py + belH * 0.82, 0, 0), new THREE.Color(0x6d5a34));
  // pyramid cap in roof tile
  const capH = h * 0.1;
  trim.add(bevelBox(belW + 0.44, 0.18, belW + 0.44, 0.04, 0.9), trs(0, py + belH + 0.29, 0, 0), new THREE.Color(0xe4d9c2));
  const cap = loft((t, o) => o.set(0, t * capH, 0), 2, 4, (t) => (1 - t) * (belW + 0.5) * 0.72, 1.6, false, false);
  cap.rotateY(Math.PI / 4);
  roof.add(cap, trs(0, py + belH + 0.38, 0, 0), new THREE.Color().setHSL(0.04, 0.2, 0.74));
  // finial
  trim.add(loft((t, o) => o.set(0, t * 1.1, 0), 2, 5, (t) => 0.06 * (1 - t * 0.6), 1, true, true), trs(0, py + belH + capH + 0.38, 0, 0), new THREE.Color(0xcfc0a4));
  void rng;
  return { wall: wall.build()!, trim: trim.build()!, roof: roof.build()!, height: py + belH + capH + 1.5 };
}

/** Market stall: four posts, a counter, and a striped canopy (fabric stream). */
export function stallGeo(rng: RNG): { frame: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = 2.6 + rng() * 1.1;
  const d = 1.7 + rng() * 0.5;
  const hh = 2.15 + rng() * 0.25;
  const white = new THREE.Color(1, 1, 1);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) acc.add(bevelBox(0.1, hh, 0.1, 0.02, 3), trs((sx * (w - 0.2)) / 2, hh / 2, (sz * (d - 0.2)) / 2, 0), white);
  // counter + a crate or two of produce
  acc.add(bevelBox(w, 0.12, d, 0.025, 1.1), trs(0, 0.95, 0, 0), new THREE.Color(0.88, 0.84, 0.76));
  acc.add(bevelBox(w - 0.2, 0.85, 0.1, 0.02, 1.1), trs(0, 0.5, (d - 0.1) / 2, 0), new THREE.Color(0.8, 0.76, 0.68));
  for (let i = 0; i < 3; i++) {
    const s = 0.3 + rng() * 0.14;
    acc.add(bevelBox(s, s * 0.7, s * 0.8, 0.02, 2), trs(-w / 2 + 0.4 + i * (w / 3.4), 1.06 + (s * 0.7) / 2, (rng() - 0.5) * 0.4, rng() * 3), new THREE.Color(0.9, 0.78, 0.6));
  }
  acc.add(bevelBox(w + 0.16, 0.08, 0.1, 0.02, 2), trs(0, hh, (d - 0.2) / 2, 0), white);
  // canopy: a shallow gable in the fabric atlas
  const can = new GeoAccum();
  const sl = Math.hypot(d / 2 + 0.28, 0.34);
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(w + 0.5, sl, 1, 1);
    g.rotateX(-Math.PI / 2);
    can.add(g, trs(0, hh + 0.16 - 0.17, (s * (d / 2 + 0.28)) / 2, 0, 1, 1, 1, (-s * 0.62) / 1.0), white);
  }
  const canopy = can.build()!;
  return { frame: acc.build()!, canopy };
}

/** Ridge tent for the support paddock bands. */
export function tentGeo(rng: RNG): { body: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const w = 2.8 + rng() * 1.4;
  const d = 3.4 + rng() * 1.6;
  const hh = 1.5 + rng() * 0.5;
  const wall = 0.6 + rng() * 0.35;
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(w, wall, d, 0.04, 0.55), trs(0, wall / 2, 0, 0), white, (_x, y) => lerp(0.5, 1, smoothstep(0, 0.8, y)));
  const sl = Math.hypot(w / 2 + 0.2, hh);
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(sl, d + 0.4, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.rotateZ(s * Math.atan2(hh, w / 2 + 0.2));
    g.translate((-s * (w / 2 + 0.2)) / 2, wall + hh / 2, 0);
    acc.add(g, trs(0, 0, 0, 0), new THREE.Color(0.94, 0.92, 0.88));
  }
  // gable triangles so the tent is closed
  for (const s of [-1, 1]) {
    const t = new THREE.BufferGeometry();
    const x = w / 2 + 0.2;
    t.setAttribute('position', new THREE.Float32BufferAttribute(s > 0 ? [-x, wall, 0, x, wall, 0, 0, wall + hh, 0] : [x, wall, 0, -x, wall, 0, 0, wall + hh, 0], 3));
    t.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, s, 0, 0, s, 0, 0, s], 3));
    t.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    acc.add(t, trs(0, 0, (s * (d + 0.4)) / 2, 0), new THREE.Color(0.8, 0.78, 0.75));
  }
  return { body: acc.build()! };
}

/** Channel buoy: a float, a cage and a topmark. */
export function buoyGeo(): THREE.BufferGeometry {
  const acc = new GeoAccum();
  acc.add(loft((t, o) => o.set(0, -0.4 + t * 1.3, 0), 5, 8, (t) => Math.sin((0.12 + t * 0.78) * Math.PI) * 0.42, 1.4, true, true), trs(0, 0, 0, 0), new THREE.Color(1, 1, 1));
  acc.add(bevelBox(0.06, 1.5, 0.06, 0.015, 3), trs(0, 1.4, 0, 0), new THREE.Color(0.8, 0.8, 0.84));
  acc.add(loft((t, o) => o.set(0, t * 0.34, 0), 2, 4, (tt) => (1 - tt) * 0.2, 1, false, false), trs(0, 1.95, 0, 0), new THREE.Color(0.2, 0.2, 0.24));
  return acc.build()!;
}

/** Start-light gantry: five housings under the arch beam plus their lenses. */
export function startLightsGeo(span: number): { frame: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const lens = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const n = 5;
  const wBox = Math.min(0.78, (span * 0.5) / n);
  acc.add(bevelBox(wBox * n * 1.35, 0.16, 0.34, 0.03, 1.4), trs(0, 0.42, 0, 0), new THREE.Color(0.28, 0.28, 0.32));
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * wBox * 1.3;
    acc.add(bevelBox(wBox, wBox * 1.05, 0.3, 0.035, 1.6), trs(x, 0, 0, 0), new THREE.Color(0.22, 0.22, 0.26));
    acc.add(bevelBox(wBox * 1.1, 0.1, 0.42, 0.02, 2), trs(x, wBox * 0.56, 0.06, 0, 1, 1, 1, 0.25), new THREE.Color(0.18, 0.18, 0.21));
    const g = new THREE.CircleGeometry(wBox * 0.34, 12);
    lens.add(g, trs(x, 0, 0.17, 0), white);
  }
  return { frame: acc.build()!, lens: lens.build()! };
}

/** A-frame roadside board: two hinged panels on a folding frame. */
export function aFrameSignGeo(): { frame: THREE.BufferGeometry; panel: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const pan = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  const hh = 1.25;
  const wdt = 1.9;
  for (const s of [-1, 1]) {
    for (const sx of [-1, 1]) acc.add(bevelBox(0.08, hh, 0.08, 0.02, 3), trs((sx * wdt) / 2, hh / 2, s * 0.3, 0, 1, 1, 1, (-s * 0.42) / 1.0), white);
    acc.add(bevelBox(wdt + 0.1, 0.07, 0.07, 0.015, 2), trs(0, 0.14, s * 0.55, 0), new THREE.Color(0.85, 0.85, 0.85));
    const g = new THREE.PlaneGeometry(wdt * 0.94, hh * 0.72, 1, 1);
    g.rotateX(s > 0 ? 0.42 : -0.42);
    g.translate(0, hh * 0.56, s * 0.24);
    if (s < 0) g.rotateY(Math.PI);
    pan.add(g, trs(0, 0, 0, 0), s > 0 ? white : new THREE.Color(0.9, 0.9, 0.9));
  }
  return { frame: acc.build()!, panel: pan.build()! };
}

/** Wall-mounted hoarding: a flat board on two short brackets. */
export function wallSignGeo(): { frame: THREE.BufferGeometry; panel: THREE.BufferGeometry } {
  const acc = new GeoAccum();
  const pan = new GeoAccum();
  const white = new THREE.Color(1, 1, 1);
  acc.add(bevelBox(3.2, 0.1, 0.12, 0.02, 2), trs(0, 1.62, 0, 0), white);
  acc.add(bevelBox(3.2, 0.1, 0.12, 0.02, 2), trs(0, 0.72, 0, 0), white);
  for (const s of [-1, 1]) acc.add(bevelBox(0.1, 1.15, 0.24, 0.02, 2), trs(s * 1.5, 1.17, -0.1, 0), new THREE.Color(0.86, 0.86, 0.86));
  const g = new THREE.PlaneGeometry(3.1, 0.82, 1, 1);
  g.translate(0, 1.17, 0.07);
  pan.add(g, trs(0, 0, 0, 0), white);
  return { frame: acc.build()!, panel: pan.build()! };
}

/** One bunting pennant, pivoting from its top edge. */
export function buntingFlagGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const w = 0.26,
    hh = 0.36;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, -hh, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  // uv.x is the cloth patch's root->free coordinate: 0 on the line, 1 at the tip
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0.5], 2));
  return g;
}

/**
 * A spectator. uv.x flags tintable clothing, uv.y > 0.92 flags raised arms.
 * Four silhouettes: a row of identical capsules is the classic placeholder
 * tell, and the fix that costs nothing is a different OUTLINE, not more polys.
 *   0 standing  1 arms up  2 child (short, no cap)  3 adult with a sun hat
 */
export function spectatorGeo(variant = 0): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const skin = new THREE.Color(1, 1, 1);
  const dark = new THREE.Color(0.42, 0.4, 0.44);
  const white = new THREE.Color(1, 1, 1);
  const child = variant === 2;
  const sc = child ? 0.72 : 1;
  const build = 1 + (variant === 3 ? 0.14 : 0) - (child ? 0.06 : 0);
  // Deliberately cheap: there are several hundred of these and they are never
  // closer than a couple of metres behind a barrier. Colour variety, outline
  // variety and the cheer animation carry the read, not the mesh.
  const torso = loft((t, o) => o.set(0, (0.62 + t * 0.56) * sc, 0), 3, 6, (t) => (0.19 + Math.sin(t * Math.PI) * 0.035 - t * 0.02) * build * sc, 1, true, true);
  setUv(torso, 1, 0.5);
  acc.add(torso, trs(0, 0, 0, 0), white);
  const legG = loft((t, o) => o.set(0, t * 0.64 * sc, 0), 1, 5, () => 0.072 * sc, 1, true, true);
  setUv(legG, 0, 0.4);
  for (const s of [-1, 1]) acc.add(legG, trs(s * 0.085 * sc, 0, 0, 0), dark);
  if (variant === 1) {
    // arms straight up — this is the silhouette that reads "crowd" at 60 m
    const up = loft((t, o) => o.set(0, (1.1 + t * 0.62) * sc, 0), 1, 4, () => 0.052 * sc, 1, true, true);
    setUv(up, 1, 0.96);
    for (const s of [-1, 1]) acc.add(up, trs(s * 0.21 * sc, 0, 0, 0, 1, 1, 1, 0, s * 0.2), white);
  } else {
    const armG = loft((t, o) => o.set(0, (1.12 - t * 0.42) * sc, 0), 1, 4, () => 0.055 * sc, 1, true, true);
    setUv(armG, 1, 0.96);
    for (const s of [-1, 1]) acc.add(armG, trs(s * 0.23 * sc * build, 0, 0, 0, 1, 1, 1, 0, s * (variant === 3 ? 0.3 : 0.16)), white);
  }
  const head = loft((t, o) => o.set(0, (1.2 + t * 0.2) * sc, 0), 2, 6, (t) => Math.sin((0.18 + t * 0.72) * Math.PI) * 0.115 * sc, 1, true, true);
  setUv(head, 0, 0.5);
  acc.add(head, trs(0, 0, 0, 0), skin);
  if (variant === 3) {
    // wide-brimmed sun hat: a completely different head silhouette
    const brim = loft((t, o) => o.set(0, (1.34 + t * 0.05) * sc, 0), 1, 8, (t) => lerp(0.26, 0.2, t) * sc, 1, true, true);
    setUv(brim, 1, 0.5);
    acc.add(brim, trs(0, 0, 0, 0), white);
    const crown = loft((t, o) => o.set(0, (1.37 + t * 0.14) * sc, 0), 2, 6, (t) => 0.108 * (1 - t * 0.35) * sc, 1, false, true);
    setUv(crown, 1, 0.5);
    acc.add(crown, trs(0, 0, 0, 0), white);
  } else if (!child) {
    const cap = loft((t, o) => o.set(0, (1.33 + t * 0.09) * sc, 0), 2, 6, (t) => 0.115 * Math.cos(t * 1.2) * sc, 1, false, true);
    setUv(cap, 1, 0.5);
    acc.add(cap, trs(0, 0, 0, 0), white);
  }
  return acc.build()!;
}

function setUv(g: THREE.BufferGeometry, x: number, y: number) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, x, y);
  uv.needsUpdate = true;
}

/** Gull: body spindle plus two wing quads, animated entirely in the shader. */
export function gullGeo(): THREE.BufferGeometry {
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const push = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(u, v);
  };
  // wings: a single strip spanning u = 0..1 so |u-0.5| is the span coordinate
  const span = 0.62;
  const pts: [number, number][] = [
    [-1, 0.0],
    [-0.55, 0.06],
    [0, 0.02],
    [0.55, 0.06],
    [1, 0.0],
  ];
  for (let i = 0; i < pts.length; i++) {
    const [sx, sz] = pts[i];
    push(sx * span, 0, sz * 0.1 - 0.03, (sx + 1) / 2, 0);
    push(sx * span, 0, sz * 0.1 + 0.14 - Math.abs(sx) * 0.1, (sx + 1) / 2, 1);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // body
  const base = pos.length / 3;
  const bl = 0.3;
  push(0, 0, -bl, 0.5, 0.5);
  push(-0.045, 0.02, 0, 0.5, 0.5);
  push(0.045, 0.02, 0, 0.5, 0.5);
  push(0, -0.02, 0.06, 0.5, 0.5);
  push(0, 0.01, bl * 0.7, 0.5, 0.5);
  idx.push(base, base + 1, base + 2, base + 1, base + 4, base + 2, base + 1, base + 3, base + 4, base + 2, base + 4, base + 3, base, base + 3, base + 1, base, base + 2, base + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Lighthouse on its own rock plinth — the plinth guarantees it never floats. */
export function lighthouseGeo(baseY: number, seaY: number): { stone: THREE.BufferGeometry; trim: THREE.BufferGeometry; glass: THREE.BufferGeometry; lampY: number } {
  const stoneA = new GeoAccum();
  const trimA = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const plinthH = Math.max(2.5, baseY - seaY + 3.0);
  const plinth = loft((t, o) => o.set(0, -plinthH + t * plinthH, 0), 5, 10, (t, a) => (7.5 - t * 3.4) * (1 + Math.sin(a * 3 + t * 2) * 0.09), 3, false, true);
  stoneA.add(plinth, trs(0, 0, 0, 0), new THREE.Color(0.86, 0.82, 0.74));
  const towerH = 15.5;
  const tower = loft((t, o) => o.set(0, t * towerH, 0), 12, 16, (t) => 2.35 - Math.pow(t, 0.85) * 1.15, 4, true, false);
  stoneA.add(tower, trs(0, 0, 0, 0), w);
  // gallery ring + corbel
  trimA.add(loft((t, o) => o.set(0, towerH + t * 0.42, 0), 3, 16, (t) => 1.75 - t * 0.25, 3, false, true), trs(0, 0, 0, 0), new THREE.Color(0.94, 0.9, 0.84));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    trimA.add(bevelBox(0.07, 0.9, 0.07, 0.015, 5), trs(Math.cos(a) * 1.6, towerH + 0.86, Math.sin(a) * 1.6, -a), new THREE.Color(0.8, 0.3, 0.28));
  }
  trimA.add(loft((t, o) => o.set(0, towerH + 1.3 + t * 0.12, 0), 1, 16, () => 1.66, 3, false, false), trs(0, 0, 0, 0), new THREE.Color(0.8, 0.3, 0.28));
  // lantern room + cap
  const lampY = towerH + 1.4;
  const glass = loft((t, o) => o.set(0, lampY + t * 2.0, 0), 2, 12, () => 1.15, 2, false, false);
  trimA.add(loft((t, o) => o.set(0, lampY + 2.0 + t * 1.05, 0), 4, 12, (t) => 1.3 * (1 - t * t), 2, false, true), trs(0, 0, 0, 0), new THREE.Color(0.8, 0.3, 0.28));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    trimA.add(bevelBox(0.09, 2.0, 0.09, 0.02, 4), trs(Math.cos(a) * 1.14, lampY + 1.0, Math.sin(a) * 1.14, -a), new THREE.Color(0.35, 0.34, 0.36));
  }
  return { stone: stoneA.build()!, trim: trimA.build()!, glass, lampY: lampY + 1.0 };
}

/** Windmill: tower + cap (static) and a 4-sail rotor (spun on the CPU, 1 object). */
export function windmillGeo(): { tower: THREE.BufferGeometry; trim: THREE.BufferGeometry; rotor: THREE.BufferGeometry; sail: THREE.BufferGeometry; hubY: number; hubZ: number } {
  const towerA = new GeoAccum();
  const trimA = new GeoAccum();
  const w = new THREE.Color(1, 1, 1);
  const H = 9.5;
  towerA.add(loft((t, o) => o.set(0, t * H, 0), 10, 14, (t) => 3.1 - t * 1.25, 3, true, false), trs(0, 0, 0, 0), w);
  // little windows so the tower isn't a bare cone
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1;
    trimA.add(bevelBox(0.6, 0.85, 0.35, 0.03, 2), trs(Math.cos(a) * 2.35, 2.6 + i * 1.9, Math.sin(a) * 2.35, -a), new THREE.Color(0.4, 0.36, 0.34));
  }
  // conical cap
  trimA.add(loft((t, o) => o.set(0, H + t * 2.4, 0), 6, 14, (t) => 2.05 * Math.pow(1 - t, 0.72), 3, false, true), trs(0, 0, 0, 0), new THREE.Color(0.78, 0.42, 0.3));
  trimA.add(loft((t, o) => o.set(0, H - 0.1 + t * 0.22, 0), 1, 14, () => 2.2, 3, false, false), trs(0, 0, 0, 0), new THREE.Color(0.92, 0.88, 0.8));
  const hubY = H + 1.35,
    hubZ = 2.3;
  // rotor: hub + four lattice arms, built around the origin in XY
  const rotorA = new GeoAccum();
  rotorA.add(loft((t, o) => o.set(0, 0, -0.1 + t * 0.6), 3, 10, (t) => 0.34 - t * 0.1, 1.5, true, true), trs(0, 0, 0, 0), w);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const L = 5.6;
    // spar
    rotorA.add(bevelBox(0.16, L, 0.16, 0.03, 3), trs((ca * L) / 2, (sa * L) / 2, 0, 0, 1, 1, 1, 0, a - Math.PI / 2), w);
    // lattice ribs
    for (let k = 1; k <= 7; k++) {
      const r = (k / 8) * L;
      rotorA.add(bevelBox(0.9, 0.07, 0.07, 0.015, 4), trs(ca * r, sa * r, 0.05, 0, 1, 1, 1, 0, a - Math.PI / 2), new THREE.Color(0.9, 0.9, 0.9));
    }
  }
  // one sail cloth per arm, instanced
  const sail = new THREE.PlaneGeometry(0.95, 4.6, 3, 8);
  sail.translate(0.55, 2.6, 0.14);
  const suv = sail.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < suv.count; i++) suv.setXY(i, suv.getX(i) * 0.5, suv.getY(i) * 0.5);
  return { tower: towerA.build()!, trim: trimA.build()!, rotor: rotorA.build()!, sail, hubY, hubZ };
}

/**
 * A landmass silhouette: a noise-displaced dome. Used for the offshore islands
 * and the receding headlands that keep the horizon from ever being empty.
 */
export function landmassGeo(radius: number, height: number, seed: number, seaY: number, jag = 1): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const n1 = createNoise2D(rng);
  const segs = 40,
    rings = 12;
  const pos: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  const skirt = height * 0.6 + 40;
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const a = u * Math.PI * 2;
      const wob = 1 + n1(Math.cos(a) * 1.5, Math.sin(a) * 1.5) * 0.34 * jag + n1(Math.cos(a) * 4.1 + 9, Math.sin(a) * 4.1) * 0.14 * jag;
      const r = radius * wob * Math.sqrt(Math.max(0, 1 - v * v));
      const ridge = n1(Math.cos(a) * 2.2 + 30, Math.sin(a) * 2.2) * 0.3 + n1(u * 7 + 51, v * 3) * 0.16;
      const y = seaY + height * Math.pow(v, 0.72) * (1 + ridge * jag);
      // The base ring is dropped well below the waterline so an island never
      // shows a floating rim however the swell moves.
      pos.push(Math.cos(a) * r, j === 0 ? seaY - skirt : y, Math.sin(a) * r);
      uv.push(u * 8, v * 5);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i;
      idx.push(a, a + segs + 1, a + 1, a + 1, a + segs + 1, a + segs + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Small tide-line debris: driftwood, shells, weed clumps, pebbles. */
export function debrisGeo(rng: RNG): THREE.BufferGeometry {
  const acc = new GeoAccum();
  const k = (rng() * 3) | 0;
  if (k === 0) {
    const L = 0.5 + rng() * 1.1;
    acc.add(loft((t, o) => o.set(0, 0, (t - 0.5) * L), 5, 6, (t) => 0.05 + Math.sin(t * Math.PI) * 0.035, 2, true, true), trs(0, 0.06, 0, rng() * 6), new THREE.Color(0.78, 0.72, 0.62));
  } else if (k === 1) {
    for (let i = 0; i < 4; i++) acc.add(bevelBox(0.12 + rng() * 0.14, 0.07 + rng() * 0.06, 0.12 + rng() * 0.12, 0.02, 4), trs((rng() - 0.5) * 0.4, 0.04, (rng() - 0.5) * 0.4, rng() * 6), new THREE.Color(0.9, 0.87, 0.8));
  } else {
    for (let i = 0; i < 5; i++) acc.add(bevelBox(0.22 + rng() * 0.2, 0.05, 0.1 + rng() * 0.1, 0.02, 4), trs((rng() - 0.5) * 0.5, 0.03, (rng() - 0.5) * 0.5, rng() * 6, 1, 1, 1, 0, rng() * 0.4), new THREE.Color(0.34, 0.36, 0.26));
  }
  return acc.build()!;
}
