import { randomBytes } from 'node:crypto';
import { MAX_ITEM_ENTITIES, TRACK_LENGTH } from '../shared/constants.js';
import {
  ITEM_ARM_TIME, ITEM_BOX_PICKUP_RADIUS, ITEM_BOX_RESPAWN,
  createItemBoxLayout,
} from '../shared/item-layout.js';

export const ITEM_KIND = Object.freeze({
  NONE: 0,
  MUSHROOM: 1,
  TRIPLE_MUSHROOM: 2,
  GREEN_SHELL: 3,
  RED_SHELL: 4,
  BANANA: 5,
  STAR: 6,
  BOLT: 7,
  BOMB: 8,
});

const WEIGHTS = {
  1: [10, 26, 16], 2: [0, 10, 21], 3: [33, 19, 6], 4: [4, 21, 17],
  5: [38, 13, 4], 6: [0, 4, 17], 7: [0, 2, 10], 8: [15, 11, 5],
};
const KINDS = Object.keys(WEIGHTS).map(Number);
const q = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mod = (v, n) => ((v % n) + n) % n;

export function createItemRuntime(seed = null) {
  const privateSeed = seed === null ? randomBytes(4).readUInt32LE(0) : seed;
  return {
    boxes: createItemBoxLayout().map((box) => ({ ...box, cooldown: 0 })),
    entities: [],
    nextEntityId: 1,
    nextEventId: 1,
    events: [],
    randomState: privateSeed >>> 0,
  };
}

export function stepItemRuntime(runtime, players, dt) {
  for (const box of runtime.boxes) box.cooldown = Math.max(0, box.cooldown - dt);
  stepEntities(runtime, players, dt);

  for (const player of players) {
    if (player.finished || player.itemKind !== ITEM_KIND.NONE) continue;
    const lapDistance = mod(player.distance, TRACK_LENGTH);
    for (const box of runtime.boxes) {
      if (box.cooldown > 0) continue;
      let along = Math.abs(lapDistance - box.distance);
      along = Math.min(along, TRACK_LENGTH - along);
      if (along > ITEM_BOX_PICKUP_RADIUS
          || Math.abs(player.lateral - box.lateral) > ITEM_BOX_PICKUP_RADIUS) continue;
      player.itemKind = roll(runtime, player.place, players.length);
      player.itemCount = player.itemKind === ITEM_KIND.TRIPLE_MUSHROOM ? 3 : 1;
      player.itemArm = ITEM_ARM_TIME;
      player.itemRevision += 1;
      box.cooldown = ITEM_BOX_RESPAWN;
      event(runtime, 'pickup', player.slot, player.itemKind);
      break;
    }
  }
}

export function useItemRuntime(runtime, player, players, backwards = false) {
  const kind = player.itemKind;
  if (!kind || player.itemCount <= 0 || player.itemArm > 0 || player.stunTime > 0) return false;

  if (kind === ITEM_KIND.MUSHROOM || kind === ITEM_KIND.TRIPLE_MUSHROOM) {
    player.boostTime = Math.max(player.boostTime, 1.55);
    player.speed += 4.5;
  } else if (kind === ITEM_KIND.STAR) {
    player.starTime = Math.max(player.starTime, 7.4);
    player.boostTime = Math.max(player.boostTime, 0.8);
  } else if (kind === ITEM_KIND.BOLT) {
    for (const target of players) {
      if (target === player || target.finished || target.starTime > 0) continue;
      target.stunTime = Math.max(target.stunTime, 0.65);
      target.shrinkTime = Math.max(target.shrinkTime, 6.5);
      target.speed *= 0.68;
      event(runtime, 'hit', target.slot, kind);
    }
  } else {
    if (!spawnEntity(runtime, kind, player, players, backwards)) return false;
  }

  player.itemCount -= 1;
  if (player.itemCount <= 0) {
    player.itemKind = ITEM_KIND.NONE;
    player.itemCount = 0;
    player.itemArm = 0;
  } else {
    player.itemArm = 0.22;
  }
  player.itemRevision += 1;
  event(runtime, 'use', player.slot, kind);
  return true;
}

export function itemSnapshot(runtime) {
  return {
    box_down: runtime.boxes
      .filter((box) => box.cooldown > 0)
      .map((box) => [box.id, q(box.cooldown)]),
    entities: runtime.entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      distance: q(entity.distance),
      lateral: q(entity.lateral),
    })),
    events: runtime.events,
  };
}

function spawnEntity(runtime, kind, player, players, backwards) {
  if (runtime.entities.length >= MAX_ITEM_ENTITIES) return false;
  const direction = backwards ? -1 : 1;
  const target = kind === ITEM_KIND.RED_SHELL && !backwards
    ? nearestAhead(player, players)?.slot ?? -1
    : -1;
  runtime.entities.push({
    id: runtime.nextEntityId++,
    kind,
    owner: player.slot,
    target,
    distance: player.distance + direction * 2.4,
    lateral: player.lateral,
    direction,
    speed: kind === ITEM_KIND.GREEN_SHELL ? 44
      : kind === ITEM_KIND.RED_SHELL ? 40
        : kind === ITEM_KIND.BOMB ? 25 : 0,
    ttl: kind === ITEM_KIND.BANANA ? 45 : kind === ITEM_KIND.BOMB ? 1.25 : 9,
    ownerLock: 0.6,
  });
  return true;
}

function stepEntities(runtime, players, dt) {
  const live = [];
  for (const entity of runtime.entities) {
    entity.ttl -= dt;
    entity.ownerLock = Math.max(0, entity.ownerLock - dt);

    if (entity.kind === ITEM_KIND.RED_SHELL && entity.target >= 0) {
      const target = players.find((player) => player.slot === entity.target && !player.finished);
      if (target) {
        entity.lateral += clamp(target.lateral - entity.lateral, -8 * dt, 8 * dt);
      }
    }
    entity.distance += entity.direction * entity.speed * dt;

    if (entity.kind === ITEM_KIND.BOMB && entity.ttl <= 0) {
      explode(runtime, entity, players);
      continue;
    }
    if (entity.ttl <= 0) continue;

    const hit = players.find((target) => {
      if (target.finished || target.starTime > 0) return false;
      if (target.slot === entity.owner && entity.ownerLock > 0) return false;
      return Math.abs(target.distance - entity.distance) < 1.8
        && Math.abs(target.lateral - entity.lateral) < 1.55;
    });
    if (hit) {
      hit.stunTime = Math.max(hit.stunTime, entity.kind === ITEM_KIND.BANANA ? 1.15 : 1.5);
      hit.speed *= entity.kind === ITEM_KIND.BANANA ? 0.6 : 0.48;
      event(runtime, 'hit', hit.slot, entity.kind);
      if (entity.kind === ITEM_KIND.BOMB) explode(runtime, entity, players);
      continue;
    }
    live.push(entity);
  }
  runtime.entities = live;
}

function explode(runtime, entity, players) {
  for (const target of players) {
    if (target.finished || target.starTime > 0) continue;
    if (Math.abs(target.distance - entity.distance) > 14
        || Math.abs(target.lateral - entity.lateral) > 5.5) continue;
    target.stunTime = Math.max(target.stunTime, 1.8);
    target.speed *= 0.42;
    event(runtime, 'hit', target.slot, ITEM_KIND.BOMB);
  }
}

function event(runtime, type, slot, kind) {
  runtime.events.push({ id: runtime.nextEventId++, type, slot, kind });
  if (runtime.events.length > 32) runtime.events.splice(0, runtime.events.length - 32);
}

function nearestAhead(player, players) {
  return players
    .filter((target) => target !== player && !target.finished && target.distance > player.distance)
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function roll(runtime, place, racers) {
  const p = racers > 1 ? clamp((place - 1) / (racers - 1), 0, 1) : 0;
  const weighted = [];
  let total = 0;
  for (const kind of KINDS) {
    const w = WEIGHTS[kind];
    const value = p < 0.5
      ? w[0] + (w[1] - w[0]) * p * 2
      : w[1] + (w[2] - w[1]) * (p - 0.5) * 2;
    if (value <= 0) continue;
    total += value;
    weighted.push([kind, total]);
  }
  const pick = random(runtime) * total;
  return weighted.find(([, end]) => pick < end)?.[0] ?? ITEM_KIND.MUSHROOM;
}

function random(runtime) {
  let x = runtime.randomState || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  runtime.randomState = x >>> 0;
  return runtime.randomState / 0x100000000;
}
