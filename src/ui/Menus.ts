/**
 * Menus — title, character select, pause and results.
 *
 * These are a *view* of `IRace.state`, never a driver of it: `state` is
 * readonly on the interface and the race director owns it. Where a menu needs
 * to act it calls the sanctioned commands (`start()` / `reset()` /
 * `setPaused()`), and where the race director does not model a state we hold
 * that screen locally instead of writing to it — `localTitle` / `localPause`
 * are the fallbacks, not the primary path.
 *
 * `?ui=title|select|pause|results` forces a screen, for capture and review.
 */
import { RaceState, type Ctx, type IKart, type KartStats } from '../types';
import { el, formatClock, ordinalSuffix, cssColor, clamp } from './uiUtil';

export type ScreenName = 'none' | 'title' | 'select' | 'pause' | 'results';

/** Stat display ranges — the roster multipliers live inside these. */
const STAT_RANGE: [number, number] = [0.74, 1.24];
const STATS: { key: keyof KartStats; label: string }[] = [
  { key: 'topSpeedMul', label: 'Speed' },
  { key: 'accelMul', label: 'Accel' },
  { key: 'handlingMul', label: 'Handling' },
  { key: 'weightMul', label: 'Weight' },
];

const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 400" class="kr-logo">
  <defs>
    <linearGradient id="krGold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fffdf2"/>
      <stop offset="32%"  stop-color="#ffe6a6"/>
      <stop offset="58%"  stop-color="#ffc23f"/>
      <stop offset="82%"  stop-color="#f28c14"/>
      <stop offset="100%" stop-color="#d1590c"/>
    </linearGradient>
    <linearGradient id="krCream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#ffffff"/>
      <stop offset="42%"  stop-color="#fdf1da"/>
      <stop offset="76%"  stop-color="#e8c79a"/>
      <stop offset="100%" stop-color="#bd9266"/>
    </linearGradient>
    <linearGradient id="krSwoosh" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#ff7a3d" stop-opacity="0"/>
      <stop offset="30%"  stop-color="#ff9a3d" stop-opacity="0.95"/>
      <stop offset="70%"  stop-color="#ffd05a" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#fff0c0" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="krBurst" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#ffd58a" stop-opacity="0.55"/>
      <stop offset="55%"  stop-color="#ff9a3d" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#ff7a3d" stop-opacity="0"/>
    </radialGradient>
    <pattern id="krCheck" width="24" height="24" patternUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="#f6efe0"/>
      <rect width="12" height="12" fill="#181425"/>
      <rect x="12" y="12" width="12" height="12" fill="#181425"/>
    </pattern>
    <!-- radial falloff so the sunburst dies away instead of hitting the
         viewBox edge and drawing a rectangle -->
    <radialGradient id="krFadeG" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#000000"/>
    </radialGradient>
    <mask id="krFade" maskUnits="userSpaceOnUse" x="0" y="0" width="900" height="400">
      <rect width="900" height="400" fill="url(#krFadeG)"/>
    </mask>
    <linearGradient id="krRibbonG" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#000000"/>
      <stop offset="14%"  stop-color="#ffffff"/>
      <stop offset="86%"  stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <mask id="krRibbon" maskUnits="userSpaceOnUse" x="60" y="240" width="790" height="130">
      <rect x="60" y="240" width="790" height="130" fill="url(#krRibbonG)"/>
    </mask>
    <filter id="krDrop" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="9" stdDeviation="10" flood-color="#060a16" flood-opacity="0.62"/>
    </filter>
    <path id="krArc" d="M 196 224 Q 450 128 704 224" fill="none"/>
  </defs>

  <g mask="url(#krFade)">
    <g class="kr-logo-rays" opacity="0.8">
      RAYS
    </g>
  </g>
  <ellipse cx="450" cy="200" rx="420" ry="200" fill="url(#krBurst)"/>

  <g filter="url(#krDrop)" transform="rotate(-2.4 450 210)">
    <!-- chequered banner, faded at both ends so it reads as a ribbon -->
    <g mask="url(#krRibbon)" opacity="0.7">
      <path d="M 104 292 L 800 266 L 795 320 L 99 346 Z" fill="url(#krCheck)"/>
      <path d="M 104 292 L 800 266 L 795 320 L 99 346 Z" fill="none" stroke="#181425" stroke-width="4.5"/>
    </g>

    <text class="kr-logo-wm" font-size="104" letter-spacing="10"
          fill="url(#krCream)" stroke="#181425" stroke-width="17"
          paint-order="stroke" stroke-linejoin="round">
      <textPath href="#krArc" startOffset="50%" text-anchor="middle">KART</textPath>
    </text>

    <text class="kr-logo-wm" x="450" y="322" font-size="152" letter-spacing="6"
          text-anchor="middle" fill="url(#krGold)" stroke="#181425" stroke-width="19"
          paint-order="stroke" stroke-linejoin="round"
          transform="skewX(-7) translate(39 0)">ROYALE</text>

    <path d="M 118 358 Q 450 386 786 344" fill="none" stroke="url(#krSwoosh)"
          stroke-width="11" stroke-linecap="round"/>
  </g>
</svg>`;

function buildRays() {
  let s = '';
  for (let i = 0; i < 24; i += 2) {
    const a0 = (i / 24) * Math.PI * 2;
    const a1 = ((i + 0.85) / 24) * Math.PI * 2;
    const R = 560;
    const x0 = 450 + Math.cos(a0) * R, y0 = 200 + Math.sin(a0) * R * 0.62;
    const x1 = 450 + Math.cos(a1) * R, y1 = 200 + Math.sin(a1) * R * 0.62;
    s += `<path d="M450 200 L${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="#ffbe62" opacity="0.11"/>`;
  }
  return s;
}

export class Menus {
  /** The screen currently shown — HUD reads this to decide how to fade out. */
  screen: ScreenName = 'none';
  /** True while a full-screen menu owns the frame (HUD hides entirely). */
  blocking = false;
  /**
   * Set by a tap on a blocking screen. Touch devices have no Enter key, and the
   * title screen's only affordance was a keyboard hint — so a tap anywhere on
   * the title, select or results screen counts as confirm.
   */
  private tapConfirm = false;

  private root: HTMLDivElement;
  private screens: Record<Exclude<ScreenName, 'none'>, HTMLDivElement>;
  private ctx!: Ctx;
  private forced: ScreenName | null = null;

  /** Local pause, used when the race director does not model RaceState.Paused. */
  private localPause = false;
  private localTitle = false;

  private selected = 0;
  private cards: HTMLDivElement[] = [];
  private buttons: { pause: HTMLDivElement[]; results: HTMLDivElement[] } = { pause: [], results: [] };
  private btnIndex = 0;

  private prevSteer = 0;
  private resultsBuilt = false;
  /** How many karts were classified when the board was last built. */
  private resultsFinished = -1;
  private finishTimes = new Map<number, number>();
  private lastRaceTime = 0;

  private rosterEl!: HTMLDivElement;
  private standingsEl!: HTMLDivElement;
  private lapsEl!: HTMLDivElement;
  private resultTitle!: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'kr-screens', parent);
    this.screens = {
      title: this.buildTitle(),
      select: this.buildSelect(),
      pause: this.buildPause(),
      results: this.buildResults(),
    };
    // one delegated listener rather than a handler per control
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.kr-btn')) this.ui('confirm');
      else if (t.closest('.kr-card')) this.ui('move');
    });

    // Tap-anywhere confirm. A real control that was tapped handles itself via
    // its own click handler, so those are excluded to avoid confirming twice.
    this.root.addEventListener('pointerdown', (e) => {
      if (!this.blocking) return;
      const t = e.target as HTMLElement;
      if (t.closest('.kr-btn, .kr-card')) return;
      this.tapConfirm = true;
    });

    const forced = new URLSearchParams(location.search).get('ui');
    if (forced === 'title' || forced === 'select' || forced === 'pause' || forced === 'results') {
      this.forced = forced;
    }
  }

  init(ctx: Ctx) {
    this.ctx = ctx;
    // finish times are not on IRace, so we stamp them off the bus ourselves
    ctx.bus.on((e) => {
      if (e.type === 'finish') this.finishTimes.set(e.kart.id, ctx.race.raceTime);
    });
    this.fillRoster(ctx);
  }

  // ------------------------------------------------------------------ frame

  update(ctx: Ctx, _dt: number) {
    const race = ctx.race;
    const input = ctx.input.state;

    // A race reset rewinds the clock; drop stale results so they rebuild.
    if (race.raceTime < this.lastRaceTime - 0.25) {
      this.resultsBuilt = false;
      this.resultsFinished = -1;
      this.finishTimes.clear();
    }
    this.lastRaceTime = race.raceTime;

    const inRace = race.state === RaceState.Racing || race.state === RaceState.Countdown;

    // Confirm is `itemPressed` — Enter / Space / E / gamepad face button — which
    // is what the on-screen hint actually promises. It used to read
    // `pausePressed`, i.e. Escape or P alone, so the title screen said "PRESS
    // ENTER TO START" and Enter did nothing at all.
    //
    // It is gated on a screen actually being up. Without that gate the same
    // keypress that fires a shell also opens the pause menu, because with no
    // screen showing `onConfirm` falls through to its pause branch.
    if (this.screen !== 'none') {
      if (input.itemPressed || this.tapConfirm) this.onConfirm(ctx, inRace);
    } else if (input.pausePressed && inRace) {
      this.localPause = true;
      this.ui('pause');
    }
    this.tapConfirm = false;

    // steer edges drive menu navigation on keyboard/gamepad
    const st = input.steer;
    if (st > 0.55 && this.prevSteer <= 0.55) this.nav(1);
    else if (st < -0.55 && this.prevSteer >= -0.55) this.nav(-1);
    this.prevSteer = st;

    let want: ScreenName;
    if (this.forced) want = this.forced;
    else if (race.state === RaceState.Menu || this.localTitle) want = this.selecting ? 'select' : 'title';
    else if (race.state === RaceState.Paused || this.localPause) want = 'pause';
    else if (race.state === RaceState.Finished || race.state === RaceState.Results) want = 'results';
    else want = 'none';

    // The board is not final the moment it appears. It goes up `RESULTS_DELAY`
    // after the *player* crosses, and on a three-lap race the field behind them
    // is still running for up to half a minute. Building it once meant a
    // winning player saw a classification frozen at their own crossing: every
    // row below them ordered by distance-on-track, printing a metre gap instead
    // of a finish time, and never corrected. Rebuild while anyone is still out
    // there — `finishedCount` only moves 7 more times, so this is a handful of
    // rebuilds, not a per-frame one.
    if (want === 'results') {
      const done = ctx.race.karts.reduce((n, k) => n + (k.finished ? 1 : 0), 0);
      if (!this.resultsBuilt || done !== this.resultsFinished) {
        this.resultsFinished = done;
        this.fillResults(ctx);
      }
    }

    if (want !== this.screen) {
      if (this.screen !== 'none') this.screens[this.screen].classList.remove('on');
      if (want !== 'none') this.screens[want].classList.add('on');
      this.screen = want;
      this.btnIndex = 0;
      this.syncButtons();
    }
    this.blocking = want === 'title' || want === 'select' || want === 'results';

    // Inline, not stylesheet: the HUD layer sets `pointer-events: none` with
    // enough specificity that an appended `.kr-screen.on` rule loses, and a
    // blocking screen that cannot receive a tap is unstartable on a phone —
    // there is no Enter key to fall back to. Inline always wins, and reverting
    // to 'none' the moment the screen clears keeps the canvas clickable.
    const pe = this.blocking ? 'auto' : 'none';
    this.root.style.pointerEvents = pe;
    if (want !== 'none') this.screens[want].style.pointerEvents = pe;
  }

  private selecting = false;

  // ------------------------------------------------------------------ input

  private nav(dir: number) {
    if (this.screen === 'select') {
      this.selected = (this.selected + dir + this.cards.length) % this.cards.length;
      this.syncCards();
    } else if (this.screen === 'pause' || this.screen === 'results') {
      const list = this.screen === 'pause' ? this.buttons.pause : this.buttons.results;
      this.btnIndex = (this.btnIndex + dir + list.length) % list.length;
      this.syncButtons();
    } else {
      return;
    }
    this.ui('move');
  }

  /**
   * Keyboard confirm routes through the same `click()` the mouse uses, so the
   * 'confirm' SFX is emitted once, by the delegated listener in the ctor.
   */
  private onConfirm(ctx: Ctx, inRace: boolean) {
    switch (this.screen) {
      case 'title':
        this.selecting = true;
        this.ui('confirm');
        return;
      case 'select':
        this.startRace(ctx);
        this.ui('confirm');
        return;
      case 'pause':
        this.buttons.pause[this.btnIndex]?.click();
        return;
      case 'results':
        this.buttons.results[this.btnIndex]?.click();
        return;
      default:
        if (inRace) { this.localPause = true; this.ui('pause'); }
    }
  }

  /** Menu SFX hook — the audio system listens for these on the bus. */
  private ui(name: string) {
    this.ctx?.bus.emit({ type: 'ui', name });
  }

  private startRace(ctx: Ctx) {
    this.forced = null;
    this.localTitle = false;
    this.selecting = false;
    this.localPause = false;
    this.resultsBuilt = false;
    this.resultsFinished = -1;
    this.finishTimes.clear();
    ctx.race.reset();
  }

  // ------------------------------------------------------------------ build

  private makeScreen(cls: string) {
    const s = el('div', 'kr-screen ' + cls, this.root);
    el('div', 'kr-screen-in', s);
    return s;
  }

  private buildTitle() {
    const s = this.makeScreen('kr-s-title');
    const inner = s.firstElementChild as HTMLDivElement;
    const wrap = el('div', 'kr-stage', inner);
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.alignItems = 'center';
    wrap.innerHTML = LOGO_SVG.replace('RAYS', buildRays());
    el('div', 'kr-sub', wrap, 'Sunset Bay Circuit');
    // The prompt and the hints follow the input device actually in use — a phone
    // has no Enter key, and telling a player to press one is how the title
    // screen becomes a dead end.
    const touch = matchMedia?.('(pointer: coarse)')?.matches || navigator.maxTouchPoints > 0;
    el('div', 'kr-prompt', wrap, touch ? 'Tap to Start' : 'Press Enter to Start');
    const hint = el('div', 'kr-hint', wrap);
    hint.innerHTML = touch
      ? '<b>Left thumb</b> steer &nbsp;&nbsp; <b>Drift</b> slide &nbsp;&nbsp; <b>Item</b> fire'
      : '<b>&#8592;</b><b>&#8594;</b> steer &nbsp;&nbsp; <b>&#8593;</b> accelerate &nbsp;&nbsp; ' +
        '<b>Shift</b> drift &nbsp;&nbsp; <b>Space</b> item &nbsp;&nbsp; <b>Esc</b> pause';
    return s;
  }

  private buildSelect() {
    const s = this.makeScreen('kr-s-select');
    const inner = s.firstElementChild as HTMLDivElement;
    const head = el('div', 'kr-stage', inner);
    el('div', 'kr-title kr-gold', head, 'Choose your racer');
    this.rosterEl = el('div', 'kr-roster kr-stage', inner);
    const go = el('div', 'kr-menu-list kr-stage', inner);
    const btn = el('div', 'kr-btn sel', go, 'Start race');
    btn.onclick = () => this.startRace(this.ctx);
    return s;
  }

  private fillRoster(ctx: Ctx) {
    const karts = ctx.race.karts;
    this.rosterEl.textContent = '';
    this.cards.length = 0;
    karts.forEach((k, i) => {
      const c = el('div', 'kr-card', this.rosterEl);
      const col = cssColor(k.stats.color);
      c.style.setProperty('--c', col);
      const chip = el('div', 'kr-card-chip', c);
      el('div', 'kr-card-init', chip, k.stats.name.charAt(0).toUpperCase());
      if (k.isPlayer) el('div', 'kr-card-you', c, 'You');
      el('div', 'kr-card-name', c, k.stats.name);
      const stats = el('div', 'kr-stats', c);
      for (const def of STATS) {
        const row = el('div', 'kr-stat', stats);
        el('span', undefined, row, def.label);
        const bar = el('div', 'kr-bar', row);
        const raw = k.stats[def.key] as number;
        const v = clamp((raw - STAT_RANGE[0]) / (STAT_RANGE[1] - STAT_RANGE[0]), 0.08, 1);
        const fill = el('i', undefined, bar);
        // staggered so the bars cascade rather than snapping in together
        fill.style.setProperty('--v', (v * 100).toFixed(1) + '%');
        fill.style.transitionDelay = (0.12 + i * 0.04 + STATS.indexOf(def) * 0.06).toFixed(2) + 's';
      }
      c.onclick = () => { this.selected = i; this.syncCards(); };
      this.cards.push(c);
    });
    this.selected = karts.findIndex((k) => k.isPlayer);
    if (this.selected < 0) this.selected = 0;
    this.syncCards();
  }

  private syncCards() {
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i].classList.toggle('sel', i === this.selected);
    }
  }

  private buildPause() {
    const s = this.makeScreen('kr-s-pause');
    const inner = s.firstElementChild as HTMLDivElement;
    const box = el('div', 'kr-stage', inner);
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    el('div', 'kr-pause-badge', box, 'Race suspended');
    el('div', 'kr-title kr-gold', box, 'Paused');
    const list = el('div', 'kr-menu-list', box);

    const resume = el('div', 'kr-btn', list, 'Resume');
    // Clearing `localPause` alone is not enough: on a real race the director
    // owns the pause and `race.state` is `Paused`, which keeps `want` pinned to
    // this screen no matter what the UI's own flag says. Resume has to tell the
    // director too, or the button does nothing — which is exactly what it did.
    resume.onclick = () => {
      this.localPause = false;
      this.forced = null;
      this.ctx?.race.setPaused(false);
    };
    const restart = el('div', 'kr-btn', list, 'Restart race');
    restart.onclick = () => { this.localPause = false; this.forced = null; this.startRace(this.ctx); };
    const quit = el('div', 'kr-btn', list, 'Quit to title');
    quit.onclick = () => {
      this.localPause = false;
      this.forced = null;
      this.localTitle = true;
      this.selecting = false;
      this.ctx.race.reset();
    };
    this.buttons.pause = [resume, restart, quit];
    return s;
  }

  private buildResults() {
    const s = this.makeScreen('kr-s-results');
    const inner = s.firstElementChild as HTMLDivElement;
    this.resultTitle = el('div', 'kr-title kr-gold kr-stage', inner, 'Race complete');
    const grid = el('div', 'kr-results-grid kr-stage', inner);
    this.standingsEl = el('div', 'kr-standings', grid);
    const right = el('div', undefined, grid) as HTMLDivElement;
    right.style.display = 'flex';
    right.style.flexDirection = 'column';
    this.lapsEl = el('div', 'kr-laps', right);

    const list = el('div', 'kr-menu-list kr-stage', inner);
    const again = el('div', 'kr-btn', list, 'Race again');
    again.onclick = () => this.startRace(this.ctx);
    const title = el('div', 'kr-btn', list, 'Back to title');
    title.onclick = () => { this.localTitle = true; this.selecting = false; this.forced = null; this.ctx.race.reset(); };
    this.buttons.results = [again, title];
    return s;
  }

  private syncButtons() {
    const list = this.screen === 'pause' ? this.buttons.pause
      : this.screen === 'results' ? this.buttons.results : null;
    for (const group of [this.buttons.pause, this.buttons.results]) {
      for (let i = 0; i < group.length; i++) {
        group[i].classList.toggle('sel', group === list && i === this.btnIndex);
      }
    }
  }

  private fillResults(ctx: Ctx) {
    // Second and subsequent builds land on a board the player is already
    // reading; only the first one gets the staggered entrance.
    this.standingsEl.classList.toggle('settled', this.resultsBuilt);
    this.resultsBuilt = true;
    const race = ctx.race;
    const player = race.player;
    const order: IKart[] = race.standings.length ? race.standings : race.karts;

    const place = player ? player.place : 1;
    this.resultTitle.textContent =
      place === 1 ? 'Winner' : `${place}${ordinalSuffix(place)} place`;

    this.standingsEl.textContent = '';
    order.forEach((k, i) => {
      const row = el('div', 'kr-row' + (k === player ? ' you' : ''), this.standingsEl);
      row.style.setProperty('--c', cssColor(k.stats.color));
      row.style.setProperty('--d', (0.14 + i * 0.055).toFixed(3) + 's');
      const p = el('div', 'kr-row-p', row);
      p.innerHTML = `${i + 1}<sup>${ordinalSuffix(i + 1)}</sup>`;
      el('div', 'kr-row-c', row);
      el('div', 'kr-row-n', row, k.stats.name);
      const t = this.finishTimes.get(k.id);
      const gap = player ? k.raceDistance - player.raceDistance : 0;
      el('div', 'kr-row-t', row,
        t !== undefined ? formatClock(t)
          : k === player ? formatClock(race.raceTime)
            : `${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(gap))} m`);
    });

    // lap times + best-lap callout
    this.lapsEl.textContent = '';
    const laps = race.lapTimes;
    let best = -1;
    for (let i = 0; i < laps.length; i++) if (best < 0 || laps[i] < laps[best]) best = i;

    const callout = el('div', 'kr-best', this.lapsEl);
    el('b', undefined, callout, 'Best lap');
    el('em', undefined, callout, best >= 0 ? formatClock(laps[best], 3) : '—:—.———');

    for (let i = 0; i < race.totalLaps; i++) {
      const line = el('div', 'kr-lapline' + (i === best ? ' best' : ''), this.lapsEl);
      el('b', undefined, line, `Lap ${i + 1}`);
      el('em', undefined, line, i < laps.length ? formatClock(laps[i], 3) : '—');
    }
    const total = el('div', 'kr-lapline kr-lapline-total', this.lapsEl);
    el('b', undefined, total, 'Total');
    el('em', undefined, total,
      formatClock(player ? (this.finishTimes.get(player.id) ?? race.raceTime) : race.raceTime, 3));
  }
}
