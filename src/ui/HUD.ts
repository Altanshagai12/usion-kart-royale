/**
 * HUD — lap, timer, position + rival interval, item box, speedometer, minimap,
 * countdown, drift feedback, speed vignette and toasts.
 *
 * ROUND 8. Two structural changes, both from the round-1 art review.
 *
 * 1. THE STANDINGS TOWER IS GONE. It was the largest single element on screen
 *    (~200x320) — a full eight-driver sim-racing timing tower, an idiom no
 *    kart racer has ever shipped — parked in the right third, which is the
 *    outside of every right-hand corner. In pack.png it was physically
 *    covering the two karts the player was dicing with: the UI telling you
 *    about 5th and 8th was hiding 5th and 8th. It also duplicated the left
 *    position widget in a different visual language, so the frame stated the
 *    same fact twice and neither read as authoritative.
 *
 *    The eight-row order moved to the pause screen and the results screen. In
 *    race, the position plate carries the whole story: your place, plus the
 *    ONE kart you are racing and your signed delta to it. The right-centre of
 *    the frame is now empty, which is where the racing is.
 *
 * 2. THE COUNTDOWN IS DRIVEN FROM STATE, NOT FROM AN EVENT. grid.png caught
 *    the start line at 0:00.00 with nothing at screen centre. The numeral was
 *    driven purely by the transient `countdown` bus event kicking a 1.02 s
 *    animation that ended at `opacity: 0`, so any beat that outlived its own
 *    animation — or any observer that mounted mid-count — got an empty frame.
 *    `showCountdown` is now called from `lateUpdate` off `IRace.countdown`
 *    every frame, the animation holds at full opacity, and there is a
 *    three-lamp start gantry above the numeral.
 *
 * LAYOUT — ART_DIRECTION §7:
 *
 *      [LAP]            [-- MINIMAP --]             [TIME]
 *      [POSITION                                            ]
 *       + RIVAL]                                    (empty)
 *      [ITEM]              (toast)                  [SPEEDO]
 *
 * The minimap stays top-centre (§7 permits "bottom-centre or top-centre" and
 * nothing else — top-right was suggested by the review and is out of bible).
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
// ROUND 8. Round 7 stripped this back to "an arc with seven ticks floating
// outside it and a plain white sliver for a needle", which the review read as
// generic stock iconography rather than an authored instrument — no scale
// relationship, no redline, no pivot.
//
// It is now an INSTRUMENT, without becoming an infographic again: five majors
// and one minor between each, all attached to the channel at a single fixed
// inset; two labels (0 and top speed) and no more; a redline segment over the
// top of the sweep in §3's kerb red that blooms on boost; and a needle with a
// counterweight tail, a chrome hub cap and a cast shadow so it pivots IN the
// dial instead of lying on it.
const DIAL_CX = 0.5;    // of width
const DIAL_CY = 0.43;   // of height
const DIAL_R = 0.285;   // of height
const A0 = Math.PI * 0.80;   // 144°
const A1 = Math.PI * 2.20;   // 396°
const REDLINE = 0.85;        // fraction of the sweep where the redline segment starts
const MAJOR_STEPS = 5;       // five majors across the sweep, one minor between each

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

/**
 * Below this, the interval to the kart you are racing is not a number the
 * player can act on — it is the readout flickering around zero. Round 1 shipped
 * "LEAD 0.00" in four separate frames, which made every one of them read as a
 * time trial with no opponents in it.
 */
const GAP_FLOOR = 0.015;

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
  private topRight!: HTMLDivElement;
  private timerWrap!: HTMLDivElement;
  private tM!: Pair;
  private tS!: Pair;
  private tF!: Pair;
  private bestWrap!: HTMLDivElement;
  private bestVal!: HTMLSpanElement;

  // position / rival interval
  private relRow!: HTMLDivElement;
  private relChip!: HTMLSpanElement;
  private relName!: HTMLSpanElement;
  private relVal!: HTMLSpanElement;
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

  /** livery colour per kart index, resolved once — cssColor() builds a string */
  private liveries: string[] = [];

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
  private countLights!: HTMLDivElement;
  private countShown = -99;
  /** seconds the countdown layer stays up after the count ends, for GO! */
  private countHold = 0;

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

  /**
   * The top-right column, mirroring the top-left one exactly: a rail-height
   * plate with a transient pill under it.
   *
   * Round 7's timer plate was 275x99 against a 98x90 lap plate — tops aligned,
   * bottoms 9 px apart, so the top rail had a visible step — and inside it the
   * digits sat top-left with the label pinned top-right, leaving ~40% of the
   * box as an empty bottom-right quadrant. Both plates are now exactly
   * `--rail-top` tall, the timer is a single centred column that hugs the
   * tabular digit width, and the best-lap readout that used to occupy the dead
   * quadrant is a pill under the plate — the same object as the lap split, on
   * the other side of the frame.
   */
  private buildTimer() {
    this.topRight = el('div', 'kr-tr', this.hud);
    this.timerWrap = el('div', 'kr-timer', this.topRight);
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

    // Under the plate, as a pill — the mirror of the lap-split pill.
    this.bestWrap = el('div', 'kr-pill kr-bestpill', this.topRight);
    el('span', 'kr-line-k', this.bestWrap, 'Best');
    this.bestVal = el('span', 'kr-line-v', this.bestWrap, '0:00.000');
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

    // THE RIVAL ROW — the whole replacement for the eight-driver tower. One
    // livery chip, one name, one ALWAYS-SIGNED delta. Round 1 shipped three
    // vocabularies in this one slot ("LEAD 12.48", "GAP +0.13", a labelled
    // empty cell reading "GRID"), so the player had to re-read it rather than
    // glance at it.
    this.relRow = el('div', 'kr-rel none', this.posWrap);
    this.relChip = el('span', 'kr-rel-c', this.relRow);
    this.relName = el('span', 'kr-rel-n', this.relRow, 'Grid');
    this.relVal = el('span', 'kr-rel-v', this.relRow, '—');
  }

  private buildItem() {
    this.itemWrap = el('div', 'kr-item', this.hud);
    const frame = el('div', 'kr-item-frame', this.itemWrap);
    // The pulse rim is a child rather than a pseudo-element: ::before is the
    // plate body in the round-8 two-layer plate recipe.
    el('div', 'kr-item-pulse', frame);
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
    // A three-lamp start gantry above the numeral. grid.png — the single
    // highest-energy moment in a kart racer — was completely inert; this is
    // the motif that says "a race is about to start" with no text at all, and
    // it fills in on every beat so the frame is never static.
    this.countLights = el('div', 'kr-count-lights', stage);
    for (let i = 0; i < 3; i++) el('div', 'kr-count-lamp', this.countLights);
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
      // The countdown is driven from IRace.countdown in lateUpdate, not from
      // here: an event is a single edge and the numeral has to survive the
      // whole beat, including a beat that outlives its own animation. The
      // event is still honoured so a beat lands on the exact frame it fires.
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

  /**
   * One beat. Idempotent: called every frame from `lateUpdate` with the
   * director's own `countdown` value, so the numeral is a function of state
   * rather than of a bus event that may already have been consumed. The
   * animations hold at full opacity, so however long a beat lasts there is
   * always a numeral on screen — which is precisely what round 1's start-line
   * capture did not have.
   */
  private showCountdown(n: number) {
    if (n === this.countShown) return;
    this.countShown = n;
    if (n > 3) return;
    retrigger(this.countNum, 'run');
    retrigger(this.countRing, 'run');
    retrigger(this.countTicks, 'run');
    retrigger(this.countVig, 'run');
    retrigger(this.countLights, 'run');
    // 3 -> one lamp, 2 -> two, 1 -> three, GO -> all green.
    this.countLights.classList.remove('l1', 'l2', 'l3', 'go');
    this.countLights.classList.add(n <= 0 ? 'go' : 'l' + (4 - n));
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

    const held2 = kind !== ItemKind.None && this.rouletteT < 0;
    this.itemWrap.classList.toggle('has-item', held2);
    // EMPTY IS A DIFFERENT STATE, VISIBLY. Round 1 drew the empty slot at full
    // opacity with a saturated gold diamond, identical in weight to a held
    // item — at a glance you could not tell whether you were carrying
    // anything. Empty is now the item-box cube, ghosted and desaturated; the
    // full-weight, saturated, glowing plate means "you are holding something"
    // and nothing else. Gold is reserved for the position accent.
    this.itemWrap.classList.toggle('empty', !held2 && this.rouletteT < 0);
    this.itemWrap.classList.toggle('multi', count > 1);
    if (count > 1) setText(this.itemCount, '×' + count);
    setStyle(this.itemWrap, '--item-tint', ITEM_TINT[show] || '#ffffff');

    if (show !== this.shownKind) {
      this.shownKind = show;
      const s = this.itemCanvas.width;
      this.itemG.clearRect(0, 0, s, s);
      // ItemKind.None now draws too — it is the dimensional "?" item box, from
      // the same atlas, on the same optical grid as every other icon.
      this.itemG.drawImage(this.atlas.get(show), 0, 0, s, s);
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
    // eased group on GO. The entrance is TRANSFORM ONLY: round 7 faded the
    // whole group to 0.78 including the plate fills, which is why every
    // numeral in the start-line frame dissolved into sunlit grass while the
    // standings tower stayed perfectly legible — exactly backwards.
    this.root.classList.toggle('is-counting', counting);
    if (counting !== this.wasCounting) {
      this.wasCounting = counting;
      this.gapT = 0;
    }

    // COUNTDOWN, from state. See showCountdown. The director flips to Racing on
    // the SAME frame it publishes GO, so the layer is held up for a beat after
    // the count ends — otherwise "GO!" would be cut off before it was drawn.
    if (counting) {
      this.showCountdown(race.countdown | 0);
      this.countHold = 0.95;
    } else if (this.countHold > 0) {
      this.countHold -= dt;
      if (this.countHold <= 0) this.countShown = -99;
    }
    setNum(this.countWrap, 'opacity',
      blocked || (!counting && this.countHold <= 0) ? 0 : 1, 1);

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
        this.topRight.classList.add('has-best');
      } else {
        this.topRight.classList.remove('has-best');
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

    // --- the one kart you are racing ---------------------------------------
    this.gapT -= dt;
    if (this.gapT <= 0) {
      this.gapT = 0.1;
      this.updateRival(ctx, place, counting);
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
   * The rival row — the whole in-race replacement for the standings tower.
   *
   * Two things round 1 got wrong are fixed here rather than papered over.
   *
   * THE GAP WAS ZERO. Four frames read "LEAD 0.00" and one read "GAP +0.00",
   * which made a race look like a time trial. The distance came off
   * `IKart.raceDistance`, which is the director's placement sort key and is
   * not guaranteed to be a metric quantity the instant a kart is repositioned.
   * The interval is now integrated here from the two numbers that are always
   * true — `lap` and the normalised progress `t` — against the track's own
   * centreline length, so it is a real distance no matter who moved what.
   *
   * THE FORMAT CHANGED PER STATE. "LEAD 12.48" / "GAP +0.13" / a labelled
   * empty cell reading "GRID": three vocabularies for one slot. There is one
   * now — the rival's livery chip and name, and a signed delta, ALWAYS signed,
   * green when you are ahead and red when you are behind so the sign is read
   * pre-attentively. No target, or on the grid: an em dash, which is a fact.
   */
  private updateRival(ctx: Ctx, place: number, counting: boolean) {
    const race = ctx.race;
    const player = race.player;
    const karts = race.karts;
    if (this.liveries.length !== karts.length) {
      this.liveries.length = 0;
      for (let i = 0; i < karts.length; i++) this.liveries.push(cssColor(karts[i].stats.color));
    }

    // The kart you are racing: the one ahead, or — if you are leading — the
    // one chasing you. That is the only rival whose gap you can act on.
    const want = place === 1 ? 2 : place - 1;
    let other: IKart | null = null;
    let otherIdx = -1;
    for (let i = 0; i < karts.length; i++) {
      if (karts[i] !== player && (karts[i].place | 0) === want) { other = karts[i]; otherIdx = i; break; }
    }

    if (!other) {
      this.setRelState('none');
      setText(this.relName, 'Solo');
      setText(this.relVal, '—');
      return;
    }

    setStyle(this.relChip, '--c', this.liveries[otherIdx] || '#8fa0bb');
    setText(this.relName, other.stats.name);

    if (counting || player.finished) {
      this.setRelState('none');
      setText(this.relVal, '—');
      return;
    }

    const len = ctx.track?.length || 0;
    const metres = len > 1
      ? ((other.lap + other.t) - (player.lap + player.t)) * len
      : other.raceDistance - player.raceDistance;
    // Closing speed floors at a walking pace so a stationary kart cannot
    // divide the interval into infinity.
    const closing = Math.max(8, Math.abs(player.forwardSpeed));
    const secs = clamp(metres / closing, -99, 99);

    if (Math.abs(secs) < GAP_FLOOR) {
      // Genuinely alongside. A signed 0.00 is noise; "dead level" is the fact.
      this.setRelState('none');
      setText(this.relVal, '0.00');
      return;
    }
    this.setRelState(secs < 0 ? 'ahead' : 'behind');
    setText(this.relVal, formatDelta(secs));
  }

  private relState = '';
  /** Cached class write — this runs at 10 Hz and must cost nothing when idle. */
  private setRelState(s: string) {
    if (s === this.relState) return;
    this.relState = s;
    this.relRow.className = 'kr-rel ' + s;
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
    g.strokeStyle = 'rgba(18, 10, 4, 0.64)';
    g.stroke();

    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW * 0.78;
    g.strokeStyle = 'rgba(255, 232, 202, 0.15)';
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

    // --- the redline segment -----------------------------------------------
    // §3's kerb red over the top of the sweep, sitting IN the channel so it
    // reads as part of the instrument rather than as a second overlay, and
    // blooming when the player is boosting (§6: boost must be unmistakable).
    const ra = A0 + sweep * REDLINE;
    g.save();
    if (boosting) {
      g.shadowColor = 'rgba(224, 69, 63, 0.95)';
      g.shadowBlur = W * 0.05;
    }
    g.beginPath();
    g.arc(cx, cy, r, ra, A1);
    g.lineWidth = chanW * 0.78;
    g.strokeStyle = boosting ? 'rgba(255, 108, 94, 0.85)' : 'rgba(224, 69, 63, 0.55)';
    g.stroke();
    g.restore();

    // re-lay the value fill over the redline so the needle's own arc still wins
    if (va > ra) {
      g.beginPath();
      g.arc(cx, cy, r, ra, va);
      g.lineWidth = chanW * 0.78;
      g.strokeStyle = 'rgba(255, 150, 96, 0.92)';
      g.stroke();
    }

    // --- the scale: majors and minors, ATTACHED to the channel --------------
    // Round 1's ticks floated outside the arc with an inconsistent gap and no
    // relationship to the value. Both series now start at ONE fixed inset from
    // the channel's outer edge, so they read as graduations of this dial.
    const inset = chanW * 0.42;
    const t0 = r + chanW * 0.5 + inset;
    const tMaj = t0 + r * 0.14;
    const tMin = t0 + r * 0.075;

    g.beginPath();
    for (let i = 0; i < MAJOR_STEPS; i++) {
      const a = A0 + sweep * ((i + 0.5) / MAJOR_STEPS);
      const c = Math.cos(a), s = Math.sin(a);
      g.moveTo(cx + c * t0, cy + s * t0);
      g.lineTo(cx + c * tMin, cy + s * tMin);
    }
    g.lineCap = 'round';
    g.lineWidth = Math.max(1.2, W * 0.007);
    g.strokeStyle = 'rgba(18, 10, 4, 0.78)';
    g.stroke();
    g.lineWidth = Math.max(1, W * 0.0035);
    g.strokeStyle = 'rgba(255, 244, 226, 0.42)';
    g.stroke();

    g.beginPath();
    for (let i = 0; i <= MAJOR_STEPS; i++) {
      const a = A0 + sweep * (i / MAJOR_STEPS);
      const c = Math.cos(a), s = Math.sin(a);
      g.moveTo(cx + c * t0, cy + s * t0);
      g.lineTo(cx + c * tMaj, cy + s * tMaj);
    }
    g.lineWidth = Math.max(1.8, W * 0.013);
    g.strokeStyle = 'rgba(18, 10, 4, 0.86)';
    g.stroke();
    g.lineWidth = Math.max(1.2, W * 0.0075);
    g.strokeStyle = 'rgba(255, 244, 226, 0.72)';
    g.stroke();

    // TWO labels, at the ends of the sweep, and no more: enough to tell the
    // player what the arc measures, not enough to become an infographic. Below
    // ~200 device px of dial they would be six pixels tall, which is clutter
    // rather than information, so they are simply not drawn.
    if (W >= 200) {
      const lr = tMaj + r * 0.16;
      // ROUND 10: the same condensed display stack --fd resolves to in ui.css.
      // Two dial labels in a different family from every other numeral in the
      // frame is exactly the "separately-invented widget" fault, one canvas
      // removed from the DOM where it is harder to notice.
      g.font = `700 ${Math.round(W * 0.072)}px "Avenir Next Condensed", ` +
        '"Roboto Condensed", "PT Sans Narrow", "Arial Narrow", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255, 244, 226, 0.5)';
      g.strokeStyle = 'rgba(18, 10, 4, 0.86)';
      g.lineWidth = Math.max(1.6, W * 0.012);
      g.lineJoin = 'round';
      for (let i = 0; i <= 1; i++) {
        const a = A0 + sweep * i;
        const x = cx + Math.cos(a) * lr;
        const y = cy + Math.sin(a) * lr;
        const txt = i === 0 ? '0' : String(this.speedMax);
        g.strokeText(txt, x, y);
        g.fillText(txt, x, y);
      }
    }

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
      g.strokeStyle = 'rgba(18, 10, 4, 0.58)';
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

    // --- needle: a pointer with a counterweight, pivoting IN the dial -------
    // Round 1's needle was a plain white sliver with no tail, no hub and no
    // cast shadow, so it read as something lying on top of the face. It now
    // has a counterweight past the pivot, a cast shadow on the face, and a
    // chrome hub cap over the pivot — the three things that make a pointer
    // look mounted.
    const na = A0 + sweep * clamp(this.needle.value, -0.02, 1.02);
    const tip = r - chanW * 0.62;
    const tail = r * 0.30;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    g.beginPath();
    g.moveTo(tip, 0);
    g.lineTo(0, -r * 0.078);
    g.lineTo(-tail, -r * 0.052);
    g.quadraticCurveTo(-tail - r * 0.06, 0, -tail, r * 0.052);
    g.lineTo(0, r * 0.078);
    g.closePath();
    g.save();
    g.shadowColor = 'rgba(18, 10, 4, 0.68)';
    g.shadowBlur = W * 0.022;
    g.shadowOffsetX = W * 0.005;
    g.shadowOffsetY = W * 0.010;
    g.fillStyle = boosting ? '#ffcf6b' : '#fff4e2';
    g.fill();
    g.restore();
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1.5, W * 0.009);
    g.strokeStyle = 'rgba(18, 10, 4, 0.92)';
    g.stroke();
    g.restore();

    // hub cap — chrome, §4's metalness 1.0 read as a two-stop vertical ramp
    const hr = r * 0.135;
    const hub = g.createLinearGradient(cx, cy - hr, cx, cy + hr);
    hub.addColorStop(0, '#fff7ec');
    hub.addColorStop(0.5, '#b29a80');
    hub.addColorStop(1, '#443426');
    g.beginPath();
    g.arc(cx, cy, hr, 0, Math.PI * 2);
    g.fillStyle = hub;
    g.fill();
    g.lineWidth = Math.max(1.4, W * 0.009);
    g.strokeStyle = 'rgba(18, 10, 4, 0.92)';
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, hr * 0.4, 0, Math.PI * 2);
    g.fillStyle = 'rgba(18, 10, 4, 0.78)';
    g.fill();
  }

  dispose() {
    this.root?.remove();
  }
}
