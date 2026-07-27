/**
 * HUD — lap, timer, position, item box, speedometer, minimap, countdown,
 * drift feedback, speed vignette and toasts.
 *
 * Layout and typography live in ui.css; this file owns state and the two
 * canvases (speedometer dial, minimap) where a canvas beats DOM. Every DOM
 * write goes through the cached setters in uiUtil so an unchanged value costs
 * nothing, and no per-frame object is allocated once the tree is built.
 */
import './ui.css';
import { BASE_TOP_SPEED, ItemKind, RaceState, type Ctx, type System } from '../types';
import { Minimap } from './Minimap';
import { Menus } from './Menus';
import { ItemIconAtlas, ITEM_NAMES, ITEM_TINT, ROULETTE_ORDER } from './ItemIcons';
import {
  Spring, TIER_COLORS, clamp, damp, el, formatClock, formatDelta,
  ordinalSuffix, retrigger, setNum, setStyle, setText,
} from './uiUtil';

// --- speedometer dial geometry ---------------------------------------------
// All fractions are of the canvas *width*; the element's 1:0.88 aspect ratio
// then guarantees the 252° sweep and its housing fit inside the plate rect with
// margin to spare, and leaves the wedge between the arc ends (which the needle
// never enters) free for the digital readout.
//
// The furthest thing this draws is the outer tick tip at 1.175 * DIAL_R, so
// DIAL_CY - 1.175 * DIAL_R must stay positive with room for the corner radius.
const DIAL_CX = 0.5;
const DIAL_CY = 0.47;
const DIAL_R = 0.365;
const A0 = Math.PI * 0.80;   // 144°
const A1 = Math.PI * 2.20;   // 396°
const REDLINE = 0.90;        // fraction of the sweep where the digit goes hot
const DIVS = 20;             // 20 steps across the sweep
const MAJOR_EVERY = 4;       // five majors, four minors between each pair

/**
 * The strongest sustained boost multiplier a kart can hold (tier-3 mini-turbo,
 * `DRIFT_BOOST_STRENGTH[3]` in Kart.ts) plus a little headroom. A dial whose
 * top third the needle can never reach carries no information, so the end of
 * the sweep is derived from what the player can actually do.
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
  private lapCur!: HTMLSpanElement;
  private lapTot!: HTMLSpanElement;
  private split!: HTMLDivElement;
  private splitKey!: HTMLSpanElement;
  private splitVal!: HTMLSpanElement;

  // timer / position
  private timerWrap!: HTMLDivElement;
  private timerVal!: HTMLDivElement;
  private bestWrap!: HTMLDivElement;
  private bestVal!: HTMLSpanElement;
  private gapKey!: HTMLSpanElement;
  private gapVal!: HTMLSpanElement;
  /** throttle on the gap recompute — 10 Hz is well past the eye's read rate */
  private gapT = 0;
  private posWrap!: HTMLDivElement;
  private posIn!: HTMLDivElement;
  private posNum!: HTMLSpanElement;
  private posSuf!: HTMLSpanElement;
  private posArrow!: HTMLSpanElement;
  /** seconds left on the gain/loss tint; 0 = no direction shown */
  private posDirT = 0;
  /** cooldown on the "took the lead" banner */
  private leadToastT = 0;

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
  private speedNum!: HTMLSpanElement;
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
  private countRing!: HTMLDivElement;
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

    // The toast slot keeps the bottom-centre column: it is small, transient,
    // and empty most of the time, so it can share that space with the kart.
    const bottom = el('div', 'kr-bottom', this.hud);
    this.toasts = el('div', 'kr-toasts', bottom);

    // The minimap does not get the centre column at either end. Bottom-centre
    // is where the chase camera parks the player's kart; top-centre is the
    // vanishing point the player is driving toward, which is why the panel kept
    // landing on the horizon, the tunnel exit, the sun and the village. It is
    // now a bottom-left plate stacked on the item box — see .kr-map.
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
    // The dial's top end is the player's own achievable top speed, not a
    // hardcoded round number: BASE_TOP_SPEED x their stat x the strongest
    // mini-turbo, in km/h, rounded up to five clean majors.
    const topMul = player?.stats?.topSpeedMul || 1;
    this.speedMax = dialMax(BASE_TOP_SPEED * topMul * BOOST_PEAK * HEADROOM * 3.6);
    this.needle.snap(0);
  }

  private ctx!: Ctx;

  // ------------------------------------------------------------------- build

  private buildLap() {
    this.lapWrap = el('div', 'kr-lap', this.hud);
    this.lapIn = el('div', 'kr-lap-in', this.lapWrap);
    el('div', 'kr-label', this.lapIn, 'Lap');
    // One gold-clipped word. The casing lives on the container (see ui.css) so
    // the whole "1/3" takes a single fill and a single outline.
    const nums = el('div', 'kr-lap-nums kr-gold kr-gold-q', this.lapIn);
    this.lapCur = el('span', 'kr-lap-cur', nums, '1');
    el('span', 'kr-lap-sep', nums, '/');
    this.lapTot = el('span', 'kr-lap-tot', nums, '3');

    this.split = el('div', 'kr-split', this.hud);
    const pill = el('div', 'kr-split-pill', this.split);
    this.splitKey = el('span', 'kr-split-k', pill, 'Lap 1');
    this.splitVal = el('span', 'kr-split-v', pill, '0:00.000');
  }

  private buildTimer() {
    this.timerWrap = el('div', 'kr-timer', this.hud);
    el('div', 'kr-label', this.timerWrap, 'Time');
    this.timerVal = el('div', 'kr-timer-v kr-gold kr-gold-q', this.timerWrap, '0:00.00');
    // Persistent best lap. Total elapsed is the least useful number in a
    // three-lap race; this is the one the player is racing against.
    this.bestWrap = el('div', 'kr-best-line', this.timerWrap);
    const bp = el('div', 'kr-split-pill', this.bestWrap);
    el('span', 'kr-split-k', bp, 'Best');
    this.bestVal = el('span', 'kr-split-v', bp, '0:00.000');
  }

  private buildPosition() {
    this.posWrap = el('div', 'kr-pos', this.hud);
    this.posIn = el('div', 'kr-pos-in', this.posWrap);
    // numeral and suffix are one word, so they share one fill and one outline
    this.posNum = el('span', 'kr-pos-n kr-gold', this.posIn, '1');
    this.posSuf = el('span', 'kr-pos-s kr-gold', this.posIn, 'st');
    // absolutely positioned so it cannot shift the lockup when it appears
    this.posArrow = el('span', 'kr-pos-arrow', this.posIn, '▲');

    // Interval to the kart being raced — ahead of the player, or behind when
    // the player leads. Hangs off the position lockup, on the split pill's
    // plate, so the two read as one readout rather than a new invention.
    const gap = el('div', 'kr-gap', this.posWrap);
    const gp = el('div', 'kr-split-pill', gap);
    this.gapKey = el('span', 'kr-split-k', gp, 'Gap');
    this.gapVal = el('span', 'kr-split-v', gp, '+0.00');
  }

  private buildItem() {
    this.itemWrap = el('div', 'kr-item', this.hud);
    el('div', 'kr-item-frame', this.itemWrap);
    // Embossed empty-slot motif — the item-box diamond struck into the well
    // floor. Replaces the dashed "?" placeholder: this reads as an empty slot,
    // not as a component nobody has designed yet.
    const motif = el('div', 'kr-item-motif', this.itemWrap);
    motif.innerHTML =
      '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      // warm, not the cool #9fb0cc it was: bottom-left was the only corner of
      // the HUD with no colour in it at all
      '<defs><linearGradient id="krMotif" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fffdf6"/><stop offset="1" stop-color="#e0a63c"/>' +
      '</linearGradient></defs>' +
      '<path d="M50 6 94 50 50 94 6 50Z" fill="none" stroke="url(#krMotif)" stroke-width="6" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M50 26 74 50 50 74 26 50Z" fill="url(#krMotif)" opacity="0.5"/>' +
      '</svg>';
    this.itemIcon = el('div', 'kr-item-icon', this.itemWrap);
    this.itemCanvas = el('canvas', undefined, this.itemIcon);
    this.itemG = this.itemCanvas.getContext('2d')!;
    this.itemCount = el('div', 'kr-item-count', this.itemWrap, '×2');
  }

  private buildSpeedo() {
    this.speedWrap = el('div', 'kr-speed', this.hud);
    // The canvas lives in a clipped face box, not directly on the plate: the
    // two rects used to differ and dial geometry escaped the rounded card.
    const face = el('div', 'kr-speed-face', this.speedWrap);
    this.speedCanvas = el('canvas', undefined, face);
    this.speedG = this.speedCanvas.getContext('2d')!;
    const read = el('div', 'kr-speed-read', this.speedWrap);
    this.speedNum = el('span', 'kr-speed-n kr-gold kr-gold-q', read, '0');
  }

  private buildCountdown() {
    this.countWrap = el('div', 'kr-count', this.root);
    this.countVig = el('div', 'kr-count-vig', this.countWrap);
    const stage = el('div', 'kr-count-stage', this.countWrap);
    this.countRing = el('div', 'kr-count-ring', stage);
    this.countNum = el('div', 'kr-count-n kr-gold', stage, '3');
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
    // once there is a benchmark, the delta is the more interesting number
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
    retrigger(this.countVig, 'run');
    if (n <= 0) {
      setText(this.countNum, 'GO!');
      this.countNum.classList.add('go');
      // white full-screen flash, GO only
      this.flash.classList.remove('tick');
      retrigger(this.flash, 'on');
    } else {
      setText(this.countNum, String(n));
      this.countNum.classList.remove('go');
      // short warm flash on every tick, so the grid is not a static wallpaper
      this.flash.classList.remove('on');
      retrigger(this.flash, 'tick');
    }
  }

  /**
   * One slot, one message. Reserved for genuinely transient events — an item
   * hit, taking the lead, finishing. Anything the HUD already shows permanently
   * must never be echoed here: two readouts of the same datum can disagree, and
   * a stack of them reads as a rendering fault.
   *
   * An incoming toast crossfades the outgoing one out *in place* (same grid
   * cell), and any node still leaving from an earlier event is dropped on the
   * spot, so at most two nodes exist and they never stack.
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
        // interval opens up cubically — a fast blur that decelerates into place
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
      // ItemKind.None draws nothing: the empty state is the recessed well and
      // the embossed motif behind this canvas, not a placeholder glyph on it.
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
    const W = this.dialW;
    const cx = DIAL_CX * W;
    const cy = DIAL_CY * W;
    const r = DIAL_R * W;
    // One warm ramp off --gold-ramp, ending on ART_DIRECTION §3 kerb red.
    // The old cyan -> green -> amber -> red diagnostic ramp was Grafana visual
    // language in a Mediterranean golden-hour racer, and it shared no colour
    // with the cased gold numerals 400 px to its left. #4fc3ff survives in this
    // instrument in exactly one place, where the palette assigns it: the
    // mini-turbo tier-1 charge ring.
    const grd = g.createLinearGradient(cx - r, cy + r * 0.35, cx + r, cy - r * 0.55);
    grd.addColorStop(0.00, '#fffdf6');
    grd.addColorStop(0.30, '#ffe7ae');
    grd.addColorStop(0.64, '#f7ae3c');
    grd.addColorStop(0.87, '#e07c14');
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
    // The countdown owns the grid: one large numeral on screen, not two.
    this.root.classList.toggle('is-counting', race.state === RaceState.Countdown);
    // the countdown belongs to the race, not to the menus
    setNum(this.countWrap, 'opacity', blocked ? 0 : 1, 1);

    if (!player) return;

    // --- lap ---------------------------------------------------------------
    const lapNow = clamp(player.lap + 1, 1, race.totalLaps);
    setText(this.lapCur, String(lapNow));
    setText(this.lapTot, String(race.totalLaps));
    this.lapWrap.classList.toggle('final', lapNow === race.totalLaps && race.totalLaps > 1);
    if (player.lap !== this.prevLap) this.prevLap = player.lap;

    // --- timer + best lap --------------------------------------------------
    setText(this.timerVal, formatClock(race.raceTime));
    // Derived from the race's own lap list rather than from the 'lap' event
    // alone, so the benchmark is right even if the HUD is built mid-race or the
    // event is missed. Only recomputed when a lap actually lands.
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
    // One position readout, in one typographic convention. The direction of
    // the change rides on this element (retinted ramp + chevron) instead of
    // spawning a second, contradictory copy of the same number elsewhere.
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
      this.posDirT = 0.70; // covers the full chevron animation
      // The toast channel is spent on the one moment that deserves it. Rate
      // limited so a flip-flopping battle for first does not machine-gun it.
      if (place === 1 && this.leadToastT <= 0) {
        this.leadToastT = 6;
        this.toast('Took the lead', '★', '#ffd36b');
      }
    } else if (this.posDirT > 0) {
      this.posDirT -= dt;
      if (this.posDirT <= 0) this.posWrap.classList.remove('gain', 'loss');
    }
    setText(this.posNum, String(place));
    setText(this.posSuf, ordinalSuffix(place));
    this.posWrap.classList.toggle('lead', place === 1);

    // --- interval to the kart being raced ----------------------------------
    // Distance along the race converted to a time by the closing speed the
    // player can actually make up, which is what "one and a half seconds back"
    // means to a driver. Recomputed at 10 Hz: any faster and the last digit is
    // noise, and the string churn is not free.
    this.gapT -= dt;
    if (this.gapT <= 0) {
      this.gapT = 0.1;
      // when leading, the interesting number is the cushion over 2nd instead.
      // Found by place rather than by index so this does not depend on how the
      // race director happens to order `standings`.
      const want = place === 1 ? 2 : place - 1;
      const karts = race.karts;
      let other: typeof player | null = null;
      for (let i = 0; i < karts.length; i++) {
        if (karts[i] !== player && karts[i].place === want) { other = karts[i]; break; }
      }
      const has = !!other && !player.finished;
      this.posWrap.classList.toggle('has-gap', has);
      if (other && has) {
        const metres = Math.abs(other.raceDistance - player.raceDistance);
        const closing = Math.max(6, Math.abs(player.forwardSpeed));
        const secs = Math.min(99, metres / closing);
        setText(this.gapKey, place === 1 ? 'Lead' : 'Gap');
        setText(this.gapVal, (place === 1 ? '' : '+') + secs.toFixed(2));
      }
    }

    // --- item --------------------------------------------------------------
    this.updateItem(ctx, dt);

    // --- speedometer -------------------------------------------------------
    const kmh = Math.abs(player.forwardSpeed) * 3.6;
    const frac = clamp(kmh / this.speedMax, 0, 1);
    this.needle.target = frac;
    this.needle.step(dt);
    const boosting = player.boostTime > 0;
    setText(this.speedNum, String(Math.round(kmh)));
    this.speedWrap.classList.toggle('red', frac > REDLINE);
    this.speedWrap.classList.toggle('boosting', boosting);

    // drift charge, and a decaying flash when a tier locks in
    const tier = player.driftTier | 0;
    const charge = player.driftDir !== 0 ? clamp(player.driftCharge, 0, 1) : 0;
    this.tierFlash = Math.max(0, this.tierFlash - dt * 2.6);
    if (tier > this.lastTier) {
      this.tierFlash = 1;
      retrigger(this.speedWrap, 'tier'); // spring pop on the whole instrument
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

  // --------------------------------------------------------------- dial draw

  private drawDial(frac: number, charge: number, tier: number, boosting: boolean, time: number) {
    const g = this.speedG;
    const W = this.dialW;
    const H = this.dialH;
    if (W < 8) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    const cx = DIAL_CX * W;
    const cy = DIAL_CY * W;
    const r = DIAL_R * W;
    const band = r * 0.155;
    const sweep = A1 - A0;

    g.lineCap = 'butt';

    // Three concentric zones, and nothing crosses between them: the scale ring
    // sits outside the channel, the channel holds the value fill, and the
    // numerals + drift ring live inside it. That separation is the whole
    // reason the gauge reads as an instrument rather than as stacked strokes.
    const chanW = band * 0.86;

    // --- channel -----------------------------------------------------------
    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW + band * 0.5;
    g.strokeStyle = 'rgba(5, 8, 18, 0.72)';
    g.stroke();

    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW;
    const housing = g.createLinearGradient(cx, cy - r, cx, cy + r);
    housing.addColorStop(0, 'rgba(30, 39, 66, 0.94)');
    housing.addColorStop(0.6, 'rgba(13, 18, 34, 0.96)');
    housing.addColorStop(1, 'rgba(7, 10, 21, 0.97)');
    g.strokeStyle = housing;
    g.stroke();

    // The unfilled scale, always present at low alpha. Without it a stationary
    // dial is a bare grey groove and a boosting one is a full warm wash — the
    // same widget reading as two different components between states. The ramp
    // is visible at rest; the value fill adds intensity on top of it, and that
    // is the only thing that changes.
    g.save();
    g.globalAlpha = 0.24;
    g.beginPath();
    g.arc(cx, cy, r, A0, A1);
    g.lineWidth = chanW;
    g.strokeStyle = this.arcGrad || '#ffd66b';
    g.stroke();
    g.restore();

    // --- value fill --------------------------------------------------------
    const va = A0 + sweep * clamp(this.needle.value, 0, 1);
    if (va > A0 + 0.004) {
      g.save();
      // one hue, two intensities — boost is a bloom, not a retint
      g.shadowColor = boosting ? 'rgba(255, 158, 62, 0.95)' : 'rgba(255, 190, 110, 0.45)';
      g.shadowBlur = W * (boosting ? 0.055 : 0.026);
      g.beginPath();
      g.arc(cx, cy, r, A0, va);
      g.lineWidth = chanW;
      g.strokeStyle = this.arcGrad || '#ffd66b';
      g.stroke();
      g.restore();
      g.beginPath();
      g.arc(cx, cy, r, Math.max(A0, va - 0.075), va);
      g.lineWidth = chanW;
      g.strokeStyle = 'rgba(255, 252, 236, 0.55)';
      g.stroke();
      if (boosting) {
        const p = (time * 1.5) % 1.35 - 0.175;
        const sa = A0 + sweep * clamp(p, 0, 1);
        // These two are NOT ordered by construction: once the sweep head runs
        // past the value fill, `start` exceeds `end` and canvas arc() takes the
        // long way round — it painted a translucent warm band across the whole
        // bottom of the dial, through the empty wedge and out past the plate
        // corners. That was the "unmasked render layer" in the boost frames.
        const s0 = Math.max(A0, sa - 0.16);
        const s1 = Math.min(va, sa + 0.16);
        if (s1 > s0) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.beginPath();
          g.arc(cx, cy, r, s0, s1);
          g.lineWidth = chanW;
          g.strokeStyle = 'rgba(255, 226, 170, 0.30)';
          g.stroke();
          g.restore();
        }
      }
    }

    // chamfer hairlines at both channel lips
    g.lineWidth = Math.max(1, W * 0.0035);
    g.beginPath(); g.arc(cx, cy, r + chanW * 0.5, A0, A1);
    g.strokeStyle = 'rgba(255, 244, 220, 0.28)'; g.stroke();
    g.beginPath(); g.arc(cx, cy, r - chanW * 0.5, A0, A1);
    g.strokeStyle = 'rgba(4, 7, 16, 0.55)'; g.stroke();

    // --- scale ring, entirely outside the channel --------------------------
    // Batched: one casing path and one fill path per weight, so the whole scale
    // costs four strokes rather than two per tick.
    const t0 = r + chanW * 0.5 + band * 0.22;
    const majorW = W * 0.0105;
    const minorW = W * 0.005;
    const casing = W * 0.0075;

    const tickPath = (major: boolean) => {
      g.beginPath();
      for (let i = 0; i <= DIVS; i++) {
        if ((i % MAJOR_EVERY === 0) !== major) continue;
        const a = A0 + sweep * (i / DIVS);
        const t1 = t0 + band * (major ? 0.48 : 0.25);
        const c = Math.cos(a), s = Math.sin(a);
        g.moveTo(cx + c * t0, cy + s * t0);
        g.lineTo(cx + c * t1, cy + s * t1);
      }
    };

    g.lineCap = 'round';
    g.strokeStyle = 'rgba(4, 7, 16, 0.85)';
    tickPath(true);  g.lineWidth = majorW + casing; g.stroke();
    tickPath(false); g.lineWidth = minorW + casing; g.stroke();
    g.strokeStyle = 'rgba(255, 244, 214, 0.95)';
    tickPath(true);  g.lineWidth = majorW; g.stroke();
    g.strokeStyle = 'rgba(255, 238, 206, 0.5)';
    tickPath(false); g.lineWidth = minorW; g.stroke();
    g.lineCap = 'butt';

    // No numerals on the scale. They sat on the needle's own ring — the needle
    // swept straight through them and erased a digit at exactly the speeds the
    // player drives at ("120" reading ".20", "90" reading "00"). A scale you
    // cannot read is worse than no scale, and at this size they would have been
    // 9 px anyway. The digital readout carries the value; the arc carries the
    // proportion. That is what §7 asks for.

    // --- mini-turbo charge ring --------------------------------------------
    // The FILL is the bright element and the track is a dark groove; the old
    // arrangement had a pale full-sweep track reading as the value and the
    // actual charge as a dim nub. At zero charge the ring is not drawn at all,
    // so an idle dial has no unlabelled circle floating in it.
    // moved outward from band*1.55 now that the numeral ring is gone
    const ir = r - chanW * 0.5 - band * 1.0;
    const driftOn = charge > 0.001 || this.tierFlash > 0;
    if (driftOn) {
      const trackW = band * 0.24;
      g.beginPath();
      g.arc(cx, cy, ir, A0, A1);
      g.lineWidth = trackW;
      g.strokeStyle = 'rgba(6, 10, 22, 0.55)';
      g.stroke();

      const col = TIER_COLORS[clamp(tier, 0, 3)];
      const ca = A0 + sweep * Math.max(0.02, clamp(charge, 0, 1));
      g.save();
      g.lineCap = 'round';
      g.shadowColor = col;
      g.shadowBlur = W * (0.024 + this.tierFlash * 0.05);
      g.beginPath();
      g.arc(cx, cy, ir, A0, ca);
      g.lineWidth = trackW * 2.2;
      g.strokeStyle = col;
      g.stroke();
      // additive bloom on the leading edge — the charge front, not the track
      g.globalCompositeOperation = 'lighter';
      g.beginPath();
      g.arc(cx, cy, ir, Math.max(A0, ca - 0.10), ca);
      g.lineWidth = trackW * 2.2;
      g.strokeStyle = 'rgba(255, 253, 244, 0.55)';
      g.stroke();
      g.restore();
      if (this.tierFlash > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.beginPath();
        g.arc(cx, cy, ir, A0, A1);
        g.lineWidth = trackW * 2.2;
        g.strokeStyle = `rgba(255,255,255,${(this.tierFlash * 0.6).toFixed(3)})`;
        g.stroke();
        g.restore();
      }
    }

    // --- needle ------------------------------------------------------------
    // A blade, not a hairline: same warm ramp and same heavy ink casing as the
    // cased type elsewhere in the HUD, so the instrument shares a line weight
    // and a fill idiom with the numerals instead of importing a second one.
    const na = A0 + sweep * clamp(this.needle.value, -0.02, 1.02);
    const tip = r - chanW * 0.5 - band * 0.10;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    // The tail stops inside the hub radius: anything longer pokes out the back
    // of the hub and reads as a glitch, not as a counterweight.
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

    // hub — a cased gold cap, not a machined chrome boss. The old radial read
    // as a photoreal metal part next to flat 2D iconography.
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
