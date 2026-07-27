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
 *  presented. Two things make this less trivial than calling `compileAsync`:
 *
 *  1. Pooled and deferred objects — items, projectiles, particle bursts — sit
 *     in the scene with `visible = false`, and the compiler skips them. They
 *     are made visible for the duration of the warm-up and restored after.
 *  2. A material's program depends on the LIGHTS it is rendered with and on
 *     which shadow cascades exist, so the warm-up has to run against the real
 *     scene and the real camera, after lighting is built — not against a
 *     throwaway scene.
 * ============================================================================
 */
import * as THREE from 'three';
import type { Ctx } from '../types';

export interface PrewarmResult {
  programsBefore: number;
  programsAfter: number;
  objectsRevealed: number;
  ms: number;
}

export async function prewarm(ctx: Ctx): Promise<PrewarmResult> {
  const t0 = performance.now();
  const renderer = ctx.renderer;
  const programsBefore = renderer.info.programs?.length ?? 0;

  // Reveal everything hidden, remembering what to put back. Pooled effects and
  // unspawned items are invisible by default and would otherwise compile later,
  // mid-race, which is the entire bug.
  const hidden: THREE.Object3D[] = [];
  ctx.scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });

  // Frustum culling is not applied by the compiler, but layers are: an object
  // the camera cannot see on its layer mask is skipped. Widen for the pass.
  const cameraLayers = ctx.camera.layers.mask;
  ctx.camera.layers.enableAll();

  try {
    // compileAsync uses KHR_parallel_shader_compile where available, so the
    // compiles overlap instead of serialising — worth the async plumbing.
    await renderer.compileAsync(ctx.scene, ctx.camera);
  } catch (err) {
    // A failed pre-warm must never stop the game booting; the worst case is
    // simply the hitching we had before.
    console.warn('[prewarm] compile failed, continuing without it', err);
  }

  ctx.camera.layers.mask = cameraLayers;
  for (const o of hidden) o.visible = false;

  return {
    programsBefore,
    programsAfter: renderer.info.programs?.length ?? 0,
    objectsRevealed: hidden.length,
    ms: Math.round(performance.now() - t0),
  };
}
