import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const importConfig = 'import("./server/config.js")';

function probe(extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', importConfig], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SERVICE_ID: 'kart-royale',
      SIGNING_SECRET: 'a-secure-random-secret-with-32-bytes',
      API_URL: 'https://mobile.mongolai.mn',
      ...extra,
    },
  });
}

test('production rejects unsigned development auth', () => {
  const result = probe({ DEV_ALLOW_UNSIGNED: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must never be enabled/i);
});

test('production rejects missing, weak, and placeholder signing secrets', () => {
  for (const secret of ['', 'short', 'change-me-change-me-change-me-change-me']) {
    const result = probe({ SIGNING_SECRET: secret });
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(secret)}`);
  }
});

test('production rejects insecure Usion endpoints', () => {
  const result = probe({ API_URL: 'http://mobile.mongolai.mn' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS/);
});
