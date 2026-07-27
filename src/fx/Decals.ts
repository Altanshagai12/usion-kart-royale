import * as THREE from 'three';
import { buildAtlas } from './Particles';

/**
 * ============================================================================
 *  Decals — pooled ground-projected quads: skid marks and scorch.
 * ============================================================================
 *  One geometry, one draw call, one hard cap. Quads are written into a ring
 *  buffer at lay-down time and never touched again: the fragment shader reads
 *  a per-vertex birth time and fades the mark out on its own, so a persisting
 *  skid mark costs the CPU nothing at all after the frame it was laid.
 *
 *  Marks are placed on the plane of the surface probe under the wheel and
 *  lifted a couple of centimetres along its normal, with polygon offset on top
 *  of that. Belt and braces, because a flickering skid mark on the hero
 *  corner would be the single most visible artefact in the game.
 *
 *  Blending is multiplicative, not alpha: a skid mark *darkens whatever it is
 *  on*, so it reads correctly on tarmac, on the kerb and on sand without any
 *  per-surface tinting, and it can never look like black paint floating over
 *  a bright surface.
 * ============================================================================
 */

export const enum DecalTile {
  Skid = 0,
  Scorch = 1,
  Smudge = 2,
  Splat = 3,
}

/** pos3 + uv2 + birth1 + life1 + tint3 + strength1 */
const VSTRIDE = 11;

const _side = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();

const VERT = /* glsl */ `
attribute vec2 aLife;    // x birth, y lifetime
attribute vec4 aTint;    // rgb tint, a strength

varying vec2 vUv;
varying vec2 vLife;
varying vec4 vTint;

void main() {
  vUv = uv;
  vLife = aLife;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec2 uAtlasTiles;
uniform float uTime;

varying vec2 vUv;
varying vec2 vLife;
varying vec4 vTint;

void main() {
  if (vLife.y <= 0.0) discard;
  float age = (uTime - vLife.x) / vLife.y;
  if (age < 0.0 || age >= 1.0) discard;
  float mask = texture2D(uAtlas, vUv).a;
  // Hold, then dissolve. Marks should look permanent for a while, then thin
  // out rather than uniformly ghosting away.
  float a = mask * vTint.a * (1.0 - smoothstep(0.5, 1.0, age));
  if (a < 0.004) discard;
  // Multiplicative: 1.0 leaves the surface untouched, tint darkens it.
  gl_FragColor = vec4(mix(vec3(1.0), vTint.rgb, a), 1.0);
}
`;

function decalTiles() {
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const sstep = (a: number, b: number, x: number) => {
    const t = clamp01((x - a) / (b - a || 1e-6));
    return t * t * (3 - 2 * t);
  };
  // deterministic hash noise — no image data, no seeded generator needed
  const h1 = (x: number) => {
    const s = Math.sin(x * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x: number) => {
    const i = Math.floor(x), f = x - i;
    const u = f * f * (3 - 2 * f);
    return h1(i) * (1 - u) + h1(i + 1) * u;
  };
  const h2 = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise2 = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
  const fbm2 = (x: number, y: number, oct: number) => {
    let a = 1, f = 1, s = 0, nrm = 0;
    for (let i = 0; i < oct; i++) { s += a * vnoise2(x * f, y * f); nrm += a; a *= 0.5; f *= 2.11; }
    return s / nrm;
  };

  return [
    // 0 — Skid. Deliberately a function of u only (across the tyre width) so
    // that consecutive quads tile along v with no seam whatsoever.
    (u: number, _v: number, o: Float32Array) => {
      const tread = 0.62 + 0.38 * vnoise(u * 26);
      const grain = 0.80 + 0.20 * vnoise(u * 97 + 13);
      const edge = sstep(0.0, 0.16, u) * sstep(1.0, 0.84, u);
      o[0] = o[1] = o[2] = 1;
      o[3] = clamp01(tread * grain * edge);
    },
    // 1 — Scorch: eroded soot disc with a slightly hotter, denser core.
    (u: number, v: number, o: Float32Array) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const n = fbm2(u * 5.5, v * 5.5, 4);
      const a = clamp01(sstep(1.0, 0.18, d + (n - 0.5) * 0.55));
      o[0] = o[1] = o[2] = 1;
      o[3] = Math.pow(a, 0.85);
    },
    // 2 — Smudge: the small dark kiss a drift spark leaves on the tarmac.
    (u: number, v: number, o: Float32Array) => {
      const x = (u - 0.5) * 2, y = (v - 0.5) * 2.6;
      const d = Math.hypot(x, y);
      const n = fbm2(u * 9, v * 4, 3);
      o[0] = o[1] = o[2] = 1;
      o[3] = clamp01(sstep(1.0, 0.25, d + (n - 0.5) * 0.5)) * 0.8;
    },
    // 3 — Splat: wet, spattered ring for water and mud throw-off.
    (u: number, v: number, o: Float32Array) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      const ang = Math.atan2(v - 0.5, u - 0.5);
      const lobe = 0.62 + 0.3 * vnoise(ang * 2.2 + 5);
      let a = sstep(lobe, lobe * 0.45, d);
      a *= 0.55 + 0.45 * fbm2(u * 11, v * 11, 3);
      o[0] = o[1] = o[2] = 1;
      o[3] = clamp01(a);
    },
  ];
}

export class Decals {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly buffer: THREE.InterleavedBuffer;
  private readonly data: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private readonly atlas: THREE.DataTexture;
  private head = 0;
  private used = 0;
  private lo = Infinity;
  private hi = -Infinity;

  constructor(readonly capacity: number) {
    this.atlas = buildAtlas(decalTiles(), 2, 2, 256);
    this.data = new Float32Array(capacity * 4 * VSTRIDE);
    this.buffer = new THREE.InterleavedBuffer(this.data, VSTRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    this.geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(this.buffer, 2, 3));
    this.geo.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.buffer, 2, 5));
    this.geo.setAttribute('aTint', new THREE.InterleavedBufferAttribute(this.buffer, 4, 7));

    const idx = new Uint16Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const b = q * 4;
      idx[q * 6] = b; idx[q * 6 + 1] = b + 1; idx[q * 6 + 2] = b + 2;
      idx[q * 6 + 3] = b; idx[q * 6 + 4] = b + 2; idx[q * 6 + 5] = b + 3;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.atlas },
        uAtlasTiles: { value: new THREE.Vector2(2, 2) },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.MultiplyBlending,
      // three only wires up MultiplyBlending's blend func on the premultiplied
      // path; without this the state call is refused and marks draw as normal
      // alpha. We never include the premultiply chunk, so the shader is
      // unaffected — this flag exists purely to select the right blend func.
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -12,
      // The output is a multiplier, not a radiance value; tone mapping it
      // would lift the marks toward grey.
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Decals go down after opaque geometry but before every particle.
    this.mesh.renderOrder = 5;
  }

  /** writes one of the four vertices of the quad currently being laid */
  private vert(o: number, x: number, y: number, z: number, u: number, v: number,
               birth: number, life: number, tr: number, tg: number, tb: number, s: number,
               ox: number, oy: number) {
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = ox + u * 0.5;   // atlas is 2x2
    d[o + 4] = oy + v * 0.5;
    d[o + 5] = birth; d[o + 6] = life;
    d[o + 7] = tr; d[o + 8] = tg; d[o + 9] = tb; d[o + 10] = s;
  }

  /**
   * Lay one quad from four world-space corners in winding order a,b,c,d.
   * `sa` applies to the a/b edge and `sb` to the c/d edge — i.e. to the two
   * ENDS of a strip segment, so consecutive segments hand strength across
   * their joins without pulsing.
   */
  private quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    tile: DecalTile, birth: number, life: number,
    tr: number, tg: number, tb: number, sa: number, sb: number,
  ) {
    const i = this.head;
    this.head = this.head + 1;
    if (this.head >= this.capacity) this.head = 0;
    if (this.used < this.capacity) this.used++;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;

    const ox = (tile & 1) * 0.5;
    const oy = (tile >> 1) * 0.5;
    const b0 = i * 4 * VSTRIDE;
    this.vert(b0, ax, ay, az, 0, 0, birth, life, tr, tg, tb, sa, ox, oy);
    this.vert(b0 + VSTRIDE, bx, by, bz, 1, 0, birth, life, tr, tg, tb, sa, ox, oy);
    this.vert(b0 + VSTRIDE * 2, cx, cy, cz, 1, 1, birth, life, tr, tg, tb, sb, ox, oy);
    this.vert(b0 + VSTRIDE * 3, dx, dy, dz, 0, 1, birth, life, tr, tg, tb, sb, ox, oy);
  }

  /**
   * A skid segment from `a` to `b` on a surface with normal `n`.
   * `sa`/`sb` are the mark strengths at each end (0..1) — feed the run-in and
   * run-out of a skid with low values and it fades in and out naturally.
   */
  skid(a: THREE.Vector3, b: THREE.Vector3, n: THREE.Vector3, width: number,
       sa: number, sb: number, now: number, life: number,
       tr = 0.30, tg = 0.28, tb = 0.30) {
    _seg.subVectors(b, a);
    if (_seg.lengthSq() < 1e-6) return;
    _n.copy(n).normalize();
    _side.crossVectors(_seg, _n);
    if (_side.lengthSq() < 1e-8) return;
    _side.normalize().multiplyScalar(width * 0.5);
    const lift = 0.025;
    _c0.copy(a).addScaledVector(_n, lift);
    _c1.copy(b).addScaledVector(_n, lift);
    this.quad(
      _c0.x - _side.x, _c0.y - _side.y, _c0.z - _side.z,
      _c0.x + _side.x, _c0.y + _side.y, _c0.z + _side.z,
      _c1.x + _side.x, _c1.y + _side.y, _c1.z + _side.z,
      _c1.x - _side.x, _c1.y - _side.y, _c1.z - _side.z,
      DecalTile.Skid, now, life, tr, tg, tb, sa, sb,
    );
  }

  /** A radially symmetric mark (scorch, smudge, splat) lying on the surface. */
  blot(p: THREE.Vector3, n: THREE.Vector3, radius: number, tile: DecalTile,
       now: number, life: number, strength: number,
       tr = 0.09, tg = 0.075, tb = 0.07) {
    _n.copy(n).normalize();
    // any two vectors orthogonal to n, rotated randomly so repeats don't align
    _seg.set(_n.y, -_n.z, _n.x);
    _side.crossVectors(_n, _seg).normalize();
    _seg.crossVectors(_side, _n).normalize();
    const a = Math.random() * Math.PI * 2;
    const ca = Math.cos(a) * radius, sa2 = Math.sin(a) * radius;
    const ex = _side.x * ca + _seg.x * sa2, ey = _side.y * ca + _seg.y * sa2, ez = _side.z * ca + _seg.z * sa2;
    const fx = -_side.x * sa2 + _seg.x * ca, fy = -_side.y * sa2 + _seg.y * ca, fz = -_side.z * sa2 + _seg.z * ca;
    const px = p.x + _n.x * 0.03, py = p.y + _n.y * 0.03, pz = p.z + _n.z * 0.03;
    this.quad(
      px - ex - fx, py - ey - fy, pz - ez - fz,
      px + ex - fx, py + ey - fy, pz + ez - fz,
      px + ex + fx, py + ey + fy, pz + ez + fz,
      px - ex + fx, py - ey + fy, pz - ez + fz,
      tile, now, life, tr, tg, tb, strength, strength,
    );
  }

  update(time: number) {
    this.material.uniforms.uTime.value = time;
    this.geo.setDrawRange(0, this.used * 6);
    if (this.hi >= this.lo) {
      const per = 4 * VSTRIDE;
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.lo * per, (this.hi - this.lo + 1) * per);
      this.buffer.needsUpdate = true;
      this.lo = Infinity; this.hi = -Infinity;
    }
  }

  /** Wipe every mark — used on race reset. */
  clear() {
    this.data.fill(0);
    this.buffer.clearUpdateRanges();
    this.buffer.needsUpdate = true;
    this.head = 0; this.used = 0;
    this.lo = Infinity; this.hi = -Infinity;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}
