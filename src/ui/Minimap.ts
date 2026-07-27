/**
 * Minimap — the real centreline from ITrack.minimapPath(), normalised by
 * ITrack.bounds.
 *
 * ROUND 7 REBUILD. The review's words: "the minimap in the middle of that
 * stack is genuinely unreadable in all ten frames" and "a photoreal-bead
 * minimap parked on the vanishing point". Four separate faults, four fixes:
 *
 *  1. IT WAS A WIRE, NOT A ROAD. Round 6 over-corrected round 5's rope into a
 *     3 px hairline with a 1 px casing on a 150 px panel. At that weight the
 *     circuit read as a thread and the eye had nothing to lock onto. It is now
 *     a real ribbon — a light road body with a dark casing and a dashed centre
 *     line, which is what makes a shape read as *track* rather than as *line*.
 *
 *  2. IT WAS ARBITRARILY ORIENTED. The path went straight from world XZ to
 *     canvas XY, so the circuit sat at whatever angle the level designer
 *     happened to lay it out at and wasted most of the panel. The path is now
 *     fitted by its own principal axis (a 2x2 covariance eigenvector — closed
 *     form, computed once) so the long axis of the circuit lies along the long
 *     axis of the panel, and then flipped so the racing direction across the
 *     start line runs left-to-right. Fixed orientation, north-up-equivalent,
 *     baked once.
 *
 *  3. THE MARKERS WERE BEADS. Eight ~3.4 px discs, all the same size, in
 *     liveries that at that radius were three or four grey-ish pixels. The
 *     player is now a bright heading CHEVRON with a dark casing and a halo —
 *     a different SHAPE from the field, not just a bigger dot — and rivals are
 *     larger livery discs with a casing sized to survive a 1 px stroke.
 *
 *  4. IT WAS ON THE KART. It lived bottom-centre; the chase camera parks the
 *     player's kart and the road's vanishing point in exactly that column.
 *     ART_DIRECTION §7 permits "bottom-centre or top-centre" — it is top-centre
 *     now, over a band that is sky in every one of the ten review frames.
 *
 * The ribbon is baked once into an offscreen canvas and blitted each frame;
 * only the racer markers are re-rasterised per frame.
 */
import type { Ctx, IKart } from '../types';
import { el, clamp, cssColor } from './uiUtil';

/** Dense enough that the village esses and the banked 180 survive. */
const SAMPLES = 720;
/** fraction of the panel reserved as margin, after rotation */
const PAD = 0.075;

/**
 * Ribbon and marker weights, in CSS px at the reference panel height, scaled
 * by `this.u` so a 720p and a 1440p frame get the same PROPORTIONS rather than
 * the same pixels.
 */
const REF_H = 150;
const TRACK_W = 6.4;      // road body
const TRACK_CASE = 3.4;   // total casing, 1.7 px each side
const TRACK_COL = '#f2ece0';           // §3 kerb white — never #ffffff
const TRACK_MID = 'rgba(60, 66, 88, 0.6)';
const CASE_COL = '#05080f';

/** Marker radii. The player is a chevron, not a disc, so it has no radius. */
const RIVAL_R = 4.6;
const PLAYER_R = 7.4;
/** minimum centre-to-centre separation as a multiple of the summed radii */
const SEPARATION = 1.35;

export class Minimap {
  readonly root: HTMLDivElement;
  private well: HTMLDivElement;
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

  // world -> canvas mapping. `rc`/`rs` are the cos/sin of the fitted rotation.
  private sx = 1;
  private cx = 0;
  private cz = 0;
  private ox = 0;
  private oy = 0;
  private rc = 1;
  private rs = 0;
  /** rotated-space extents of the path, world units */
  private spanU = 1;
  private spanV = 1;

  /** cached livery colours, so we never build a string in the draw loop */
  private colors: string[] = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'kr-map kr-plate', parent);
    // The same WELL idiom the item box uses — one recessed graphic surface in
    // the system, not two.
    this.well = el('div', 'kr-well', this.root);
    this.canvas = el('canvas', undefined, this.well);
    this.g = this.canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.baseG = this.base.getContext('2d')!;
  }

  /**
   * Principal-axis fit. The 2x2 covariance of the centreline has a closed-form
   * dominant eigenvector, so this is a dozen flops and runs exactly once. The
   * result is the angle that lays the circuit's long axis flat.
   */
  private fitRotation() {
    const p = this.path;
    const n = p.length;
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += p[i].x; mz += p[i].z; }
    mx /= n; mz /= n;
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < n; i++) {
      const dx = p[i].x - mx, dz = p[i].z - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    // angle of the dominant eigenvector of [[sxx,sxz],[sxz,szz]]
    let a = 0.5 * Math.atan2(2 * sxz, sxx - szz);

    // Direction: the racing line crossing the start/finish must run to the
    // RIGHT on screen. Without this the same circuit can bake mirrored between
    // runs, and a map you have to read backwards is worse than no map.
    const q = p[Math.min(6, n - 1)];
    const tx = q.x - p[0].x, tz = q.z - p[0].z;
    if (Math.cos(a) * tx + Math.sin(a) * tz < 0) a += Math.PI;

    // Rotating by -a puts the dominant axis on +u.
    this.rc = Math.cos(-a);
    this.rs = Math.sin(-a);
    this.cx = mx;
    this.cz = mz;

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = p[i].x - mx, dz = p[i].z - mz;
      const u = dx * this.rc - dz * this.rs;
      const v = dx * this.rs + dz * this.rc;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    // Recentre on the fitted box, not on the centroid: a circuit with a long
    // spur is not centred on its mean.
    const uc = (uMin + uMax) * 0.5;
    const vc = (vMin + vMax) * 0.5;
    this.cx = mx + (uc * this.rc + vc * this.rs);
    this.cz = mz + (-uc * this.rs + vc * this.rc);
    this.spanU = Math.max(1, uMax - uMin);
    this.spanV = Math.max(1, vMax - vMin);
  }

  private tryBuild(ctx: Ctx) {
    const b = ctx.track.bounds;
    if (!(b.max.x - b.min.x > 1) || !(b.max.z - b.min.z > 1)) return false;
    this.path = ctx.track.minimapPath(SAMPLES);
    if (this.path.length < 8) return false;
    this.fitRotation();
    this.built = true;
    this.colors = ctx.race.karts.map((k) => cssColor(k.stats.color));
    return true;
  }

  /**
   * The panel is a FIXED box in ui.css (--map-w x --map-h) and the canvas
   * fills its well exactly. Round 6 derived the panel's width from the track's
   * aspect at runtime, so the top rail's geometry depended on level data and
   * changed shape one frame after boot.
   */
  resize() {
    const r = this.well.getBoundingClientRect();
    const cssW = r.width;
    const cssH = r.height;
    if (cssW < 32 || cssH < 24) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.w = Math.round(cssW * this.dpr);
    this.h = Math.round(cssH * this.dpr);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.u = this.dpr * clamp(cssH / REF_H, 0.62, 2.0);
    this.base.width = this.w;
    this.base.height = this.h;
    if (this.built) this.bake();
  }

  private project(x: number, z: number, out: { x: number; y: number }) {
    const dx = x - this.cx, dz = z - this.cz;
    out.x = this.ox + (dx * this.rc - dz * this.rs) * this.sx;
    out.y = this.oy + (dx * this.rs + dz * this.rc) * this.sx;
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
    this.sx = Math.min(usableW / this.spanU, usableH / this.spanV);
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

    // A road, not a wire: dark casing, light body, dashed centre line. Three
    // strokes of one shape — no bevel, no gradient, no glow, no value bands.
    trace();
    g.strokeStyle = CASE_COL;
    g.lineWidth = (TRACK_W + TRACK_CASE) * d;
    g.stroke();

    trace();
    g.strokeStyle = TRACK_COL;
    g.lineWidth = TRACK_W * d;
    g.stroke();

    // The centre line is what makes the shape read as a carriageway at 6 px.
    // It is also the cheapest possible sense of direction along the ribbon.
    trace();
    g.setLineDash([4.6 * d, 5.4 * d]);
    g.strokeStyle = TRACK_MID;
    g.lineWidth = Math.max(1, 1.0 * d);
    g.stroke();
    g.setLineDash([]);

    // Start/finish: a tick across the ribbon. One idiom per widget.
    this.project(p[0].x, p[0].z, s);
    const ax = s.x, ay = s.y;
    this.project(p[3 % n].x, p[3 % n].z, s);
    let tx = s.x - ax, ty = s.y - ay;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const half = (TRACK_W + TRACK_CASE) * 0.5 * d;
    const nx = -ty * half, ny = tx * half;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(ax - nx, ay - ny);
    g.lineTo(ax + nx, ay + ny);
    g.lineWidth = 3.2 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
    g.lineWidth = 1.8 * d;
    g.strokeStyle = '#ffcf6b';
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
    // track normal, which is the direction real karts are separated in — so a
    // bunched pack fans out across the road instead of collapsing into a knot.
    const px = this.px, py = this.py, nx = this.nx, ny = this.ny, off = this.off;
    for (let i = 0; i < n; i++) {
      const k = karts[i];
      this.project(k.position.x, k.position.z, s);
      px[i] = s.x; py[i] = s.y;
      // heading, rotated into canvas space by the same fitted rotation
      const f = k.forward;
      const hx = f.x * this.rc - f.z * this.rs;
      const hy = f.x * this.rs + f.z * this.rc;
      const l = Math.hypot(hx, hy) || 1;
      // perpendicular of the heading
      nx[i] = -hy / l; ny[i] = hx / l;
      off[i] = 0;
    }

    const maxOff = rivalR * 4.0;
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
    // Back of the field first, leader last, player last of all. Insertion sort
    // in place: n is eight, and a comparator closure would be a per-frame
    // allocation in the hot path (§8).
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
      this.dot(g, px[i], py[i], rivalR, this.colors[i] || '#f2ece0', k.starTime > 0, battle, d);
    }

    if (player) {
      const i = karts.indexOf(player);
      this.playerMark(g, px[i], py[i], playerR, player, d);
    }
  }

  /** Rivals: a flat livery disc with a dark casing. One idiom, one weight. */
  private dot(
    g: CanvasRenderingContext2D, x: number, y: number, r: number,
    color: string, glow: boolean, battle: boolean, d: number,
  ) {
    if (glow) {
      g.beginPath();
      g.arc(x, y, r * 1.9, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,207,107,0.5)';
      g.fill();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 1.6 * d;
    g.strokeStyle = CASE_COL;
    g.stroke();
    if (battle) {
      g.beginPath();
      g.arc(x, y, r + 2.4 * d, 0, Math.PI * 2);
      g.lineWidth = 1.4 * d;
      g.strokeStyle = '#ffcf6b';
      g.stroke();
    }
  }

  /**
   * The player is a different SHAPE on a different GROUND: a gold heading
   * chevron struck into an opaque near-black disc. Two things matter here and
   * round 6 got both wrong.
   *
   *  - The ribbon is LIGHT. A cream player dot on a cream ribbon is invisible
   *    exactly where the player always is, which is on the ribbon. The disc
   *    inverts the local value so the marker always has its own ground, and
   *    the chevron is the HUD's one accent (`--gold`), the same colour that
   *    means "you" on the standings board.
   *  - A radius difference does not survive at panel scale. A shape difference
   *    does, and it carries heading for free.
   */
  private playerMark(
    g: CanvasRenderingContext2D, x: number, y: number, r: number, k: IKart, d: number,
  ) {
    const f = k.forward;
    // heading, rotated by the same fit the ribbon was baked with
    const hx = f.x * this.rc - f.z * this.rs;
    const hy = f.x * this.rs + f.z * this.rc;
    const a = Math.atan2(hy, hx);

    // ground: opaque, so the marker never blends into the ribbon under it
    g.beginPath();
    g.arc(x, y, r * 1.34, 0, Math.PI * 2);
    g.fillStyle = '#080c18';
    g.fill();
    g.lineWidth = 1.6 * d;
    g.strokeStyle = 'rgba(255, 244, 226, 0.85)';
    g.stroke();

    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(r * 1.0, 0);
    g.lineTo(-r * 0.66, -r * 0.8);
    g.lineTo(-r * 0.28, 0);
    g.lineTo(-r * 0.66, r * 0.8);
    g.closePath();
    g.lineJoin = 'round';
    g.fillStyle = '#ffcf6b';
    g.fill();
    g.restore();
  }
}
