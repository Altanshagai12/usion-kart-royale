import { MAX_ITEM_ENTITIES } from '../../shared/constants.js';

const MAX_EFFECT_SECONDS = 60;

export interface DirectRosterRow {
  slot: number;
  user_id: string;
  name: string;
  connected?: boolean;
}

export interface DirectPlayerRow {
  slot: number;
  user_id: string;
  name: string;
  connected: boolean;
  distance: number;
  lateral: number;
  speed: number;
  heading: number;
  yaw_rate: number;
  rack: number;
  rack_velocity: number;
  drifting: boolean;
  drift_dir: number;
  drift_charge: number;
  item_kind: number;
  item_count: number;
  item_arm: number;
  item_slots: DirectItemSlot[];
  item_slot_revisions: [number, number, number];
  item_revision: number;
  ack_item_seq: number;
  boost_time: number;
  stun_time: number;
  star_time: number;
  shrink_time: number;
  lap: number;
  place: number;
  finished: boolean;
  finish_ms: number | null;
}

export type DirectItemSlot = [kind: number, count: number, arm: number];

export interface DirectItemEntity {
  id: number;
  kind: number;
  distance: number;
  lateral: number;
}

export interface DirectItemState {
  box_down: [number, number][];
  entities: DirectItemEntity[];
  events: DirectItemEvent[];
}

export interface DirectItemEvent {
  id: number;
  type: 'pickup' | 'use' | 'hit';
  slot: number;
  kind: number;
}

export interface DirectSnapshot {
  v: number;
  s: number;
  k?: boolean;
  server_ts: number;
  elapsed_ms: number;
  phase: 'waiting' | 'countdown' | 'playing' | 'finished';
  countdown_ms: number;
  roster: DirectRosterRow[];
  ack: Record<string, number>;
  items: DirectItemState;
  players: DirectPlayerRow[];
}

export interface DirectJoined {
  room_id: string;
  slot: number | null;
  spectator: boolean;
  roster: DirectRosterRow[];
  phase: DirectSnapshot['phase'];
  snapshot?: DirectSnapshot;
}

export interface DrivePayload {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  iseq: number;
  client_sent_at: number;
}

export function normalizeSnapshot(value: unknown): DirectSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as any;
  if (frame.v !== 1
      || !Number.isSafeInteger(frame.s)
      || !Number.isFinite(frame.server_ts)
      || !Number.isFinite(frame.elapsed_ms)
      || !['waiting', 'countdown', 'playing', 'finished'].includes(frame.phase)
      || !Array.isArray(frame.roster)
      || frame.roster.length > 4
      || !frame.roster.every((row: any) => (
        Number.isSafeInteger(row?.slot) && row.slot >= 0 && row.slot < 4
        && typeof row?.user_id === 'string' && typeof row?.name === 'string'
      ))
      || !frame.ack || typeof frame.ack !== 'object'
      || !Array.isArray(frame.players)
      || frame.players.length > 4) return null;

  const legacyItems = frame.items === undefined;
  const rawItems = legacyItems ? { box_down: [], entities: [], events: [] } : frame.items;
  if (!rawItems || !Array.isArray(rawItems.box_down) || rawItems.box_down.length > 64
      || !rawItems.box_down.every((row: unknown) => (
        Array.isArray(row) && row.length === 2
        && Number.isSafeInteger(row[0]) && row[0] >= 0 && row[0] < 64
        && Number.isFinite(row[1]) && row[1] >= 0 && row[1] <= 3
      ))
      || !Array.isArray(rawItems.entities) || rawItems.entities.length > MAX_ITEM_ENTITIES
      || !rawItems.entities.every((entity: any) => (
        Number.isSafeInteger(entity?.id)
        && [3, 4, 5, 8].includes(entity?.kind)
        && Number.isFinite(entity?.distance)
        && Number.isFinite(entity?.lateral)
      ))) return null;
  const events = rawItems.events ?? [];
  if (!Array.isArray(events) || events.length > 32 || !events.every((event: any) => (
    Number.isSafeInteger(event?.id)
    && ['pickup', 'use', 'hit'].includes(event?.type)
    && Number.isSafeInteger(event?.slot) && event.slot >= 0 && event.slot < 4
    && Number.isSafeInteger(event?.kind) && event.kind >= 1 && event.kind <= 8
  ))) return null;

  const players = frame.players.map((raw: any) => {
    const itemRevision = raw.item_revision ?? 0;
    const legacy: DirectItemSlot = [
      raw.item_kind ?? 0,
      raw.item_count ?? 0,
      raw.item_arm ?? 0,
    ];
    const itemSlots: DirectItemSlot[] = raw.item_slots
      ?? [legacy, [0, 0, 0], [0, 0, 0]];
    const first = Array.isArray(itemSlots)
      ? itemSlots.find((slot) => Array.isArray(slot) && slot[0] > 0) ?? [0, 0, 0]
      : [0, 0, 0];
    return {
      ...raw,
      item_kind: first[0],
      item_count: first[1],
      item_arm: first[2],
      item_slots: itemSlots,
      item_slot_revisions: raw.item_slot_revisions
        ?? [itemRevision, itemRevision, itemRevision],
      item_revision: itemRevision,
      ack_item_seq: raw.ack_item_seq ?? 0,
      boost_time: raw.boost_time ?? 0,
      stun_time: raw.stun_time ?? 0,
      star_time: raw.star_time ?? 0,
      shrink_time: raw.shrink_time ?? 0,
    };
  });
  if (!players.every((row: any) => (
    Number.isSafeInteger(row.slot) && row.slot >= 0 && row.slot < 4
    && typeof row.user_id === 'string'
    && Number.isFinite(row.distance) && Number.isFinite(row.lateral) && Number.isFinite(row.speed)
    && Number.isFinite(row.heading) && Number.isFinite(row.yaw_rate)
    && Number.isFinite(row.rack) && Number.isFinite(row.rack_velocity)
    && typeof row.drifting === 'boolean'
    && Number.isFinite(row.drift_dir) && Number.isFinite(row.drift_charge)
    && Number.isSafeInteger(row.item_kind) && row.item_kind >= 0 && row.item_kind <= 8
    && Number.isSafeInteger(row.item_count) && row.item_count >= 0 && row.item_count <= 3
    && Number.isFinite(row.item_arm) && row.item_arm >= 0 && row.item_arm <= 2
    && Array.isArray(row.item_slots) && row.item_slots.length === 3
    && row.item_slots.every((item: unknown) => (
      Array.isArray(item) && item.length === 3
      && Number.isSafeInteger(item[0]) && item[0] >= 0 && item[0] <= 8
      && Number.isSafeInteger(item[1]) && item[1] >= 0 && item[1] <= 3
      && Number.isFinite(item[2]) && item[2] >= 0 && item[2] <= 2
      && ((item[0] === 0 && item[1] === 0) || (item[0] > 0 && item[1] > 0))
    ))
    && Array.isArray(row.item_slot_revisions) && row.item_slot_revisions.length === 3
    && row.item_slot_revisions.every((revision: unknown) => (
      Number.isSafeInteger(revision) && (revision as number) >= 0
    ))
    && Number.isSafeInteger(row.item_revision) && row.item_revision >= 0
    && Number.isSafeInteger(row.ack_item_seq) && row.ack_item_seq >= 0
    && Number.isFinite(row.boost_time)
    && row.boost_time >= 0 && row.boost_time <= MAX_EFFECT_SECONDS
    && Number.isFinite(row.stun_time)
    && row.stun_time >= 0 && row.stun_time <= MAX_EFFECT_SECONDS
    && Number.isFinite(row.star_time)
    && row.star_time >= 0 && row.star_time <= MAX_EFFECT_SECONDS
    && Number.isFinite(row.shrink_time)
    && row.shrink_time >= 0 && row.shrink_time <= MAX_EFFECT_SECONDS
    && Number.isSafeInteger(row.lap) && row.lap >= 0
    && Number.isSafeInteger(row.place) && row.place >= 1 && row.place <= 4
    && typeof row.finished === 'boolean'
  ))) return null;

  return {
    ...frame,
    items: {
      box_down: rawItems.box_down,
      entities: rawItems.entities,
      events,
    },
    players,
  } as DirectSnapshot;
}

export function isSnapshot(value: unknown): value is DirectSnapshot {
  return normalizeSnapshot(value) !== null;
}
