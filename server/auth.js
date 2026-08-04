import crypto from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { DEV_ALLOW_UNSIGNED, IS_PROD } from './config.js';

const cache = new Map();
const DEV_TOKEN = /^dev:([\w-]+):([\w-]+)$/;

function jwks(url, force = false) {
  if (force) cache.delete(url);
  if (!cache.has(url)) {
    cache.set(url, createRemoteJWKSet(new URL(url), {
      timeoutDuration: 15_000,
      cacheMaxAge: 300_000,
      cooldownDuration: 1_000,
    }));
  }
  return cache.get(url);
}

function shouldRefresh(err) {
  const text = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  return text.includes('signature') || text.includes('matching key') || text.includes('applicable key');
}

export async function validateAccessToken(token, { jwksUrl, serviceId }) {
  if (DEV_ALLOW_UNSIGNED && !IS_PROD) {
    const match = DEV_TOKEN.exec(token);
    if (match) {
      return {
        sub: match[1],
        room_id: match[2],
        session_id: crypto.randomUUID(),
        name: match[1],
      };
    }
  }

  const options = {
    issuer: 'usion-backend',
    audience: `usion-game-service:${serviceId}`,
    algorithms: ['RS256'],
    clockTolerance: 60,
  };
  let verified;
  try {
    verified = await jwtVerify(token, jwks(jwksUrl), options);
  } catch (err) {
    if (!shouldRefresh(err)) throw err;
    verified = await jwtVerify(token, jwks(jwksUrl, true), options);
  }
  const payload = verified.payload;
  if (payload.service_id && payload.service_id !== serviceId) throw new Error('service_id mismatch');
  if (!Array.isArray(payload.permissions) || !payload.permissions.includes('play')) {
    throw new Error("missing 'play' permission");
  }
  if (!payload.sub || !payload.room_id || !payload.session_id) {
    throw new Error('missing identity, room, or session claim');
  }
  const signedPlayerIds = Array.isArray(payload.player_ids)
    ? payload.player_ids.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  const signedHostId = typeof payload.host_id === 'string' && payload.host_id.length > 0
    ? payload.host_id
    : signedPlayerIds[0];
  return {
    sub: String(payload.sub),
    room_id: String(payload.room_id),
    session_id: String(payload.session_id),
    name: String(payload.name || payload.username || payload.sub),
    ...(signedHostId ? { host_id: signedHostId } : {}),
  };
}

export function safeDiagnosticClaims(token) {
  if (IS_PROD || process.env.AUTH_DIAG !== '1') return null;
  try {
    const claims = decodeJwt(token);
    return {
      iss: claims.iss,
      aud: claims.aud,
      service_id: claims.service_id,
      room_id: claims.room_id,
    };
  } catch {
    return null;
  }
}
