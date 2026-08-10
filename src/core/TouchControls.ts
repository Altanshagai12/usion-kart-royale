import './touch-controls.css';
import { clientToSurface } from './Viewport';

export interface TouchState {
  steer: number;
  accel: number;
  /** true only while the player is pressing GAS, never for automatic throttle */
  accelHeld: boolean;
  brake: number;
  drift: boolean;
  item: boolean;
  /** exact visible inventory slot, -1 when no item button was pressed */
  itemSlot: number;
  pause: boolean;
  steering: boolean;
  active: boolean;
}

type ButtonId = 'left' | 'right' | 'drift' | 'brake' | 'gas'
  | 'item0' | 'item1' | 'item2';

type Btn = {
  id: ButtonId;
  el: HTMLElement;
  pointer: number;
  tapped: boolean;
  cx: number;
  cy: number;
  r2: number;
};

const BASE_BUTTONS: ButtonId[] = ['left', 'right', 'drift', 'brake', 'gas'];

/** Fixed, reference-style mobile controls with independent multi-touch claims. */
export class TouchControls {
  readonly state: TouchState = {
    steer: 0,
    accel: 0,
    accelHeld: false,
    brake: 0,
    drift: false,
    item: false,
    itemSlot: -1,
    pause: false,
    steering: false,
    active: false,
  };

  private auto = true;
  private root: HTMLElement | null = null;
  private autoChip!: HTMLElement;
  private buttons: Btn[] = [];
  private itemButtons: Btn[] = [];
  private mounted = false;
  private dirty = true;
  private free = new Set<number>();

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    document.documentElement.setAttribute('data-touch', '');
    const root = document.createElement('div');
    root.className = 'tc-root';
    root.innerHTML = MARKUP;
    document.body.appendChild(root);
    this.root = root;
    this.autoChip = root.querySelector('.tc-auto')!;
    for (const id of BASE_BUTTONS) {
      const el = root.querySelector<HTMLElement>(`[data-btn="${id}"]`)!;
      this.buttons.push(this.makeButton(id, el));
    }
    this.autoChip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setAuto(!this.auto);
    });
    root.querySelector('[data-btn="pause"]')!.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.state.pause = true;
    });
    this.setAuto(this.auto);
    addEventListener('pointerdown', this.onDown, { passive: false });
    addEventListener('pointermove', this.onMove, { passive: false });
    addEventListener('pointerup', this.onUp, { passive: false });
    addEventListener('pointercancel', this.onUp, { passive: false });
    addEventListener('contextmenu', this.onContext);
    addEventListener('resize', this.invalidate);
    addEventListener('orientationchange', this.invalidate);
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('pointercancel', this.onUp);
    removeEventListener('contextmenu', this.onContext);
    removeEventListener('resize', this.invalidate);
    removeEventListener('orientationchange', this.invalidate);
    document.documentElement.removeAttribute('data-touch');
    this.root?.remove();
    this.root = null;
    this.buttons = [];
    this.itemButtons = [];
    this.free.clear();
    Object.assign(this.state, {
      steer: 0, accel: 0, accelHeld: false, brake: 0, drift: false, item: false,
      itemSlot: -1, steering: false, active: false,
    });
  }

  private makeButton(id: ButtonId, el: HTMLElement): Btn {
    return { id, el, pointer: -1, tapped: false, cx: 0, cy: 0, r2: 0 };
  }

  private bindItemButtons() {
    if (this.itemButtons.length === 3) return;
    const nodes = [...document.querySelectorAll<HTMLElement>('.kr-item-slot[data-item-slot]')];
    if (nodes.length !== 3) return;
    this.itemButtons = nodes.map((el, index) => this.makeButton(`item${index}` as ButtonId, el));
    this.buttons.push(...this.itemButtons);
    this.dirty = true;
  }

  private setAuto(on: boolean) {
    this.auto = on;
    this.autoChip.classList.toggle('on', on);
    this.autoChip.textContent = on ? 'AUTO' : 'MANUAL';
  }

  private invalidate = () => { this.dirty = true; };
  private onContext = (event: Event) => event.preventDefault();

  private measure() {
    this.bindItemButtons();
    this.dirty = false;
    for (const button of this.buttons) {
      const rect = button.el.getBoundingClientRect();
      const center = clientToSurface(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const radius = Math.max(rect.width, rect.height) / 2 + 10;
      button.cx = center.x;
      button.cy = center.y;
      button.r2 = rect.width === 0 || rect.height === 0 ? 0 : radius * radius;
    }
  }

  private hitButton(x: number, y: number): Btn | null {
    if (this.dirty || this.itemButtons.length !== 3) this.measure();
    let nearest: Btn | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const button of this.buttons) {
      if (button.pointer >= 0 || button.r2 === 0) continue;
      const distance = (x - button.cx) ** 2 + (y - button.cy) ** 2;
      if (distance <= button.r2 && distance < nearestDistance) {
        nearest = button;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private claim(button: Btn, pointer: number) {
    button.pointer = pointer;
    button.tapped = true;
    button.el.classList.add('down');
  }

  private onDown = (event: PointerEvent) => {
    if (!this.mounted) return;
    const target = event.target as HTMLElement;
    if (target?.closest?.('.tc-chip')) return;
    this.bindItemButtons();
    const exactElement = target?.closest?.<HTMLElement>('[data-btn], .kr-item-slot[data-item-slot]');
    const exact = exactElement
      ? this.buttons.find((button) => button.el === exactElement && button.pointer < 0)
      : null;
    const point = clientToSurface(event.clientX, event.clientY);
    const button = exact ?? this.hitButton(point.x, point.y);
    if (button) {
      event.preventDefault();
      this.claim(button, event.pointerId);
    } else {
      this.free.add(event.pointerId);
    }
  };

  private onMove = (event: PointerEvent) => {
    if (!this.free.has(event.pointerId)) return;
    const point = clientToSurface(event.clientX, event.clientY);
    const button = this.hitButton(point.x, point.y);
    if (!button) return;
    event.preventDefault();
    this.free.delete(event.pointerId);
    this.claim(button, event.pointerId);
  };

  private onUp = (event: PointerEvent) => {
    this.free.delete(event.pointerId);
    for (const button of this.buttons) {
      if (button.pointer !== event.pointerId) continue;
      button.pointer = -1;
      button.el.classList.remove('down');
    }
  };

  update() {
    this.bindItemButtons();
    const pressed = (id: ButtonId) => {
      const button = this.buttons.find((candidate) => candidate.id === id);
      return !!button && (button.pointer >= 0 || button.tapped);
    };
    const left = pressed('left');
    const right = pressed('right');
    const itemSlot = this.itemButtons.findIndex((button) => button.pointer >= 0 || button.tapped);
    const state = this.state;
    state.steer = (right ? 1 : 0) - (left ? 1 : 0);
    state.steering = left || right;
    state.drift = pressed('drift');
    state.brake = pressed('brake') ? 1 : 0;
    const gas = pressed('gas');
    state.accel = this.auto ? (state.brake > 0 ? 0 : 1) : gas ? 1 : 0;
    state.accelHeld = gas;
    state.itemSlot = itemSlot;
    state.item = itemSlot >= 0;
    state.active = this.buttons.some((button) => button.pointer >= 0 || button.tapped);
    for (const button of this.buttons) button.tapped = false;
  }

  consumePause() {
    const value = this.state.pause;
    this.state.pause = false;
    return value;
  }
}

const MARKUP = `
<div class="tc-top">
  <div class="tc-chip tc-auto on">AUTO</div>
  <div class="tc-chip tc-pause" data-btn="pause">II</div>
</div>
<div class="tc-steer-cluster" aria-label="Steering">
  <div class="tc-btn tc-left" data-btn="left" aria-label="Steer left"><i></i></div>
  <div class="tc-btn tc-right" data-btn="right" aria-label="Steer right"><i></i></div>
</div>
<div class="tc-action-cluster">
  <div class="tc-btn tc-brake" data-btn="brake"><span>BRAKE</span></div>
  <div class="tc-btn tc-gas" data-btn="gas"><span>GAS</span></div>
  <div class="tc-btn tc-drift" data-btn="drift"><span>DRIFT</span></div>
</div>`;
