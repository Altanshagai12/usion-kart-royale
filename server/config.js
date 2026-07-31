export * from '../shared/constants.js';

const env = process.env;
const bool = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

export const PORT = Number(env.PORT || 3017);
export const NODE_ENV = env.NODE_ENV || 'development';
export const IS_PROD = NODE_ENV === 'production';
export const DEV_ALLOW_UNSIGNED = bool(env.DEV_ALLOW_UNSIGNED);

export const SERVICE_ID = env.SERVICE_ID || 'kart-royale';
export const API_URL = (env.API_URL || 'https://mobile.mongolai.mn').replace(/\/$/, '');
export const JWKS_URL = env.JWKS_URL || `${API_URL}/.well-known/jwks.json`;
export const SIGNING_KEY_ID = env.SIGNING_KEY_ID || 'kart-royale-key-1';
export const SIGNING_SECRET = env.SIGNING_SECRET || '';

if (DEV_ALLOW_UNSIGNED && IS_PROD) {
  throw new Error('DEV_ALLOW_UNSIGNED must never be enabled in production');
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port');
}
if (IS_PROD) {
  if (!env.SERVICE_ID || !env.SIGNING_SECRET) {
    throw new Error('SERVICE_ID and SIGNING_SECRET are required in production');
  }
  if (SIGNING_SECRET.length < 32 || /^(change|replace|secret|example)/i.test(SIGNING_SECRET)) {
    throw new Error('SIGNING_SECRET must be a strong, non-placeholder secret');
  }
  for (const [name, value] of [['API_URL', API_URL], ['JWKS_URL', JWKS_URL]]) {
    if (!value.startsWith('https://')) throw new Error(`${name} must use HTTPS in production`);
  }
}
