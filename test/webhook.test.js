import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

test('result retries keep one idempotency key and sign the exact body', { timeout: 10_000 }, async (t) => {
  const secret = 'test-signing-secret-at-least-32-bytes';
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks) });
      const status = requests.length < 3 ? 503 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"retry"}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  process.env.API_URL = `http://127.0.0.1:${port}`;
  process.env.SIGNING_SECRET = secret;
  process.env.SERVICE_ID = 'kart-royale';
  const { submitResult } = await import('../server/webhook.js');

  const result = await submitResult({
    roomId: 'room-1',
    sessionId: 'session-1',
    winnerIds: ['winner'],
    participants: ['winner', 'runner-up'],
    reason: 'race_complete',
    finalStats: { laps: 3 },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((row) => row.headers['x-idempotency-key'])).size, 1);
  assert.equal(new Set(requests.map((row) => row.body.toString('utf8'))).size, 1);

  for (const request of requests) {
    const timestamp = request.headers['x-usion-timestamp'];
    const hash = crypto.createHash('sha256').update(request.body).digest('hex');
    const canonical = `${timestamp}\nPOST\n/games/direct/results\n${hash}`;
    const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    assert.equal(request.headers['x-usion-signature'], expected);
  }
});
