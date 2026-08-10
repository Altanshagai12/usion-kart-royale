import { RaceState, type Ctx, type IInput, type InputState } from '../types';
import { TouchControls } from './TouchControls';

/**
 * ============================================================================
 *  Keyboard + gamepad + on-screen touch input.
 * ============================================================================
 *  Every consumer in the game reads `state` once per frame, so the edge flags
 *  (`driftPressed`, `itemPressed`, `pausePressed`, `anyPressed`) are computed
 *  here in `update()` and are true for exactly one frame. `lookBack` is a held
 *  boolean — the camera rig wants it sustained, not pulsed.
 *
 *  ---------------------------------------------------------------------------
 *  THE LATENCY BUDGET (round 11) — the reason most of this file looks the way
 *  it does. `Input` is the second system in main.ts's update list and `Race` is
 *  the seventh, so a press observed here reaches `Kart.step` on the same frame.
 *  Everything between the two is therefore *chosen* lag, and it was being spent
 *  twice:
 *
 *    - `Kart` already owns a steering rack. `steerInput` chases the command
 *      through `approach(..., rate * dt)` at 8.5 units/s low speed falling to
 *      4.2 at top speed, and `steerAngle` then chases *that* at 26/s. Those are
 *      the physical rate limits, they are speed-aware, and they belong in the
 *      physics.
 *    - This file then put a SECOND rate limit in front of them: a 6.4/s ramp
 *      for keys (156 ms to full lock) and a `dt * 24` exponential lag for the
 *      touch stick and the gamepad. Two rate limiters in series is how steering
 *      gets described as "mushy". Measured lock-to-lock on the keyboard was
 *      215 ms *before physics had seen anything*.
 *
 *  So: the analogue sources (touch stick, gamepad stick) are now passed through
 *  UNFILTERED. A thumb on glass and a stick in a hand are already absolute
 *  positions — they ARE the rack command — and the kart's own rack turns them
 *  into a physical angle. The digital ramp survives only for keys and the
 *  d-pad, where an axis genuinely has to be invented, and runs at 15/s: fast
 *  enough that `Kart`'s rack is once again the single authority on how quickly
 *  a kart can turn, which is where that decision should have been all along.
 *
 *  ---------------------------------------------------------------------------
 *  FRAME-RATE INDEPENDENCE. Every rate in this file is a LINEAR ramp integrated
 *  as `rate * dt`, which is exact at any step size — 30, 60 and 120 fps produce
 *  the same steering trajectory in wall-clock terms, and the bench confirms it.
 *  The old analogue path used `x += (target - x) * min(1, dt * 24)`, which is a
 *  first-order approximation of an exponential and is *not* step-invariant: it
 *  measured 66.7 ms to 0.9 at 30 fps against 91.7 ms at 120 fps, and became a
 *  hard snap below 24 fps where the factor clamps to 1. A phone that drops to
 *  30 fps must not quietly get quicker steering than the same phone at 120 Hz.
 *  There is no exponential smoother left in this file for that reason.
 *
 *  ---------------------------------------------------------------------------
 *  BUFFERING. Two different problems, two different mechanisms:
 *
 *   1. *Presses that were never observed.* Keys have been latched for a while
 *      (see `latched`). Touch buttons were not, and were polled — a stab at the
 *      item button lasting less than one frame set and cleared a pointer id
 *      between two rAFs and was gone. `TouchControls` now latches too.
 *
 *   2. *Presses that arrived a frame before they were legal.* Standard in the
 *      genre and worth ~100 ms. `drift` gets a minimum hold, so a tap is still
 *      held while `Kart`'s rack winds the steering past the 0.2 it needs to
 *      commit to a slide — pressing drift and flicking the stick on the same
 *      frame used to lose the drift. `item` gets a re-arm: the press is
 *      re-offered each frame until the held-item view changes (which is the
 *      only observable proof `IItems.use` accepted it) or the window runs out,
 *      so a shot fired while the roulette is still settling still goes.
 * ============================================================================
 */

/** units/s toward the target while a key or d-pad direction is held */
const STEER_RATE = 15;
/** units/s while the command is on the far side of centre — a counter-flick */
const STEER_CROSS = 34;
/** units/s back to centre when nothing is held */
const STEER_RETURN = 16;

/** gamepad stick dead zone, rescaled away so the first live degree is not a jump */
const STICK_DEADZONE = 0.15;
/** a worn stick that only reaches 0.94 must still be able to ask for full lock */
const STICK_SATURATION = 0.95;
/** mild expo — fine control near centre without costing the mid-range */
const STICK_CURVE = 1.18;
/** analogue triggers rest a little above zero on most pads */
const TRIGGER_DEADZONE = 0.06;
const TRIGGER_SATURATION = 0.92;

/** seconds a tapped drift stays held, so a late-arriving condition still sees it */
const DRIFT_MIN_HOLD = 0.1;
/** seconds an item press keeps being re-offered while it is refused */
const ITEM_BUFFER = 0.11;
/** seconds between rumble effects — a pad that is always buzzing says nothing */
const RUMBLE_GAP = 0.055;

export class Input implements IInput {
  state: InputState = {
    steer: 0, accel: 0, accelHeld: false, brake: 0, drift: false, driftPressed: false,
    itemPressed: false, itemSlot: -1,
    lookBack: false, pausePressed: false, anyPressed: false,
  };
  touch = false;

  private keys = new Set<string>();
  /**
   * Keys that went down since the last `update`, whether or not they are still
   * held. Edges are otherwise derived by polling `keys` once a frame, so a
   * press and release landing entirely between two frames — a 16ms window at
   * 60fps, which a quick tap on the item button really does hit — would never
   * be observed at all. Latching guarantees every press is seen for exactly one
   * frame; it is cleared at the end of `update`.
   */
  private latched = new Set<string>();
  /** edge bookkeeping — previous frame's held state per logical button */
  private wasDrift = false;
  private wasItem = false;
  private wasPause = false;
  private wasAny = false;
  private padIndex = -1;
  private pad = new TouchControls();
  /** true once a finger has actually driven the on-screen pad */
  private padUsed = false;

  /** true once the gamepad stick has been the steering source */
  private padSteered = false;
  /** seconds until the next `navigator.getGamepads()` sweep while none is known */
  private padScan = 0;

  /** remaining seconds of the drift minimum hold */
  private driftMin = 0;
  /** remaining seconds an unaccepted item press keeps being re-offered */
  private itemBuf = 0;
  /** slot that originated the buffered item press; -1 = first occupied */
  private itemBufSlot = -1;
  /** held-item fingerprint at the moment the buffered press was raised */
  private itemSig = -1;

  private ctx: Ctx | null = null;
  private offBus: (() => void) | null = null;
  private rumbleCooldown = 0;
  private rumbleStrength = 0;

  init(ctx: Ctx) {
    this.ctx = ctx;
    addEventListener('keydown', this.onDown);
    addEventListener('keyup', this.onUp);
    addEventListener('blur', this.onBlur);
    addEventListener('gamepadconnected', this.onPad);
    addEventListener('gamepaddisconnected', this.onPadOff);
    addEventListener('keydown', this.onFirstKey, { once: true });

    // Two-stage detection, because one stage is not enough.
    //
    // Stage 1, eager: a coarse pointer or a positive touch-point count covers
    // every phone and touch laptop, and correctly ignores a phone-sized desktop
    // window. It is a media query rather than user-agent sniffing.
    //
    // Stage 2, lazy: iPadOS Safari defaults to "Request Desktop Website", under
    // which it reports `pointer: fine` and `maxTouchPoints: 0` — it claims to be
    // a Mac. Stage 1 says desktop and the pad never appears, which is exactly
    // the bug this fixes. So an actual touch, from any device however it
    // describes itself, mounts the pad on the spot. A real finger is the only
    // evidence that cannot be wrong.
    this.touch = (matchMedia?.('(pointer: coarse)')?.matches ?? false) ||
      navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    if (this.touch) this.pad.mount();
    // Capture phase on window, so this runs BEFORE the pad's own bubble-phase
    // listener is consulted. Mounting here means the very touch that revealed
    // the controls still reaches them on the way back up, instead of being
    // swallowed and forcing the player to tap twice.
    else addEventListener('pointerdown', this.onFirstTouch, { capture: true });

    this.blockPageGestures();

    // Haptics. The bus is the only place impacts are announced, and it is
    // fire-and-forget, so listening costs nothing when no pad is attached.
    this.offBus = ctx.bus.on((e) => {
      switch (e.type) {
        case 'collide':
          if (e.kart.isPlayer) this.haptic(clamp01(e.impulse / 14), 0.35, 130);
          break;
        case 'hit':
          if (e.kart.isPlayer) this.haptic(0.95, 0.75, 220);
          break;
        case 'land':
          if (e.kart.isPlayer) this.haptic(clamp01(e.impact / 22), 0.2, 90);
          break;
        case 'boost':
          if (e.kart.isPlayer) this.haptic(0.28, 0.75, 200);
          break;
        case 'drift-spark':
          // A tick on each mini-turbo tier change. Tier 0 is drift ENTRY and
          // fires on every corner, so it is deliberately left silent.
          if (e.kart.isPlayer && e.tier > 0) this.haptic(0.16, 0.5, 55);
          break;
      }
    });
  }

  /** A real finger on a device that claimed to be a desktop. Believe the finger. */
  private onFirstTouch = (e: PointerEvent) => {
    if (this.touch || e.pointerType !== 'touch') return;
    this.touch = true;
    this.pad.mount();
    removeEventListener('pointerdown', this.onFirstTouch, { capture: true } as any);
  };

  dispose() {
    removeEventListener('keydown', this.onDown);
    removeEventListener('keyup', this.onUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('gamepadconnected', this.onPad);
    removeEventListener('gamepaddisconnected', this.onPadOff);
    removeEventListener('keydown', this.onFirstKey);
    removeEventListener('pointerdown', this.onFirstTouch, { capture: true } as any);
    this.offBus?.();
    this.offBus = null;
    this.pad.unmount();
  }

  /**
   * A real keypress means a real keyboard, so the on-screen pad is clutter —
   * unless a finger has already used it, in which case this is a tablet with a
   * keyboard attached and taking the controls away mid-race would be worse.
   */
  private onFirstKey = () => {
    if (this.touch && !this.padUsed) {
      this.touch = false;
      this.pad.unmount();
    }
  };

  /**
   * iOS Safari has ignored `user-scalable=no` since iOS 10, so the viewport meta
   * tag does not stop pinch-zoom — the page zooms under the player's thumbs
   * mid-corner. These are the parts that actually work: `touch-action: none`
   * (set on html/body in index.html) kills the browser's own panning and
   * double-tap zoom, and Safari's proprietary `gesture*` events must be
   * cancelled explicitly on top of that. Installed at boot rather than at pad
   * mount, because a pinch can happen before the first single touch.
   */
  private blockPageGestures() {
    const stop = (e: Event) => e.preventDefault();
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      addEventListener(t, stop, { passive: false });
    }
    // Belt and braces for engines that honour neither of the above: cancel any
    // multi-finger move that is not aimed at an interactive control.
    addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
    // Double-tap-to-zoom fires as a second tap inside ~300ms.
    let lastTap = 0;
    addEventListener('touchend', (e: TouchEvent) => {
      const now = e.timeStamp;
      if (now - lastTap < 320) e.preventDefault();
      lastTap = now;
    }, { passive: false });
  }

  private onDown = (e: KeyboardEvent) => {
    if (!e.repeat) this.latched.add(e.code);
    this.keys.add(e.code);
    // Space and the arrows scroll the page; the game owns them.
    if (SWALLOW.has(e.code)) e.preventDefault();
  };
  private onUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  /** Losing focus mid-corner must not leave a key stuck down. */
  private onBlur = () => { this.keys.clear(); this.latched.clear(); };
  private onPad = (e: GamepadEvent) => { this.padIndex = e.gamepad.index; };
  private onPadOff = () => { this.padIndex = -1; this.padSteered = false; };

  // ---------------------------------------------------------------------------
  // gamepad
  // ---------------------------------------------------------------------------

  /**
   * The connected pad, or null.
   *
   * `gamepadconnected` is the documented way in and is honoured, but it only
   * fires after the *first input* on some browsers, and never at all for a pad
   * that was already live when the tab was restored from bfcache. So a sweep
   * backstops it — throttled to twice a second while no pad is known, because
   * `getGamepads()` allocates a fresh array on every call and this is the hot
   * path the art direction's "zero per-frame allocation" rule is about.
   */
  private gamepad(dt: number): Gamepad | null {
    const get = navigator.getGamepads;
    if (typeof get !== 'function') return null;
    if (this.padIndex >= 0) {
      const g = get.call(navigator)[this.padIndex];
      if (g && g.connected) return g;
      this.padIndex = -1;
      this.padSteered = false;
    }
    this.padScan -= dt;
    if (this.padScan > 0) return null;
    this.padScan = 0.5;
    const all = get.call(navigator);
    for (let i = 0; i < all.length; i++) {
      const g = all[i];
      if (g && g.connected) { this.padIndex = g.index; return g; }
    }
    return null;
  }

  /** Dead-zoned, rescaled and mildly expo'd — an absolute rack command. */
  private stickAxis(v: number): number {
    if (!Number.isFinite(v)) return 0;
    const m = Math.abs(v);
    if (m <= STICK_DEADZONE) return 0;
    const n = Math.min(1, (m - STICK_DEADZONE) / (STICK_SATURATION - STICK_DEADZONE));
    return Math.sign(v) * Math.pow(n, STICK_CURVE);
  }

  /** Analogue trigger, 0..1, with its own (much smaller) rest dead zone. */
  private triggerValue(b: GamepadButton | undefined): number {
    const v = b ? (b.value || (b.pressed ? 1 : 0)) : 0;
    if (!Number.isFinite(v) || v <= TRIGGER_DEADZONE) return 0;
    return Math.min(1, (v - TRIGGER_DEADZONE) / (TRIGGER_SATURATION - TRIGGER_DEADZONE));
  }

  /**
   * Fire a rumble effect if the attached pad can, and a short device vibration
   * if it cannot but the phone can. Everything is best-effort: `playEffect` is
   * absent on Safari and rejects on a pad that has lost its actuator, and a
   * rejected promise here must never reach the player.
   */
  private haptic(strong: number, weak: number, ms: number) {
    if (strong <= 0.02) return;
    // A weak effect must not cut a strong one short; a strong one may cut a
    // weak one, otherwise a shell hit lands silently behind a drift tick.
    if (this.rumbleCooldown > 0 && strong <= this.rumbleStrength) return;
    this.rumbleCooldown = Math.max(RUMBLE_GAP, ms / 1000);
    this.rumbleStrength = strong;

    const g = this.padIndex >= 0 ? navigator.getGamepads?.()?.[this.padIndex] : null;
    const act = (g as any)?.vibrationActuator;
    if (act && typeof act.playEffect === 'function') {
      try {
        const p = act.playEffect('dual-rumble', {
          startDelay: 0, duration: ms,
          strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak),
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* an actuator that refuses is not an error worth surfacing */ }
      return;
    }
    // No pad. Phones that expose the Vibration API get a short pulse for real
    // impacts only — a buzz on every drift tier would be intolerable in a hand.
    // iOS Safari does not implement this, so it is a no-op there.
    if (strong > 0.55 && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(Math.min(40, Math.round(ms * 0.15))); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // frame
  // ---------------------------------------------------------------------------

  update(ctx: Ctx, dt: number) {
    this.ctx = ctx;
    const k = this.keys;
    const s = this.state;
    const has = (...codes: string[]) => codes.some((c) => k.has(c));
    /**
     * Held OR pressed-since-last-frame. Used for the buttons whose edge matters
     * (item, pause, drift); steering and throttle deliberately stay on `has`,
     * since a one-frame ghost of a held axis would feel like a twitch.
     */
    const hit = (...codes: string[]) => codes.some((c) => k.has(c) || this.latched.has(c));

    // --- keyboard -------------------------------------------------------------
    let digital = (has('ArrowRight', 'KeyD') ? 1 : 0) - (has('ArrowLeft', 'KeyA') ? 1 : 0);
    let accel = has('ArrowUp', 'KeyW') ? 1 : 0;
    let accelHeld = accel > 0;
    let brake = has('ArrowDown', 'KeyS') ? 1 : 0;
    let drift = hit('ShiftLeft', 'ShiftRight');
    // Space fires items. It used to be a third accelerate binding, which wasted
    // the most reachable key on the board on a function two other keys already
    // cover, and left firing on Ctrl — a modifier the OS intercepts.
    let itemSlot = hit('Digit1') ? 0 : hit('Digit2') ? 1 : hit('Digit3') ? 2 : -1;
    let item = itemSlot >= 0 || hit('Space', 'Enter', 'KeyE', 'ControlLeft', 'ControlRight');
    let look = has('KeyQ', 'AltLeft');
    let pause = hit('Escape', 'KeyP');
    /** true if the player did something deliberate this frame */
    let acted = k.size > 0;

    /**
     * An absolute steering request from a real axis, or null if the only thing
     * asking is a digital button. Analogue sources are NOT smoothed: see the
     * latency budget at the top of this file.
     */
    let analogue: number | null = null;

    // --- on-screen pad, if this is a touch device ----------------------------
    if (this.touch) {
      this.pad.update();
      const t = this.pad.state;
      if (t.active) { this.padUsed = true; acted = true; }
      // `steering`, not `steer !== 0`: a thumb parked inside the dead zone is
      // asking for straight-ahead RIGHT NOW, and should get it immediately
      // rather than coasting back through the digital return ramp.
      if (t.steering) analogue = t.steer;
      accel = Math.max(accel, t.accel);
      accelHeld = accelHeld || t.accelHeld;
      brake = Math.max(brake, t.brake);
      drift = drift || t.drift;
      item = item || t.item;
      if (t.item) itemSlot = t.itemSlot;
      pause = pause || this.pad.consumePause();
    }

    // --- gamepad, if one is attached -----------------------------------------
    // Standard Gamepad layout (the `mapping: "standard"` button order):
    //   0 A / 1 B / 2 X / 3 Y, 4 LB / 5 RB, 6 LT / 7 RT (both analogue),
    //   8 Back / 9 Start, 10 L3 / 11 R3, 12..15 d-pad up/down/left/right,
    //   axes 0,1 left stick, axes 2,3 right stick.
    const gp = this.gamepad(dt);
    if (gp) {
      const b = gp.buttons;
      const ax = this.stickAxis(gp.axes[0] ?? 0);
      if (ax !== 0) {
        analogue = ax;
        this.padSteered = true;
        acted = true;
      } else if (this.padSteered && analogue === null && digital === 0) {
        // The stick is physically centred and it was the last thing steering.
        // A real spring has already returned; report that, do not ramp back.
        analogue = 0;
      }
      // The d-pad is a digital source and goes through the ramp, not the axis.
      const dpad = (b[15]?.pressed ? 1 : 0) - (b[14]?.pressed ? 1 : 0);
      if (dpad !== 0) { digital = dpad; analogue = null; acted = true; }

      // Analogue throttle and brake. RT/LT are pressure-sensitive on every
      // standard pad, so feathering out of a corner works; A/B and the d-pad
      // stay as full-travel fallbacks for pads that report triggers as buttons.
      const rt = this.triggerValue(b[7]);
      const lt = this.triggerValue(b[6]);
      const padAccel = Math.max(rt, b[0]?.pressed ? 1 : 0, b[12]?.pressed ? 1 : 0);
      accel = Math.max(accel, padAccel);
      // Preserve the old countdown threshold so a lightly resting/noisy
      // analogue trigger cannot accumulate a full burnout hold.
      accelHeld = accelHeld || padAccel > 0.5;
      brake = Math.max(brake, lt, b[1]?.pressed ? 1 : 0, b[13]?.pressed ? 1 : 0);
      drift = drift || !!b[5]?.pressed || !!b[4]?.pressed;
      item = item || !!b[2]?.pressed || !!b[3]?.pressed;
      look = look || !!b[10]?.pressed || !!b[11]?.pressed;
      pause = pause || !!b[9]?.pressed || !!b[8]?.pressed;
      if (accel > 0 || brake > 0 || drift || item || look || pause) acted = true;
    }

    // --- steering -------------------------------------------------------------
    if (analogue !== null) {
      // Straight through. The kart's own rack is the rate limit.
      s.steer = analogue < -1 ? -1 : analogue > 1 ? 1 : analogue;
    } else if (digital !== 0) {
      // A key has to have an axis invented for it. Linear in dt, so identical
      // at 30, 60 and 120 fps; fast, because Kart.step limits it again anyway.
      const crossing = s.steer !== 0 && Math.sign(digital) !== Math.sign(s.steer);
      const rate = (crossing ? STEER_CROSS : STEER_RATE) * dt;
      const delta = digital - s.steer;
      s.steer += delta < -rate ? -rate : delta > rate ? rate : delta;
    } else {
      const d = STEER_RETURN * dt;
      s.steer = Math.abs(s.steer) <= d ? 0 : s.steer - Math.sign(s.steer) * d;
    }
    if (digital !== 0) acted = true;

    // --- drift: minimum hold ---------------------------------------------------
    // A tap must survive long enough for `Kart` to have wound the steering rack
    // past the 0.2 it demands before it will commit to a slide. Armed on the
    // rising edge and counted down while held, so RELEASING a long-held drift —
    // which is the mini-turbo, and is timing-critical — is never delayed.
    if (drift && !this.wasDrift) this.driftMin = DRIFT_MIN_HOLD;
    else if (this.driftMin > 0) this.driftMin -= dt;
    if (this.driftMin > 0) drift = true;

    s.accel = accel;
    s.accelHeld = accelHeld;
    s.brake = brake;
    s.drift = drift;
    s.lookBack = look;

    // --- edges ----------------------------------------------------------------
    s.driftPressed = drift && !this.wasDrift;
    let itemPressed = item && !this.wasItem;
    s.pausePressed = pause && !this.wasPause;
    this.wasDrift = drift;
    this.wasItem = item;
    this.wasPause = pause;

    // --- item: re-arm while the press is being refused -------------------------
    // `IItems.use` silently returns false while the roulette is still arming,
    // while stunned, and with an empty slot — so a shot loosed a few frames
    // early simply vanished. There is no acknowledgement channel, but there is
    // proof: a use that was ACCEPTED always changes the held-item view (the
    // count drops, or the kind clears, or a towed shell is let go). So the
    // press is re-offered until that fingerprint moves, or the window expires.
    //
    // Hard-gated to `RaceState.Racing`. `itemPressed` doubles as CONFIRM on
    // every menu, and a confirm that repeated for six frames would walk the
    // player through six screens.
    const live = ctx.race?.state === RaceState.Racing;
    if (itemPressed) {
      this.itemBuf = live ? ITEM_BUFFER : 0;
      this.itemBufSlot = itemSlot;
      this.itemSig = this.heldItemSig(this.itemBufSlot);
    } else if (this.itemBuf > 0) {
      this.itemBuf -= dt;
      const sig = this.heldItemSig(this.itemBufSlot);
      if (!live || sig < 0 || sig !== this.itemSig) this.itemBuf = 0;
      else if (this.itemBuf > 0) {
        itemPressed = true;
        itemSlot = this.itemBufSlot;
      }
    }
    s.itemPressed = itemPressed;
    s.itemSlot = itemPressed ? itemSlot : -1;

    if (drift || item || pause || look) acted = true;
    s.anyPressed = acted && !this.wasAny;
    this.wasAny = acted;

    if (this.rumbleCooldown > 0) {
      this.rumbleCooldown -= dt;
      if (this.rumbleCooldown <= 0) this.rumbleStrength = 0;
    }

    // One frame of visibility per press, then gone.
    this.latched.clear();
  }

  /**
   * A fingerprint of what the player is holding: kind and count folded into one
   * integer, -1 when it cannot be read. Only ever compared for inequality.
   */
  private heldItemSig(slotIndex = -1): number {
    const ctx = this.ctx;
    const player = ctx?.race?.player;
    if (!ctx || !player || !ctx.items) return -1;
    const h = ctx.items.held(player, slotIndex);
    return h ? (h.kind | 0) * 64 + (h.count | 0) : -1;
  }
}

function clamp01(v: number) {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

// Keys the browser would otherwise scroll the page with. `Enter` is
// deliberately *not* here: it is the item key, but swallowing it would also
// stop a focused menu button from activating.
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);
