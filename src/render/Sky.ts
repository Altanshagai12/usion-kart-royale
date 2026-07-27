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
 *    into fog is what pushed everything past 60 m over the ACES knee. And it is
 *    sampled PER VIEW AZIMUTH, not once: the sky is drawn from the real model,
 *    so aerial perspective that converges on an average of it can only meet it
 *    at a seam. That seam was the bay.
 *
 *  · The light rig is a real three-point rig, not a key plus a wash: a warm
 *    #ffd9a8 key at 4.2, a COOL #a8c8ff directional fill at 0.85 arriving from
 *    35° up on the anti-solar side, a token warm ground bounce, and a rim term
 *    driven by the key's own shadowed radiance and folded into the directional
 *    loop. Measured on a 0.18 grey card: key:fill 5.7:1, and an anti-solar-facing
 *    surface swings from red:blue 1.69 (warm) to 0.54 (cool) against a key that
 *    swings the other way to 4.60. Before this there was no fill light at all
 *    and the shaded side was warm — a dimmer copy of the key, which is exactly
 *    what "illuminates but does not sculpt" describes.
 *
 *  · Enclosed geometry actually occludes the sky. A capsule volume fitted to the
 *    tunnel bore is baked into `<common>` and cuts the indirect terms, the
 *    shadowless fill lights and the fog inside it, because none of those three
 *    knew the rock was there and together they out-shone the tunnel's own exit.
 *
 *  · Environment intensity is 1.0, i.e. materials get the envMapIntensity they
 *    were authored with, so chrome and clearcoat actually mirror the sky. The
 *    DIFFUSE half of the IBL is scaled down separately (another chunk override)
 *    because that is the term that flattens key/fill, and it is the only reason
 *    the old code had to hold the whole environment down to 0.40.
 *
 *  · Shadows are a real two-slice CSM: ONE key light at full energy, TWO shadow
 *    maps, and the cascade chosen — and cross-faded — on the shadow TEST inside
 *    a patched `lights_fragment_begin`. The rig this replaced split the sun's
 *    energy between two independent lights, which cannot work: three lights
 *    every fragment from both, so outside the near frustum that light's share of
 *    the key leaks through anything only the far map is shadowing, and the
 *    cascade border becomes a straight-edged step in brightness. Shrinking the
 *    share shrinks the step; it never removes it. Now the only thing that
 *    changes across the border is penumbra width. Both frusta are texel-snapped
 *    in light space: without that, shadow edges crawl as the kart moves and the
 *    whole frame looks cheap.
 * ============================================================================
 */
import * as THREE from 'three';
import { Quality, type Ctx, type System } from '../types';
import {
  AtmosphereModel,
  GROUND_BOUNCE_COLOR,
  SKY_FILL_COLOR,
  SKY_FILL_DIRECTION,
  SKY_VERTEX_SHADER,
  SUN_DIRECTION,
  SUN_LIGHT_COLOR,
  buildSkyFragmentShader,
  hazeGlsl,
} from './Atmosphere';
import { TUNNEL_T0, TUNNEL_T1 } from '../world/TrackLayout';

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
const DIFFUSE_ENV_INTENSITY = 0.16;
/** SH ambient on top of the env map — energy compensation for the bounces
 *  single-scattering IBL cannot see, and the only ambient that reaches
 *  materials which ignore environment maps. Deliberately small. */
const PROBE_INTENSITY = 0.08;
/**
 * How far the ambient probe's chromaticity is pulled toward the bible's
 * #a8c8ff. Up from 0.5: the probe is the omnidirectional part of the fill and
 * the one term guaranteed to reach a shaded surface whatever its normal, so if
 * it is warm the shadow side can never be cool no matter what else is done.
 */
const PROBE_FILL_TINT = 0.85;
/**
 * Warm bounce off the sand and stone, art bible §2. Lights undersides only.
 *
 * Down from 0.30, and this matters more than the number suggests. This light
 * casts no shadow and is aimed UP, so it reached the shaded side of every
 * object in the game with the same warm #c98f5a the key is already made of. On
 * a matte sphere it took the anti-solar pole to a red:blue of 2.1 — the shadow
 * side was measurably warmer than neutral while the key was warm too, which is
 * the definition of "illuminates but does not sculpt". It is now a hint under
 * the chassis and the kerbs, which is all a bounce should ever be.
 */
const BOUNCE_INTENSITY = 0.13;
/**
 * Cool directional sky fill, art bible §2 (`#a8c8ff`), from above and the
 * anti-solar side. This is the term the rig was missing.
 *
 * The environment map alone cannot do this job at golden hour. Its lower half
 * and its whole horizon band are warm — at 14° elevation the model's own low sky
 * runs #fef8f3 down-sun to #fbc89b behind, i.e. warm all the way round the
 * compass — so IBL irradiance on a side-facing normal is warm no matter which
 * way the object is turned. Only the HIGH sky is blue, and only a directional
 * term weighted to it can put that blue on the shaded side. One extra
 * DirectionalLight, no shadow map, no draw calls.
 */
const SKY_FILL_INTENSITY = 0.85;

// --- aerial perspective ------------------------------------------------------
// Replaces FogExp2. The old single exp2 term at density 0.0019 reached 44% at
// 400 m and 95% at 900 m, so the backdrop headlands were being built and then
// erased, and everything past ~60 m converged on one cream value. Split into a
// sea-level layer that thins with the eye's altitude plus a thin global term,
// the near-road contact haze is actually STRONGER than before (3% at 30 m
// against 0.3%) while the three backdrop layers land at 60% / 78% / 88% from
// the harbour instead of 95% / 100% / 100%, and at 45% / 64% / 76% from the
// cliff apex — three plates at descending contrast, which is the whole point.

/** Density of the low layer, per metre, at FOG_SEA_LEVEL. */
const FOG_SEA_DENSITY = 0.00085;
/** Scale height of that layer, metres. Density halves every ~42 m of altitude. */
const FOG_HEIGHT_SCALE = 60;
/** Altitude the sea-level density is quoted at. */
const FOG_SEA_LEVEL = 0;
/**
 * Height-independent term. Also published as `scene.fog.density`.
 *
 * Down from 0.00030: this is the term that fogs things the height falloff is
 * supposed to leave alone, and it was the reason a 300 m ridge and a 3 km
 * headland landed within a few percent of each other in the establishing shot.
 * The sea-level term carries the difference (and then some), so the bay hazes
 * harder than before while anything standing out of it separates.
 */
const FOG_GLOBAL_DENSITY = 0.00022;
/**
 * Distance at which aerial perspective starts. Beer fog from zero puts a couple
 * of percent of haze on the foreground, which is physically right and
 * pictorially wrong: it is the first thing to take the saturation off the
 * village pastels and the kerb red in the near field. 20 m costs nothing at
 * range (it is a translation, not a scale) and gives the foreground back.
 */
const FOG_START = 20;
/**
 * Hard ceiling on the fog factor. Without it the far plates all converge on the
 * haze colour and the horizon becomes one flat plate again. 0.92 rather than
 * 0.88: with the haze now sampled per view azimuth the thing distant geometry
 * converges on is the sky it is actually standing in front of, so convergence
 * is what we WANT at the horizon line — the residual is only there to keep the
 * backdrop layers from fusing, and 8% is enough for that.
 */
const FOG_MAX = 0.92;

/**
 * Cascade splits, art bible §2. Two maps: the near one carries 12/45, the far
 * one 160/500. The near extent is smaller than it used to be (65) because it no
 * longer has to hide a handoff — see `cascadeShadowChunk`.
 */
const NEAR_EXTENT = 55;
const FAR_EXTENT = 220;
/** Single-cascade fallback (Medium and below): one map has to cover everything. */
const SOLO_EXTENT = 110;
const NEAR_DISTANCE = 300;
const FAR_DISTANCE = 900;
/**
 * Where the cross-fade from the near cascade to the far one begins, as a
 * fraction of the near map's normalised extent. 0.80 puts the band in the outer
 * 20% of the box — about 11 m of light-space travel — which is wide enough that
 * the change in penumbra width reads as distance rather than as an edge.
 */
const CASCADE_BLEND = 0.80;
/** The far cascade only redraws every N frames; it is 440 m across and nothing
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
  'common', 'fog_pars_fragment', 'fog_fragment', 'envmap_physical_pars_fragment',
  'shadowmap_pars_fragment', 'lights_pars_begin', 'lights_fragment_begin',
  'lights_fragment_maps',
] as const;

// --- interior volumes --------------------------------------------------------
// THE TUNNEL WAS BRIGHTER INSIDE THAN THE DAYLIGHT OUTSIDE IT.
//
// The bore casts shadows, so the KEY was correctly blocked. Everything else was
// not, and everything else adds up to more than the key: `scene.environment` is
// a full sky probe sampled with no notion of what is between the fragment and
// the sky, the SH ambient likewise, and the warm ground bounce is a
// DirectionalLight with `castShadow = false` — i.e. a light that passes through
// solid rock by construction. Aerial perspective piled a third of a stop of warm
// haze on top. A fragment 60 m inside a hillside was receiving the entire
// hemisphere of a golden-hour sky, and the mouths were the one part of frame
// where you could see the sky BEING that bright, so the exit read as the dark
// end of the shot. That is an inversion, and no amount of retuning the sodium
// lamps can fix it, because the problem is that the rock is not occluding
// anything.
//
// So: a real occlusion volume. A capsule chain fitted to the bore's own
// centreline, tapered in from each mouth, baked into `common` as literals and
// applied to the indirect terms, to the shadowless fill lights and to the fog.
// Inside the bore, indirect light is cut to a few percent and the only things
// left are the sodium strips, the daylight spilling in at the mouths, and the
// bore's own baked vertex-colour rhythm. The exit is then a genuinely bright
// hole, which is what it always should have been.

/** Fraction of indirect diffuse removed at the centre of an interior volume. */
const INTERIOR_IRRADIANCE_CUT = 0.90;
/** Same for the specular half of the IBL. Slightly gentler: a wet floor and the
 *  karts' chrome still need something to reflect, and what they should reflect
 *  in there is mostly the lamps, which N8AO and the point lights supply. */
const INTERIOR_RADIANCE_CUT = 0.86;
/** Fraction of the shadowless fill/bounce lights removed. Near-total: these are
 *  the lights that were literally shining through the hillside. */
const INTERIOR_FILL_CUT = 0.95;
/** Fraction of aerial perspective removed. Fog is skylight in suspension; there
 *  is no sky in there for it to be. */
const INTERIOR_FOG_CUT = 0.88;
/** Radial extent of the bore volume around the centreline: full effect inside
 *  the first, none beyond the second. The bore is ~13 m half-width by 8.6 m, so
 *  the far edge is ~16 m off the centreline; anything past that is solid rock. */
const INTERIOR_R_IN = 17;
const INTERIOR_R_OUT = 25;
/** How far in from each mouth the interior reaches full strength, metres. This
 *  is the daylight spill, and it is what makes the mouth read as a portal
 *  instead of as a line. */
const INTERIOR_MOUTH = 20;
/** Capsule segments fitted to the tunnel centreline. Ten over ~140 m is a 14 m
 *  chord, which tracks the bore's curvature to well inside a metre. */
const INTERIOR_SEGMENTS = 10;

/** One capsule of the interior chain, in world space. */
interface InteriorSegment {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  /** arc distance from the volume's start at A and at B */
  s0: number; s1: number;
}

interface InteriorVolume {
  segments: InteriorSegment[];
  /** bounding sphere, for the one-test early-out every other fragment takes */
  cx: number; cy: number; cz: number; radius: number;
  total: number;
}

// --- the sun rim -------------------------------------------------------------
/**
 * Strength of the rim, as a fraction of the key's own radiance added straight to
 * direct specular. A silhouette edge fully side-on to a 4.2 key picks up ~1.2
 * scene-linear, which lands just under display white through the shoulder — a
 * bright edge with colour still in it, not a white outline.
 */
const RIM_STRENGTH = 0.34;
/** How tightly the rim hugs the silhouette. 3.0 confines it to roughly the last
 *  20° of grazing angle; lower and it becomes a wash over the whole side. */
const RIM_POWER = 3.0;

/**
 * How far into a shadow map its own contribution starts fading out. This is a
 * thin safety strip now, not the cascade handoff — the handoff is a real
 * cross-fade of two shadow tests, see `cascadeShadowChunk`. It still earns its
 * place on the FAR cascade's outer edge (nothing catches that one) and on the
 * single-cascade path used below Quality.High.
 */
const SHADOW_BORDER_FADE = 0.96;

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
 *  4. The colour is sampled per VIEW AZIMUTH out of the same atmosphere model
 *     the dome is drawn from, instead of being one constant. See
 *     `AtmosphereModel.hazePoly`: at 14° elevation the horizon runs from a pale
 *     #f1e3d9 straight down-sun to a dusty #f7bf92 behind, an 1.8:1 luminance
 *     swing and a full hue swing, and a single averaged haze guarantees that in
 *     most camera directions the sea and the sky converge on two different
 *     colours — which is half of the hard bay/sky seam. (The other half was the
 *     dome only welding 34% of the way onto that haze; see
 *     `HORIZON_WELD_BAND`.) There is
 *     no uniform channel into this chunk (three merges `UniformsLib.fog` into
 *     `ShaderLib` at its own module-init time), so the fit is baked in as
 *     literals by `hazeGlsl`.
 *
 *  NOTE ON THE SHAPE OF THIS: the obvious implementation integrates the density
 *  profile between the eye and the FRAGMENT, and shades it with the direction
 *  eye→fragment. Both need the fragment's world position — one extra varying.
 *  That is not available: `src/world/Water.ts` hand-rolls its own `vFogDepth` in
 *  its vertex shader and then includes `<fog_pars_fragment>`/`<fog_fragment>`
 *  without three's `<fog_pars_vertex>`/`<fog_vertex>`, so a varying declared
 *  here would be undeclared in the sea's vertex stage and fail to link. What IS
 *  available in every fragment prefix three emits is `viewMatrix` and
 *  `cameraPosition`, and the camera's world-space forward falls straight out of
 *  the former. So:
 *
 *    · the ray's vertical slope is taken as the camera's forward slope, which
 *      makes the height integral EXACT for the fragment at the centre of the
 *      frame and correct in trend everywhere else — and note that `vFogDepth` is
 *      view-space depth, not ray length, so `fwd.y * vFogDepth` is exactly the
 *      world-Y that the known component of the view position contributes;
 *    · the haze is sampled in the camera's forward azimuth, so the horizon
 *      converges dead-on at frame centre and drifts by at most half the
 *      horizontal FOV at the edges — where the sky itself has drifted with it.
 *
 *  Per-fragment would be strictly better and costs one `varying vec3`; it needs
 *  Water.ts to stop hand-rolling `vFogDepth`. Flagged, not smuggled.
 */
function fogChunks(model: AtmosphereModel, stockPars: string): Record<string, string> {
  const K = {
    SEA: glslFloat(FOG_SEA_DENSITY),
    H: glslFloat(FOG_HEIGHT_SCALE),
    HINV: glslFloat(1 / FOG_HEIGHT_SCALE),
    Y0: glslFloat(FOG_SEA_LEVEL),
    MAX: glslFloat(FOG_MAX),
    START: glslFloat(FOG_START),
  };

  return {
    // The haze fit is a function, so it cannot live in `fog_fragment` — that
    // chunk is included inside main(). It goes here, at file scope, in the one
    // fog chunk every material with fog pulls in (Water.ts included: it rolls
    // its own vFogDepth in the vertex stage but takes this chunk verbatim).
    fog_pars_fragment: `${stockPars}
#ifdef USE_FOG
${hazeGlsl(model, 'krFogHaze')}
#endif
`,

    fog_fragment: /* glsl */`
#ifdef USE_FOG

	// world-space camera forward: minus the third ROW of the view rotation
	vec3 krFwd = -vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );

	float krD = max( vFogDepth - ${K.START}, 0.0 );

	// Exact mean of exp( -y / H ) between the ray's clamped start and end
	// altitudes, which is the analytic Beer integral of the height profile along
	// the ray. Both ends are clamped before the exponential, so a camera looking
	// down a long way cannot drive the density to infinity the way integrating
	// the raw profile below sea level would.
	float krSlope = clamp( krFwd.y, -0.7, 0.7 );
	float krY0 = clamp( cameraPosition.y - ${K.Y0}, -20.0, 600.0 );
	float krY1 = clamp( cameraPosition.y + krSlope * krD - ${K.Y0}, -20.0, 600.0 );
	float krE0 = exp( -krY0 * ${K.HINV} );
	float krE1 = exp( -krY1 * ${K.HINV} );
	float krDy = krY1 - krY0;
	float krAvg = abs( krDy ) < 0.5 ? 0.5 * ( krE0 + krE1 ) : ( krE0 - krE1 ) * ${K.H} / krDy;

	#ifdef FOG_EXP2
		float krGlobal = fogDensity;
	#else
		float krGlobal = 0.0;
	#endif

	float fogFactor = min( 1.0 - exp( -( ${K.SEA} * krAvg + krGlobal ) * krD ), ${K.MAX} );

	// Aerial perspective is skylight scattered in the air between here and the
	// eye. Inside the bore there is no sky above that air, and a third of a stop
	// of warm haze laid over the interior was a good part of why the tunnel
	// out-shone its own exit.
	fogFactor *= 1.0 - krInterior * ${glslFloat(INTERIOR_FOG_CUT)};

	gl_FragColor.rgb = mix( gl_FragColor.rgb, krFogHaze( krFwd.xz ), fogFactor );

#endif
`,
  };
}

/**
 * Everything scene-wide that needs to be visible from BOTH the lighting chunks
 * and the fog chunk goes into `<common>`, which is the one chunk every fragment
 * shader in three includes — lit, unlit, and hand-rolled ShaderMaterials that
 * pull three's chunks piecemeal. `krInterior` therefore always exists, and reads
 * 0 for anything that never runs the lighting path, which is exactly right: an
 * unlit material has no indirect term to occlude.
 */
function commonChunk(original: string, volume: InteriorVolume | null): string {
  const F = glslFloat;
  let body = '\treturn 0.0;';

  if (volume !== null && volume.segments.length > 0) {
    const lines: string[] = [
      `\tvec3 krD = p - vec3( ${F(volume.cx)}, ${F(volume.cy)}, ${F(volume.cz)} );`,
      `\tif ( dot( krD, krD ) > ${F(volume.radius * volume.radius)} ) return 0.0;`,
      '\tfloat m = 0.0;',
      '\tvec3 ap, q; float t, s;',
    ];
    // Every segment is expressed RELATIVE to the volume centre, and the test
    // runs on `krD` rather than on `p`. The circuit sits a few hundred metres
    // from the origin and this is squaring distances; keeping the operands under
    // a hundred metres costs nothing and keeps the whole test comfortably inside
    // float precision even where a driver decides mediump is good enough.
    for (const seg of volume.segments) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay, dz = seg.bz - seg.az;
      const inv = 1 / Math.max(dx * dx + dy * dy + dz * dz, 1e-6);
      lines.push(
        `\tap = krD - vec3( ${F(seg.ax - volume.cx)}, ${F(seg.ay - volume.cy)}, ` +
          `${F(seg.az - volume.cz)} );`,
        `\tt = clamp( dot( ap, vec3( ${F(dx)}, ${F(dy)}, ${F(dz)} ) ) * ${F(inv)}, 0.0, 1.0 );`,
        `\tq = ap - vec3( ${F(dx)}, ${F(dy)}, ${F(dz)} ) * t;`,
        `\ts = ${F(seg.s0)} + ${F(seg.s1 - seg.s0)} * t;`,
        `\tm = max( m, ( 1.0 - smoothstep( ${F(INTERIOR_R_IN * INTERIOR_R_IN)}, ` +
          `${F(INTERIOR_R_OUT * INTERIOR_R_OUT)}, dot( q, q ) ) )` +
          ` * smoothstep( 0.0, ${F(INTERIOR_MOUTH)}, s )` +
          ` * smoothstep( 0.0, ${F(INTERIOR_MOUTH)}, ${F(volume.total)} - s ) );`,
      );
    }
    lines.push('\treturn m;');
    body = lines.join('\n');
  }

  return `${original}

// --- Kart Royale: scene-wide lighting state ---------------------------------
// 1 deep inside an enclosed volume, 0 in the open. Written once per fragment by
// the patched <lights_fragment_begin>; read by the indirect terms, by the
// shadowless fill lights and by aerial perspective.
float krInterior = 0.0;

float krInteriorAt( vec3 p ) {
${body}
}

/**
 * The low sun grazing a silhouette.
 *
 * Not a physical term and not pretending to be — it is the third light of a
 * three-point rig, expressed as a function of geometry rather than as another
 * DirectionalLight, because a rim that is a light has to be re-aimed every time
 * the subject turns and there are eight subjects. Driven by the KEY's already
 * shadowed radiance, so it vanishes in shadow and inside the tunnel exactly as
 * a real one would.
 *
 * The 'lit' factor is what keeps it honest: the rim appears only on the edge that is
 * turned toward the sun, so a kart with the sun behind it gets a hot outline and
 * a kart driving into the sun gets none, which is the correct read.
 *
 * The floor mask is not cosmetic. Vectors here are VIEW space, so the world-up
 * component has to be recovered from the view matrix; without the mask, every
 * road fragment past about twelve metres is grazing and the rim becomes a second
 * uncontrolled specular smeared over the whole carriageway.
 */
vec3 krSunRim( const in vec3 lightColor, const in vec3 lightDir,
	const in vec3 N, const in vec3 V, const in float rough ) {
	float graze = 1.0 - saturate( dot( N, V ) );
	float lit = saturate( dot( N, lightDir ) );
	float worldY = dot( N, vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] ) );
	float mask = 1.0 - smoothstep( 0.25, 0.95, worldY );
	float k = ${F(RIM_STRENGTH)} * pow( graze, ${F(RIM_POWER)} ) * lit * mask;
	return lightColor * ( k * ( 1.0 - 0.65 * rough ) );
}
`;
}

/** Set `krInterior` before anything reads it, from the world position three
 *  itself reconstructs the same way for its light-probe grid. */
function interiorLightsChunk(original: string): string {
  const anchor = 'vec3 geometryClearcoatNormal = vec3( 0.0 );';
  if (!original.includes(anchor)) {
    console.warn('[sky] lights_fragment_begin layout changed; interior volume skipped');
    return original;
  }
  return original.replace(anchor, `${anchor}

	krInterior = krInteriorAt( ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz );
`);
}

/** Occlude the indirect terms inside an interior volume. */
function interiorMapsChunk(original: string): string {
  return `${original}
#if defined( RE_IndirectDiffuse )
	irradiance *= 1.0 - krInterior * ${glslFloat(INTERIOR_IRRADIANCE_CUT)};
	iblIrradiance *= 1.0 - krInterior * ${glslFloat(INTERIOR_IRRADIANCE_CUT)};
#endif
#if defined( RE_IndirectSpecular )
	radiance *= 1.0 - krInterior * ${glslFloat(INTERIOR_RADIANCE_CUT)};
	clearcoatRadiance *= 1.0 - krInterior * ${glslFloat(INTERIOR_RADIANCE_CUT)};
#endif
`;
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
 * Fade a shadow map out across its own frustum border instead of cutting it
 * dead at the edge. Three returns "fully lit" the moment a fragment leaves a
 * shadow map, which on a flat surface is a straight line of constant value.
 *
 * With the cascade cross-fade below doing the real work this is down to a 4%
 * safety strip, but it still matters in two places: the FAR cascade's outer
 * border, which nothing catches, and the single-map path used below
 * Quality.High. It also applies to spot shadows, where a soft frustum edge is
 * what you want anyway.
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
    console.warn(`[sky] getShadow layout changed (${count} sites); border fade skipped`);
    return original;
  }
  return original.split(from).join(to);
}

/**
 * Append the cascade resolver to `shadowmap_pars_fragment`.
 *
 * THIS IS THE FIX FOR THE HARD-EDGED KEY-LIGHT STEP. The old rig stacked two
 * DirectionalLights sharing the sun's direction and SPLIT THE SUN'S ENERGY
 * between them, because three has no notion of a cascade: both lights light
 * every fragment and only the shadow test is per-map, so outside the near
 * frustum three returns "lit" from the near map and that light's whole share of
 * the key leaks through anything the far map alone is shadowing. Every version
 * of that is a brightness discontinuity along a dead-straight geometric line,
 * and shrinking the leak (0.66 → 0.80 → …) only makes the step smaller; it never
 * makes it stop being a step. You cannot hide a hard edge by lowering its
 * contrast.
 *
 * So: light 0 carries 100% of the key. Light 1 is a shadow-only slave — same
 * direction, intensity 0, skipped entirely in `lights_fragment_begin` — and its
 * map is read from here. The near map is used inside its own box, the far map
 * outside, and the two SHADOW TESTS are cross-faded across the border. What
 * changes at the seam is penumbra width (2.9 cm/texel to 21 cm/texel), which the
 * eye reads as distance. What does not change is how much key the surface gets.
 *
 * Indexing the arrays directly is safe because they are declared at the top of
 * this same chunk, and because Sky is the only thing in the game that creates a
 * DirectionalLight and adds the near one first (see `buildLights`).
 */
function cascadeShadowChunk(original: string): string {
  const helper = /* glsl */`
	#if NUM_DIR_LIGHT_SHADOWS > 1

		float krCascadeShadow() {

			vec4 nc = vDirectionalShadowCoord[ 0 ];
			vec3 ndc = nc.xyz / max( nc.w, 1e-6 );
			// distance to the near box's border, 0 at the centre and 1 at the face,
			// taken over depth as well as the two lateral axes so a fragment leaving
			// through the back of the frustum hands over just as smoothly
			vec3 krE = abs( ndc - 0.5 ) * 2.0;
			float krW = 1.0 - smoothstep( ${glslFloat(CASCADE_BLEND)}, 1.0,
				max( max( krE.x, krE.y ), krE.z ) );

			float krFar = getShadow(
				directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize,
				directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias,
				directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] );

			if ( krW <= 0.0 ) return krFar;

			float krNear = getShadow(
				directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize,
				directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias,
				directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );

			// Inside the box the near map is authoritative and complete: in LIGHT
			// space an occluder sits at the same xy as the surface it shadows, so
			// any caster of a fragment inside the box is also inside the box. There
			// is nothing for the far map to add here, and mixing it in would only
			// drag its 21 cm texels and its every-third-frame staleness forward.
			return mix( krFar, krNear, krW );

		}

	#endif
`;
  // Insert at file scope after every getShadow variant has been declared: the
  // last column-0 `#endif` closes `#ifdef USE_SHADOWMAP`.
  const at = original.lastIndexOf('\n#endif');
  if (at < 0) {
    console.warn('[sky] shadowmap_pars_fragment layout changed; cascade resolver skipped');
    return original;
  }
  return original.slice(0, at) + '\n' + helper + original.slice(at);
}

/**
 * Rewrite the directional-light loop in `lights_fragment_begin` so cascade 1 is
 * shadow-only and cascade 0 resolves both maps. Falls back to stock behaviour
 * whenever there is only one shadow-casting directional light, so the Medium and
 * Low paths (and any future third-party light) are untouched.
 *
 * `UNROLLED_LOOP_INDEX` and `NUM_DIR_LIGHT_SHADOWS` are both textually
 * substituted by three before the preprocessor ever sees them, which is what
 * lets a `#if` pick a different body per unrolled iteration — three's own code
 * in this chunk relies on exactly that.
 */
function cascadeLightsChunk(original: string): string {
  const head = '\tfor ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {\n';
  const tail = '\n\t}\n\t#pragma unroll_loop_end';
  const shadowLine = `		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;`;

  const h = original.indexOf(head);
  const t = h < 0 ? -1 : original.indexOf(tail, h);
  if (h < 0 || t < 0 || !original.slice(h, t).includes(shadowLine)) {
    console.warn('[sky] directional light loop moved; cascade selection skipped');
    return original;
  }

  const reLine = '		RE_Direct( directLight, geometryPosition, geometryNormal, ' +
    'geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

  // Cascade 0 resolves both maps itself.
  let body = original.slice(h + head.length, t).replace(shadowLine, `		directionalLightShadow = directionalLightShadows[ i ];
		#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? krCascadeShadow() : 1.0;
		#else
${shadowLine.split('\n')[1]}
		#endif`);

  // Two more things hang off this loop, both keyed on the unrolled index:
  //
  //  · Directional lights past the shadow-casting ones are the cool sky fill and
  //    the warm ground bounce. They cast nothing, which is what let them shine
  //    straight through a hillside; inside an interior volume they are cut.
  //    (Three sorts shadow casters to the front of the array, so the test is
  //    exactly "is this a fill".) When shadows are off entirely the sun itself
  //    lands in that bucket, which is also correct — with no map to occlude it,
  //    the volume is the only thing that can.
  //
  //  · Light 0 is always the key, and after it has been shaded and shadowed it
  //    is also the only correct source for a rim.
  if (body.includes(reLine)) {
    body = body.replace(reLine, `		#if ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )
		directLight.color *= 1.0 - krInterior * ${glslFloat(INTERIOR_FILL_CUT)};
		#endif

${reLine}

		#if ( UNROLLED_LOOP_INDEX == 0 ) && defined( STANDARD ) && defined( RE_Direct )
		reflectedLight.directSpecular += krSunRim( directLight.color, directLight.direction,
			geometryNormal, geometryViewDir, material.roughness );
		#endif`);
  } else {
    console.warn('[sky] RE_Direct call moved; rim and interior fill occlusion skipped');
  }

  // Cascade 1 drops out of the loop completely: no light info, no shadow test,
  // no RE_Direct. One BRDF evaluation per fragment cheaper than the rig this
  // replaces, which ran the full shading equation twice for one sun.
  const guarded = `		#if ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 1 )

		// shadow-only cascade: no energy, no BRDF; krCascadeShadow() reads its map

		#else
${body}
		#endif
`;
  return original.slice(0, h + head.length) + guarded + original.slice(t);
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

  /**
   * Key light — also published as `ctx.sun`. Carries 100% of the sun's energy
   * and owns the near shadow cascade. Anything sampling `ctx.sun.intensity` gets
   * the art bible's 4.2, not a fraction of it.
   */
  sun!: THREE.DirectionalLight;
  /**
   * Far cascade. A shadow-only slave: same direction, INTENSITY ZERO, present
   * purely so three renders and binds its map as `directionalShadowMap[1]` for
   * `krCascadeShadow` to read. Null below Quality.High.
   */
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
  private skyFill!: THREE.DirectionalLight;
  private bounce!: THREE.DirectionalLight;
  private interiorInstalled = false;
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

    // Before anything is drawn, therefore before any program is compiled. The
    // interior volume is filled in on the first frame; see buildInteriorVolume.
    this.installShaderPatches(null);
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
  private installShaderPatches(volume: InteriorVolume | null): void {
    const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
    if (_originalChunks === null) {
      _originalChunks = {};
      for (const name of PATCHED_CHUNKS) _originalChunks[name] = chunks[name];
    }
    const stock = _originalChunks;

    const fog = fogChunks(this.model, stock.fog_pars_fragment);
    for (const name of Object.keys(fog)) chunks[name] = fog[name];

    chunks.common = commonChunk(stock.common, volume);
    chunks.envmap_physical_pars_fragment =
      envDiffuseChunk(stock.envmap_physical_pars_fragment, DIFFUSE_ENV_INTENSITY);
    chunks.shadowmap_pars_fragment =
      cascadeShadowChunk(shadowBorderChunk(stock.shadowmap_pars_fragment));
    chunks.lights_pars_begin = stock.lights_pars_begin;
    chunks.lights_fragment_begin =
      interiorLightsChunk(cascadeLightsChunk(stock.lights_fragment_begin));
    chunks.lights_fragment_maps = interiorMapsChunk(stock.lights_fragment_maps);
  }

  /**
   * Fit the interior volume to the tunnel bore.
   *
   * This has to happen after `Track.init`, and Sky inits before Track because
   * everything downstream of Sky needs the env map and the key light at ITS
   * init. So the chunks go in twice: once at boot with an empty volume, so that
   * nothing can possibly compile against a half-built patch set, and once on the
   * first frame with the real one. Nothing has been rendered by then, so nothing
   * has been compiled either and the second install is free — the
   * `needsUpdate` sweep below is belt and braces for a future system that
   * decides to warm a shader during its own init.
   */
  private buildInteriorVolume(ctx: Ctx): InteriorVolume | null {
    const track = ctx.track;
    if (!track || !(track.length > 1)) return null;

    const pts: THREE.Vector3[] = [];
    const arc: number[] = [];
    const span = TUNNEL_T1 - TUNNEL_T0;
    // The bore geometry is built a touch outside the layout's t range; match it
    // so the volume covers the whole lining rather than stopping short of it.
    const t0 = TUNNEL_T0 - 0.005;
    let total = 0;
    for (let i = 0; i <= INTERIOR_SEGMENTS; i++) {
      const t = t0 + ((span + 0.01) * i) / INTERIOR_SEGMENTS;
      const p = track.sample(t - Math.floor(t)).pos.clone();
      // The centreline sits on the carriageway; the bore's mass is above it, so
      // lift the axis to the middle of the section. That keeps the capsule
      // radius honest instead of having to cover the crown from the floor.
      p.y += 3.4;
      if (i > 0) total += p.distanceTo(pts[i - 1]);
      pts.push(p);
      arc.push(total);
    }
    if (!(total > 1)) return null;

    const segments: InteriorSegment[] = [];
    for (let i = 0; i < INTERIOR_SEGMENTS; i++) {
      const a = pts[i], b = pts[i + 1];
      segments.push({
        ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z,
        s0: arc[i], s1: arc[i + 1],
      });
    }

    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(p);
    const c = box.getCenter(new THREE.Vector3());
    let radius = 0;
    for (const p of pts) radius = Math.max(radius, p.distanceTo(c));

    return {
      segments,
      cx: c.x, cy: c.y, cz: c.z,
      // The bounding sphere is a REJECT test, so it has to be generous: a
      // fragment is inside the volume out to INTERIOR_R_OUT off the axis.
      radius: radius + INTERIOR_R_OUT + 1,
      total,
    };
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
      fragmentShader: buildSkyFragmentShader(m),
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

    // The key is ONE light at full intensity. The second DirectionalLight below
    // is a shadow-only slave: three needs it to exist for its map to be rendered
    // and bound as `directionalShadowMap[1]`, but it contributes no energy and
    // `cascadeLightsChunk` skips its RE_Direct entirely. Nothing downstream can
    // ever see a step in key brightness at a cascade border again — and as a
    // side effect `ctx.sun.intensity` is finally the bible's 4.2, which is what
    // src/world/Water.ts scales its sun glitter by.
    const nearMap = q >= Quality.Ultra ? 4096 : q >= Quality.High ? 3072 : 2048;
    const nearExtent = twoCascades ? NEAR_EXTENT : SOLO_EXTENT;
    // 3072 over a 110 m box is 3.6 cm/texel — finer than the 4.2 cm the old
    // 130 m box gave, because the near cascade no longer has to be oversized to
    // push its own handoff out of frame.
    this.sun = this.makeCascade(ctx, SUN_INTENSITY, nearExtent, NEAR_DISTANCE,
      nearMap, shadows, -0.00004, twoCascades ? 0.022 : 0.05, 1, 3.0);
    this.sun.name = 'SunKeyNear';

    if (twoCascades) {
      this.sunFar = this.makeCascade(ctx, 0, FAR_EXTENT,
        FAR_DISTANCE, q >= Quality.Ultra ? 3072 : 2048, true,
        -0.00008, 0.35, FAR_UPDATE_INTERVAL, 3.0);
      this.sunFar.name = 'SunKeyFarShadowOnly';
    }

    // SH ambient projected from our own sky — strictly better than a hemisphere
    // light because it carries the azimuthal asymmetry (the side of an object
    // facing the sun's half of the sky picks up more skylight).
    this.probe = new THREE.LightProbe(
      this.model.projectSH(2048, PROBE_FILL_TINT), PROBE_INTENSITY);
    ctx.scene.add(this.probe);

    // The FILL. Cool, directional, from above and behind the sun's shoulder.
    // This and the key are the whole warm/cool axis of the frame; the bounce
    // below is a garnish and the IBL irradiance is a floor.
    //
    // Order matters: three sorts shadow casters to the front of the directional
    // array and is stable otherwise, so this and the bounce land after the
    // cascades and are picked up by the interior-occlusion test in
    // `cascadeLightsChunk`. Neither casts a shadow, and a light that casts
    // nothing has to be told where the walls are.
    this.skyFill = new THREE.DirectionalLight(SKY_FILL_COLOR, SKY_FILL_INTENSITY);
    this.skyFill.position.copy(SKY_FILL_DIRECTION).multiplyScalar(100);
    this.skyFill.castShadow = false;
    this.skyFill.name = 'SkyFill';
    ctx.scene.add(this.skyFill);
    ctx.scene.add(this.skyFill.target);

    // Warm bounce from the sand and stone below, tilted toward the sun's
    // azimuth because that is the ground actually receiving the key.
    this.bounce = new THREE.DirectionalLight(GROUND_BOUNCE_COLOR, BOUNCE_INTENSITY);
    this.bounce.position.set(this.sunDirection.x * 0.55, -1, this.sunDirection.z * 0.55)
      .normalize().multiplyScalar(100);
    this.bounce.castShadow = false;
    this.bounce.name = 'GroundBounce';
    ctx.scene.add(this.bounce);
    ctx.scene.add(this.bounce.target);
  }

  private makeCascade(
    ctx: Ctx, intensity: number, extent: number, distance: number,
    mapSize: number, shadows: boolean, bias: number, normalBias: number, interval: number,
    radius: number,
  ): THREE.DirectionalLight {
    const light = new THREE.DirectionalLight(SUN_LIGHT_COLOR, intensity);
    light.position.copy(this.sunDirection).multiplyScalar(distance);
    light.castShadow = shadows;

    if (shadows) {
      const s = light.shadow;
      s.mapSize.set(mapSize, mapSize);
      s.bias = bias;
      s.normalBias = normalBias;
      s.radius = radius;
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
    if (!this.interiorInstalled) {
      this.interiorInstalled = true;
      const volume = this.buildInteriorVolume(ctx);
      if (volume !== null) {
        this.installShaderPatches(volume);
        // Nothing has rendered yet, so nothing has compiled and this sweep is a
        // no-op — but it is the difference between "correct" and "correct as
        // long as no one warms a shader during init".
        ctx.scene.traverse((o) => {
          const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) for (const m of mat) m.needsUpdate = true;
          else if (mat) mat.needsUpdate = true;
        });
      } else {
        console.warn('[sky] track unavailable; tunnel interior will not be occluded');
      }
    }

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
    if (this.frame === 1) this.checkCascadeOrder(ctx);
    this.frame++;
  }

  /**
   * `krCascadeShadow` reads `directionalShadowMap[0]` as the near cascade and
   * `[1]` as the far one. Three fills those arrays in scene-traversal order, and
   * Sky adds the near light first and is the only thing in the game that creates
   * a DirectionalLight — but that is an invariant, not a guarantee, so say so
   * out loud the moment anything else joins the list. Runs once, on frame 1,
   * after every system has finished building.
   */
  private checkCascadeOrder(ctx: Ctx): void {
    if (this.cascades.length < 2) return;
    const lights: THREE.DirectionalLight[] = [];
    ctx.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (l.isDirectionalLight) lights.push(l);
    });
    const ok = lights[0] === this.sun && lights[1] === this.sunFar
      && !lights.slice(2).some((l) => l.castShadow);
    if (!ok) {
      console.warn('[sky] directional light order changed. krCascadeShadow reads ' +
        'directionalShadowMap[0] as the near cascade and [1] as the far one, and three ' +
        'fills that array in scene-traversal order with shadow casters first. Shadows ' +
        'will be wrong until the new light is added after Sky\'s two.');
    }
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
    this.skyFill?.parent?.remove(this.skyFill);
    this.bounce?.parent?.remove(this.bounce);
  }
}
