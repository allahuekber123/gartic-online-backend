import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from '../src/security.js';

test('session token round trips and rejects tampering', () => {
  const token = signSession({ sub: 'u1', roomId: 'room-a', provider: 'gartic.io', identityHash: 'h', nickname: 'Ada' }, 60);
  const claims = verifySession(token);
  assert.equal(claims?.sub, 'u1');
  const [payload, signature] = token.split('.');
  assert.equal(verifySession(`${payload}.tampered`), null);
  assert.ok(signature);
});
