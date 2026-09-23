import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../dist/services/authService.js';

test('delivered OTPs are never returned to clients, including development', async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const auth = new AuthService(async () => ({ success: true, simulated: false }));
    const result = await auth.requestOtp('delivered@example.test');
    assert.equal(result.devCode, undefined);
    const simulated = new AuthService(async () => ({ success: true, simulated: true }));
    assert.equal((await simulated.requestOtp('dev@example.test')).devCode, undefined);
    process.env.NODE_ENV = 'test';
    assert.match((await simulated.requestOtp('fixture@example.test')).devCode, /^\d{6}$/);
    assert.equal((await auth.requestOtp('real-in-test@example.test')).devCode, undefined);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});
