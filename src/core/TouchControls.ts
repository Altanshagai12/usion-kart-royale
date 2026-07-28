/**
 * ============================================================================
 *  On-screen controls for touch devices.
 * ============================================================================
 *  A floating analogue stick under the left thumb and an action cluster under
 *  the right. `Input` merges `state` into the same InputState every other
 *  system already reads, so nothing downstream knows or cares that the player
 *  is on a phone.
 *
 *  Six decisions worth recording:
 *
 *  1. **The stick floats.** Its origin is wherever the thumb first lands in the
 *     left half, not a fixed rosette. A fixed stick requires the player to look
 *     down to find it; a floating one is always exactly under the thumb. If the
 *     drag exceeds the lock radius the base follows, so a long pull never
 *     saturates and then feels dead on the way back.
 *
 *  2. **Auto-accelerate is on by default**, which is the convention every
 *     shipped mobile kart racer settles on: one thumb steers, the other drifts,
 *     and nobody has a spare thumb for a throttle. It is a toggle rather than a
 *     law — the AUTO chip turns it off and reveals a GAS pedal.
 *
 *  3. **Every control tracks its own pointerId.** Steering while holding drift
 *     and tapping an item is three simultaneous touches, and a naive
 *     single-pointer implementation drops two of them. This is the single most
 *     common way on-screen controls are got wrong.
 *
 *  4. **Presses are latched, not polled** (round 11). `update()` used to report
 *     `pointer >= 0`, i.e. "is a finger on this button *right now*". A tap
 *     shorter than a frame — press and release both landing between two rAFs,
 *     which at 30 fps on a phone is a 33 ms window and a perfectly ordinary
 *     stab at the item button — set and cleared the pointer without a single
 *     frame ever observing it, and the press was silently gone. The keyboard
 *     had this fixed long ago; touch never did, and touch is the platform the
 *     player is actually complaining about. Every press now sets a `tapped`
 *     flag that survives until the next `update()` reads it.
 *
 *  5. **Buttons can be slid onto.** A thumb that lands 20 px shy of DRIFT at
 *     corner entry and then slides on used to do nothing at all, because the
 *     button was only claimed on `pointerdown`. An unclaimed pointer now keeps
 *     looking, so a near-miss corrects itself instead of costing the corner.
 *
 *  6. **Hit rectangles are cached.** `getBoundingClientRect()` inside a pointer
 *     handler forces synchronous layout; five of them on every touchdown, on
 *     the exact event whose latency the player feels, is the wrong place to
 *     spend milliseconds. They only change on resize / AUTO toggle, so that is
 *     when they are recomputed.
 * ============================================================================
 */

export interface TouchState {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  item: boolean;
  look: boolean;
  pause: boolean;
  /** true while a thumb is actually on the steering stick */
  steering: boolean;
  /** true while the player is actually touching something */
  active: boolean;
}

/**
 * Fraction of the lock radius ignored around centre.
 *
 * A *floating* stick has no drift and no calibration error to reject: the
 * origin is defined as the pixel the thumb landed on, so zero really is zero.
 * The only thing a dead zone has to absorb here is the two or three pixels a
 * thumb rolls through while it settles. 0.1 of a 52 px radius was 5.2 px of
 * nothing — a deliberate small correction on a straight did not move the kart
 * at all, which reads as the controls ignoring you. 0.055 of a 62 px radius is
 * 3.4 px: still immune to the settle, but a nudge steers.
 */
const DEADZONE = 0.055;
/**
 * Exponent applied past the dead zone. >1 buys fine control near centre at the
 * cost of the mid-range. 1.35 was a hard sell — half a thumb-sweep produced a
 * third of the lock, so ordinary corners needed most of the travel and there
 * was nothing left for a correction. 1.22 keeps the fine centre and gives the
 * mid-range back.
 */
const CURVE = 1.22;

type Btn = {
  id: 'drift' | 'item' | 'brake' | 'look' | 'gas';
  el: HTMLElement;
  pointer: number;
  /** set on press, cleared by `update()` — see note 4 in the header */
  tapped: boolean;
  /** cached circular hit test, refreshed by `measure()` */
  cx: number;
  cy: number;
  r2: number;
};

export class TouchControls {
  readonly state: TouchState = {
    steer: 0, accel: 0, brake: 0, drift: false, item: false,
    look: false, pause: false, steering: false, active: false,
  };

  /** auto-accelerate — the AUTO chip toggles it */
  private auto = true;
  private root: HTMLElement | null = null;
  private stickWrap!: HTMLElement;
  private stickBase!: HTMLElement;
  private stickKnob!: HTMLElement;
  private gasBtn!: HTMLElement;
  private autoChip!: HTMLElement;
  private buttons: Btn[] = [];
  /** direct handles, so the per-frame `update()` allocates nothing */
  private bDrift!: Btn;
  private bItem!: Btn;
  private bBrake!: Btn;
  private bLook!: Btn;
  private bGas!: Btn;

  /** -1 when no thumb is steering */
  private stickPointer = -1;
  private originX = 0;
  private originY = 0;
  /** thumb travel, in px, that maps to full lock */
  private radius = 62;
  private mounted = false;
  /** hit rects are stale until the next test */
  private dirty = true;
  /** pointers that went down without claiming anything — may still slide on */
  private free = new Set<number>();

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Lets the HUD (and the rules at the foot of this file) reflow for thumbs.
    document.documentElement.setAttribute('data-touch', '');

    const root = document.createElement('div');
    root.className = 'tc-root';
    root.innerHTML = MARKUP;
    document.body.appendChild(root);
    this.root = root;

    this.stickWrap = root.querySelector('.tc-stick-zone')!;
    this.stickBase = root.querySelector('.tc-stick-base')!;
    this.stickKnob = root.querySelector('.tc-stick-knob')!;
    this.autoChip = root.querySelector('.tc-auto')!;
    this.gasBtn = root.querySelector('[data-btn="gas"]')!;

    for (const id of ['drift', 'item', 'brake', 'look', 'gas'] as const) {
      const el = root.querySelector<HTMLElement>(`[data-btn="${id}"]`)!;
      this.buttons.push({ id, el, pointer: -1, tapped: false, cx: 0, cy: 0, r2: 0 });
    }
    const byId = (id: Btn['id']) => this.buttons.find((b) => b.id === id)!;
    this.bDrift = byId('drift');
    this.bItem = byId('item');
    this.bBrake = byId('brake');
    this.bLook = byId('look');
    this.bGas = byId('gas');

    this.autoChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setAuto(!this.auto);
    });
    root.querySelector('[data-btn="pause"]')!.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.state.pause = true; // consumed as an edge by Input on the next frame
    });

    this.setAuto(this.auto);
    this.sizeStick();

    // Listeners go on the window so a thumb that slides off a button still
    // releases it — a button that latches because the release landed on the
    // canvas is the second most common on-screen-control bug.
    addEventListener('pointerdown', this.onDown, { passive: false });
    addEventListener('pointermove', this.onMove, { passive: false });
    addEventListener('pointerup', this.onUp, { passive: false });
    addEventListener('pointercancel', this.onUp, { passive: false });
    addEventListener('contextmenu', this.onContext);
    addEventListener('resize', this.sizeStick);
    addEventListener('orientationchange', this.sizeStick);
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    removeEventListener('contextmenu', this.onContext);
    removeEventListener('resize', this.sizeStick);
    removeEventListener('orientationchange', this.sizeStick);
    document.documentElement.removeAttribute('data-touch');
    this.root?.remove();
    this.root = null;
    this.free.clear();
    this.stickPointer = -1;
    this.state.steer = 0;
    this.state.steering = false;
  }

  private setAuto(on: boolean) {
    this.auto = on;
    this.autoChip.classList.toggle('on', on);
    this.autoChip.textContent = on ? 'AUTO' : 'MANUAL';
    // With auto off the player needs a throttle; with it on that space is dead
    // weight under the thumb, so the pedal is removed rather than just dimmed.
    this.gasBtn.style.display = on ? 'none' : '';
    if (on && this.bGas) {
      this.bGas.pointer = -1;
      this.bGas.tapped = false;
      this.bGas.el.classList.remove('down');
    }
    this.dirty = true;
  }

  private sizeStick = () => {
    /**
     * Thumb reach, not screen size: a tablet does not want a 200 px stick.
     *
     * This is the travel that reaches FULL LOCK, and it is also where the base
     * starts trailing the thumb — the two must be the same number or there is a
     * band at the edge where pushing further does nothing and pulling back does
     * nothing either, which is exactly the "saturates and then feels dead"
     * failure the floating base exists to avoid.
     *
     * 0.13 of the short edge gave 52 px on a landscape phone: 1 px of thumb was
     * 2% of lock, so nothing between "straight" and "committed" was reachable.
     * 0.16 gives 62 px there — 20% more resolution for a sweep a thumb still
     * covers without lifting — and is capped at 88 rather than 96 so a tablet
     * does not demand a whole hand's travel for full lock.
     */
    this.radius = Math.max(56, Math.min(88, Math.min(innerWidth, innerHeight) * 0.16));
    const d = this.radius * 2;
    this.stickBase.style.width = this.stickBase.style.height = `${d}px`;
    this.stickKnob.style.width = this.stickKnob.style.height = `${d * 0.42}px`;
    this.dirty = true;
  };

  private onContext = (e: Event) => e.preventDefault();

  /** Refresh the cached hit circles. Layout is read here and nowhere else. */
  private measure() {
    this.dirty = false;
    for (const b of this.buttons) {
      const r = b.el.getBoundingClientRect();
      b.cx = r.left + r.width / 2;
      b.cy = r.top + r.height / 2;
      // Generously padded: thumbs are imprecise and a miss on the drift button
      // at corner entry is felt immediately.
      const rad = r.width / 2 + 16;
      b.r2 = r.width === 0 ? 0 : rad * rad;
    }
  }

  private hitButton(x: number, y: number): Btn | null {
    if (this.dirty) this.measure();
    for (const b of this.buttons) {
      if (b.id === 'gas' && this.auto) continue;
      if (b.r2 === 0 || b.pointer >= 0) continue;
      if ((x - b.cx) ** 2 + (y - b.cy) ** 2 <= b.r2) return b;
    }
    return null;
  }

  private claim(b: Btn, id: number) {
    b.pointer = id;
    b.tapped = true; // survives until `update()` reads it — see note 4
    b.el.classList.add('down');
  }

  private onDown = (e: PointerEvent) => {
    if (!this.mounted) return;
    const t = e.target as HTMLElement;
    if (t?.closest?.('.tc-chip, .tc-pause')) return; // handled by their own listeners

    const btn = this.hitButton(e.clientX, e.clientY);
    if (btn) {
      e.preventDefault();
      this.claim(btn, e.pointerId);
      return;
    }

    // Left half and no thumb already steering: spawn the stick here.
    if (this.stickPointer < 0 && e.clientX < innerWidth * 0.5) {
      e.preventDefault();
      this.stickPointer = e.pointerId;
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.state.steering = true;
      this.state.steer = 0;
      this.stickWrap.classList.add('live');
      this.placeStick(0, 0);
      return;
    }

    // Landed on nothing. Keep watching it — see note 5.
    this.free.add(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) {
      // A thumb that missed the button it was aiming at can still slide on.
      if (this.free.has(e.pointerId)) {
        const b = this.hitButton(e.clientX, e.clientY);
        if (b) {
          e.preventDefault();
          this.free.delete(e.pointerId);
          this.claim(b, e.pointerId);
        }
      }
      return;
    }
    e.preventDefault();
    let dx = e.clientX - this.originX;
    const dy = e.clientY - this.originY;
    const r = this.radius;

    // Let the base trail the thumb once it leaves the ring, so the stick never
    // saturates and a pull back toward centre responds immediately.
    if (dx > r) { this.originX = e.clientX - r; dx = r; }
    else if (dx < -r) { this.originX = e.clientX + r; dx = -r; }

    this.placeStick(dx, Math.max(-r, Math.min(r, dy)));

    const raw = dx / r;
    const mag = Math.abs(raw);
    this.state.steer = mag <= DEADZONE
      ? 0
      : Math.sign(raw) * Math.min(1, Math.pow((mag - DEADZONE) / (1 - DEADZONE), CURVE));
  };

  private onUp = (e: PointerEvent) => {
    this.free.delete(e.pointerId);
    if (e.pointerId === this.stickPointer) {
      this.stickPointer = -1;
      this.state.steer = 0;
      this.state.steering = false;
      this.stickWrap.classList.remove('live');
    }
    for (const b of this.buttons) {
      if (b.pointer === e.pointerId) {
        b.pointer = -1;
        b.el.classList.remove('down');
      }
    }
  };

  private placeStick(dx: number, dy: number) {
    this.stickBase.style.transform = `translate(${this.originX}px, ${this.originY}px) translate(-50%, -50%)`;
    this.stickKnob.style.transform =
      `translate(${this.originX + dx}px, ${this.originY + dy}px) translate(-50%, -50%)`;
  }

  /**
   * Called once per frame by Input, before it reads `state`.
   *
   * `held || tapped` is the whole point of the latch: a press that has already
   * been released is still reported for the one frame that first sees it, so a
   * sub-frame stab at DRIFT or ITEM lands instead of vanishing.
   */
  update() {
    const s = this.state;
    s.drift = this.bDrift.pointer >= 0 || this.bDrift.tapped;
    s.item = this.bItem.pointer >= 0 || this.bItem.tapped;
    s.look = this.bLook.pointer >= 0 || this.bLook.tapped;
    s.brake = this.bBrake.pointer >= 0 || this.bBrake.tapped ? 1 : 0;
    const gas = !this.auto && (this.bGas.pointer >= 0 || this.bGas.tapped);
    s.accel = this.auto ? (s.brake > 0 ? 0 : 1) : gas ? 1 : 0;
    s.active = this.stickPointer >= 0 ||
      this.bDrift.pointer >= 0 || this.bItem.pointer >= 0 || this.bBrake.pointer >= 0 ||
      this.bLook.pointer >= 0 || this.bGas.pointer >= 0 ||
      s.drift || s.item || s.brake > 0 || gas;
    for (let i = 0; i < this.buttons.length; i++) this.buttons[i].tapped = false;
  }

  /** Input clears this after converting it to a one-frame edge. */
  consumePause() {
    const p = this.state.pause;
    this.state.pause = false;
    return p;
  }
}

const MARKUP = `
<div class="tc-stick-zone">
  <div class="tc-stick-base"></div>
  <div class="tc-stick-knob"></div>
</div>

<div class="tc-top">
  <div class="tc-chip tc-auto on">AUTO</div>
  <div class="tc-chip tc-pause" data-btn="pause">II</div>
</div>

<div class="tc-cluster">
  <div class="tc-btn tc-look"  data-btn="look"><span>◄►</span></div>
  <div class="tc-btn tc-brake" data-btn="brake"><span>BRAKE</span></div>
  <div class="tc-btn tc-gas"   data-btn="gas"><span>GAS</span></div>
  <div class="tc-btn tc-item"  data-btn="item">
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect x="6" y="6" width="28" height="28" rx="7" fill="none" stroke="currentColor" stroke-width="3"/>
      <path d="M20 13v14M13 20h14" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="tc-btn tc-drift" data-btn="drift"><span>DRIFT</span></div>
</div>

<div class="tc-rotate"><div><b>Rotate your device</b><br/>Kart Royale plays in landscape.</div></div>
`;

const CSS = `
.tc-root {
  position: fixed; inset: 0; z-index: 20;
  pointer-events: none; touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  font: 700 3.1vmin/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: 0.06em;
}

/* The stick zone is a hit area only; the visuals are positioned absolutely
   from JS at the thumb, so this stays empty until a touch lands. */
.tc-stick-zone { position: absolute; inset: 0 50% 0 0; }
.tc-stick-base, .tc-stick-knob {
  position: fixed; top: 0; left: 0; border-radius: 50%;
  opacity: 0; transition: opacity 120ms ease;
  will-change: transform, opacity;
}
.tc-stick-base {
  background: radial-gradient(circle at 50% 45%, rgba(255,255,255,.10), rgba(8,14,26,.30) 70%);
  border: 2px solid rgba(255,255,255,.42);
  box-shadow: 0 4px 22px rgba(0,0,0,.45), inset 0 0 20px rgba(255,255,255,.07);
}
.tc-stick-knob {
  background: radial-gradient(circle at 40% 35%, #fff, #ffd98a 55%, #f0a93c 100%);
  border: 2px solid rgba(255,255,255,.85);
  box-shadow: 0 6px 18px rgba(0,0,0,.5), 0 0 22px rgba(255,190,90,.55);
}
.tc-stick-zone.live .tc-stick-base { opacity: .85; }
.tc-stick-zone.live .tc-stick-knob { opacity: 1; }

/* Top-LEFT, tucked in beside the lap counter. The obvious home is top-right,
   but that is the race timer, and a chip sitting on the timer is exactly the
   kind of collision that reads as unfinished. */
.tc-top {
  position: absolute; display: flex; gap: 1.4vmin;
  top: calc(env(safe-area-inset-top, 0px) + 1.6vmin);
  left: calc(env(safe-area-inset-left, 0px) + 17vmin);
}
.tc-chip {
  pointer-events: auto; min-width: 11vmin; padding: 1.1vmin 1.8vmin;
  text-align: center; border-radius: 2.2vmin; color: #cfd8e6;
  background: rgba(10,16,28,.55); border: 1.5px solid rgba(255,255,255,.20);
  backdrop-filter: blur(6px); font-size: 2.5vmin;
  text-shadow: 0 1px 2px rgba(0,0,0,.6);
}
.tc-chip.on {
  color: #10202f; text-shadow: none;
  background: linear-gradient(180deg, #ffe6a8, #f2b445);
  border-color: rgba(255,255,255,.6);
}
.tc-pause { min-width: 8vmin; letter-spacing: .14em; }

.tc-cluster {
  position: absolute;
  right: calc(env(safe-area-inset-right, 0px) + 3vmin);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 3vmin);
  width: 46vmin; height: 40vmin;
}
.tc-btn {
  position: absolute; pointer-events: auto;
  display: grid; place-items: center; border-radius: 50%;
  color: #f4f7fb; text-align: center;
  background: radial-gradient(circle at 50% 38%, rgba(255,255,255,.16), rgba(9,15,27,.52) 72%);
  border: 2px solid rgba(255,255,255,.34);
  box-shadow: 0 5px 18px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.22);
  backdrop-filter: blur(5px);
  text-shadow: 0 1px 3px rgba(0,0,0,.75);
  /* 90ms was long enough that a fast tap released before the press state had
     finished animating in, so a stab at DRIFT looked like it had missed even
     when it had not. Feedback on a control must not lag the control. */
  transition: transform 55ms ease, box-shadow 55ms ease, background 55ms ease;
}
.tc-btn span { font-size: 2.4vmin; }
.tc-btn svg { width: 52%; height: 52%; }
.tc-btn.down { transform: scale(.92); }

.tc-drift {
  right: 0; bottom: 0; width: 22vmin; height: 22vmin;
  background: radial-gradient(circle at 50% 36%, rgba(120,220,255,.42), rgba(12,52,84,.62) 72%);
  border-color: rgba(150,230,255,.72);
  box-shadow: 0 6px 22px rgba(0,0,0,.45), 0 0 26px rgba(79,195,255,.32), inset 0 1px 0 rgba(255,255,255,.3);
}
.tc-drift.down { box-shadow: 0 0 40px rgba(79,195,255,.85), inset 0 1px 0 rgba(255,255,255,.4); }
.tc-item  { right: 24vmin; bottom: 3vmin; width: 16vmin; height: 16vmin; }
.tc-item.down { box-shadow: 0 0 34px rgba(255,214,110,.8); }
.tc-brake { right: 2vmin; bottom: 24vmin; width: 14vmin; height: 14vmin; }
.tc-gas   { right: 17vmin; bottom: 21vmin; width: 14vmin; height: 14vmin; }
.tc-look  { right: 33vmin; bottom: 20vmin; width: 11vmin; height: 11vmin; opacity: .8; }
.tc-look span { font-size: 2.7vmin; letter-spacing: 0; }

/* ---- HUD reflow for thumbs -------------------------------------------------
   The desktop HUD owns all four corners, and two of them are now under a hand.
   These live here rather than in ui.css so the touch layout ships as one
   self-contained unit, and so the HUD keeps a single desktop layout to reason
   about. Scoped to html[data-touch], so desktop is untouched. */
html[data-touch] .kr-speed {
  /* left of the action cluster, which is 46vmin wide */
  right: 47vmin;
  transform: scale(.82);   /* transform-origin is already 100% 100% */
}
/* DEAD RULE REMOVED (round 10). This block repositioned '.kr-board', the
   eight-row standings tower that used to sit right-centre. Round 8 deleted
   that element — the in-race order is now one rival row inside the position
   plate at LEFT-centre — so this selector had matched nothing since. The
   right half of a touch frame is now the action cluster and the speedometer
   and nothing else, which is what the reflow below assumes. */
/* The AUTO / PAUSE chips start at 17vmin, which is inside the lap plate on a
   short landscape phone. Push them clear; the minimap sits at frame centre and
   is nowhere near them. */
html[data-touch] .tc-top { left: calc(env(safe-area-inset-left, 0px) + 26vmin); }
/* The item box deliberately stays in its desktop bottom-left home. Moving it up
   the left edge to dodge the thumb put it straight through the position
   indicator, and it is a read-only display the floating stick can safely
   overlap for the moment a thumb is actually down there. */

/* Portrait is unplayable at this HUD density; say so rather than shipping a
   squashed frame the player has to guess at. */
.tc-rotate { display: none; }
@media (orientation: portrait) {
  .tc-rotate {
    display: grid; place-items: center; position: absolute; inset: 0;
    background: rgba(5,8,16,.92); color: #f0f4fa; pointer-events: auto;
    text-align: center; font-size: 4.2vmin; line-height: 1.55; padding: 8vmin;
  }
  .tc-rotate b { font-size: 5.4vmin; letter-spacing: .04em; }
  .tc-stick-zone, .tc-cluster, .tc-top { display: none; }
}
`;
