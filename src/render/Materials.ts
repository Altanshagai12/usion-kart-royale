/**
 * ============================================================================
 *  Procedural material library — every surface in Sunset Bay lives here.
 * ============================================================================
 *  Usage from any other system:
 *
 *      import { getMaterials } from '../render/Materials';
 *      const mat = getMaterials().get('cobblestone');
 *
 *  or, if you already hold the instance, `materials.tarmac`.
 *
 *  Contract:
 *   • Materials are built LAZILY on first `get()` and cached forever. Asking
 *     twice returns the *same* object — never mutate a material you did not
 *     build. If you need a recoloured copy, use `variant()` / `livery()`,
 *     which clone the material but share the textures.
 *   • Every material ships albedo + normal + packed ORM (R=AO, G=roughness,
 *     B=metalness), all procedurally generated, all with spatially varying
 *     roughness. Normals are Sobel-derived from a real height field.
 *   • Ground/architecture materials carry a tiling-breakup injection: a second
 *     sample of the variation channel in WORLD space at a non-integer period,
 *     so the modulation is continuous across the whole village and cannot
 *     repeat per instance. Architecture additionally takes a per-instance UV
 *     phase offset and value jitter, keyed off the instance origin — a hundred
 *     houses sharing one texture set must not share one texture *phase*.
 *   • Ground materials carry a distance settle: past ~35 m the fine octave
 *     fades into its own local mean and the normal flattens with it, because a
 *     detail layer that holds full contrast to the horizon is a shimmering
 *     carpet the moment the camera moves.
 *   • `worldScale(name)` reports how many metres one tile of the texture is
 *     meant to cover. Build your UVs as `worldPos / worldScale` and every
 *     surface in the game will agree on texel density.
 * ============================================================================
 */
import * as THREE from 'three';
import { Quality, type Ctx, type System } from '../types';
import {
  brickField,
  clamp,
  clamp01,
  fbmField,
  grainField,
  hash2,
  lerp,
  mulberry32,
  smoothstep,
  voronoiField,
} from './Noise';
import {
  Fields,
  alphaFrom,
  blurField,
  buildMaps,
  createCanvas,
  mixRGB,
  readPixels,
  rgb,
  toImageData,
  type Canvas2D,
  type MapSet,
  type RGB,
} from './Textures';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type MaterialName =
  | 'tarmac'
  | 'tarmac-racing-line'
  | 'cobblestone'
  | 'kerb'
  | 'sand'
  | 'grass'
  | 'dirt'
  | 'cliff-rock'
  | 'tunnel-bore'
  | 'stone-wall'
  | 'stucco'
  | 'roof-tile'
  | 'wood-plank'
  | 'wood-weathered'
  | 'metal-painted'
  | 'chrome'
  | 'rubber'
  | 'glass'
  | 'canvas-awning'
  | 'water-surface'
  | 'concrete'
  | 'marble'
  | 'boost-pad'
  | 'banner-fabric'
  | 'palm-bark'
  | 'foliage-leaf'
  | 'palm-frond'
  | 'crowd'
  | 'tunnel-light'
  | 'neon';

/** Base texture resolution before the quality scale is applied. */
const BASE_SIZE: Record<string, number> = {
  tarmac: 1024,
  'tarmac-racing-line': 1024,
  cobblestone: 1024,
  kerb: 1024,
  sand: 1024,
  grass: 1024,
  dirt: 512,
  'cliff-rock': 1024,
  'tunnel-bore': 1024,
  'stone-wall': 1024,
  stucco: 512,
  'roof-tile': 512,
  'wood-plank': 512,
  'wood-weathered': 512,
  'metal-painted': 512,
  chrome: 256,
  rubber: 512,
  glass: 256,
  'canvas-awning': 512,
  'water-surface': 512,
  concrete: 512,
  marble: 512,
  'boost-pad': 512,
  'banner-fabric': 512,
  'palm-bark': 512,
  'foliage-leaf': 512,
  'palm-frond': 512,
  crowd: 512,
  'tunnel-light': 256,
  neon: 256,
};

/** Metres of world covered by one texture tile. Build UVs as worldPos / this. */
const WORLD_SCALE: Record<string, number> = {
  tarmac: 3.5, // 96 aggregate cells over 3.5 m ≈ 36 mm chippings
  'tarmac-racing-line': 3.5,
  cobblestone: 2.4, // 12 setts across ≈ 200 mm, which is what a sett is
  kerb: 2.0, // 4 bands per tile = 500 mm stripes
  sand: 4,
  grass: 3.2,
  dirt: 3,
  'cliff-rock': 4.0, // 1024 over 4 m ≈ 4 mm/texel, with a 4.3× macro octave for metre-scale form
  'tunnel-bore': 3.2,
  'stone-wall': 3, // 5 × 8 → 600 × 375 mm ashlar blocks
  stucco: 3,
  'roof-tile': 1.1, // 5 pans across ≈ 220 mm barrel tiles
  'wood-plank': 1.2, // 5 boards ≈ 240 mm
  'wood-weathered': 1.2,
  'metal-painted': 1.5,
  chrome: 1,
  rubber: 0.35,
  glass: 1,
  'canvas-awning': 1.8,
  'water-surface': 16,
  concrete: 3,
  marble: 2.5,
  'boost-pad': 6, // one tile = 4 chevrons, sized to the pad itself
  'banner-fabric': 4,
  'palm-bark': 1.0, // 6 × 13 leaf scars ≈ 170 × 77 mm
  'foliage-leaf': 1,
  'palm-frond': 1,
  crowd: 1,
  'tunnel-light': 1,
  neon: 1,
};

const ALIASES: Record<string, MaterialName> = {
  road: 'tarmac',
  asphalt: 'tarmac',
  'racing-line': 'tarmac-racing-line',
  cobble: 'cobblestone',
  'kart-paint': 'metal-painted',
  paint: 'metal-painted',
  metal: 'chrome',
  tyre: 'rubber',
  tire: 'rubber',
  water: 'water-surface',
  rock: 'cliff-rock',
  bore: 'tunnel-bore',
  tunnel: 'tunnel-bore',
  leaf: 'foliage-leaf',
  plaster: 'stucco',
};

/** The village pastels from the art bible, in roof-to-wall order. */
export const STUCCO_TINTS = [0xf2c9a0, 0xe8a5a0, 0xf5e2b0, 0xa9c8d4, 0xdcb8d8, 0xefd9c0, 0xd8c6a8, 0xc9d8cf];

interface Entry {
  mat: THREE.Material;
  textures: THREE.Texture[];
}

// module-scope scratch — generators run once but the loops are hot enough to care
const _a: RGB = { r: 0, g: 0, b: 0 };
const _b: RGB = { r: 0, g: 0, b: 0 };
const _c: RGB = { r: 0, g: 0, b: 0 };

// ---------------------------------------------------------------------------
// Shader injections
// ---------------------------------------------------------------------------

/**
 * World-space varyings shared by every injection below.
 *
 * `vWorldP` is the fragment's world position **including the instance matrix**
 * — three applies `instanceMatrix` inside `<project_vertex>`, so a naive
 * `modelMatrix * transformed` at `<begin_vertex>` reports the same position for
 * every instance and any world-space effect collapses to a per-instance repeat.
 * `vInstOrigin` is the instance's own origin, which is the only stable
 * per-instance identity available without a custom attribute.
 */
const WORLD_PARS = /* glsl */ `
varying vec3 vWorldP;
varying float vViewDist;
`;

const WORLD_VERTEX = /* glsl */ `
  vec4 kWP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    kWP = instanceMatrix * kWP;
  #endif
  vWorldP = ( modelMatrix * kWP ).xyz;
  vViewDist = length( ( viewMatrix * vec4( vWorldP, 1.0 ) ).xyz );
`;

/** Per-instance identity, paid for only where a surface actually jitters. */
const INST_PARS = 'varying vec3 vInstOrigin;\n';

const INST_VERTEX = /* glsl */ `
  vec4 kOrg = vec4( 0.0, 0.0, 0.0, 1.0 );
  #ifdef USE_INSTANCING
    kOrg = instanceMatrix * kOrg;
  #endif
  vInstOrigin = ( modelMatrix * kOrg ).xyz;
`;

const WORLD_HASH = /* glsl */ `
vec3 kHash3( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}
// One 2D slice of world space that never smears on a vertical surface: folding
// Y into both axes means a wall, a roof pitch and the ground all see the
// variation move as you travel across them.
vec2 kWorldPlane( vec3 p, float period ) {
  return ( p.xz + p.y * 0.71 ) / period;
}
`;

const TRI_COMMON = /* glsl */ `
uniform float uTriScale;
uniform float uTriSharp;
varying vec3 vTriN;
vec3 triWeights() {
  vec3 w = pow( abs( normalize( vTriN ) ), vec3( uTriSharp ) );
  return w / max( 1e-4, w.x + w.y + w.z );
}
`;

export interface BreakupOpts {
  /** metres of world per cycle of the low-frequency variation */
  period: number;
  /** how hard that variation pushes albedo and roughness */
  strength: number;
  /** per-instance UV phase offset, in tiles (0 = off) */
  instUv?: number;
  /** per-instance value/hue jitter, 0..1 (0 = off) */
  instTint?: number;
  /** [near, far] metres over which fine detail settles toward the local mean */
  settle?: [number, number];
  /** roughness the surface converges on past `settle[1]` */
  settleRough?: number;
  /**
   * Second surface variant. The world-space variation cross-fades albedo toward
   * this colour, which is the cheap stand-in for the vertex-colour blend between
   * two grass or two sand variants the bible asks for — and unlike vertex
   * colours it works on geometry somebody else authored.
   */
  variantTint?: number;
  variantAmount?: number;
}

/**
 * Tiling breakup, per-instance de-duplication and distance settle, in one
 * injection because they all need the same world-space varyings.
 *
 * The variation channel (ORM.a) is sampled in **world space**, not UV space.
 * Sampling it in UV space welds the modulation to each mesh's own UV layout,
 * so a hundred instanced houses get the identical blotch in the identical
 * place — which is precisely the visible-tiling fail the art bible calls out.
 * In world space the modulation is continuous across the whole village and
 * cannot repeat per instance no matter how the UVs were laid out.
 *
 * `settle` fades the fine octave toward a high mip of the same map with
 * distance. Without it the aggregate on a road survives to the horizon at
 * constant on-screen density, which on a moving frame is a shimmering carpet;
 * anisotropic filtering makes this *worse*, because it holds a low mip at
 * exactly the grazing angles a racing camera lives at.
 */
function injectBreakup(mat: THREE.Material, o: BreakupOpts): void {
  const uBreak = { value: new THREE.Vector2(o.period, o.strength) };
  const uInst = { value: new THREE.Vector2(o.instUv ?? 0, o.instTint ?? 0) };
  const settle = o.settle ?? [1e6, 1e6 + 1];
  const uSettle = { value: new THREE.Vector3(settle[0], settle[1], o.settleRough ?? 0.8) };
  const uVariant = {
    value: new THREE.Vector4(0, 0, 0, 0),
  };
  if (o.variantTint !== undefined) {
    const c = new THREE.Color(o.variantTint).convertSRGBToLinear();
    uVariant.value.set(c.r, c.g, c.b, o.variantAmount ?? 0.5);
  }
  const jitters = (o.instUv ?? 0) > 0;
  const settles = !!o.settle;
  // Compiled in only where it is asked for: a second variant costs a texture
  // fetch and most surfaces do not need one.
  const VARIANT_BLEND =
    o.variantTint === undefined
      ? ''
      : /* glsl */ `
            #ifdef USE_ROUGHNESSMAP
            {
              // second variant, keyed off a world signal on a different period
              // from the tile — the repeat can still be measured but never seen
              float kV = texture2D( roughnessMap, kWorldPlane( vWorldP, uBreak.x * 1.63 ) + 0.37 ).a;
              float kL = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
              sampledDiffuseColor.rgb = mix(
                sampledDiffuseColor.rgb,
                uVariant.xyz * ( 0.55 + kL * 1.1 ),
                smoothstep( 0.35, 0.72, kV ) * uVariant.w );
            }
            #endif`;
  const prev = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uBreak = uBreak;
    shader.uniforms.uInstJit = uInst;
    shader.uniforms.uSettle = uSettle;
    shader.uniforms.uVariant = uVariant;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS + (jitters ? INST_PARS : ''))
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' + WORLD_VERTEX + (jitters ? INST_VERTEX : ''),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
          WORLD_PARS +
          (jitters ? INST_PARS : '') +
          WORLD_HASH +
          'uniform vec2 uBreak;\nuniform vec2 uInstJit;\nuniform vec3 uSettle;\nuniform vec4 uVariant;\n' +
          'float gBreak = 0.0;\nfloat gSettle = 0.0;\nvec2 gUvJit = vec2( 0.0 );\n',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          ${jitters ? 'vec3 kIH = kHash3( floor( vInstOrigin * 3.7 ) + 0.5 );' : 'vec3 kIH = vec3( 0.5 );'}
          gUvJit = ( kIH.xy - 0.5 ) * uInstJit.x;
          gSettle = smoothstep( uSettle.x, uSettle.y, vViewDist );
          #ifdef USE_ROUGHNESSMAP
            gBreak = ( texture2D( roughnessMap, kWorldPlane( vWorldP, uBreak.x ) ).a - 0.5 ) * 2.0 * uBreak.y;
          #endif
          #ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vMapUv + gUvJit );
            // settle: past the ramp the fine octave is replaced by its own local
            // mean, so the far field resolves to a clean value instead of crawling
            sampledDiffuseColor = mix( sampledDiffuseColor, textureLod( map, vMapUv + gUvJit, 5.5 ), gSettle );
            sampledDiffuseColor.rgb *= 1.0 + gBreak * 0.30;
            sampledDiffuseColor.rgb *= vec3( 1.0 ) + ( kIH.zxy - 0.5 ) * vec3( 1.0, 0.55, 0.8 ) * uInstJit.y;
${VARIANT_BLEND}
            diffuseColor *= sampledDiffuseColor;
          #endif
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv + gUvJit ).g * ( 1.0 + gBreak * 0.26 );
          roughnessFactor = mix( roughnessFactor, uSettle.z, gSettle );
        #endif`,
      );

    if (jitters || settles) {
      shader.fragmentShader = shader.fragmentShader
        .replace('texture2D( aoMap, vAoMapUv )', 'texture2D( aoMap, vAoMapUv + gUvJit )')
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 mapN = texture2D( normalMap, vNormalMapUv + gUvJit ).xyz * 2.0 - 1.0;
            // relief has to go with the detail it belongs to, or the far road
            // keeps a normal map it has no albedo left to justify
            mapN.xy *= normalScale * ( 1.0 - gSettle * 0.85 );
            normal = normalize( tbn * mapN );
          #endif`,
        );
    }
  };

  const key =
    `brk${o.period}_${o.strength}_${o.instUv ?? 0}_${o.instTint ?? 0}` +
    `_${settles ? settle.join(',') : 'x'}_${o.variantTint ?? 'x'}`;
  mat.customProgramCacheKey = () => key;
}

export interface TriplanarOpts {
  /** metres of world covered by one tile of the detail octave */
  worldScale: number;
  /**
   * Projection blend exponent. Too low and the X and Z projections cross-fade
   * over most of a curved surface, which is not a blend — it is two copies of a
   * directional noise sliding past each other, and it reads as fur. A tunnel
   * bore or a boulder needs one dominant projection almost everywhere.
   */
  sharpness: number;
  /** metres per cycle of the low-frequency variation */
  period: number;
  /**
   * How many times larger the macro form octave is than the detail octave.
   * Deliberately non-integer so the two never come back into phase.
   */
  macro: number;
  /** how hard the macro octave tips the surface normal */
  macroRelief: number;
  /** [near, far] metres over which the detail octave settles */
  settle?: [number, number];
}

/**
 * World-space triplanar projection with whiteout normal blending, at two
 * scales. Used on cliff rock and the tunnel bore, where the geometry has no
 * sane UV layout and any planar mapping smears down a 40 m rock face.
 *
 * The second (macro) octave is the part that makes rock read as rock. One
 * 1024² tile at a few metres can only carry centimetre-to-decimetre detail;
 * everything larger mips away by 15 m, and a cliff with no feature bigger than
 * a hand catches no form shading from a 14° key — it is sandpaper wallpaper.
 * Sampling the same normal map again at `macro`× the scale costs three taps and
 * buys metre-scale relief that the low sun can actually rake across.
 */
function injectTriplanar(mat: THREE.Material, o: TriplanarOpts): void {
  const uScale = { value: 1 / o.worldScale };
  const uSharp = { value: o.sharpness };
  const uMacro = { value: new THREE.Vector3(1 / (o.worldScale * o.macro), o.macroRelief, o.period) };
  const settle = o.settle ?? [1e6, 1e6 + 1];
  const uSettle = { value: new THREE.Vector2(settle[0], settle[1]) };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = uScale;
    shader.uniforms.uTriSharp = uSharp;
    shader.uniforms.uTriMacro = uMacro;
    shader.uniforms.uSettle = uSettle;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WORLD_PARS + '\nvarying vec3 vTriN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' +
          WORLD_VERTEX +
          /* glsl */ `
        vec3 kON = objectNormal;
        #ifdef USE_INSTANCING
          kON = mat3( instanceMatrix ) * kON;
        #endif
        vTriN = normalize( mat3( modelMatrix ) * kON );`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
          WORLD_PARS +
          WORLD_HASH +
          TRI_COMMON +
          '\nuniform vec3 uTriMacro;\nuniform vec2 uSettle;\n' +
          'float gBreak = 0.0;\nfloat gSettle = 0.0;\nfloat gCavity = 1.0;\nvec3 gTriW = vec3( 0.0, 1.0, 0.0 );\n' +
          'vec2 gTriX = vec2( 0.0 );\nvec2 gTriY = vec2( 0.0 );\nvec2 gTriZ = vec2( 0.0 );\n',
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        gTriW = triWeights();
        gTriX = vWorldP.zy * uTriScale;
        gTriY = vWorldP.xz * uTriScale;
        gTriZ = vWorldP.xy * uTriScale;
        gSettle = smoothstep( uSettle.x, uSettle.y, vViewDist );
        #ifdef USE_ROUGHNESSMAP
          gBreak = ( texture2D( roughnessMap, kWorldPlane( vWorldP, uTriMacro.z ) ).a - 0.5 ) * 2.0;
        #endif
        #ifdef USE_MAP
          vec4 sampledDiffuseColor =
            texture2D( map, gTriX ) * gTriW.x + texture2D( map, gTriY ) * gTriW.y + texture2D( map, gTriZ ) * gTriW.z;
          sampledDiffuseColor = mix( sampledDiffuseColor, textureLod( map, gTriY, 5.5 ), gSettle * 0.65 );
          sampledDiffuseColor.rgb *= 1.0 + gBreak * 0.30;
          diffuseColor *= sampledDiffuseColor;
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          vec4 triR = texture2D( roughnessMap, gTriX ) * gTriW.x + texture2D( roughnessMap, gTriY ) * gTriW.y +
                      texture2D( roughnessMap, gTriZ ) * gTriW.z;
          gCavity = triR.r;
          roughnessFactor *= triR.g * ( 1.0 + gBreak * 0.24 );
          // damp collects low and in the shade: the floor line of a rock cut is
          // always darker and glossier than its crown, and that split is most of
          // what tells you the surface is stone and not carpet
          roughnessFactor *= 1.0 - ( 1.0 - gCavity ) * 0.30;
        #endif`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 tnX = texture2D( normalMap, gTriX ).xyz * 2.0 - 1.0;
          vec3 tnY = texture2D( normalMap, gTriY ).xyz * 2.0 - 1.0;
          vec3 tnZ = texture2D( normalMap, gTriZ ).xyz * 2.0 - 1.0;
          // macro octave: the same map at a non-integer multiple of the scale,
          // supplying the metre-scale form the detail tile is too small to hold
          vec2 mScale = vec2( uTriMacro.x / uTriScale );
          tnX.xy += ( texture2D( normalMap, gTriX * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          tnY.xy += ( texture2D( normalMap, gTriY * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          tnZ.xy += ( texture2D( normalMap, gTriZ * mScale ).xy * 2.0 - 1.0 ) * uTriMacro.y;
          vec2 nsc = normalScale * ( 1.0 - gSettle * 0.5 );
          tnX.xy *= nsc; tnY.xy *= nsc; tnZ.xy *= nsc;
          vec3 gN = normalize( vTriN );
          // whiteout blend: add the geometric normal in, keep z positive, reswizzle per axis
          tnX = vec3( tnX.xy + gN.zy, abs( tnX.z ) * gN.x );
          tnY = vec3( tnY.xy + gN.xz, abs( tnY.z ) * gN.y );
          tnZ = vec3( tnZ.xy + gN.xy, abs( tnZ.z ) * gN.z );
          vec3 triWorldN = normalize( tnX.zyx * gTriW.x + tnY.xzy * gTriW.y + tnZ.xyz * gTriW.z );
          normal = normalize( ( viewMatrix * vec4( triWorldN, 0.0 ) ).xyz );
        #endif`,
      );
  };
  mat.customProgramCacheKey = () =>
    `tri${o.worldScale}_${o.sharpness}_${o.macro}_${o.macroRelief}_${o.period}_${o.settle ? o.settle.join(',') : 'x'}`;
}

/**
 * Wrap/transmission lighting for leaf cards. At 14° sun elevation the palms and
 * hedges are almost all backlit; without this they read as black cutouts, which
 * throws away the single best lighting moment on the course.
 */
function injectFoliageSSS(mat: THREE.Material, color: THREE.Color, strength: number): void {
  const uCol = { value: color };
  const uStr = { value: strength };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSSSColor = uCol;
    shader.uniforms.uSSSStrength = uStr;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSSSColor;\nuniform float uSSSStrength;')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
          vec3 sssV = normalize( vViewPosition );
          vec3 sssL = directionalLights[ 0 ].direction;
          float sssBack = pow( max( 0.0, dot( sssV, -sssL ) ), 3.0 );
          float sssWrap = max( 0.0, dot( normal, sssL ) * 0.5 + 0.5 );
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * uSSSColor * diffuseColor.rgb *
            ( sssBack * 1.35 + sssWrap * 0.22 ) * uSSSStrength;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => `foliagesss${strength}`;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

let active: Materials | null = null;

export class Materials implements System {
  private cache = new Map<string, Entry>();
  private variants = new Map<string, THREE.Material>();
  private aniso = 8;
  private quality: Quality = Quality.High;

  // animated bits, held so update() allocates nothing
  private boostEmissive: THREE.Texture | null = null;
  private boostMat: THREE.MeshStandardMaterial | null = null;
  private waterTime: { value: number } | null = null;
  private neonMat: THREE.MeshStandardMaterial | null = null;
  private envConsumers: THREE.MeshStandardMaterial[] = [];
  private lastEnv: THREE.Texture | null = null;
  private clock = 0;

  constructor() {
    active = this;
  }

  init(ctx: Ctx): void {
    this.quality = ctx.settings.quality;
    const caps = ctx.renderer?.capabilities;
    this.aniso = caps ? Math.min(8, caps.getMaxAnisotropy()) : 8;
  }

  // -- public API ----------------------------------------------------------

  /** Fetch (building on first call) a shared material by name. Never mutate the result. */
  get(name: string): THREE.Material {
    const key = ALIASES[name] ?? name;
    const hit = this.cache.get(key);
    if (hit) return hit.mat;
    const entry = this.build(key);
    this.cache.set(key, entry);
    return entry.mat;
  }

  standard(name: string): THREE.MeshStandardMaterial {
    return this.get(name) as THREE.MeshStandardMaterial;
  }

  physical(name: string): THREE.MeshPhysicalMaterial {
    return this.get(name) as THREE.MeshPhysicalMaterial;
  }

  /** Metres of world one texture tile is authored to cover. */
  worldScale(name: string): number {
    return WORLD_SCALE[ALIASES[name] ?? name] ?? 1;
  }

  /**
   * A recoloured (or otherwise tweaked) copy of a base material that SHARES its
   * textures — this is how eight kart liveries and a dozen stucco pastels cost
   * one texture set between them. Cached, so repeated calls are free.
   */
  variant(
    base: string,
    o: {
      color?: THREE.ColorRepresentation;
      roughness?: number;
      metalness?: number;
      emissive?: THREE.ColorRepresentation;
      emissiveIntensity?: number;
      clearcoat?: number;
      opacity?: number;
      key?: string;
    },
  ): THREE.Material {
    const key = `${base}|${o.key ?? JSON.stringify(o)}`;
    const hit = this.variants.get(key);
    if (hit) return hit;
    const src = this.get(base) as THREE.MeshPhysicalMaterial;
    const m = src.clone() as THREE.MeshPhysicalMaterial;
    // `Material.copy()` walks a fixed property list and `onBeforeCompile` is not
    // on it, so a plain clone silently drops every shader injection this library
    // installs. That is how a hundred instanced houses ended up sharing one
    // un-broken-up texture phase: the tiling breakup was never running on the
    // variant at all. Carry both across, and keep the cache key with them or
    // three will hand the clone the base material's compiled program.
    const before = (src as { onBeforeCompile?: THREE.Material['onBeforeCompile'] }).onBeforeCompile;
    if (before && before !== THREE.Material.prototype.onBeforeCompile) {
      m.onBeforeCompile = before.bind(src);
      m.customProgramCacheKey = src.customProgramCacheKey.bind(src);
    }
    if (o.color !== undefined) m.color.set(o.color);
    if (o.roughness !== undefined) m.roughness = o.roughness;
    if (o.metalness !== undefined) m.metalness = o.metalness;
    if (o.emissive !== undefined && m.emissive) m.emissive.set(o.emissive);
    if (o.emissiveIntensity !== undefined) m.emissiveIntensity = o.emissiveIntensity;
    if (o.clearcoat !== undefined && 'clearcoat' in m) m.clearcoat = o.clearcoat;
    if (o.opacity !== undefined) {
      m.opacity = o.opacity;
      m.transparent = o.opacity < 1;
    }
    // Clones are not in `envConsumers`, so without this they never receive
    // `ctx.envMap` and fall back to whatever `scene.environment` happens to be —
    // which is how eight liveries' clearcoat and every chrome variant ended up
    // with nothing sharp to reflect.
    this.envConsumers.push(m as unknown as THREE.MeshStandardMaterial);
    if (this.lastEnv) { m.envMap = this.lastEnv; m.needsUpdate = true; }
    this.variants.set(key, m);
    return m;
  }

  /** Lacquered kart bodywork in a roster colour. Shares the painted-metal texture set. */
  livery(color: THREE.ColorRepresentation, key?: string): THREE.MeshPhysicalMaterial {
    const c = new THREE.Color(color);
    return this.variant('metal-painted', {
      color: c,
      key: key ?? `livery${c.getHexString()}`,
    }) as THREE.MeshPhysicalMaterial;
  }

  /** One of the village pastels (index wraps). */
  stuccoTint(i: number): THREE.MeshStandardMaterial {
    const hex = STUCCO_TINTS[((i % STUCCO_TINTS.length) + STUCCO_TINTS.length) % STUCCO_TINTS.length];
    return this.variant('stucco', { color: hex, key: `pastel${i}` }) as THREE.MeshStandardMaterial;
  }

  // -- convenience getters (typed, so call sites keep autocomplete) ---------

  get tarmac() { return this.standard('tarmac'); }
  get racingLine() { return this.standard('tarmac-racing-line'); }
  get cobblestone() { return this.standard('cobblestone'); }
  get kerb() { return this.standard('kerb'); }
  get sand() { return this.standard('sand'); }
  get grass() { return this.standard('grass'); }
  get dirt() { return this.standard('dirt'); }
  get cliffRock() { return this.standard('cliff-rock'); }
  get tunnelBore() { return this.standard('tunnel-bore'); }
  get stoneWall() { return this.standard('stone-wall'); }
  get stucco() { return this.standard('stucco'); }
  get roofTile() { return this.standard('roof-tile'); }
  get woodPlank() { return this.standard('wood-plank'); }
  get woodWeathered() { return this.standard('wood-weathered'); }
  get metalPainted() { return this.physical('metal-painted'); }
  get chrome() { return this.standard('chrome'); }
  get rubber() { return this.standard('rubber'); }
  get glass() { return this.physical('glass'); }
  get canvasAwning() { return this.standard('canvas-awning'); }
  get water() { return this.physical('water-surface'); }
  get concrete() { return this.standard('concrete'); }
  get marble() { return this.physical('marble'); }
  get boostPad() { return this.standard('boost-pad'); }
  get bannerFabric() { return this.standard('banner-fabric'); }
  get palmBark() { return this.standard('palm-bark'); }
  get foliageLeaf() { return this.standard('foliage-leaf'); }
  get palmFrond() { return this.standard('palm-frond'); }
  get crowd() { return this.standard('crowd'); }
  get tunnelLight() { return this.standard('tunnel-light'); }
  get neon() { return this.standard('neon'); }

  /** Layout of the crowd atlas: 4 columns × 2 rows of spectator cutouts. */
  readonly crowdAtlas = { cols: 4, rows: 2, count: 8 };

  // -- lifecycle -----------------------------------------------------------

  update(ctx: Ctx, dt: number): void {
    this.clock += dt;
    if (this.boostEmissive) {
      // chevrons flow in +V, i.e. the direction of travel across the pad
      this.boostEmissive.offset.y = (this.boostEmissive.offset.y - dt * 0.85) % 1;
      this.boostMat!.emissiveIntensity = 1.15 + Math.sin(this.clock * 7.5) * 0.28;
    }
    if (this.waterTime) this.waterTime.value = this.clock;
    if (this.neonMat) this.neonMat.emissiveIntensity = 2.1 + Math.sin(this.clock * 3.1) * 0.12;

    if (ctx.envMap !== this.lastEnv) {
      this.lastEnv = ctx.envMap;
      for (const m of this.envConsumers) {
        m.envMap = ctx.envMap;
        m.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const e of this.cache.values()) {
      for (const t of e.textures) t.dispose();
      e.mat.dispose();
    }
    for (const m of this.variants.values()) m.dispose();
    this.cache.clear();
    this.variants.clear();
    this.envConsumers.length = 0;
    this.boostEmissive = null;
    this.boostMat = null;
    this.waterTime = null;
    this.neonMat = null;
    if (active === this) active = null;
  }

  // -- internals -----------------------------------------------------------

  private res(name: string): number {
    const base = BASE_SIZE[name] ?? 512;
    const scale = this.quality <= Quality.Medium ? 0.5 : 1;
    return Math.max(128, Math.round(base * scale));
  }

  private maps(f: Fields, o: Parameters<typeof buildMaps>[1] = {}): MapSet {
    return buildMaps(f, { anisotropy: this.aniso, ...o });
  }

  /** Wire a standard material to a generated map set with sane defaults. */
  private std(m: MapSet, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      map: m.map,
      normalMap: m.normalMap,
      roughnessMap: m.ormMap,
      metalnessMap: m.ormMap,
      aoMap: m.ormMap,
      roughness: 1,
      metalness: 1,
      ...o,
    });
    return mat;
  }

  private phys(m: MapSet, o: Partial<THREE.MeshPhysicalMaterialParameters> = {}): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      map: m.map,
      normalMap: m.normalMap,
      roughnessMap: m.ormMap,
      metalnessMap: m.ormMap,
      aoMap: m.ormMap,
      roughness: 1,
      metalness: 1,
      ...o,
    });
  }

  private build(name: string): Entry {
    const size = this.res(name);
    switch (name) {
      case 'tarmac': return this.buildTarmac(size, false);
      case 'tarmac-racing-line': return this.buildTarmac(size, true);
      case 'cobblestone': return this.buildCobble(size);
      case 'kerb': return this.buildKerb(size);
      case 'sand': return this.buildSand(size);
      case 'grass': return this.buildGrass(size);
      case 'dirt': return this.buildDirt(size);
      case 'cliff-rock': return this.buildCliffRock(size);
      case 'tunnel-bore': return this.buildTunnelBore(size);
      case 'stone-wall': return this.buildStoneWall(size);
      case 'stucco': return this.buildStucco(size);
      case 'roof-tile': return this.buildRoofTile(size);
      case 'wood-plank': return this.buildWood(size, false);
      case 'wood-weathered': return this.buildWood(size, true);
      case 'metal-painted': return this.buildPaintedMetal(size);
      case 'chrome': return this.buildChrome(size);
      case 'rubber': return this.buildRubber(size);
      case 'glass': return this.buildGlass(size);
      case 'canvas-awning': return this.buildAwning(size);
      case 'water-surface': return this.buildWater(size);
      case 'concrete': return this.buildConcrete(size);
      case 'marble': return this.buildMarble(size);
      case 'boost-pad': return this.buildBoostPad(size);
      case 'banner-fabric': return this.buildBanner(size);
      case 'palm-bark': return this.buildPalmBark(size);
      case 'foliage-leaf': return this.buildLeafCard(size, false);
      case 'palm-frond': return this.buildLeafCard(size, true);
      case 'crowd': return this.buildCrowd(size);
      case 'tunnel-light': return this.buildLightStrip(size, 0xffb264, 2.4);
      case 'neon': return this.buildLightStrip(size, 0x4fc3ff, 2.1);
      default:
        // Unknown name: a loud magenta so it is caught in review, not shipped.
        return { mat: new THREE.MeshStandardMaterial({ color: 0xff00aa, roughness: 0.6 }), textures: [] };
    }
  }

  // =========================================================================
  // Ground
  // =========================================================================

  /**
   * Asphalt. Binder + exposed aggregate, with the aggregate showing through
   * only where the surface has worn — that correlation is what stops it
   * reading as noise sprinkled on grey.
   */
  private buildTarmac(size: number, racingLine: boolean): Entry {
    const f = new Fields(size);
    const agg = voronoiField(size, 96, 96, 1.0, racingLine ? 71 : 11);
    const crack = voronoiField(size, 4, 4, 0.85, 21, 4);
    const grit = fbmField(size, { freq: Math.round(size / 5), octaves: 2, seed: 12 });
    const wear = fbmField(size, { freq: 7, octaves: 4, seed: 13, warp: 0.03 });
    const patch = fbmField(size, { freq: 15, octaves: 3, seed: 15, mode: 'turbulence' });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 14, warp: 0.05 });
    const tar = fbmField(size, { freq: 4, octaves: 3, seed: 17, warp: 0.06 });
    // rubber laid down along the direction of travel (V)
    const smear = fbmField(size, { freq: 14, octaves: 3, seed: 31, stretchY: 0.22 });
    const grain = grainField(size, 16);

    const binder = rgb(racingLine ? 0x43434d : 0x4a4a52);
    // Chippings are a VALUE break in the binder, not a hue break. A warm grey
    // this far from the binder's cool violet survives the golden-hour key and
    // the 1.12 saturation lift as orange confetti sprinkled on lavender, which
    // is the one thing asphalt never looks like.
    const aggWarm = rgb(0x6e6a66);
    const aggCool = rgb(0x5c5c64);
    const rubberCol = rgb(0x2c2b31);

    const baseRough = racingLine ? 0.55 : 0.72;

    for (let i = 0; i < size * size; i++) {
      const cellId = agg.id[i];
      const cv = hash2(cellId, 7, 3);
      // Aggregate crown: close to the site AND in a worn patch. The patch gate
      // has to stay tight — widen it and the 36 mm chippings clot into 20 cm
      // blotches, which is what reads as confetti rather than as exposed stone.
      const stone = smoothstep(0.42, 0.14, agg.f1[i]) * smoothstep(0.46, 0.68, patch[i]);
      // cracks are rare and shallow: a full crack net over every square metre
      // is a texture-artist tell, not a road
      const edge = smoothstep(0.028, 0.0, crack.f2[i] - crack.f1[i]) * smoothstep(0.62, 0.85, wear[i]);
      const tarBleed = smoothstep(0.62, 0.82, tar[i]);
      const rub = racingLine ? smoothstep(0.42, 0.88, smear[i]) : 0;

      mixRGB(aggCool, aggWarm, cv, _a);
      mixRGB(binder, _a, stone * 0.45, _b);
      mixRGB(_b, rubberCol, rub * 0.26 + tarBleed * 0.12, _c);

      // tone: large-scale sun-bleaching plus per-texel grit
      const tone = 0.9 + wear[i] * 0.2 + (grain[i] - 0.5) * 0.05 - edge * 0.2;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      // NB: no white-noise term in the height field. Per-texel noise produces
      // normals that cannot be mip-filtered and shows up as specular crawl on
      // a road surface at speed — grain belongs in albedo and roughness only.
      // The chip crown carries most of the relief: with the albedo contrast
      // pulled down to a value break, the normal is now what has to make a
      // 36 mm chipping legible at 1 m under a 14° key.
      const h = grit[i] * 0.09 + stone * 0.5 + (1 - clamp01(agg.f1[i] * 1.6)) * 0.04 - edge * 0.4;
      const rough = clamp(
        baseRough + (grit[i] - 0.5) * 0.2 + (wear[i] - 0.5) * 0.22 - stone * 0.16 - tarBleed * 0.24 - rub * 0.14,
        0.24,
        0.97,
      );
      const ao = 1 - edge * 0.3 - (1 - stone) * 0.05 - clamp01(1 - grit[i]) * 0.04;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    // 0.46 was too shallow for the key to find: at 1 m the surface read as fine
    // purple felt with no chippings resolving at all. The racing line stays
    // flatter on purpose — that is what "worn smooth" means.
    const m = this.maps(f, { normalStrength: racingLine ? 0.6 : 0.95 });
    const mat = this.std(m, { envMapIntensity: 0.7 });
    injectBreakup(mat, {
      period: 27.3,
      strength: 0.85,
      // Aggregate that keeps full contrast to the horizon crawls on a moving
      // frame; past ~34 m the road resolves to its own local mean instead.
      settle: [34, 95],
      settleRough: racingLine ? 0.66 : 0.78,
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Village cobbles: domed setts, deep mortar joints, crowns polished by traffic. */
  private buildCobble(size: number): Entry {
    const f = new Fields(size);
    const v = voronoiField(size, 12, 12, 0.72, 41);
    const micro = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 43 });
    const chip = fbmField(size, { freq: 30, octaves: 3, seed: 44, mode: 'turbulence' });
    const damp = fbmField(size, { freq: 3, octaves: 3, seed: 45, warp: 0.05 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 46, warp: 0.04 });
    const grain = grainField(size, 47);

    const pal = [rgb(0x8f887c), rgb(0x7b7469), rgb(0xa1968a), rgb(0x8a8074), rgb(0x9c8c78), rgb(0x77787c)];
    const mortar = rgb(0x6f6a60);

    for (let i = 0; i < size * size; i++) {
      const gap = v.f2[i] - v.f1[i];
      const joint = smoothstep(0.0, 0.14, gap); // 0 in the joint, 1 on the stone
      const dome = Math.pow(joint, 0.45);
      const id = v.id[i];
      const stone = pal[id % pal.length];
      const tint = hash2(id, 3, 9);
      mixRGB(stone, pal[(id * 7 + 3) % pal.length], tint * 0.45, _a);

      // crown wear: the top of each sett is lighter and much smoother
      const crown = smoothstep(0.55, 1.0, dome) * (0.7 + hash2(id, 11, 5) * 0.6);
      const chipped = smoothstep(0.62, 0.86, chip[i]) * joint;
      const wet = smoothstep(0.55, 0.85, damp[i]);

      mixRGB(mortar, _a, joint, _b);
      const tone =
        (0.88 + tint * 0.2 + crown * 0.14 - wet * 0.22 + (micro[i] - 0.5) * 0.16 + (grain[i] - 0.5) * 0.05) *
        (1 - chipped * 0.12);
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = dome * 0.85 + micro[i] * 0.08 * joint - chipped * 0.12;
      const rough = clamp(
        0.86 - crown * 0.42 - wet * 0.14 + chipped * 0.1 + (micro[i] - 0.5) * 0.14 - joint * 0.06,
        0.22,
        0.98,
      );
      const ao = 1 - (1 - joint) * 0.62 - (1 - dome) * 0.12;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.9 });
    const mat = this.std(m, { envMapIntensity: 0.9 });
    injectBreakup(mat, { period: 12.7, strength: 0.7, settle: [40, 110], settleRough: 0.8 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /**
   * Kerb. Bands run across V so the mesh's V axis should follow the kerb's
   * length. Paint is chipped preferentially at the band boundaries, where a
   * real kerb takes wheel strikes.
   */
  private buildKerb(size: number): Entry {
    const f = new Fields(size);
    const chip = fbmField(size, { freq: 26, octaves: 4, seed: 51, mode: 'turbulence' });
    const pit = fbmField(size, { freq: Math.round(size / 12), octaves: 2, seed: 52 });
    const scuff = fbmField(size, { freq: 12, octaves: 3, seed: 53, stretchY: 0.3 });
    const dirtN = fbmField(size, { freq: 5, octaves: 3, seed: 54, warp: 0.04 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 55 });
    const grain = grainField(size, 56);

    const red = rgb(0xe0453f);
    const white = rgb(0xf2ece0);
    const concreteC = rgb(0x9d9589);
    const rubberC = rgb(0x3a3a40);
    const bands = 4; // two red + two white per tile

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const bandF = v * bands;
      const band = Math.floor(bandF);
      const inBand = bandF - band;
      // distance to the nearest band boundary, in texels
      const dEdge = Math.min(inBand, 1 - inBand) * (size / bands);
      const bevel = smoothstep(0, 3.5, dEdge);
      const isRed = (band & 1) === 0;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const paint = isRed ? red : white;
        // chips cluster on the boundaries
        const chipMask = smoothstep(0.5, 0.72, chip[i] + (1 - bevel) * 0.3) * smoothstep(0.25, 0.55, dirtN[i] + 0.2);
        const sc = smoothstep(0.5, 0.82, scuff[i]) * (isRed ? 0.45 : 0.75);

        mixRGB(paint, concreteC, chipMask, _a);
        mixRGB(_a, rubberC, sc * 0.5, _b);
        const grime = 0.9 + dirtN[i] * 0.18 + (grain[i] - 0.5) * 0.05;
        const tone = grime * (0.94 + bevel * 0.06);
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        const h = bevel * 0.5 + pit[i] * 0.1 - chipMask * 0.35;
        const rough = clamp(
          0.42 + chipMask * 0.46 + (pit[i] - 0.5) * 0.14 + sc * 0.1 + dirtN[i] * 0.12 - bevel * 0.02,
          0.28,
          0.96,
        );
        const ao = 1 - (1 - bevel) * 0.2 - chipMask * 0.12;
        f.surf(i, h, ao, rough);
        f.macro(i, macro[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.65 });
    const mat = this.std(m, { envMapIntensity: 0.9 });
    injectBreakup(mat, { period: 9.1, strength: 0.45 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Beach sand: wind ripples, a shell scatter, damp patches near the tide line. */
  private buildSand(size: number): Entry {
    const f = new Fields(size);
    const dune = fbmField(size, { freq: 3, octaves: 4, seed: 61, warp: 0.07 });
    const rippleWarp = fbmField(size, { freq: 5, octaves: 3, seed: 62 });
    const micro = fbmField(size, { freq: Math.round(size / 6), octaves: 2, seed: 63 });
    const shells = voronoiField(size, 34, 34, 1.0, 64, 2);
    const damp = fbmField(size, { freq: 4, octaves: 3, seed: 65, warp: 0.09 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 66, warp: 0.05 });
    const grain = grainField(size, 67);

    const dry = rgb(0xe3c893);
    const wet = rgb(0xa98f63);
    const shellC = rgb(0xf4ece0);
    const dark = rgb(0xc7a97a);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // ripples: an integer-frequency sine whose phase is pushed around by a
        // tiling warp field, so the crests meander instead of striping.
        const phase = (u * 9 + v * 3) + (rippleWarp[i] - 0.5) * 1.6;
        const ripple = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
        const rippleAmt = smoothstep(0.35, 0.7, dune[i]);
        const wetness = smoothstep(0.52, 0.78, damp[i]);
        const shell = smoothstep(0.16, 0.05, shells.f1[i]) * (hash2(shells.id[i], 5, 2) > 0.82 ? 1 : 0);

        mixRGB(dry, wet, wetness * 0.8, _a);
        mixRGB(_a, dark, (1 - ripple) * rippleAmt * 0.16, _b);
        mixRGB(_b, shellC, shell * 0.85, _c);
        const tone = 0.93 + dune[i] * 0.14 + (micro[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.07;
        f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

        const h =
          dune[i] * 0.35 + ripple * rippleAmt * 0.3 + micro[i] * 0.08 + shell * 0.22;
        const rough = clamp(
          0.93 - wetness * 0.34 - shell * 0.3 + (micro[i] - 0.5) * 0.1 - ripple * rippleAmt * 0.03,
          0.4,
          0.99,
        );
        const ao = 1 - (1 - ripple) * rippleAmt * 0.14 - (1 - dune[i]) * 0.06;
        f.surf(i, h, ao, rough);
        f.macro(i, macro[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { envMapIntensity: 0.8 });
    injectBreakup(mat, { period: 23.3, strength: 0.75, settle: [45, 130], settleRough: 0.9 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Turf seen from a kart: clumps, dry patches, blade direction, soil showing through. */
  private buildGrass(size: number): Entry {
    const f = new Fields(size);
    const clump = fbmField(size, { freq: 9, octaves: 4, seed: 71, warp: 0.03 });
    const blade = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 72, stretchY: 0.22 });
    const blade2 = fbmField(size, { freq: Math.round(size / 16), octaves: 2, seed: 73, stretchY: 4 });
    const dryN = fbmField(size, { freq: 6, octaves: 3, seed: 74, warp: 0.06 });
    const bare = fbmField(size, { freq: 4, octaves: 4, seed: 75, warp: 0.05 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 76, warp: 0.04 });
    const grain = grainField(size, 77);

    const dark = rgb(0x4e7434);
    const mid = rgb(0x6f9b47);
    const tip = rgb(0x87b356);
    const dryC = rgb(0xb5a35c);
    const soil = rgb(0x6b5238);

    for (let i = 0; i < size * size; i++) {
      const b = blade[i] * 0.65 + blade2[i] * 0.35;
      const height = clamp01(clump[i] * 0.7 + b * 0.5);
      const soilMask = smoothstep(0.33, 0.16, bare[i]);
      const dryMask = smoothstep(0.58, 0.82, dryN[i]);

      mixRGB(dark, mid, clamp01(height * 1.4), _a);
      mixRGB(_a, tip, smoothstep(0.55, 0.95, b), _b);
      mixRGB(_b, dryC, dryMask * 0.7, _c);
      mixRGB(_c, soil, soilMask * 0.7, _a);
      const tone = 0.88 + clump[i] * 0.22 + (grain[i] - 0.5) * 0.09;
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

      // The 3 cm blade octave stays OUT of the height field. At 3.2 m per tile
      // it is near per-texel, and per-texel normals cannot be mip-filtered —
      // that is the crawl on the left bank, not the tile repeat. Only the clump
      // and the coarse stretched octave carry relief; the fine blades live in
      // albedo and roughness, where mipping resolves them to a clean value.
      const h = clump[i] * 0.62 + blade2[i] * 0.34 - soilMask * 0.3;
      const rough = clamp(0.86 - smoothstep(0.6, 1.0, b) * 0.16 + soilMask * 0.08 - dryMask * 0.04, 0.55, 0.99);
      const ao = 1 - (1 - height) * 0.34 - soilMask * 0.1;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.85 });
    const mat = this.std(m, { envMapIntensity: 0.7 });
    injectBreakup(mat, {
      period: 17.9,
      strength: 0.9,
      // a drier, yellower meadow variant swapping in on its own period
      variantTint: 0x9fae5e,
      variantAmount: 0.5,
      settle: [30, 100],
      settleRough: 0.9,
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Compacted earth: embedded pebbles, dried cracks, tyre-churned tone. */
  private buildDirt(size: number): Entry {
    const f = new Fields(size);
    const peb = voronoiField(size, 26, 26, 1.0, 81);
    const crack = voronoiField(size, 9, 9, 0.9, 82, 2);
    const lumps = fbmField(size, { freq: 12, octaves: 4, seed: 83, warp: 0.04 });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 84 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 85, warp: 0.05 });
    const grain = grainField(size, 86);

    const earth = rgb(0x77604a);
    const pale = rgb(0x9c8a70);
    const rich = rgb(0x584434);
    const pebC = rgb(0x8f8577);

    for (let i = 0; i < size * size; i++) {
      const pebMask = smoothstep(0.24, 0.1, peb.f1[i]) * (hash2(peb.id[i], 2, 4) > 0.55 ? 1 : 0);
      const crackMask = smoothstep(0.05, 0.0, crack.f2[i] - crack.f1[i]);
      mixRGB(earth, pale, lumps[i] * 0.7, _a);
      mixRGB(_a, rich, crackMask * 0.5 + (1 - lumps[i]) * 0.2, _b);
      mixRGB(_b, pebC, pebMask * 0.75, _c);
      const tone = 0.9 + fine[i] * 0.18 + (grain[i] - 0.5) * 0.08;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      const h = lumps[i] * 0.35 + pebMask * 0.45 + fine[i] * 0.12 - crackMask * 0.5;
      const rough = clamp(0.92 - pebMask * 0.22 + (fine[i] - 0.5) * 0.12 - lumps[i] * 0.06, 0.55, 0.99);
      const ao = 1 - crackMask * 0.55 - (1 - lumps[i]) * 0.14;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { envMapIntensity: 0.75 });
    injectBreakup(mat, { period: 19.7, strength: 0.8, settle: [40, 110], settleRough: 0.92 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  // =========================================================================
  // Architecture and terrain
  // =========================================================================

  /** Sea cliff: bedded strata, fracture planes, lichen. Triplanar — no stretching. */
  private buildCliffRock(size: number): Entry {
    const f = new Fields(size);
    const strata = fbmField(size, { freq: 4, octaves: 3, seed: 91, stretchY: 5, warp: 0.03 });
    const ridge = fbmField(size, { freq: 6, octaves: 5, seed: 92, mode: 'ridged', warp: 0.05 });
    const frac = voronoiField(size, 11, 11, 0.95, 93, 2);
    const flake = voronoiField(size, 29, 29, 0.95, 94, 2);
    const lichen = fbmField(size, { freq: 8, octaves: 4, seed: 95, warp: 0.08 });
    const fine = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 96 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 97, warp: 0.06 });
    const grain = grainField(size, 98);

    const stone = rgb(0xa8927a);
    const shade = rgb(0x7a6957);
    // The bleach was the source of the orange: pushed by the golden-hour key and
    // the saturation lift, #c9b79c goes tangerine. Cooled and pulled back so the
    // face reads as the bible's #a8927a limestone at any exposure.
    const bleach = rgb(0xbcae9a);
    const lichenC = rgb(0x8b9a6d);

    for (let i = 0; i < size * size; i++) {
      const band = strata[i];
      const fracture = smoothstep(0.03, 0.0, frac.f2[i] - frac.f1[i]) * smoothstep(0.3, 0.65, ridge[i]);
      const flakeEdge = smoothstep(0.035, 0.0, flake.f2[i] - flake.f1[i]);
      const face = smoothstep(0.3, 0.85, ridge[i]);
      const lich = smoothstep(0.62, 0.85, lichen[i]) * (1 - fracture) * smoothstep(0.35, 0.7, band);

      mixRGB(shade, stone, clamp01(band * 1.3), _a);
      mixRGB(_a, bleach, face * 0.45, _b);
      mixRGB(_b, lichenC, lich * 0.6, _c);
      // Most of the form has to come from the normal and not from baked value,
      // or the rock is a painting of a cliff that ignores where the sun is.
      const bedding = 0.84 + Math.pow(band, 0.8) * 0.28;
      const tone = bedding + (fine[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05 - fracture * 0.1;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      // Height, not albedo, is where the strata and the fracture planes belong.
      // Deepened across the board: a rock cut has to throw micro-shadow under a
      // raking key or it is wallpaper.
      const h =
        ridge[i] * 0.95 + band * 0.62 + fine[i] * 0.16 - fracture * 0.85 - flakeEdge * 0.34;
      // Genuinely bimodal: dry exposed faces near 0.62, damp shaded crevices
      // near 0.95. A constant roughness is the #1 amateur tell and 0.89 ± 0.08
      // was effectively constant.
      const rough = clamp(
        0.93 - face * 0.30 - band * 0.06 + fracture * 0.05 + lich * 0.06 + (fine[i] - 0.5) * 0.14,
        0.55,
        0.99,
      );
      const ao = 1 - fracture * 0.55 - flakeEdge * 0.2 - (1 - ridge[i]) * 0.3;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 1.25 });
    const mat = this.std(m, { envMapIntensity: 0.8 });
    mat.normalScale.set(1.15, 1.15);
    injectTriplanar(mat, {
      worldScale: WORLD_SCALE['cliff-rock'],
      // 5 was low enough that X and Z cross-faded across most of a curved face,
      // sliding two copies of the same directional noise past each other — the
      // "fur" in the tunnel bore. At 7 one projection dominates almost anywhere.
      sharpness: 7,
      period: 31.7,
      macro: 3.3,
      macroRelief: 0.72,
      settle: [70, 220],
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /**
   * The tunnel bore. A cut rock face is not a cliff face: it is fresher, darker,
   * carries the arcs the boring head left, and its floor line stays damp while
   * its crown dries. Sharing one material with the cliff is why the bore had no
   * form — crown, haunch and springline were all the same value.
   */
  private buildTunnelBore(size: number): Entry {
    const f = new Fields(size);
    // Chisel/bore arcs: the tool signature, at a slight stretch so the arcs run
    // across the bore rather than along it under either projection.
    const arcs = fbmField(size, { freq: 15, octaves: 2, seed: 301, stretchY: 0.3, mode: 'ridged' });
    const blast = fbmField(size, { freq: 7, octaves: 4, seed: 302, mode: 'ridged', warp: 0.06 });
    const frac = voronoiField(size, 9, 9, 0.95, 303, 2);
    const spall = voronoiField(size, 22, 22, 0.9, 304, 2);
    const damp = fbmField(size, { freq: 5, octaves: 3, seed: 305, warp: 0.07 });
    const soot = fbmField(size, { freq: 3, octaves: 4, seed: 306, warp: 0.05 });
    const fine = fbmField(size, { freq: Math.round(size / 12), octaves: 2, seed: 307 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 308, warp: 0.06 });
    const grain = grainField(size, 309);

    const cut = rgb(0x9c8974);
    const deep = rgb(0x6a5b4c);
    const wet = rgb(0x4e453d);
    const dust = rgb(0xb3a794);

    for (let i = 0; i < size * size; i++) {
      const arc = smoothstep(0.42, 0.9, arcs[i]);
      const face = smoothstep(0.28, 0.82, blast[i]);
      const fracture = smoothstep(0.035, 0.0, frac.f2[i] - frac.f1[i]);
      const spalled = smoothstep(0.05, 0.0, spall.f2[i] - spall.f1[i]) * smoothstep(0.4, 0.75, blast[i]);
      const wetM = smoothstep(0.52, 0.86, damp[i]);
      const sooty = smoothstep(0.45, 0.8, soot[i]);

      mixRGB(deep, cut, clamp01(face * 1.25), _a);
      mixRGB(_a, dust, arc * 0.18 * (1 - wetM), _b);
      mixRGB(_b, wet, wetM * 0.55 + sooty * 0.18, _c);
      const tone = 0.86 + face * 0.2 + (fine[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05 - fracture * 0.14;
      f.set(i, _c.r * tone, _c.g * tone, _c.b * tone);

      const h = blast[i] * 0.95 + arc * 0.2 + fine[i] * 0.14 - fracture * 0.95 - spalled * 0.45;
      // Dry blasted crown near 0.60, damp shaded floor line near 0.85 — carried
      // on the wet mask so the split follows the surface rather than a hard band.
      const rough = clamp(
        0.60 + wetM * 0.2 + (1 - face) * 0.22 + fracture * 0.08 + (fine[i] - 0.5) * 0.12,
        0.42,
        0.97,
      );
      const ao = 1 - fracture * 0.62 - spalled * 0.28 - (1 - blast[i]) * 0.3 - wetM * 0.12;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 1.35 });
    const mat = this.std(m, { envMapIntensity: 0.5 });
    mat.normalScale.set(1.2, 1.2);
    injectTriplanar(mat, {
      worldScale: WORLD_SCALE['tunnel-bore'],
      sharpness: 8,
      period: 23.3,
      macro: 3.7,
      macroRelief: 0.6,
      settle: [55, 180],
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Ashlar sea wall / bridge stone: irregular courses, chamfered blocks, weeping joints. */
  private buildStoneWall(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 5, 8, 0.37, 0.24, 0.014, 101);
    const face = fbmField(size, { freq: 24, octaves: 4, seed: 102, warp: 0.03 });
    const pit = fbmField(size, { freq: Math.round(size / 9), octaves: 2, seed: 103 });
    const streak = fbmField(size, { freq: 14, octaves: 3, seed: 104, stretchY: 0.16 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 105, warp: 0.05 });
    const grain = grainField(size, 106);

    const pal = [rgb(0xb8a68c), rgb(0xa6947c), rgb(0xc4b49a), rgb(0x9d8d76), rgb(0xb0a48e)];
    const mortar = rgb(0x9a9084);

    for (let i = 0; i < size * size; i++) {
      const e = bf.edge[i];
      const joint = smoothstep(0, 0.55, e);
      const chamfer = smoothstep(0.05, 0.45, e);
      const id = bf.id[i];
      const blockC = pal[id % pal.length];
      const bias = hash2(id, 13, 6);
      const dirty = smoothstep(0.55, 0.9, streak[i]) * (1 - joint * 0.4);

      mixRGB(mortar, blockC, joint, _a);
      const tone =
        (0.9 + bias * 0.16 + (face[i] - 0.5) * 0.18 + (grain[i] - 0.5) * 0.05) * (1 - dirty * 0.14) * (0.9 + chamfer * 0.1);
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

      const h = chamfer * 0.65 + face[i] * 0.14 * joint + pit[i] * 0.06 - (1 - joint) * 0.25;
      const rough = clamp(
        0.84 + (face[i] - 0.5) * 0.18 + (1 - joint) * 0.12 + dirty * 0.06 - bias * 0.06,
        0.5,
        0.99,
      );
      const ao = 1 - (1 - joint) * 0.5 - (1 - chamfer) * 0.16 - dirty * 0.08;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 1.05 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, { period: 13.1, strength: 0.6, instUv: 0.8, instTint: 0.07 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /**
   * Lime plaster, deliberately near-white so `stuccoTint()` can pull a dozen
   * pastel houses out of one texture set.
   */
  private buildStucco(size: number): Entry {
    const f = new Fields(size);
    const trowel = fbmField(size, { freq: 7, octaves: 4, seed: 111, warp: 0.09, warpFreq: 4 });
    const fine = fbmField(size, { freq: Math.round(size / 12), octaves: 3, seed: 112 });
    const cracks = voronoiField(size, 8, 8, 0.95, 113, 2);
    const stain = fbmField(size, { freq: 4, octaves: 4, seed: 114, warp: 0.07 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 115, warp: 0.04 });
    const grain = grainField(size, 116);

    const base = rgb(0xf0e9df);
    const dirty = rgb(0xcfc4b2);
    const crackC = rgb(0xb3a897);

    for (let i = 0; i < size * size; i++) {
      const crack =
        smoothstep(0.03, 0.0, cracks.f2[i] - cracks.f1[i]) * smoothstep(0.4, 0.72, stain[i]);
      const grime = smoothstep(0.5, 0.85, stain[i]) * 0.55;
      mixRGB(base, dirty, grime, _a);
      mixRGB(_a, crackC, crack * 0.45, _b);
      const tone = 0.94 + trowel[i] * 0.12 + (fine[i] - 0.5) * 0.06 + (grain[i] - 0.5) * 0.04;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = trowel[i] * 0.3 + fine[i] * 0.18 - crack * 0.28;
      const rough = clamp(0.9 + (fine[i] - 0.5) * 0.14 + (trowel[i] - 0.5) * 0.1 + crack * 0.06, 0.62, 0.99);
      const ao = 1 - crack * 0.22 - (1 - trowel[i]) * 0.08;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.45 });
    const mat = this.std(m, { color: 0xffffff, envMapIntensity: 0.9 });
    injectBreakup(mat, { period: 14.3, strength: 0.55, instUv: 0.9, instTint: 0.10 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Mission barrel tiles: half-round pans running down the slope in overlapping courses. */
  private buildRoofTile(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 5, 2, 0.0, 0.05, 0.008, 121);
    const fine = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 122 });
    const moss = fbmField(size, { freq: 7, octaves: 4, seed: 123, warp: 0.07 });
    const chalk = fbmField(size, { freq: 12, octaves: 3, seed: 124 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 125, warp: 0.04 });
    const grain = grainField(size, 126);

    const pal = [rgb(0xb5643f), rgb(0x9d5236), rgb(0xc9825c), rgb(0xa85a3a), rgb(0xbd7350)];
    const mossC = rgb(0x7f8a58);
    const chalkC = rgb(0xd6c3ae);

    for (let i = 0; i < size * size; i++) {
      const lu = bf.lu[i];
      const lv = bf.lv[i];
      // barrel profile across the tile, flattening at the overlap seams
      const barrel = Math.pow(Math.sin(clamp01(lu) * Math.PI), 0.55);
      // courses overlap: the butt of each pan sits proud of the one below it
      const overlap = smoothstep(0.0, 0.06, lv) * (1 - smoothstep(0.9, 1.0, lv) * 0.55);
      const lip = smoothstep(0.12, 0.02, lv);
      const seam = 1 - smoothstep(0.05, 0.0, Math.min(lu, 1 - lu));
      const id = bf.id[i];
      const tileC = pal[id % pal.length];
      const bias = hash2(id, 17, 8);
      const mossM = smoothstep(0.62, 0.86, moss[i]) * (1 - barrel * 0.55);
      const chalkM = smoothstep(0.68, 0.92, chalk[i]) * barrel;

      mixRGB(tileC, chalkC, chalkM * 0.25, _a);
      mixRGB(_a, mossC, mossM * 0.55, _b);
      const tone = 0.86 + bias * 0.2 + barrel * 0.14 + (fine[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = barrel * 0.72 + overlap * 0.16 + lip * 0.2 + fine[i] * 0.07 - seam * 0.22;
      const rough = clamp(0.78 - chalkM * 0.06 + mossM * 0.14 + (fine[i] - 0.5) * 0.14 - barrel * 0.1, 0.42, 0.98);
      const ao = 1 - (1 - barrel) * 0.42 - (1 - overlap) * 0.35 - mossM * 0.1;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 1.2 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, { period: 11.7, strength: 0.6, instUv: 0.85, instTint: 0.13 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Boat decking, jetty planks, market stalls. `weathered` greys it out and splits the grain. */
  private buildWood(size: number, weathered: boolean): Entry {
    const f = new Fields(size);
    const seed = weathered ? 200 : 130;
    const bf = brickField(size, 5, 1, 0, 0.14, 0.008, seed, false);
    // grain runs along V: low Y frequency, high X frequency
    const grainN = fbmField(size, { freq: 40, octaves: 4, seed: seed + 1, stretchY: 0.12, warp: 0.02 });
    const rings = fbmField(size, { freq: 18, octaves: 3, seed: seed + 2, stretchY: 0.2, mode: 'ridged' });
    const split = fbmField(size, { freq: 30, octaves: 3, seed: seed + 3, stretchY: 0.08, mode: 'ridged' });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: seed + 4 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: seed + 5 });
    const grain = grainField(size, seed + 6);

    const light = rgb(weathered ? 0xa9a094 : 0xb08c5c);
    const dark = rgb(weathered ? 0x6f6a63 : 0x7a5a34);
    const knotC = rgb(weathered ? 0x574f47 : 0x4d3720);

    // a handful of knots per tile, placed deterministically
    const rnd = mulberry32(seed * 31 + 5);
    const knotN = weathered ? 4 : 3;
    const kx = new Float32Array(knotN);
    const ky = new Float32Array(knotN);
    const kr = new Float32Array(knotN);
    for (let k = 0; k < knotN; k++) {
      kx[k] = rnd();
      ky[k] = rnd();
      kr[k] = 0.02 + rnd() * 0.03;
    }

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const joint = smoothstep(0, 0.5, bf.edge[i]);
        const id = bf.id[i];
        const bias = hash2(id, 19, 11);

        let knot = 0;
        let knotRing = 0;
        for (let k = 0; k < knotN; k++) {
          let dx = u - kx[k];
          let dy = v - ky[k];
          dx -= Math.round(dx);
          dy -= Math.round(dy);
          const d = Math.sqrt(dx * dx + dy * dy);
          knot = Math.max(knot, smoothstep(kr[k] * 2.2, kr[k] * 0.5, d));
          knotRing = Math.max(knotRing, smoothstep(kr[k] * 4.5, kr[k], d) * (Math.sin(d * 260) * 0.5 + 0.5));
        }

        const g = grainN[i] * 0.6 + rings[i] * 0.4;
        const splitM = weathered ? smoothstep(0.72, 0.94, split[i]) : 0;
        mixRGB(dark, light, clamp01(g * 1.25 + bias * 0.25), _a);
        mixRGB(_a, knotC, clamp01(knot * 0.85 + knotRing * 0.25), _b);
        // the gap between planks goes almost black — that dark line is most of
        // what makes decking read as boards rather than a printed pattern
        const gapShade = 0.32 + joint * 0.68;
        const tone = (0.9 + bias * 0.16 + (fine[i] - 0.5) * 0.08 + (grain[i] - 0.5) * 0.05) * (1 - splitM * 0.2) * gapShade;
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        const h = joint * 0.5 + g * 0.2 + knot * 0.12 - splitM * 0.35 - (1 - joint) * 0.3;
        const rough = clamp(
          (weathered ? 0.88 : 0.66) + (g - 0.5) * 0.16 + splitM * 0.1 - knot * 0.12 + (fine[i] - 0.5) * 0.1,
          0.35,
          0.98,
        );
        const ao = 1 - (1 - joint) * 0.55 - splitM * 0.15 - knot * 0.08;
        f.surf(i, h, ao, rough);
        f.macro(i, macro[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.9 });
    const mat = this.std(m, { envMapIntensity: 0.8 });
    injectBreakup(mat, { period: 7.3, strength: weathered ? 0.7 : 0.5, instUv: 0.9, instTint: 0.09 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  // =========================================================================
  // Manufactured
  // =========================================================================

  /**
   * Lacquered painted metal — kart bodywork, signs, boat hulls. Near-white
   * albedo so `livery()` tints it; the clearcoat is what makes it read as a
   * toy with real lacquer rather than coloured plastic.
   */
  private buildPaintedMetal(size: number): Entry {
    const f = new Fields(size);
    const peel = fbmField(size, { freq: Math.round(size / 14), octaves: 3, seed: 141 });
    const scratch = fbmField(size, { freq: 60, octaves: 3, seed: 142, stretchY: 0.14, mode: 'ridged' });
    const wear = voronoiField(size, 40, 40, 1.0, 143);
    const dust = fbmField(size, { freq: 5, octaves: 3, seed: 144, warp: 0.05 });
    const macro = fbmField(size, { freq: 3, octaves: 3, seed: 145 });
    const grain = grainField(size, 146);

    const paint = rgb(0xeceded);
    const primer = rgb(0x8b8f95);

    for (let i = 0; i < size * size; i++) {
      const scr = smoothstep(0.86, 0.99, scratch[i]);
      const chip = smoothstep(0.13, 0.05, wear.f1[i]) * (hash2(wear.id[i], 23, 12) > 0.93 ? 1 : 0);
      mixRGB(paint, primer, chip * 0.7, _a);
      const tone = 0.97 + (peel[i] - 0.5) * 0.05 + scr * 0.03 - dust[i] * 0.04 + (grain[i] - 0.5) * 0.02;
      f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

      const h = peel[i] * 0.12 + scr * 0.05 - chip * 0.3;
      const rough = clamp(0.28 + (peel[i] - 0.5) * 0.08 + scr * 0.28 + chip * 0.34 + dust[i] * 0.1, 0.14, 0.85);
      const ao = 1 - chip * 0.25;
      f.surf(i, h, ao, rough, 0);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.35 });
    const mat = this.phys(m, {
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      // The lacquer lobe is only as tight as the environment it samples; at 1.15
      // against a 0.40 scene intensity the second specular lobe never appears and
      // the paint reads as matte plastic.
      envMapIntensity: 1.5,
    });
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  /** Roll bars, exhausts, railings. Spatially varying roughness — polished chrome is never uniform. */
  private buildChrome(size: number): Entry {
    const f = new Fields(size);
    const smudge = fbmField(size, { freq: 6, octaves: 4, seed: 151, warp: 0.08 });
    const brush = fbmField(size, { freq: 70, octaves: 2, seed: 152, stretchY: 0.1 });
    const dent = fbmField(size, { freq: 10, octaves: 3, seed: 153, warp: 0.05 });
    const grain = grainField(size, 154);

    const base = rgb(0xf3f5f8);
    const tarnish = rgb(0xcfd3d8);

    for (let i = 0; i < size * size; i++) {
      const sm = smoothstep(0.45, 0.85, smudge[i]);
      mixRGB(base, tarnish, sm * 0.5, _a);
      f.setRGB(i, _a);
      const h = dent[i] * 0.2 + brush[i] * 0.05;
      const rough = clamp(0.12 + sm * 0.22 + (brush[i] - 0.5) * 0.09 + (dent[i] - 0.5) * 0.05, 0.05, 0.5);
      f.surf(i, h, 1, rough, 1);
      f.macro(i, smudge[i]);
    }

    const m = this.maps(f, { normalStrength: 0.25 });
    // A roughness-0.12 metal is nothing but its reflection. At a scene
    // environmentIntensity of 0.40 an envMapIntensity of 1.6 leaves the roll bar
    // reading as pale blue-grey paint rather than a mirror carrying the horizon.
    const mat = this.std(m, { envMapIntensity: 2.3 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Tyres. Knurled sidewall, moulding flash, and a polished band where it meets the road. */
  private buildRubber(size: number): Entry {
    const f = new Fields(size);
    const scuff = fbmField(size, { freq: 8, octaves: 4, seed: 161, warp: 0.05 });
    const fine = fbmField(size, { freq: Math.round(size / 6), octaves: 2, seed: 162 });
    const grain = grainField(size, 163);

    const base = rgb(0x1e1e22);
    const dusty = rgb(0x3a3a3f);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      // knurl: a fine diamond lattice, the classic moulded sidewall texture
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const ka = Math.abs(((u * 48 + v * 48) % 1) - 0.5) * 2;
        const kb = Math.abs(((u * 48 - v * 48 + 100) % 1) - 0.5) * 2;
        const knurl = smoothstep(0.55, 0.95, Math.min(ka, kb));
        const flash = smoothstep(0.02, 0.0, Math.abs(((v * 2) % 1) - 0.5));
        const dust = smoothstep(0.5, 0.85, scuff[i]);

        mixRGB(base, dusty, dust * 0.4 + fine[i] * 0.08, _a);
        const tone = 0.96 + knurl * 0.045 + (grain[i] - 0.5) * 0.04;
        f.set(i, _a.r * tone, _a.g * tone, _a.b * tone);

        const h = knurl * 0.06 + flash * 0.12 + fine[i] * 0.06;
        const rough = clamp(0.92 - knurl * 0.14 - dust * 0.1 + (fine[i] - 0.5) * 0.12, 0.55, 0.99);
        const ao = 1 - (1 - knurl) * 0.16;
        f.surf(i, h, ao, rough);
        f.macro(i, scuff[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.6 });
    const mat = this.std(m, { envMapIntensity: 0.5 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Windscreens, shop windows, lamp glass. Cheap alpha blend, not transmission — this is a racer. */
  private buildGlass(size: number): Entry {
    const f = new Fields(size);
    const smear = fbmField(size, { freq: 5, octaves: 4, seed: 171, warp: 0.1 });
    const dust = fbmField(size, { freq: 14, octaves: 3, seed: 172 });
    const grain = grainField(size, 173);

    for (let i = 0; i < size * size; i++) {
      const sm = smoothstep(0.55, 0.9, smear[i]);
      const d = 250 - sm * 14 - dust[i] * 8;
      f.set(i, d, d + 3, d + 6);
      const h = smear[i] * 0.08;
      const rough = clamp(0.04 + sm * 0.13 + dust[i] * 0.05 + (grain[i] - 0.5) * 0.01, 0.02, 0.3);
      f.surf(i, h, 1, rough, 0);
      f.macro(i, smear[i]);
    }

    const m = this.maps(f, { normalStrength: 0.12 });
    const mat = this.phys(m, {
      metalness: 0,
      color: 0xd9ecf5,
      transparent: true,
      opacity: 0.34,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 2.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  /** Striped awning canvas over the harbour shops. Woven, sun-faded, tintable. */
  private buildAwning(size: number): Entry {
    const f = new Fields(size);
    const sag = fbmField(size, { freq: 6, octaves: 3, seed: 181, stretchY: 0.3 });
    const fade = fbmField(size, { freq: 4, octaves: 3, seed: 182, warp: 0.05 });
    const grain = grainField(size, 183);

    const light = rgb(0xf2ece0);
    const tintable = rgb(0xb2b2b2); // multiplied by variant colour
    const threads = 96;

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const stripe = Math.floor(v * 6) % 2 === 0;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // plain weave: which thread is on top alternates on both axes
        const tu = u * threads;
        const tv = v * threads;
        const over = (Math.floor(tu) + Math.floor(tv)) % 2 === 0;
        const wu = Math.abs((tu % 1) - 0.5) * 2;
        const wv = Math.abs((tv % 1) - 0.5) * 2;
        const thread = over ? 1 - wu : 1 - wv;

        const c = stripe ? light : tintable;
        const faded = 0.9 + fade[i] * 0.18 + sag[i] * 0.06 + (grain[i] - 0.5) * 0.05;
        const shade = 0.88 + thread * 0.16;
        f.set(i, c.r * faded * shade, c.g * faded * shade, c.b * faded * shade);

        const h = thread * 0.4 + sag[i] * 0.25;
        const rough = clamp(0.88 - thread * 0.08 + (fade[i] - 0.5) * 0.12, 0.6, 0.99);
        const ao = 1 - (1 - thread) * 0.3;
        f.surf(i, h, ao, rough);
        f.macro(i, fade[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.9 });
    const mat = this.std(m, { side: THREE.DoubleSide, envMapIntensity: 0.7 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Poured concrete: harbour walls, tunnel lining, jetty. */
  private buildConcrete(size: number): Entry {
    const f = new Fields(size);
    const agg = voronoiField(size, 30, 30, 1.0, 191);
    const bubble = voronoiField(size, 60, 60, 1.0, 192);
    const stain = fbmField(size, { freq: 5, octaves: 4, seed: 193, warp: 0.07 });
    const streak = fbmField(size, { freq: 10, octaves: 3, seed: 194, stretchY: 0.14 });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 195 });
    const macro = fbmField(size, { freq: 2, octaves: 3, seed: 196, warp: 0.04 });
    const grain = grainField(size, 197);

    const base = rgb(0x9d9a94);
    const pale = rgb(0xb6b2aa);
    const dirty = rgb(0x736f68);

    for (let i = 0; i < size * size; i++) {
      const speck = smoothstep(0.2, 0.08, agg.f1[i]) * (hash2(agg.id[i], 29, 14) > 0.7 ? 1 : 0);
      const pit = smoothstep(0.1, 0.03, bubble.f1[i]) * (hash2(bubble.id[i], 31, 15) > 0.78 ? 1 : 0);
      const grime = smoothstep(0.55, 0.9, stain[i]) * 0.34 + smoothstep(0.7, 0.95, streak[i]) * 0.16;

      mixRGB(base, pale, speck * 0.5 + fine[i] * 0.2, _a);
      mixRGB(_a, dirty, clamp01(grime), _b);
      const tone = 0.93 + (fine[i] - 0.5) * 0.1 + (grain[i] - 0.5) * 0.05 - pit * 0.35;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = fine[i] * 0.15 + speck * 0.1 - pit * 0.6;
      const rough = clamp(0.82 + (fine[i] - 0.5) * 0.16 + pit * 0.12 + grime * 0.06 - speck * 0.06, 0.5, 0.98);
      const ao = 1 - pit * 0.55 - grime * 0.1;
      f.surf(i, h, ao, rough);
      f.macro(i, macro[i]);
    }

    const m = this.maps(f, { normalStrength: 0.7 });
    const mat = this.std(m, { envMapIntensity: 0.85 });
    injectBreakup(mat, { period: 17.1, strength: 0.65, instUv: 0.6, instTint: 0.05 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Polished marble for the plaza, fountain and bridge caps. Veins by domain-warped ridges. */
  private buildMarble(size: number): Entry {
    const f = new Fields(size);
    const vein = fbmField(size, { freq: 3, octaves: 5, seed: 201, mode: 'ridged', warp: 0.16, warpFreq: 2 });
    const vein2 = fbmField(size, { freq: 6, octaves: 4, seed: 202, mode: 'ridged', warp: 0.12, warpFreq: 3 });
    const cloud = fbmField(size, { freq: 4, octaves: 4, seed: 203, warp: 0.08 });
    const polish = fbmField(size, { freq: 7, octaves: 3, seed: 204, warp: 0.05 });
    const grain = grainField(size, 205);

    const base = rgb(0xf1eee8);
    const grey = rgb(0x8a8d94);
    const gold = rgb(0xb99a63);
    const veinCore = rgb(0x5a5f68);

    for (let i = 0; i < size * size; i++) {
      const v1 = smoothstep(0.70, 0.94, vein[i]);
      const v2 = smoothstep(0.78, 0.98, vein2[i]);
      const core = smoothstep(0.88, 0.99, vein[i]);
      mixRGB(base, grey, v1 * 0.9, _a);
      mixRGB(_a, gold, v2 * 0.55, _b);
      mixRGB(_b, veinCore, core * 0.6, _b);
      const tone = 0.95 + cloud[i] * 0.09 + (grain[i] - 0.5) * 0.02;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      // veins are slightly softer stone, so they polish differently — that
      // roughness break is what sells marble over "grey noise"
      const h = v1 * 0.1 + v2 * 0.06 + cloud[i] * 0.04;
      const rough = clamp(0.16 + v1 * 0.14 + v2 * 0.1 + (polish[i] - 0.5) * 0.14, 0.06, 0.55);
      f.surf(i, h, 1 - v1 * 0.08, rough);
      f.macro(i, cloud[i]);
    }

    const m = this.maps(f, { normalStrength: 0.3 });
    const mat = this.phys(m, {
      metalness: 0,
      clearcoat: 0.65,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.1,
    });
    injectBreakup(mat, { period: 11.3, strength: 0.45, instUv: 0.7, instTint: 0.06 });
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  // =========================================================================
  // Emissive
  // =========================================================================

  /** Boost strip: dark tread plate under animated cyan chevrons that flow forward in +V. */
  private buildBoostPad(size: number): Entry {
    const f = new Fields(size);
    const emissive = new Uint8ClampedArray(size * size * 4);
    const tread = fbmField(size, { freq: Math.round(size / 10), octaves: 2, seed: 211 });
    const wear = fbmField(size, { freq: 6, octaves: 3, seed: 212, warp: 0.05 });
    const rivet = voronoiField(size, 8, 8, 0.2, 213);
    const grain = grainField(size, 214);

    const plate = rgb(0x2b3140);
    const plateWorn = rgb(0x424a5b);
    const glow = rgb(0x4fc3ff);
    const glowHot = rgb(0xdcf4ff);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        // four chevrons per tile, apex leading
        const chev = ((v * 4 - Math.abs(u - 0.5) * 1.15) % 1 + 1) % 1;
        const band = smoothstep(0.06, 0.16, chev) * (1 - smoothstep(0.5, 0.62, chev));
        const core = smoothstep(0.12, 0.24, chev) * (1 - smoothstep(0.4, 0.52, chev));
        const margin = smoothstep(0.06, 0.02, Math.min(u, 1 - u));
        const chevron = clamp01(band * (1 - margin));
        const riv = smoothstep(0.16, 0.08, rivet.f1[i]) * margin;

        mixRGB(plate, plateWorn, wear[i] * 0.7, _a);
        mixRGB(_a, glow, chevron * 0.55, _b);
        const tone = 0.92 + tread[i] * 0.14 + (grain[i] - 0.5) * 0.05 + riv * 0.2;
        f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

        mixRGB(glow, glowHot, core * 0.8, _c);
        const k = i * 4;
        const e = chevron;
        emissive[k] = _c.r * e;
        emissive[k + 1] = _c.g * e;
        emissive[k + 2] = _c.b * e;
        emissive[k + 3] = 255;

        const h = tread[i] * 0.14 + riv * 0.5 - chevron * 0.12;
        const rough = clamp(0.5 - chevron * 0.26 + (tread[i] - 0.5) * 0.18 - wear[i] * 0.08, 0.1, 0.9);
        f.surf(i, h, 1 - riv * 0.15, rough, 0.15 + riv * 0.4);
        f.macro(i, wear[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const emissiveMap = new THREE.CanvasTexture(this.bytesCanvas(size, emissive));
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
    emissiveMap.anisotropy = this.aniso;
    emissiveMap.needsUpdate = true;

    const mat = this.std(m, {
      emissive: 0xffffff,
      emissiveMap,
      emissiveIntensity: 1.15,
      envMapIntensity: 1.0,
    });
    this.boostEmissive = emissiveMap;
    this.boostMat = mat;
    this.envConsumers.push(mat);
    return { mat, textures: [...m.all, emissiveMap] };
  }

  /** Tunnel sodium strips and shop neon: a frosted tube with a hot core. */
  private buildLightStrip(size: number, hex: number, intensity: number): Entry {
    const f = new Fields(size);
    const emissive = new Uint8ClampedArray(size * size * 4);
    const frost = fbmField(size, { freq: 18, octaves: 3, seed: 221 });
    const dust = fbmField(size, { freq: 6, octaves: 3, seed: 222, warp: 0.05 });

    const c = rgb(hex);
    const hot = rgb(0xfff6e8);

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      // tube cross-section runs across V: hot in the middle, falling off to the ends
      const prof = Math.pow(Math.sin(clamp01(v) * Math.PI), 0.5);
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const grime = 1 - dust[i] * 0.25;
        mixRGB(c, hot, prof * 0.55, _a);
        const e = prof * grime * (0.85 + frost[i] * 0.3);
        f.set(i, lerp(60, _a.r, e * 0.7), lerp(60, _a.g, e * 0.7), lerp(62, _a.b, e * 0.7));
        const k = i * 4;
        emissive[k] = _a.r * e;
        emissive[k + 1] = _a.g * e;
        emissive[k + 2] = _a.b * e;
        emissive[k + 3] = 255;
        f.surf(i, frost[i] * 0.15, 1, clamp(0.28 + frost[i] * 0.3 + dust[i] * 0.1, 0.1, 0.8), 0);
        f.macro(i, dust[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.3 });
    const emissiveMap = new THREE.CanvasTexture(this.bytesCanvas(size, emissive));
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
    emissiveMap.needsUpdate = true;

    const mat = this.std(m, {
      emissive: 0xffffff,
      emissiveMap,
      emissiveIntensity: intensity,
      envMapIntensity: 0.4,
    });
    if (hex === 0x4fc3ff) this.neonMat = mat;
    return { mat, textures: [...m.all, emissiveMap] };
  }

  // =========================================================================
  // Water
  // =========================================================================

  /**
   * The bay. Two scrolling octaves of the same wave normal, a view-dependent
   * shallow→deep colour ramp and a hard clearcoat so the sun clips to white and
   * blooms — which the bible calls out as *the* look.
   */
  private buildWater(size: number): Entry {
    const f = new Fields(size);
    const w1 = fbmField(size, { freq: 6, octaves: 4, seed: 231, warp: 0.05 });
    const w2 = fbmField(size, { freq: 14, octaves: 3, seed: 232, stretchY: 0.6 });
    const wind = fbmField(size, { freq: 3, octaves: 3, seed: 233, warp: 0.08 });

    // The albedo stays near-white: the shallow→deep colour is supplied by the
    // shader ramp below, so the same texture works at any water depth.
    for (let i = 0; i < size * size; i++) {
      const h = w1[i] * 0.7 + w2[i] * 0.3;
      const t = 226 + h * 26;
      f.set(i, t, t + 4, t + 6);
      // wind streaks ruffle the surface: the roughness variation is what makes
      // the specular sheet break up into a plausible glitter path
      const rough = clamp(0.045 + wind[i] * 0.1 + (w2[i] - 0.5) * 0.04, 0.02, 0.2);
      f.surf(i, h, 1, rough, 0);
      f.macro(i, wind[i]);
    }

    // A near-flat mirror at a 14° grazing angle reflects the sky at ~100% Fresnel
    // everywhere, which is why the bay came out sitting in the same value band as
    // the sky above it with no horizon at all. Chop is what breaks that: facets
    // have to tip far enough for the troughs to show the water body and the crests
    // to catch the sun. 0.95 was nowhere near enough tilt to do it.
    const m = this.maps(f, { normalStrength: 2.4 });
    const uTime = { value: 0 };
    const uShallow = { value: new THREE.Color(0x3fc9c4) };
    const uDeep = { value: new THREE.Color(0x0d5a7a) };
    const mat = this.phys(m, {
      color: 0xffffff,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.8,
      normalScale: new THREE.Vector2(0.85, 0.85),
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.uniforms.uShallow = uShallow;
      shader.uniforms.uDeep = uDeep;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + WORLD_PARS)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WORLD_VERTEX);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\n' +
            WORLD_PARS +
            'uniform float uTime;\nuniform vec3 uShallow;\nuniform vec3 uDeep;\n',
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          #include <map_fragment>
          // Depth ramp. Grazing angles look through more water, so they show the
          // deep body; looking down into it shows the shallow colour. Driven by
          // the *flat* plane normal so the ramp reads as depth and not as chop.
          #ifndef FLAT_SHADED
            float wFacing = pow( clamp( dot( normalize( vViewPosition ), normalize( vNormal ) ), 0.0, 1.0 ), 0.55 );
            // near water is measurably darker than the horizon band: without this
            // the bay sits in the sky's value range and there is no horizon line
            float wNear = 1.0 - smoothstep( 12.0, 260.0, vViewDist );
            diffuseColor.rgb *= mix( uDeep, uShallow, wFacing ) * ( 1.0 - wNear * 0.45 );
          #endif`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            // Two octaves at non-matching scales AND non-matching speeds, so the
            // interference pattern never settles into a visible tile.
            vec2 wUv1 = vNormalMapUv + vec2( uTime * 0.0125, uTime * 0.0205 );
            vec2 wUv2 = vNormalMapUv * 2.37 - vec2( uTime * 0.0185, uTime * 0.0095 );
            vec3 wN1 = texture2D( normalMap, wUv1 ).xyz * 2.0 - 1.0;
            vec3 wN2 = texture2D( normalMap, wUv2 ).xyz * 2.0 - 1.0;
            vec3 mapN = normalize( vec3( wN1.xy + wN2.xy, wN1.z * wN2.z ) );
            // Chop has to fall off toward the horizon or the far bay aliases into
            // a crawling band; near water keeps its full tilt so the troughs read.
            mapN.xy *= normalScale * ( 1.0 - smoothstep( 90.0, 700.0, vViewDist ) * 0.82 );
            normal = normalize( tbn * mapN );
          #endif`,
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          #if ( NUM_DIR_LIGHTS > 0 )
            // The sun path. At 14° elevation the specular lobe from the key must
            // lay a broad shimmering track across the bay toward camera, clipping
            // well above 1.0 so bloom picks it up — §2 of the bible calls that
            // clip the look, and it is the single highest-value pixel in the shot.
            vec3 wV = normalize( vViewPosition );
            vec3 wH = normalize( wV + directionalLights[ 0 ].direction );
            float wSpec = pow( max( 0.0, dot( normal, wH ) ), 900.0 ) * 26.0
                        + pow( max( 0.0, dot( normal, wH ) ), 90.0 ) * 1.6;
            reflectedLight.directSpecular += directionalLights[ 0 ].color * wSpec;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'water2';
    this.waterTime = uTime;
    this.envConsumers.push(mat as unknown as THREE.MeshStandardMaterial);
    return { mat, textures: m.all };
  }

  // =========================================================================
  // Drawn cards (canvas path work, then modulated per texel)
  // =========================================================================

  /** Palm trunk: overlapping diamond leaf-scars and vertical fibre. */
  private buildPalmBark(size: number): Entry {
    const f = new Fields(size);
    const bf = brickField(size, 6, 13, 0.5, 0.1, 0.02, 241);
    const fibre = fbmField(size, { freq: 46, octaves: 3, seed: 242, stretchY: 0.1 });
    const rot = fbmField(size, { freq: 6, octaves: 3, seed: 243, warp: 0.06 });
    const fine = fbmField(size, { freq: Math.round(size / 8), octaves: 2, seed: 244 });
    const grain = grainField(size, 245);

    const bark = rgb(0x8a7359);
    const darkC = rgb(0x5d4c3b);
    const paleC = rgb(0xa8927a);

    for (let i = 0; i < size * size; i++) {
      const lu = bf.lu[i];
      const lv = bf.lv[i];
      // diamond scar: a chamfered lozenge inside each lattice cell
      const d = Math.abs(lu - 0.5) + Math.abs(lv - 0.5);
      const scar = smoothstep(0.5, 0.24, d);
      const rim = smoothstep(0.5, 0.42, d) * (1 - smoothstep(0.42, 0.3, d));
      const id = bf.id[i];
      const bias = hash2(id, 37, 21);
      const decay = smoothstep(0.55, 0.85, rot[i]);

      mixRGB(darkC, bark, clamp01(scar * 0.8 + fibre[i] * 0.5), _a);
      mixRGB(_a, paleC, rim * 0.5 + bias * 0.2, _b);
      const tone = 0.88 + bias * 0.16 + (fine[i] - 0.5) * 0.12 + (grain[i] - 0.5) * 0.05 - decay * 0.12;
      f.set(i, _b.r * tone, _b.g * tone, _b.b * tone);

      const h = scar * 0.55 + rim * 0.25 + fibre[i] * 0.16 - (1 - scar) * 0.2;
      const rough = clamp(0.9 + (fine[i] - 0.5) * 0.14 - rim * 0.1 + decay * 0.05, 0.6, 0.99);
      const ao = 1 - (1 - scar) * 0.4 - decay * 0.1;
      f.surf(i, h, ao, rough);
      f.macro(i, rot[i]);
    }

    const m = this.maps(f, { normalStrength: 1.15 });
    const mat = this.std(m, { envMapIntensity: 0.7 });
    injectBreakup(mat, { period: 3.7, strength: 0.5, instUv: 0.95, instTint: 0.11 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /**
   * Alpha-tested foliage card. `frond` swaps the bushy leaf cluster for a long
   * pinnate palm leaf. Both get wrap lighting so the low sun blows through them.
   */
  private buildLeafCard(size: number, frond: boolean): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.clearRect(0, 0, size, size);
    const rnd = mulberry32(frond ? 313 : 271);

    const drawLeaf = (
      cx: number,
      cy: number,
      len: number,
      wid: number,
      ang: number,
      fill: string,
      vein: string,
    ) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(wid, len * 0.45, 0, len);
      g.quadraticCurveTo(-wid, len * 0.45, 0, 0);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = vein;
      g.lineWidth = Math.max(1, size / 340);
      g.beginPath();
      g.moveTo(0, len * 0.02);
      g.lineTo(0, len * 0.97);
      g.stroke();
      for (let k = 1; k < 7; k++) {
        const t = k / 7;
        const w = wid * 0.85 * Math.sin(t * Math.PI);
        g.beginPath();
        g.moveTo(0, len * t);
        g.lineTo(w, len * (t + 0.11));
        g.moveTo(0, len * t);
        g.lineTo(-w, len * (t + 0.11));
        g.stroke();
      }
      g.restore();
    };

    if (frond) {
      // one long pinnate frond filling the card, leaflets down a curved rachis
      const baseX = size * 0.5;
      g.save();
      g.strokeStyle = '#6d7f3a';
      g.lineWidth = size / 90;
      g.beginPath();
      g.moveTo(baseX, size * 0.99);
      g.quadraticCurveTo(baseX + size * 0.12, size * 0.45, baseX + size * 0.06, size * 0.03);
      g.stroke();
      g.restore();
      for (let k = 0; k < 34; k++) {
        const t = 0.04 + (k / 34) * 0.92;
        const x = baseX + size * 0.12 * (t * t) * 1.1;
        const y = size * (1 - t);
        const len = size * 0.34 * Math.sin(t * Math.PI) ** 0.6;
        const shade = 0.72 + rnd() * 0.35;
        const col = `rgb(${(96 * shade) | 0},${(148 * shade) | 0},${(58 * shade) | 0})`;
        drawLeaf(x, y, len, len * 0.1, Math.PI * 0.5 + 0.55 + rnd() * 0.12, col, 'rgba(40,70,26,0.5)');
        drawLeaf(x, y, len, len * 0.1, Math.PI * 0.5 - 0.55 - rnd() * 0.12 + Math.PI, col, 'rgba(40,70,26,0.5)');
      }
    } else {
      // a bushy cluster that reads as a hedge/olive canopy at any distance
      for (let k = 0; k < 130; k++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.pow(rnd(), 0.62) * size * 0.44;
        const x = size * 0.5 + Math.cos(a) * r;
        const y = size * 0.52 + Math.sin(a) * r * 0.92;
        const len = size * (0.14 + rnd() * 0.15);
        const shade = 0.6 + rnd() * 0.55 + (1 - r / (size * 0.5)) * 0.12;
        const warm = rnd() > 0.82;
        const col = warm
          ? `rgb(${(150 * shade) | 0},${(160 * shade) | 0},${(66 * shade) | 0})`
          : `rgb(${(88 * shade) | 0},${(140 * shade) | 0},${(56 * shade) | 0})`;
        drawLeaf(x, y, len, len * 0.3, rnd() * Math.PI * 2, col, 'rgba(38,66,26,0.45)');
      }
    }

    const f = new Fields(size);
    const px = readPixels(c);
    f.albedo.set(px);
    const alpha = alphaFrom(px);
    // a blurred alpha makes a believable rounded leaf body for the normal map
    const puff = blurField(alpha, size, Math.max(2, size >> 7));
    const micro = fbmField(size, { freq: Math.round(size / 12), octaves: 3, seed: 251 });
    const dry = fbmField(size, { freq: 5, octaves: 3, seed: 252, warp: 0.06 });

    for (let i = 0; i < size * size; i++) {
      const k = i * 4;
      const a = alpha[i];
      const tone = 0.9 + micro[i] * 0.2 + dry[i] * 0.1;
      f.albedo[k] = f.albedo[k] * tone;
      f.albedo[k + 1] = f.albedo[k + 1] * tone;
      f.albedo[k + 2] = f.albedo[k + 2] * tone * (1 - dry[i] * 0.1);
      const rough = clamp(0.66 + (micro[i] - 0.5) * 0.2 + dry[i] * 0.1, 0.4, 0.95);
      f.surf(i, puff[i] * 0.7 + micro[i] * 0.08 * a, 1 - (1 - puff[i]) * 0.25, rough);
      f.macro(i, dry[i]);
    }

    const m = this.maps(f, { normalStrength: 1.0, wrap: THREE.ClampToEdgeWrapping });
    const mat = this.std(m, {
      transparent: false,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      envMapIntensity: 0.6,
      // leaf cards are thin: shadow acne here would look like dirt on the leaf
      shadowSide: THREE.DoubleSide,
    });
    injectFoliageSSS(mat, new THREE.Color(0.55, 0.85, 0.32), 1.0);
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** 4×2 atlas of stylised spectators for instanced grandstand billboards. */
  private buildCrowd(size: number): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.clearRect(0, 0, size, size);
    const cols = this.crowdAtlas.cols;
    const rows = this.crowdAtlas.rows;
    const cw = size / cols;
    const ch = size / rows;
    const rnd = mulberry32(4711);

    const shirts = [0xe0453f, 0x4fc3ff, 0xf5e2b0, 0x6f9b47, 0xdcb8d8, 0xff9d2e, 0xf2ece0, 0xa9c8d4];
    const skins = [0xf0c9a2, 0xd6a074, 0xa9744c, 0x7a4f30, 0xf7dcc0];

    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col;
        const ox = col * cw;
        const oy = r * ch;
        const shirt = shirts[i % shirts.length];
        const skin = skins[(i * 3 + 1) % skins.length];
        const arms = i % 3 === 0; // a third of the crowd has their arms up
        const hex = (v: number) => `#${v.toString(16).padStart(6, '0')}`;

        const bx = ox + cw * 0.5;
        const bw = cw * 0.34;
        const headR = cw * 0.115;
        const shoulderY = oy + ch * 0.42;

        g.save();
        // hard clip: a waving flag must not spill into the neighbouring cell
        g.beginPath();
        g.rect(ox, oy, cw, ch);
        g.clip();
        // torso
        g.fillStyle = hex(shirt);
        g.beginPath();
        g.moveTo(bx - bw * 0.5, oy + ch * 0.98);
        g.lineTo(bx - bw * 0.56, shoulderY + ch * 0.04);
        g.quadraticCurveTo(bx, shoulderY - ch * 0.06, bx + bw * 0.56, shoulderY + ch * 0.04);
        g.lineTo(bx + bw * 0.5, oy + ch * 0.98);
        g.closePath();
        g.fill();
        // arms
        g.strokeStyle = hex(skin);
        g.lineCap = 'round';
        g.lineWidth = cw * 0.085;
        g.beginPath();
        if (arms) {
          g.moveTo(bx - bw * 0.5, shoulderY + ch * 0.06);
          g.lineTo(bx - bw * 0.85, oy + ch * 0.16);
          g.moveTo(bx + bw * 0.5, shoulderY + ch * 0.06);
          g.lineTo(bx + bw * 0.85, oy + ch * 0.16);
        } else {
          g.moveTo(bx - bw * 0.52, shoulderY + ch * 0.08);
          g.lineTo(bx - bw * 0.72, oy + ch * 0.8);
          g.moveTo(bx + bw * 0.52, shoulderY + ch * 0.08);
          g.lineTo(bx + bw * 0.72, oy + ch * 0.8);
        }
        g.stroke();
        // head + hair/cap
        g.fillStyle = hex(skin);
        g.beginPath();
        g.arc(bx, shoulderY - headR * 1.05, headR, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = i % 2 ? hex(shirts[(i + 3) % shirts.length]) : '#3a2f28';
        g.beginPath();
        g.arc(bx, shoulderY - headR * 1.2, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95);
        g.fill();
        // a few waving flags for silhouette interest
        if (i % 4 === 1) {
          g.fillStyle = hex(shirts[(i + 5) % shirts.length]);
          g.beginPath();
          g.moveTo(bx + bw * 0.85, oy + ch * 0.16);
          g.lineTo(bx + bw * 1.5, oy + ch * 0.06);
          g.lineTo(bx + bw * 1.45, oy + ch * 0.3);
          g.closePath();
          g.fill();
        }
        g.restore();
        rnd();
      }
    }

    const f = new Fields(size);
    const px = readPixels(c);
    f.albedo.set(px);
    const alpha = alphaFrom(px);
    const puff = blurField(alpha, size, Math.max(2, size >> 6));
    const cloth = fbmField(size, { freq: Math.round(size / 14), octaves: 3, seed: 261 });

    for (let i = 0; i < size * size; i++) {
      const k = i * 4;
      const tone = 0.9 + cloth[i] * 0.2;
      f.albedo[k] *= tone;
      f.albedo[k + 1] *= tone;
      f.albedo[k + 2] *= tone;
      f.surf(i, puff[i] * 0.8, 1 - (1 - puff[i]) * 0.3, clamp(0.82 + (cloth[i] - 0.5) * 0.16, 0.6, 0.96));
      f.macro(i, cloth[i]);
    }

    const m = this.maps(f, { normalStrength: 0.8, wrap: THREE.ClampToEdgeWrapping });
    const mat = this.std(m, {
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      envMapIntensity: 0.55,
    });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  /** Start/finish arch and sponsor banners: printed cloth with a real weave. */
  private buildBanner(size: number): Entry {
    const c = createCanvas(size);
    const g = c.ctx;
    g.fillStyle = '#f2ece0';
    g.fillRect(0, 0, size, size);

    // horizontal colour bands
    const bands = ['#e0453f', '#f5e2b0', '#4fc3ff', '#f2ece0'];
    for (let i = 0; i < 4; i++) {
      g.fillStyle = bands[i];
      g.fillRect(0, (size * i) / 4, size, size / 4);
    }
    // chevron ribbon through the middle
    // chevron ribbons sit above and below the wordmark, never across it
    g.save();
    g.fillStyle = '#1d2a33';
    for (const [top, bot] of [[0.30, 0.355], [0.645, 0.70]] as const) {
      g.beginPath();
      for (let k = 0; k <= 10; k++) g.lineTo((size * k) / 10, size * (k % 2 ? top : top + 0.028));
      for (let k = 10; k >= 0; k--) g.lineTo((size * k) / 10, size * (k % 2 ? bot : bot + 0.028));
      g.closePath();
      g.fill();
    }
    g.restore();
    // printed wordmark — a system font stack, no webfont to load
    g.save();
    g.fillStyle = '#1d2a33';
    g.font = `800 ${Math.round(size * 0.105)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.translate(size * 0.5, size * 0.5);
    g.fillText('SUNSET  BAY', 0, 0);
    g.restore();
    g.save();
    g.fillStyle = '#1d2a33';
    g.font = `700 ${Math.round(size * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('GRAND PRIX', size * 0.5, size * 0.155);
    g.fillText('CIRCUIT 01', size * 0.5, size * 0.845);
    g.restore();

    const f = new Fields(size);
    f.albedo.set(readPixels(c));
    const fold = fbmField(size, { freq: 5, octaves: 3, seed: 271, stretchY: 0.25 });
    const fade = fbmField(size, { freq: 3, octaves: 3, seed: 272, warp: 0.05 });
    const threads = 110;

    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = (x + 0.5) / size;
        const tu = u * threads;
        const tv = v * threads;
        const over = (Math.floor(tu) + Math.floor(tv)) % 2 === 0;
        const thread = over ? 1 - Math.abs((tu % 1) - 0.5) * 2 : 1 - Math.abs((tv % 1) - 0.5) * 2;
        const shade = (0.86 + thread * 0.18) * (0.92 + fold[i] * 0.16) * (0.94 + fade[i] * 0.1);
        const k = i * 4;
        f.albedo[k] *= shade;
        f.albedo[k + 1] *= shade;
        f.albedo[k + 2] *= shade;
        f.albedo[k + 3] = 255;
        const rough = clamp(0.86 - thread * 0.08 + (fade[i] - 0.5) * 0.12, 0.6, 0.98);
        f.surf(i, thread * 0.35 + fold[i] * 0.4, 1 - (1 - thread) * 0.22, rough);
        f.macro(i, fade[i]);
      }
    }

    const m = this.maps(f, { normalStrength: 0.8 });
    const mat = this.std(m, { side: THREE.DoubleSide, envMapIntensity: 0.65 });
    this.envConsumers.push(mat);
    return { mat, textures: m.all };
  }

  // -- small helpers -------------------------------------------------------

  private bytesCanvas(size: number, bytes: Uint8ClampedArray): HTMLCanvasElement {
    const c: Canvas2D = createCanvas(size);
    c.ctx.putImageData(toImageData(bytes, size), 0, 0);
    return c.canvas as HTMLCanvasElement;
  }
}

/**
 * The shared instance. `main.ts` constructs `Materials` itself and the context
 * has no slot for it, so this is how the other visual systems reach the same
 * cache instead of each building their own copy of every texture.
 */
export function getMaterials(): Materials {
  return active ?? new Materials();
}
