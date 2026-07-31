import { access, writeFile } from 'node:fs/promises';

const apiUrl = (process.env.USION_API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
const token = process.env.USION_API_TOKEN;
const gameUrl = process.env.GAME_URL?.replace(/\/$/, '');
const signingKeyId = process.env.SIGNING_KEY_ID || 'kart-royale-key-1';
const envFile = process.env.RAILWAY_ENV_FILE || '.env.railway.generated';

if (!token?.startsWith('usion_sk_')) {
  throw new Error('USION_API_TOKEN must be a Service Creator API token');
}
if (!gameUrl?.startsWith('https://')) {
  throw new Error('GAME_URL must be the production HTTPS deployment URL');
}
try {
  await access(envFile);
  throw new Error(`${envFile} already exists; import or remove it before rotating the secret`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Usion API failed (${response.status}): ${JSON.stringify(result)}`);
  }
  return result;
}

const mine = await request('/registry/services/my');
let service = Array.isArray(mine)
  ? mine.find((candidate) => (
      candidate.name === 'Kart Royale'
      && candidate.iframe_url === gameUrl
      && candidate.is_published === false
    ))
  : null;
if (!service) {
  service = await request('/registry/services/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Kart Royale',
      description: 'A smooth-steering, server-authoritative 2–4 player kart racer.',
      service_type: 'game',
      iframe_url: gameUrl,
      cost: 0,
      tags: ['game', 'iframe', 'multiplayer', 'action', 'direct', 'free'],
      is_published: false,
      max_players: 4,
      realtime: {
        connection_mode: 'direct',
        connection_transport: 'websocket',
        ws_url: `${gameUrl.replace(/^http/, 'ws')}/ws`,
        protocol_version: '2',
        heartbeat_interval_ms: 15_000,
        max_payload_bytes: 8192,
        rate_limits: { input_per_sec: 60 },
        signing: {
          alg: 'HMAC-SHA256',
          key_id: signingKeyId,
          result_webhook_enabled: true,
        },
      },
    }),
  });
}
const serviceId = service.id;
if (!serviceId) throw new Error('Usion registration did not return a service id');

const minted = await request(`/registry/services/my/${encodeURIComponent(serviceId)}/notify-secret`, {
  method: 'POST',
  body: '{}',
});
if (!minted.secret || minted.secret.length < 32) {
  throw new Error('Usion did not return the one-time signing secret');
}

const vars = [
  'NODE_ENV=production',
  `SERVICE_ID=${serviceId}`,
  `SIGNING_SECRET=${minted.secret}`,
  `SIGNING_KEY_ID=${minted.key_id || signingKeyId}`,
  `API_URL=${apiUrl}`,
  `JWKS_URL=${apiUrl}/.well-known/jwks.json`,
  '',
].join('\n');
await writeFile(envFile, vars, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

console.log(JSON.stringify({
  id: serviceId,
  name: service.name || 'Kart Royale',
  iframe_url: gameUrl,
  published: false,
  railway_env_file: envFile,
  next: 'Import the generated variables into Railway, redeploy, then run npm run publish:usion.',
}, null, 2));
