import type { Ctx, System } from '../types';
import { Race } from '../game/Race';
import { Items } from '../game/Items';
import { ConnectionOverlay } from './ConnectionOverlay';
import { LocalDirectSocket } from './LocalDirectSocket';
import { WaitingRoomOverlay } from './WaitingRoomOverlay';
import { RaceResultsOverlay } from './RaceResultsOverlay';
import { RacePredictor } from './RacePredictor';
import { RemoteInterpolation } from './RemoteInterpolation';
import {
  INPUT_HZ,
} from '../../shared/constants.js';
import type {
  DirectJoined, DirectPlayerRow, DirectRosterRow, DirectSnapshot, DrivePayload,
} from './protocol';
import { normalizeSnapshot } from './protocol';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

const SERVICE_ID = 'kart-royale';
const RESYNC_THROTTLE_MS = 500;
const RECONNECT_WARNING_DELAY_MS = 650;

export class DirectMultiplayer implements System {
  private usion: any = null;
  private ctx: Ctx | null = null;
  private overlay = new ConnectionOverlay();
  private lobby = new WaitingRoomOverlay(
    (ready) => this.sendLobbyReady(ready),
    () => this.sendLobbyStart(),
  );
  private results = new RaceResultsOverlay(
    () => this.sendRematch(),
    () => this.exitRoom(),
  );
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
  private itemSequence = 0;
  private pendingItem: {
    item_seq: number;
    item_revision: number;
    item_slot_revision: number;
    expected_kind: number;
    item_slot: number;
    backwards: boolean;
    client_sent_at: number;
    sentAt: number;
  } | null = null;
  private queuedItems: { slot: number; backwards: boolean }[] = [];
  private connectingRoom: string | null = null;
  private localMode = false;
  private language = 'en';
  private autoStartSolo = false;
  private reconnectWarningTimer: number | null = null;
  /** authoritative false -> true edge for immediate local finish feedback */
  private ownFinished = false;

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
          const launchMode = launch?.mode === 'multiplayer' ? 'multiplayer' : 'single';
          const roomId = config?.roomId || launch?.roomId || this.usion.config?.roomId;
          this.autoStartSolo = launchMode === 'single';
          // A solo launch may still receive an auto-created room id. Trust the
          // host's explicit mode: solo races start immediately with local bots,
          // then onRoomAssigned promotes that live session if the user shares.
          if (launchMode === 'multiplayer' && roomId) {
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

  takeSoloAutoStart() {
    const value = this.autoStartSolo;
    this.autoStartSolo = false;
    return value;
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
    if (
      this.connection === 'connected'
      && this.phase === 'playing'
      && !this.spectator
      && this.ownSlot !== null
    ) {
      this.predictor?.advance(performance.now(), drive);
    }
    if (input.itemPressed) {
      const own = this.latest.players.find((row) => row.slot === this.ownSlot);
      if (own) {
        const slot = this.resolveItemSlot(own, input.itemSlot);
        if (slot >= 0) {
          const backwards = input.brake > 0.5 || input.lookBack;
          if (this.pendingItem) {
            // Input deliberately re-offers one physical tap for ~110 ms while
            // the held-item fingerprint is unchanged. Do not turn those
            // frame-level retries into multiple authoritative uses (notably,
            // one tap must not drain all three mushrooms). A genuinely
            // different slot/direction may still be buffered behind the
            // in-flight request.
            const duplicate = (
              this.pendingItem.item_slot === slot && this.pendingItem.backwards === backwards
            ) || this.queuedItems.some((item) => (
              item.slot === slot && item.backwards === backwards
            ));
            if (!duplicate && this.queuedItems.length < 3) {
              this.queuedItems.push({ slot, backwards });
            }
          } else {
            this.queueItemUse(own, slot, backwards);
          }
        }
      }
    }
    if (this.pendingItem && this.connection === 'connected'
        && performance.now() - this.pendingItem.sentAt >= 250) {
      this.sendPendingItem();
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
    const own = this.ownSlot === null ? null : this.predictor?.view(dt)
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
    const authoritativeOwn = this.ownSlot === null ? null
      : this.latest.players.find((row) => row.slot === this.ownSlot) || null;
    if (authoritativeOwn?.finished && !this.ownFinished) {
      this.ownFinished = true;
      ctx.bus.emit({
        type: 'finish',
        kart: race.player,
        place: authoritativeOwn.place,
      });
    } else if (authoritativeOwn && !authoritativeOwn.finished) {
      this.ownFinished = false;
    }
  }

  dispose() {
    this.localSocket?.close();
    this.clearReconnectWarning();
    this.overlay.dispose();
    this.lobby.dispose();
    this.results.dispose();
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
      if (!this.active) return;
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
    const resumed = this.joined;
    this.active = true;
    this.joined = true;
    this.ownSlot = payload.slot;
    this.spectator = !!payload.spectator;
    this.lastSnapshotSequence = -1;
    this.interpolation?.clear();
    this.setRoster(payload.roster);
    if (payload.snapshot) this.handleSnapshot(payload.snapshot, true);
    if (resumed && this.ctx) {
      this.ctx.bus.emit({ type: 'camera-cut', kart: (this.ctx.race as Race).player });
    }
    this.sendHello();
    this.setConnection('connected');
  }

  private handleSnapshot(value: unknown, fromJoin = false) {
    const snapshot = normalizeSnapshot(value);
    if (!snapshot) return;
    const fresh = snapshot.s > this.lastSnapshotSequence;
    if (!fresh && !(snapshot.k && snapshot.s === this.lastSnapshotSequence)) return;
    if (fresh && this.lastSnapshotSequence >= 0 && snapshot.s > this.lastSnapshotSequence + 1) {
      this.requestSync();
    }
    if (fresh) this.lastSnapshotSequence = snapshot.s;
    const previousPhase = this.phase;
    this.latest = snapshot;
    const directItems = this.ctx?.items as Items | undefined;
    directItems?.setDirectMultiplayer(true);
    directItems?.applyDirectSnapshot(snapshot);
    this.phase = snapshot.phase;
    this.setRoster(snapshot.roster);
    const restarted = previousPhase === 'finished' && snapshot.phase === 'waiting';
    if (this.ownSlot !== null) {
      const own = snapshot.players.find((row) => row.slot === this.ownSlot);
      if (own) {
        if (restarted) {
          this.ownFinished = false;
          this.pendingItem = null;
          this.queuedItems.length = 0;
          this.interpolation?.clear();
        }
        this.itemSequence = Math.max(this.itemSequence, own.ack_item_seq || 0);
        if (this.pendingItem && own.ack_item_seq >= this.pendingItem.item_seq) {
          this.pendingItem = null;
          this.flushQueuedItem(own);
        }
        const ack = snapshot.ack?.[String(this.ownSlot)] ?? snapshot.ack?.[this.ownSlot] ?? -1;
        if (fromJoin || restarted) this.predictor?.reset(own);
        else this.predictor?.reconcile(own, ack);
      }
    }
    this.interpolation?.add(snapshot.players, snapshot.server_ts, this.ownSlot);
    if (snapshot.phase === 'waiting') {
      this.results.hide();
    } else {
      const own = snapshot.players.find((row) => row.slot === this.ownSlot);
      if (own?.finished || this.results.visible) {
        this.results.showLive(snapshot.players, this.roster, this.ownSlot, this.language);
      }
    }
    this.paintPhase();
  }

  private handleMatchEnd(payload: any) {
    this.phase = 'finished';
    this.lobby.hide();
    const hostLeft = payload?.reason === 'host_left';
    if (hostLeft) {
      this.active = false;
      this.joined = false;
      this.results.hide();
      this.localSocket?.close();
      if (!this.localMode) this.usion?.game?.disconnect?.();
      this.overlay.show(this.copy('Host left the room', 'Өрөөний эзэн гарлаа'), 'warning');
      return;
    }
    this.overlay.hide();
    this.results.showFinal(
      payload || {}, this.latest?.players || [], this.roster, this.ownSlot, this.language,
    );
  }

  private setRoster(value: unknown) {
    if (!Array.isArray(value)) return;
    if (value.every((row) => typeof row === 'string')) {
      this.roster = value.map((id, slot) => ({
        slot, user_id: id, name: id, connected: true, ready: false, is_host: slot === 0,
      }));
      this.paintPhase();
      return;
    }
    this.roster = value
      .filter((row) => Number.isInteger(row?.slot) && typeof row?.user_id === 'string')
      .slice(0, 4);
    this.paintPhase();
  }

  private sendDrive(payload: DrivePayload) {
    if (this.localSocket) this.localSocket.send('drive', payload);
    else this.usion?.game?.realtime('drive', payload);
  }

  private sendLobbyReady(ready: boolean) {
    if (this.phase !== 'waiting' || this.connection !== 'connected') return;
    if (this.localSocket) this.localSocket.send('lobby_ready', { ready });
    else this.usion?.game?.realtime('lobby_ready', { ready });
  }

  private sendLobbyStart() {
    if (this.phase !== 'waiting' || this.connection !== 'connected') return;
    if (this.localSocket) this.localSocket.send('lobby_start', {});
    else this.usion?.game?.realtime('lobby_start', {});
  }

  private sendRematch() {
    if (this.phase !== 'finished' || this.connection !== 'connected') return false;
    if (this.localSocket) this.localSocket.requestRematch();
    else this.usion?.game?.requestRematch?.();
    return true;
  }

  private exitRoom() {
    this.results.hide();
    this.lobby.hide();
    this.active = false;
    this.joined = false;
    if (this.localMode) {
      this.localSocket?.close();
      const target = new URL(location.href);
      for (const key of ['multiplayer', 'room', 'player']) target.searchParams.delete(key);
      location.assign(`${target.pathname}${target.search}`);
      return;
    }
    this.usion?.game?.leave?.();
    this.usion?.game?.disconnect?.();
    this.usion?.exit?.();
  }

  private resolveItemSlot(row: DirectPlayerRow, requested: number) {
    if (Number.isSafeInteger(requested) && requested >= 0 && requested < 3) {
      return row.item_slots[requested][0] > 0 ? requested : -1;
    }
    return row.item_slots.findIndex((item) => item[0] > 0 && item[1] > 0);
  }

  private queueItemUse(row: DirectPlayerRow, slot: number, backwards: boolean) {
    const item = row.item_slots[slot];
    if (!item || item[0] <= 0 || item[1] <= 0) return;
    this.pendingItem = {
      item_seq: ++this.itemSequence,
      item_revision: row.item_revision,
      item_slot_revision: row.item_slot_revisions[slot],
      expected_kind: item[0],
      item_slot: slot,
      backwards,
      client_sent_at: Date.now(),
      sentAt: 0,
    };
    this.sendPendingItem();
  }

  private flushQueuedItem(row: DirectPlayerRow) {
    while (!this.pendingItem && this.queuedItems.length) {
      const next = this.queuedItems.shift()!;
      const slot = this.resolveItemSlot(row, next.slot);
      if (slot >= 0) this.queueItemUse(row, slot, next.backwards);
    }
  }

  private sendPendingItem() {
    if (!this.pendingItem || this.connection !== 'connected') return;
    this.pendingItem.sentAt = performance.now();
    const { sentAt: _, ...payload } = this.pendingItem;
    if (this.localSocket) this.localSocket.send('use_item', payload);
    else this.usion?.game?.realtime('use_item', payload);
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
    if (state !== this.connection) this.predictor?.resetClock();
    if (state !== 'reconnecting') this.clearReconnectWarning();
    this.connection = state;
    this.results.setConnected(state === 'connected');
    if (state === 'connecting') {
      this.lobby.hide();
      this.overlay.show(this.copy('Connecting racers…', 'Тоглогчдыг холбож байна…'));
    } else if (state === 'reconnecting') {
      this.lobby.hide();
      this.overlay.hide();
      if (this.reconnectWarningTimer === null) {
        this.reconnectWarningTimer = window.setTimeout(() => {
          this.reconnectWarningTimer = null;
          if (this.connection === 'reconnecting') {
            this.overlay.show(this.copy('Reconnecting…', 'Дахин холбогдож байна…'), 'warning');
          }
        }, RECONNECT_WARNING_DELAY_MS);
      }
    } else if (state === 'error') {
      this.lobby.hide();
      this.overlay.show(this.copy('Connection failed', 'Холболт амжилтгүй'), 'error');
    } else if (state === 'connected') {
      this.paintPhase();
    }
  }

  private clearReconnectWarning() {
    if (this.reconnectWarningTimer !== null) {
      clearTimeout(this.reconnectWarningTimer);
      this.reconnectWarningTimer = null;
    }
  }

  private paintPhase() {
    if (!this.active || this.connection !== 'connected') return;
    if (this.phase === 'waiting') {
      this.results.hide();
      this.overlay.hide();
      this.lobby.show(this.roster, this.ownSlot, this.language);
      return;
    }
    this.lobby.hide();
    if (this.phase === 'countdown') {
      this.overlay.show(this.copy('Get ready', 'Бэлэн бай'));
    } else {
      this.overlay.hide();
    }
  }

  private copy(en: string, mn: string) {
    return this.language.toLowerCase().startsWith('mn') ? mn : en;
  }
}
