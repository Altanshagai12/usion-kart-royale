import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  exportJWK, generateKeyPair, SignJWT,
} from 'jose';
import { validateAccessToken } from '../server/auth.js';

test('RS256 access tokens enforce issuer, audience, service, and play permission', async (t) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const jwksUrl = `http://127.0.0.1:${port}/jwks`;
  const serviceId = 'kart-royale';

  const sign = (overrides = {}, issuer = 'usion-backend', audience = `usion-game-service:${serviceId}`) => new SignJWT({
    service_id: serviceId,
    permissions: ['play'],
    room_id: 'room-1',
    session_id: 'session-1',
    name: 'Racer',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('user-1')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey);

  const identity = await validateAccessToken(await sign(), { jwksUrl, serviceId });
  assert.deepEqual(identity, {
    sub: 'user-1',
    room_id: 'room-1',
    session_id: 'session-1',
    name: 'Racer',
  });
  await assert.rejects(
    validateAccessToken(await sign({ permissions: ['spectate'] }), { jwksUrl, serviceId }),
    /play/,
  );
  await assert.rejects(
    validateAccessToken(await sign({ service_id: 'another-game' }), { jwksUrl, serviceId }),
    /service_id mismatch/,
  );
  await assert.rejects(
    validateAccessToken(await sign({}, 'another-issuer'), { jwksUrl, serviceId }),
    /iss|issuer/i,
  );
  await assert.rejects(
    validateAccessToken(await sign({}, 'usion-backend', 'another-audience'), { jwksUrl, serviceId }),
    /aud|audience/i,
  );
});
