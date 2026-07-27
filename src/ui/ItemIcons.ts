/**
 * Procedural item art — Sunset Bay's own set.
 *
 * ROUND 2 REBUILD, for two reasons.
 *
 * 1. The round-1 icons were near-traces of another publisher's item roster —
 *    a spotted mushroom with eyes, a footed bomb with a lit fuse, green and
 *    red carapaces. That is not a look this game can ship, whatever it looks
 *    like in a screenshot. The set is now drawn from this circuit's own world:
 *    an espresso, netted glass fishing floats, an Amalfi lemon, the golden
 *    hour itself, a squall, a harbour mooring buoy. Same gameplay slots, same
 *    silhouette weights, original forms.
 *
 * 2. Two construction styles shared one 166 px slot — a soft-shaded 3D render
 *    with a specular highlight and a glow that bled past the plate corner, and
 *    a flat vector with a hard keyline and no glow at all.
 *
 * ONE construction, applied to every icon without exception:
 *   - a single ink keyline at ONE weight (LW). No icon is more line-arty.
 *   - TWO-STOP shading only. One linear ramp per shape, light at the top.
 *     No radial gradients, no specular blobs, no rim lights, no glows.
 *   - one contact shadow, identical parameters everywhere.
 *   - one optical-size box: every icon is authored inside a unit square and
 *     then fitted to an 82% inset, vertically centred on its OPTICAL centroid
 *     (see OPT_Y) rather than on its bounding box, so a tall icon and a wide
 *     one sit at the same visual height in the slot.
 */
import { ItemKind } from '../types';

const INK = '#241a2e';
/** the one keyline weight, in unit-box coordinates */
const LW = 0.055;

export const ITEM_NAMES: Record<number, string> = {
  [ItemKind.None]: '',
  [ItemKind.Mushroom]: 'Espresso',
  [ItemKind.TripleMushroom]: 'Triple Espresso',
  [ItemKind.GreenShell]: 'Glass Float',
  [ItemKind.RedShell]: 'Homing Float',
  [ItemKind.Banana]: 'Lemon',
  [ItemKind.Star]: 'Golden Hour',
  [ItemKind.Bolt]: 'Squall',
  [ItemKind.Bomb]: 'Mooring Buoy',
};

/** Accent colour used for the item-box glow and the hit toast rule. */
export const ITEM_TINT: Record<number, string> = {
  [ItemKind.None]: '#8fa0bb',
  [ItemKind.Mushroom]: '#d98a3c',
  [ItemKind.TripleMushroom]: '#e0a04a',
  [ItemKind.GreenShell]: '#5fd463',
  [ItemKind.RedShell]: '#ff4d4d',
  [ItemKind.Banana]: '#ffd447',
  [ItemKind.Star]: '#ffd76b',
  [ItemKind.Bolt]: '#ffe066',
  [ItemKind.Bomb]: '#e0453f',
};

/** Cycling order for the roulette — mixes hues so the spin looks lively. */
export const ROULETTE_ORDER: ItemKind[] = [
  ItemKind.Mushroom,
  ItemKind.GreenShell,
  ItemKind.Banana,
  ItemKind.Star,
  ItemKind.RedShell,
  ItemKind.TripleMushroom,
  ItemKind.Bolt,
  ItemKind.Bomb,
];

/**
 * Optical-centroid correction per icon, in unit-box coordinates. Positive
 * moves the icon down. A sun with rays reads high; a cup on a saucer reads
 * low. Bounding-box centring alone is what left the round-1 mushroom with
 * more headroom than footroom next to a bomb that filled the plate.
 */
const OPT_Y: Record<number, number> = {
  [ItemKind.Mushroom]: -0.015,
  [ItemKind.TripleMushroom]: -0.01,
  [ItemKind.GreenShell]: -0.02,
  [ItemKind.RedShell]: -0.02,
  [ItemKind.Banana]: 0,
  [ItemKind.Star]: 0.005,
  [ItemKind.Bolt]: 0,
  [ItemKind.Bomb]: -0.01,
};

type G = CanvasRenderingContext2D;

// --------------------------------------------------------------------------
// primitives — the only ones any icon is allowed to use
// --------------------------------------------------------------------------

/** THE two-stop ramp. Light at the top, saturated at the bottom, always. */
function ramp(g: G, top: string, bottom: string, y0 = -0.44, y1 = 0.44) {
  const grd = g.createLinearGradient(0, y0, 0, y1);
  grd.addColorStop(0, top);
  grd.addColorStop(1, bottom);
  return grd;
}

/** THE keyline. */
function key(g: G, p: Path2D, w = LW) {
  g.strokeStyle = INK;
  g.lineWidth = w;
  g.stroke(p);
}

/** THE contact shadow — identical on every icon so nothing floats and nothing
 *  is lit differently from its neighbour in the roulette. */
function contact(g: G) {
  g.save();
  g.translate(0, 0.445);
  g.scale(1, 0.24);
  g.beginPath();
  g.arc(0, 0, 0.30, 0, Math.PI * 2);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 0.30);
  grd.addColorStop(0, 'rgba(20,14,30,0.42)');
  grd.addColorStop(1, 'rgba(20,14,30,0)');
  g.fillStyle = grd;
  g.fill();
  g.restore();
}

function fillKey(g: G, p: Path2D, top: string, bottom: string, y0?: number, y1?: number, kw = LW) {
  g.fillStyle = ramp(g, top, bottom, y0, y1);
  g.fill(p);
  key(g, p, kw);
}

function ellipsePath(x: number, y: number, rx: number, ry: number, rot = 0) {
  const p = new Path2D();
  p.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  return p;
}

// --------------------------------------------------------------------------
// icons
// --------------------------------------------------------------------------

/** Espresso — the boost item. Harbour-front bar, one shot, go.
 *  `s` scales the whole cup about the local origin; every stroke weight is
 *  divided by it so the keyline lands at exactly LW whatever the size — a
 *  small icon in the triple must not be more delicately drawn than a large
 *  one, or the set stops reading as one hand. */
function espresso(g: G, s: number) {
  g.save();
  g.scale(s, s);
  const w = LW / s;

  // saucer
  const saucer = ellipsePath(0, 0.315, 0.40, 0.105);
  fillKey(g, saucer, '#fdf6e8', '#cbb99a', 0.20, 0.42, w);

  // handle, behind the cup
  const handle = new Path2D();
  handle.moveTo(0.235, -0.055);
  handle.bezierCurveTo(0.415, -0.075, 0.425, 0.185, 0.235, 0.185);
  g.strokeStyle = INK;
  g.lineWidth = w * 2.6;
  g.stroke(handle);
  g.strokeStyle = '#f6eddc';
  g.lineWidth = w * 1.4;
  g.stroke(handle);

  // cup
  const cup = new Path2D();
  cup.moveTo(-0.265, -0.175);
  cup.lineTo(0.265, -0.175);
  cup.lineTo(0.205, 0.185);
  cup.bezierCurveTo(0.185, 0.275, -0.185, 0.275, -0.205, 0.185);
  cup.closePath();
  fillKey(g, cup, '#fffaf0', '#dccdb4', -0.22, 0.28, w);

  // crema
  const crema = ellipsePath(0, -0.175, 0.265, 0.075);
  fillKey(g, crema, '#d9974a', '#7d4413', -0.25, -0.10, w);

  // steam — the one line-art element, at the shared weight
  g.strokeStyle = 'rgba(255,246,228,0.72)';
  g.lineWidth = w * 0.72;
  g.lineCap = 'round';
  for (const sx of [-0.10, 0.10]) {
    g.beginPath();
    g.moveTo(sx, -0.28);
    g.bezierCurveTo(sx + 0.075, -0.35, sx - 0.075, -0.40, sx, -0.465);
    g.stroke();
  }
  g.restore();
}

function drawEspresso(g: G) {
  contact(g);
  espresso(g, 1);
}

function drawTripleEspresso(g: G) {
  contact(g);
  // Three shots in a triangle. No tray: at 64 px a tray plus three cups is one
  // brown lump, and the count chip on the plate already says how many.
  g.save(); g.translate(-0.265, 0.155); espresso(g, 0.46); g.restore();
  g.save(); g.translate(0.265, 0.155); espresso(g, 0.46); g.restore();
  g.save(); g.translate(0, -0.145); espresso(g, 0.52); g.restore();
}

/**
 * Netted glass fishing float — the bouncing projectile. Every harbour on this
 * coast has a wall of them.
 */
function glassFloat(g: G, top: string, bottom: string, homing: boolean) {
  contact(g);
  const R = 0.345;
  const body = new Path2D();
  body.arc(0, 0.035, R, 0, Math.PI * 2);
  fillKey(g, body, top, bottom, -0.34, 0.40);

  // rope net: three arcs, clipped to the glass
  g.save();
  g.clip(body);
  g.strokeStyle = '#efe2c4';
  g.lineWidth = LW * 0.68;
  for (const rx of [0.115, 0.245]) {
    g.beginPath();
    g.ellipse(0, 0.035, rx, R, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.ellipse(0, 0.035, R, 0.125, 0, 0, Math.PI * 2);
  g.stroke();
  g.restore();

  // knot / hanging loop at the crown
  const loop = new Path2D();
  loop.ellipse(0, -0.375, 0.085, 0.075, 0, 0, Math.PI * 2);
  g.fillStyle = '#efe2c4';
  g.fill(loop);
  key(g, loop, LW * 0.9);

  if (homing) {
    // a brass tracking band — this one comes looking for you. One thin ring,
    // no needle: a band plus a lozenge inside a sphere read as an eye at 64 px.
    const band = new Path2D();
    band.ellipse(0, 0.035, R * 1.0, 0.095, 0, 0, Math.PI * 2);
    g.strokeStyle = INK;
    g.lineWidth = LW * 1.7;
    g.stroke(band);
    g.strokeStyle = '#f0c24e';
    g.lineWidth = LW * 0.95;
    g.stroke(band);
  }
}

function drawGreenFloat(g: G) { glassFloat(g, '#b8f0a8', '#1e7a35', false); }
function drawRedFloat(g: G) { glassFloat(g, '#ffb9a4', '#b3202a', true); }

/** Amalfi lemon — the dropped hazard. */
function drawLemon(g: G) {
  contact(g);
  const body = new Path2D();
  // a lemon: an ellipse with a nipple at each end, tilted
  body.moveTo(-0.415, -0.135);
  body.bezierCurveTo(-0.335, -0.335, 0.055, -0.385, 0.275, -0.235);
  body.bezierCurveTo(0.455, -0.115, 0.475, 0.115, 0.315, 0.265);
  body.bezierCurveTo(0.135, 0.425, -0.215, 0.375, -0.355, 0.185);
  body.bezierCurveTo(-0.445, 0.065, -0.455, -0.045, -0.415, -0.135);
  body.closePath();
  fillKey(g, body, '#fff6b0', '#e8a30c', -0.40, 0.42);

  // the one interior line the set allows: the pith seam
  g.save();
  g.clip(body);
  g.strokeStyle = 'rgba(255,252,206,0.62)';
  g.lineWidth = LW * 1.3;
  g.beginPath();
  g.moveTo(-0.305, -0.135);
  g.bezierCurveTo(-0.185, -0.265, 0.065, -0.285, 0.205, -0.185);
  g.stroke();
  g.restore();

  // leaf
  const leaf = new Path2D();
  leaf.moveTo(0.135, -0.305);
  leaf.bezierCurveTo(0.265, -0.475, 0.435, -0.475, 0.475, -0.395);
  leaf.bezierCurveTo(0.425, -0.245, 0.245, -0.215, 0.135, -0.305);
  leaf.closePath();
  fillKey(g, leaf, '#9ecf6a', '#41702c', -0.48, -0.20);
}

/** Golden Hour — the invulnerability item. The circuit's own light, weaponised. */
function drawGoldenHour(g: G) {
  contact(g);
  // rays and disc in ONE path, so the keyline runs round one silhouette
  const p = new Path2D();
  const R0 = 0.285, R1 = 0.485;
  for (let i = 0; i < 16; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 8;
    const half = Math.PI / 16 * 0.78;
    if (i % 2 === 0) {
      // ray: a tapered spike
      const x0 = Math.cos(a - half) * R0, y0 = Math.sin(a - half) * R0;
      const xt = Math.cos(a) * R1, yt = Math.sin(a) * R1;
      const x1 = Math.cos(a + half) * R0, y1 = Math.sin(a + half) * R0;
      if (i === 0) p.moveTo(x0, y0); else p.lineTo(x0, y0);
      p.lineTo(xt, yt);
      p.lineTo(x1, y1);
    } else {
      p.arc(0, 0, R0, a - Math.PI / 16, a + Math.PI / 16);
    }
  }
  p.closePath();
  fillKey(g, p, '#fff4c6', '#ef8f12', -0.48, 0.48);

  // inner disc — the second of the two stops, as a shape rather than a blur
  const disc = new Path2D();
  disc.arc(0, -0.02, 0.20, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,250,222,0.55)';
  g.fill(disc);
}

/** Squall — the field-wide storm. A bolt out of a cloud, not a bare glyph. */
function drawSquall(g: G) {
  contact(g);
  const cloud = new Path2D();
  cloud.moveTo(-0.415, -0.055);
  cloud.bezierCurveTo(-0.485, -0.225, -0.315, -0.365, -0.145, -0.315);
  cloud.bezierCurveTo(-0.085, -0.465, 0.165, -0.485, 0.245, -0.335);
  cloud.bezierCurveTo(0.435, -0.365, 0.505, -0.145, 0.365, -0.055);
  cloud.closePath();
  fillKey(g, cloud, '#8fa2c6', '#2f3a5c', -0.48, -0.02);

  const bolt = new Path2D();
  bolt.moveTo(0.055, -0.085);
  bolt.lineTo(0.285, -0.045);
  bolt.lineTo(0.095, 0.185);
  bolt.lineTo(0.255, 0.225);
  bolt.lineTo(-0.115, 0.475);
  bolt.lineTo(-0.015, 0.185);
  bolt.lineTo(-0.235, 0.145);
  bolt.lineTo(-0.075, -0.085);
  bolt.closePath();
  fillKey(g, bolt, '#fff6c2', '#f0a412', -0.10, 0.48);
}

/** Mooring buoy — the dropped/thrown hazard. Standard harbour livery. */
function drawBuoy(g: G) {
  contact(g);
  // mast + lamp
  const mast = new Path2D();
  mast.moveTo(-0.048, -0.235);
  mast.lineTo(0.048, -0.235);
  mast.lineTo(0.038, -0.395);
  mast.lineTo(-0.038, -0.395);
  mast.closePath();
  fillKey(g, mast, '#c9d2e0', '#6a7488', -0.42, -0.22);

  const lamp = new Path2D();
  lamp.moveTo(-0.135, -0.385);
  lamp.bezierCurveTo(-0.135, -0.545, 0.135, -0.545, 0.135, -0.385);
  lamp.closePath();
  fillKey(g, lamp, '#fff2c0', '#e0902a', -0.55, -0.36);

  // hull — one silhouette, banded by a clipped rectangle rather than a second
  // gradient, so the two-stop rule still holds per shape
  const hull = new Path2D();
  hull.moveTo(-0.335, -0.155);
  hull.bezierCurveTo(-0.335, -0.275, 0.335, -0.275, 0.335, -0.155);
  hull.lineTo(0.315, 0.175);
  hull.bezierCurveTo(0.285, 0.395, -0.285, 0.395, -0.315, 0.175);
  hull.closePath();
  fillKey(g, hull, '#fdf4e2', '#c3b295', -0.30, 0.42);

  g.save();
  g.clip(hull);
  const band = new Path2D();
  band.rect(-0.5, -0.155, 1, 0.19);
  g.fillStyle = ramp(g, '#f4776c', '#c22d24', -0.16, 0.04);
  g.fill(band);
  g.restore();
  key(g, hull);

  // mooring ring
  const ring = new Path2D();
  ring.ellipse(0, 0.335, 0.115, 0.048, 0, 0, Math.PI * 2);
  g.strokeStyle = INK;
  g.lineWidth = LW * 1.9;
  g.stroke(ring);
  g.strokeStyle = '#c9d2e0';
  g.lineWidth = LW * 1.0;
  g.stroke(ring);
}

/** The empty-slot ghost. The HUD never asks for this — the empty state is the
 *  plate's own well and the embossed diamond behind the canvas — but the table
 *  needs a total function. */
function drawEmpty(_g: G) { /* deliberately nothing */ }

const TABLE: Record<number, (g: G) => void> = {
  [ItemKind.None]: drawEmpty,
  [ItemKind.Mushroom]: drawEspresso,
  [ItemKind.TripleMushroom]: drawTripleEspresso,
  [ItemKind.GreenShell]: drawGreenFloat,
  [ItemKind.RedShell]: drawRedFloat,
  [ItemKind.Banana]: drawLemon,
  [ItemKind.Star]: drawGoldenHour,
  [ItemKind.Bolt]: drawSquall,
  [ItemKind.Bomb]: drawBuoy,
};

/**
 * Paint `kind` centred in a `size` px box on `g`, fitted to the shared
 * optical-size box. The caller owns the canvas clear; we leave the context
 * state exactly as we found it.
 */
export function drawItem(g: G, kind: ItemKind, size: number) {
  g.save();
  g.translate(size * 0.5, size * 0.5);
  // 82% inset square, vertically centred on the optical centroid.
  g.scale(size * 0.82, size * 0.82);
  g.translate(0, OPT_Y[kind] || 0);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.miterLimit = 2;
  (TABLE[kind] || drawEmpty)(g);
  g.restore();
}

/** Off-screen cache so the roulette can blit instead of re-rasterising paths. */
export class ItemIconAtlas {
  private cache = new Map<number, HTMLCanvasElement>();
  private size = 0;

  /** Rebuilds only when the required pixel size actually moves. */
  ensure(px: number) {
    const s = Math.max(96, Math.min(512, Math.round(px / 32) * 32));
    if (s === this.size) return;
    this.size = s;
    this.cache.clear();
  }

  get(kind: ItemKind): HTMLCanvasElement {
    let c = this.cache.get(kind);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = this.size || 256;
      const g = c.getContext('2d')!;
      drawItem(g, kind, c.width);
      this.cache.set(kind, c);
    }
    return c;
  }
}
