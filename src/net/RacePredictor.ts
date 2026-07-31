import {
  DESYNC_SNAP_METERS, SIM_DT_MS,
} from '../../shared/constants.js';
import { stepPlayer } from '../../shared/race-sim.js';
import type { DirectPlayerRow } from './protocol';

const MAX_CATCHUP_MS = 250;

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
          rate: 0.22,
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
  }

  advance(now: number, input: object) {
    if (!this.initialized || !this.core) return 0;
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

  view(): DirectPlayerRow | null {
    if (!this.initialized || !this.core) return null;
    const row = this.core.view();
    return {
      ...row,
      yaw_rate: row.yawRate ?? row.yaw_rate,
      rack_velocity: row.rackVelocity ?? row.rack_velocity,
      drift_dir: row.driftDir ?? row.drift_dir,
      drift_charge: row.driftCharge ?? row.drift_charge,
    } as DirectPlayerRow;
  }

  sequence() {
    return this.core?.lastSeq || 0;
  }

  resetClock() {
    this.lastAdvanceAt = 0;
    this.accumulator = 0;
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
