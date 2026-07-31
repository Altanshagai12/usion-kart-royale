import crypto from 'node:crypto';
import {
  API_URL, SERVICE_ID, SIGNING_KEY_ID, SIGNING_SECRET,
} from './config.js';

const PATH = '/games/direct/results';
const BACKOFF = [1000, 3000, 9000];

function signature(timestamp, bytes) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const canonical = `${timestamp}\nPOST\n${PATH}\n${hash}`;
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

export async function submitResult({
  roomId, sessionId, winnerIds, participants, reason, finalStats,
}) {
  if (!SIGNING_SECRET) {
    console.warn(`[RESULT] signing disabled; room=${roomId}`);
    return null;
  }
  const body = Buffer.from(JSON.stringify({
    room_id: roomId,
    session_id: sessionId,
    service_id: SERVICE_ID,
    winner_ids: winnerIds,
    participants,
    reason,
    final_stats: finalStats,
    ended_at: new Date().toISOString(),
  }));
  const idempotencyKey = crypto.randomUUID();
  let lastError;
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetch(`${API_URL}${PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Usion-Service-Id': SERVICE_ID,
          'X-Usion-Key-Id': SIGNING_KEY_ID,
          'X-Usion-Signature': signature(timestamp, body),
          'X-Usion-Timestamp': timestamp,
          'X-Idempotency-Key': idempotencyKey,
        },
        body,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return await response.json();
    } catch (err) {
      lastError = err;
      if (BACKOFF[attempt] === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF[attempt]));
    }
  }
  console.error(`[RESULT] failed room=${roomId}: ${lastError?.message || lastError}`);
  return null;
}
