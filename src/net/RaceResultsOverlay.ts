import type { DirectPlayerRow, DirectRosterRow } from './protocol';

type Placement = { user_id?: string; place?: number; finish_ms?: number | null };
type ResultPayload = {
  placements?: Placement[];
  rematch_user_ids?: string[];
};

type Copy = {
  title: string;
  live: string;
  final: string;
  racing: string;
  dnf: string;
  rematch: string;
  rematchLater: string;
  waiting: string;
  reconnecting: string;
  exit: string;
};

const COPY: Record<'en' | 'mn', Copy> = {
  en: {
    title: 'Race results', live: 'Waiting for the other racers', final: 'Race complete',
    racing: 'Racing…', dnf: 'DNF', rematch: 'Race again',
    rematchLater: 'Available when the race ends', waiting: 'Waiting for racers…',
    reconnecting: 'Reconnecting…', exit: 'Exit',
  },
  mn: {
    title: 'Уралдааны дүн', live: 'Бусад тоглогчийг хүлээж байна', final: 'Уралдаан дууслаа',
    racing: 'Уралдаж байна…', dnf: 'Дуусгаагүй', rematch: 'Дахин уралдах',
    rematchLater: 'Уралдаан дуусмагц боломжтой', waiting: 'Тоглогчдыг хүлээж байна…',
    reconnecting: 'Дахин холбогдож байна…', exit: 'Гарах',
  },
};

type ResultRow = {
  userId: string;
  name: string;
  place: number;
  finishMs: number | null;
  finished: boolean;
};

export class RaceResultsOverlay {
  private root: HTMLDivElement;
  private title: HTMLHeadingElement;
  private status: HTMLParagraphElement;
  private rows: HTMLDivElement;
  private rematch: HTMLButtonElement;
  private exit: HTMLButtonElement;
  private copy = COPY.en;
  private ownUserId: string | null = null;
  private final = false;
  private voted = false;
  private connected = false;

  constructor(onRematch: () => boolean, onExit: () => void) {
    this.installStyle();
    this.root = document.createElement('div');
    this.root.className = 'kr-results';
    this.root.hidden = true;
    this.root.innerHTML = `
      <section class="kr-results-card" role="dialog" aria-modal="true" aria-labelledby="kr-results-title">
        <header><div><h2 id="kr-results-title"></h2><p></p></div><span>🏁</span></header>
        <div class="kr-results-rows"></div>
        <footer><button class="kr-results-rematch" type="button"></button>
          <button class="kr-results-exit" type="button"></button></footer>
      </section>`;
    this.title = this.root.querySelector('h2')!;
    this.status = this.root.querySelector('p')!;
    this.rows = this.root.querySelector('.kr-results-rows')!;
    this.rematch = this.root.querySelector('.kr-results-rematch')!;
    this.exit = this.root.querySelector('.kr-results-exit')!;
    this.rematch.addEventListener('click', () => {
      if (this.rematch.disabled) return;
      if (onRematch()) {
        this.voted = true;
        this.paintActions();
      }
    });
    this.exit.addEventListener('click', onExit);
    document.body.appendChild(this.root);
  }

  get visible() { return !this.root.hidden; }

  setConnected(connected: boolean) {
    this.connected = connected;
    if (this.visible) this.paintActions();
  }

  showLive(
    players: readonly DirectPlayerRow[], roster: readonly DirectRosterRow[],
    ownSlot: number | null, language: string,
  ) {
    this.prepare(roster, ownSlot, language);
    this.final = false;
    this.voted = false;
    const rows = roster.map((member) => {
      const player = players.find((candidate) => candidate.slot === member.slot);
      return {
        userId: member.user_id,
        name: member.name || member.user_id,
        place: player?.place ?? member.slot + 1,
        finishMs: player?.finish_ms ?? null,
        finished: player?.finished === true,
      };
    });
    this.paint(rows);
  }

  showFinal(
    payload: ResultPayload, players: readonly DirectPlayerRow[],
    roster: readonly DirectRosterRow[], ownSlot: number | null, language: string,
  ) {
    this.prepare(roster, ownSlot, language);
    this.final = true;
    const votes = Array.isArray(payload.rematch_user_ids) ? payload.rematch_user_ids : [];
    this.voted = this.ownUserId !== null && votes.includes(this.ownUserId);
    const placements = Array.isArray(payload.placements) ? payload.placements : [];
    const rows = roster.map((member) => {
      const placement = placements.find((candidate) => candidate.user_id === member.user_id);
      const player = players.find((candidate) => candidate.slot === member.slot);
      const finishMs = Number.isFinite(placement?.finish_ms)
        ? Number(placement?.finish_ms) : Number.isFinite(player?.finish_ms) ? player!.finish_ms : null;
      return {
        userId: member.user_id,
        name: member.name || member.user_id,
        place: Number.isSafeInteger(placement?.place)
          ? Number(placement?.place) : player?.place ?? member.slot + 1,
        finishMs,
        finished: finishMs !== null || player?.finished === true,
      };
    });
    this.paint(rows);
  }

  hide() { this.root.hidden = true; }
  dispose() { this.root.remove(); }

  private prepare(roster: readonly DirectRosterRow[], ownSlot: number | null, language: string) {
    this.copy = language.toLowerCase().startsWith('mn') ? COPY.mn : COPY.en;
    this.ownUserId = roster.find((member) => member.slot === ownSlot)?.user_id ?? null;
  }

  private paint(rows: ResultRow[]) {
    this.title.textContent = this.copy.title;
    this.status.textContent = this.final ? this.copy.final : this.copy.live;
    this.rows.textContent = '';
    rows.sort((a, b) => a.place - b.place || a.name.localeCompare(b.name));
    for (const result of rows) {
      const row = document.createElement('div');
      row.className = 'kr-results-row';
      row.dataset.own = String(result.userId === this.ownUserId);
      const place = document.createElement('strong');
      place.textContent = String(result.place);
      const name = document.createElement('b');
      name.textContent = result.name;
      const time = document.createElement('span');
      time.textContent = result.finishMs !== null
        ? this.formatTime(result.finishMs) : this.final ? this.copy.dnf : this.copy.racing;
      row.append(place, name, time);
      this.rows.appendChild(row);
    }
    this.paintActions();
    this.root.hidden = false;
  }

  private paintActions() {
    this.rematch.disabled = !this.final || this.ownUserId === null || this.voted || !this.connected;
    this.rematch.textContent = !this.connected
      ? this.copy.reconnecting
      : !this.final ? this.copy.rematchLater : this.voted ? this.copy.waiting : this.copy.rematch;
    this.exit.textContent = this.copy.exit;
  }

  private formatTime(ms: number) {
    const safe = Math.max(0, Math.round(ms));
    const minutes = Math.floor(safe / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1000);
    const millis = safe % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  private installStyle() {
    if (document.getElementById('kr-results-style')) return;
    const style = document.createElement('style');
    style.id = 'kr-results-style';
    style.textContent = `
      .kr-results{position:fixed;inset:0;z-index:52;display:grid;place-items:center;padding:4vmin;
        pointer-events:auto;background:rgba(3,7,16,.62);backdrop-filter:blur(7px);
        font:700 clamp(11px,2.1vmin,17px)/1.2 system-ui,sans-serif;color:#f6f8ff}
      .kr-results[hidden]{display:none}.kr-results-card{width:min(74vmin,590px);max-height:92vh;
        padding:3vmin;border:1px solid rgba(255,255,255,.25);border-radius:2.8vmin;
        background:rgba(9,16,31,.95);box-shadow:0 3vmin 9vmin rgba(0,0,0,.5)}
      .kr-results header{display:flex;align-items:center;justify-content:space-between}.kr-results h2{margin:0;
        font-size:clamp(20px,4.2vmin,32px)}.kr-results header p{margin:.7vmin 0 1.8vmin;color:#9eb0cf}
      .kr-results header>span{font-size:clamp(24px,6vmin,46px)}.kr-results-rows{display:grid;gap:.65vmin}
      .kr-results-row{display:grid;grid-template-columns:3.3vmin minmax(0,1fr) auto;align-items:center;
        gap:1.3vmin;padding:1.1vmin 1.4vmin;border-radius:1.3vmin;background:rgba(255,255,255,.07)}
      .kr-results-row[data-own=true]{background:rgba(242,189,86,.18);outline:1px solid rgba(242,189,86,.5)}
      .kr-results-row strong{color:#f2bd56}.kr-results-row b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .kr-results-row span{color:#bde9ff;font-variant-numeric:tabular-nums}.kr-results footer{display:grid;
        grid-template-columns:1fr auto;gap:1.1vmin;margin-top:2vmin}.kr-results button{min-height:7.5vmin;
        padding:1.2vmin 2.3vmin;border:0;border-radius:1.5vmin;font:900 inherit;cursor:pointer}
      .kr-results-rematch{background:#f2bd56;color:#17130b}.kr-results-exit{background:rgba(255,255,255,.12);color:#fff}
      .kr-results button:disabled{cursor:default;color:rgba(242,246,255,.56);background:rgba(255,255,255,.1)}
      @media (max-height:430px){.kr-results-card{width:min(82vw,680px);padding:2.3vmin}.kr-results-row{padding:.8vmin 1.3vmin}
        .kr-results button{min-height:6.5vmin}.kr-results header>span{font-size:4.5vmin}}
    `;
    document.head.appendChild(style);
  }
}
