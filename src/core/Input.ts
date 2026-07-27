import type { Ctx, IInput, InputState } from '../types';
import { TouchControls } from './TouchControls';

/**
 * Keyboard + gamepad + on-screen touch input.
 *
 * Every consumer in the game reads `state` once per frame, so the edge flags
 * (`driftPressed`, `itemPressed`, `pausePressed`, `anyPressed`) are computed
 * here in `update()` and are true for exactly one frame. `lookBack` is a held
 * boolean — the camera rig wants it sustained, not pulsed.
 *
 * `steer` is smoothed and dead-zoned so a digital key feels like a stick: the
 * physics reads it as an analogue rack angle and a raw ±1 step makes the front
 * axle snap.
 */

const STEER_RATE = 6.4;   // units/s toward the target while a key is held
const STEER_RETURN = 9.5; // units/s back to centre when nothing is held
const DEADZONE = 0.16;

export class Input implements IInput {
  state: InputState = {
    steer: 0, accel: 0, brake: 0, drift: false, driftPressed: false,
    itemPressed: false, lookBack: false, pausePressed: false, anyPressed: false,
  };
  touch = false;

  private keys = new Set<string>();
  /** edge bookkeeping — previous frame's held state per logical button */
  private wasDrift = false;
  private wasItem = false;
  private wasPause = false;
  private wasAny = false;
  private padIndex = -1;
  private pad = new TouchControls();
  /** true once a finger has actually driven the on-screen pad */
  private padUsed = false;

  init(_ctx: Ctx) {
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
    this.keys.add(e.code);
    // Space and the arrows scroll the page; the game owns them.
    if (SWALLOW.has(e.code)) e.preventDefault();
  };
  private onUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  /** Losing focus mid-corner must not leave a key stuck down. */
  private onBlur = () => { this.keys.clear(); };
  private onPad = (e: GamepadEvent) => { this.padIndex = e.gamepad.index; };
  private onPadOff = () => { this.padIndex = -1; };

  update(_ctx: Ctx, dt: number) {
    const k = this.keys;
    const s = this.state;
    const has = (...codes: string[]) => codes.some((c) => k.has(c));

    let steerTarget = (has('ArrowRight', 'KeyD') ? 1 : 0) - (has('ArrowLeft', 'KeyA') ? 1 : 0);
    let accel = has('ArrowUp', 'KeyW', 'Space') ? 1 : 0;
    let brake = has('ArrowDown', 'KeyS') ? 1 : 0;
    let drift = has('ShiftLeft', 'ShiftRight');
    let item = has('ControlLeft', 'ControlRight', 'KeyE', 'Enter');
    let look = has('KeyQ', 'AltLeft');
    let pause = has('Escape', 'KeyP');

    // Analogue sources report an absolute stick position, so they must not go
    // through the digital ramp below — that ramp exists to fake an axis out of
    // a key, and applying it to a real axis just adds lag.
    let analogue = false;

    // --- on-screen pad, if this is a touch device ----------------------------
    if (this.touch) {
      this.pad.update();
      const t = this.pad.state;
      if (t.active) this.padUsed = true;
      if (t.steer !== 0) { steerTarget = t.steer; analogue = true; }
      accel = Math.max(accel, t.accel);
      brake = Math.max(brake, t.brake);
      drift = drift || t.drift;
      item = item || t.item;
      look = look || t.look;
      pause = pause || this.pad.consumePause();
    }

    // --- gamepad, if one is attached -----------------------------------------
    const pad = this.padIndex >= 0 ? navigator.getGamepads?.()?.[this.padIndex] : null;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) {
        analogue = true;
        // rescale past the dead zone so the first live degree isn't a jump
        steerTarget = Math.sign(ax) * ((Math.abs(ax) - DEADZONE) / (1 - DEADZONE));
      }
      const btn = (i: number) => (pad.buttons[i]?.value ?? 0);
      accel = Math.max(accel, btn(7), pad.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, btn(6), pad.buttons[1]?.pressed ? 1 : 0);
      drift = drift || !!pad.buttons[5]?.pressed || !!pad.buttons[4]?.pressed;
      item = item || !!pad.buttons[2]?.pressed || !!pad.buttons[3]?.pressed;
      look = look || !!pad.buttons[10]?.pressed;
      pause = pause || !!pad.buttons[9]?.pressed;
    }

    // --- analogue-feeling steer ----------------------------------------------
    if (analogue) {
      // Track the physical stick closely; the light smoothing is only there to
      // take the jitter off a thumb resting on glass.
      s.steer += (steerTarget - s.steer) * Math.min(1, dt * 24);
    } else if (steerTarget !== 0) {
      const rate = Math.sign(steerTarget) === Math.sign(s.steer) || s.steer === 0
        ? STEER_RATE
        : STEER_RATE * 2.1; // crossing centre must be quick or it feels dead
      s.steer += Math.max(-rate * dt, Math.min(rate * dt, steerTarget - s.steer));
    } else {
      const d = STEER_RETURN * dt;
      s.steer = Math.abs(s.steer) <= d ? 0 : s.steer - Math.sign(s.steer) * d;
    }

    s.accel = accel;
    s.brake = brake;
    s.drift = drift;
    s.lookBack = look;

    // --- edges ----------------------------------------------------------------
    s.driftPressed = drift && !this.wasDrift;
    s.itemPressed = item && !this.wasItem;
    s.pausePressed = pause && !this.wasPause;
    this.wasDrift = drift;
    this.wasItem = item;
    this.wasPause = pause;

    const any = k.size > 0 || accel > 0 || brake > 0 || drift || item || pause ||
      steerTarget !== 0 || look;
    s.anyPressed = any && !this.wasAny;
    this.wasAny = any;
  }
}

// Keys the browser would otherwise scroll the page with. `Enter` is
// deliberately *not* here: it is the item key, but swallowing it would also
// stop a focused menu button from activating.
const SWALLOW = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);
