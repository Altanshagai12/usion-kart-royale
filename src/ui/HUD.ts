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
import { BASE_TOP_SPEED, ItemKind, type Ctx, type System } from '../types';
import { Minimap } from './Minimap';
import { Menus } from './Menus';
import { ItemIconAtlas, ITEM_NAMES, ITEM_TINT, ROULETTE_ORDER } from './ItemIcons';
import {
  Spring, TIER_COLORS, clamp, damp, el, formatClock, formatDelta,
  ordinalSuffix, retrigger, setNum, setStyle, setText,
} from './uiUtil';

// --- speedometer dial geometry ---------------------------------------------
// All fractions are of the canvas *width*; the element's 1:0.95 aspect ratio
// then guarantees the 252° sweep and its housing fit with margin to spare, and
// leaves the wedge between the arc ends (which the needle never enters) free
// for the digital readout.
const DIAL_CX = 0.5;
const DIAL_CY = 0.58;
const DIAL_R = 0.385;
const A0 = Math.PI * 0.80;   // 144°
const A1 = Math.PI * 2.20;   // 396°
const REDLINE = 0.90;        // fraction of the sweep where the warning band starts
const DIVS = 20;             // 20 steps across the sweep
const MAJOR_EVERY = 4;       // five majors, four minors between each pair
const KERB_RED = '224, 69, 63';  // ART_DIRECTION §3 kerb red #e0453f

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
  private timerVal!: HTMLDivElement;
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
  /** pre-formatted major-tick numerals, so the draw loop never builds a string */
  private tickText: string[] = [];

  // countdown
  private countWrap!: HTMLDivElement;
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

    // The minimap does not. A chase camera parks the player's kart at
    // bottom-centre, so a permanent panel there covers the one thing the frame
    // is about — it was sitting on the kart and swallowing the boost flame and
    // drift sparks outright in the boost, drift, scenery and grid captures.
    // ART_DIRECTION §7 offers bottom-centre or top-centre; top-centre is the
    // one that is empty sky in a chase cam.
    this.minimap = new Minimap(el('div', 'kr-topmid', this.hud));

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
    this.tickText.length = 0;
    for (let i = 0; i <= DIVS; i++) {
      this.tickText.push(i % MAJOR_EVERY === 0 ? String(Math.round(this.speedMax * (i / DIVS))) : '');
    }
    this.needle.snap(0);
  }

  private ctx!: Ctx;

  // ------------------------------------------------------------------- build

  private buildLap() {
    this.lapWrap = el('div', 'kr-lap', this.hud);
    this.lapIn = el('div', 'kr-lap-in', this.lapWrap);
    el('div', 'kr-label', this.lapIn, 'Lap');
    const nums = el('div', 'kr-lap-nums kr-ink', this.lapIn);
    this.lapCur = el('span', 'kr-lap-cur', nums, '1');
    el('span', 'kr-lap-sep', nums, '/');
    this.lapTot = el('span', 'kr-lap-tot', nums, '3');

    this.split = el('div', 'kr-split', this.hud);
    const pill = el('div', 'kr-split-pill', this.split);
    this.splitKey = el('span', 'kr-split-k', pill, 'Lap 1');
    this.splitVal = el('span', 'kr-split-v', pill, '0:00.000');
  }

  private buildTimer() {
    const w = el('div', 'kr-timer', this.hud);
    el('div', 'kr-label', w, 'Time');
    this.timerVal = el('div', 'kr-timer-v kr-ink', w, '0:00.00');
  }

  private buildPosition() {
    this.posWrap = el('div', 'kr-pos', this.hud);
    this.posIn = el('div', 'kr-pos-in', this.posWrap);
    // numeral and suffix are one word, so they share one fill and one outline
    this.posNum = el('span', 'kr-pos-n kr-gold', this.posIn, '1');
    this.posSuf = el('span', 'kr-pos-s kr-gold', this.posIn, 'st');
    // absolutely positioned so it cannot shift the lockup when it appears
    this.posArrow = el('span', 'kr-pos-arrow', this.posIn, '▲');
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
      '<defs><linearGradient id="krMotif" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#f8f2e6"/><stop offset="1" stop-color="#9fb0cc"/>' +
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
    this.speedCanvas = el('canvas', undefined, this.speedWrap);
    this.speedG = this.speedCanvas.getContext('2d')!;
    const read = el('div', 'kr-speed-read', this.speedWrap);
    this.speedNum = el('span', 'kr-speed-n kr-ink', read, '0');
    el('span', 'kr-speed-u', read, 'km/h');
  }

  private buildCountdown() {
    this.countWrap = el('div', 'kr-count', this.root);
    this.countRing = el('div', 'kr-count-ring', this.countWrap);
    this.countNum = el('div', 'kr-count-n kr-gold', this.countWrap, '3');
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
    if (n <= 0) {
      setText(this.countNum, 'GO!');
      this.countNum.classList.add('go');
      retrigger(this.countNum, 'run');
      retrigger(this.countRing, 'run');
      retrigger(this.flash, 'on');
    } else {
      setText(this.countNum, String(n));
      this.countNum.classList.remove('go');
      retrigger(this.countNum, 'run');
      retrigger(this.countRing, 'run');
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
    const grd = g.createLinearGradient(cx - r, cy + r * 0.2, cx + r, cy - r * 0.6);
    grd.addColorStop(0.00, '#4fc3ff');
    grd.addColorStop(0.34, '#7ee0b4');
    grd.addColorStop(0.60, '#ffd66b');
    grd.addColorStop(0.82, '#ff9d2e');
    grd.addColorStop(1.00, '#ff4d3d');
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
    // the countdown belongs to the race, not to the menus
    setNum(this.countWrap, 'opacity', blocked ? 0 : 1, 1);

    if (!player) return;

    // --- lap ---------------------------------------------------------------
    const lapNow = clamp(player.lap + 1, 1, race.totalLaps);
    setText(this.lapCur, String(lapNow));
    setText(this.lapTot, String(race.totalLaps));
    this.lapWrap.classList.toggle('final', lapNow === race.totalLaps && race.totalLaps > 1);
    if (player.lap !== this.prevLap) this.prevLap = player.lap;

    // --- timer -------------------------------------------------------------
    setText(this.timerVal, formatClock(race.raceTime));

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

    // Warning band, at the channel's own width so the groove stays uniform.
    // It starts at 90% of a sweep the player can actually complete, so it is a
    // band you reach under boost rather than permanently dead dial.
    const redA = A0 + sweep * REDLINE;
    g.beginPath();
    g.arc(cx, cy, r, redA, A1);
    g.lineWidth = chanW;
    g.strokeStyle = `rgba(${KERB_RED}, ${boosting ? 0.55 : 0.34})`;
    g.stroke();

    // --- value fill --------------------------------------------------------
    const va = A0 + sweep * clamp(this.needle.value, 0, 1);
    if (va > A0 + 0.004) {
      g.save();
      g.shadowColor = boosting ? 'rgba(255, 150, 60, 0.95)' : 'rgba(120, 190, 255, 0.5)';
      g.shadowBlur = W * (boosting ? 0.055 : 0.026);
      g.beginPath();
      g.arc(cx, cy, r, A0, va);
      g.lineWidth = chanW;
      g.strokeStyle = this.arcGrad || '#ffd66b';
      g.stroke();
      g.restore();
      g.beginPath();
      g.arc(cx, cy, r, Math.max(A0, va - 0.055), va);
      g.lineWidth = chanW;
      g.strokeStyle = 'rgba(255, 252, 236, 0.8)';
      g.stroke();
      if (boosting) {
        const p = (time * 1.5) % 1.35 - 0.175;
        const sa = A0 + sweep * clamp(p, 0, 1);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.beginPath();
        g.arc(cx, cy, r, Math.max(A0, sa - 0.16), Math.min(va, sa + 0.16));
        g.lineWidth = chanW;
        g.strokeStyle = 'rgba(255, 226, 170, 0.30)';
        g.stroke();
        g.restore();
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
    g.strokeStyle = 'rgba(255, 248, 232, 0.94)';
    tickPath(true);  g.lineWidth = majorW; g.stroke();
    g.strokeStyle = 'rgba(255, 248, 232, 0.58)';
    tickPath(false); g.lineWidth = minorW; g.stroke();
    g.lineCap = 'butt';

    // Numerals at the sweep ends would land in the readout's wedge, so the
    // scale is labelled from the second major inward only.
    g.font = `800 ${(W * 0.044).toFixed(1)}px "SF Pro Display", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lr = r - chanW * 0.5 - band * 0.62;
    g.save();
    g.shadowColor = 'rgba(4, 7, 16, 0.9)';
    g.shadowBlur = W * 0.008;
    g.fillStyle = 'rgba(248, 242, 230, 0.85)';
    for (let i = MAJOR_EVERY; i < DIVS; i += MAJOR_EVERY) {
      const a = A0 + sweep * (i / DIVS);
      g.fillText(this.tickText[i], cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
    }
    g.restore();

    // --- mini-turbo charge ring, inside the numerals -----------------------
    // The FILL is the bright element and the track is a dark groove; the old
    // arrangement had a pale full-sweep track reading as the value and the
    // actual charge as a dim nub. At zero charge the ring is not drawn at all,
    // so an idle dial has no unlabelled circle floating in it.
    const ir = r - chanW * 0.5 - band * 1.55;
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
    const na = A0 + sweep * clamp(this.needle.value, -0.02, 1.02);
    const tip = r - chanW * 0.5 - band * 0.08;
    g.save();
    g.translate(cx, cy);
    g.rotate(na);
    // The tail stops inside the hub radius (0.125r): anything longer pokes out
    // the back of the hub and reads as a glitch, not as a counterweight.
    g.beginPath();
    g.moveTo(tip, 0);
    g.lineTo(tip * 0.86, -r * 0.030);
    g.lineTo(r * 0.06, -r * 0.082);
    g.lineTo(-r * 0.055, -r * 0.062);
    g.lineTo(-r * 0.085, 0);
    g.lineTo(-r * 0.055, r * 0.062);
    g.lineTo(r * 0.06, r * 0.082);
    g.lineTo(tip * 0.86, r * 0.030);
    g.closePath();
    g.save();
    g.shadowColor = 'rgba(4, 7, 16, 0.6)';
    g.shadowBlur = W * 0.022;
    g.shadowOffsetY = W * 0.010;
    const ng = g.createLinearGradient(-r * 0.26, -r * 0.08, tip, r * 0.08);
    ng.addColorStop(0, '#8c99b6');
    ng.addColorStop(0.22, '#fffaee');
    ng.addColorStop(0.55, boosting ? '#ffcf76' : '#ff8a63');
    ng.addColorStop(1, boosting ? '#fff0c4' : '#ff3f30');
    g.fillStyle = ng;
    g.fill();
    g.restore();
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1.5, W * 0.0085);
    g.strokeStyle = 'rgba(6, 9, 20, 0.92)';
    g.stroke();
    // top bevel so the needle has a lit face rather than a flat fill
    g.beginPath();
    g.moveTo(tip * 0.84, -r * 0.014);
    g.lineTo(r * 0.06, -r * 0.052);
    g.lineTo(-r * 0.04, -r * 0.040);
    g.lineWidth = Math.max(1, W * 0.004);
    g.strokeStyle = 'rgba(255, 252, 240, 0.55)';
    g.stroke();
    g.restore();

    // hub
    const hr = r * 0.125;
    g.beginPath();
    g.arc(cx, cy, hr, 0, Math.PI * 2);
    const hg = g.createRadialGradient(cx - hr * 0.4, cy - hr * 0.45, 0, cx, cy, hr);
    hg.addColorStop(0, '#f8fbff');
    hg.addColorStop(0.38, '#a8b6d0');
    hg.addColorStop(0.74, '#3c4762');
    hg.addColorStop(1, '#121828');
    g.fillStyle = hg;
    g.fill();
    g.lineWidth = Math.max(1.2, W * 0.006);
    g.strokeStyle = 'rgba(8, 11, 24, 0.8)';
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, hr * 0.42, 0, Math.PI * 2);
    g.fillStyle = 'rgba(12, 17, 32, 0.85)';
    g.fill();
  }

  dispose() {
    this.root?.remove();
  }
}
