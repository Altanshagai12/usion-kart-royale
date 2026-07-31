export type NetworkTone = 'hidden' | 'waiting' | 'warning' | 'error';

export class ConnectionOverlay {
  private element: HTMLElement | null = null;

  show(message: string, tone: NetworkTone = 'waiting') {
    const el = this.ensure();
    el.textContent = message;
    el.dataset.tone = tone;
    el.hidden = tone === 'hidden';
  }

  hide() {
    if (this.element) this.element.hidden = true;
  }

  dispose() {
    this.element?.remove();
    this.element = null;
  }

  private ensure() {
    if (this.element) return this.element;
    const style = document.createElement('style');
    style.textContent = `
      .kr-network {
        position: fixed;
        z-index: 45;
        top: calc(env(safe-area-inset-top, 0px) + 1.8vmin);
        left: 50%;
        transform: translateX(-50%);
        max-width: min(84vw, 520px);
        padding: 1.1vmin 2.2vmin;
        border: 1px solid rgba(255,255,255,.28);
        border-radius: 999px;
        color: #f5f8ff;
        background: rgba(7,12,24,.76);
        box-shadow: 0 6px 24px rgba(0,0,0,.34);
        backdrop-filter: blur(9px);
        pointer-events: none;
        text-align: center;
        font: 800 clamp(11px, 2.2vmin, 16px)/1.2 system-ui, sans-serif;
        letter-spacing: .055em;
      }
      .kr-network[data-tone="warning"] {
        color: #211400;
        background: rgba(255,196,75,.92);
        border-color: rgba(255,239,180,.95);
      }
      .kr-network[data-tone="error"] {
        color: #fff;
        background: rgba(157,31,50,.94);
        border-color: rgba(255,170,183,.9);
      }
      @media (orientation: portrait) {
        .kr-network { top: auto; bottom: 8vmin; }
      }
    `;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'kr-network';
    el.dataset.tone = 'waiting';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    this.element = el;
    return el;
  }
}
