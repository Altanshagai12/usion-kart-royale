/**
 * ============================================================================
 *  Shader pre-warm.
 * ============================================================================
 *  three compiles a GPU program the first time a material is actually rendered.
 *  That compile is synchronous on the GL thread, and a big one blows the frame
 *  budget several times over — measured here at up to 56ms, against a 16.7ms
 *  budget. The browser then misses its compositing deadline and presents a
 *  partially-updated surface, which the player sees as part of the screen
 *  flashing black.
 *
 *  It shows up exactly where a new material first appears: picking up an item,
 *  firing a shell, the first explosion, or turning into a stretch of circuit
 *  whose props have not been on screen before. Nine programs were still
 *  compiling during the first half-minute of racing.
 *
 *  So every program is compiled up front instead, before the first frame is
 *  presented. Three things make this less trivial than calling `compileAsync`:
 *
 *  1. Pooled and deferred objects — items, projectiles, particle bursts — sit
 *     in the scene with `visible = false`. `compile()` walks materials with a
 *     plain `traverse` so visibility does not actually matter for them, but it
 *     gathers LIGHTS with `traverseVisible`, and the light counts are part of
 *     the program cache key. So everything is made visible for the duration of
 *     the warm-up and restored after, or a hidden light silently changes the
 *     key of every lit material in the scene.
 *  2. A material's program depends on the LIGHTS it is rendered with and on
 *     which shadow cascades exist, so the warm-up has to run against the real
 *     scene and the real camera, after lighting is built — not against a
 *     throwaway scene.
 *  3. **The program cache key depends on the framebuffer being rendered into.**
 *     This is what round 7 was still leaking three programs through, and it is
 *     worth spelling out because it is invisible from the call site.
 *
 *     `WebGLPrograms.getParameters()` reads `renderer.getRenderTarget()` twice:
 *
 *       outputColorSpace: currentRenderTarget === null
 *         ? renderer.outputColorSpace          // 'srgb'
 *         : ColorManagement.workingColorSpace  // 'srgb-linear'
 *       toneMapping: material.toneMapped && currentRenderTarget === null
 *         ? renderer.toneMapping : NoToneMapping
 *
 *     Both go straight into `getProgramCacheKey`. `renderer.compile()` does not
 *     bind anything, so a pre-warm run at boot compiles every material for the
 *     DEFAULT FRAMEBUFFER — sRGB output, ACES tone map baked into the shader.
 *     The game never renders there: `RenderPipeline` hands the scene to the
 *     post-processing composer, whose RenderPass binds an HDR render target, so
 *     every material's real program is the linear / NoToneMapping variant.
 *
 *     Every program compiled by the old pre-warm was therefore the wrong one,
 *     and the right one was still built lazily on first render. Most materials
 *     hid that because their meshes are on screen during the first few frames,
 *     behind the boot curtain and before the measurement window opens. The ones
 *     that do not — the tunnel bore, the tunnel light strip, the arched bridge —
 *     are frustum-culled until the player physically arrives at them, so their
 *     compile landed mid-race. That is the 56ms frame.
 *
 *     The fix is to bind a render target for the duration of the compile so the
 *     two key inputs match the real scene pass. Any non-XR target will do: only
 *     `=== null` is tested, never the target's size or format, so a 1x1 scratch
 *     buffer produces exactly the programs the composer will ask for.
 *
 *  Subsystems that own a material which is NOT reachable from the scene graph
 *  at boot — an art set for a projectile kind that has never spawned, say —
 *  push it through `registerPrewarm()`. Anything registered that the scene walk
 *  does not already account for gets a throwaway host object for the duration
 *  of the pass. Nothing is ever drawn through it: `compileAsync` builds programs
 *  and never issues a draw call, so a host with none of the material's custom
 *  attributes is perfectly safe.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';

export interface PrewarmResult {
  programsBefore: number;
  programsAfter: number;
  objectsRevealed: number;
  /** labels of materials nothing in the scene referenced, so we hosted them */
  materialsCaged: string[];
  /** which framebuffer(s) the compile ran against */
  surfaces: string[];
  ms: number;
}

// ---------------------------------------------------------------------------
//  Registry
// ---------------------------------------------------------------------------

interface Request {
  material: THREE.Material;
  /** true if the material is ever drawn through an InstancedMesh */
  instanced: boolean;
  label: string;
}

const REQUESTS: Request[] = [];

/**
 * Declare a material that MUST have a compiled program before the first frame.
 *
 * Call this for anything built at init but not attached to an object in the
 * scene — a pooled art set, or a variant only one code path ever reaches.
 * Materials already on a mesh in the scene may be registered too; the pass sees
 * they are covered and skips them, so registering is always safe and is the
 * cheapest way to make the guarantee explicit rather than incidental.
 *
 * @param instanced pass true when the material's only real host is an
 *   `InstancedMesh` — `instancing` is part of the program cache key, and a
 *   plain host would compile the wrong variant.
 */
export function registerPrewarm(
  material: THREE.Material | null | undefined,
  opts: { instanced?: boolean; label?: string } = {},
): void {
  if (!material) return;
  const instanced = opts.instanced === true;
  for (const r of REQUESTS) if (r.material === material && r.instanced === instanced) return;
  REQUESTS.push({
    material,
    instanced,
    label: opts.label ?? (material.name || material.type),
  });
}

/** Drop every registration. Only a full teardown/rebuild should need this. */
export function clearPrewarmRegistry(): void {
  REQUESTS.length = 0;
}

/**
 * One degenerate triangle carrying the three attributes every stock three
 * shader expects. Custom attributes an injected shader declares (`aTint`,
 * `aUv`, the particle interleaved block) may be absent: an undeclared vertex
 * attribute reads as zero in GL and compiles fine, and this geometry is never
 * drawn through.
 */
function hostGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
  g.setIndex([0, 1, 2]);
  return g;
}

/**
 * Does the scene pass render into a target, or straight to the canvas?
 *
 * `RenderPipeline` publishes itself on `globalThis.__render` (the same contract
 * the perf and capture harnesses use) and exposes `composer`, which is non-null
 * exactly when the scene is rasterised into the composer's HDR buffer. Reading
 * it here rather than importing the pipeline keeps this module free of a
 * dependency on the renderer's internals — and if it is not there we simply
 * warm both surfaces rather than guess.
 */
function scenePassSurface(): 'target' | 'canvas' | 'unknown' {
  try {
    const pipe = (globalThis as { __render?: { composer?: unknown } }).__render;
    if (pipe && typeof pipe === 'object' && 'composer' in pipe) {
      return pipe.composer ? 'target' : 'canvas';
    }
  } catch {
    /* fall through to the both-surfaces path */
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------

export async function prewarm(ctx: Ctx): Promise<PrewarmResult> {
  const t0 = performance.now();
  const renderer = ctx.renderer;
  const programsBefore = renderer.info.programs?.length ?? 0;

  // Reveal everything hidden, remembering what to put back. Pooled effects and
  // unspawned items are invisible by default; more importantly, `compile()`
  // collects lights with `traverseVisible`, and the light counts are in the
  // cache key of every lit material.
  const hidden: THREE.Object3D[] = [];
  ctx.scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });

  // Which materials the scene walk will already cover.
  const present = new Set<THREE.Material>();
  ctx.scene.traverse((o) => {
    const m = (o as Partial<THREE.Mesh>).material;
    if (Array.isArray(m)) for (const x of m) present.add(x);
    else if (m) present.add(m);
  });

  // Host anything registered that nothing in the scene refers to.
  const cage = new THREE.Group();
  cage.name = 'prewarm-hosts';
  const materialsCaged: string[] = [];
  let geo: THREE.BufferGeometry | null = null;
  for (const r of REQUESTS) {
    if (present.has(r.material)) continue;
    if (geo === null) geo = hostGeometry();
    const host = r.instanced
      ? new THREE.InstancedMesh(geo, r.material, 1)
      : new THREE.Mesh(geo, r.material);
    host.frustumCulled = false;
    host.castShadow = true;
    host.receiveShadow = true;
    cage.add(host);
    present.add(r.material);
    materialsCaged.push(r.label);
  }
  if (cage.children.length > 0) ctx.scene.add(cage);

  // Frustum culling is not applied by the compiler, but layers are: an object
  // the camera cannot see on its layer mask is skipped. Widen for the pass.
  const cameraLayers = ctx.camera.layers.mask;
  ctx.camera.layers.enableAll();

  // Bind the framebuffer the scene is really rasterised into, so the compiled
  // programs carry the same `outputColorSpace` and `toneMapping` the first real
  // render will ask for. See the header — this is the whole ballgame.
  const prevTarget = renderer.getRenderTarget();
  const prevCubeFace = renderer.getActiveCubeFace();
  const prevMip = renderer.getActiveMipmapLevel();
  let scratch: THREE.WebGLRenderTarget | null = null;
  const surfaces: string[] = [];

  try {
    const surface = scenePassSurface();
    // Only `=== null` is ever tested, so the scratch target's size and format
    // are irrelevant; 1x1 costs four bytes and one framebuffer object.
    // If we cannot tell, warm both and finish on the target variant: whichever
    // one three primed LAST is the one `materialProperties.currentProgram`
    // points at, and the composer path is the one every WebGL2 device takes.
    // Landing on the wrong one still costs only a cache lookup on frame 1, not
    // a compile — both programs exist by then.
    const order: ('target' | 'canvas')[] =
      surface === 'unknown' ? ['canvas', 'target'] : [surface];
    for (const s of order) {
      if (s === 'target') {
        if (scratch === null) scratch = new THREE.WebGLRenderTarget(1, 1);
        renderer.setRenderTarget(scratch);
      } else {
        renderer.setRenderTarget(null);
      }
      surfaces.push(s);
      // compileAsync uses KHR_parallel_shader_compile where available, so the
      // compiles overlap instead of serialising — worth the async plumbing.
      await renderer.compileAsync(ctx.scene, ctx.camera);
    }
  } catch (err) {
    // A failed pre-warm must never stop the game booting; the worst case is
    // simply the hitching we had before.
    console.warn('[prewarm] compile failed, continuing without it', err);
  } finally {
    renderer.setRenderTarget(prevTarget, prevCubeFace, prevMip);
    scratch?.dispose();
  }

  ctx.camera.layers.mask = cameraLayers;
  if (cage.parent !== null) cage.removeFromParent();
  cage.clear();
  geo?.dispose();
  for (const o of hidden) o.visible = false;

  // The surface is the part worth seeing in a log: 'canvas' where the composer
  // is live means the pre-warm is compiling programs the game will never use.
  console.info(
    `[prewarm] surface=${surfaces.join('+') || 'none'}` +
    (materialsCaged.length ? ` hosted=[${materialsCaged.join(', ')}]` : ''),
  );

  return {
    programsBefore,
    programsAfter: renderer.info.programs?.length ?? 0,
    objectsRevealed: hidden.length,
    materialsCaged,
    surfaces,
    ms: Math.round(performance.now() - t0),
  };
}
