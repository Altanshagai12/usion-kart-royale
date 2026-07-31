import { sanitizeInput } from '../shared/race-sim.js';
import { useItemRuntime } from './item-runtime.js';

export function handlePlayerInput(room, conn, envelope) {
  const type = envelope.action_type;
  const data = envelope.action_data || envelope;
  if (type === 'hello') {
    const name = String(data.name || '')
      .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
    const player = room.players.find((candidate) => candidate.userId === conn.userId);
    if (name && player) {
      player.name = name;
      conn.name = name;
      room.broadcast('player_joined', { roster: room.roster(), slot: player.slot });
    }
    return;
  }

  const player = room.players.find((candidate) => candidate.userId === conn.userId);
  if (!player || player.finished) return;
  if (type === 'use_item' && room.phase === 'playing') {
    const itemSeq = Number(data.item_seq);
    if (!Number.isSafeInteger(itemSeq) || itemSeq <= 0) return;
    if (itemSeq <= player.ackItemSeq) return;
    const revision = Number(data.item_revision);
    if (!Number.isSafeInteger(revision) || revision !== player.itemRevision
        || Number(data.expected_kind) !== player.itemKind) {
      player.ackItemSeq = itemSeq;
      return;
    }
    useItemRuntime(room.items, player, room.players, data.backwards === true);
    player.ackItemSeq = itemSeq;
    return;
  }
  if (type !== 'drive' || !['countdown', 'playing'].includes(room.phase)) return;
  const next = sanitizeInput(data);
  if (next.iseq <= player.ackIseq) return;
  player.ackIseq = next.iseq;
  player.input = next;
}
