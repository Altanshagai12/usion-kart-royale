/**
 * ============================================================================
 *  Water — the bay.
 * ============================================================================
 *  A camera-centred radial grid (dense underfoot, coarse at the horizon) with
 *  world-space analytic displacement, so the surface never swims when the
 *  camera moves and there is no texture tiling to catch.
 *
 *  Shading:
 *    - four scrolling wave octaves in the vertex shader for silhouette,
 *      four more evaluated per-pixel for the normal detail;
 *    - Fresnel-weighted reflection of the sky (analytic Rayleigh/Mie-ish dome
 *      matching ART_DIRECTION §2, blended with ctx.envMap when the sky system
 *      hands us one in a mapping we can sample directly);
 *    - depth ramp #3fc9c4 -> #0d5a7a driven by a baked shore-proximity field;
 *    - a sun specular lobe that deliberately clips far above 1.0 so the
 *      glitter path across the bay blows out through bloom;
 *    - foam where the sea meets the shore and the cliff feet, plus crest foam.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';
import type { Shared } from './Props';

export interface SeaField {
  /** world-space min corner (x,z) of the baked field */
  origin: THREE.Vector2;
  /** world-space extent of the field, metres (square) */
  size: number;
  /** resolution per axis */
  res: number;
  /** RGBA8: R = depth 0..1, G = shore foam, B = cliff-foot foam, A = 255 */
  data: Uint8Array;
}

const _v2 = new THREE.Vector3();

export class Water {
  readonly group = new THREE.Group();
  private mesh!: THREE.Mesh;
  private mat!: THREE.ShaderMaterial;
  private fieldTex!: THREE.DataTexture;
  private level = 0;
  private envTried = false;

  constructor(private u: Shared) {
    this.group.name = 'sea';
  }

  build(ctx: Ctx, level: number, field: SeaField, radius = 2600) {
    this.level = level;
    this.u.uSeaLevel.value = level;

    this.fieldTex = new THREE.DataTexture(field.data, field.res, field.res, THREE.RGBAFormat);
    this.fieldTex.wrapS = this.fieldTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fieldTex.minFilter = this.fieldTex.magFilter = THREE.LinearFilter;
    this.fieldTex.needsUpdate = true;

    const geo = this.discGeometry(radius, ctx.settings.quality >= 2 ? 168 : 112, ctx.settings.quality >= 2 ? 104 : 68);

    const uniforms: any = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    uniforms.uTime = this.u.uTime;
    uniforms.uCam = this.u.uCam;
    uniforms.uSunDir = { value: new THREE.Vector3(-0.62, 0.245, -0.745).normalize() };
    uniforms.uSunCol = { value: new THREE.Color(0xffd9a8).multiplyScalar(1.6) };
    uniforms.uLevel = { value: level };
    uniforms.uField = { value: this.fieldTex };
    uniforms.uFieldOrigin = { value: field.origin.clone() };
    uniforms.uFieldSize = { value: field.size };
    uniforms.uEnv = { value: null };
    uniforms.uEnvIntensity = { value: 0 };
    uniforms.uChop = { value: ctx.settings.quality >= 1 ? 1 : 0.6 };

    this.mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      side: THREE.FrontSide,
      defines: { ENV_NONE: '' },
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'sea-surface';
    // The grid is re-centred on the camera every frame; culling it is wrong.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.matrixAutoUpdate = true;
    this.group.add(this.mesh);
  }

  /**
   * Radial grid: ring radii follow a cubic so the first rings are ~0.3 m apart
   * (crisp displacement at the shoreline you are driving past) while the last
   * reach the horizon. 168 x 104 ≈ 35 k triangles for the entire ocean.
   */
  private discGeometry(radius: number, segs: number, rings: number): THREE.BufferGeometry {
    const pos = new Float32Array((rings + 1) * (segs + 1) * 3);
    const idx: number[] = [];
    let p = 0;
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const r = radius * t * t * t;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pos[p++] = Math.cos(a) * r;
        pos[p++] = 0;
        pos[p++] = Math.sin(a) * r;
      }
    }
    const stride = segs + 1;
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < segs; i++) {
        // Wound counter-clockwise seen from ABOVE — the sea is single-sided and
        // the camera is always above it.
        const a = j * stride + i;
        idx.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.2);
    return g;
  }

  update(ctx: Ctx) {
    // Keep the dense centre of the grid under the camera. Waves are a function
    // of absolute world position, so nothing shifts as this moves.
    this.mesh.position.set(ctx.camera.position.x, this.level, ctx.camera.position.z);
    const su = this.mat.uniforms.uSunDir.value as THREE.Vector3;
    su.copy(ctx.sunDirection);
    if (ctx.sun) {
      _v2.set(ctx.sun.color.r, ctx.sun.color.g, ctx.sun.color.b);
      (this.mat.uniforms.uSunCol.value as THREE.Color).setRGB(_v2.x, _v2.y, _v2.z).multiplyScalar(1.35 + Math.min(ctx.sun.intensity, 6) * 0.12);
    }
    if (!this.envTried && ctx.envMap) this.adoptEnv(ctx.envMap);
  }

  /**
   * The sky system may hand us a PMREM (CubeUV) map, which a raw ShaderMaterial
   * cannot sample without dragging in three's whole cube-uv chunk set. Cube and
   * equirect maps we take; anything else falls back to the analytic dome, which
   * is authored to the same palette so the two agree.
   */
  private adoptEnv(env: THREE.Texture) {
    this.envTried = true;
    const m = env.mapping;
    if (m === THREE.CubeReflectionMapping || m === THREE.CubeRefractionMapping) {
      this.mat.defines = { ENV_CUBE: '' };
    } else if (m === THREE.EquirectangularReflectionMapping || m === THREE.EquirectangularRefractionMapping) {
      this.mat.defines = { ENV_EQUI: '' };
    } else return;
    this.mat.uniforms.uEnv.value = env;
    this.mat.uniforms.uEnvIntensity.value = 1;
    this.mat.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.fieldTex.dispose();
  }
}

// ---------------------------------------------------------------------------

const WAVES = /* glsl */ `
// Four directional octaves. Returns height in .x and d/dx, d/dz in .yz so the
// normal is analytic — no normal map, therefore no tiling to spot.
vec3 waveSet(vec2 p, float t, float atten, float chop) {
  vec3 acc = vec3(0.0);
  // (dirx, dirz, wavelength, amplitude)
  const vec4 W0 = vec4( 0.86,  0.51, 46.0, 0.46);
  const vec4 W1 = vec4(-0.42,  0.91, 21.0, 0.24);
  const vec4 W2 = vec4( 0.97, -0.24,  9.4, 0.105);
  const vec4 W3 = vec4( 0.24,  0.97,  4.3, 0.042);
  vec4 ws[4];
  ws[0] = W0; ws[1] = W1; ws[2] = W2; ws[3] = W3;
  for (int i = 0; i < 4; i++) {
    vec4 w = ws[i];
    float k = 6.28318 / w.z;
    float sp = sqrt(9.81 / k);            // deep-water dispersion: long swell moves fast
    float ph = dot(w.xy, p) * k + t * sp * 0.55;
    float a = w.w * atten * (i > 1 ? chop : 1.0);
    // sharpened crests / flattened troughs, Gerstner-ish without the xz shear
    float s = sin(ph);
    float sh = s * (0.78 + 0.22 * s);
    float dsh = cos(ph) * (0.78 + 0.44 * s);
    acc.x += a * sh;
    acc.yz += a * k * dsh * w.xy;
  }
  return acc;
}
`;

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform float uLevel;
uniform float uChop;
uniform sampler2D uField;
uniform vec2 uFieldOrigin;
uniform float uFieldSize;
varying vec3 vWorld;
varying vec3 vWaveD;      // (height, ddx, ddz) of the coarse set
varying vec3 vShore;      // (depth01, shoreFoam, cliffFoam)
#ifdef USE_FOG
  varying float vFogDepth;
#endif
${WAVES}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 fuv = (wp.xz - uFieldOrigin) / uFieldSize;
  vec3 shore = texture2D(uField, clamp(fuv, 0.002, 0.998)).rgb;
  // Waves flatten as the bottom comes up — shoaling, and it keeps the shoreline
  // from tearing through the beach geometry.
  float atten = mix(0.32, 1.0, shore.r);
  // Fade displacement out toward the horizon so the far rings stay flat and
  // the silhouette of the sea meets the sky cleanly.
  float dist = length(wp.xz - uCam.xz);
  atten *= 1.0 - smoothstep(260.0, 900.0, dist);
  vec3 w = waveSet(wp.xz, uTime, atten, uChop);
  // Displacement fades toward the horizon so the far rings meet the sky
  // cleanly — but the SLOPE must not, or the distant bay becomes a mirror with
  // no sun track on it at all. Height and slope are attenuated separately.
  float horizonFade = 1.0 - smoothstep(320.0, 1100.0, dist);
  wp.y = uLevel + w.x * horizonFade;
  vWorld = wp.xyz;
  vWaveD = vec3(w.x * horizonFade, w.yz);
  vShore = shore;
  vec4 mvPosition = viewMatrix * wp;
  #ifdef USE_FOG
    vFogDepth = -mvPosition.z;
  #endif
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uChop;
uniform float uEnvIntensity;
#ifdef ENV_CUBE
  uniform samplerCube uEnv;
#endif
#ifdef ENV_EQUI
  uniform sampler2D uEnv;
#endif
varying vec3 vWorld;
varying vec3 vWaveD;
varying vec3 vShore;
#include <common>
#include <fog_pars_fragment>
${WAVES}

// ART_DIRECTION §2/§3, in linear space.
const vec3 ZENITH  = vec3(0.0508, 0.1746, 0.5457);   // #3f74c4
const vec3 HORIZON = vec3(1.0000, 0.6308, 0.3515);   // #ffd0a0
const vec3 SHALLOW = vec3(0.0508, 0.5841, 0.5457);   // #3fc9c4
const vec3 DEEP    = vec3(0.0040, 0.1022, 0.1946);   // #0d5a7a
const vec3 FOAM    = vec3(0.8549, 0.9559, 1.0000);   // #eefaff

vec3 skyDome(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(HORIZON, ZENITH, pow(up, 0.42));
  // below the horizon the reflection ray sees haze over distant water
  c = mix(vec3(0.085, 0.115, 0.135), c, smoothstep(-0.10, 0.015, d.y));
  float mu = max(dot(d, uSunDir), 0.0);
  c += uSunCol * pow(mu, 8.0) * 0.35;        // Mie forward lobe
  c += uSunCol * pow(mu, 90.0) * 1.8;        // tight halo
  c += uSunCol * pow(mu, 1600.0) * 13.0;     // the disc: this is the glitter
  return c;
}

vec3 envSample(vec3 d) {
  #ifdef ENV_CUBE
    return mix(skyDome(d), textureCube(uEnv, d).rgb, uEnvIntensity * 0.75) ;
  #elif defined(ENV_EQUI)
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    return mix(skyDome(d), texture2D(uEnv, uv).rgb, uEnvIntensity * 0.75);
  #else
    return skyDome(d);
  #endif
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 V = normalize(uCam - vWorld);
  float viewDist = distance(uCam, vWorld);

  // Coarse normal from the vertex-stage derivatives, plus a second, finer set
  // evaluated per pixel and faded out with distance to kill shimmer.
  float detailFade = 1.0 - smoothstep(60.0, 420.0, viewDist);
  vec3 fine = waveSet(vWorld.xz * 3.7 + vec2(11.3, -4.1), uTime * 1.9, 0.085 * detailFade * mix(0.35, 1.0, vShore.r), uChop);
  vec3 micro = waveSet(vWorld.xz * 11.0 + vec2(-30.0, 7.0), uTime * 3.1, 0.018 * detailFade, uChop);
  vec2 slope = vWaveD.yz + fine.yz + micro.yz;
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  // Flatten toward the horizon — per-pixel wavelets alias badly at grazing
  // angles. flatten01 is how much slope variance was thrown away doing that;
  // the specular lobe below widens by exactly that amount, so the energy comes
  // back as a broad glitter path instead of vanishing.
  float flatten01 = smoothstep(90.0, 1100.0, viewDist);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), flatten01));

  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.008);                       // never sample under the sea
  vec3 refl = envSample(R);

  // --- body colour: depth ramp plus a warm upwelling on the sun-facing faces
  float depth01 = vShore.r;
  vec3 body = mix(SHALLOW, DEEP, depth01 * depth01);
  float upwell = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  float crest = clamp(vWaveD.x * 1.6 + 0.35, 0.0, 1.0);
  body *= 0.55 + 0.85 * upwell;
  body += SHALLOW * uSunCol * (1.0 - depth01) * 0.22 * crest;   // sun through the shallows

  // --- specular: a tight lobe scaled to a KNOWN peak. A physical GGX D term
  // peaks in the hundreds of thousands at water roughness and would detonate
  // the bloom pass; the sun is not a delta light, so it is clamped by hand.
  vec3 H = normalize(V + uSunDir);
  float ndh = max(dot(N, H), 0.0);
  float ndl = max(dot(N, uSunDir), 0.0);
  // Two lobes. Near water keeps the tight, sharp highlight riding real geometry.
  // Far water gets a wide lobe standing in for the millions of wavelets whose
  // normals were flattened away — that wide lobe IS the sun path across the bay,
  // and without it a golden-hour coastal shot has a dead sea in it.
  float tight = pow(ndh, 1500.0) * ndl * 7.0 * (1.0 - flatten01);
  float broad = pow(ndh, mix(400.0, 34.0, flatten01)) * ndl * mix(1.2, 4.6, flatten01);
  // the path is stretched toward the viewer, so lift it where the reflected
  // ray and the sun share an azimuth even when the elevations disagree
  float track = pow(max(dot(normalize(vec2(reflect(-V, N).xz)), normalize(uSunDir.xz)), 0.0), 26.0);
  broad *= 0.55 + 0.45 * track;
  // sparkle: sparse sub-pixel facets riding the lobe, so the glitter path
  // reads as individual points of light rather than a smooth smear
  float sp = hash21(floor(vWorld.xz * 6.0 + vec2(uTime * 0.6, -uTime * 0.4)));
  float sparkle = pow(ndh, 220.0) * step(0.86, sp) * 8.0 * detailFade;
  // a coarser, slower facet field that survives out to the horizon
  float spF = hash21(floor(vWorld.xz * 0.55 + vec2(uTime * 0.11, -uTime * 0.07)));
  float glint = pow(ndh, mix(240.0, 70.0, flatten01)) * step(0.82, spF) * 3.2 * flatten01;
  vec3 sun = uSunCol * (tight + broad + sparkle + glint);

  // --- foam
  float shoreFoam = vShore.g;
  float cliffFoam = vShore.b;
  // the shoreline band surges with the swell instead of sitting still
  float surge = sin(vWorld.x * 0.22 + vWorld.z * 0.19 - uTime * 1.35) * 0.5 + 0.5;
  float lace = clamp(fine.x * 26.0 + micro.x * 40.0, -1.0, 1.0) * 0.5 + 0.5;
  float foam = shoreFoam * smoothstep(0.15, 0.85, surge * 0.55 + lace * 0.65);
  foam += cliffFoam * (0.45 + 0.55 * abs(sin(vWorld.x * 0.35 + uTime * 1.9))) * lace;
  // whitecaps on the steepest crests
  float steep = length(vWaveD.yz);
  foam += smoothstep(0.16, 0.42, steep) * 0.7 * detailFade;
  foam = clamp(foam, 0.0, 1.0);

  vec3 col = mix(body, refl, fres) + sun;
  col = mix(col, FOAM * (0.70 + 0.55 * upwell), foam * 0.88);
  // foam kills the mirror, and the wet edge stays slightly brighter
  col += FOAM * foam * uSunCol * 0.10;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
