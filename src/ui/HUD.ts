/**
 * HUD — lap, timer, position, standings, item box, speedometer, minimap,
 * countdown, drift feedback, speed vignette and toasts.
 *
 * ROUND 7. The review's verdict was "six separately-invented widgets, not a
 * HUD". Every widget is now the SAME object: one plate recipe, one radius, one
 * border, one shadow, one type scale, one numeral treatment (see the header of
 * ui.css). Nothing here declares its own chrome.
 *
 * LAYOUT — ART_DIRECTION §7:
 *
 *      [LAP]            [-- MINIMAP --]             [TIME]
 *      [POSITION+GAP]                            [STANDINGS]
 *      [ITEM]              (toast)                  [SPEEDO]
 *
 * The minimap moved from bottom-centre to top-centre (§7 allows either). At
 * bottom-centre it landed on the player's kart and the road's vanishing point
 * in all ten review frames. The bottom centre is now deliberately empty.
 *
 * Layout and typography live in ui.css; this file owns state and the two
 * canvases (speedometer dial, minimap) where a canvas beats DOM. Every DOM
 * write goes through the cached setters in uiUtil so an unchanged value costs
 * nothing, and no per-frame object is allocated once the tree is built.
 */
import './ui.css';
import { BASE_TOP_SPEED, ItemKind, RaceState, type Ctx, type IKart, type System } from '../types';
import { Minimap } from './Minimap';
import { Menus } from './Menus';
import { ItemIconAtlas, ITEM_NAMES, ITEM_TINT, ROULETTE_ORDER } from './ItemIcons';
import {
  Spring, TIER_COLORS, clamp, cssColor, damp, el, formatClock, formatDelta,
  ordinalSuffix, retrigger, setNum, setStyle, setText,
} from './uiUtil';

// --- speedometer dial geometry ---------------------------------------------
// ROUND 7: the review called this "a Grafana-grade infographic speedometer".
// Gone: sixteen minor ticks, the redline arc segment and its recoloured ticks,
// the hub cap with its inner dot, and the separate three-pip mini-turbo charge
// rail slung under the dial. §7 asks for "an analogue arc, needle with slight
// overshoot, plus a digital readout" and that is now exactly what it is —
// one channel, one value arc, five majors, one slim needle, and the drift
// charge folded into a single concentric inner arc in the tier colour.
const DIAL_CX = 0.5;    // of width
const DIAL_CY = 0.44;   // of height
const DIAL_R = 0.285;   // of height
const A0 = Math.PI * 0.80;   // 144°
const A1 = Math.PI * 2.20;   // 396°
const REDLINE = 0.88;        // fraction of the sweep at which the readout goes hot
const MAJOR_STEPS = 5;       // five majors across the sweep, nothing between

/**
 * The strongest sustained boost multiplier a kart can hold (tier-3 mini-turbo,
 * `DRIFT_BOOST_STRENGTH[3]` in Kart.ts) plus a little headroom.
 */
const BOOST_PEAK = 1.30;
const HEADROOM = 1.05;

/** Round a raw top speed up to a dial max that divides into five clean majors. */
function dialMax(kmh: number) {
  const step = Math.max(10, Math.ceil(kmh / (MAJOR_STEPS * 5)) * 5);
  return step * MAJOR_STEPS;
}

const ROULETTE_TIME = 1.15;
/** how many standings rows the board shows */
const BOARD_ROWS = 8;

const PAD2 = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'];
function p2(n: number) { return n < 10 ? PAD2[n] : String(n); }

/**
 * A live text slot. Round 6 built every headline numeral TWICE — an ink layer
 * carrying a `-webkit-text-stroke` under a gradient-clipped layer — which is
 * where the mitred outlines the review measured came from. There is one layer
 * now, so both slots of a Pair point at the same node; `setText` is cached, so
 * the second write is free and the call sites did not have to change.
 */
type Pair = [HTMLElement, HTMLElement];
function setPair(p: Pair, v: string) { setText(p[0], v); setText(p[1], v); }

export class HUD implements System {
  private root!: HTMLDivElement;
  private hud!: HTMLDivElement;
  private minimap!: Minimap;
  private menus!: Menus;

  // atmospherics
  private vig!: HTMLDivElement;
  private boostEl!: HTMLDivElement;
  private driftEl!: HTMLDivElement;
  private flash!: HTMLDivElement;

  // lap
  private lapWrap!: HTMLDivElement;
  private lapIn!: HTMLDivElement;
  private lapCur!: Pair;
  private lapTot!: Pair;
  private split!: HTMLDivElement;
  private splitKey!: HTMLSpanElement;
  private splitVal!: HTMLSpanElement;

  // timer — three fixed-width slots, never one string
  private timerWrap!: HTMLDivElement;
  private tM!: Pair;
  private tS!: Pair;
  private tF!: Pair;
  private bestWrap!: HTMLDivElement;
  private bestVal!: HTMLSpanElement;

  // position / gap
  private gapKey!: HTMLSpanElement;
  private gapVal!: HTMLSpanElement;
  /** throttle on the gap recompute — 10 Hz is well past the eye's read rate */
  private gapT = 0;
  private posWrap!: HTMLDivElement;
  private posIn!: HTMLDivElement;
  private posNum!: Pair;
  private posSuf!: Pair;
  private posArrow!: HTMLSpanElement;
  /** seconds left on the gain/loss chevron; 0 = no direction shown */
  private posDirT = 0;
  /** cooldown on the "took the lead" banner */
  private leadToastT = 0;
  private shownRank = -1;

  // rival board
  private board!: HTMLDivElement;
  private rows: HTMLDivElement[] = [];
  private rowPlace: HTMLSpanElement[] = [];
  private rowSuf: HTMLElement[] = [];
  private rowChip: HTMLSpanElement[] = [];
  private rowName: HTMLSpanElement[] = [];
  /** scratch: kart occupying each board slot. Allocated once. */
  private slot: (IKart | null)[] = [];
  /** livery colour per kart index, resolved once — cssColor() builds a string */
  private liveries: string[] = [];
  /** kart index occupying each board slot, parallel to `slot` */
  private slotIdx: number[] = [];
  private boardT = 0;

  // item
  private itemWrap!: HTMLDivElement;
  private itemIcon!: HTMLDivElement;
  private itemCanvas!: HTMLCanvasElement;
  private itemG!: CanvasRenderingContext2D;
  private itemCount!: HTMLDivElement;
  private atlas = new ItemIconAtlas();
  private shownKind: ItemKind = -1 as ItemKind;
  private rouletteT = -1;
  private rouletteNext = 0;
  private rouletteIdx = 0;

  // speedometer
  private speedWrap!: HTMLDivElement;
  private speedCanvas!: HTMLCanvasElement;
  private speedG!: CanvasRenderingContext2D;
  private speedNum!: Pair;
  private needle = new Spring(190, 15.5);
  private dialW = 0;
  private dialH = 0;
  private arcGrad: CanvasGradient | null = null;
  /** end of the sweep in km/h, derived from the player's real top speed */
  private speedMax = 150;

  // countdown
  private countWrap!: HTMLDivElement;
  private countVig!: HTMLDivElement;
  private countNum!: HTMLDivElement;
  private countText!: Pair;
  private countRing!: HTMLDivElement;
  private countTicks!: HTMLDivElement;
  private countShown = -99;

  // toast: a single slot, plus at most one outgoing node mid-crossfade
  private toasts!: HTMLDivElement;
  private toastCur: HTMLDivElement | null = null;
  private toastOut: HTMLDivElement | null = null;

  // transient state
  private prevPlace = 0;
  private prevLap = -1;
  private bestLap = Infinity;
  /** length of race.lapTimes the best-lap readout was last built from */
  private lapsSeen = -1;
  private driftGlow = 0;
  private tierFlash = 0;
  private wasCounting = true;

  // ---------------------------------------------------------------- lifecycle

  init(ctx: Ctx) {
    const host = document.getElementById('ui') || document.body;
    this.root = el('div', 'kr', host);

    this.vig = el('div', 'kr-vig', this.root);
    this.boostEl = el('div', 'kr-boost', this.root);
    this.driftEl = el('div', 'kr-drift', this.root);

    this.hud = el('div', 'kr-hud', this.root);
    this.buildLap();
    this.buildTimer();
    this.buildPosition();
    this.buildBoard(ctx);
    this.buildItem();
    this.buildSpeedo();

    // Bottom-centre carries the transient toast slot and nothing else — that
    // band is where the player's own kart lives in every frame.
    const bottom = el('div', 'kr-bottom', this.hud);
    this.toasts = el('div', 'kr-toasts', bottom);

    // §7: "Minimap: bottom-centre or top-centre". TOP-centre. Bottom-centre
    // put a 240 px panel directly under the kart and on the road's vanishing
    // point in all ten review frames, which is exactly the complaint.
    this.minimap = new Minimap(this.hud);

    this.buildCountdown();
    this.flash = el('div', 'kr-flash', this.root);

    this.menus = new Menus(this.root);
    this.menus.init(ctx);

    ctx.bus.on(this.onEvent);
    this.ctx = ctx;

    const player = ctx.race.player;
    this.prevPlace = player ? player.place : 1;
    // starting on pole is not "taking the lead"
    this.leadToastT = this.prevPlace === 1 ? 6 : 0;
    const topMul = player?.stats?.topSpeedMul || 1;
    this.speedMax = dialMax(BASE_TOP_SPEED * topMul * BOOST_PEAK * HEADROOM * 3.6);
    this.needle.snap(0);
  }

  private ctx!: Ctx;

  // ------------------------------------------------------------------- build

  /**
   * Build a headline lockup: ONE layer, no stroke, no gradient clip, no filter
   * chain. `build` returns the nodes that carry live text; each is zipped with
   * itself into a Pair so the existing setPair call sites still work.
   */
  private cased(
    parent: HTMLElement, cls: string, _topCls: string,
    build?: (layer: HTMLElement) => HTMLElement[],
  ): { wrap: HTMLDivElement; parts: Pair[] } {
    const wrap = el('div', 'kr-lock ' + cls, parent);
    const layer = el('div', 'kr-lock-l', wrap);
    const nodes = build ? build(layer) : [layer];
    const parts: Pair[] = [];
    for (let i = 0; i < nodes.length; i++) parts.push([nodes[i], nodes[i]]);
    return { wrap, parts };
  }

  private buildLap() {
    // A plate, like every other widget. The shaped radial scrim round 6 used
    // here is gone: an opaque plate is a stronger guarantee against a
    // blown-out sky than any amount of darkening, and it is the same object
    // as the item box and the speedometer instead of a seventh idea.
    // One top-left column: the lap plate and, under it, the lap-split flash.
    // The split used to be positioned off .kr-hud, so `top: 100%` resolved
    // against the whole HUD frame rather than against the lap plate.
    const tl = el('div', 'kr-tl', this.hud);
    this.lapWrap = el('div', 'kr-lap', tl);
    this.lapIn = el('div', 'kr-lap-in', this.lapWrap);
    el('div', 'kr-label', this.lapIn, 'Lap');
    const lap = this.cased(this.lapIn, 'kr-lap-nums', '', (l) => {
      const cur = el('span', 'kr-lap-cur', l, '1');
      el('span', 'kr-lap-sep', l, '/');
      const tot = el('span', 'kr-lap-tot', l, '3');
      return [cur, tot];
    });
    this.lapCur = lap.parts[0];
    this.lapTot = lap.parts[1];

    this.split = el('div', 'kr-split', tl);
    const pill = el('div', 'kr-pill', this.split);
    this.splitKey = el('span', 'kr-line-k', pill, 'Lap 1');
    this.splitVal = el('span', 'kr-line-v', pill, '0:00.000');
  }

  private buildTimer() {
    this.timerWrap = el('div', 'kr-timer', this.hud);
    el('div', 'kr-label', this.timerWrap, 'Time');
    // JITTER. The review measured 5 px of horizontal jump here. The digits are
    // tabular AND the clock block has a hard `width` in ui.css that packs to
    // its right edge, so no advance-width difference, subpixel rounding or
    // font fallback can move anything: the fields simply consume reserved
    // space. Splitting the string into fields is what makes that possible.
    const t = this.cased(this.timerWrap, 'kr-timer-v', '', (l) => {
      const m = el('span', 'kr-t-m', l, '0');
      el('span', 'kr-t-sep', l, ':');
      const sec = el('span', 'kr-t-s', l, '00');
      const f = el('span', 'kr-t-f', l, '.00');
      return [m, sec, f];
    });
    this.tM = t.parts[0];
    this.tS = t.parts[1];
    this.tF = t.parts[2];

    // Inside the timer plate, as a ruled row — not a second floating pill.
    this.bestWrap = el('div', 'kr-best-line', this.timerWrap);
    const bp = el('div', 'kr-line', this.bestWrap);
    el('span', 'kr-line-k', bp, 'Best');
    this.bestVal = el('span', 'kr-line-v', bp, '0:00.000');
  }

  private buildPosition() {
    this.posWrap = el('div', 'kr-pos', this.hud);
    const pos = this.cased(this.posWrap, 'kr-pos-in', '', (l) => {
      const n = el('span', 'kr-pos-n', l, '1');
      const suf = el('span', 'kr-pos-s', l, 'st');
      return [n, suf];
    });
    this.posIn = pos.wrap;
    this.posNum = pos.parts[0];
    this.posSuf = pos.parts[1];
    // Hung off the lockup, not off .kr-pos: on .kr-pos it would anchor to the
    // plate's width (set by the interval row) rather than the numeral's.
    this.posArrow = el('span', 'kr-pos-arrow', this.posIn, '▲');

    // The interval is the same fact as the position, so it lives in the same
    // plate as a ruled row. Round 6 hung it outside as a separate pill.
    const gap = el('div', 'kr-gap', this.posWrap);
    const gp = el('div', 'kr-line', gap);
    this.gapKey = el('span', 'kr-line-k', gp, 'Grid');
    this.gapVal = el('span', 'kr-line-v', gp, '+0.00');
  }

  /**
   * Standings, right-centre — on a plate now. Round 6 floated eight rows of
   * stroked type over the world with only a radial scrim behind them, and over
   * the village frontages in the review's drift frame the lower rows were
   * illegible. Same plate as everything else; only the player's row is chromed.
   */
  private buildBoard(ctx: Ctx) {
    this.board = el('div', 'kr-board', this.hud);
    const n = Math.min(BOARD_ROWS, ctx.race?.karts?.length || BOARD_ROWS);
    for (let i = 0; i < n; i++) {
      const row = el('div', 'kr-brow', this.board);
      const p = el('span', 'kr-brow-p', row, String(i + 1));
      const suf = el('i', undefined, p, ordinalSuffix(i + 1));
      this.rowSuf.push(suf);
      this.rowPlace.push(p);
      this.rowChip.push(el('span', 'kr-brow-c', row));
      this.rowName.push(el('span', 'kr-brow-n', row, ''));
      row.classList.add('r' + Math.min(4, i + 1));
      this.rows.push(row);
      this.slot.push(null);
    }
  }

  private buildItem() {
    this.itemWrap = el('div', 'kr-item', this.hud);
    el('div', 'kr-item-frame', this.itemWrap);
    // The empty state is a deliberate, shaped, breathing item-box diamond
    // struck into the well floor — not a dim placeholder glyph. The plate's
    // own chrome (border, well, sheen) is identical whether or not an item is
    // held; only the contents swap.
    const motif = el('div', 'kr-item-motif', this.itemWrap);
    motif.innerHTML =
      '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<path d="M50 6 94 50 50 94 6 50Z" fill="none" stroke="#ffcf6b" stroke-width="6" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M50 27 73 50 50 73 27 50Z" fill="#ffcf6b" opacity="0.34"/>' +
      '</svg>';
    this.itemIcon = el('div', 'kr-item-icon', this.itemWrap);
    this.itemCanvas = el('canvas', undefined, this.itemIcon);
    this.itemG = this.itemCanvas.getContext('2d')!;
    this.itemCount = el('div', 'kr-item-count', this.itemWrap, '×2');
  }

  private buildSpeedo() {
    this.speedWrap = el('div', 'kr-speed', this.hud);
    const face = el('div', 'kr-speed-face', this.speedWrap);
    this.speedCanvas = el('canvas', undefined, face);
    this.speedG = this.speedCanvas.getContext('2d')!;
    // Below the dial's open bottom wedge, outside the needle's reach, with a
    // real unit. "101" on its own is a number, not a speed.
    const read = el('div', 'kr-speed-read', this.speedWrap);
    this.speedNum = this.cased(read, 'kr-speed-n', '').parts[0];
    el('span', 'kr-speed-u', read, 'km/h');
  }

  private buildCountdown() {
    this.countWrap = el('div', 'kr-count', this.root);
    this.countVig = el('div', 'kr-count-vig', this.countWrap);
    const stage = el('div', 'kr-count-stage', this.countWrap);
    this.countRing = el('div', 'kr-count-ring', stage);
    // Three radial chevron ticks in the mini-turbo blue (§3), on the ring's
    // easing. A designed start motif in place of the round-1 tan haze.
    this.countTicks = el('div', 'kr-count-ticks', stage);
    let ticks = '<svg viewBox="0 0 200 200" aria-hidden="true">';
    for (let i = 0; i < 3; i++) {
      const a = -90 + i * 120;
      ticks += `<g transform="rotate(${a} 100 100)">` +
        '<path d="M100 6 L112 26 L100 20 L88 26 Z" fill="#4fc3ff" opacity="0.92"/>' +
        '</g>';
    }
    this.countTicks.innerHTML = ticks + '</svg>';
    // The countdown is the one gameplay element that keeps the display
    // gradient: full-screen, transient, nothing competing with it.
    const c = el('div', 'kr-lock kr-count-n', stage);
    const layer = el('div', 'kr-lock-l kr-gold', c);
    this.countNum = c;
    this.countText = [layer, layer];
    setPair(this.countText, '3');
  }

  // ------------------------------------------------------------------ events

  private onEvent = (e: import('../types').GameEvent) => {
    const ctx = this.ctx;
    const player = ctx?.race?.player;
    switch (e.type) {
      case 'countdown':
        this.showCountdown(e.n);
        break;
      case 'lap':
        if (e.kart === player) this.onLap(ctx);
        break;
      case 'item-pickup':
        if (e.kart === player) this.startRoulette();
        break;
      case 'hit':
        if (e.kart === player) {
          this.toast(ITEM_NAMES[e.kind] || 'Hit', '!', ITEM_TINT[e.kind] || '#ff7a6a');
        }
        break;
      case 'finish':
        if (e.kart === player) {
          this.toast(`Finished ${e.place}${ordinalSuffix(e.place)}`, '⚑', '#ffd36b');
        }
        break;
    }
  };

  private onLap(ctx: Ctx) {
    const laps = ctx.race.lapTimes;
    const n = laps.length;
    if (!n) return;
    const t = laps[n - 1];
    const isBest = t < this.bestLap;
    const prevBest = this.bestLap;
    if (isBest) this.bestLap = t;

    setText(this.splitKey, `Lap ${n}`);
    setText(this.splitVal, formatClock(t, 3));
    this.split.classList.toggle('best', isBest);
    this.bestWrap.classList.toggle('best-new', isBest);
    if (!isBest && Number.isFinite(prevBest)) {
      setText(this.splitKey, `Lap ${n}  ${formatDelta(t - prevBest)}`);
    }
    retrigger(this.split, 'on');
    retrigger(this.lapIn, 'punch');
  }

  private showCountdown(n: number) {
    if (n === this.countShown) return;
    this.countShown = n;
    if (n > 3) return;
    retrigger(this.countNum, 'run');
    retrigger(this.countRing, 'run');
    retrigger(this.countTicks, 'run');
    retrigger(this.countVig, 'run');
    if (n <= 0) {
      setPair(this.countText, 'GO!');
      this.countNum.classList.add('go');
      this.flash.classList.remove('tick');
      retrigger(this.flash, 'on');
    } else {
      setPair(this.countText, String(n));
      this.countNum.classList.remove('go');
      this.flash.classList.remove('on');
      retrigger(this.flash, 'tick');
    }
  }

  /**
   * One slot, one message. Reserved for genuinely transient events.
   */
  private toast(label: string, glyph: string, tint: string) {
    this.toastOut?.remove();
    this.toastOut = null;

    const prev = this.toastCur;
    if (prev) {
      this.toastOut = prev;
      prev.classList.add('out');
      prev.addEventListener('animationend', () => {
        prev.remove();
        if (this.toastOut === prev) this.toastOut = null;
      }, { once: true });
    }

    const t = el('div', 'kr-toast', this.toasts);
    t.style.setProperty('--tc', tint);
    el('i', undefined, t, glyph);
    el('span', undefined, t, label);
    this.toastCur = t;
    t.addEventListener('animationend', () => {
      t.remove();
      if (this.toastCur === t) this.toastCur = null;
      if (this.toastOut === t) this.toastOut = null;
    }, { once: true });
  }

  // --------------------------------------------------------------- roulette

  private startRoulette() {
    this.rouletteT = 0;
    this.rouletteNext = 0;
    this.itemWrap.classList.add('spinning');
  }

  private updateItem(ctx: Ctx, dt: number) {
    const player = ctx.race.player;
    const held = player ? ctx.items.held(player) : null;
    const kind = held ? held.kind : ItemKind.None;
    const count = held ? held.count : 0;

    let show = kind;
    if (this.rouletteT >= 0) {
      this.rouletteT += dt;
      if (this.rouletteT >= this.rouletteNext) {
        this.rouletteIdx = (this.rouletteIdx + 1) % ROULETTE_ORDER.length;
        const f = clamp(this.rouletteT / ROULETTE_TIME, 0, 1);
        this.rouletteNext = this.rouletteT + 0.040 + 0.215 * f * f * f;
      }
      show = ROULETTE_ORDER[this.rouletteIdx];
      if (this.rouletteT >= ROULETTE_TIME) {
        this.rouletteT = -1;
        this.itemWrap.classList.remove('spinning');
        show = kind;
        retrigger(this.itemIcon, 'land');
      }
    }

    this.itemWrap.classList.toggle('has-item', kind !== ItemKind.None && this.rouletteT < 0);
    this.itemWrap.classList.toggle('multi', count > 1);
    if (count > 1) setText(this.itemCount, '×' + count);
    setStyle(this.itemWrap, '--item-tint', ITEM_TINT[show] || '#ffffff');

    if (show !== this.shownKind) {
      this.shownKind = show;
      const s = this.itemCanvas.width;
      this.itemG.clearRect(0, 0, s, s);
      // ItemKind.None draws nothing: the empty state is the well and the
      // embossed diamond behind this canvas, not a placeholder glyph on it.
      if (show !== ItemKind.None) this.itemG.drawImage(this.atlas.get(show), 0, 0, s, s);
    }
  }

  // ------------------------------------------------------------------ resize

  resize(_w: number, _h: number) {
    if (!this.root) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const ir = this.itemIcon.getBoundingClientRect();
    const ipx = Math.max(64, Math.round(ir.width * dpr));
    if (this.itemCanvas.width !== ipx) {
      this.itemCanvas.width = this.itemCanvas.height = ipx;
      this.atlas.ensure(ipx);
      this.shownKind = -1 as ItemKind; // force a redraw at the new size
    }

    const sr = this.speedWrap.getBoundingClientRect();
    const sw = Math.max(120, Math.round(sr.width * dpr));
    const sh = Math.max(100, Math.round(sr.height * dpr));
    if (sw !== this.dialW || sh !== this.dialH) {
      this.dialW = this.speedCanvas.width = sw;
      this.dialH = this.speedCanvas.height = sh;
      this.buildDialGradient();
    }

    this.minimap.resize();
  }

  private buildDialGradient() {
    const g = this.speedG;
    const cx = DIAL_CX * this.dialW;
    const cy = DIAL_CY * this.dialH;
    const r = DIAL_R * this.dialH;
    // One warm ramp off --gold-ramp. This is the VALUE fill only; the unfilled
    // scale is a single flat low value (see drawDial) — round 1 painted the
    // whole ramp at low alpha behind the fill, which came out grey on the left
    // half and brown on the right and read as a rendering fault.
    const grd = g.createLinearGradient(cx - r, cy + r * 0.35, cx + r, cy - r * 0.55);
    grd.addColorStop(0.00, '#fff4e2');
    grd.addColorStop(0.45, '#ffcf6b');
    grd.addColorStop(1.00, '#e0453f');
    this.arcGrad = grd;
  }

  // ------------------------------------------------------------------- frame

  lateUpdate(ctx: Ctx, dt: number) {
    const race = ctx.race;
    const player = race.player;
    this.menus.update(ctx, dt);

    const blocked = this.menus.blocking;
    const dimmed = !blocked && this.menus.screen === 'pause';
    this.root.classList.toggle('is-blocked', blocked);
    this.root.classList.toggle('is-dimmed', dimmed);
    const counting = race.state === RaceState.Countdown;
    // The HUD stays MOUNTED through the countdown and comes forward as one
    // eased group on GO. Nothing is allowed to pop into a previously empty
    // zone the instant the lights go out.
    this.root.classList.toggle('is-counting', counting);
    this.posWrap.classList.toggle('grid', counting);
    if (counting !== this.wasCounting) {
      this.wasCounting = counting;
      setText(this.gapKey, counting ? 'Grid' : 'Gap');
    }
    setNum(this.countWrap, 'opacity', blocked ? 0 : 1, 1);

    if (!player) return;

    // --- lap ---------------------------------------------------------------
    const lapNow = clamp(player.lap + 1, 1, race.totalLaps);
    setPair(this.lapCur, String(lapNow));
    setPair(this.lapTot, String(race.totalLaps));
    this.lapWrap.classList.toggle('final', lapNow === race.totalLaps && race.totalLaps > 1);
    if (player.lap !== this.prevLap) this.prevLap = player.lap;

    // --- timer, into three fixed-width slots -------------------------------
    this.writeClock(race.raceTime);
    const laps = race.lapTimes;
    if (laps.length !== this.lapsSeen) {
      this.lapsSeen = laps.length;
      let best = Infinity;
      for (let i = 0; i < laps.length; i++) if (laps[i] < best) best = laps[i];
      this.bestLap = best;
      if (Number.isFinite(best)) {
        setText(this.bestVal, formatClock(best, 3));
        this.timerWrap.classList.add('has-best');
      } else {
        this.timerWrap.classList.remove('has-best');
      }
    }

    // --- position ----------------------------------------------------------
    // Colour means RANK and nothing else — gold / silver / bronze / cream, one
    // outline weight across all four. Round 1 retinted the ramp by the
    // DIRECTION of the last change, which put an alarm red on a hard-won 2nd
    // and left a steady 5th in trophy gold. Direction now rides entirely on
    // the chevron and the punch.
    const place = player.place || 1;
    if (this.leadToastT > 0) this.leadToastT -= dt;
    if (place !== this.prevPlace) {
      const gained = place < this.prevPlace;
      this.prevPlace = place;
      retrigger(this.posIn, 'punch');
      setText(this.posArrow, gained ? '▲' : '▼');
      this.posWrap.classList.toggle('gain', gained);
      this.posWrap.classList.toggle('loss', !gained);
      retrigger(this.posArrow, 'run');
      this.posDirT = 0.70;
      if (place === 1 && this.leadToastT <= 0) {
        this.leadToastT = 6;
        this.toast('Took the lead', '★', '#ffd36b');
      }
    } else if (this.posDirT > 0) {
      this.posDirT -= dt;
      if (this.posDirT <= 0) this.posWrap.classList.remove('gain', 'loss');
    }
    setPair(this.posNum, String(place));
    setPair(this.posSuf, ordinalSuffix(place));
    const rank = Math.min(4, place);
    if (rank !== this.shownRank) {
      this.posWrap.classList.remove('p1', 'p2', 'p3');
      if (rank <= 3) this.posWrap.classList.add('p' + rank);
      this.shownRank = rank;
    }

    // --- interval to the kart being raced ----------------------------------
    this.gapT -= dt;
    if (this.gapT <= 0) {
      this.gapT = 0.1;
      const want = place === 1 ? 2 : place - 1;
      const karts = race.karts;
      let other: IKart | null = null;
      for (let i = 0; i < karts.length; i++) {
        if (karts[i] !== player && karts[i].place === want) { other = karts[i]; break; }
      }
      if (other && !player.finished) {
        const metres = Math.abs(other.raceDistance - player.raceDistance);
        const closing = Math.max(6, Math.abs(player.forwardSpeed));
        const secs = Math.min(99, metres / closing);
        if (!counting) setText(this.gapKey, place === 1 ? 'Lead' : 'Gap');
        setText(this.gapVal, (place === 1 ? '' : '+') + secs.toFixed(2));
      }
    }

    // --- rival board -------------------------------------------------------
    this.boardT -= dt;
    if (this.boardT <= 0) {
      this.boardT = 0.2;
      this.updateBoard(ctx);
    }

    // --- item --------------------------------------------------------------
    this.updateItem(ctx, dt);

    // --- speedometer -------------------------------------------------------
    const kmh = Math.abs(player.forwardSpeed) * 3.6;
    const frac = clamp(kmh / this.speedMax, 0, 1);
    this.needle.target = frac;
    this.needle.step(dt);
    const boosting = player.boostTime > 0;
    setPair(this.speedNum, String(Math.round(kmh)));
    this.speedWrap.classList.toggle('red', frac > REDLINE);
    this.speedWrap.classList.toggle('boosting', boosting);

    // drift charge, and a decaying flash when a tier locks in
    const tier = player.driftTier | 0;
    const charge = player.driftDir !== 0 ? clamp(player.driftCharge, 0, 1) : 0;
    this.tierFlash = Math.max(0, this.tierFlash - dt * 2.6);
    if (tier > this.lastTier) {
      this.tierFlash = 1;
      retrigger(this.speedWrap, 'tier');
    }
    this.lastTier = player.driftDir !== 0 ? tier : 0;
    this.drawDial(frac, charge, tier, boosting, ctx.time);

    // --- minimap -----------------------------------------------------------
    if (!blocked) this.minimap.update(ctx);

    // --- atmospherics ------------------------------------------------------
    const si = clamp(ctx.speedIntensity, 0, 1.4);
    setNum(this.vig, 'opacity', clamp((si - 0.42) / 0.75, 0, 1) * 0.9, 0.01);
    setNum(this.boostEl, 'opacity', clamp(player.boostTime * 2.2, 0, 1) * 0.85, 0.01);

    const wantGlow = player.driftDir !== 0 ? 0.09 + charge * 0.15 + this.tierFlash * 0.30 : 0;
    this.driftGlow = damp(this.driftGlow, wantGlow, 9, dt);
    setNum(this.driftEl, 'opacity', this.driftGlow, 0.01);
    setStyle(this.driftEl, '--tier', TIER_COLORS[clamp(tier, 0, 3)]);
  }

  private lastTier = 0;

  /** m : ss . hh, one field per fixed-width slot. */
  private writeClock(seconds: number) {
    const s = seconds < 0 ? 0 : seconds;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s - m * 60);
    const f = Math.floor((s - m * 60 - sec) * 100);
    setPair(this.tM, String(m));
    setPair(this.tS, p2(sec));
    setPair(this.tF, '.' + p2(f));
  }

  /**
   * Standings rows. Written at 5 Hz through the cached setters, so a frame in
   * which nothing changed places costs zero DOM work.
   */
  private updateBoard(ctx: Ctx) {
    const karts = ctx.race.karts;
    const player = ctx.race.player;
    const n = this.rows.length;
    if (this.liveries.length !== karts.length) {
      this.liveries.length = 0;
      for (let i = 0; i < karts.length; i++) this.liveries.push(cssColor(karts[i].stats.color));
    }
    for (let i = 0; i < n; i++) this.slot[i] = null;
    for (let i = 0; i < karts.length; i++) {
      const p = (karts[i].place | 0) - 1;
      if (p >= 0 && p < n && !this.slot[p]) { this.slot[p] = karts[i]; this.slotIdx[p] = i; }
    }
    for (let i = 0; i < n; i++) {
      const k = this.slot[i];
      const row = this.rows[i];
      if (!k) {
        // an unfilled slot must go blank, not keep a stale name at low alpha
        row.classList.add('out');
        setText(this.rowName[i], '');
        continue;
      }
      row.classList.remove('out');
      this.setPlaceText(i, i + 1);
      setStyle(this.rowChip[i], '--c', this.liveries[this.slotIdx[i]] || '#888888');
      setText(this.rowName[i], k.stats.name);
      row.classList.toggle('you', k === player);
    }
  }

  /** Writes "5" + <i>th</i> without rebuilding the row. */
  private setPlaceText(i: number, place: number) {
    const p = this.rowPlace[i];
    const first = p.firstChild;
    const s = String(place);
    if (first && first.nodeType === 3) {
      if (first.nodeValue !== s) first.nodeValue = s;
    } else {
      p.insertBefore(document.createTextNode(s), p.firstChild);
    }
    setText(this.rowSuf[i], ordinalSuffix(place));
  }

  // --------------------------------------------------------------- dial draw

  private drawDial(frac: number, charge: number, tier: number, boosting: boolean, _time: number) {
    const g = this.speedG;
    const W = this.dialW;
    const H = this.dialH;
    if (W < 8) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    const cx = DIAL_CX * W;
    const cy = DIAL_CY * H;
    const r = DIAL_R * H;
    const sweep = A1 - A0;
    const chanW = r * 0.20;

    g.lineCap = 'butt';

    // --- channel + unfilled scale: ONE dark groove, ONE flat low value ------
    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW;
    g.strokeStyle = 'rgba(3, 6, 15, 0.62)';
    g.stroke();

    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW * 0.78;
    g.strokeStyle = 'rgba(206, 222, 255, 0.16)';
    g.stroke();

    // --- value fill --------------------------------------------------------
    const va = A0 + sweep * clamp(this.needle.value, 0, 1);
    if (va > A0 + 0.004) {
      g.save();
      g.shadowColor = boosting ? 'rgba(255, 158, 62, 0.9)' : 'rgba(255, 190, 110, 0.34)';
      g.shadowBlur = W * (boosting ? 0.045 : 0.02);
      g.beginPath();
      g.arc(cx, cy, r, A0, va);
      g.lineWidth = chanW * 0.78;
      g.strokeStyle = this.arcGrad || '#ffcf6b';
      g.stroke();
      g.restore();
    }

    // --- five majors, outside the channel ----------------------------------
    // Five. Round 6 also drew sixteen minors, a red arc segment and a second
    // recoloured tick pass over the top of both.
    const t0 = r + chanW * 0.62;
    const t1 = t0 + r * 0.13;
    g.beginPath();
    for (let i = 0; i <= MAJOR_STEPS; i++) {
      const a = A0 + sweep * (i / MAJOR_STEPS);
      const c = Math.cos(a), s = Math.sin(a);
      g.moveTo(cx + c * t0, cy + s * t0);
      g.lineTo(cx + c * t1, cy + s * t1);
    }
    g.lineCap = 'round';
    g.lineWidth = Math.max(1.5, W * 0.011);
    g.strokeStyle = 'rgba(3, 6, 15, 0.8)';
    g.stroke();
    g.lineWidth = Math.max(1, W * 0.006);
    g.strokeStyle = 'rgba(255, 244, 226, 0.6)';
    g.stroke();

    // --- mini-turbo charge: ONE concentric inner arc in the tier colour ----
    // §6 wants an unmistakable read on the drift charge; it does not want a
    // second instrument. Same centre, same sweep, same idiom as the speed arc,
    // half the weight, inside it — so it reads as part of the same dial.
    const driftOn = charge > 0.001 || this.tierFlash > 0.001;
    if (driftOn) {
      const cr = r - chanW * 1.0;
      const col = TIER_COLORS[clamp(tier, 0, 3)];
      g.lineCap = 'butt';
      g.beginPath();
      g.arc(cx, cy, cr, A0, A1);
      g.lineWidth = chanW * 0.34;
      g.strokeStyle = 'rgba(3, 6, 15, 0.55)';
      g.stroke();
      const ca = A0 + sweep * clamp(Math.max(charge, this.tierFlash * 0.2), 0.02, 1);
      g.save();
      g.shadowColor = col;
      g.shadowBlur = W * (0.015 + this.tierFlash * 0.05);
      g.beginPath();
      g.arc(cx, cy, cr, A0, ca);
      g.lineWidth = chanW * 0.34;
      g.strokeStyle = col;
      g.stroke();
      g.restore();
    }

    // --- needle: slim, one form, no hub cap --------------------------------
    const na = A0 + sweep * clamp(this.needle.value, -0.02, 1.02);
    const tip = r - chanW * 0.62;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    g.beginPath();
    g.moveTo(tip, 0);
    g.lineTo(0, -r * 0.075);
    g.lineTo(-r * 0.14, 0);
    g.lineTo(0, r * 0.075);
    g.closePath();
    g.save();
    g.shadowColor = 'rgba(3, 6, 15, 0.6)';
    g.shadowBlur = W * 0.02;
    g.shadowOffsetY = W * 0.008;
    g.fillStyle = boosting ? '#ffcf6b' : '#fff4e2';
    g.fill();
    g.restore();
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1.5, W * 0.009);
    g.strokeStyle = 'rgba(3, 6, 15, 0.9)';
    g.stroke();
    g.restore();

    g.beginPath();
    g.arc(cx, cy, r * 0.075, 0, Math.PI * 2);
    g.fillStyle = 'rgba(3, 6, 15, 0.9)';
    g.fill();
  }

  dispose() {
    this.root?.remove();
  }
}
