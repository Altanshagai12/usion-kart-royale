/**
 * Minimap — the real centreline from ITrack.minimapPath(), normalised by
 * ITrack.bounds and drawn as a layered ribbon (ink casing → road → centre
 * dashes) with a warm outer glow, so it reads as a piece of track rather than
 * a polyline. The ribbon is baked once into an offscreen canvas and blitted
 * each frame; only the racer dots are re-rasterised per frame.
 */
import type { Ctx, IKart } from '../types';
import { el, clamp, cssColor } from './uiUtil';

const SAMPLES = 320;
const PAD = 0.085; // fraction of the panel reserved as margin

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

  /**
   * The track publishes its bounds during its own init, which runs before ours,
   * but we still tolerate a degenerate box by simply retrying on a later frame.
   */
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

  resize() {
    // measure the canvas, not the panel: the panel's padding is part of its box
    const cssW = this.canvas.getBoundingClientRect().width;
    if (cssW < 40) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    // The panel aspect follows the track's own aspect, clamped so a very long
    // circuit doesn't produce a letterbox slot.
    const aspect = this.built
      ? Math.min(1.35, Math.max(0.6, this.spanX / this.spanZ))
      : 1.25;
    const cssH = cssW / aspect;

    this.w = Math.round(cssW * this.dpr);
    this.h = Math.round(cssH * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.canvas.style.height = cssH + 'px';
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

    const unit = Math.max(1, Math.min(W, H) / 120);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    // 1 — warm outer glow, two passes so the falloff is not a hard halo
    trace();
    g.strokeStyle = 'rgba(255, 186, 96, 0.20)';
    g.lineWidth = unit * 11;
    g.stroke();
    g.strokeStyle = 'rgba(255, 206, 130, 0.28)';
    g.lineWidth = unit * 6.5;
    g.stroke();

    // 2 — ink casing (the drop the ribbon sits in)
    trace();
    g.strokeStyle = 'rgba(9, 12, 24, 0.86)';
    g.lineWidth = unit * 4.6;
    g.stroke();

    // 3 — road body, gradient so the far side of the circuit sits back
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#f6e8cd');
    grd.addColorStop(0.55, '#e6d2ad');
    grd.addColorStop(1, '#c9ab7e');
    trace();
    g.strokeStyle = grd;
    g.lineWidth = unit * 3.1;
    g.stroke();

    // 4 — centre dashes
    trace();
    g.strokeStyle = 'rgba(70, 52, 34, 0.42)';
    g.lineWidth = unit * 0.62;
    g.setLineDash([unit * 2.6, unit * 2.6]);
    g.stroke();
    g.setLineDash([]);

    // 5 — start/finish, drawn perpendicular to the first segment
    this.project(p[0].x, p[0].z, s);
    const ax = s.x, ay = s.y;
    this.project(p[2 % n].x, p[2 % n].z, s);
    let tx = s.x - ax, ty = s.y - ay;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    g.save();
    g.translate(ax, ay);
    g.rotate(Math.atan2(ny, nx));
    const cell = unit * 1.75;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) & 1 ? '#1a1626' : '#fbf5e6';
        g.fillRect((i - 1.5) * cell, (j - 1) * cell, cell, cell);
      }
    }
    g.strokeStyle = 'rgba(9,12,24,0.75)';
    g.lineWidth = unit * 0.45;
    g.strokeRect(-1.5 * cell, -cell, cell * 3, cell * 2);
    g.restore();
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

    const unit = Math.max(1, Math.min(W, H) / 120);
    const karts = ctx.race.karts;
    const player = ctx.race.player;
    const s = this.scratch;
    const n = karts.length;

    const rivalR = unit * 3.0;
    const playerR = unit * 3.9;

    // --- project, then de-overlap ------------------------------------------
    // A bunched field used to collapse into one indistinct smear. Dots that
    // land on top of each other are pushed apart along the local track normal
    // (each kart's own heading rotated 90°), which is the direction real karts
    // are actually separated in — so the map reads like a grid, not a blob.
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

    // three relaxation passes is plenty for an eight-kart field
    const maxOff = rivalR * 3.4;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const ri = karts[i] === player ? playerR : rivalR;
        for (let j = i + 1; j < n; j++) {
          const rj = karts[j] === player ? playerR : rivalR;
          const minD = (ri + rj) * 1.12;
          const dx = px[j] - px[i], dy = py[j] - py[i];
          const d = Math.hypot(dx, dy);
          if (d >= minD) continue;
          // split the shortfall along i's normal; sign follows the current
          // separation so dots keep the side they were already leaning to
          const push = (minD - d) * 0.5;
          const sgn = (dx * nx[i] + dy * ny[i]) >= 0 ? 1 : -1;
          const oi = clamp(off[i] - push * sgn, -maxOff, maxOff);
          const oj = clamp(off[j] + push * sgn, -maxOff, maxOff);
          px[i] += (oi - off[i]) * nx[i]; py[i] += (oi - off[i]) * ny[i];
          px[j] += (oj - off[j]) * nx[j]; py[j] += (oj - off[j]) * ny[j];
          off[i] = oi; off[j] = oj;
        }
      }
    }

    // the two karts the player is actually racing get a gold battle ring
    const pp = player ? player.place : 0;

    // rivals first so the player dot is never occluded
    for (let i = 0; i < n; i++) {
      const k = karts[i];
      if (k === player) continue;
      const battle = pp > 0 && (k.place === pp - 1 || k.place === pp + 1);
      this.dot(g, px[i], py[i], rivalR, this.colors[i] || '#ffffff', k.starTime > 0, battle);
    }

    if (player) {
      const i = karts.indexOf(player);
      this.playerDot(g, px[i], py[i], unit, player, ctx.time);
    }
  }

  private dot(
    g: CanvasRenderingContext2D, x: number, y: number, r: number,
    color: string, glow: boolean, battle: boolean,
  ) {
    if (glow) {
      g.beginPath();
      g.arc(x, y, r * 2.4, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,236,160,0.35)';
      g.fill();
    }
    g.beginPath();
    g.arc(x, y + r * 0.28, r * 1.02, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8,10,20,0.5)';
    g.fill();

    // A thin casing only: at this size a heavy one ate most of the dot and the
    // livery colour — the whole point of the dot — was down to a few pixels.
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = r * 0.22;
    g.strokeStyle = 'rgba(10,13,26,0.92)';
    g.stroke();
    if (battle) {
      g.beginPath();
      g.arc(x, y, r * 1.34, 0, Math.PI * 2);
      g.lineWidth = r * 0.24;
      g.strokeStyle = '#ffcf6b';
      g.stroke();
    }
    // top catchlight — the dots read as beads, not as flat circles
    g.beginPath();
    g.arc(x - r * 0.26, y - r * 0.3, r * 0.34, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fill();
  }

  private playerDot(
    g: CanvasRenderingContext2D, x: number, y: number, unit: number, k: IKart, time: number,
  ) {
    const r = unit * 3.9;
    // slow halo pulse so the eye finds the player instantly
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    g.beginPath();
    g.arc(x, y, r * (1.9 + pulse * 0.5), 0, Math.PI * 2);
    g.fillStyle = `rgba(255,236,180,${0.10 + pulse * 0.10})`;
    g.fill();

    // heading wedge
    const f = k.forward;
    const a = Math.atan2(f.z, f.x);
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(r * 2.5, 0);
    g.lineTo(r * 0.95, -r * 0.82);
    g.lineTo(r * 0.95, r * 0.82);
    g.closePath();
    g.fillStyle = '#fff6e2';
    g.fill();
    g.lineWidth = unit * 0.9;
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(10,13,26,0.9)';
    g.stroke();
    g.restore();

    g.beginPath();
    g.arc(x, y + r * 0.24, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8,10,20,0.55)';
    g.fill();

    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x, y, r);
    grd.addColorStop(0, '#fffdf6');
    grd.addColorStop(0.45, '#ffe7b0');
    grd.addColorStop(1, '#f2a63a');
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = r * 0.34;
    g.strokeStyle = 'rgba(10,13,26,0.92)';
    g.stroke();
    g.lineWidth = r * 0.16;
    g.strokeStyle = 'rgba(255,250,236,0.85)';
    g.stroke();
  }
}
