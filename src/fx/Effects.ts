import * as THREE from 'three';
import {
  ItemKind,
  Quality,
  RaceState,
  SURFACE_PROPS,
  Surface,
  type Ctx,
  type GameEvent,
  type IKart,
  type System,
} from '../types';
import { PMode, PTile, Particles } from './Particles';
import { Trails } from './Trails';
import { DecalTile, Decals } from './Decals';

/**
 * ============================================================================
 *  Effects — the readability layer.
 * ============================================================================
 *  Everything the player learns about their own car without reading the HUD
 *  comes from here: how hard they are drifting, how close the mini-turbo is,
 *  whether the surface under them is costing them speed, whether that hit
 *  landed. It subscribes to the bus and reads kart state; it never drives
 *  gameplay.
 *
 *  Budget: 2 particle draws, 1 trail draw, 1 decal draw, plus five small
 *  world/entity systems (rings, motes, gulls, shimmer, star shells) that each
 *  cost exactly one instanced draw and skip themselves entirely when idle.
 *
 *  Energy: every additive surface in this file is multiplied by a single
 *  shared `gain` that falls as more bright effects crowd the frame — see
 *  `updateGain`. The worst case the art direction calls out (purple drift +
 *  boost + a tunnel-exit bloom) lands around 0.5 gain, which keeps the sum of
 *  the additive layers inside the tone mapper's shoulder instead of clipping
 *  the whole frame to white.
 * ============================================================================
 */

// --- palette (art bible §3) -------------------------------------------------
const C_TIER = [
  new THREE.Color(0xffffff),
  new THREE.Color(0x4fc3ff),
  new THREE.Color(0xff9d2e),
  new THREE.Color(0xc05cff),
];
const C_HOT = new THREE.Color(0xfff2d4);
const C_FLAME_MID = new THREE.Color(0xff9a2e);
const C_FLAME_COOL = new THREE.Color(0xc4331a);
/** blue-white root of a boost flame — hotter and cooler-hued than C_HOT */
const C_FLAME_ROOT = new THREE.Color(0xdcefff);
const C_SMOKE = new THREE.Color(0xb9b4ac);
const C_SMOKE_DARK = new THREE.Color(0x6a655e);
const C_WATER = new THREE.Color(0xbfe6ff);
const C_FOAM = new THREE.Color(0xeefaff);
const C_GOLD = new THREE.Color(0xffd36b);
const C_SUNMOTE = new THREE.Color(0xffe2b4);
const C_SPARK_WHITE = new THREE.Color(0xfff4e0);
const C_DEBRIS = new THREE.Color(0x3a3530);
const CONFETTI = [
  new THREE.Color(0xe0453f), new THREE.Color(0x4fc3ff), new THREE.Color(0xffd36b),
  new THREE.Color(0x87b356), new THREE.Color(0xdcb8d8), new THREE.Color(0xf2ece0),
];

// --- module-scope scratch: the hot path allocates nothing --------------------
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _r = new THREE.Vector3();
const _n = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const _mat = new THREE.Matrix4();
const _scaleV = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const damp = (dt: number, rate: number) => 1 - Math.pow(rate, dt);

// ===========================================================================
//  Shockwave rings — instanced, simulated entirely in the vertex shader.
// ===========================================================================

const RING_VERT = /* glsl */ `
uniform float uTime;
attribute vec4 aCen;   // xyz centre, w birth
attribute vec4 aRad;   // x r0, y r1, z life, w thickness (0..1 of radius)
attribute vec4 aQuat;  // orientation, maps +Y to the surface normal
attribute vec4 aCol;   // rgb, a peak intensity
attribute vec4 aDrift; // xyz centre velocity, w drag (1/s)
varying vec3 vCol;
varying float vA;
varying float vR;
varying float vViewZ;

vec3 rotq(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main() {
  float age = uTime - aCen.w;
  float u = age / max(aRad.z, 1e-4);
  if (age < 0.0 || u >= 1.0) {
    vCol = vec3(0.0); vA = 0.0; vR = 0.0; vViewZ = 1.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Ease-out expansion: a shockwave is fastest the instant it is born.
  float e = 1.0 - pow(1.0 - u, 2.8);
  float R = mix(aRad.x, aRad.y, e);
  float rr = mix(R * (1.0 - aRad.w), R, uv.x);
  // The centre may travel. A ring fired off a kart at 25 m/s that stays pinned
  // to the world is 7 m adrift by the time it fades, which is exactly why the
  // drift ring reads as a hoop lying on empty tarmac instead of as feedback
  // attached to the car.
  float k = max(aDrift.w, 1e-3);
  vec3 centre = aCen.xyz + aDrift.xyz * (1.0 - exp(-k * age)) / k;
  vec3 wp = centre + rotq(aQuat, vec3(position.x * rr, 0.0, position.z * rr));
  vCol = aCol.rgb;
  vA = aCol.a * (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.10, u);
  vR = uv.x;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const RING_FRAG = /* glsl */ `
uniform float uGain;
#ifdef SOFT_DEPTH
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uCamPlanes;
uniform float uSoft;
#endif
varying vec3 vCol;
varying float vA;
varying float vR;
varying float vViewZ;
void main() {
  // Two-lobe radial profile across the annulus: a narrow bright band riding a
  // wide soft body, reaching exactly zero at BOTH rims. The old sin^2 was
  // effectively a fat plateau — with an additive colour authored above 1.0 it
  // saturated across most of its width, and a saturated band with a fast
  // shoulder is indistinguishable from an opaque matte torus. This keeps a
  // legible core while spending most of the annulus in visible falloff.
  float e = sin(vR * 3.14159265);
  float a = vA * (0.34 * pow(e, 1.7) + 0.66 * pow(e, 5.5));
#ifdef SOFT_DEPTH
  // Depth fade. A shockwave punched out of a kart necessarily intersects the
  // kart; without this it terminates on a hard curve exactly where it enters
  // the bodywork, which is the "welded plastic prop" read.
  float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
  float nz = uCamPlanes.x, fz = uCamPlanes.y;
  float sceneZ = (2.0 * nz * fz) / (fz + nz - (d * 2.0 - 1.0) * (fz - nz));
  a *= clamp((sceneZ - vViewZ) / uSoft, 0.0, 1.0);
#endif
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Rings {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly data: Float32Array;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private used = 0;
  private liveUntil = -1;

  static readonly STRIDE = 20;

  constructor(readonly capacity: number, segments = 64) {
    const pos = new Float32Array((segments + 1) * 2 * 3);
    const uv = new Float32Array((segments + 1) * 2 * 2);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        pos[o] = cx; pos[o + 1] = 0; pos[o + 2] = cz;
        uv[(i * 2 + k) * 2] = k;          // 0 = inner rim, 1 = outer rim
        uv[(i * 2 + k) * 2 + 1] = i / segments;
      }
    }
    const idx = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx[i * 6] = a; idx[i * 6 + 1] = a + 1; idx[i * 6 + 2] = a + 2;
      idx[i * 6 + 3] = a + 1; idx[i * 6 + 4] = a + 3; idx[i * 6 + 5] = a + 2;
    }

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.data = new Float32Array(capacity * Rings.STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, Rings.STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    const names = ['aCen', 'aRad', 'aQuat', 'aCol', 'aDrift'];
    for (let i = 0; i < names.length; i++) {
      this.geo.setAttribute(names[i], new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    }
    this.geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uGain: { value: 1 },
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uCamPlanes: { value: new THREE.Vector2(0.2, 3000) },
        // ~0.7 m of intersection distance: long enough to swallow a wheel or a
        // roll bar, short enough that a ring against the road still reads.
        uSoft: { value: 0.7 },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;
  }

  set gain(v: number) { this.material.uniforms.uGain.value = v; }

  resize(w: number, h: number) { this.material.uniforms.uInvRes.value.set(1 / w, 1 / h); }

  setDepthTexture(tex: THREE.Texture | null, near: number, far: number) {
    const m = this.material;
    const had = m.defines.SOFT_DEPTH !== undefined;
    const want = !!tex;
    m.uniforms.uDepth.value = tex;
    m.uniforms.uCamPlanes.value.set(near, far);
    if (want !== had) {
      if (want) m.defines.SOFT_DEPTH = ''; else delete m.defines.SOFT_DEPTH;
      m.needsUpdate = true;
    }
  }

  /**
   * `drift` (optional) is the velocity the ring's centre inherits, decayed by
   * `driftDrag`. Pass the emitting kart's velocity and the ring stays with the
   * car instead of being left behind on the road.
   */
  spawn(p: THREE.Vector3, normal: THREE.Vector3, r0: number, r1: number, life: number,
        thickness: number, color: THREE.Color, intensity: number, now: number,
        drift: THREE.Vector3 | null = null, driftDrag = 0.9) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    const o = i * Rings.STRIDE;
    const d = this.data;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = now;
    d[o + 4] = r0; d[o + 5] = r1; d[o + 6] = life; d[o + 7] = thickness;
    _quat.setFromUnitVectors(UP, _n.copy(normal).normalize());
    d[o + 8] = _quat.x; d[o + 9] = _quat.y; d[o + 10] = _quat.z; d[o + 11] = _quat.w;
    d[o + 12] = color.r * intensity; d[o + 13] = color.g * intensity; d[o + 14] = color.b * intensity;
    d[o + 15] = 1;
    d[o + 16] = drift ? drift.x : 0;
    d[o + 17] = drift ? drift.y : 0;
    d[o + 18] = drift ? drift.z : 0;
    d[o + 19] = driftDrag;
    this.buf.needsUpdate = true;
    if (now + life > this.liveUntil) this.liveUntil = now + life;
  }

  update(now: number) {
    this.material.uniforms.uTime.value = now;
    this.geo.instanceCount = now > this.liveUntil ? 0 : this.used;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Dust motes — the low sun catching airborne particulate near the camera.
//  Entirely GPU-resident: positions are hashed, wrapped around the camera and
//  drifted in the vertex shader, so this is one draw and zero CPU forever.
// ===========================================================================

const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform float uBox;
uniform float uFar;
attribute vec4 aSeed;
varying float vA;
varying vec2 vQ;

void main() {
  vec3 base = aSeed.xyz * (2.0 * uBox);
  float t = uTime * (0.10 + aSeed.w * 0.14);
  base += vec3(sin(t * 1.7 + aSeed.x * 41.0),
               sin(t * 1.1 + aSeed.y * 27.0) * 0.55,
               cos(t * 1.4 + aSeed.z * 33.0)) * 0.7;
  // wrap into the box centred on the camera
  vec3 p = uCam + mod(base - uCam + uBox, 2.0 * uBox) - uBox;

  vec3 d = p - uCam;
  float dist = length(d);
  vec3 vdir = d / max(dist, 1e-4);
  // Motes only really exist when they are between you and the sun.
  float fs = pow(max(dot(vdir, uSunDir), 0.0), 3.5);
  // kept low: motes should read as haze in the light shafts, never a starfield
  vA = (0.07 + 0.85 * fs)
     * smoothstep(uFar, uFar * 0.45, dist)
     * smoothstep(0.7, 2.6, dist);
  if (vA < 0.002) { vQ = vec2(0.0); gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float sz = (0.022 + aSeed.w * 0.045) * (1.0 + dist * 0.06);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 vert = p + camRight * (position.x * sz) + camUp * (position.y * sz);
  vQ = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(vert, 1.0);
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
varying float vA;
varying vec2 vQ;
void main() {
  float d = length(vQ);
  float a = vA * pow(max(0.0, 1.0 - d), 2.2);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Motes {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(count: number, box: number, far: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = count;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uBox: { value: box }, uFar: { value: far },
        uColor: { value: C_SUNMOTE.clone().multiplyScalar(1.6) },
        uGain: { value: 1 },
      },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 13;
  }

  update(time: number, cam: THREE.Vector3, sunDir: THREE.Vector3, gain: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCam.value.copy(cam);
    u.uSunDir.value.copy(sunDir);
    u.uGain.value = gain;
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Gulls — instanced, flapped and flown in the vertex shader.
// ===========================================================================

const GULL_VERT = /* glsl */ `
uniform float uTime;
attribute vec4 aOrbit;  // xyz centre, w radius
attribute vec4 aPhase;  // x phase, y angular speed, z flap rate, w scale
varying float vTip;
varying float vShade;

void main() {
  float ang = uTime * aPhase.y + aPhase.x;
  vec3 c = aOrbit.xyz + vec3(cos(ang), 0.0, sin(ang)) * aOrbit.w;
  c.y += sin(ang * 2.0 + aPhase.x) * 1.8;

  vec3 fwd = vec3(-sin(ang), 0.0, cos(ang));
  vec3 right = vec3(cos(ang), 0.0, sin(ang));
  vec3 up = vec3(0.0, 1.0, 0.0);

  float flap = sin(uTime * aPhase.z + aPhase.x * 3.0) * 0.85;
  // position doubles as the bird-local frame: x span, y up, z along the body
  float span = abs(position.x);
  vec3 L = position;
  L.y += sin(flap) * span * 1.15;
  L.x *= cos(flap * 0.55);
  // bank into the turn
  float bank = 0.25;
  vec3 r2 = right * cos(bank) + up * sin(bank);
  vec3 u2 = up * cos(bank) - right * sin(bank);

  vec3 wp = c + (r2 * L.x + u2 * L.y + fwd * L.z) * aPhase.w;
  vTip = span;
  vShade = 0.55 + 0.45 * clamp(cos(flap), 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const GULL_FRAG = /* glsl */ `
uniform vec3 uLight;
varying float vTip;
varying float vShade;
void main() {
  // white body, charcoal wingtips — reads at any distance
  vec3 albedo = mix(vec3(0.95, 0.94, 0.90), vec3(0.16, 0.16, 0.18), smoothstep(0.62, 0.95, vTip));
  gl_FragColor = vec4(albedo * uLight * vShade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Gulls {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(count: number, centre: THREE.Vector3) {
    // Six triangles: two per wing, two for the body sliver.
    const L: number[] = [];
    const push = (a: number[], b: number[], c: number[]) => { L.push(...a, ...b, ...c); };
    for (const s of [-1, 1]) {
      push([0, 0, 0.1], [s * 0.5, 0.02, 0.22], [s * 1.0, 0.0, -0.02]);
      push([0, 0, 0.1], [s * 1.0, 0.0, -0.02], [s * 0.42, -0.01, -0.24]);
    }
    push([0, 0.03, 0.42], [-0.075, 0, -0.02], [0.075, 0, -0.02]);
    push([0, 0.0, -0.46], [0.075, 0, -0.02], [-0.075, 0, -0.02]);

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(L), 3));

    const orbit = new Float32Array(count * 4);
    const phase = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      orbit[i * 4] = centre.x + (Math.random() - 0.5) * 70;
      orbit[i * 4 + 1] = centre.y + 14 + Math.random() * 26;
      orbit[i * 4 + 2] = centre.z + (Math.random() - 0.5) * 70;
      orbit[i * 4 + 3] = 16 + Math.random() * 46;
      phase[i * 4] = Math.random() * Math.PI * 2;
      phase[i * 4 + 1] = (0.055 + Math.random() * 0.06) * (Math.random() < 0.5 ? -1 : 1);
      phase[i * 4 + 2] = 3.4 + Math.random() * 2.2;
      phase[i * 4 + 3] = 0.9 + Math.random() * 0.55;
    }
    this.geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    this.geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 4));
    this.geo.instanceCount = count;
    this.geo.boundingSphere = new THREE.Sphere(centre.clone(), 400);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: GULL_VERT,
      fragmentShader: GULL_FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.matrixAutoUpdate = false;
  }

  update(time: number, light: THREE.Color) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uLight.value.copy(light);
  }

  dispose() { this.geo.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Heat shimmer — a warm haze band that hangs over hot tarmac in the middle
//  distance. Without access to the post chain we cannot refract, so this
//  deliberately stays a low-amplitude scattering veil rather than pretending.
// ===========================================================================

const SHIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHIM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAmount;
uniform vec3 uColor;
uniform float uGain;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  if (uAmount <= 0.001) discard;
  // vertical wobble of the sample point is what sells "rising air"
  float wob = vnoise(vec2(vUv.x * 9.0, uTime * 0.9)) - 0.5;
  vec2 q = vec2(vUv.x * 14.0 - uTime * 0.35, vUv.y * 4.0 + wob * 0.7 - uTime * 1.25);
  float n = vnoise(q) * 0.65 + vnoise(q * 2.3 + 5.0) * 0.35;
  float band = smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
  float edge = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
  float a = uAmount * band * edge * smoothstep(0.42, 0.85, n);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class Shimmer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const g = new THREE.PlaneGeometry(70, 4.5, 1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0xffd2a0) }, uGain: { value: 1 },
      },
      vertexShader: SHIM_VERT, fragmentShader: SHIM_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.renderOrder = 13;
    this.mesh.frustumCulled = false;
  }

  place(pos: THREE.Vector3, faceDir: THREE.Vector3, amount: number, time: number, gain: number) {
    this.mesh.position.copy(pos);
    _p.copy(pos).sub(faceDir);
    this.mesh.lookAt(_p);
    this.material.uniforms.uAmount.value = amount;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uGain.value = gain;
    this.mesh.visible = amount > 0.002;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

// ===========================================================================
//  Star power shell — rainbow-cycling fresnel husk around an invincible kart.
// ===========================================================================

const STAR_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec3 vCentre;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vCentre = instanceMatrix[3].xyz;
  vN = normalize(mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const STAR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGain;
varying vec3 vN;
varying vec3 vW;
varying vec3 vCentre;

vec3 hue2rgb(float h) {
  vec3 k = fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0;
  return clamp(abs(k) - 1.0, 0.0, 1.0);
}

void main() {
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.4);
  float h = fract(uTime * 0.55 + dot(vCentre, vec3(0.031, 0.017, 0.023)) + vW.y * 0.16);
  vec3 rgb = mix(vec3(1.0), hue2rgb(h), 0.88);
  float band = 0.5 + 0.5 * sin(vW.y * 9.0 - uTime * 7.0);
  float a = fres * (0.55 + 0.45 * band);
  if (a < 0.005) discard;
  gl_FragColor = vec4(rgb * (0.6 + 1.5 * fres) * uGain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class StarShells {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number) {
    const g = new THREE.IcosahedronGeometry(1, 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uGain: { value: 1 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    });
    this.mesh = new THREE.InstancedMesh(g, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;
  }

  begin() { this.mesh.count = 0; }

  add(pos: THREE.Vector3, quat: THREE.Quaternion, sx: number, sy: number, sz: number) {
    const i = this.mesh.count;
    if (i >= this.mesh.instanceMatrix.count) return;
    _mat.compose(pos, quat, _scaleV.set(sx, sy, sz));
    this.mesh.setMatrixAt(i, _mat);
    this.mesh.count = i + 1;
  }

  end(time: number, gain: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uGain.value = gain;
    if (this.mesh.count > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.mesh.dispose(); }
}

// ===========================================================================
//  Effect lights — a tiny fixed pool of point lights that bright effects can
//  claim for a frame.
// ===========================================================================
//
//  Every additive effect in this file used to be pure emission: sparks, flame
//  and boost pads glowed but lit nothing, so they floated in front of the world
//  instead of being part of it. Coloured light pooling under the tier is what
//  sells the drift read at a glance in a shipped arcade racer.
//
//  The pool is allocated ONCE and the lights stay in the scene for the lifetime
//  of the process with intensity 0 when idle. That matters: three.js keys shader
//  permutations on the light counts, so adding, removing or hiding a light
//  forces every material in the scene to recompile. A fixed count costs a few
//  ALU per lit fragment and never hitches.
//
//  Claims are re-issued every frame and ranked by importance, so the player's
//  drift always outranks a rival's and the pool degrades by dropping the least
//  important claimant rather than by flickering between them.
class EffectLights {
  private readonly lights: THREE.PointLight[] = [];
  /** importance of whatever currently owns each slot, this frame */
  private readonly score: number[] = [];
  private readonly owner: number[] = [];

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.castShadow = false;
      // Never culled out of the light list: see the note above on recompiles.
      l.matrixAutoUpdate = false;
      this.lights.push(l);
      this.score.push(-1);
      this.owner.push(-1);
    }
  }

  get meshes(): THREE.PointLight[] { return this.lights; }

  begin() {
    for (let i = 0; i < this.score.length; i++) this.score[i] = -1;
  }

  /**
   * Ask for a light. `key` identifies the claimant so the same emitter keeps
   * the same slot frame to frame (a light that hops between karts strobes).
   */
  request(key: number, importance: number, p: THREE.Vector3, colour: THREE.Color,
          intensity: number, distance: number) {
    if (this.lights.length === 0 || intensity <= 0) return;
    let slot = -1;
    for (let i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === key) { slot = i; break; }
    }
    if (slot < 0) {
      let worst = 0;
      for (let i = 1; i < this.score.length; i++) if (this.score[i] < this.score[worst]) worst = i;
      if (this.score[worst] >= importance) return;
      slot = worst;
    } else if (this.score[slot] >= importance) {
      return; // this claimant already placed something more important
    }
    this.owner[slot] = key;
    this.score[slot] = importance;
    const l = this.lights[slot];
    l.position.copy(p);
    l.updateMatrix();
    l.color.copy(colour);
    l.intensity = intensity;
    l.distance = distance;
  }

  /** Anything not claimed this frame goes dark (but stays in the light list). */
  end(dt: number) {
    const k = Math.min(1, dt * 18);
    for (let i = 0; i < this.lights.length; i++) {
      if (this.score[i] < 0) {
        const l = this.lights[i];
        if (l.intensity > 0.001) l.intensity -= l.intensity * k;
        else { l.intensity = 0; this.owner[i] = -1; }
      }
    }
  }

  dispose() { for (const l of this.lights) l.removeFromParent(); }
}

// ===========================================================================
//  Per-kart effect state
// ===========================================================================

class KartFx {
  sparkAcc = 0;
  smokeAcc = 0;
  dustAcc = 0;
  flameAcc = 0;
  sparkleAcc = 0;
  exhaustAcc = 0;
  scorchAcc = 0;
  poolAcc = 0;
  rollAcc = 0;
  padAcc = 0;
  starAcc = 0;
  trail = -1;
  lastTier = 0;
  /** seconds left of the ignition flash, drives the boost light's overshoot */
  igniteT = 0;
  wasBoosting = false;
  stunPhase = 0;
  /** squash-and-stretch: signed impulse plus its velocity, a critically-ish
   *  damped spring so the chassis rebounds instead of snapping back */
  squash = 0;
  squashV = 0;
  squashOwned = false;
  resolved = false;
  readonly offL = new THREE.Vector3(-0.62, 0, -0.80);
  readonly offR = new THREE.Vector3(0.62, 0, -0.80);
  readonly skidL = new THREE.Vector3();
  readonly skidR = new THREE.Vector3();
  skidding = false;
  skidStrength = 0;
  groundY = 0;
  readonly groundN = new THREE.Vector3(0, 1, 0);
  surface: Surface = Surface.Road;
}

// ===========================================================================
//  Effects
// ===========================================================================

export class Effects implements System {
  private ctx!: Ctx;
  private group = new THREE.Group();
  private particles!: Particles;
  private trails!: Trails;
  private decals!: Decals;
  private rings!: Rings;
  private motes: Motes | null = null;
  private gulls: Gulls | null = null;
  private shimmer: Shimmer | null = null;
  private shells!: StarShells;
  private lights!: EffectLights;
  private unsubscribe: (() => void) | null = null;

  private fx: KartFx[] = [];
  private gain = 1;
  private blastLoad = 0;
  private shimmerAmount = 0;
  private shimmerTimer = 0;
  private readonly shimmerPos = new THREE.Vector3();
  private readonly sprays: THREE.Vector3[] = [];
  private sprayAcc = 0;
  private lastState: RaceState = RaceState.Menu;

  private readonly sunColor = new THREE.Color(0xffd9a8);
  private readonly skyColor = new THREE.Color(0xa8c8ff);
  private readonly bounceColor = new THREE.Color(0xc98f5a);

  init(ctx: Ctx) {
    this.ctx = ctx;
    const q = ctx.settings.quality;
    const dens = ctx.settings.particleDensity;

    const addCap = Math.round(THREE.MathUtils.clamp(3400 * dens, 900, 4200));
    const alphaCap = Math.round(THREE.MathUtils.clamp(2400 * dens, 700, 3000));
    this.particles = new Particles(addCap, alphaCap);
    this.particles.density = dens;
    this.particles.setLighting(ctx.sunDirection, this.sunColor, this.skyColor, this.bounceColor);
    this.particles.resize(ctx.width, ctx.height);

    this.trails = new Trails(16, true);
    this.decals = new Decals(q <= Quality.Low ? 900 : 3200);
    this.rings = new Rings(28);
    this.shells = new StarShells(12);

    this.rings.resize(ctx.width, ctx.height);

    // 3 / 2 / 0 by quality. Three is enough for the player's drift or boost
    // plus the two nearest rivals, which is every case the pack shot has.
    this.lights = new EffectLights(q >= Quality.High ? 3 : q >= Quality.Medium ? 2 : 0);

    this.group.add(
      this.particles.group, this.trails.mesh, this.decals.mesh,
      this.rings.mesh, this.shells.mesh, ...this.lights.meshes,
    );

    if (q >= Quality.Medium) {
      this.motes = new Motes(Math.round(THREE.MathUtils.clamp(760 * dens, 200, 1200)), 26, 24);
      this.group.add(this.motes.mesh);
      this.shimmer = new Shimmer();
      this.group.add(this.shimmer.mesh);
    }
    if (q >= Quality.Medium && ctx.track) {
      const s = ctx.track.sample(0.16);
      this.gulls = new Gulls(q >= Quality.High ? 18 : 10, s.pos);
      this.group.add(this.gulls.mesh);
      this.findSpraySites(ctx);
    }

    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);

    this.unsubscribe = ctx.bus.on(this.onEvent);
  }

  /**
   * Sea spray only makes sense where the road is actually above the water, so
   * the sites are derived from the track's own elevation rather than guessed.
   */
  private findSpraySites(ctx: Ctx) {
    for (let t = 0.30; t < 0.60 && this.sprays.length < 8; t += 0.012) {
      const s = ctx.track.sample(t);
      if (s.pos.y < 9) continue;
      const v = new THREE.Vector3()
        .copy(s.pos)
        .addScaledVector(s.binormal, s.halfWidth + 14 + Math.random() * 10);
      v.y = 0.4;
      this.sprays.push(v);
      t += 0.02;
    }
  }

  resize(w: number, h: number) {
    this.particles?.resize(w, h);
    this.rings?.resize(w, h);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onEvent = (e: GameEvent) => {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.time;
    // Events are raised during the gameplay update, which runs before ours;
    // re-stamp so a burst is born now rather than at last frame's flush.
    this.particles.setTime(now);

    switch (e.type) {
      case 'drift-spark': {
        // Tier promotion: the single most important read in the whole game.
        const fx = this.state(e.kart);
        const tier = Math.min(3, Math.max(1, e.tier));
        const col = C_TIER[tier];
        this.rearPoints(e.kart, fx);

        // Kill what is left of the previous tier BEFORE firing the new burst.
        // Two contradictory tier colours on screen at once is worse than no
        // colour at all — it is the one thing this effect must never do.
        this.particles.retireRecent(true, 260, 0.06);

        const n = 22 + tier * 8;
        const boost = 1.55 + tier * 0.2;
        this.burstSparks(this.skidLRef, col, n, boost);
        this.burstSparks(this.skidRRef, col, n, boost);

        // NO ANNULUS. A 1.7 m-radius vertical torus spawned inside the chassis
        // is geometrically *inside* the kart for its whole life: it cuts through
        // the rear wheels, exits the far side of the bodywork and reads as a
        // plastic hoop welded to the car. The comment this replaces warned that
        // a ground-plane ring reads as a dropped hula hoop and then shipped the
        // same object rotated ninety degrees. Per the art bible §6 the drift
        // signature is *emitted sparks plus a soft ground glow* — no ring at
        // all. Rings are kept for boost ignition and impacts, where they are
        // punched clear of the body along the direction of travel.
        //
        // The flash is a ground-projected radial pool instead: it has area, no
        // silhouette of its own, cannot intersect anything, and it puts the tier
        // colour on the tarmac where the sparks are actually landing.
        _q.copy(e.kart.position); _q.y = fx.groundY + 0.05;
        const p = this.particles.reset();
        p.tile = PTile.Glow; p.mode = PMode.Ground;
        p.life = 0.40; p.lifeJitter = 0.1;
        p.size0 = 2.0; p.size1 = 6.2; p.sizeJitter = 0.1;
        // Carries the kart's velocity, otherwise a 0.4 s flash on a kart doing
        // 25 m/s is stranded eight metres back down the road by the time it
        // fades — which is precisely how the pack shot ended up with a drift
        // ring sitting on empty tarmac next to nothing.
        p.fadeIn = 0.05; p.drag = 0.6; p.count = 1; p.softness = 0;
        this.particles.at(_q.x, _q.y, _q.z);
        this.particles.vel(e.kart.velocity.x, 0, e.kart.velocity.z);
        this.particles.colorA(col, 1.5 + 0.25 * tier, 0.9);
        this.particles.colorB(col, 0.35, 0);
        this.particles.emit(true);

        // A tight hot kiss under each rear wheel on top of the wide pool, so
        // the promotion has a point of origin rather than a vague wash.
        p.life = 0.26; p.size0 = 0.7; p.size1 = 2.4; p.count = 1;
        for (let s = 0; s < 2; s++) {
          const at = s === 0 ? this.skidLRef : this.skidRRef;
          this.particles.at(at.x, fx.groundY + 0.06, at.z);
          this.particles.colorA(C_HOT, 1.6, 0.9);
          this.particles.colorB(col, 0.5, 0);
          this.particles.emit(true);
        }

        // scorch under the burst, so the tier change leaves a mark on the road
        this.decals.blot(_q, fx.groundN, 0.9, DecalTile.Smudge, now, 7, 0.5);
        if (e.kart.isPlayer) ctx.shake(0.055 + tier * 0.02, 0.14);
        break;
      }

      case 'boost':
        this.boostFlash(e.kart, e.tier, now);
        break;

      case 'hop': {
        const fx = this.state(e.kart);
        this.groundPuff(e.kart, fx, 6, 0.5);
        break;
      }

      case 'land': {
        const fx = this.state(e.kart);
        const k = THREE.MathUtils.clamp(e.impact, 0, 1);
        if (k < 0.06) break;
        this.groundPuff(e.kart, fx, 6 + 22 * k, 0.6 + 1.1 * k);
        _p.copy(e.kart.position); _p.y = fx.groundY + 0.05;
        this.rings.spawn(_p, fx.groundN, 0.3, 1.4 + 2.4 * k, 0.38, 0.35, C_SMOKE, 0.35 + 0.4 * k, now);
        this.addSquash(e.kart, -0.30 * k - 0.08);
        if (e.kart.isPlayer) ctx.shake(0.10 + 0.5 * k, 0.2);
        break;
      }

      case 'collide': {
        const k = THREE.MathUtils.clamp(e.impulse / 14, 0, 1);
        if (k < 0.08) break;
        _p.copy(e.kart.position); _p.y += 0.4;
        const p = this.particles.reset();
        p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 1.2;
        p.life = 0.26; p.lifeJitter = 0.4;
        p.size0 = 0.22 + 0.2 * k; p.size1 = 0.03;
        p.gravity = -12; p.drag = 1.6; p.velJitter = 4 + 7 * k;
        p.count = Math.round(6 + 16 * k);
        this.particles.at(_p.x, _p.y, _p.z);
        this.particles.vel(0, 1.5, 0);
        this.particles.colorA(C_SPARK_WHITE, 2.6, 1);
        this.particles.colorB(C_FLAME_MID, 0.8, 0);
        this.particles.emit(true);
        this.addSquash(e.kart, -0.22 * k - 0.06);
        if (e.kart.isPlayer) ctx.shake(0.18 + 0.55 * k, 0.24);
        break;
      }

      case 'item-pickup':
        this.sparkleBurst(e.kart.position, e.kart.stats.color, 18);
        break;

      case 'coin':
        this.sparkleBurst(e.kart.position, C_GOLD, 12);
        break;

      case 'item-use':
        if (e.kind === ItemKind.Star) {
          _p.copy(e.kart.position); _p.y += 0.5;
          this.rings.spawn(_p, UP, 0.4, 3.0, 0.5, 0.22, C_GOLD, 2.2, now);
          this.sparkleBurst(e.kart.position, C_GOLD, 30);
        } else if (e.kind === ItemKind.Mushroom || e.kind === ItemKind.TripleMushroom) {
          this.boostFlash(e.kart, 1, now);
        }
        break;

      case 'hit': {
        const fx = this.state(e.kart);
        this.addSquash(e.kart, e.kind === ItemKind.Bolt ? -0.55 : -0.35);
        if (e.kind === ItemKind.Bomb) {
          _p.copy(e.kart.position); _p.y += 0.5;
          this.explode(_p, fx.groundN, fx.groundY, 1, now);
        } else {
          _p.copy(e.kart.position); _p.y += 0.55;
          this.impactBurst(_p, fx.groundN, now, e.kind === ItemKind.Banana ? 0.55 : 1);
          if (e.kart.isPlayer) this.ctx.shake(0.45, 0.32);
        }
        break;
      }

      case 'lap':
        if (e.kart.isPlayer) {
          _p.copy(e.kart.position); _p.y += 0.3;
          this.rings.spawn(_p, UP, 0.8, 4.2, 0.55, 0.18, C_GOLD, 1.4, now);
          this.sparkleBurst(e.kart.position, C_GOLD, 22);
        }
        break;

      case 'finish':
        if (e.kart.isPlayer) this.confetti(e.kart.position);
        break;

      default:
        break;
    }
  };

  /** Boost ignition: shockwave rings, an exhaust bloom and a tyre chirp. */
  private boostFlash(k: IKart, tier: number, now: number) {
    const fx = this.state(k);
    const col = C_TIER[Math.min(3, Math.max(1, tier))];
    _fwd.copy(k.forward);
    _p.copy(k.position).addScaledVector(_fwd, -0.9);
    _p.y += 0.45;
    // Rings face along the direction of travel, so they read as being punched
    // out of the back of the kart rather than laid on the floor.
    //
    // Intensity is well down from where it was. An annulus authored at 2.0x a
    // saturated primary is above the highlight knee across its whole width once
    // the gain is applied, so the falloff the profile describes never survives
    // into the frame — it arrives as a flat saturated band with a hard shoulder,
    // i.e. as a solid disc. 1.15 / 0.95 keeps the peak just under the knee so
    // the ring blooms at the core and *visibly* falls off at both rims.
    this.rings.spawn(_p, _fwd, 0.35, 2.1 + tier * 0.35, 0.40, 0.16, col, 1.15, now, k.velocity, 0.6);
    this.rings.spawn(_p, _fwd, 0.15, 1.35, 0.26, 0.30, C_HOT, 0.95, now, k.velocity, 0.6);

    const p = this.particles.reset();
    p.tile = PTile.Flame; p.mode = PMode.Stretch; p.stretch = 0.9;
    p.life = 0.26; p.lifeJitter = 0.3;
    p.size0 = 0.85; p.size1 = 0.20; p.sizeJitter = 0.3;
    p.drag = 7; p.gravity = 2.2; p.velJitter = 2.4; p.fadeIn = 0.06; p.count = 16;
    p.groundY = fx.groundY; p.softness = 0.6;
    this.particles.at(_p.x, _p.y, _p.z);
    // Biased up and away rather than straight down the barrel of the chase cam,
    // and carrying most of the kart's velocity so the burst stays with the car
    // instead of being stranded on the tarmac (see boostPlume for why).
    this.particles.vel(
      k.velocity.x * 0.85 - _fwd.x * 3.5, k.velocity.y * 0.85 + 2.6, k.velocity.z * 0.85 - _fwd.z * 3.5);
    this.particles.colorA(C_FLAME_ROOT, 1.6, 0.95);
    this.particles.colorB(C_FLAME_MID, 0.55, 0);
    this.particles.emit(true);

    // Ground flash under the ignition — the thing that makes the boost read as
    // an event that happened *on the road* rather than a sprite over it.
    p.tile = PTile.Glow; p.mode = PMode.Ground; p.stretch = 0;
    p.life = 0.3; p.size0 = 1.8; p.size1 = 6.5; p.sizeJitter = 0.1;
    p.drag = 0.7; p.gravity = 0; p.velJitter = 0; p.count = 1; p.softness = 0;
    this.particles.at(k.position.x, fx.groundY + 0.05, k.position.z);
    this.particles.vel(k.velocity.x, 0, k.velocity.z);
    this.particles.colorA(col, 1.6, 0.85);
    this.particles.colorB(col, 0.3, 0);
    this.particles.emit(true);

    fx.igniteT = 0.30;
    this.tyreSmokePuff(k, fx, 8, 1.4);
    if (k.isPlayer) this.ctx.shake(0.16 + 0.05 * tier, 0.22);
    this.blastLoad = Math.max(this.blastLoad, 0.5);
  }

  // -------------------------------------------------------------------------
  // Public API for other systems (projectiles have no transform in the shared
  // contract, so items/AI can drive these directly if they want trails/blasts)
  // -------------------------------------------------------------------------

  /** Attach a ribbon trail. Returns a handle, or -1 if the pool is full. */
  attachTrail(color: THREE.Color, intensity = 1.4, width = 0.5, maxLen = 7): number {
    return this.trails.acquire(width, color, intensity, 0.85, 0.28, 0.3, maxLen);
  }
  moveTrail(h: number, p: THREE.Vector3) { this.trails.push(h, p.x, p.y, p.z); }
  detachTrail(h: number) { this.trails.release(h); }

  /**
   * Soft contact shadow under a dropped pickup, so items read as sitting on the
   * road rather than pasted over it. Cheap: one decal quad. Items own their
   * own transforms, so they must call this — re-lay it when the item moves, or
   * once with a long `life` for something that has settled.
   */
  blobShadow(p: THREE.Vector3, normal: THREE.Vector3, radius = 0.42, life = 1e6) {
    this.decals.blot(p, normal, radius, DecalTile.Smudge, this.ctx.time, life, 0.55,
      0.05, 0.045, 0.05);
  }

  /** Full explosion at a world point: fireball, smoke, debris, scorch, shake. */
  explodeAt(p: THREE.Vector3, normal: THREE.Vector3, groundY: number, scale = 1) {
    this.explode(p, normal, groundY, scale, this.ctx.time);
  }

  /**
   * Hand the smoke layer a scene depth texture to enable true soft particles.
   * Optional: without one we fall back to the analytic ground-plane fade, which
   * already removes the hard intersection line against the road. Pass null to
   * turn the depth comparison back off (e.g. when the target is recreated).
   *
   * The pipeline can also simply publish `depthTexture` on the shared context
   * and we will pick it up automatically each frame.
   */
  setDepthTexture(tex: THREE.Texture | null, near: number, far: number) {
    this.lastDepth = tex;
    this.particles.setDepthTexture(tex, near, far);
    this.rings.setDepthTexture(tex, near, far);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(ctx: Ctx, dt: number) {
    const race = ctx.race;
    const karts = race?.karts;
    const now = ctx.time;
    // Everything emitted this frame is born now, not at last frame's flush.
    this.particles.setTime(now);

    if (race && race.state !== this.lastState) {
      // A fresh countdown means a fresh track surface.
      if (race.state === RaceState.Countdown) this.decals.clear();
      this.lastState = race.state;
    }

    this.updateGain(ctx, dt);
    // Smoke and dust must live in whatever light the sky system is actually
    // producing — including going flat and cool inside the tunnel — so track
    // the key light rather than baking the golden-hour values in.
    if (ctx.sun) {
      this.sunColor.copy(ctx.sun.color).multiplyScalar(Math.min(1.2, ctx.sun.intensity * 0.26));
    }
    this.particles.setLighting(ctx.sunDirection, this.sunColor, this.skyColor, this.bounceColor);

    this.lights.begin();
    if (karts) {
      for (let i = 0; i < karts.length; i++) this.updateKart(ctx, karts[i], dt, now);
    }
    this.lights.end(dt);

    this.updateAmbient(ctx, dt, now);
    this.updateSignals(ctx, dt);
  }

  lateUpdate(ctx: Ctx, dt: number) {
    const karts = ctx.race?.karts;
    const now = ctx.time;

    // Star shells and the squash pulse are applied after physics has finished
    // writing the chassis for the frame.
    this.shells.begin();
    if (karts) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const fx = this.state(k);
        if (k.starTime > 0) {
          _p.copy(k.position); _p.y += 0.42;
          const pulse = 1 + Math.sin(now * 11 + k.id) * 0.035;
          this.shells.add(_p, k.quaternion, 1.05 * pulse, 0.72 * pulse, 1.42 * pulse);
        }
        this.applySquash(k, fx, dt);
      }
    }
    this.shells.end(now, this.gain);

    this.trails.update(dt);
    this.decals.update(now);
    this.rings.update(now);
    this.rings.gain = this.gain;
    this.trails.gain = this.gain;
    this.particles.additiveGain = this.gain;
    this.particles.update(now);

    // Opportunistic true soft particles: if whoever owns the render pipeline
    // publishes a scene depth texture on the context we pick it up for free.
    const depth = (ctx as any).depthTexture as THREE.Texture | undefined;
    if (depth !== this.lastDepth) {
      this.lastDepth = depth ?? null;
      this.rings.setDepthTexture(this.lastDepth, ctx.camera.near, ctx.camera.far);
      this.particles.setDepthTexture(this.lastDepth, ctx.camera.near, ctx.camera.far);
    }
  }

  private lastDepth: THREE.Texture | null = null;

  // -------------------------------------------------------------------------

  private state(k: IKart): KartFx {
    let s = this.fx[k.id];
    if (!s) {
      s = new KartFx();
      // Seed the ground plane so an event fired before this kart's first
      // update() still puts its sparks somewhere sane.
      s.groundY = k.position.y;
      this.fx[k.id] = s;
    }
    return s;
  }

  /**
   * Additive budget. Each bright effect on screen contributes load weighted by
   * how close it is to the camera; the shared gain then falls hyperbolically.
   * One boosting kart is free; a purple drift plus a boost plus a star costs
   * about half the additive brightness, which is precisely the case the art
   * direction says must not white out.
   */
  private updateGain(ctx: Ctx, dt: number) {
    let load = 0;
    const karts = ctx.race?.karts;
    if (karts) {
      const cam = ctx.camera.position;
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const d = cam.distanceTo(k.position);
        if (d > 70) continue;
        const w = 1 - d / 70;
        if (k.boostTime > 0) load += 1.0 * w;
        if (k.driftTier > 0) load += (0.3 + 0.35 * k.driftTier) * w;
        if (k.starTime > 0) load += 0.85 * w;
        // A kart standing on a boost pad is sitting on the brightest surface in
        // the game with its own blue wash on top. This is the third term of the
        // exact worst case §6 names: boost + drift + tunnel-exit bloom.
        if (this.fx[k.id]?.surface === Surface.Boost) load += 0.7 * w;
      }
    }
    this.blastLoad = Math.max(0, this.blastLoad - dt * 1.4);
    load += this.blastLoad;
    const target = THREE.MathUtils.clamp(1 / (1 + 0.42 * Math.max(0, load - 1)), 0.42, 1);
    this.gain += (target - this.gain) * damp(dt, 0.0015);
  }

  /**
   * Drives the render/camera effect requests declared on Ctx.
   *
   * SINGLE OWNER. Both this and Race.updateCamera used to read-modify-write
   * ctx.speedIntensity and ctx.fovPunch every frame with different curves and
   * different time constants. Because each of them accumulated ONTO the shared
   * field rather than onto its own state, whichever ran last did not just win —
   * it destroyed the other's smoothing, so the eased curve degenerated into
   * whatever the last writer's instantaneous value was.
   *
   * The fix is to keep the state here and *assign* the result, so the published
   * value is a well-formed curve no matter what order the systems run in.
   * Race.updateCamera's copy still needs deleting; see the round-2 report.
   */
  private signalSpeed = 0;
  private signalFov = 0;

  private updateSignals(ctx: Ctx, dt: number) {
    const k = ctx.race?.player;
    if (!k) {
      this.signalSpeed = 0; this.signalFov = 0;
      ctx.speedIntensity = 0; ctx.fovPunch = 0;
      return;
    }
    const racing = ctx.race?.state !== RaceState.Countdown;
    const top = 30 * (k.stats?.topSpeedMul ?? 1);
    const ratio = THREE.MathUtils.clamp(Math.abs(k.forwardSpeed) / top, 0, 1.4);
    // Speed lines only above ~70% of top speed, and they ramp, never pop.
    const want = racing ? THREE.MathUtils.clamp((ratio - 0.70) / 0.42, 0, 1) : 0;
    const boost = racing && k.boostTime > 0 ? 1 : 0;

    const speedTarget = Math.min(1, want + boost * 0.55);
    this.signalSpeed += (speedTarget - this.signalSpeed) * damp(dt, 0.02);
    ctx.speedIntensity = this.signalSpeed;

    // Punch in fast, ease out slowly — the asymmetry is the whole kick. Held
    // here rather than left to the camera so the ramp survives an ordering
    // change, and so a stun visibly pulls the frame back in.
    let fovTarget = boost * 7.5 + want * 3.2;
    if (k.driftTier > 0 && !boost) fovTarget = Math.max(fovTarget, 1.1 * k.driftTier);
    if (k.stunTime > 0) fovTarget = -3;
    const rate = fovTarget > this.signalFov ? 12 : 4.5;
    this.signalFov += (fovTarget - this.signalFov) * Math.min(1, dt * rate);
    ctx.fovPunch = this.signalFov;
  }

  // -------------------------------------------------------------------------
  // Per-kart continuous effects
  // -------------------------------------------------------------------------

  private readonly skidLRef = new THREE.Vector3();
  private readonly skidRRef = new THREE.Vector3();

  /** Resolve rear-wheel offsets once, from whatever model the kart shipped. */
  private resolveOffsets(k: IKart, fx: KartFx) {
    if (fx.resolved) return;
    fx.resolved = true;
    const w = k.wheels;
    if (!w || w.length < 4) return;
    let i0 = -1, i1 = -1, z0 = Infinity, z1 = Infinity;
    for (let i = 0; i < w.length; i++) {
      const z = w[i].position.z;
      if (z < z0) { z1 = z0; i1 = i0; z0 = z; i0 = i; }
      else if (z < z1) { z1 = z; i1 = i; }
    }
    if (i0 < 0 || i1 < 0) return;
    // Guard the pair actually straddles the centreline. A model that lists its
    // wheels in an unexpected order, or with a rear axle at the same z, can
    // otherwise hand back two wheels on the SAME side — both spark streams then
    // land on top of each other and the drift looks one-sided. Defaults are
    // already a sane rear axle, so falling back to them is safe.
    const xa = w[i0].position.x, xb = w[i1].position.x;
    if (xa * xb >= 0 || Math.abs(xa - xb) < 0.2) return;
    const l = xa < xb ? i0 : i1;
    const r = xa < xb ? i1 : i0;
    fx.offL.set(w[l].position.x, 0, w[l].position.z);
    fx.offR.set(w[r].position.x, 0, w[r].position.z);
  }

  /** World-space rear contact patches, projected onto the local ground plane. */
  private rearPoints(k: IKart, fx: KartFx) {
    this.resolveOffsets(k, fx);
    for (let s = 0; s < 2; s++) {
      const off = s === 0 ? fx.offL : fx.offR;
      const out = s === 0 ? this.skidLRef : this.skidRRef;
      out.copy(off).applyQuaternion(k.quaternion).add(k.position);
      const n = fx.groundN;
      // plane through (kart.xz, groundY) with normal n
      out.y = fx.groundY - (n.x * (out.x - k.position.x) + n.z * (out.z - k.position.z)) / (n.y || 1);
      out.y += 0.04;
    }
  }

  private updateKart(ctx: Ctx, k: IKart, dt: number, now: number) {
    const fx = this.state(k);
    const cam = ctx.camera.position;
    const dist = cam.distanceTo(k.position);
    // Everything below is readability for a kart you can see. Beyond 120 m the
    // kart is a few pixels wide and its dust would be noise.
    if (dist > 120) {
      if (fx.trail >= 0) { this.trails.release(fx.trail); fx.trail = -1; }
      fx.skidding = false;
      return;
    }

    const probe = ctx.track.probe(k.position, k.t);
    fx.groundY = probe.y;
    fx.groundN.copy(probe.normal);
    fx.surface = probe.surface;
    this.rearPoints(k, fx);

    const speed = Math.abs(k.forwardSpeed);
    const grounded = !k.airborne;
    const props = SURFACE_PROPS[fx.surface] ?? SURFACE_PROPS[Surface.Road];
    // Near effects get full rate; distant ones thin out so the far pack does
    // not quietly eat the particle budget.
    const lod = dist < 30 ? 1 : dist < 70 ? 0.45 : 0.18;

    // --- drift: sparks, smoke, skid marks ---------------------------------
    const drifting = k.driftDir !== 0 && grounded && speed > 4;
    if (drifting && k.driftTier > 0) {
      const tier = Math.min(3, k.driftTier);
      const col = C_TIER[tier];
      fx.sparkAcc += dt * (58 + 22 * tier) * lod;
      const n = Math.floor(fx.sparkAcc);
      if (n > 0) {
        fx.sparkAcc -= n;
        this.emitSparks(this.skidLRef, k, col, n, tier, -1);
        this.emitSparks(this.skidRRef, k, col, n, tier, 1);
      }

      // Coloured light pool on the road under the sparks. Sparks that light
      // nothing float in front of the world; this is the single change that
      // makes the tier read at a glance in a moving frame. Two cheap ground
      // quads carry it on every kart...
      fx.poolAcc += dt * 26 * lod;
      const np = Math.floor(fx.poolAcc);
      if (np > 0) {
        fx.poolAcc -= np;
        this.groundPool(k, fx, col, tier);
      }
      // ...and the nearest few karts additionally get a real point light, so
      // the tarmac, the kerb and the kart's own underbody all pick the tier up.
      if (dist < 45) {
        _p.copy(k.position).addScaledVector(k.forward, -0.7);
        _p.y = fx.groundY + 0.55;
        // Candela: three is physically-correct, so this is divided by r^2 at the
        // shading point. The pool sits ~0.55 m off the tarmac, so 0.6 lands
        // around 2 lx under a tier-1 drift against a 4.2 key — a clear coloured
        // wash, not a blowout.
        this.lights.request(
          k.id, (k.isPlayer ? 100 : 10) + tier - dist * 0.05, _p, col,
          (0.25 + 0.35 * tier) * (1 - dist / 45) * this.gain, 5.0);
      }

      // Scorch under the tyres. Was gated to tier 2+, which meant the entire
      // blue tier — the one every drift passes through — left nothing behind.
      fx.scorchAcc += dt * (5 + 2 * tier);
      if (fx.scorchAcc >= 1) {
        fx.scorchAcc = 0;
        const at = Math.random() < 0.5 ? this.skidLRef : this.skidRRef;
        this.decals.blot(at, fx.groundN, 0.42, DecalTile.Smudge, now, 5.5, 0.25 + 0.12 * tier);
      }
    } else {
      fx.sparkAcc = 0;
      fx.poolAcc = 0;
    }

    // Lateral slip, 0..1, from the actual velocity rather than the drift flag.
    // The drift button is not the only way to end up sideways, and more to the
    // point a kart that has just released a drift is still sliding — gating the
    // rubber on `driftDir` is why the hero corner had a kart mid-slide over
    // perfectly clean tarmac with no trace of the line it took.
    let slip = 0;
    if (grounded && speed > 3) {
      _side.crossVectors(UP, k.forward).normalize();
      const lat = Math.abs(k.velocity.dot(_side));
      slip = THREE.MathUtils.clamp((lat / Math.max(speed, 1) - 0.10) / 0.30, 0, 1);
    }

    if (drifting) {
      // Smoke is the only thing that gives a drift mass. It has to scale with
      // the charge, or a tier-3 drift looks exactly like a tier-0 one.
      const tier = Math.min(3, k.driftTier);
      fx.smokeAcc += dt * (26 + 14 * tier) * lod;
      const n = Math.floor(fx.smokeAcc);
      if (n > 0) {
        fx.smokeAcc -= n;
        this.tyreSmoke(k, fx, this.skidLRef, n, props.dustColor);
        this.tyreSmoke(k, fx, this.skidRRef, n, props.dustColor);
      }
    } else {
      fx.smokeAcc = 0;
    }

    // Rubber. Laid for anything actually sliding, drifting or not, and out to
    // 95 m so the pack in front of you leaves a readable line too. Clean tarmac
    // behind a drifting kart costs the frame its whole sense of history; the
    // decal ring is 3200 quads and a segment is 0.55 m, so a kart can lay ~40 m
    // of continuous mark before it starts recycling its own oldest slot.
    const marking = grounded && speed > 5 && dist < 95 &&
      (drifting || slip > 0.25) &&
      fx.surface !== Surface.Water;
    if (marking) {
      this.layStrip(fx, now, THREE.MathUtils.clamp(
        Math.max(slip, drifting ? 0.55 : 0) * Math.min(1, speed / 14), 0.25, 1));
    } else if (fx.skidding) {
      fx.skidding = false; fx.skidStrength = 0;
    }

    // --- surface reaction: dust, spray, sand ------------------------------
    if (grounded && speed > 5) {
      const s = fx.surface;
      if (s === Surface.Water) {
        fx.dustAcc += dt * 30 * lod * (speed / 20);
        const n = Math.floor(fx.dustAcc);
        if (n > 0) { fx.dustAcc -= n; this.waterSpray(k, fx, n); }
      } else if (s !== Surface.Road && s !== Surface.Boost) {
        const heavy = s === Surface.Sand;
        fx.dustAcc += dt * (heavy ? 26 : 18) * lod * (speed / 20);
        const n = Math.floor(fx.dustAcc);
        if (n > 0) { fx.dustAcc -= n; this.surfaceDust(k, fx, n, props.dustColor, heavy); }
      } else {
        fx.dustAcc = 0;
      }
    }

    // --- boost: plume, trail, glow ----------------------------------------
    const boosting = k.boostTime > 0;
    fx.igniteT = Math.max(0, fx.igniteT - dt);
    if (boosting) {
      const btier = Math.min(3, Math.max(1, k.driftTier || 1));
      fx.flameAcc += dt * 105 * lod;
      const n = Math.floor(fx.flameAcc);
      if (n > 0) { fx.flameAcc -= n; this.boostPlume(k, n); }
      if (fx.trail < 0 && dist < 90) {
        // Boost palette, NOT the livery. Deriving the ribbon colour from the
        // kart's paint is why the hero boost frame trailed a rust-brown streak
        // that read as a mud smear: a red kart lerped toward cream lands on
        // exactly the hue of dried dirt. §3 fixes boost at #4fc3ff / #ff9d2e /
        // #c05cff and the ribbon has to be one of the three, whatever colour
        // the car is painted.
        _col.copy(C_TIER[btier]).lerp(C_FLAME_ROOT, 0.18);
        // Narrow and short. This is a heat ribbon threading the plume
        // together, not the effect itself — at 0.62 m wide, 1.5x intensity and
        // ~11 m long it was the widest, flattest, brightest thing on screen the
        // moment its tail swung past the chase camera. 4.5 m keeps the whole
        // ribbon in front of the lens at every rig distance.
        fx.trail = this.trails.acquire(0.40, _col, 1.5, 0.5, 0.16, 0.22, 4.5);
      }
      if (fx.trail >= 0) {
        _p.copy(k.position).addScaledVector(k.forward, -0.95); _p.y += 0.50;
        this.trails.push(fx.trail, _p.x, _p.y, _p.z);
      }
      // The flame has to light the rear bodywork or it floats on top of it.
      // Ignition overshoots hard for a third of a second, then settles.
      if (dist < 55) {
        _p.copy(k.position).addScaledVector(k.forward, -1.0); _p.y += 0.55;
        _col.copy(C_TIER[btier]).lerp(C_FLAME_MID, 0.45);
        const kick = 1 + 1.6 * (fx.igniteT / 0.30);
        this.lights.request(
          k.id, (k.isPlayer ? 200 : 60) - dist * 0.05, _p, _col,
          0.7 * kick * (1 - dist / 55) * this.gain, 7.0);
      }
    } else if (fx.trail >= 0) {
      this.trails.release(fx.trail);
      fx.trail = -1;
    }
    fx.wasBoosting = boosting;

    // --- boost pad contact -------------------------------------------------
    // The pad is the brightest surface on the circuit and it lit nothing at
    // all: a kart crossing it was graded exactly as it was a metre earlier.
    // The pad's own material belongs to the track, but the response of a kart
    // standing on it is ours, and it is most of what sells the pad.
    if (grounded && fx.surface === Surface.Boost && speed > 6) {
      const padCol = C_TIER[1];
      if (dist < 50) {
        _p.copy(k.position); _p.y = fx.groundY + 0.7;
        this.lights.request(
          // Keys must stay clear of the pool's "unowned" sentinel (-1) and of
          // the drift/boost keys, which are raw kart ids.
          1000 + k.id, (k.isPlayer ? 150 : 40) - dist * 0.05, _p, padCol,
          1.0 * (1 - dist / 50) * this.gain, 6.5);
      }
      fx.padAcc += dt * 34 * lod;
      const np = Math.floor(fx.padAcc);
      if (np > 0) {
        fx.padAcc -= np;
        // Rising heat off the strip plus a wash of pad-blue under the kart.
        const p = this.particles.reset();
        p.tile = PTile.Glow; p.mode = PMode.Ground;
        p.life = 0.35; p.lifeJitter = 0.3;
        p.size0 = 1.5; p.size1 = 4.0; p.sizeJitter = 0.3;
        p.drag = 1.2; p.count = 1; p.softness = 0; p.fadeIn = 0.15;
        this.particles.at(k.position.x, fx.groundY + 0.04, k.position.z);
        this.particles.vel(k.velocity.x * 0.5, 0, k.velocity.z * 0.5);
        this.particles.colorA(padCol, 0.75, 0.55);
        this.particles.colorB(padCol, 0.2, 0);
        this.particles.emit(true);

        p.mode = PMode.Billboard; p.tile = PTile.Core;
        p.life = 0.3; p.size0 = 0.09; p.size1 = 0.02; p.sizeJitter = 0.5;
        p.gravity = 1.6; p.drag = 2.0; p.velJitter = 1.4; p.posJitter = 0.5;
        p.count = Math.max(1, np >> 1); p.fadeIn = 0.05;
        this.particles.at(k.position.x, fx.groundY + 0.12, k.position.z);
        this.particles.vel(0, 2.6, 0);
        this.particles.colorA(padCol, 3.2, 1);
        this.particles.colorB(padCol, 0.8, 0);
        this.particles.emit(true);
      }
    } else {
      fx.padAcc = 0;
    }

    // --- idle exhaust ------------------------------------------------------
    // A pack shot has to look like eight running engines. Every other emitter
    // in this file is conditional on drifting, boosting, being stunned or
    // leaving the road, so a rival holding a clean line at 25 m/s emits
    // literally nothing and reads as a static prop. This is the baseline: a
    // thin, warm, sun-lit wisp off the stacks, cheap enough to run on the whole
    // field (~9 puffs/s/kart before LOD).
    if (!boosting && grounded && speed > 6 && dist < 70) {
      fx.exhaustAcc += dt * 9 * lod * Math.min(1, speed / 14);
      const n = Math.floor(fx.exhaustAcc);
      if (n > 0) { fx.exhaustAcc -= n; this.idleExhaust(k, fx, n); }
    } else {
      fx.exhaustAcc = 0;
    }

    // --- tyre contact at speed --------------------------------------------
    // Separate from the exhaust and from the off-road dust: this is the thin
    // veil a hot tyre throws off tarmac. Without it the hero kart at 92 km/h
    // emitted *nothing at all* and was indistinguishable from a parked one
    // while the rival two car-lengths away threw sparks and smoke. Speed-scaled
    // so it disappears at a crawl and never fights the drift smoke.
    if (grounded && !drifting && dist < 55) {
      const sr = THREE.MathUtils.clamp((speed - 11) / 16, 0, 1);
      if (sr > 0) {
        fx.rollAcc += dt * 15 * sr * lod;
        const n = Math.floor(fx.rollAcc);
        if (n > 0) { fx.rollAcc -= n; this.rollDust(k, fx, n, props.dustColor, sr); }
      } else {
        fx.rollAcc = 0;
      }
    } else {
      fx.rollAcc = 0;
    }

    // --- star power sparkle trail -----------------------------------------
    if (k.starTime > 0) {
      fx.starAcc += dt * 34 * lod;
      const n = Math.floor(fx.starAcc);
      if (n > 0) { fx.starAcc -= n; this.starSparkle(k, n, now); }
    } else {
      fx.starAcc = 0;
    }

    // --- spin-out stars ----------------------------------------------------
    if (k.stunTime > 0) {
      fx.stunPhase += dt * 5.4;
      fx.sparkleAcc += dt * 26 * lod;
      const n = Math.floor(fx.sparkleAcc);
      if (n > 0) { fx.sparkleAcc -= n; this.stunStars(k, fx, n); }
    } else {
      fx.sparkleAcc = 0;
    }

    // tier bookkeeping for the burst on promotion is handled by the bus event
    fx.lastTier = k.driftTier;
  }

  // --- emitters ------------------------------------------------------------

  /**
   * `side` is -1 for the left contact patch and +1 for the right. The two
   * streams must not be identical: a single shared velocity makes both wheels
   * throw the same cone and the pair collapses into one clump under the middle
   * of the kart, which is exactly what the tier-2 shot showed.
   */
  private emitSparks(at: THREE.Vector3, k: IKart, col: THREE.Color, n: number, tier: number, side: number) {
    // sparks fly backwards and away from the direction of the turn
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).multiplyScalar(-k.driftDir);
    const sp = 3.4 + tier * 1.1;
    // The outside wheel is the one loaded up, so it throws harder and wider.
    const outside = side === -k.driftDir ? 1.25 : 0.75;
    const splay = side * 1.6;

    const p = this.particles.reset();
    p.tile = PTile.Core;
    p.mode = PMode.Stretch;
    // Sparks must streak along their own velocity or they read as evenly
    // scattered decorative confetti composited over the scene — which is
    // exactly what a uniform 1.7 was producing at chase-camera angles.
    p.stretch = 3.6;
    p.life = 0.26; p.lifeJitter = 0.5;
    p.size0 = 0.15 + 0.03 * tier; p.size1 = 0.02;
    // 0.5..1.5x. Uniformly-sized sparks are the other half of the confetti
    // read; real ones come off a tyre in a wide spread of masses.
    p.sizeJitter = 0.5;
    p.gravity = -13; p.drag = 1.5;
    p.posJitter = 0.09; p.velJitter = 2.4; p.velScatter = 0.5;
    p.fadeIn = 0.03;
    // Bias the count to the loaded outside wheel, not just its speed.
    p.count = Math.max(1, Math.round(n * (outside > 1 ? 1.35 : 0.7)));
    this.particles.at(at.x, at.y, at.z);
    // A real 3D cone: backwards, outwards along the wheel's own side, and up.
    _r.crossVectors(UP, _fwd);
    this.particles.vel(
      -_fwd.x * sp * 0.75 + (_side.x * sp + _r.x * splay) * outside,
      2.5 + tier * 0.5,
      -_fwd.z * sp * 0.75 + (_side.z * sp + _r.z * splay) * outside);
    // Authored well above 1.0 so the ADDITIVE core-whitening in Particles has
    // something to clip: the middle of the sprite blows out to neutral white
    // and blooms, and the tier hue lives in the falloff around it.
    this.particles.colorA(col, 4.5, 1);
    this.particles.colorB(col, 1.2, 0);
    this.particles.emit(true);

    // Soft halo behind the cores. Without this the sparks read as a handful of
    // loose dots; with it they read as one bright object at a glance, which is
    // the whole point of the tier colour.
    p.tile = PTile.Glow;
    p.mode = PMode.Billboard;
    p.stretch = 0;
    p.life = 0.22;
    p.size0 = 0.52 + 0.10 * tier; p.size1 = 0.12;
    p.count = n;
    p.velJitter = 1.2;
    // Alpha held down: this halo stacks two per spark at 60+ spawns a second,
    // and at 0.8 a stationary-ish contact patch accumulated into a solid white
    // blob that swallowed the tier hue it exists to carry.
    this.particles.colorA(col, 1.15, 0.62);
    this.particles.colorB(col, 0.35, 0);
    this.particles.emit(true);

    // A steady lamp at the contact patch itself: the tier colour has to be
    // legible even in the frames between spark spawns.
    p.tile = PTile.Glow;
    p.life = 0.10; p.lifeJitter = 0.1;
    p.size0 = 0.85 + 0.18 * tier; p.size1 = 0.55;
    p.gravity = 0; p.drag = 6; p.velJitter = 0; p.posJitter = 0.04;
    p.count = 1; p.fadeIn = 0.2;
    this.particles.vel(0, 0.4, 0);
    this.particles.colorA(col, 0.75, 0.6);
    this.particles.colorB(col, 0.35, 0);
    this.particles.emit(true);
  }

  /**
   * The coloured pool the sparks throw onto the road. Ground-aligned additive
   * quads under each rear contact patch: no silhouette, cannot intersect the
   * kart, and it works identically whether or not the light budget could take a
   * real PointLight. Art bible §6 calls for a ground-scorch decal under drift
   * sparks; the decal layer is multiplicative so it can only darken, which is
   * why the *bright* half of that note has to be a particle.
   */
  private groundPool(k: IKart, fx: KartFx, col: THREE.Color, tier: number) {
    const p = this.particles.reset();
    p.tile = PTile.Glow; p.mode = PMode.Ground;
    p.life = 0.30; p.lifeJitter = 0.25;
    p.size0 = 1.0 + 0.18 * tier; p.size1 = 2.2 + 0.4 * tier; p.sizeJitter = 0.25;
    p.drag = 1.4; p.gravity = 0; p.spin = 0.9;
    p.posJitter = 0.12; p.count = 1; p.softness = 0; p.fadeIn = 0.12;
    // Inherits the kart's velocity so the pool tracks the car instead of being
    // left behind as a stationary blob of light on empty tarmac.
    this.particles.vel(k.velocity.x * 0.75, 0, k.velocity.z * 0.75);
    this.particles.colorA(col, 0.55 + 0.16 * tier, 0.60);
    this.particles.colorB(col, 0.14, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, fx.groundY + 0.04, at.z);
      this.particles.emit(true);
    }
  }

  /**
   * Thin tyre-contact veil under a kart that is simply travelling fast. Every
   * other emitter in this file needs the kart to be drifting, boosting, stunned
   * or off-road, so a clean fast lap emitted nothing and the frame had no sense
   * of speed outside the HUD number.
   */
  private rollDust(k: IKart, fx: KartFx, n: number, dust: THREE.Color, sr: number) {
    const road = fx.surface === Surface.Road || fx.surface === Surface.Boost;
    _col.copy(road ? C_SMOKE : dust).lerp(this.sunColor, 0.35);
    _fwd.copy(k.forward);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 0.55; p.lifeJitter = 0.4;
    p.size0 = 0.16; p.size1 = 0.95 + 0.5 * sr; p.sizeJitter = 0.45;
    p.gravity = 0.7; p.drag = 2.6; p.spin = 1.3;
    p.posJitter = 0.14; p.velJitter = 0.9; p.fadeIn = 0.14;
    p.groundY = fx.groundY; p.softness = 0.9; p.count = n;
    // Deliberately faint: this is a veil that says "moving", not a smoke screen.
    this.particles.colorA(_col, 1.0, 0.11 + 0.16 * sr);
    this.particles.colorB(_col, 0.8, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.10, at.z);
      this.particles.vel(-_fwd.x * 1.6, 0.7, -_fwd.z * 1.6);
      this.particles.emit(false);
    }
  }

  private burstSparks(at: THREE.Vector3, col: THREE.Color, n: number, intensity: number) {
    const p = this.particles.reset();
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 2.0;
    p.life = 0.42; p.lifeJitter = 0.4;
    p.size0 = 0.2; p.size1 = 0.02; p.sizeJitter = 0.45;
    p.gravity = -13; p.drag = 1.1;
    p.posJitter = 0.12; p.velJitter = 6.5; p.fadeIn = 0.02; p.count = n;
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(0, 3.4, 0);
    this.particles.colorA(col, 3.4 * intensity, 1);
    this.particles.colorB(col, 1.0, 0);
    this.particles.emit(true);
  }

  private tyreSmoke(k: IKart, fx: KartFx, at: THREE.Vector3, n: number, dust: THREE.Color) {
    // Grey smoke on grey road is invisible by construction. Warm the puff
    // toward the key light so it separates from the tarmac by hue as well as
    // by value — that is what "it must catch the sun" in §6 actually buys.
    _col.copy(fx.surface === Surface.Road || fx.surface === Surface.Boost ? C_SMOKE : dust)
      .lerp(this.sunColor, 0.30);
    _col2.copy(_col).lerp(C_SMOKE_DARK, 0.5);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 1.25; p.lifeJitter = 0.35;
    // Wide per-particle scale and rotation spread: a cloud of identically sized
    // puffs turning at the same rate has no internal structure and reads as one
    // flat decal, which is exactly how the drift smoke was landing.
    p.size0 = 0.62; p.size1 = 2.9; p.sizeJitter = 0.55;
    p.gravity = 1.1; p.drag = 1.7; p.spin = 1.5;
    p.posJitter = 0.24; p.velJitter = 1.5; p.velScatter = 0.35; p.fadeIn = 0.10;
    // Deeper soft fade so the puff dissolves into the tarmac over a metre
    // instead of terminating on the intersection line.
    p.groundY = fx.groundY; p.softness = 1.15;
    p.count = n;
    _fwd.copy(k.forward);
    // Spawned clear of the ground plane: at 0.08 m the soft-particle fade was
    // eating two thirds of the alpha before it ever reached the frame.
    this.particles.at(at.x, at.y + 0.30, at.z);
    this.particles.vel(-_fwd.x * 2.0, 1.5, -_fwd.z * 2.0);
    this.particles.colorA(_col, 1.0, 0.85);
    this.particles.colorB(_col2, 0.85, 0);
    this.particles.emit(false);
  }

  private tyreSmokePuff(k: IKart, fx: KartFx, n: number, size: number) {
    this.rearPoints(k, fx);
    this.particles.reset();
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      const p = this.particles.p;
      p.tile = PTile.Smoke; p.life = 0.95; p.lifeJitter = 0.35;
      p.size0 = 0.5 * size; p.size1 = 2.2 * size; p.sizeJitter = 0.5;
      p.gravity = 0.8; p.drag = 2.2; p.spin = 1.6;
      p.posJitter = 0.24; p.velJitter = 1.8; p.fadeIn = 0.1;
      p.groundY = fx.groundY; p.softness = 1.1; p.count = n;
      _col.copy(C_SMOKE).lerp(this.sunColor, 0.30);
      this.particles.at(at.x, at.y + 0.28, at.z);
      this.particles.vel(0, 1.7, 0);
      this.particles.colorA(_col, 1.0, 0.8);
      this.particles.colorB(C_SMOKE_DARK, 0.9, 0);
      this.particles.emit(false);
    }
  }

  private groundPuff(k: IKart, fx: KartFx, n: number, size: number) {
    const props = SURFACE_PROPS[fx.surface] ?? SURFACE_PROPS[Surface.Road];
    _col.copy(fx.surface === Surface.Road ? C_SMOKE : props.dustColor);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 0.9; p.lifeJitter = 0.35;
    p.size0 = 0.4 * size; p.size1 = 2.0 * size; p.sizeJitter = 0.35;
    p.gravity = 0.4; p.drag = 2.6; p.spin = 1.1;
    p.posJitter = 0.5; p.velJitter = 2.2; p.velScatter = 0.5; p.fadeIn = 0.08;
    p.groundY = fx.groundY; p.softness = 0.7; p.count = n;
    this.particles.at(k.position.x, fx.groundY + 0.12, k.position.z);
    this.particles.vel(0, 1.0, 0);
    this.particles.colorA(_col, 0.95, 0.45);
    this.particles.colorB(_col, 0.7, 0);
    this.particles.emit(false);

    // A pair of discs pinned flat to the ground: they read as dust spreading
    // out along the tarmac rather than a ball of it hanging in the air.
    p.mode = PMode.Ground;
    p.life = 0.7; p.size0 = 0.9 * size; p.size1 = 3.4 * size;
    p.gravity = 0; p.drag = 3.4; p.velJitter = 0; p.spin = 0.6;
    p.posJitter = 0.25; p.softness = 0;
    p.count = Math.max(1, n >> 2);
    this.particles.at(k.position.x, fx.groundY + 0.05, k.position.z);
    this.particles.vel(0, 0, 0);
    this.particles.colorA(_col, 0.95, 0.32);
    this.particles.colorB(_col, 0.7, 0);
    this.particles.emit(false);
  }

  private surfaceDust(k: IKart, fx: KartFx, n: number, dust: THREE.Color, heavy: boolean) {
    _fwd.copy(k.forward);
    const p = this.particles.reset();
    p.tile = heavy ? PTile.Splash : PTile.Smoke;
    p.life = heavy ? 0.75 : 1.3; p.lifeJitter = 0.3;
    p.size0 = heavy ? 0.22 : 0.4; p.size1 = heavy ? 0.5 : 2.6; p.sizeJitter = 0.4;
    p.gravity = heavy ? -6.5 : 0.5; p.drag = heavy ? 1.4 : 1.7; p.spin = 1.0;
    p.posJitter = 0.22; p.velJitter = heavy ? 2.6 : 1.2; p.fadeIn = 0.1;
    p.groundY = fx.groundY; p.softness = 0.7; p.count = n;
    this.particles.colorA(dust, heavy ? 1.0 : 0.95, heavy ? 0.85 : 0.5);
    this.particles.colorB(dust, 0.75, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, at.y + 0.06, at.z);
      this.particles.vel(-_fwd.x * 2.6, heavy ? 3.2 : 1.1, -_fwd.z * 2.6);
      this.particles.emit(false);
    }
  }

  private waterSpray(k: IKart, fx: KartFx, n: number) {
    _fwd.copy(k.forward);
    const p = this.particles.reset();
    p.tile = PTile.Splash;
    p.life = 0.65; p.lifeJitter = 0.35;
    p.size0 = 0.2; p.size1 = 0.62; p.sizeJitter = 0.4;
    p.gravity = -11; p.drag = 1.0; p.spin = 1.4;
    p.posJitter = 0.22; p.velJitter = 2.6; p.fadeIn = 0.06;
    p.groundY = fx.groundY; p.softness = 0.35; p.count = n;
    this.particles.colorA(C_FOAM, 1.05, 0.9);
    this.particles.colorB(C_WATER, 0.9, 0);
    for (let s = 0; s < 2; s++) {
      const at = s === 0 ? this.skidLRef : this.skidRRef;
      this.particles.at(at.x, fx.groundY + 0.06, at.z);
      this.particles.vel(-_fwd.x * 3.2, 4.2, -_fwd.z * 3.2);
      this.particles.emit(false);
    }
    // a few additive highlights so the spray catches the low sun
    p.tile = PTile.Glow;
    p.life = 0.4; p.size0 = 0.14; p.size1 = 0.03;
    p.count = Math.max(1, n >> 1);
    this.particles.colorA(C_FOAM, 1.8, 0.8);
    this.particles.colorB(C_WATER, 0.6, 0);
    this.particles.at(this.skidLRef.x, fx.groundY + 0.1, this.skidLRef.z);
    this.particles.emit(true);
  }

  /**
   * Exhaust plume.
   *
   * The three things that make this hard, and what each one costs if you get it
   * wrong:
   *
   *  1. It is emitted *at the chase camera*. Anything fired straight down -fwd
   *     from a kart the camera is following flies into the near plane, so the
   *     sprite's projected size runs away and two particles cover the frame.
   *     Fixed on both ends: the emit velocity is biased up and outward so the
   *     plume arcs clear of the lens, and Particles clamps projected size and
   *     fades anything inside a metre of the eye.
   *  2. Velocity antiparallel to the view axis has no screen-space direction,
   *     so PMode.Stretch has nothing to orient against. Particles now blends
   *     back to a billboard before the axis degenerates — without that, the
   *     tapered flame tile snaps to an arbitrary angle and reads as a shard.
   *  3. Additive brightness. Colour * 2.3 clips to flat cream long before the
   *     sprite's alpha has fallen off, which converts a soft gradient into a
   *     hard-edged cutout. The core stays hot but the body is driven well down
   *     the tone curve so the falloff is actually visible as falloff.
   */
  private boostPlume(k: IKart, n: number) {
    const fx = this.state(k);
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    const tier = k.driftTier > 0 ? k.driftTier : 1;
    _col.copy(C_TIER[Math.min(3, tier)]);
    // Length is modulated by how much boost is left, so the plume flares on
    // ignition and shortens as the boost runs out instead of switching off.
    const burn = THREE.MathUtils.clamp(k.boostTime / 0.9, 0.35, 1);

    // THE reason the boost frame had no flame in it.
    //
    // Particles are simulated in WORLD space. A plume emitted with a purely
    // local velocity is, in world terms, *stationary* — so a kart doing 33 m/s
    // leaves each puff exactly where it was born and by the end of a 0.24 s life
    // the "plume" is smeared eight metres down the road behind the car. What
    // reaches the frame is a scatter of unrelated bright specks along the tarmac,
    // which is precisely what the review called "no flame plume, just sparks".
    //
    // Inheriting most of the kart's velocity and letting drag bleed it off is
    // what turns that back into a tongue: the flame holds station at the stacks
    // for the first few hundredths of a second and then falls back over roughly
    // 1.5 m. `keep` is per-layer, so the hot root stays welded to the exhaust and
    // the cooling embers stream further back — which is the shape of a real
    // afterburner and the thing that makes the plume read as attached.
    const vx = k.velocity.x, vy = k.velocity.y, vz = k.velocity.z;

    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? -0.34 : 0.34;
      _p.copy(k.position)
        .addScaledVector(_fwd, -0.85)
        .addScaledVector(_side, sx);
      _p.y += 0.58;

      const p = this.particles.reset();
      p.tile = PTile.Flame; p.mode = PMode.Stretch; p.stretch = 1.6;
      p.life = 0.16 + 0.08 * burn; p.lifeJitter = 0.25;
      p.size0 = 0.30 + 0.22 * burn; p.size1 = 0.10; p.sizeJitter = 0.28;
      p.gravity = 2.6; p.drag = 3.0;
      p.posJitter = 0.05; p.velJitter = 0.9; p.velScatter = 0.18;
      p.fadeIn = 0.06; p.count = n;
      p.groundY = fx.groundY; p.softness = 0.6;
      this.particles.at(_p.x, _p.y, _p.z);
      this.particles.vel(
        vx * 0.94 - _fwd.x * 3.0 + _side.x * sx * 2.4,
        vy * 0.94 + 1.8,
        vz * 0.94 - _fwd.z * 3.0 + _side.z * sx * 2.4);
      // Blue-white at the root grading to orange at the tip, per §6. The old
      // ramp went cream -> deep red, which through ACES is a brown smear: it
      // had no hue anywhere near the flame temperature it was meant to imply,
      // and the tail landed *below* the bloom threshold so nothing glowed.
      this.particles.colorA(C_FLAME_ROOT, 2.2, 0.95);
      this.particles.colorB(C_FLAME_MID, 0.85, 0);
      this.particles.emit(true);

      // Bright core at the stack mouth: small, hot, pinned hardest to the kart
      // and NOT stretched, so the plume has an unambiguous point of origin
      // instead of floating loose. Authored above the bloom threshold on
      // purpose — this is the part that must clip to white and bleed.
      p.tile = PTile.Glow; p.mode = PMode.Billboard; p.stretch = 0;
      p.life = 0.11; p.size0 = 0.20 + 0.10 * burn; p.size1 = 0.05;
      p.count = Math.max(1, n >> 1); p.velJitter = 0.4; p.drag = 5;
      this.particles.vel(vx, vy + 0.6, vz);
      this.particles.colorA(C_FLAME_ROOT, 3.0, 1);
      this.particles.colorB(C_FLAME_MID, 1.0, 0);
      this.particles.emit(true);

      // Wide, dim tier-coloured halo. This is what carries the mini-turbo
      // colour at a glance; the flame body is too hot to hold a hue.
      p.tile = PTile.Glow; p.life = 0.20;
      p.size0 = 0.50; p.size1 = 0.80 * burn + 0.35; p.sizeJitter = 0.3;
      p.count = Math.max(1, n >> 1); p.drag = 4;
      this.particles.vel(vx * 0.92 - _fwd.x * 2.0, vy * 0.92 + 1.2, vz * 0.92 - _fwd.z * 2.0);
      this.particles.colorA(_col, 0.85, 0.5);
      this.particles.colorB(_col, 0.20, 0);
      this.particles.emit(true);

      // Erosion at the tail: a sparse scatter of cooling embers, held back
      // harder so the plume dissipates into the slipstream rather than ending
      // on a clean edge. Streak, not Core — the core tile's cross flare reads
      // as a decorative sparkle at this size.
      p.tile = PTile.Streak; p.mode = PMode.Stretch; p.stretch = 3.0;
      p.life = 0.24; p.lifeJitter = 0.5;
      p.size0 = 0.06; p.size1 = 0.015; p.sizeJitter = 0.5;
      p.gravity = -3.0; p.drag = 1.6; p.velJitter = 2.0; p.velScatter = 0.4;
      p.count = Math.max(1, n >> 1);
      this.particles.vel(
        vx * 0.70 - _fwd.x * 2.5 + _side.x * sx * 1.6,
        vy * 0.70 + 1.0,
        vz * 0.70 - _fwd.z * 2.5 + _side.z * sx * 1.6);
      this.particles.colorA(C_FLAME_MID, 2.4, 1);
      this.particles.colorB(C_FLAME_COOL, 0.9, 0);
      this.particles.emit(true);
    }
  }

  /** Baseline running-engine wisp off the exhaust stacks. */
  private idleExhaust(k: IKart, fx: KartFx, n: number) {
    _fwd.copy(k.forward);
    _side.crossVectors(UP, _fwd).normalize();
    _col.copy(C_SMOKE_DARK).lerp(this.sunColor, 0.35);
    const p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 0.62; p.lifeJitter = 0.35;
    p.size0 = 0.16; p.size1 = 0.85; p.sizeJitter = 0.35;
    p.gravity = 1.4; p.drag = 3.2; p.spin = 1.2;
    p.posJitter = 0.10; p.velJitter = 0.8; p.fadeIn = 0.10;
    p.groundY = fx.groundY; p.softness = 0.5;
    p.count = n;
    this.particles.colorA(_col, 1.0, 0.30);
    this.particles.colorB(_col, 0.85, 0);
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? -0.34 : 0.34;
      _p.copy(k.position).addScaledVector(_fwd, -0.85).addScaledVector(_side, sx);
      _p.y += 0.58;
      this.particles.at(_p.x, _p.y, _p.z);
      // Partial velocity inheritance: exhaust should trail, but a world-static
      // wisp on a kart at 25 m/s strings itself over fifteen metres of road and
      // stops reading as coming out of the stacks at all.
      this.particles.vel(
        k.velocity.x * 0.72 - _fwd.x * 1.6, k.velocity.y * 0.72 + 1.1, k.velocity.z * 0.72 - _fwd.z * 1.6);
      this.particles.emit(false);
    }
  }

  private starSparkle(k: IKart, n: number, now: number) {
    const p = this.particles.reset();
    p.tile = PTile.Star; p.mode = PMode.Billboard;
    p.life = 0.6; p.lifeJitter = 0.35;
    p.size0 = 0.34; p.size1 = 0.05; p.sizeJitter = 0.4;
    p.gravity = -1.5; p.drag = 2.2; p.spin = 3.0;
    p.posJitter = 0.7; p.velJitter = 1.6; p.fadeIn = 0.05; p.count = n;
    // hue cycles with the shell so the trail and the husk agree
    const h = (now * 0.55) % 1;
    _col.setHSL(h, 0.85, 0.62);
    this.particles.at(k.position.x, k.position.y + 0.45, k.position.z);
    this.particles.vel(0, 0.6, 0);
    this.particles.colorA(_col, 2.2, 1);
    this.particles.colorB(C_HOT, 0.8, 0);
    this.particles.emit(true);
  }

  private stunStars(k: IKart, fx: KartFx, n: number) {
    // Re-emitted on a rotating ring above the helmet: the particles themselves
    // barely move, the emission point orbits, which reads as classic orbiting
    // stars without needing per-frame simulation.
    const p = this.particles.reset();
    p.tile = PTile.Star;
    p.life = 0.34; p.lifeJitter = 0.15;
    p.size0 = 0.30; p.size1 = 0.24; p.sizeJitter = 0.15;
    p.gravity = 0; p.drag = 5; p.spin = 2.2; p.fadeIn = 0.25; p.count = 1;
    this.particles.colorA(C_GOLD, 2.4, 1);
    this.particles.colorB(C_GOLD, 1.2, 0);
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 4; s++) {
        const a = fx.stunPhase + (s / 4) * Math.PI * 2;
        this.particles.at(
          k.position.x + Math.cos(a) * 0.72,
          k.position.y + 1.05 + Math.sin(a * 2) * 0.06,
          k.position.z + Math.sin(a) * 0.72);
        this.particles.emit(true);
      }
    }
  }

  private sparkleBurst(at: THREE.Vector3, col: THREE.Color, n: number) {
    const p = this.particles.reset();
    p.tile = PTile.Star; p.mode = PMode.Billboard;
    p.life = 0.7; p.lifeJitter = 0.3;
    p.size0 = 0.34; p.size1 = 0.04; p.sizeJitter = 0.4;
    p.gravity = -2.5; p.drag = 2.4; p.spin = 3.5;
    p.posJitter = 0.3; p.velJitter = 3.4; p.fadeIn = 0.04; p.count = n;
    this.particles.at(at.x, at.y + 0.6, at.z);
    this.particles.vel(0, 2.2, 0);
    this.particles.colorA(col, 2.4, 1);
    this.particles.colorB(C_HOT, 0.9, 0);
    this.particles.emit(true);
  }

  private confetti(at: THREE.Vector3) {
    for (let i = 0; i < CONFETTI.length; i++) {
      const p = this.particles.reset();
      p.tile = PTile.Streak; p.mode = PMode.Billboard;
      p.life = 2.6; p.lifeJitter = 0.35;
      p.size0 = 0.16; p.size1 = 0.16; p.sizeJitter = 0.4;
      p.gravity = -4.2; p.drag = 1.5; p.spin = 6;
      p.posJitter = 0.9; p.velJitter = 5.5; p.fadeIn = 0.03; p.count = 14;
      p.softness = 0;
      this.particles.at(at.x, at.y + 2.4, at.z);
      this.particles.vel(0, 5.5, 0);
      this.particles.colorA(CONFETTI[i], 1.0, 1);
      this.particles.colorB(CONFETTI[i], 0.9, 0.9);
      this.particles.emit(false);
    }
  }

  private impactBurst(at: THREE.Vector3, n: THREE.Vector3, now: number, scale: number) {
    const p = this.particles.reset();
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 1.6;
    p.life = 0.4; p.lifeJitter = 0.4;
    p.size0 = 0.22 * scale; p.size1 = 0.02;
    p.gravity = -12; p.drag = 1.3; p.velJitter = 8 * scale;
    p.posJitter = 0.2; p.fadeIn = 0.02; p.count = Math.round(24 * scale);
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(0, 3, 0);
    this.particles.colorA(C_SPARK_WHITE, 3.0, 1);
    this.particles.colorB(C_FLAME_MID, 0.9, 0);
    this.particles.emit(true);

    p.tile = PTile.Smoke; p.mode = PMode.Billboard; p.stretch = 0;
    p.life = 0.8; p.size0 = 0.4 * scale; p.size1 = 1.8 * scale;
    p.gravity = 1.2; p.drag = 3.2; p.spin = 1.4; p.velJitter = 2.2;
    p.count = Math.round(10 * scale); p.softness = 0.6; p.groundY = at.y - 1.2;
    this.particles.colorA(C_SMOKE, 0.9, 0.5);
    this.particles.colorB(C_SMOKE_DARK, 0.8, 0);
    this.particles.emit(false);

    this.rings.spawn(at, n, 0.25, 2.2 * scale, 0.30, 0.30, C_HOT, 1.8 * scale, now);
    this.blastLoad = Math.max(this.blastLoad, 0.7 * scale);
  }

  private explode(at: THREE.Vector3, n: THREE.Vector3, groundY: number, scale: number, now: number) {
    // fireball
    let p = this.particles.reset();
    p.tile = PTile.Flame; p.mode = PMode.Billboard;
    p.life = 0.42; p.lifeJitter = 0.35;
    p.size0 = 1.1 * scale; p.size1 = 3.0 * scale; p.sizeJitter = 0.35;
    p.gravity = 5.5; p.drag = 4.0; p.spin = 1.8;
    p.posJitter = 0.55 * scale; p.velJitter = 6.5 * scale; p.fadeIn = 0.04;
    p.count = Math.round(20 * scale);
    this.particles.at(at.x, at.y, at.z);
    this.particles.vel(0, 3.5, 0);
    this.particles.colorA(C_HOT, 2.6, 1);
    this.particles.colorB(C_FLAME_COOL, 0.7, 0);
    this.particles.emit(true);

    // sparks
    p.tile = PTile.Core; p.mode = PMode.Stretch; p.stretch = 2.2;
    p.life = 0.8; p.lifeJitter = 0.5;
    p.size0 = 0.24; p.size1 = 0.02;
    p.gravity = -13; p.drag = 0.9; p.velJitter = 14 * scale; p.posJitter = 0.2;
    p.count = Math.round(34 * scale);
    this.particles.vel(0, 5, 0);
    this.particles.colorA(C_SPARK_WHITE, 3.2, 1);
    this.particles.colorB(C_FLAME_MID, 1.0, 0);
    this.particles.emit(true);

    // smoke column
    p = this.particles.reset();
    p.tile = PTile.Smoke; p.mode = PMode.Billboard;
    p.life = 2.1; p.lifeJitter = 0.35;
    p.size0 = 0.9 * scale; p.size1 = 5.0 * scale; p.sizeJitter = 0.35;
    p.gravity = 1.6; p.drag = 1.5; p.spin = 0.7;
    p.posJitter = 0.7 * scale; p.velJitter = 3.2; p.fadeIn = 0.08;
    p.groundY = groundY; p.softness = 0.9;
    p.count = Math.round(22 * scale);
    this.particles.at(at.x, at.y + 0.2, at.z);
    this.particles.vel(0, 2.6, 0);
    this.particles.colorA(C_SMOKE_DARK, 0.9, 0.72);
    this.particles.colorB(C_SMOKE, 0.75, 0);
    this.particles.emit(false);

    // debris
    p.tile = PTile.Streak; p.mode = PMode.Stretch; p.stretch = 1.1;
    p.life = 1.5; p.lifeJitter = 0.4;
    p.size0 = 0.2 * scale; p.size1 = 0.14 * scale; p.sizeJitter = 0.5;
    p.gravity = -16; p.drag = 0.55; p.spin = 8;
    p.velJitter = 9 * scale; p.posJitter = 0.3; p.softness = 0;
    p.count = Math.round(16 * scale);
    this.particles.vel(0, 7, 0);
    this.particles.colorA(C_DEBRIS, 1.0, 1);
    this.particles.colorB(C_DEBRIS, 0.8, 0.6);
    this.particles.emit(false);

    this.rings.spawn(at, n, 0.4, 6.0 * scale, 0.48, 0.18, C_HOT, 2.4, now);
    this.rings.spawn(at, n, 0.25, 3.2 * scale, 0.32, 0.38, C_FLAME_MID, 1.6, now);

    // `at` may alias the shared _p scratch, so land the decal via a different one
    _r.set(at.x, groundY, at.z);
    this.decals.blot(_r, n, 2.6 * scale, DecalTile.Scorch, now, 18, 0.85);

    this.ctx.shake(0.9 * scale, 0.55);
    this.blastLoad = Math.max(this.blastLoad, 1.6 * scale);
  }

  /** Lay one skid segment per rear wheel, with run-in/run-out fading. */
  private layStrip(fx: KartFx, now: number, strength: number) {
    if (!fx.skidding) {
      fx.skidding = true;
      fx.skidStrength = 0;
      fx.skidL.copy(this.skidLRef);
      fx.skidR.copy(this.skidRRef);
      return;
    }
    const prevS = fx.skidStrength;
    fx.skidStrength = Math.min(1, fx.skidStrength + 0.34);
    // 0.55 m segments. The chord error against a drift radius of 15 m is under
    // 3 mm, and it halves how fast a pack fight can churn through the ring.
    if (fx.skidL.distanceToSquared(this.skidLRef) < 0.3) return;
    const life = 13;
    // Wider and considerably darker than they were. At 0.30 m and a 0.30 grey
    // multiplier the mark was a faint smudge that vanished into a tarmac
    // already at #4a4a52 — reviewers looking at a mid-drift hero frame read the
    // road as perfectly clean. Hot rubber on tarmac is nearly black.
    const w = 0.36;
    const a0 = prevS * strength, a1 = fx.skidStrength * strength;
    this.decals.skid(fx.skidL, this.skidLRef, fx.groundN, w, a0, a1, now, life,
      0.17, 0.16, 0.19);
    this.decals.skid(fx.skidR, this.skidRRef, fx.groundN, w, a0, a1, now, life,
      0.17, 0.16, 0.19);
    fx.skidL.copy(this.skidLRef);
    fx.skidR.copy(this.skidRRef);
  }

  // --- squash & stretch ----------------------------------------------------

  private addSquash(k: IKart, impulse: number) {
    const fx = this.state(k);
    fx.squashV += impulse * 26;
  }

  /**
   * Damped spring on a single scalar: negative squashes (flat and wide),
   * positive stretches. We only ever touch `object.scale`, we restore it to
   * exactly identity when the pulse dies, and we never take it over unless we
   * put it there — so a kart-model animator writing scale wins by default.
   */
  private applySquash(k: IKart, fx: KartFx, dt: number) {
    if (Math.abs(fx.squash) < 1e-4 && Math.abs(fx.squashV) < 1e-3) {
      if (fx.squashOwned) {
        k.object.scale.set(1, 1, 1);
        fx.squashOwned = false;
        fx.squash = 0; fx.squashV = 0;
      }
      return;
    }
    const s = k.object.scale;
    if (!fx.squashOwned) {
      if (Math.abs(s.x - 1) > 0.02 || Math.abs(s.y - 1) > 0.02) { fx.squashV = 0; return; }
      fx.squashOwned = true;
    }
    // stiffness/damping tuned for ~3 visible bounces over ~0.45 s
    fx.squashV += (-fx.squash * 420 - fx.squashV * 17) * dt;
    fx.squash += fx.squashV * dt;
    fx.squash = THREE.MathUtils.clamp(fx.squash, -0.45, 0.45);
    const q = fx.squash;
    s.set(1 - q * 0.55, 1 + q, 1 - q * 0.55);
  }

  // --- ambient -------------------------------------------------------------

  private updateAmbient(ctx: Ctx, dt: number, now: number) {
    const cam = ctx.camera.position;

    if (this.motes) this.motes.update(now, cam, ctx.sunDirection, this.gain);
    if (this.gulls) {
      _col.copy(this.sunColor).multiplyScalar(0.85).add(_col2.copy(this.skyColor).multiplyScalar(0.35));
      this.gulls.update(now, _col);
    }

    // sea spray at the cliff base
    if (this.sprays.length) {
      this.sprayAcc += dt;
      if (this.sprayAcc > 0.22) {
        this.sprayAcc = 0;
        const site = this.sprays[(Math.random() * this.sprays.length) | 0];
        if (cam.distanceToSquared(site) < 200 * 200) {
          const p = this.particles.reset();
          p.tile = PTile.Splash; p.mode = PMode.Billboard;
          p.life = 2.0; p.lifeJitter = 0.3;
          p.size0 = 1.4; p.size1 = 5.5; p.sizeJitter = 0.35;
          p.gravity = -1.6; p.drag = 1.1; p.spin = 0.5;
          p.posJitter = 3.5; p.velJitter = 2.5; p.fadeIn = 0.14;
          p.groundY = 0; p.softness = 1.2; p.count = 5;
          this.particles.at(site.x, site.y, site.z);
          this.particles.vel(0, 6.5, 0);
          this.particles.colorA(C_FOAM, 1.0, 0.55);
          this.particles.colorB(C_WATER, 0.85, 0);
          this.particles.emit(false);
        }
      }
    }

    // heat shimmer over the tarmac ahead
    if (this.shimmer) {
      ctx.camera.getWorldDirection(_q);
      this.shimmerTimer -= dt;
      const player = ctx.race?.player;
      if (this.shimmerTimer <= 0 && player) {
        // The ground probe is the only per-frame cost here, so it runs at 5 Hz
        // and the band eases between placements.
        this.shimmerTimer = 0.2;
        _fwd.copy(_q);
        _fwd.y = 0;
        if (_fwd.lengthSq() > 1e-4) {
          _fwd.normalize();
          _p.copy(cam).addScaledVector(_fwd, 46);
          const probe = ctx.track.probe(_p, player.t);
          const onTarmac = probe.surface === Surface.Road || probe.surface === Surface.Boost;
          this.shimmerPos.set(_p.x, probe.y + 1.6, _p.z);
          this.shimmerAmount += ((onTarmac ? 0.085 : 0) - this.shimmerAmount) * 0.35;
        }
      }
      this.shimmer.place(this.shimmerPos, _q, this.shimmerAmount, now, this.gain);
    }
  }

  dispose() {
    this.unsubscribe?.();
    this.particles?.dispose();
    this.trails?.dispose();
    this.decals?.dispose();
    this.rings?.dispose();
    this.motes?.dispose();
    this.gulls?.dispose();
    this.shimmer?.dispose();
    this.shells?.dispose();
    this.lights?.dispose();
    this.group.removeFromParent();
  }
}
