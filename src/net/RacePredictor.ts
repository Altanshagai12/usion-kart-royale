import {
  DESYNC_SNAP_METERS, SIM_DT_MS,
} from '../../shared/constants.js';
import { stepPlayer } from '../../shared/race-sim.js';
import type { DirectPlayerRow } from './protocol';

const MAX_CATCHUP_MS = 250;
const VIEW_SMOOTH_RATE_60HZ = 0.22;

type PredictorCore = {
  state: any;
  lastSeq: number;
  reset(state: any): void;
  predict(input: any): any;
  reconcile(state: any, ack: number): any;
  view(rate?: number): any;
};

export class RacePredictor {
  private core: PredictorCore | null = null;
  private lastAdvanceAt = 0;
  private accumulator = 0;
  private initialized = false;
  private correction = 0;
  /** Latest local command, used only to project the render pose through the
   * fixed-step accumulator remainder. The authoritative/predicted state still
   * advances exclusively in SIM_DT_MS ticks. */
  private renderInput: object = {};

  constructor(private readonly usion: any) {
    const create = usion?.game?.createPredictor;
    if (typeof create === 'function') {
      this.core = create({
        apply: (state: any, input: any) => ({
          ...state,
          ...stepPlayer(state, input, input.dt),
        }),
        smooth: {
          keys: 'distance lateral heading',
          rate: VIEW_SMOOTH_RATE_60HZ,
          snapTo: 0.001,
        },
      });
    }
  }

  reset(row: DirectPlayerRow) {
    const state = this.stateFrom(row);
    if (this.core) this.core.reset(state);
    else this.core = this.fallbackCore(state);
    this.initialized = true;
    this.lastAdvanceAt = 0;
    this.accumulator = 0;
    this.renderInput = {};
  }

  advance(now: number, input: object) {
    if (!this.initialized || !this.core) return 0;
    this.renderInput = input;
    if (this.lastAdvanceAt === 0) this.lastAdvanceAt = now;
    this.accumulator = Math.min(
      MAX_CATCHUP_MS,
      this.accumulator + now - this.lastAdvanceAt,
    );
    this.lastAdvanceAt = now;
    while (this.accumulator >= SIM_DT_MS) {
      this.accumulator -= SIM_DT_MS;
      this.core.predict({ ...input, dt: SIM_DT_MS / 1000 });
    }
    return this.core.lastSeq;
  }

  reconcile(row: DirectPlayerRow, ack: number) {
    if (!this.initialized || !this.core) {
      this.reset(row);
      return;
    }
    const before = this.core.state;
    const after = this.core.reconcile(this.stateFrom(row), ack);
    if (!before || !after) return;
    this.correction = Math.hypot(
      before.distance - after.distance,
      before.lateral - after.lateral,
    );
    if (this.correction > DESYNC_SNAP_METERS) this.core.view(1);
  }

  view(dt = 1 / 60): DirectPlayerRow | null {
    if (!this.initialized || !this.core) return null;
    // Usion's view rate is a fraction consumed per call, so passing the same
    // fraction at 144 Hz made reconciliation land 2.4x faster than at 60 Hz.
    // Convert the authored 60 Hz fraction to an equivalent wall-clock rate.
    const frameSeconds = Math.max(0, Math.min(0.1, dt));
    const viewRate = 1 - Math.pow(1 - VIEW_SMOOTH_RATE_60HZ, frameSeconds * 60);
    let row = this.core.view(viewRate);
    // The server and predictor tick at 60 Hz, while a desktop display commonly
    // presents at 120/144 Hz. Returning the last completed simulation tick made
    // those extra presents repeat the same pose and then jump to the next one;
    // mobile's 60 Hz cadence hid the fault. Project only the unsimulated wall-
    // clock remainder for display, keeping reconciliation and input sequencing
    // on the unchanged fixed-step state.
    if (this.accumulator > 0.001 && !row.finished) {
      row = stepPlayer(row, this.renderInput, this.accumulator / 1000);
    }
    return {
      ...row,
      yaw_rate: row.yawRate ?? row.yaw_rate,
      rack_velocity: row.rackVelocity ?? row.rack_velocity,
      drift_dir: row.driftDir ?? row.drift_dir,
      drift_charge: row.driftCharge ?? row.drift_charge,
      boost_time: row.boostTime ?? row.boost_time,
      stun_time: row.stunTime ?? row.stun_time,
      star_time: row.starTime ?? row.star_time,
      shrink_time: row.shrinkTime ?? row.shrink_time,
      item_arm: row.itemArm ?? row.item_arm,
    } as DirectPlayerRow;
  }

  sequence() {
    return this.core?.lastSeq || 0;
  }

  resetClock() {
    this.lastAdvanceAt = 0;
    this.accumulator = 0;
    this.renderInput = {};
  }

  lastCorrection() {
    return this.correction;
  }

  private stateFrom(row: DirectPlayerRow) {
    return {
      ...row,
      yawRate: row.yaw_rate,
      rackVelocity: row.rack_velocity,
      driftDir: row.drift_dir,
      driftCharge: row.drift_charge,
      boostTime: row.boost_time,
      stunTime: row.stun_time,
      starTime: row.star_time,
      shrinkTime: row.shrink_time,
      itemArm: row.item_arm,
      input: {
        steer: 0, accel: 0, brake: 0, drift: false, iseq: 0,
      },
    };
  }

  private fallbackCore(initial: any): PredictorCore {
    let state = initial;
    let lastSeq = 0;
    return {
      get state() { return state; },
      get lastSeq() { return lastSeq; },
      reset(next) { state = next; lastSeq = 0; },
      predict(input) {
        lastSeq += 1;
        state = { ...state, ...stepPlayer(state, input, input.dt) };
        return state;
      },
      reconcile(next) { state = next; return state; },
      view() { return state; },
    };
  }
}
