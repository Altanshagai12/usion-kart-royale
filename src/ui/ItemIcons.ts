/**
 * Procedural item art. Every icon is drawn in a normalised [-0.5, 0.5] square
 * so a single routine serves the 64 px roulette and a 512 px pre-render.
 *
 * House rules for all of them, because consistency is what makes a set read as
 * authored rather than assembled:
 *   - a soft contact shadow, so nothing floats;
 *   - one dark ink outline at a shared weight (no icon is more "line-arty");
 *   - a vertical value ramp (light at the top, saturated at the bottom) plus a
 *     warm rim on the lower right — the scene's golden-hour key baked in;
 *   - one crisp specular blob upper-left, one soft one on the shoulder.
 */
import { ItemKind } from '../types';

const INK = '#20182c';
const INK_SOFT = 'rgba(24,17,36,0.45)';
const LW = 0.052;

export const ITEM_NAMES: Record<number, string> = {
  [ItemKind.None]: '',
  [ItemKind.Mushroom]: 'Mushroom',
  [ItemKind.TripleMushroom]: 'Triple Mushroom',
  [ItemKind.GreenShell]: 'Green Shell',
  [ItemKind.RedShell]: 'Red Shell',
  [ItemKind.Banana]: 'Banana',
  [ItemKind.Star]: 'Star',
  [ItemKind.Bolt]: 'Lightning',
  [ItemKind.Bomb]: 'Bob-omb',
};

/** Accent colour used for the item-box glow and the hit toast rule. */
export const ITEM_TINT: Record<number, string> = {
  [ItemKind.None]: '#8fa0bb',
  [ItemKind.Mushroom]: '#ff6a5e',
  [ItemKind.TripleMushroom]: '#ff8a5e',
  [ItemKind.GreenShell]: '#5fd463',
  [ItemKind.RedShell]: '#ff4d4d',
  [ItemKind.Banana]: '#ffd447',
  [ItemKind.Star]: '#ffd76b',
  [ItemKind.Bolt]: '#ffe066',
  [ItemKind.Bomb]: '#8ea6d6',
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

type G = CanvasRenderingContext2D;

// --------------------------------------------------------------------------
// primitives
// --------------------------------------------------------------------------

function lg(g: G, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const grd = g.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) grd.addColorStop(o, c);
  return grd;
}

function rg(g: G, x: number, y: number, r0: number, r: number, stops: [number, string][]) {
  const grd = g.createRadialGradient(x, y, r0, x, y, r);
  for (const [o, c] of stops) grd.addColorStop(o, c);
  return grd;
}

function ink(g: G, w = LW) {
  g.strokeStyle = INK;
  g.lineWidth = w;
  g.stroke();
}

/** Soft elliptical contact shadow. */
function contact(g: G, y = 0.42, rx = 0.30, ry = 0.075, a = 0.42) {
  g.save();
  g.translate(0, y);
  g.scale(1, ry / rx);
  g.beginPath();
  g.arc(0, 0, rx, 0, Math.PI * 2);
  g.fillStyle = rg(g, 0, 0, 0, rx, [[0, `rgba(20,14,30,${a})`], [0.55, `rgba(20,14,30,${a * 0.55})`], [1, 'rgba(20,14,30,0)']]);
  g.fill();
  g.restore();
}

/** Warm bounce along the lower-right silhouette — the golden-hour tell. */
function rimLight(g: G, path: Path2D, color = 'rgba(255,196,120,0.85)') {
  g.save();
  g.clip(path);
  g.translate(-0.018, -0.022);
  g.beginPath();
  g.strokeStyle = color;
  g.lineWidth = LW * 0.9;
  g.stroke(path);
  g.restore();
}

function specular(g: G, x: number, y: number, rx: number, ry: number, rot: number, a = 0.85) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(1, ry / rx);
  g.beginPath();
  g.arc(0, 0, rx, 0, Math.PI * 2);
  g.fillStyle = rg(g, 0, 0, 0, rx, [[0, `rgba(255,255,255,${a})`], [0.6, `rgba(255,255,255,${a * 0.35})`], [1, 'rgba(255,255,255,0)']]);
  g.fill();
  g.restore();
}

function glow(g: G, r: number, color: string, a = 0.55) {
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fillStyle = rg(g, 0, 0, 0, r, [[0, color.replace('ALPHA', String(a))], [0.5, color.replace('ALPHA', String(a * 0.4))], [1, color.replace('ALPHA', '0')]]);
  g.fill();
}

// --------------------------------------------------------------------------
// icons
// --------------------------------------------------------------------------

/** Draws a mushroom in a unit box; `s` scales it about the local origin. */
function mushroom(g: G, s: number, capA: string, capB: string, capC: string) {
  g.save();
  g.scale(s, s);
  const w = LW / s;

  // stem — cream, slightly bell-bottomed, with the two eye dots
  const stem = new Path2D();
  stem.moveTo(-0.205, -0.02);
  stem.bezierCurveTo(-0.235, 0.18, -0.20, 0.34, -0.10, 0.385);
  stem.bezierCurveTo(-0.035, 0.412, 0.035, 0.412, 0.10, 0.385);
  stem.bezierCurveTo(0.20, 0.34, 0.235, 0.18, 0.205, -0.02);
  stem.closePath();
  g.fillStyle = lg(g, 0, -0.05, 0, 0.42, [[0, '#fffaf0'], [0.55, '#f4e3c6'], [1, '#d9bf98']]);
  g.fill(stem);
  rimLight(g, stem, 'rgba(255,206,140,0.9)');
  g.strokeStyle = INK; g.lineWidth = w; g.stroke(stem);

  for (const ex of [-0.082, 0.082]) {
    g.beginPath();
    g.ellipse(ex, 0.175, 0.036, 0.062, 0, 0, Math.PI * 2);
    g.fillStyle = '#2b2033';
    g.fill();
  }
  // tiny catchlights make the eyes read as glossy, not as holes
  for (const ex of [-0.092, 0.072]) {
    g.beginPath();
    g.ellipse(ex, 0.150, 0.013, 0.018, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fill();
  }

  // cap — a dome that overhangs the stem
  const cap = new Path2D();
  cap.moveTo(-0.455, 0.045);
  cap.bezierCurveTo(-0.475, -0.235, -0.275, -0.415, 0, -0.415);
  cap.bezierCurveTo(0.275, -0.415, 0.475, -0.235, 0.455, 0.045);
  cap.bezierCurveTo(0.30, 0.115, -0.30, 0.115, -0.455, 0.045);
  cap.closePath();
  g.fillStyle = rg(g, -0.14, -0.24, 0.02, 0.66, [[0, capA], [0.45, capB], [1, capC]]);
  g.fill(cap);

  g.save();
  g.clip(cap);
  // spots, sized unevenly so it doesn't look like a stamped pattern
  const spots: [number, number, number][] = [
    [-0.245, -0.115, 0.105], [0.185, -0.155, 0.092], [0.005, -0.295, 0.072],
    [0.335, 0.005, 0.062], [-0.375, 0.020, 0.055], [-0.045, 0.010, 0.048],
  ];
  for (const [x, y, r] of spots) {
    g.beginPath();
    g.ellipse(x, y, r, r * 0.92, 0, 0, Math.PI * 2);
    g.fillStyle = rg(g, x - r * 0.3, y - r * 0.3, 0, r, [[0, '#fffdf6'], [1, '#f0dfc0']]);
    g.fill();
  }
  // ambient shade where the cap meets the stem
  g.beginPath();
  g.rect(-0.5, -0.02, 1, 0.2);
  g.fillStyle = lg(g, 0, -0.02, 0, 0.12, [[0, 'rgba(60,20,30,0)'], [1, 'rgba(60,20,30,0.35)']]);
  g.fill();
  g.restore();

  rimLight(g, cap);
  g.strokeStyle = INK; g.lineWidth = w; g.stroke(cap);
  specular(g, -0.235, -0.245, 0.135, 0.075, -0.55, 0.75);
  specular(g, 0.135, -0.325, 0.06, 0.032, -0.2, 0.5);
  g.restore();
}

function drawMushroom(g: G) {
  contact(g, 0.44, 0.28, 0.07);
  g.translate(0, -0.01);
  mushroom(g, 1, '#ff8b7e', '#f0483f', '#b81f2a');
}

function drawTripleMushroom(g: G) {
  contact(g, 0.45, 0.36, 0.075, 0.38);
  // an orbit ring sells "three of them" before the shapes even resolve
  g.save();
  g.beginPath();
  g.ellipse(0, 0.13, 0.44, 0.17, 0, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,214,150,0.30)';
  g.lineWidth = 0.028;
  g.setLineDash([0.07, 0.055]);
  g.stroke();
  g.restore();

  g.save(); g.translate(-0.245, 0.155); mushroom(g, 0.50, '#ff9a8c', '#ee5a4a', '#ab2230'); g.restore();
  g.save(); g.translate(0.245, 0.155); mushroom(g, 0.50, '#ff9a8c', '#ee5a4a', '#ab2230'); g.restore();
  g.save(); g.translate(0, -0.135); mushroom(g, 0.58, '#ff8b7e', '#f0483f', '#b81f2a'); g.restore();
}

function shell(g: G, hiA: string, hiB: string, lo: string, plate: string) {
  contact(g, 0.44, 0.32, 0.075);

  // belly — the cream underside, drawn first so the dome overlaps it
  const belly = new Path2D();
  belly.moveTo(-0.455, 0.075);
  belly.bezierCurveTo(-0.455, 0.36, -0.28, 0.44, 0, 0.44);
  belly.bezierCurveTo(0.28, 0.44, 0.455, 0.36, 0.455, 0.075);
  belly.closePath();
  g.fillStyle = lg(g, 0, 0.02, 0, 0.45, [[0, '#fff6e0'], [0.6, '#f0dcb4'], [1, '#cfae7c']]);
  g.fill(belly);
  rimLight(g, belly, 'rgba(255,206,140,0.9)');
  g.strokeStyle = INK; g.lineWidth = LW; g.stroke(belly);

  // dome
  const dome = new Path2D();
  dome.moveTo(-0.475, 0.115);
  dome.bezierCurveTo(-0.475, -0.24, -0.275, -0.455, 0, -0.455);
  dome.bezierCurveTo(0.275, -0.455, 0.475, -0.24, 0.475, 0.115);
  dome.bezierCurveTo(0.30, 0.20, -0.30, 0.20, -0.475, 0.115);
  dome.closePath();
  g.fillStyle = rg(g, -0.15, -0.26, 0.02, 0.72, [[0, hiA], [0.42, hiB], [1, lo]]);
  g.fill(dome);

  g.save();
  g.clip(dome);

  // A darker inner field leaves a lighter rim band around the dome edge; the
  // band plus the radial separators is what makes this read as a carapace
  // rather than as a coloured hemisphere.
  const field = new Path2D();
  field.ellipse(0, 0.035, 0.352, 0.345, 0, 0, Math.PI * 2);
  g.fillStyle = rg(g, -0.11, -0.16, 0.02, 0.52, [[0, hiB], [0.5, plate], [1, lo]]);
  g.fill(field);
  g.strokeStyle = 'rgba(20,14,28,0.55)';
  g.lineWidth = 0.026;
  g.stroke(field);

  g.save();
  g.clip(field);
  for (let i = -2; i <= 2; i++) {
    const a = i * 0.62 - Math.PI * 0.5;
    g.beginPath();
    g.moveTo(0, 0.035);
    g.lineTo(Math.cos(a) * 0.6, 0.035 + Math.sin(a) * 0.6);
    g.strokeStyle = 'rgba(20,14,28,0.5)';
    g.lineWidth = 0.026;
    g.stroke();
  }
  g.restore();

  // crown plate, lit rather than dark — it is the top of the shell
  g.beginPath();
  g.ellipse(0, -0.045, 0.135, 0.108, 0, 0, Math.PI * 2);
  g.fillStyle = rg(g, -0.04, -0.08, 0, 0.17, [[0, hiA], [1, hiB]]);
  g.fill();
  g.strokeStyle = 'rgba(20,14,28,0.55)';
  g.lineWidth = 0.026;
  g.stroke();

  // ambient shade where the dome tucks under toward the belly
  g.beginPath();
  g.rect(-0.5, 0.02, 1, 0.24);
  g.fillStyle = lg(g, 0, 0.02, 0, 0.2, [[0, 'rgba(24,8,18,0)'], [1, 'rgba(24,8,18,0.5)']]);
  g.fill();
  g.restore();

  // the cream lip between dome and belly, with its own cast shadow
  g.beginPath();
  g.moveTo(-0.468, 0.128);
  g.bezierCurveTo(-0.30, 0.218, 0.30, 0.218, 0.468, 0.128);
  g.strokeStyle = 'rgba(60,38,14,0.35)';
  g.lineWidth = 0.078;
  g.stroke();
  g.beginPath();
  g.moveTo(-0.470, 0.112);
  g.bezierCurveTo(-0.30, 0.200, 0.30, 0.200, 0.470, 0.112);
  g.strokeStyle = '#fdf2da';
  g.lineWidth = 0.062;
  g.stroke();

  rimLight(g, dome);
  g.strokeStyle = INK; g.lineWidth = LW; g.stroke(dome);
  specular(g, -0.225, -0.265, 0.145, 0.085, -0.5, 0.8);
  specular(g, 0.185, -0.315, 0.062, 0.034, -0.25, 0.55);
}

function drawGreenShell(g: G) { shell(g, '#d2fba0', '#5fd85c', '#0f5a26', '#2f9e3c'); }
function drawRedShell(g: G) { shell(g, '#ffc0ac', '#f2564d', '#780d1c', '#c92330'); }

function drawBanana(g: G) {
  contact(g, 0.42, 0.30, 0.068);
  g.translate(0, -0.02);

  // A crescent this size only reads as a banana if it is genuinely fat in the
  // belly and tapers hard into the tips — a thin arc reads as a comma.
  const body = new Path2D();
  body.moveTo(-0.325, -0.250);
  body.bezierCurveTo(-0.500, 0.140, -0.240, 0.455, 0.110, 0.440);
  body.bezierCurveTo(0.300, 0.432, 0.412, 0.312, 0.450, 0.150);
  body.bezierCurveTo(0.360, 0.262, 0.240, 0.300, 0.090, 0.270);
  body.bezierCurveTo(-0.130, 0.228, -0.212, 0.058, -0.188, -0.226);
  body.closePath();

  g.fillStyle = lg(g, -0.30, -0.30, 0.28, 0.44, [[0, '#fff6b4'], [0.30, '#ffe256'], [0.68, '#f5b915'], [1, '#c67f07']]);
  g.fill(body);

  g.save();
  g.clip(body);
  // pale ridge along the inner face, brown seam along the outer
  g.beginPath();
  g.moveTo(-0.205, -0.230);
  g.bezierCurveTo(-0.258, 0.040, -0.150, 0.196, 0.085, 0.256);
  g.strokeStyle = 'rgba(255,255,228,0.62)';
  g.lineWidth = 0.070;
  g.stroke();
  g.beginPath();
  g.moveTo(-0.315, -0.190);
  g.bezierCurveTo(-0.430, 0.130, -0.215, 0.392, 0.120, 0.382);
  g.strokeStyle = 'rgba(146,90,8,0.38)';
  g.lineWidth = 0.036;
  g.stroke();
  // shade pooling in the belly
  g.beginPath();
  g.rect(-0.5, 0.24, 1, 0.35);
  g.fillStyle = lg(g, 0, 0.24, 0, 0.46, [[0, 'rgba(140,80,0,0)'], [1, 'rgba(140,80,0,0.32)']]);
  g.fill();
  g.restore();

  rimLight(g, body);
  g.strokeStyle = INK; g.lineWidth = LW; g.stroke(body);

  // stalk (upper left, squarer) and blossom end (right, rounder)
  g.save();
  g.translate(-0.262, -0.276);
  g.rotate(-0.32);
  g.beginPath();
  g.ellipse(0, 0, 0.082, 0.062, 0, 0, Math.PI * 2);
  g.fillStyle = lg(g, 0, -0.08, 0, 0.08, [[0, '#9a6733'], [1, '#4a2c12']]);
  g.fill();
  g.strokeStyle = INK; g.lineWidth = LW * 0.9; g.stroke();
  g.restore();

  g.save();
  g.translate(0.452, 0.172);
  g.rotate(1.0);
  g.beginPath();
  g.ellipse(0, 0, 0.062, 0.048, 0, 0, Math.PI * 2);
  g.fillStyle = lg(g, 0, -0.06, 0, 0.06, [[0, '#9a6733'], [1, '#4a2c12']]);
  g.fill();
  g.strokeStyle = INK; g.lineWidth = LW * 0.9; g.stroke();
  g.restore();

  specular(g, -0.215, 0.045, 0.082, 0.170, 0.40, 0.55);
}

function drawStar(g: G) {
  glow(g, 0.5, 'rgba(255,214,110,ALPHA)', 0.7);
  contact(g, 0.44, 0.24, 0.06, 0.32);

  const star = new Path2D();
  const R = 0.47, r = 0.205;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad * 0.98 + 0.015;
    if (i === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  star.closePath();

  g.fillStyle = rg(g, -0.06, -0.13, 0.02, 0.58, [[0, '#fffbe0'], [0.35, '#ffe07a'], [0.72, '#ffbe2b'], [1, '#e8830c']]);
  g.fill(star);

  g.save();
  g.clip(star);
  // inner facet — a slightly smaller star in a lighter tone gives it volume
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = (i % 2 === 0 ? R : r) * 0.64;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad * 0.98 + 0.015;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = 'rgba(255,252,214,0.42)';
  g.fill();
  g.beginPath();
  g.rect(-0.5, 0.10, 1, 0.5);
  g.fillStyle = lg(g, 0, 0.10, 0, 0.5, [[0, 'rgba(150,60,0,0)'], [1, 'rgba(150,60,0,0.35)']]);
  g.fill();
  g.restore();

  rimLight(g, star, 'rgba(255,236,180,0.9)');
  g.strokeStyle = '#5e3406'; g.lineWidth = LW * 1.05; g.stroke(star);

  // face
  for (const ex of [-0.105, 0.105]) {
    g.beginPath();
    g.ellipse(ex, 0.015, 0.042, 0.068, 0, 0, Math.PI * 2);
    g.fillStyle = '#4a2606';
    g.fill();
    g.beginPath();
    g.ellipse(ex - 0.013, -0.012, 0.016, 0.022, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0.075, 0.105, 0.18 * Math.PI, 0.82 * Math.PI);
  g.strokeStyle = '#4a2606';
  g.lineWidth = 0.042;
  g.lineCap = 'round';
  g.stroke();

  specular(g, -0.13, -0.245, 0.10, 0.055, -0.6, 0.85);
}

function drawBolt(g: G) {
  glow(g, 0.5, 'rgba(255,226,120,ALPHA)', 0.62);
  contact(g, 0.45, 0.20, 0.055, 0.3);

  const bolt = new Path2D();
  bolt.moveTo(0.075, -0.475);
  bolt.lineTo(0.335, -0.395);
  bolt.lineTo(0.135, -0.105);
  bolt.lineTo(0.325, -0.045);
  bolt.lineTo(-0.075, 0.475);
  bolt.lineTo(-0.015, 0.075);
  bolt.lineTo(-0.315, 0.015);
  bolt.lineTo(-0.115, -0.325);
  bolt.lineTo(-0.215, -0.375);
  bolt.closePath();

  g.fillStyle = lg(g, -0.3, -0.45, 0.3, 0.45, [[0, '#fffbd2'], [0.28, '#ffe561'], [0.62, '#ffbe1c'], [1, '#e07c07']]);
  g.fill(bolt);

  g.save();
  g.clip(bolt);
  // hot core down the middle — the bit that makes it feel like it's emitting
  g.beginPath();
  g.moveTo(0.115, -0.40);
  g.lineTo(-0.02, -0.10);
  g.lineTo(0.075, -0.02);
  g.lineTo(-0.055, 0.30);
  g.strokeStyle = 'rgba(255,255,240,0.72)';
  g.lineWidth = 0.075;
  g.lineJoin = 'round';
  g.stroke();
  g.beginPath();
  g.rect(-0.5, 0.05, 1, 0.5);
  g.fillStyle = lg(g, 0, 0.05, 0, 0.5, [[0, 'rgba(170,70,0,0)'], [1, 'rgba(170,70,0,0.32)']]);
  g.fill();
  g.restore();

  rimLight(g, bolt, 'rgba(255,240,190,0.9)');
  g.strokeStyle = '#5e3a04'; g.lineWidth = LW * 1.05; g.stroke(bolt);
  specular(g, 0.155, -0.335, 0.075, 0.036, -0.85, 0.9);
}

function drawBomb(g: G) {
  contact(g, 0.45, 0.30, 0.072, 0.5);

  // Feet first, and set wide: against a near-black body they only read if
  // they clear the silhouette.
  for (const fx of [-0.225, 0.225]) {
    g.save();
    g.translate(fx, 0.352);
    g.rotate(fx < 0 ? -0.26 : 0.26);
    g.beginPath();
    g.ellipse(0, 0, 0.138, 0.072, 0, 0, Math.PI * 2);
    g.fillStyle = lg(g, 0, -0.072, 0, 0.072, [[0, '#ffe089'], [0.55, '#ffbc38'], [1, '#cf7a0a']]);
    g.fill();
    g.strokeStyle = INK; g.lineWidth = LW * 0.95; g.stroke();
    g.restore();
  }

  const body = new Path2D();
  body.arc(0, 0.055, 0.365, 0, Math.PI * 2);
  g.fillStyle = rg(g, -0.13, -0.09, 0.02, 0.60, [[0, '#5a6a8c'], [0.32, '#2c3450'], [0.78, '#141a2c'], [1, '#0b0e18']]);
  g.fill(body);

  g.save();
  g.clip(body);
  // warm bounce from below-right: this is the golden-hour scene, after all
  g.beginPath();
  g.arc(0.14, 0.20, 0.30, 0, Math.PI * 2);
  g.fillStyle = rg(g, 0.16, 0.22, 0.02, 0.32, [[0, 'rgba(255,168,96,0.36)'], [1, 'rgba(255,168,96,0)']]);
  g.fill();
  g.restore();

  rimLight(g, body, 'rgba(255,178,104,0.9)');
  g.strokeStyle = INK; g.lineWidth = LW; g.stroke(body);

  // eyes
  for (const ex of [-0.115, 0.115]) {
    g.beginPath();
    g.ellipse(ex, 0.02, 0.072, 0.088, 0, 0, Math.PI * 2);
    g.fillStyle = '#fbf3e4';
    g.fill();
    g.strokeStyle = 'rgba(20,14,30,0.55)'; g.lineWidth = 0.02; g.stroke();
    g.beginPath();
    g.ellipse(ex + 0.012, 0.032, 0.030, 0.044, 0, 0, Math.PI * 2);
    g.fillStyle = '#1a1526';
    g.fill();
  }

  // fuse
  g.beginPath();
  g.moveTo(0.045, -0.29);
  g.bezierCurveTo(0.155, -0.375, 0.19, -0.325, 0.245, -0.40);
  g.strokeStyle = '#8b8168';
  g.lineWidth = 0.062;
  g.lineCap = 'round';
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.lineWidth = 0.022;
  g.stroke();

  // spark
  g.save();
  g.translate(0.265, -0.415);
  g.beginPath();
  g.arc(0, 0, 0.19, 0, Math.PI * 2);
  g.fillStyle = rg(g, 0, 0, 0, 0.19, [[0, 'rgba(255,246,200,0.95)'], [0.28, 'rgba(255,186,60,0.75)'], [1, 'rgba(255,120,30,0)']]);
  g.fill();
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const rr = i % 2 ? 0.055 : 0.115;
    const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fillStyle = '#fff8dc';
  g.fill();
  g.restore();

  specular(g, -0.175, -0.145, 0.115, 0.062, -0.62, 0.62);
  specular(g, 0.09, -0.20, 0.048, 0.026, -0.3, 0.4);
}

/** The empty-slot ghost. */
function drawEmpty(g: G) {
  g.beginPath();
  g.arc(0, 0, 0.34, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(232,238,255,0.22)';
  g.lineWidth = 0.055;
  g.setLineDash([0.10, 0.075]);
  g.stroke();
  g.setLineDash([]);
  g.font = '700 0.46px "SF Pro Display", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(232,238,255,0.26)';
  g.fillText('?', 0, 0.02);
}

const TABLE: Record<number, (g: G) => void> = {
  [ItemKind.None]: drawEmpty,
  [ItemKind.Mushroom]: drawMushroom,
  [ItemKind.TripleMushroom]: drawTripleMushroom,
  [ItemKind.GreenShell]: drawGreenShell,
  [ItemKind.RedShell]: drawRedShell,
  [ItemKind.Banana]: drawBanana,
  [ItemKind.Star]: drawStar,
  [ItemKind.Bolt]: drawBolt,
  [ItemKind.Bomb]: drawBomb,
};

/**
 * Paint `kind` centred in a `size` px box on `g`. The caller owns the canvas
 * clear; we leave the context state exactly as we found it.
 */
export function drawItem(g: G, kind: ItemKind, size: number) {
  g.save();
  g.translate(size * 0.5, size * 0.5);
  g.scale(size * 0.92, size * 0.92); // 4% breathing room for glows and outlines
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
