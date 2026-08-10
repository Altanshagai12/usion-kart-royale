type MessageHandler = (type: string, payload: any) => void;
type StatusHandler = (state: 'connected' | 'reconnecting' | 'error') => void;

const HEARTBEAT_MS = 25_000;

export class LocalDirectSocket {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private reconnectAttempt = 0;
  private heartbeat: number | null = null;
  private closed = false;

  constructor(
    private readonly roomId: string,
    private readonly playerId: string,
    private readonly onMessage: MessageHandler,
    private readonly onStatus: StatusHandler,
  ) {}

  start() {
    this.open();
  }

  send(actionType: string, data: object) {
    this.envelope('input', { action_type: actionType, action_data: data });
  }

  requestSync(lastSequence: number) {
    this.envelope('ping', { last_sequence: Math.max(0, lastSequence) });
  }

  requestRematch() {
    this.envelope('rematch', {});
  }

  close() {
    this.closed = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.socket?.close();
  }

  private open() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const safePlayer = this.playerId.replace(/[^\w-]/g, '-').slice(0, 24) || 'player';
    const safeRoom = this.roomId.replace(/[^\w-]/g, '-').slice(0, 64) || 'local-room';
    const token = encodeURIComponent(`dev:${safePlayer}:${safeRoom}`);
    this.socket = new WebSocket(`${scheme}//${location.host}/ws?token=${token}`);
    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.sequence = 0;
      this.envelope('join', {});
      this.envelope('input', {
        action_type: 'hello',
        action_data: { name: this.playerId.slice(0, 24) },
      });
      if (this.heartbeat !== null) clearInterval(this.heartbeat);
      this.heartbeat = window.setInterval(() => this.envelope('heartbeat', {}), HEARTBEAT_MS);
      this.onStatus('connected');
    };
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type) this.onMessage(message.type, message.payload || {});
      } catch {
        // Invalid server frames are ignored; the next keyframe restores state.
      }
    };
    this.socket.onclose = () => {
      if (this.heartbeat !== null) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.closed) return;
      this.onStatus('reconnecting');
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, 15_000);
      window.setTimeout(() => this.open(), delay);
    };
    this.socket.onerror = () => this.onStatus('error');
  }

  private envelope(type: string, payload: object) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.sequence += 1;
    this.socket.send(JSON.stringify({
      type,
      room_id: this.roomId,
      ts: Date.now(),
      seq: this.sequence,
      session_id: null,
      protocol_version: '2',
      payload,
    }));
  }
}
