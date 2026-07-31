import {
  AUTO_START_MS, COUNTDOWN_MS, KEYFRAME_EVERY_NET_TICKS, LONE_PLAYER_END_MS,
  MAX_PLAYERS, MIN_PLAYERS, NET_EVERY_SIM_TICKS,
  RECONNECT_GRACE_MS, SESSION_SILENT_TIMEOUT_MS,
  SIM_DT_MS, SNAPSHOT_MAX_BYTES,
} from './config.js';
import {
  createPlayer, neutralInput, stepRace,
} from '../shared/race-sim.js';
import { serializeSnapshot } from './snapshot.js';
import { finishRoom } from './result.js';
import {
  createItemRuntime, stepItemRuntime,
} from './item-runtime.js';
import { handlePlayerInput } from './input.js';

const SWEEP_MS = 5000;

export class Room {
  constructor(roomId, { onDestroy }) {
    this.roomId = roomId;
    this.onDestroy = onDestroy;
    this.phase = 'waiting';
    this.players = [];
    this.connections = new Map();
    this.spectators = new Set();
    this.lastSessionId = null;
    this.snapSeq = 0;
    this.serverTick = 0;
    this.netTick = 0;
    this.countdownMs = 0;
    this.roundStartedAt = 0;
    this.firstFinishAt = 0;
    this.loneSince = 0;
    this.items = createItemRuntime();
    this.startTimer = null;
    this.tickTimer = null;
    this.lastTickAt = 0;
    this.destroyed = false;
    this.sweep = setInterval(() => this.sweepConnections(), SWEEP_MS);
    this.sweep.unref?.();
  }

  send(conn, type, payload) {
    if (conn.ws.readyState !== 1) return;
    try {
      conn.ws.send(JSON.stringify({ type, room_id: this.roomId, payload }));
    } catch {
      // The close callback owns cleanup.
    }
  }

  broadcast(type, payload) {
    const json = JSON.stringify({ type, room_id: this.roomId, payload });
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === 1) conn.ws.send(json);
    }
    for (const conn of this.spectators) {
      if (conn.ws.readyState === 1) conn.ws.send(json);
    }
  }

  roster() {
    return this.players.map((p) => ({
      slot: p.slot, user_id: p.userId, name: p.name, connected: p.connected,
    }));
  }

  snapshot({ keyframe = false, advance = false } = {}) {
    return serializeSnapshot(this, { keyframe, advance });
  }

  unicastKeyframe(conn) {
    const { json } = this.snapshot({ keyframe: true, advance: false });
    if (conn.ws.readyState === 1) conn.ws.send(json);
  }

  handleMessage(conn, message) {
    const payload = message?.payload || {};
    switch (message?.type) {
      case 'join':
        return this.join(conn);
      case 'input':
      case 'action':
        return this.input(conn, payload);
      case 'heartbeat':
        return this.send(conn, 'heartbeat', { t: Date.now() });
      case 'ping':
        this.send(conn, 'pong', { t: payload.t, server_ts: Date.now() });
        if (Number(payload.last_sequence) < this.snapSeq) this.unicastKeyframe(conn);
        return;
      case 'sync':
        return this.unicastKeyframe(conn);
      case 'leave':
        this.detach(conn, true);
        return;
      case 'set_state':
        return this.send(conn, 'error', {
          code: 'UNSUPPORTED', message: 'The kart server owns race state',
        });
      default:
        return this.send(conn, 'error', { code: 'BAD_MESSAGE', message: 'Unknown message type' });
    }
  }

  join(conn) {
    this.lastSessionId = conn.sessionId;
    const existing = this.players.find((p) => p.userId === conn.userId);
    if (existing) {
      const old = this.connections.get(conn.userId);
      if (old && old !== conn) old.ws.close();
      this.connections.set(conn.userId, conn);
      existing.connected = true;
      existing.disconnectedAt = 0;
      existing.input = neutralInput();
      existing.ackIseq = 0;
      this.sendJoined(conn, existing.slot, false);
      this.broadcast('player_joined', { roster: this.roster(), slot: existing.slot });
      return;
    }

    const occupiedSlots = new Set(this.players.map((player) => player.slot));
    const freeSlot = Array.from({ length: MAX_PLAYERS }, (_, slot) => slot)
      .find((slot) => !occupiedSlots.has(slot));
    const canRace = ['waiting', 'countdown'].includes(this.phase)
      && freeSlot !== undefined;
    if (canRace) {
      const player = createPlayer({
        slot: freeSlot, userId: conn.userId, name: conn.name,
      });
      this.players.push(player);
      this.connections.set(conn.userId, conn);
      this.sendJoined(conn, player.slot, false);
      this.broadcast('player_joined', { roster: this.roster(), slot: player.slot });
      this.armStart();
      if (this.players.length === MAX_PLAYERS) this.startCountdown();
      return;
    }

    conn.spectator = true;
    this.spectators.add(conn);
    this.sendJoined(conn, null, true);
  }

  sendJoined(conn, slot, spectator) {
    const { payload } = this.snapshot({ keyframe: true });
    this.send(conn, 'joined', {
      room_id: this.roomId, slot, spectator,
      roster: this.roster(), phase: this.phase, snapshot: payload,
    });
  }

  input(conn, envelope) {
    handlePlayerInput(this, conn, envelope);
  }

  armStart() {
    const connected = this.players.filter((p) => p.connected).length;
    if (this.phase !== 'waiting' || connected < MIN_PLAYERS || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.phase === 'waiting'
          && this.players.filter((p) => p.connected).length >= MIN_PLAYERS) {
        this.startCountdown();
      }
    }, AUTO_START_MS);
  }

  startCountdown() {
    if (this.phase !== 'waiting') return;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.phase = 'countdown';
    this.countdownMs = COUNTDOWN_MS;
    this.lastTickAt = performance.now();
    this.broadcast('phase', { phase: this.phase, countdown_ms: COUNTDOWN_MS });
    this.scheduleTick();
  }

  scheduleTick() {
    if (!['countdown', 'playing'].includes(this.phase) || this.destroyed) return;
    const elapsed = performance.now() - this.lastTickAt;
    this.tickTimer = setTimeout(() => this.tick(), Math.max(0, SIM_DT_MS - elapsed));
  }

  tick() {
    if (!['countdown', 'playing'].includes(this.phase) || this.destroyed) return;
    const now = performance.now();
    const dtMs = Math.min(SIM_DT_MS * 2, Math.max(0, now - this.lastTickAt));
    this.lastTickAt = now;
    this.serverTick += 1;
    if (this.phase === 'countdown') {
      this.countdownMs -= dtMs;
      if (this.countdownMs <= 0) {
        this.phase = 'playing';
        this.roundStartedAt = Date.now();
        this.broadcast('phase', { phase: this.phase });
      }
    } else {
      const before = new Set(this.players.filter((p) => p.finished).map((p) => p.slot));
      this.players = stepRace(this.players, dtMs / 1000);
      stepItemRuntime(this.items, this.players, dtMs / 1000);
      for (const player of this.players) {
        if (player.finished && !before.has(player.slot)) {
          player.finishMs = Date.now() - this.roundStartedAt;
          if (!this.firstFinishAt) this.firstFinishAt = Date.now();
        }
      }
      this.checkFinish();
    }
    if (this.serverTick % NET_EVERY_SIM_TICKS === 0) this.netTickFrame();
    this.scheduleTick();
  }

  netTickFrame() {
    this.netTick += 1;
    const keyframe = (this.netTick - 1) % KEYFRAME_EVERY_NET_TICKS === 0;
    const { json } = this.snapshot({ keyframe, advance: true });
    for (const conn of [...this.connections.values(), ...this.spectators]) {
      if (conn.ws.readyState === 1 && conn.ws.bufferedAmount < SNAPSHOT_MAX_BYTES * 8) {
        conn.ws.send(json);
      }
    }
  }

  checkFinish() {
    const connected = this.players.filter((p) => p.connected);
    if (connected.length <= 1) {
      if (!this.loneSince) this.loneSince = Date.now();
      if (Date.now() - this.loneSince >= LONE_PLAYER_END_MS) {
        return this.finish('opponents_left');
      }
    } else {
      this.loneSince = 0;
    }
    const allFinished = this.players.length > 0 && this.players.every((p) => p.finished);
    if (allFinished || (this.firstFinishAt && Date.now() - this.firstFinishAt >= 10_000)) {
      this.finish('race_complete');
    }
  }

  finish(reason) {
    finishRoom(this, reason);
  }

  detach(conn, close = false) {
    if (this.spectators.delete(conn)) return;
    if (this.connections.get(conn.userId) !== conn) return;
    this.connections.delete(conn.userId);
    const player = this.players.find((p) => p.userId === conn.userId);
    if (player) {
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.input = neutralInput();
      this.broadcast('player_left', { user_id: player.userId, slot: player.slot, roster: this.roster() });
    }
    if (close) conn.ws.close();
  }

  sweepConnections() {
    const now = Date.now();
    for (const conn of [...this.connections.values(), ...this.spectators]) {
      if (now - conn.lastSeenMs > SESSION_SILENT_TIMEOUT_MS) conn.ws.close();
    }
    if (this.phase === 'waiting') {
      this.players = this.players.filter((p) => p.connected || now - p.disconnectedAt < RECONNECT_GRACE_MS);
      this.armStart();
      if (this.connections.size === 0 && this.spectators.size === 0 && this.players.length === 0) {
        this.destroy();
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const timer of [this.startTimer, this.tickTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.sweep) clearInterval(this.sweep);
    for (const conn of [...this.connections.values(), ...this.spectators]) conn.ws.close();
    this.connections.clear();
    this.spectators.clear();
    this.onDestroy(this.roomId);
  }
}
