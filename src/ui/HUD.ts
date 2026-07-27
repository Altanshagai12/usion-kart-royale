/**
 * HUD — lap, timer, position, rival board, item box, speedometer, minimap,
 * countdown, drift feedback, speed vignette and toasts.
 *
 * LAYOUT (round 2). Five zones off one safe-area token, not a stack:
 *
 *      LAP  top-left                                   top-right  TIME
 *      POSITION + GAP  left-centre        right-centre  RIVAL BOARD
 *      bottom rail:  [ITEM]      [--- MINIMAP ---]      [SPEEDO]
 *
 * Round 1 put LAP, POSITION, GAP, MINIMAP and ITEM all inside x<300 and left
 * the whole right-centre and bottom-centre empty, which is what made every
 * frame read left-heavy. The minimap is now bottom-centre as ART_DIRECTION §7
 * requires, the three bottom panels share one height and one bottom edge, and
 * the right-centre carries the standings.
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
// Fractions of the canvas: CX/CY/R are keyed to HEIGHT (except cx), because
// what has to fit is the vertical stack — dial, charge rail, readout — and the
// panel is very close to square.
//
// The dial sweeps 252° with its opening at the bottom. Everything below
// DIAL_CY + 0.588 * (tick tip radius) is free, and that strip carries the
// mini-turbo charge rail and the digital readout. Round 1 put the readout
// under the hub, INSIDE the arc, and the needle swept straight through the
// digits at both ends of the range.
const DIAL_CX = 0.5;    // of width
const DIAL_CY = 0.40;   // of height
const DIAL_R = 0.30;    // of height
const A0 = Math.PI * 0.80;   // 144°
const A1 = Math.PI * 2.20;   // 396°
const REDLINE = 0.88;        // fraction of the sweep where the scale goes hot
const DIVS = 20;             // 20 steps across the sweep
const MAJOR_EVERY = 4;       // five majors, four minors between each pair

/** Charge rail, in the open wedge directly under the dial. */
const RAIL_Y = 0.650;   // of height
const RAIL_HW = 0.255;  // half-width, of width
const RAIL_T = 0.030;   // thickness, of height

/**
 * The strongest sustained boost multiplier a kart can hold (tier-3 mini-turbo,
 * `DRIFT_BOOST_STRENGTH[3]` in Kart.ts) plus a little headroom.
 */
const BOOST_PEAK = 1.30;
const HEADROOM = 1.05;
const MAJOR_STEPS = DIVS / MAJOR_EVERY; // 5

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
 * A live text slot in a two-layer cased lockup: [ink layer node, top layer
 * node]. Both carry the same string; the ink layer draws the outline with a
 * real font stroke and the top layer draws the gradient over it.
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

    // Transient slot only, and it sits ABOVE the minimap so the two never
    // share pixels.
    const bottom = el('div', 'kr-bottom', this.hud);
    this.toasts = el('div', 'kr-toasts', bottom);

    // §7: "Minimap: bottom-centre or top-centre". Bottom-centre, centred on
    // the frame axis and locked to the same bottom line as the item box and
    // the speedometer, so the foot of the frame is one rail of three panels at
    // one height rather than a left-hand column of stacked widgets.
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
   * Build a two-layer cased lockup: an ink layer carrying a real font stroke,
   * and a gradient-clipped layer on top of it. `build` is called once per
   * layer and returns the nodes that carry live text, in the same order both
   * times; the two are zipped into Pairs so one setPair writes both.
   *
   * This replaces round 1's chained-drop-shadow outline, which compounded
   * (each shadow filters the previous one's output) and hit Chromium's
   * filter-region clip — the stair-stepped diagonals and mitre spikes the
   * review measured. One stroke, no filter chain, and it costs less per frame.
   */
  private cased(
    parent: HTMLElement, cls: string, topCls: string,
    build?: (layer: HTMLElement) => HTMLElement[],
  ): { wrap: HTMLDivElement; parts: Pair[] } {
    const wrap = el('div', 'kr-cased ' + cls, parent);
    const mk = (extra: string) => {
      const l = el('div', 'kr-cased-l ' + extra, wrap);
      return build ? build(l) : [l];
    };
    const ink = mk('kr-cased-ink');
    const top = mk('kr-cased-top ' + topCls);
    const parts: Pair[] = [];
    for (let i = 0; i < ink.length; i++) parts.push([ink[i], top[i]]);
    return { wrap, parts };
  }

  private buildLap() {
    // kr-scrim: a shaped darken so the lockup survives whatever the world puts
    // behind it — in the round-1 hero frame a grandstand roof and its post sat
    // directly under this cluster.
    this.lapWrap = el('div', 'kr-lap kr-scrim', this.hud);
    this.lapIn = el('div', 'kr-lap-in', this.lapWrap);
    el('div', 'kr-label', this.lapIn, 'Lap');
    // One gold-clipped word: the ramp lives on the lockup, so "1" and "/3"
    // ride one continuous gradient instead of each re-ramping over its own box.
    const lap = this.cased(this.lapIn, 'kr-lap-nums', 'kr-gold kr-gold-q', (l) => {
      const cur = el('span', 'kr-lap-cur', l, '1');
      el('span', 'kr-lap-sep', l, '/');
      const tot = el('span', 'kr-lap-tot', l, '3');
      return [cur, tot];
    });
    this.lapCur = lap.parts[0];
    this.lapTot = lap.parts[1];

    this.split = el('div', 'kr-split', this.hud);
    const pill = el('div', 'kr-pill', this.split);
    this.splitKey = el('span', 'kr-pill-k', pill, 'Lap 1');
    this.splitVal = el('span', 'kr-pill-v', pill, '0:00.000');
  }

  private buildTimer() {
    this.timerWrap = el('div', 'kr-timer', this.hud);
    el('div', 'kr-label', this.timerWrap, 'Time');
    // Fixed-width slots. The hundredths roll every frame; any advance-width
    // difference at all — and a right-anchored string has nowhere to put it —
    // pumps the head of the clock sideways sixty times a second. Each field is
    // its own fixed-em inline-block, so the block width is a constant.
    const t = this.cased(this.timerWrap, 'kr-timer-v', 'kr-gold kr-gold-q', (l) => {
      const m = el('span', 'kr-t-m', l, '0');
      el('span', 'kr-t-sep', l, ':');
      const sec = el('span', 'kr-t-s', l, '00');
      const f = el('span', 'kr-t-f', l, '.00');
      return [m, sec, f];
    });
    this.tM = t.parts[0];
    this.tS = t.parts[1];
    this.tF = t.parts[2];

    this.bestWrap = el('div', 'kr-best-line', this.timerWrap);
    const bp = el('div', 'kr-pill', this.bestWrap);
    el('span', 'kr-pill-k', bp, 'Best');
    this.bestVal = el('span', 'kr-pill-v', bp, '0:00.000');
  }

  private buildPosition() {
    this.posWrap = el('div', 'kr-pos kr-scrim', this.hud);
    // The gold clip lives on the LOCKUP, not on the glyphs: numeral and
    // ordinal share one ramp and one outline, so the suffix stops reading as a
    // foreign object stuck onto the numeral.
    const pos = this.cased(this.posWrap, 'kr-pos-in', 'kr-gold', (l) => {
      const n = el('span', 'kr-pos-n', l, '1');
      const suf = el('span', 'kr-pos-s', l, 'st');
      return [n, suf];
    });
    this.posIn = pos.wrap;
    this.posNum = pos.parts[0];
    this.posSuf = pos.parts[1];
    // A sibling of the two cased layers, not a child of either: inside the
    // gradient layer it would be clipped to the ramp and painted transparent,
    // and hung off .kr-pos it would anchor to the gap pill's width instead of
    // the numeral's.
    this.posArrow = el('span', 'kr-pos-arrow', this.posIn, '▲');

    const gap = el('div', 'kr-gap', this.posWrap);
    const gp = el('div', 'kr-pill', gap);
    this.gapKey = el('span', 'kr-pill-k', gp, 'Grid');
    this.gapVal = el('span', 'kr-pill-v', gp, '+0.00');
  }

  /**
   * Standings, right-centre. This is the element the round-1 frame was
   * missing: the right side carried only the timer and the dial, so the
   * composition was weighted hard to the left in every shot. It is also the
   * one thing a player in a pack actually wants to know.
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
      '<defs><linearGradient id="krMotif" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fffdf6"/><stop offset="0.55" stop-color="#ffd36a"/>' +
      '<stop offset="1" stop-color="#e07c14"/>' +
      '</linearGradient></defs>' +
      '<path d="M50 4 96 50 50 96 4 50Z" fill="none" stroke="url(#krMotif)" stroke-width="7" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M50 25 75 50 50 75 25 50Z" fill="url(#krMotif)" opacity="0.42"/>' +
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
    this.speedNum = this.cased(read, 'kr-speed-n', 'kr-gold kr-gold-q').parts[0];
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
    const c = this.cased(stage, 'kr-count-n', 'kr-gold');
    this.countNum = c.wrap;
    this.countText = c.parts[0];
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
    grd.addColorStop(0.00, '#fffdf6');
    grd.addColorStop(0.34, '#ffe7ae');
    grd.addColorStop(0.70, '#f7ae3c');
    grd.addColorStop(1.00, '#e07c14');
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

  private drawDial(frac: number, charge: number, tier: number, boosting: boolean, time: number) {
    const g = this.speedG;
    const W = this.dialW;
    const H = this.dialH;
    if (W < 8) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    const cx = DIAL_CX * W;
    const cy = DIAL_CY * H;
    const r = DIAL_R * H;
    const band = r * 0.165;
    const sweep = A1 - A0;
    const chanW = band * 0.86;
    const backW = chanW + band * 0.5;

    g.lineCap = 'butt';

    // --- channel -----------------------------------------------------------
    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = backW;
    g.strokeStyle = 'rgba(6, 10, 22, 0.7)';
    g.stroke();

    // The unfilled scale: ONE flat low value at ONE opacity, all the way
    // round. Round 1 drew the whole warm ramp here at 24% alpha, which read as
    // grey from 7 to 12 o'clock and brown from 12 to 5 with no legend and no
    // semantics — the review called it a bug, correctly.
    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW;
    g.strokeStyle = 'rgba(232, 226, 208, 0.28)';
    g.stroke();

    // ...and a REAL redline: a saturated §3 kerb-red segment over the top 12%
    // of the range, so the one coloured thing on the unfilled scale means
    // something.
    const ra = A0 + sweep * REDLINE;
    g.beginPath();
    g.arc(cx, cy, r, ra, A1);
    g.lineWidth = chanW;
    g.strokeStyle = 'rgba(224, 69, 63, 0.85)';
    g.stroke();

    // --- value fill --------------------------------------------------------
    const va = A0 + sweep * clamp(this.needle.value, 0, 1);
    if (va > A0 + 0.004) {
      g.save();
      g.shadowColor = boosting ? 'rgba(255, 158, 62, 0.95)' : 'rgba(255, 190, 110, 0.42)';
      g.shadowBlur = W * (boosting ? 0.05 : 0.024);
      g.beginPath();
      g.arc(cx, cy, r, A0, va);
      g.lineWidth = chanW;
      g.strokeStyle = this.arcGrad || '#ffd66b';
      g.stroke();
      g.restore();
      g.beginPath();
      g.arc(cx, cy, r, Math.max(A0, va - 0.07), va);
      g.lineWidth = chanW;
      g.strokeStyle = 'rgba(255, 252, 236, 0.5)';
      g.stroke();
      if (boosting) {
        const p = (time * 1.5) % 1.35 - 0.175;
        const sa = A0 + sweep * clamp(p, 0, 1);
        // These two are NOT ordered by construction: if start exceeds end,
        // canvas arc() takes the long way round and paints a band across the
        // whole open wedge.
        const s0 = Math.max(A0, sa - 0.16);
        const s1 = Math.min(va, sa + 0.16);
        if (s1 > s0) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.beginPath();
          g.arc(cx, cy, r, s0, s1);
          g.lineWidth = chanW;
          g.strokeStyle = 'rgba(255, 226, 170, 0.28)';
          g.stroke();
          g.restore();
        }
      }
    }

    // chamfer hairlines at both channel lips
    g.lineWidth = Math.max(1, W * 0.0035);
    g.beginPath(); g.arc(cx, cy, r + chanW * 0.5, A0, A1);
    g.strokeStyle = 'rgba(255, 244, 220, 0.24)'; g.stroke();
    g.beginPath(); g.arc(cx, cy, r - chanW * 0.5, A0, A1);
    g.strokeStyle = 'rgba(4, 7, 16, 0.5)'; g.stroke();

    // --- scale ring, entirely outside the channel --------------------------
    // t0 clears the CASING radius, not the channel radius. Round 1 measured
    // from the channel, so the backing arc reached past the tick roots and the
    // end ticks appeared to cross the arc terminus.
    const t0 = r + backW * 0.5 + band * 0.20;
    const majorW = W * 0.0105;
    const minorW = W * 0.005;
    const casing = W * 0.0075;
    const redIdx = REDLINE * DIVS;

    const tickPath = (major: boolean, hot: boolean) => {
      g.beginPath();
      for (let i = 0; i <= DIVS; i++) {
        if ((i % MAJOR_EVERY === 0) !== major) continue;
        if ((i >= redIdx) !== hot) continue;
        const a = A0 + sweep * (i / DIVS);
        const t1 = t0 + band * (major ? 0.46 : 0.24);
        const c = Math.cos(a), s = Math.sin(a);
        g.moveTo(cx + c * t0, cy + s * t0);
        g.lineTo(cx + c * t1, cy + s * t1);
      }
    };

    g.lineCap = 'round';
    g.strokeStyle = 'rgba(4, 7, 16, 0.85)';
    tickPath(true, false);  g.lineWidth = majorW + casing; g.stroke();
    tickPath(true, true);   g.stroke();
    tickPath(false, false); g.lineWidth = minorW + casing; g.stroke();
    tickPath(false, true);  g.stroke();
    // cool ticks
    g.strokeStyle = 'rgba(255, 244, 214, 0.95)';
    tickPath(true, false);  g.lineWidth = majorW; g.stroke();
    g.strokeStyle = 'rgba(255, 238, 206, 0.5)';
    tickPath(false, false); g.lineWidth = minorW; g.stroke();
    // ticks inside the redline match the redline
    g.strokeStyle = '#e0453f';
    tickPath(true, true);  g.lineWidth = majorW; g.stroke();
    tickPath(false, true); g.lineWidth = minorW; g.stroke();
    g.lineCap = 'butt';

    // --- mini-turbo charge rail, in the open wedge under the dial ----------
    // §6 asks for an unmistakable read on the drift charge. Round 1 hid it as
    // a thin ring inside the dial where the needle and the digits were already
    // competing; a frame at tier 2 gave the player no idea what tier they were
    // on. It is now its own instrument, directly under the gauge, in the tier
    // colour, with a full-width flash on promotion.
    const ry = RAIL_Y * H;
    const rhw = RAIL_HW * W;
    const rt = RAIL_T * H;
    const driftOn = charge > 0.001 || this.tierFlash > 0.001;
    g.lineCap = 'round';
    g.lineWidth = rt;
    g.beginPath();
    g.moveTo(cx - rhw, ry);
    g.lineTo(cx + rhw, ry);
    g.strokeStyle = 'rgba(6, 10, 22, 0.72)';
    g.stroke();
    g.lineWidth = rt * 0.6;
    g.strokeStyle = 'rgba(238, 232, 214, 0.10)';
    g.stroke();
    if (driftOn) {
      const col = TIER_COLORS[clamp(tier, 0, 3)];
      const w = rhw * 2 * clamp(Math.max(charge, this.tierFlash * 0.25), 0.03, 1);
      g.save();
      g.lineWidth = rt * 0.72;
      g.shadowColor = col;
      g.shadowBlur = W * (0.02 + this.tierFlash * 0.05);
      g.beginPath();
      g.moveTo(cx - rhw, ry);
      g.lineTo(cx - rhw + w, ry);
      g.strokeStyle = col;
      g.stroke();
      if (this.tierFlash > 0) {
        g.globalCompositeOperation = 'lighter';
        g.beginPath();
        g.moveTo(cx - rhw, ry);
        g.lineTo(cx + rhw, ry);
        g.lineWidth = rt * 0.72;
        g.strokeStyle = `rgba(255,255,255,${(this.tierFlash * 0.7).toFixed(3)})`;
        g.stroke();
      }
      g.restore();
      // tier pips: three notches so the rail says WHICH tier, not just "some"
      for (let i = 1; i <= 3; i++) {
        const x = cx - rhw + (rhw * 2) * (i / 3);
        g.beginPath();
        g.moveTo(x, ry - rt * 0.42);
        g.lineTo(x, ry + rt * 0.42);
        g.lineWidth = Math.max(1, W * 0.006);
        g.strokeStyle = i <= tier ? 'rgba(255,255,255,0.9)' : 'rgba(6,10,22,0.7)';
        g.stroke();
      }
    }
    g.lineCap = 'butt';

    // --- needle ------------------------------------------------------------
    const na = A0 + sweep * clamp(this.needle.value, -0.02, 1.02);
    const tip = r - chanW * 0.5 - band * 0.10;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    g.beginPath();
    g.moveTo(tip, 0);
    g.lineTo(tip * 0.84, -r * 0.042);
    g.lineTo(r * 0.06, -r * 0.115);
    g.lineTo(-r * 0.06, -r * 0.088);
    g.lineTo(-r * 0.095, 0);
    g.lineTo(-r * 0.06, r * 0.088);
    g.lineTo(r * 0.06, r * 0.115);
    g.lineTo(tip * 0.84, r * 0.042);
    g.closePath();
    g.save();
    g.shadowColor = 'rgba(4, 7, 16, 0.65)';
    g.shadowBlur = W * 0.024;
    g.shadowOffsetY = W * 0.010;
    const ng = g.createLinearGradient(-r * 0.26, -r * 0.10, tip, r * 0.10);
    ng.addColorStop(0, '#cfc0a4');
    ng.addColorStop(0.20, '#fffdf6');
    ng.addColorStop(0.62, '#ffe7ae');
    ng.addColorStop(1, boosting ? '#f7ae3c' : '#e07c14');
    g.fillStyle = ng;
    g.fill();
    g.restore();
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, W * 0.014);
    g.strokeStyle = 'rgba(6, 10, 22, 0.94)';
    g.stroke();
    g.restore();

    // hub — a cased gold cap, the same idiom as the cased type elsewhere
    const hr = r * 0.145;
    g.beginPath();
    g.arc(cx, cy, hr, 0, Math.PI * 2);
    g.fillStyle = '#ffe7ae';
    g.fill();
    g.lineWidth = Math.max(2, W * 0.014);
    g.strokeStyle = 'rgba(6, 10, 22, 0.94)';
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, hr * 0.38, 0, Math.PI * 2);
    g.fillStyle = 'rgba(10, 15, 28, 0.9)';
    g.fill();
  }

  dispose() {
    this.root?.remove();
  }
}
