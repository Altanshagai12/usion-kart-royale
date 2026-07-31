import type { Ctx, System } from '../types';
import { Race } from '../game/Race';
import { Items } from '../game/Items';
import { ConnectionOverlay } from './ConnectionOverlay';
import { LocalDirectSocket } from './LocalDirectSocket';
import { RacePredictor } from './RacePredictor';
import { RemoteInterpolation } from './RemoteInterpolation';
import {
  INPUT_HZ,
} from '../../shared/constants.js';
import type {
  DirectJoined, DirectPlayerRow, DirectRosterRow, DirectSnapshot, DrivePayload,
} from './protocol';
import { isSnapshot } from './protocol';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

const SERVICE_ID = 'kart-royale';
const RESYNC_THROTTLE_MS = 500;

export class DirectMultiplayer implements System {
  private usion: any = null;
  private ctx: Ctx | null = null;
  private overlay = new ConnectionOverlay();
  private localSocket: LocalDirectSocket | null = null;
  private predictor: RacePredictor | null = null;
  private interpolation: RemoteInterpolation | null = null;
  private roster: DirectRosterRow[] = [];
  private latest: DirectSnapshot | null = null;
  private ownSlot: number | null = null;
  private spectator = false;
  private active = false;
  private joined = false;
  private phase: DirectSnapshot['phase'] = 'waiting';
  private connection: ConnectionState = 'idle';
  private lastSnapshotSequence = -1;
  private lastResyncAt = 0;
  private sendAccumulator = 0;
  private connectingRoom: string | null = null;
  private localMode = false;
  private language = 'en';

  start(): Promise<void> {
    this.usion = (window as any).Usion;
    this.predictor = new RacePredictor(this.usion);
    this.interpolation = new RemoteInterpolation(this.usion);
    const query = new URLSearchParams(location.search);
    this.localMode = query.get('multiplayer') === '1' && window.parent === window;
    if (this.localMode) {
      const room = query.get('room') || 'local-room';
      const player = query.get('player') || `player-${Math.random().toString(36).slice(2, 6)}`;
      this.language = query.get('lang') || 'en';
      this.localSocket = new LocalDirectSocket(
        room,
        player,
        (type, payload) => this.handleWire(type, payload),
        (state) => this.setConnection(state),
      );
      this.setConnection('connecting');
      this.localSocket.start();
      return Promise.resolve();
    }

    const nativeHost = Boolean((window as any).ReactNativeWebView);
    if (window.parent === window && !nativeHost) return Promise.resolve();
    if (!this.usion?.init || !this.usion?.game) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Usion initialization timed out'));
      }, 15_000);
      try {
        this.usion.init((config: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.language = config?.language || this.usion.getLanguage?.() || 'en';
          this.registerPlatformHandlers();
          const launch = this.usion.getLaunchParams?.() || config || {};
          const roomId = config?.roomId || launch?.roomId || this.usion.config?.roomId;
          if (roomId) {
            void this.connectPlatformRoom(
              roomId,
              config?.serviceId || launch?.serviceId || this.usion.config?.serviceId,
            );
          }
          resolve();
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  init(ctx: Ctx) {
    this.ctx = ctx;
  }

  update(ctx: Ctx, dt: number) {
    this.ctx = ctx;
    if (!this.active || !this.joined || !this.latest) return;
    const race = ctx.race as Race;
    const displaySlot = this.ownSlot ?? this.roster[0]?.slot ?? 0;
    race.configureDirectReplica(
      displaySlot,
      this.roster.map((member) => member.slot),
      this.spectator,
    );
    (ctx.items as Items).setDirectMultiplayer(true);

    const input = ctx.input.state;
    const drive = {
      steer: this.connection === 'connected' && this.phase === 'playing' ? input.steer : 0,
      accel: this.connection === 'connected' && this.phase === 'playing' ? input.accel : 0,
      brake: this.connection === 'connected' && this.phase === 'playing' ? input.brake : 0,
      drift: this.connection === 'connected' && this.phase === 'playing' && input.drift,
    };
    if (this.phase === 'playing' && !this.spectator && this.ownSlot !== null) {
      this.predictor?.advance(performance.now(), drive);
    }
    this.sendAccumulator += dt;
    const sendEvery = 1 / INPUT_HZ;
    if (this.sendAccumulator >= sendEvery && !this.spectator && this.connection === 'connected') {
      this.sendAccumulator %= sendEvery;
      this.sendDrive({
        ...drive,
        iseq: this.predictor?.sequence() || 0,
        client_sent_at: Date.now(),
      });
    }

    const views = this.interpolation?.views(this.ownSlot) || new Map();
    const own = this.ownSlot === null ? null : this.predictor?.view()
      || this.latest.players.find((row) => row.slot === this.ownSlot)
      || null;
    if (own && this.ownSlot !== null) views.set(this.ownSlot, own);
    race.applyDirectViews(
      this.phase,
      this.latest.countdown_ms,
      this.roster,
      views,
      dt,
      this.latest.elapsed_ms,
    );
  }

  dispose() {
    this.localSocket?.close();
    this.overlay.dispose();
  }

  private registerPlatformHandlers() {
    const game = this.usion.game;
    game.onJoined((payload: DirectJoined) => this.handleJoined(payload));
    game.onPlayerJoined((payload: any) => this.setRoster(payload?.roster || payload?.player_ids));
    game.onPlayerLeft((payload: any) => this.setRoster(payload?.roster || payload?.player_ids));
    game.onRealtime((payload: unknown) => this.handleSnapshot(payload));
    game.onGameFinished((payload: any) => this.handleMatchEnd(payload));
    game.onRoomAssigned((payload?: { roomId?: string }) => {
      const roomId = payload?.roomId
        || this.usion.config?.roomId
        || this.usion.getLaunchParams?.()?.roomId;
      if (roomId) void this.connectPlatformRoom(roomId, this.usion.config?.serviceId);
    });
    game.onConnectionState((state: string) => {
      if (state === 'disconnected' || state === 'rejoining') this.setConnection('reconnecting');
      else if (state === 'connected' || state === 'reconnected') this.setConnection('connected');
    });
    game.onReconnected(() => {
      this.requestSync();
      this.sendHello();
    });
    game.onError((error: any) => {
      console.warn('[kart-net]', error?.code || 'UNKNOWN', error?.message || error);
      if (error?.source !== 'realtime') this.setConnection('error');
    });
  }

  private async connectPlatformRoom(roomId: string, serviceId?: string) {
    if (!roomId || this.connectingRoom === roomId) return;
    this.connectingRoom = roomId;
    this.active = true;
    this.setConnection('connecting');
    try {
      await this.usion.game.connectDirect({
        roomId,
        serviceId: serviceId || this.usion.config?.serviceId || SERVICE_ID,
      });
      this.setConnection('connected');
    } catch (err) {
      console.error('[kart-net] connectDirect failed', err);
      this.connectingRoom = null;
      this.setConnection('error');
    }
  }

  private handleWire(type: string, payload: any) {
    if (type === 'joined') this.handleJoined(payload);
    else if (type === 'player_joined' || type === 'player_left') this.setRoster(payload.roster);
    else if (type === 'state_snapshot' || type === 'state_delta') this.handleSnapshot(payload);
    else if (type === 'match_end') this.handleMatchEnd(payload);
    else if (type === 'error') {
      console.warn('[kart-net]', payload?.code, payload?.message);
      this.setConnection('error');
    }
  }

  private handleJoined(payload: DirectJoined) {
    this.active = true;
    this.joined = true;
    this.ownSlot = payload.slot;
    this.spectator = !!payload.spectator;
    this.lastSnapshotSequence = -1;
    this.interpolation?.clear();
    this.setRoster(payload.roster);
    if (payload.snapshot) this.handleSnapshot(payload.snapshot, true);
    this.sendHello();
    this.setConnection('connected');
  }

  private handleSnapshot(value: unknown, fromJoin = false) {
    if (!isSnapshot(value)) return;
    const snapshot = value;
    const fresh = snapshot.s > this.lastSnapshotSequence;
    if (!fresh && !(snapshot.k && snapshot.s === this.lastSnapshotSequence)) return;
    if (fresh && this.lastSnapshotSequence >= 0 && snapshot.s > this.lastSnapshotSequence + 1) {
      this.requestSync();
    }
    if (fresh) this.lastSnapshotSequence = snapshot.s;
    this.latest = snapshot;
    this.phase = snapshot.phase;
    this.setRoster(snapshot.roster);
    if (this.ownSlot !== null) {
      const own = snapshot.players.find((row) => row.slot === this.ownSlot);
      if (own) {
        const ack = snapshot.ack?.[String(this.ownSlot)] ?? snapshot.ack?.[this.ownSlot] ?? -1;
        if (fromJoin) this.predictor?.reset(own);
        else this.predictor?.reconcile(own, ack);
      }
    }
    this.interpolation?.add(snapshot.players, snapshot.server_ts, this.ownSlot);
    this.paintPhase();
  }

  private handleMatchEnd(_payload: unknown) {
    this.phase = 'finished';
    this.overlay.show(this.copy('Race finished', 'Тэмцээн дууслаа'), 'waiting');
  }

  private setRoster(value: unknown) {
    if (!Array.isArray(value)) return;
    if (value.every((row) => typeof row === 'string')) {
      this.roster = value.map((id, slot) => ({
        slot, user_id: id, name: id, connected: true,
      }));
      return;
    }
    this.roster = value
      .filter((row) => Number.isInteger(row?.slot) && typeof row?.user_id === 'string')
      .slice(0, 4);
  }

  private sendDrive(payload: DrivePayload) {
    if (this.localSocket) this.localSocket.send('drive', payload);
    else this.usion?.game?.realtime('drive', payload);
  }

  private sendHello() {
    const name = this.localMode
      ? new URLSearchParams(location.search).get('player')
      : this.usion?.user?.getName?.();
    if (!name) return;
    if (this.localSocket) this.localSocket.send('hello', { name: String(name).slice(0, 24) });
    else this.usion?.game?.realtime('hello', { name: String(name).slice(0, 24) });
  }

  private requestSync() {
    const now = performance.now();
    if (now - this.lastResyncAt < RESYNC_THROTTLE_MS) return;
    this.lastResyncAt = now;
    if (this.localSocket) this.localSocket.requestSync(this.lastSnapshotSequence);
    else this.usion?.game?.requestSync(Math.max(0, this.lastSnapshotSequence));
  }

  private setConnection(state: ConnectionState) {
    this.connection = state;
    if (state === 'connecting') {
      this.overlay.show(this.copy('Connecting racers…', 'Тоглогчдыг холбож байна…'));
    } else if (state === 'reconnecting') {
      this.overlay.show(this.copy('Reconnecting…', 'Дахин холбогдож байна…'), 'warning');
    } else if (state === 'error') {
      this.overlay.show(this.copy('Connection failed', 'Холболт амжилтгүй'), 'error');
    } else if (state === 'connected') {
      this.paintPhase();
    }
  }

  private paintPhase() {
    if (!this.active || this.connection !== 'connected') return;
    if (this.phase === 'waiting') {
      this.overlay.show(this.copy('Waiting for racers…', 'Тоглогч хүлээж байна…'));
    } else if (this.phase === 'countdown') {
      this.overlay.show(this.copy('Get ready', 'Бэлэн бай'));
    } else {
      this.overlay.hide();
    }
  }

  private copy(en: string, mn: string) {
    return this.language.toLowerCase().startsWith('mn') ? mn : en;
  }
}
