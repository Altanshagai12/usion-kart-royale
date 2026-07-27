/**
 * Minimap — the real centreline from ITrack.minimapPath(), normalised by
 * ITrack.bounds.
 *
 * ROUND 2 REBUILD. The round-1 map failed the only job it has: the track was a
 * thick cream ribbon with a fake bevel (bright highlight upper-left, dark brown
 * lower-right) whose stroke was so heavy that every corner radius was
 * swallowed — the tunnel, the bridge, the village esses and the banked 180 all
 * collapsed into one featureless bean, so the map never matched the track in
 * front of you. Three unrelated marker idioms (arrow, checkered lozenge,
 * yellow chevron) shared one 226 px widget, and a bunched field piled into a
 * single knot.
 *
 * So: a flat single-colour centreline at a hairline weight with one darker
 * casing, no bevel, no gradient, no glow, no bands, no dashes; twice the
 * sample count; ONE marker idiom (a cased dot, the player's larger and
 * ringed); a two-pixel start/finish tick perpendicular to the ribbon; and a
 * repulsion pass that fans a tight pack out along the local track normal.
 *
 * The ribbon is baked once into an offscreen canvas and blitted each frame;
 * only the racer dots are re-rasterised per frame.
 */
import type { Ctx, IKart } from '../types';
import { el, clamp, cssColor } from './uiUtil';

/** 4x the round-1 sample density — this is what lets the esses survive. */
const SAMPLES = 720;
const PAD = 0.055; // fraction of the panel reserved as margin

/**
 * Ribbon and marker weights, in CSS px at the reference panel height. They are
 * scaled by `this.u` (panel height / REF_H) so a 720p and a 1440p frame get the
 * same PROPORTIONS rather than the same pixels — a fixed pixel stroke goes
 * hairline on a large panel and rope-like on a small one.
 */
const REF_H = 162;
const TRACK_W = 3.0;
const TRACK_CASE = 2.0;   // total, 1 px each side
const TRACK_COL = '#dcd3c0';
const CASE_COL = 'rgba(5, 8, 18, 0.95)';

/** Dot radii. Player is 1.6x a rival and carries a white ring. */
const RIVAL_R = 3.4;
const PLAYER_R = RIVAL_R * 1.6;
/** minimum centre-to-centre separation as a multiple of the summed radii */
const SEPARATION = 1.4;

export class Minimap {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private baseG: CanvasRenderingContext2D;

  private path: { x: number; z: number }[] = [];
  private built = false;
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** device px per reference CSS px — dpr folded together with panel scale */
  private u = 1;

  // world -> canvas mapping
  private sx = 1;
  private cx = 0;
  private cz = 0;
  private ox = 0;
  private oy = 0;

  /** cached livery colours, so we never build a string in the draw loop */
  private colors: string[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'kr-map kr-plate', parent);
    this.canvas = el('canvas', undefined, this.root);
    this.g = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.baseG = this.base.getContext('2d')!;
  }

  private tryBuild(ctx: Ctx) {
    const b = ctx.track.bounds;
    const dx = b.max.x - b.min.x;
    const dz = b.max.z - b.min.z;
    if (!(dx > 1) || !(dz > 1)) return false;
    this.path = ctx.track.minimapPath(SAMPLES);
    if (this.path.length < 8) return false;
    this.cx = (b.min.x + b.max.x) * 0.5;
    this.cz = (b.min.z + b.max.z) * 0.5;
    this.spanX = dx;
    this.spanZ = dz;
    this.built = true;
    this.colors = ctx.race.karts.map((k) => cssColor(k.stats.color));
    return true;
  }

  private spanX = 1;
  private spanZ = 1;

  /**
   * The panel is HEIGHT-driven now: it sits in the bottom rail alongside the
   * item box and the speedometer, and all three are exactly --rail tall. The
   * width follows the track's own aspect, so a wide circuit gets a wide panel
   * instead of a square one that wastes half its area.
   */
  resize() {
    const cs = getComputedStyle(this.root);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cssH = this.root.getBoundingClientRect().height - padY;
    if (cssH < 32) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    const aspect = this.built
      ? Math.min(2.2, Math.max(1.15, this.spanX / this.spanZ))
      : 1.5;
    const cssW = cssH * aspect;

    this.w = Math.round(cssW * this.dpr);
    this.h = Math.round(cssH * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.u = this.dpr * clamp(cssH / REF_H, 0.68, 1.9);
    this.base.width = this.w;
    this.base.height = this.h;
    if (this.built) this.bake();
  }

  private project(x: number, z: number, out: { x: number; y: number }) {
    out.x = this.ox + (x - this.cx) * this.sx;
    out.y = this.oy + (z - this.cz) * this.sx;
  }

  /** Bake the static ribbon. Called on build and on resize. */
  private bake() {
    const g = this.baseG;
    const W = this.w, H = this.h;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.built || W < 4) return;

    const usableW = W * (1 - PAD * 2);
    const usableH = H * (1 - PAD * 2);
    this.sx = Math.min(usableW / this.spanX, usableH / this.spanZ);
    this.ox = W * 0.5;
    this.oy = H * 0.5;

    const p = this.path;
    const n = p.length;
    const s = this.scratch;
    const d = this.u;

    const trace = () => {
      g.beginPath();
      this.project(p[0].x, p[0].z, s);
      g.moveTo(s.x, s.y);
      for (let i = 1; i < n; i++) {
        this.project(p[i].x, p[i].z, s);
        g.lineTo(s.x, s.y);
      }
      g.closePath();
    };

    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Two strokes, total. A casing and a flat body — no glow, no bevel, no
    // value bands, no centre dashes. At this weight a 12 m corner radius is
    // four pixels of arc instead of one pixel of arc inside eleven pixels of
    // rope, which is the whole reason the esses and the banked 180 now read.
    trace();
    g.strokeStyle = CASE_COL;
    g.lineWidth = (TRACK_W + TRACK_CASE) * d;
    g.stroke();

    trace();
    g.strokeStyle = TRACK_COL;
    g.lineWidth = TRACK_W * d;
    g.stroke();

    // Start/finish: a tick across the ribbon, not a rotated checkered lozenge.
    // One idiom per widget.
    this.project(p[0].x, p[0].z, s);
    const ax = s.x, ay = s.y;
    this.project(p[3 % n].x, p[3 % n].z, s);
    let tx = s.x - ax, ty = s.y - ay;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty * (TRACK_W + TRACK_CASE) * 1.9 * d;
    const ny = tx * (TRACK_W + TRACK_CASE) * 1.9 * d;
    g.beginPath();
    g.moveTo(ax - nx, ay - ny);
    g.lineTo(ax + nx, ay + ny);
    g.lineCap = 'butt';
    g.lineWidth = 4 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
    g.lineWidth = 2 * d;
    g.strokeStyle = '#fbf5e6';
    g.stroke();
    g.lineCap = 'round';
  }

  private scratch = { x: 0, y: 0 };

  /** Per-kart plot state, allocated once and reused every frame. */
  private px: number[] = [];
  private py: number[] = [];
  /** unit perpendicular to each kart's heading, in canvas space */
  private nx: number[] = [];
  private ny: number[] = [];
  /** how far each dot has been nudged off its true position, canvas px */
  private off: number[] = [];
  /** draw order, back of the field first. Allocated once. */
  private order: number[] = [];

  update(ctx: Ctx) {
    if (!this.built) {
      if (!this.tryBuild(ctx)) return;
      this.resize();
    }
    const g = this.g;
    const W = this.w, H = this.h;
    if (W < 4) return;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.drawImage(this.base, 0, 0);

    const d = this.u;
    const karts = ctx.race.karts;
    const player = ctx.race.player;
    const s = this.scratch;
    const n = karts.length;

    const rivalR = RIVAL_R * d;
    const playerR = PLAYER_R * d;

    // --- project, then de-overlap ------------------------------------------
    // Dots that land on top of each other are pushed apart along the local
    // track normal (each kart's own heading rotated 90°), which is the
    // direction real karts are separated in — so a bunched pack fans out
    // across the road instead of collapsing into one indistinct knot.
    const px = this.px, py = this.py, nx = this.nx, ny = this.ny, off = this.off;
    for (let i = 0; i < n; i++) {
      const k = karts[i];
      this.project(k.position.x, k.position.z, s);
      px[i] = s.x; py[i] = s.y;
      const f = k.forward;
      // world +x -> canvas +x and world +z -> canvas +y, so the perpendicular
      // of (f.x, f.z) in canvas space is (-f.z, f.x)
      const ax = -f.z, ay = f.x;
      const l = Math.hypot(ax, ay) || 1;
      nx[i] = ax / l; ny[i] = ay / l;
      off[i] = 0;
    }

    const maxOff = rivalR * 5.0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const ri = karts[i] === player ? playerR : rivalR;
        for (let j = i + 1; j < n; j++) {
          const rj = karts[j] === player ? playerR : rivalR;
          const minD = (ri + rj) * SEPARATION;
          const dx = px[j] - px[i], dy = py[j] - py[i];
          const dist = Math.hypot(dx, dy);
          if (dist >= minD) continue;
          const push = (minD - dist) * 0.5;
          const sgn = (dx * nx[i] + dy * ny[i]) >= 0 ? 1 : -1;
          const oi = clamp(off[i] - push * sgn, -maxOff, maxOff);
          const oj = clamp(off[j] + push * sgn, -maxOff, maxOff);
          px[i] += (oi - off[i]) * nx[i]; py[i] += (oi - off[i]) * ny[i];
          px[j] += (oj - off[j]) * nx[j]; py[j] += (oj - off[j]) * ny[j];
          off[i] = oi; off[j] = oj;
        }
      }
    }

    // --- depth sort by race position ---------------------------------------
    // Back of the field first, leader last, player last of all. Round 1 drew
    // in kart order, so whoever happened to be later in the array covered the
    // dot underneath — in one review frame the orange and blue dots were
    // exactly superimposed and one was entirely invisible.
    // Insertion sort in place: n is eight, and a comparator closure would be a
    // per-frame allocation in the hot path (§8).
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    for (let i = 1; i < n; i++) {
      const v = order[i];
      const pv = karts[v].place | 0;
      let j = i - 1;
      while (j >= 0 && (karts[order[j]].place | 0) < pv) { order[j + 1] = order[j]; j--; }
      order[j + 1] = v;
    }

    const pp = player ? player.place : 0;
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      const k = karts[i];
      if (k === player) continue;
      const battle = pp > 0 && (k.place === pp - 1 || k.place === pp + 1);
      this.dot(g, px[i], py[i], rivalR, this.colors[i] || '#ffffff', k.starTime > 0, battle, d);
    }

    if (player) {
      const i = karts.indexOf(player);
      this.playerDot(g, px[i], py[i], playerR, player, d);
    }
  }

  /** One idiom: a flat livery disc with a one-pixel dark casing. */
  private dot(
    g: CanvasRenderingContext2D, x: number, y: number, r: number,
    color: string, glow: boolean, battle: boolean, d: number,
  ) {
    if (glow) {
      g.beginPath();
      g.arc(x, y, r * 2.0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,228,130,0.55)';
      g.fill();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 1 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
    if (battle) {
      g.beginPath();
      g.arc(x, y, r + 2.2 * d, 0, Math.PI * 2);
      g.lineWidth = 1.4 * d;
      g.strokeStyle = '#ffcf6b';
      g.stroke();
    }
  }

  /**
   * The player: same flat construction, 1.6x the radius, plus a white ring so
   * it is findable in a pack, plus a heading pip so the marker still says
   * which way you are pointing. No pulse halo, no gradient, no specular — the
   * whole widget is one flat idiom now.
   */
  private playerDot(
    g: CanvasRenderingContext2D, x: number, y: number, r: number, k: IKart, d: number,
  ) {
    const f = k.forward;
    const a = Math.atan2(f.z, f.x);

    g.save();
    g.translate(x, y);
    g.rotate(a);
    // heading pip, drawn first so the disc caps it cleanly
    g.beginPath();
    g.moveTo(r * 0.4, 0);
    g.lineTo(r * 2.05, 0);
    g.lineWidth = 3.4 * d;
    g.lineCap = 'round';
    g.strokeStyle = CASE_COL;
    g.stroke();
    g.lineWidth = 1.8 * d;
    g.strokeStyle = '#fffdf6';
    g.stroke();
    g.restore();

    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = '#fffdf6';
    g.fill();
    g.lineWidth = 1 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
    g.beginPath();
    g.arc(x, y, r + 2.4 * d, 0, Math.PI * 2);
    g.lineWidth = 2 * d;
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.stroke();
  }
}
