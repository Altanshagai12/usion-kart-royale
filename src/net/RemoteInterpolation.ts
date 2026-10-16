import type { DirectPlayerRow } from './protocol';

export class RemoteInterpolation {
  private core: any = null;
  private latest = new Map<number, DirectPlayerRow>();
  private output = new Map<number, DirectPlayerRow>();
  private rendered = new Map<number, DirectPlayerRow>();

  constructor(usion: any) {
    const create = usion?.game?.createInterpolation;
    if (typeof create === 'function') {
      this.core = create({
        serverFps: 20,
        adaptive: true,
        minBufferMs: 60,
        maxBufferMs: 200,
        extrapolationMs: 100,
        serverTime: true,
      });
    }
  }

  add(rows: DirectPlayerRow[], serverTime: number, ownSlot: number | null) {
    this.latest.clear();
    for (const row of rows) this.latest.set(row.slot, row);
    if (!this.core) return;
    this.core.add({
      time: serverTime,
      state: rows
        .filter((row) => row.slot !== ownSlot)
        .map((row) => ({
          id: row.slot,
          distance: row.distance,
          lateral: row.lateral,
          speed: row.speed,
          heading: row.heading,
          rack: row.rack,
        })),
    });
  }

  views(ownSlot: number | null) {
    const out = this.output;
    out.clear();
    if (this.core) {
      const rows = this.core.calc('distance lateral speed heading rack') || [];
      for (const interpolated of rows) {
        const latest = this.latest.get(Number(interpolated.id));
        if (!latest) continue;
        let row = this.rendered.get(latest.slot);
        if (!row) {
          row = { ...latest };
          this.rendered.set(latest.slot, row);
        }
        Object.assign(row, latest, interpolated);
        out.set(latest.slot, row);
      }
    }
    for (const [slot, latest] of this.latest) {
      if (slot === ownSlot || out.has(slot)) continue;
      out.set(slot, latest);
    }
    return out;
  }

  clear() {
    this.core?.vault?.clear?.();
    this.latest.clear();
    this.output.clear();
    this.rendered.clear();
  }

  bufferMs() {
    return this.core?.getBufferMs?.() || 0;
  }
}
