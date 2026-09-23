import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProductionConfig } from '../dist/lib/productionConfig.js';
const valid = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture', JWT_SECRET: 'x'.repeat(40), RESEND_API_KEY: 'fixture', CLIENT_ORIGIN: 'https://app.example.test', EMAIL_FROM: 'Reserv <hello@example.test>' };
test('production rejects local browser origins, default email senders and invalid proxy settings', () => {
  assert.equal(checkProductionConfig(valid).errors.length, 0);
  for (const override of [{ CLIENT_ORIGIN: '*' }, { CLIENT_ORIGIN: 'http://localhost:3000' }, { EMAIL_FROM: 'onboarding@resend.dev' }, { TRUST_PROXY_HOPS: 'true' }, { ENABLE_CALL_SCHEDULER: 'true' }, { STRIPE_SECRET_KEY: 'fixture' }]) {
    assert.ok(checkProductionConfig({ ...valid, ...override }).errors.length > 0);
  }
});
test('production voice calling requires authenticated booking tools and a public webhook', () => {
  const voice = { ...valid, AETHEX_API_KEY: 'fixture', AETHEX_WEBHOOK_SECRET: 'signing', AETHEX_PUBLIC_WEBHOOK_URL: 'https://api.example.test/api/calls/webhook', VOICE_TOOLS_SECRET: 't'.repeat(40) };
  assert.equal(checkProductionConfig(voice).errors.length, 0);
  for (const override of [{ VOICE_TOOLS_SECRET: '' }, { VOICE_TOOLS_SECRET: 'short' }, { VOICE_TOOLS_SECRET: valid.JWT_SECRET }, { AETHEX_PUBLIC_WEBHOOK_URL: 'http://api.example.test/api/calls/webhook' }, { AETHEX_PUBLIC_WEBHOOK_URL: 'https://localhost/api/calls/webhook' }, { AETHEX_WEBHOOK_SECRET: '' }]) {
    assert.ok(checkProductionConfig({ ...voice, ...override }).errors.length > 0, JSON.stringify(override));
  }
});
