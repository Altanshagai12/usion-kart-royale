import type { DirectRosterRow } from './protocol';

type LobbyCopy = {
  title: string;
  hint: string;
  host: string;
  ready: string;
  notReady: string;
  start: string;
  waiting: string;
  waitingReady: string;
};

const COPY: Record<'en' | 'mn', LobbyCopy> = {
  en: {
    title: 'Waiting room',
    hint: 'Invite friends with Usion Share',
    host: 'Host',
    ready: 'Ready',
    notReady: 'Not ready',
    start: 'Start race',
    waiting: 'Waiting for another racer',
    waitingReady: 'Waiting for racers to get ready',
  },
  mn: {
    title: 'Хүлээлгийн өрөө',
    hint: 'Usion Share-аар найзуудаа урина уу',
    host: 'Host',
    ready: 'Бэлэн',
    notReady: 'Бэлэн биш',
    start: 'Уралдааныг эхлүүлэх',
    waiting: 'Өөр тоглогч хүлээж байна',
    waitingReady: 'Тоглогчид бэлэн болохыг хүлээж байна',
  },
};

export class WaitingRoomOverlay {
  private root: HTMLDivElement;
  private title: HTMLHeadingElement;
  private count: HTMLSpanElement;
  private hint: HTMLParagraphElement;
  private roster: HTMLDivElement;
  private action: HTMLButtonElement;
  private copy = COPY.en;
  private ownReady = false;
  private isHost = false;

  constructor(
    private readonly onReady: (ready: boolean) => void,
    private readonly onStart: () => void,
  ) {
    this.installStyle();
    this.root = document.createElement('div');
    this.root.className = 'kr-lobby';
    this.root.hidden = true;
    this.root.innerHTML = `
      <section class="kr-lobby-card" role="dialog" aria-modal="false">
        <header><h2></h2><span></span></header>
        <p class="kr-lobby-hint"></p>
        <div class="kr-lobby-roster"></div>
        <button class="kr-lobby-action" type="button"></button>
      </section>`;
    this.title = this.root.querySelector('h2')!;
    this.count = this.root.querySelector('header span')!;
    this.hint = this.root.querySelector('.kr-lobby-hint')!;
    this.roster = this.root.querySelector('.kr-lobby-roster')!;
    this.action = this.root.querySelector('.kr-lobby-action')!;
    this.action.addEventListener('click', () => {
      if (this.action.disabled) return;
      if (this.isHost) this.onStart();
      else this.onReady(!this.ownReady);
    });
    document.body.appendChild(this.root);
  }

  show(roster: readonly DirectRosterRow[], ownSlot: number | null, language: string) {
    this.copy = language.toLowerCase().startsWith('mn') ? COPY.mn : COPY.en;
    const connected = roster.filter((member) => member.connected !== false);
    const own = roster.find((member) => member.slot === ownSlot);
    this.isHost = own?.is_host === undefined ? ownSlot === 0 : own.is_host;
    this.ownReady = own?.ready === true;

    this.title.textContent = this.copy.title;
    this.count.textContent = `${connected.length}/4`;
    this.hint.textContent = this.copy.hint;
    this.roster.textContent = '';
    for (const member of roster) {
      const row = document.createElement('div');
      row.className = 'kr-lobby-player';
      row.dataset.connected = String(member.connected !== false);
      const name = document.createElement('b');
      name.textContent = member.name || member.user_id;
      const state = document.createElement('span');
      const host = member.is_host === undefined ? member.slot === 0 : member.is_host;
      state.textContent = host ? this.copy.host : member.ready ? this.copy.ready : this.copy.notReady;
      state.dataset.ready = String(host || member.ready === true);
      row.append(name, state);
      this.roster.appendChild(row);
    }

    if (this.isHost) {
      const guestsReady = connected.length >= 2
        && connected.every((member) => member.slot === ownSlot || member.ready === true);
      this.action.disabled = !guestsReady;
      this.action.textContent = connected.length < 2
        ? this.copy.waiting
        : guestsReady ? this.copy.start : this.copy.waitingReady;
    } else {
      this.action.disabled = false;
      this.action.textContent = this.ownReady ? this.copy.notReady : this.copy.ready;
      this.action.dataset.ready = String(this.ownReady);
    }
    this.root.hidden = false;
  }

  hide() { this.root.hidden = true; }
  dispose() { this.root.remove(); }

  private installStyle() {
    if (document.getElementById('kr-lobby-style')) return;
    const style = document.createElement('style');
    style.id = 'kr-lobby-style';
    style.textContent = `
      .kr-lobby{position:fixed;inset:0;z-index:46;display:grid;place-items:center;
        padding:5vmin;pointer-events:auto;background:rgba(4,8,18,.48);backdrop-filter:blur(5px);
        font:700 clamp(11px,2.15vmin,17px)/1.2 system-ui,sans-serif;color:#f6f8ff}
      .kr-lobby[hidden]{display:none}.kr-lobby-card{width:min(72vmin,560px);padding:3.2vmin;
        border:1px solid rgba(255,255,255,.24);border-radius:3vmin;background:rgba(9,16,31,.92);
        box-shadow:0 2.5vmin 7vmin rgba(0,0,0,.46)}.kr-lobby header{display:flex;align-items:center;
        justify-content:space-between}.kr-lobby h2{font-size:clamp(18px,4vmin,30px);letter-spacing:.02em}
      .kr-lobby header span{padding:.7vmin 1.3vmin;border-radius:99px;background:rgba(255,255,255,.12)}
      .kr-lobby-hint{margin:1vmin 0 2.2vmin;color:rgba(230,238,255,.68);font-weight:600}
      .kr-lobby-roster{display:grid;gap:.8vmin}.kr-lobby-player{display:flex;justify-content:space-between;
        padding:1.2vmin 1.5vmin;border-radius:1.4vmin;background:rgba(255,255,255,.07)}
      .kr-lobby-player[data-connected=false]{opacity:.48}.kr-lobby-player span{color:#ffbd7c}
      .kr-lobby-player span[data-ready=true]{color:#79e3a4}.kr-lobby-action{width:100%;min-height:8vmin;
        margin-top:2.3vmin;padding:1.3vmin 2vmin;border:0;border-radius:1.8vmin;background:#f2bd56;
        color:#17130b;font:900 inherit;cursor:pointer}.kr-lobby-action[data-ready=true]{background:#89d9ff}
      .kr-lobby-action:disabled{cursor:default;color:rgba(242,246,255,.58);background:rgba(255,255,255,.12)}
    `;
    document.head.appendChild(style);
  }
}
