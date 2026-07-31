import assert from 'node:assert/strict';
import {
  readFile, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const token = 'usion_sk_test-token';
const gameUrl = 'https://kart.example.test';

test('registration stores the one-time signing secret without logging it', async (t) => {
  const envFile = path.join(tmpdir(), `kart-railway-${crypto.randomUUID()}.env`);
  t.after(() => unlink(envFile).catch(() => {}));
  const calls = [];
  const originalFetch = global.fetch;
  const originalLog = console.log;
  let logged = '';
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/registry/services/my') && !options.method) {
      return Response.json([]);
    }
    if (String(url).endsWith('/registry/services/register')) {
      return Response.json({
        id: 'kart-royale-test',
        name: 'Kart Royale',
        iframe_url: gameUrl,
        is_published: false,
      }, { status: 201 });
    }
    if (String(url).endsWith('/notify-secret')) {
      return Response.json({
        secret: 'minted-secret-that-is-longer-than-32-characters',
        key_id: 'kart-royale-key-1',
      });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  console.log = (value) => { logged += String(value); };
  Object.assign(process.env, {
    USION_API_TOKEN: token,
    USION_API_URL: 'http://usion.test',
    GAME_URL: gameUrl,
    RAILWAY_ENV_FILE: envFile,
  });

  try {
    await import(`../scripts/register-usion.mjs?test=${crypto.randomUUID()}`);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }

  const registration = JSON.parse(calls[1].options.body);
  assert.equal(registration.is_published, false);
  assert.equal(registration.realtime.signing.result_webhook_enabled, true);
  assert.equal(registration.realtime.signing.key_id, 'kart-royale-key-1');
  assert.equal(registration.realtime.signing.shared_secret, undefined);
  const generated = await readFile(envFile, 'utf8');
  assert.match(generated, /SERVICE_ID=kart-royale-test/);
  assert.match(generated, /SIGNING_SECRET=minted-secret/);
  assert.doesNotMatch(logged, /minted-secret/);
});

test('registration preflight does not rotate a secret when the env file exists', async (t) => {
  const envFile = path.join(tmpdir(), `kart-railway-existing-${crypto.randomUUID()}.env`);
  await writeFile(envFile, 'keep-me');
  t.after(() => unlink(envFile).catch(() => {}));
  let fetches = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetches += 1;
    return Response.json({});
  };
  Object.assign(process.env, {
    USION_API_TOKEN: token,
    GAME_URL: gameUrl,
    RAILWAY_ENV_FILE: envFile,
  });
  try {
    await assert.rejects(
      import(`../scripts/register-usion.mjs?test=${crypto.randomUUID()}`),
      /already exists/,
    );
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});

test('publish script requires a healthy deployment before publishing', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const originalLog = console.log;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === `${gameUrl}/health`) return Response.json({ ok: true });
    return Response.json({
      id: 'kart-royale-test',
      name: 'Kart Royale',
      iframe_url: gameUrl,
      is_published: true,
    });
  };
  console.log = () => {};
  Object.assign(process.env, {
    USION_API_TOKEN: token,
    USION_API_URL: 'http://usion.test',
    USION_SERVICE_ID: 'kart-royale-test',
    GAME_URL: gameUrl,
  });
  try {
    await import(`../scripts/publish-usion.mjs?test=${crypto.randomUUID()}`);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.equal(calls[0].url, `${gameUrl}/health`);
  assert.match(calls[1].url, /\/registry\/services\/my\/kart-royale-test\/publish$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { is_published: true });
});
