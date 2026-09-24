import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionClaims } from './types.js';

const b64 = (value: string) => Buffer.from(value).toString('base64url');
const unb64 = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

export function hashIdentity(parts: string[]) {
  return createHmac('sha256', process.env.SESSION_SECRET ?? 'dev-only-secret-change-me').update(parts.join('|')).digest('hex');
}

export function signSession(input: Omit<SessionClaims, 'iat' | 'exp' | 'nonce'>, ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 900)) {
  const claims: SessionClaims = { ...input, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: randomBytes(12).toString('hex') };
  const payload = b64(JSON.stringify(claims));
  const signature = createHmac('sha256', process.env.SESSION_SECRET ?? 'dev-only-secret-change-me').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySession(token: string): SessionClaims | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', process.env.SESSION_SECRET ?? 'dev-only-secret-change-me').update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(unb64(payload)) as SessionClaims;
    if (claims.provider !== 'gartic.io' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
