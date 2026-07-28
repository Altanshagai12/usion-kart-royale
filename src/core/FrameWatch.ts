/**
 * ============================================================================
 *  Frame-integrity watchdog.  Enable with ?debug=frames
 * ============================================================================
 *  The player reports intermittent "black partial renders" on desktop Chrome
 *  that no headless capture reproduces — 50 back-to-back screenshots came back
 *  clean, and every layer agreed on its size. An artifact that only exists on
 *  the live present path cannot be debugged from the outside, so this measures
 *  it from the inside, against the real drawing buffer, on the machine that
 *  actually shows it.
 *
 *  It is off unless asked for. `readPixels` forces a GPU sync, which is exactly
 *  the stall we spend the rest of the codebase avoiding, so this reads ONE row
 *  — a single call per sampled frame — and only every Nth frame.
 *
 *  A tear shows up as a long run of near-black along that row. The row is at
 *  55% height, which crosses road, karts and scenery in every camera pose, so a
 *  legitimately dark frame is unlikely and a large black band is unmissable.
 *
 *  On a hit it records the canvas and composer dimensions alongside, because
 *  the leading theory is a size disagreement, and prints a compact report to the
 *  console. `window.__frameWatch` holds the record for copy-paste.
 * ============================================================================
 */
import type { Ctx } from '../types';

export interface TearRecord {
  frame: number;
  t: number;
  /** longest unbroken run of near-black pixels along the sampled row */
  runPx: number;
  runFrac: number;
  startX: number;
  bufW: number;
  bufH: number;
  cssW: number;
  cssH: number;
  composer: string;
  pixelRatio: number;
}

const SAMPLE_EVERY = 3;
const DARK = 6;
/** a run longer than this fraction of the row is a tear, not scene content */
const TEAR_FRAC = 0.12;

export class FrameWatch {
  enabled = false;
  readonly tears: TearRecord[] = [];
  private row: Uint8Array | null = null;
  private rowW = 0;
  private frames = 0;
  private reported = 0;

  init(ctx: Ctx) {
    this.enabled = new URLSearchParams(location.search).get('debug') === 'frames';
    if (!this.enabled) return;
    (window as any).__frameWatch = this;
    console.info(
      '%c[frame-watch] on — sampling the drawing buffer for partial-black presents.\n' +
      'Play until you see a black flash, then run: copy(JSON.stringify(__frameWatch.tears))',
      'color:#ffb020;font-weight:bold',
    );
  }

  /** Called immediately after the present, once the frame is on the buffer. */
  afterPresent(ctx: Ctx) {
    if (!this.enabled) return;
    if (++this.frames % SAMPLE_EVERY !== 0) return;

    const canvas = ctx.renderer.domElement;
    const w = canvas.width, h = canvas.height;
    if (w < 8 || h < 8) {
      // A degenerate buffer IS the bug; record it without trying to read it.
      this.record(ctx, { runPx: w, runFrac: 1, startX: 0 });
      return;
    }

    const gl = ctx.renderer.getContext();
    if (gl.isContextLost()) return;
    if (!this.row || this.rowW !== w) {
      this.row = new Uint8Array(w * 4);
      this.rowW = w;
    }
    const row = this.row;
    // Bind the default framebuffer explicitly: whatever the last pass left bound
    // is not necessarily what the user is looking at.
    ctx.renderer.setRenderTarget(null);
    gl.readPixels(0, Math.floor(h * 0.55), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);

    let run = 0, best = 0, start = -1, bestStart = -1;
    for (let x = 0; x < w; x++) {
      const l = (row[x * 4] + row[x * 4 + 1] + row[x * 4 + 2]) / 3;
      if (l <= DARK) {
        if (run === 0) start = x;
        run++;
        if (run > best) { best = run; bestStart = start; }
      } else run = 0;
    }
    if (best > w * TEAR_FRAC) {
      this.record(ctx, { runPx: best, runFrac: best / w, startX: bestStart });
    }
  }

  private record(ctx: Ctx, hit: { runPx: number; runFrac: number; startX: number }) {
    const canvas = ctx.renderer.domElement;
    const pipe = (globalThis as any).__render;
    const rt = pipe?.composer?.inputBuffer;
    const rec: TearRecord = {
      frame: ctx.frame,
      t: +ctx.time.toFixed(2),
      runPx: hit.runPx,
      runFrac: +hit.runFrac.toFixed(3),
      startX: hit.startX,
      bufW: canvas.width,
      bufH: canvas.height,
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      composer: rt ? `${rt.width}x${rt.height}` : '(none)',
      pixelRatio: ctx.renderer.getPixelRatio(),
    };
    this.tears.push(rec);
    // Cap, so a permanently black frame does not fill memory with evidence of
    // itself.
    if (this.tears.length > 200) this.tears.shift();
    if (this.reported++ < 20) {
      console.warn(
        `[frame-watch] partial-black frame ${rec.frame} @${rec.t}s — ` +
        `${(rec.runFrac * 100).toFixed(0)}% of the row from x=${rec.startX}; ` +
        `buffer ${rec.bufW}x${rec.bufH}, css ${rec.cssW}x${rec.cssH}, ` +
        `composer ${rec.composer}, dpr ${rec.pixelRatio}`,
      );
    }
  }
}
