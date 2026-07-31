const apiUrl = (process.env.USION_API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
const token = process.env.USION_API_TOKEN;
const serviceId = process.env.USION_SERVICE_ID;
const gameUrl = process.env.GAME_URL?.replace(/\/$/, '');

if (!token?.startsWith('usion_sk_')) throw new Error('USION_API_TOKEN is required');
if (!serviceId) throw new Error('USION_SERVICE_ID is required');
if (!gameUrl?.startsWith('https://')) throw new Error('GAME_URL must be HTTPS');

const health = await fetch(`${gameUrl}/health`);
if (!health.ok) throw new Error(`Game healthcheck failed (${health.status})`);

const response = await fetch(
  `${apiUrl}/registry/services/my/${encodeURIComponent(serviceId)}/publish`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ is_published: true }),
  },
);
const result = await response.json().catch(() => ({}));
if (!response.ok) {
  throw new Error(`Usion publish failed (${response.status}): ${JSON.stringify(result)}`);
}
console.log(JSON.stringify({
  id: result.id || serviceId,
  name: result.name || 'Kart Royale',
  iframe_url: gameUrl,
  published: result.is_published === true,
}, null, 2));
