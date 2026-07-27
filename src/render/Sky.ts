/**
 * ============================================================================
 *  Sky — atmosphere, key light, cascaded shadows, fog and the PBR environment.
 * ============================================================================
 *  Art bible §2 is the spec. Everything downstream keys off what this file
 *  decides, so a few of the choices here deserve stating up front:
 *
 *  · The dome is drawn as an infinite skybox (translation stripped, depth
 *    forced to the far plane), so it never needs to track the camera or be
 *    scaled against the far clip, and it never writes depth.
 *
 *  · The PBR environment is generated FROM that same shader, through a cube
 *    render and PMREM, once. Every metal and every clearcoat in the game is
 *    therefore reflecting the exact sky the player can see.
 *
 *  · Aerial perspective is a height-attenuated Beer fog, not FogExp2 — a
 *    ShaderChunk override installed from here replaces three's exp2 term. Three
 *    things matter: it layers instead of walling (exp2 is transparent up close
 *    then slams shut); density falls off with the eye's altitude, so the bay
 *    hazes and the cliff traverse looks out over it; and the factor is clamped
 *    short of 1, so every distant element keeps a slice of its own albedo and
 *    the backdrop stays a stack of silhouettes rather than one plate. The fog
 *    colour is the model's own horizon radiance with a highlight rolloff, NOT
 *    the raw superwhite the dome uses — feeding an above-display-white constant
 *    into fog is what pushed everything past 60 m over the ACES knee.
 *
 *  · Environment intensity is 1.0, i.e. materials get the envMapIntensity they
 *    were authored with, so chrome and clearcoat actually mirror the sky. The
 *    DIFFUSE half of the IBL is scaled down separately (another chunk override)
 *    because that is the term that flattens key/fill, and it is the only reason
 *    the old code had to hold the whole environment down to 0.40.
 *
 *  · Shadows are two cascades built from two directional lights sharing the
 *    sun's direction and splitting its energy. Every point in the near frustum
 *    is also inside the far one, so near shadows composite to full darkness.
 *    Outside the near frustum only the far map is testing, so the near cascade's
 *    share leaks as light: the split is weighted hard toward the near map and
 *    every cascade fades its own shadow out across its border, so the handoff is
 *    a soft 8 m ramp instead of a straight-edged rectangle painted on the road.
 *    Both frusta are texel-snapped in light space: without that, shadow edges
 *    crawl as the kart moves and the whole frame looks cheap.
 * ============================================================================
 */
import * as THREE from 'three';
import { Quality, type Ctx, type System } from '../types';
import {
  AtmosphereModel,
  GROUND_BOUNCE_COLOR,
  SKY_FRAGMENT_SHADER,
  SKY_VERTEX_SHADER,
  SUN_DIRECTION,
  SUN_LIGHT_COLOR,
} from './Atmosphere';

// --- tuning ------------------------------------------------------------------

/** Art bible §2: sun intensity ~4.2, physical-ish, tone mapped. */
const SUN_INTENSITY = 4.2;
/**
 * `scene.environmentIntensity`, i.e. the multiplier on every material's
 * authored envMapIntensity. This is 1.0 and must stay 1.0: at 0.40 the kart's
 * chrome (authored 1.6) reflected the sky at 0.64 and the clearcoat (1.15) at
 * 0.46, which is why no metal in the game showed a horizon line, a sun blob or
 * a warm/cool split — they read as painted trim. The reason 0.40 looked
 * necessary is DIFFUSE_ENV_INTENSITY below; that is the term that was flooding
 * the scene, and it is now scaled on its own.
 */
const ENV_INTENSITY = 1.0;
/**
 * Diffuse-only scale on the IBL, applied by patching getIBLIrradiance. Specular
 * reflection and diffuse skylight are physically the same environment but they
 * play completely different roles here: the reflection is what sells metal, the
 * irradiance is pure non-directional fill and every unit of it eats the key/fill
 * separation. Measured on a matte grey sphere (lit pole / terminator / dark
 * pole, linear luminance) this lands at 1.00 / 0.113 / 0.117 against the ~1.00 /
 * 0.25 / 0.12 a golden-hour reference gives.
 */
const DIFFUSE_ENV_INTENSITY = 0.30;
/** SH ambient on top of the env map — energy compensation for the bounces
 *  single-scattering IBL cannot see, and the only ambient that reaches
 *  materials which ignore environment maps. Deliberately small. */
const PROBE_INTENSITY = 0.10;
/** Warm bounce off the sand and stone, art bible §2. Lights undersides only. */
const BOUNCE_INTENSITY = 0.30;

// --- aerial perspective ------------------------------------------------------
// Replaces FogExp2. The old single exp2 term at density 0.0019 reached 44% at
// 400 m and 95% at 900 m, so the backdrop headlands were being built and then
// erased, and everything past ~60 m converged on one cream value. Split into a
// sea-level layer that thins with the eye's altitude plus a thin global term,
// the near-road contact haze is actually STRONGER than before (3% at 30 m
// against 0.3%) while the three backdrop layers land at 60% / 78% / 88% from
// the harbour instead of 95% / 100% / 100%, and at 45% / 64% / 76% from the
// cliff apex — three plates at descending contrast, which is the whole point.

/** Density of the low layer, per metre, with the eye at FOG_SEA_LEVEL. */
const FOG_SEA_DENSITY = 0.00075;
/** Scale height of that layer, metres. Density halves every ~42 m of altitude. */
const FOG_HEIGHT_SCALE = 60;
/** Altitude the sea-level density is quoted at. */
const FOG_SEA_LEVEL = 0;
/** Height-independent term. Also published as `scene.fog.density`. */
const FOG_GLOBAL_DENSITY = 0.00030;
/**
 * Hard ceiling on the fog factor. Without it the far plates all converge on the
 * haze colour and the horizon becomes one flat plate again; at 0.88 the most
 * distant thing on the course still carries 12% of its own albedo, which is
 * exactly the residual that keeps three backdrop layers readable as three.
 */
const FOG_MAX = 0.88;

/** Cascade splits, art bible §2. The near map covers 12/45, the far 160/500. */
const NEAR_EXTENT = 65;
const FAR_EXTENT = 240;
const NEAR_DISTANCE = 300;
const FAR_DISTANCE = 900;
/**
 * Energy split. Three has no notion of cascades, so both lights light every
 * fragment and only the shadow TEST is per-cascade: outside the near frustum
 * three returns "lit" from the near map, so `1 - NEAR_SHARE` of the key leaks
 * through anything the far map alone is shadowing. At 0.66 that leak was 34% —
 * a shadow crossing the near boundary jumped from black to a third lit along a
 * dead-straight line, which is the "large hard-edged dark quad on the road".
 * At 0.80 the step is 20%, and SHADOW_BORDER_FADE below smears what is left
 * over the last ~8 m of the frustum so it reads as penumbra, not as geometry.
 */
const NEAR_SHARE = 0.80;
/** The far cascade only redraws every N frames; it is 240 m across and nothing
 *  in it moves fast enough on screen for the staleness to read. */
const FAR_UPDATE_INTERVAL = 3;

const UP = new THREE.Vector3(0, 1, 0);

// --- global shader patches ---------------------------------------------------
// Three exposes no hook for either of these: fog is hard-wired to one exp/exp2
// term against a single colour, and environmentIntensity multiplies the diffuse
// and specular IBL together. Both are scene-wide lighting decisions that this
// file owns, so both are installed by overriding the ShaderChunks — once, before
// the first frame, therefore before any program is compiled. Originals are kept
// and restored on dispose so a second Sky in the same page is not a landmine.

const PATCHED_CHUNKS = [
  'fog_fragment', 'envmap_physical_pars_fragment', 'shadowmap_pars_fragment',
] as const;

/** How far into a shadow cascade its own contribution starts fading out. */
const SHADOW_BORDER_FADE = 0.84;

let _originalChunks: Record<string, string> | null = null;

function glslFloat(x: number): string {
  return Number.isFinite(x) ? x.toFixed(7) : '0.0';
}

/**
 * Height-attenuated Beer fog, replacing three's uniform exp2 term.
 *
 * Three things change and each one is load-bearing:
 *
 *  1. exp(-d) instead of exp(-d²). exp2 is nearly transparent up close and then
 *     slams shut — at 0.0019 it was 1.3% at 60 m and 95% at 900 m, which is a
 *     wall, not aerial perspective. Beer layers smoothly: 3% at 30 m (MORE
 *     contact haze than before), 33% at 400 m, 60% at 900 m, 78% at 1.5 km.
 *  2. Density falls off exponentially with the eye's altitude, so the harbour
 *     sits in haze and the cliff traverse looks out over it through half as
 *     much.
 *  3. The factor is clamped below 1, so nothing ever reaches the fog colour
 *     exactly and the backdrop stays a stack of plates.
 *
 *  NOTE ON THE SHAPE OF THIS: the obvious implementation integrates the density
 *  profile between the eye and the FRAGMENT, which needs the fragment's world
 *  position — one extra varying. That is not available: `src/world/Water.ts`
 *  hand-rolls its own `vFogDepth` in its vertex shader and then includes
 *  `<fog_pars_fragment>`/`<fog_fragment>`, so any varying this chunk references
 *  that three's own `fog_vertex` writes would be undeclared in the sea's vertex
 *  stage and fail to link. Keying the height term off the eye alone costs
 *  accuracy only where the ray climbs or dives steeply (a 600 m hilltop seen
 *  from the harbour fogs at 46% instead of an ideal 33%) and needs nothing but
 *  `cameraPosition`, which three declares in every fragment prefix.
 */
function fogChunks(): Record<string, string> {
  const K = {
    SEA: glslFloat(FOG_SEA_DENSITY),
    HINV: glslFloat(1 / FOG_HEIGHT_SCALE),
    Y0: glslFloat(FOG_SEA_LEVEL),
    MAX: glslFloat(FOG_MAX),
  };

  return {
    fog_fragment: /* glsl */`
#ifdef USE_FOG

	float krSea = ${K.SEA} * exp( -clamp( cameraPosition.y - ${K.Y0}, -20.0, 600.0 ) * ${K.HINV} );

	#ifdef FOG_EXP2
		float krGlobal = fogDensity;
	#else
		float krGlobal = 0.0;
	#endif

	float fogFactor = min( 1.0 - exp( -( krSea + krGlobal ) * vFogDepth ), ${K.MAX} );

	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

#endif
`,
  };
}

/**
 * Split the IBL into its specular and diffuse halves. Only getIBLIrradiance —
 * the Lambertian term — is scaled; getIBLRadiance, which is the actual
 * reflection, keeps the material's authored intensity.
 */
function envDiffuseChunk(original: string, scale: number): string {
  const from = 'return PI * envMapColor.rgb * envMapIntensity;';
  const to = `return PI * envMapColor.rgb * envMapIntensity * ${glslFloat(scale)};`;
  if (!original.includes(from)) {
    console.warn('[sky] getIBLIrradiance signature moved; diffuse IBL left unscaled');
    return original;
  }
  return original.replace(from, to);
}

/**
 * Fade a cascade's shadow out across its own frustum border instead of cutting
 * it dead at the edge. Three returns "fully lit" the moment a fragment leaves a
 * shadow map, so with two cascades of unequal energy the handoff is a straight
 * line of constant value across whatever flat surface it lands on — the dark
 * quad painted across the road in scenery.png. Ramping the near map's own
 * contribution to zero over the last 16% of its extent (≈10 m at NEAR_EXTENT 65)
 * turns that line into a gradient, and the far map, which covers the same ground
 * at lower resolution, carries the shadow on.
 *
 * Applied to all three getShadow variants — the three-tab return is unique to
 * them, getPointShadow is indented one level shallower and is left alone.
 * shadowCoord has already been divided by w by the time this runs.
 */
function shadowBorderChunk(original: string): string {
  const from = '\t\t\treturn mix( 1.0, shadow, shadowIntensity );';
  const to = [
    '\t\t\tvec2 krEdge = abs( shadowCoord.xy - 0.5 ) * 2.0;',
    `\t\t\tfloat krFade = 1.0 - smoothstep( ${glslFloat(SHADOW_BORDER_FADE)}, 1.0, max( krEdge.x, krEdge.y ) );`,
    '\t\t\tshadow = mix( 1.0, shadow, krFade );',
    from,
  ].join('\n');
  const count = original.split(from).length - 1;
  if (count !== 3) {
    console.warn(`[sky] getShadow layout changed (${count} sites); cascade blend skipped`);
    return original;
  }
  return original.split(from).join(to);
}

// --- module scratch (nothing in the update path allocates) --------------------

const _center = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _camDir = new THREE.Vector3();

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

interface Cascade {
  light: THREE.DirectionalLight;
  extent: number;
  distance: number;
  mapSize: number;
  /** update every N frames; 1 = every frame */
  interval: number;
}

export class Sky implements System {
  /** The physical model. Public so anything can ask what colour the sky is. */
  model!: AtmosphereModel;

  /** Key light — also published as `ctx.sun`. This is the near cascade. */
  sun!: THREE.DirectionalLight;
  /** Second cascade; same direction, shares the key's energy. Null on Medium-. */
  sunFar: THREE.DirectionalLight | null = null;
  /** Unit vector toward the sun; mirrors `ctx.sunDirection`. */
  readonly sunDirection = SUN_DIRECTION.clone();

  // --- data the post stack (godrays / flares) needs from us ---
  /** Sun position in screen UV space, (0,0) bottom-left .. (1,1) top-right. */
  readonly sunScreenPosition = new THREE.Vector2(0.5, 0.5);
  /** False when the sun is behind the camera; screen position is meaningless then. */
  sunVisible = false;
  /** 0..1 — how much a light-shaft pass should contribute this frame. */
  sunScreenIntensity = 0;
  /** Linear radiance of the disc, for flare/streak tinting. */
  readonly sunDiscColor = new THREE.Color();
  /** Linear radiance of the horizon as the DOME draws it. Deliberately above
   *  display white — that is the only thing that tone maps to the bible's
   *  #ffd0a0. Do not use it as a fog or blend target; use `hazeColor`. */
  readonly horizonColor = new THREE.Color();
  /** The same horizon with the highlight rolloff applied: what the fog, the
   *  sky's low-elevation weld and the cloud aerial term all converge on. */
  readonly hazeColor = new THREE.Color();

  /** The PMREM environment, also published as `ctx.envMap`. */
  envMap: THREE.Texture | null = null;
  /** The dome material, exposed for debugging / uniform pokes. */
  material!: THREE.ShaderMaterial;
  /**
   * The sky dome itself (also findable as `scene.getObjectByName('Sky')`).
   * Exposed so the post stack can exclude it from any `overrideMaterial`
   * depth/normal prepass: it writes no depth and its vertex shader pins z to
   * the far plane, so a prepass that draws it with a foreign material would
   * stamp a unit cube into the depth buffer.
   */
  dome!: THREE.Mesh;

  private envMesh!: THREE.Mesh;
  private envScene!: THREE.Scene;
  private geometry!: THREE.BoxGeometry;
  private lut!: THREE.DataTexture;
  private noise!: THREE.DataTexture;
  private probe!: THREE.LightProbe;
  private bounce!: THREE.DirectionalLight;
  private cubeRT: THREE.WebGLCubeRenderTarget | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private cascades: Cascade[] = [];
  private frame = 0;

  // light-space basis, matching DirectionalLightShadow's own lookAt convention
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();

  init(ctx: Ctx): void {
    // The render pipeline is constructed before us, so whatever exposure it
    // settled on is what the calibration should solve against.
    const exposure = ctx.renderer?.toneMappingExposure || 1.05;
    this.model = new AtmosphereModel(exposure);

    // Before anything is drawn, therefore before any program is compiled.
    this.installShaderPatches();
    this.buildDome(ctx);
    this.buildFog(ctx);
    this.buildLights(ctx);
    this.buildEnvironment(ctx);

    ctx.sun = this.sun;
    ctx.sunDirection.copy(this.sunDirection);
    this.sunDiscColor.setRGB(
      this.model.sunDiscColor.x, this.model.sunDiscColor.y, this.model.sunDiscColor.z,
      THREE.LinearSRGBColorSpace,
    );
    this.horizonColor.setRGB(
      this.model.horizonColor.x, this.model.horizonColor.y, this.model.horizonColor.z,
      THREE.LinearSRGBColorSpace,
    );
    this.hazeColor.setRGB(
      this.model.hazeColor.x, this.model.hazeColor.y, this.model.hazeColor.z,
      THREE.LinearSRGBColorSpace,
    );

    // The post stack has no reference to this object otherwise; `ctx.sun` alone
    // is not enough to place a light-shaft origin on screen.
    (ctx as any).sky = this;
  }

  // -- construction -----------------------------------------------------------

  /**
   * Install the ShaderChunk overrides. Idempotent, and it snapshots the stock
   * chunks the first time so `dispose` can put them back.
   */
  private installShaderPatches(): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (_originalChunks === null) {
      _originalChunks = {};
      for (const name of PATCHED_CHUNKS) _originalChunks[name] = chunks[name];
    }
    const stock = _originalChunks;

    const fog = fogChunks();
    for (const name of Object.keys(fog)) chunks[name] = fog[name];

    chunks.envmap_physical_pars_fragment =
      envDiffuseChunk(stock.envmap_physical_pars_fragment, DIFFUSE_ENV_INTENSITY);
    chunks.shadowmap_pars_fragment = shadowBorderChunk(stock.shadowmap_pars_fragment);
  }

  private buildDome(ctx: Ctx): void {
    const q = ctx.settings.quality;
    const layers = q >= Quality.High ? 3 : q === Quality.Medium ? 2 : 1;

    this.lut = this.model.bakeScatteringLUT();
    this.noise = this.model.bakeCloudNoise();
    const maxAniso = ctx.renderer?.capabilities.getMaxAnisotropy?.() ?? 1;
    this.noise.anisotropy = Math.min(4, maxAniso);

    const m = this.model;
    const u = m.uniformValues();
    const sunPlane = new THREE.Vector2(this.sunDirection.x, this.sunDirection.z).normalize();

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.ShaderMaterial({
      name: 'SkyAtmosphere',
      uniforms: {
        uLut: { value: this.lut },
        uNoise: { value: this.noise },
        uSunDir: { value: this.sunDirection },
        uSunPlane: { value: sunPlane },
        uGainZenith: { value: u.gainZenith },
        uGainHorizon: { value: u.gainHorizon },
        uMieTint: { value: u.mieTint },
        uSunDisc: { value: m.sunDiscColor.clone() },
        uGroundColor: { value: m.groundColor.clone() },
        uHorizonColor: { value: m.horizonColor.clone() },
        uHazeColor: { value: m.hazeColor.clone() },
        uCloudSun: { value: m.cloudSunColor.clone() },
        uCloudAmbient: { value: m.cloudAmbientColor.clone() },
        uCameraXZ: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uMieG: { value: u.mieG },
        uMieIso: { value: u.mieIso },
        uRayBack: { value: u.rayBack },
        uGainBlendEnd: { value: u.gainBlendEnd },
        uGainBlendPow: { value: u.gainBlendPow },
        uSunRadius: { value: m.sunAngularRadius },
        uCloudAmount: { value: 1 },
      },
      defines: { CLOUD_LAYERS: layers },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(this.geometry, this.material);
    this.dome.name = 'Sky';
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    // Drawn LAST among opaques, not first: the dome sits on the far plane and
    // writes no depth, so with the world already in the depth buffer only the
    // pixels that are actually sky ever run the scattering + cloud shader.
    this.dome.renderOrder = 1000;
    this.dome.castShadow = false;
    this.dome.receiveShadow = false;
    ctx.scene.add(this.dome);

    // A second instance of the same material, alone in its own scene, is what
    // the cube camera renders for the environment map.
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(this.geometry, this.material);
    this.envMesh.frustumCulled = false;
    this.envMesh.matrixAutoUpdate = false;
    this.envScene.add(this.envMesh);
  }

  /**
   * A FogExp2 is still what goes on the scene — that is what makes three define
   * USE_FOG/FOG_EXP2 and hand every material a `fogColor` and a `fogDensity`.
   * The exp2 term itself is gone, replaced in the chunk above; `density` now
   * means the height-independent component and `color` the base haze.
   */
  private buildFog(ctx: Ctx): void {
    const h = this.model.hazeColor;
    const fog = new THREE.FogExp2(0x000000, FOG_GLOBAL_DENSITY);
    fog.color.setRGB(h.x, h.y, h.z, THREE.LinearSRGBColorSpace);
    ctx.scene.fog = fog;
  }

  private buildLights(ctx: Ctx): void {
    const shadows = ctx.settings.shadows;
    const q = ctx.settings.quality;
    const twoCascades = shadows && q >= Quality.High;

    // basis used for texel snapping; identical to the one
    // DirectionalLightShadow derives via camera.lookAt with up = +Y
    this.axisZ.copy(this.sunDirection);
    this.axisX.copy(UP).cross(this.axisZ).normalize();
    this.axisY.copy(this.axisZ).cross(this.axisX).normalize();

    // 3072 over a 130 m box is 4.2 cm/texel — enough that a kart wheel lands a
    // real contact shadow — without spending the 67 MB a 4096 map costs. The
    // box grew from 110 m so the cascade seam sits further out, where haze and
    // foreshortening cover the last of it.
    const nearMap = q >= Quality.Ultra ? 4096 : q >= Quality.High ? 3072 : 2048;
    const nearShare = twoCascades ? NEAR_SHARE : 1;
    this.sun = this.makeCascade(ctx, SUN_INTENSITY * nearShare, NEAR_EXTENT, NEAR_DISTANCE,
      nearMap, shadows, -0.00004, 0.025, 1);
    this.sun.name = 'SunKeyNear';

    if (twoCascades) {
      this.sunFar = this.makeCascade(ctx, SUN_INTENSITY * (1 - NEAR_SHARE), FAR_EXTENT,
        FAR_DISTANCE, 2048, true, -0.00008, 0.35, FAR_UPDATE_INTERVAL);
      this.sunFar.name = 'SunKeyFar';
    }

    // SH ambient projected from our own sky — strictly better than a hemisphere
    // light because it carries the azimuthal asymmetry (the side of an object
    // facing the sun's half of the sky picks up more skylight).
    this.probe = new THREE.LightProbe(this.model.projectSH(), PROBE_INTENSITY);
    ctx.scene.add(this.probe);

    // Warm bounce from the sand and stone below, tilted toward the sun's
    // azimuth because that is the ground actually receiving the key.
    this.bounce = new THREE.DirectionalLight(GROUND_BOUNCE_COLOR, BOUNCE_INTENSITY);
    this.bounce.position.set(this.sunDirection.x * 0.55, -1, this.sunDirection.z * 0.55)
      .normalize().multiplyScalar(100);
    this.bounce.castShadow = false;
    ctx.scene.add(this.bounce);
    ctx.scene.add(this.bounce.target);
  }

  private makeCascade(
    ctx: Ctx, intensity: number, extent: number, distance: number,
    mapSize: number, shadows: boolean, bias: number, normalBias: number, interval: number,
  ): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(SUN_LIGHT_COLOR, intensity);
    light.position.copy(this.sunDirection).multiplyScalar(distance);
    light.castShadow = shadows;

    if (shadows) {
      const s = light.shadow;
      s.mapSize.set(mapSize, mapSize);
      s.bias = bias;
      s.normalBias = normalBias;
      s.radius = 2.2;
      const cam = s.camera;
      cam.left = -extent; cam.right = extent;
      cam.top = extent; cam.bottom = -extent;
      cam.near = 5;
      cam.far = distance + extent * 2 + 400;
      cam.updateProjectionMatrix();
      if (interval > 1) s.autoUpdate = false;
    }

    ctx.scene.add(light);
    ctx.scene.add(light.target);
    this.cascades.push({ light, extent, distance, mapSize, interval });
    return light;
  }

  private buildEnvironment(ctx: Ctx): void {
    const renderer = ctx.renderer;
    if (!renderer) return;

    // 512 on High+: with the environment now at full authored intensity the
    // chrome actually resolves what it is reflecting, and a 256 face put the
    // sun disc (0.019 rad) on about three texels. One-time bake, no frame cost.
    const cubeSize = ctx.settings.quality >= Quality.High ? 512 : 256;

    if (this.cubeRT && this.cubeRT.width !== cubeSize) {
      this.cubeRT.dispose();
      this.cubeRT = null;
    }

    if (!this.cubeRT) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.cubeRT.texture.name = 'SkyCube';
    }

    // 0.1/10 near-far: the dome ignores them entirely, it sits on the far plane.
    const cubeCam = new THREE.CubeCamera(0.1, 10, this.cubeRT);
    // A composer-driven pipeline usually turns autoClear off; the cube faces
    // need a defined depth buffer, so force it for the duration of the bake.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    cubeCam.update(renderer, this.envScene);
    renderer.autoClear = prevAutoClear;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromCubemap(this.cubeRT.texture, this.envRT ?? null);
    pmrem.dispose();
    this.envRT = rt;

    this.envMap = rt.texture;
    ctx.envMap = rt.texture;
    ctx.scene.environment = rt.texture;
    ctx.scene.environmentIntensity = ENV_INTENSITY;
  }

  /**
   * Re-render the sky into the environment map. Costs a 6-face render plus a
   * PMREM chain, so it is never called from the frame loop — only if something
   * genuinely changes the sky (a quality switch, a retune).
   */
  refreshEnvironment(ctx: Ctx): void {
    this.buildEnvironment(ctx);
  }

  // -- frame ------------------------------------------------------------------

  update(ctx: Ctx, _dt: number): void {
    const u = this.material.uniforms;
    u.uTime.value = ctx.time;
    // True translational parallax between the cloud planes as the kart moves —
    // the low deck slides past the high cirrus exactly as it should.
    (u.uCameraXZ.value as THREE.Vector2).set(ctx.camera.position.x, ctx.camera.position.z);
  }

  lateUpdate(ctx: Ctx, _dt: number): void {
    // Follow the player when there is one, the camera before the race exists.
    const player = ctx.race?.player;
    _camDir.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    _fwd.set(_camDir.x, 0, _camDir.z);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1); else _fwd.normalize();

    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      if (!c.light.castShadow) continue;
      if (c.interval > 1) {
        if (this.frame % c.interval !== 0) continue;
        c.light.shadow.needsUpdate = true;
      }
      if (player) _center.copy(player.position); else _center.copy(ctx.camera.position);
      // Bias the frustum ahead of the action: half of a cascade spent behind
      // the player is half a cascade wasted.
      _center.addScaledVector(_fwd, c.extent * 0.45);
      this.snapCascade(c, _center);
    }

    this.updateSunScreen(ctx.camera);
    this.frame++;
  }

  /**
   * Quantise the cascade centre to whole shadow texels in light space. Without
   * this the shadow map resamples the world at a slightly different offset each
   * frame and every shadow edge boils. Mandatory, not an optimisation.
   */
  private snapCascade(c: Cascade, center: THREE.Vector3): void {
    const texel = (2 * c.extent) / c.mapSize;
    const px = Math.round(center.dot(this.axisX) / texel) * texel;
    const py = Math.round(center.dot(this.axisY) / texel) * texel;
    const pz = center.dot(this.axisZ);
    _snapped.set(0, 0, 0)
      .addScaledVector(this.axisX, px)
      .addScaledVector(this.axisY, py)
      .addScaledVector(this.axisZ, pz);
    c.light.target.position.copy(_snapped);
    c.light.position.copy(_snapped).addScaledVector(this.sunDirection, c.distance);
    c.light.target.updateMatrixWorld();
    c.light.updateMatrixWorld();
  }

  /**
   * Where the sun lands on screen, for light shafts and lens effects.
   * Cheap enough that the post stack can call it again with a fresher camera.
   */
  projectSunToScreen(camera: THREE.PerspectiveCamera, out: THREE.Vector2): boolean {
    _camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = _camDir.dot(this.sunDirection);
    if (facing <= 0) {
      out.set(0.5, 0.5);
      return false;
    }
    // A point well inside the far plane along the sun ray projects to the same
    // screen position as the disc itself, without the w-flip of a point at
    // infinity behind the eye.
    _proj.copy(camera.position).addScaledVector(this.sunDirection, 1500).project(camera);
    out.set(_proj.x * 0.5 + 0.5, _proj.y * 0.5 + 0.5);
    return true;
  }

  private updateSunScreen(camera: THREE.PerspectiveCamera): void {
    this.sunVisible = this.projectSunToScreen(camera, this.sunScreenPosition);
    if (!this.sunVisible) {
      this.sunScreenIntensity = 0;
      return;
    }
    _camDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const facing = _camDir.dot(this.sunDirection);
    const edge = Math.max(
      Math.abs(this.sunScreenPosition.x - 0.5),
      Math.abs(this.sunScreenPosition.y - 0.5),
    );
    // Fade as the disc leaves the frame so shafts cannot pop on and off.
    this.sunScreenIntensity = smoothstep(0.0, 0.25, facing) * (1 - smoothstep(0.45, 1.1, edge));
  }

  dispose(): void {
    if (_originalChunks !== null) {
      const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
      for (const name of PATCHED_CHUNKS) chunks[name] = _originalChunks[name];
      _originalChunks = null;
    }
    this.dome?.parent?.remove(this.dome);
    this.envScene?.remove(this.envMesh);
    this.geometry?.dispose();
    this.material?.dispose();
    this.lut?.dispose();
    this.noise?.dispose();
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    for (const c of this.cascades) {
      c.light.shadow?.dispose();
      c.light.parent?.remove(c.light);
    }
    this.cascades.length = 0;
    this.probe?.parent?.remove(this.probe);
    this.bounce?.parent?.remove(this.bounce);
  }
}
