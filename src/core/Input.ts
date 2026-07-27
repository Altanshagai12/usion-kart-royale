import type { Ctx, IInput, InputState } from '../types';

/**
 * Keyboard + gamepad input.
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

  init(_ctx: Ctx) {
    addEventListener('keydown', this.onDown);
    addEventListener('keyup', this.onUp);
    addEventListener('blur', this.onBlur);
    addEventListener('gamepadconnected', this.onPad);
    addEventListener('gamepaddisconnected', this.onPadOff);
    this.touch = matchMedia?.('(pointer: coarse)')?.matches ?? false;
  }

  dispose() {
    removeEventListener('keydown', this.onDown);
    removeEventListener('keyup', this.onUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('gamepadconnected', this.onPad);
    removeEventListener('gamepaddisconnected', this.onPadOff);
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

    // --- gamepad, if one is attached -----------------------------------------
    const pad = this.padIndex >= 0 ? navigator.getGamepads?.()?.[this.padIndex] : null;
    if (pad) {
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > DEADZONE) {
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
    if (steerTarget !== 0) {
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
