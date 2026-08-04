import { ItemKind } from '../types';

type G = CanvasRenderingContext2D;

const INK = '#21182d';
const LINE = 0.055;

function contact(g: G) {
  g.save();
  g.translate(0, 0.43);
  g.scale(1, 0.24);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, 0.34);
  glow.addColorStop(0, 'rgba(20,14,30,.42)');
  glow.addColorStop(1, 'rgba(20,14,30,0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(0, 0, 0.34, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function fill(g: G, path: Path2D, top: string, bottom: string) {
  const ramp = g.createLinearGradient(0, -0.48, 0, 0.48);
  ramp.addColorStop(0, top);
  ramp.addColorStop(1, bottom);
  g.fillStyle = ramp;
  g.fill(path);
  g.save();
  g.clip(path);
  const shine = g.createRadialGradient(-0.2, -0.25, 0, -0.2, -0.25, 0.5);
  shine.addColorStop(0, 'rgba(255,255,255,.55)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = shine;
  g.fillRect(-0.6, -0.6, 1.2, 1.2);
  g.restore();
  g.strokeStyle = INK;
  g.lineWidth = LINE;
  g.lineJoin = 'round';
  g.stroke(path);
}

function turbo(g: G) {
  contact(g);
  const can = new Path2D();
  can.roundRect(-0.27, -0.34, 0.54, 0.72, 0.13);
  fill(g, can, '#ffd071', '#e54d13');
  g.strokeStyle = '#fff7dc';
  g.lineWidth = 0.075;
  g.lineCap = 'round';
  for (const x of [-0.1, 0.08]) {
    g.beginPath();
    g.moveTo(x - 0.08, -0.13);
    g.lineTo(x + 0.05, 0);
    g.lineTo(x - 0.08, 0.13);
    g.stroke();
  }
}

function slowDisc(g: G) {
  contact(g);
  const disc = new Path2D();
  disc.ellipse(0, 0.08, 0.45, 0.26, 0, 0, Math.PI * 2);
  fill(g, disc, '#8ff3ff', '#2176a8');
  const hub = new Path2D();
  hub.ellipse(0, 0.045, 0.19, 0.11, 0, 0, Math.PI * 2);
  fill(g, hub, '#f8fdff', '#86b9d0');
  g.strokeStyle = '#d8fbff';
  g.lineWidth = 0.045;
  g.beginPath();
  g.arc(0, 0.05, 0.32, Math.PI * 0.1, Math.PI * 0.9);
  g.stroke();
}

function flyBall(g: G) {
  contact(g);
  for (const side of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(side * 0.18, -0.08);
    wing.quadraticCurveTo(side * 0.58, -0.34, side * 0.44, 0.08);
    wing.quadraticCurveTo(side * 0.28, 0.13, side * 0.18, 0.06);
    wing.closePath();
    fill(g, wing, '#e8fbff', '#68bada');
  }
  const orb = new Path2D();
  orb.arc(0, 0.02, 0.29, 0, Math.PI * 2);
  fill(g, orb, '#ff9a9c', '#c32643');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(-0.09, -0.04, 0.055, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(0.09, -0.04, 0.055, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK;
  g.beginPath(); g.arc(-0.075, -0.035, 0.025, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(0.075, -0.035, 0.025, 0, Math.PI * 2); g.fill();
}

function banana(g: G) {
  contact(g);
  const fruit = new Path2D();
  fruit.moveTo(-0.4, -0.25);
  fruit.bezierCurveTo(-0.28, 0.35, 0.2, 0.48, 0.43, -0.04);
  fruit.bezierCurveTo(0.17, 0.27, -0.12, 0.22, -0.2, -0.31);
  fruit.closePath();
  fill(g, fruit, '#fff46d', '#efa914');
  g.strokeStyle = '#6d4616';
  g.lineWidth = 0.065;
  g.beginPath(); g.moveTo(-0.4, -0.27); g.lineTo(-0.34, -0.34); g.stroke();
}

function shield(g: G) {
  contact(g);
  const plate = new Path2D();
  plate.moveTo(0, -0.47);
  plate.lineTo(0.39, -0.31);
  plate.lineTo(0.34, 0.13);
  plate.quadraticCurveTo(0.26, 0.36, 0, 0.5);
  plate.quadraticCurveTo(-0.26, 0.36, -0.34, 0.13);
  plate.lineTo(-0.39, -0.31);
  plate.closePath();
  fill(g, plate, '#9af4ff', '#2471cf');
  g.strokeStyle = '#eaffff';
  g.lineWidth = 0.07;
  g.beginPath();
  g.moveTo(0, -0.3); g.lineTo(0, 0.29);
  g.moveTo(-0.22, -0.17); g.lineTo(0.22, -0.17);
  g.stroke();
}

function devil(g: G) {
  contact(g);
  const head = new Path2D();
  head.moveTo(-0.34, -0.2);
  head.lineTo(-0.45, -0.48);
  head.lineTo(-0.12, -0.32);
  head.quadraticCurveTo(0, -0.39, 0.12, -0.32);
  head.lineTo(0.45, -0.48);
  head.lineTo(0.34, -0.2);
  head.quadraticCurveTo(0.43, 0.37, 0, 0.43);
  head.quadraticCurveTo(-0.43, 0.37, -0.34, -0.2);
  head.closePath();
  fill(g, head, '#d995ff', '#7022a8');
  g.strokeStyle = '#fff0b0';
  g.lineWidth = 0.065;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-0.19, -0.05); g.lineTo(-0.07, 0.01);
  g.moveTo(0.19, -0.05); g.lineTo(0.07, 0.01);
  g.stroke();
  g.beginPath();
  g.arc(0, 0.11, 0.13, 0.12 * Math.PI, 0.88 * Math.PI);
  g.stroke();
}

export function drawKartRoyaleItem(g: G, kind: ItemKind) {
  switch (kind) {
    case ItemKind.Mushroom: turbo(g); return true;
    case ItemKind.GreenShell: slowDisc(g); return true;
    case ItemKind.RedShell: flyBall(g); return true;
    case ItemKind.Banana: banana(g); return true;
    case ItemKind.Star: shield(g); return true;
    case ItemKind.Bolt: devil(g); return true;
    default: return false;
  }
}
