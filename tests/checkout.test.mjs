import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import Stripe from 'stripe';
import { CheckoutService } from '../dist/payments/service.js';
import { providerEnabled, validCheckoutURL, verifyPaystackSignature, parseStripeEvent, initializeProvider, verifyProvider } from '../dist/payments/providers.js';

const attempt = { id: 'e6f450af-6357-451a-a6be-0b2ba79261f4', business_id: 'tenant-a', booking_id: 'booking-a', reservation_code: 'ABCDEFGHIJKL', provider: 'paystack', live_mode: false, choice: 'deposit', email: 'customer@example.test', amount_minor: 500000, currency: 'NGN', status: 'initializing', provider_reference: 'rsv-e6f450af-6357-451a-a6be-0b2ba79261f4', provider_session: null, checkout_url: null, created_at: new Date().toISOString(), return_url: 'https://reserv.example', needs_review: false };
const verified = { paid: true, transaction: 'transaction-a', amount: 500000, currency: 'NGN', live: false };

function harness(verification = verified) {
  let row = structuredClone(attempt), claimed = false, initialized = 0, settlements = 0;
  const repo = {
    async claim() { if (claimed) return false; claimed = true; return true; },
    async initialized(id, session, url) { row = { ...row, provider_session: session, checkout_url: url, status: 'pending' }; },
    async find() { return row; },
    async settle() { settlements++; return row = { ...row, status: 'succeeded' }; },
    async expire() { row.status = 'expired'; },
  };
  const init = async () => { initialized++; return { session: 'session', url: 'https://checkout.paystack.com/session' }; };
  return { service: new CheckoutService(repo, init, async () => verification), repo, init, get row() { return row; }, get initialized() { return initialized; }, get settlements() { return settlements; } };
}
test('only one concurrent request initializes checkout; other requests retain the reference', async () => {
  const h = harness({ paid: false });
  const results = await Promise.allSettled([h.service.begin(attempt), h.service.begin(attempt)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.initialized, 1);
  assert.equal((await h.service.begin(h.row)).checkout_url, 'https://checkout.paystack.com/session');
  assert.equal(h.initialized, 1);
});
test('verified amount, currency and environment must match before settlement', async () => {
  for (const patch of [{ amount: 1 }, { amount: 500000.1 }, { currency: 'USD' }, { live: true }, { transaction: undefined }]) {
    const h = harness({ ...verified, ...patch });
    await assert.rejects(h.service.reconcile(attempt), /verification did not match/);
    assert.equal(h.settlements, 0);
  }
});
test('unpaid, completed and expired states do not create another payment', async () => {
  const h = harness({ paid: false });
  assert.equal((await h.service.reconcile(attempt)).status, 'initializing');
  await h.service.reconcile({ ...attempt, status: 'succeeded' });
  await h.service.reconcile({ ...attempt, status: 'expired' });
  assert.equal(h.settlements, 0);
  const exp = harness({ paid: false, expired: true });
  assert.equal((await exp.service.reconcile({ ...attempt, provider: 'stripe', status: 'pending' })).status, 'expired');
});
test('an ambiguous initialization failure is reconciled without creating a second charge', async () => {
  const h = harness();
  const service = new CheckoutService(h.repo, async () => { throw new Error('timeout'); }, async () => verified);
  assert.equal((await service.begin(attempt)).status, 'succeeded');
  assert.equal(h.settlements, 1);
});
test('provider configuration and checkout redirects fail closed', () => {
  process.env.PAYMENT_RETURN_URL = 'https://reserv.example';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example';
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(providerEnabled('paystack'), true); assert.equal(providerEnabled('stripe'), false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_example'; assert.equal(providerEnabled('stripe'), false);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example'; assert.equal(providerEnabled('stripe'), true);
  process.env.PAYMENT_RETURN_URL = 'https://reserv.example/unsafe/path'; assert.equal(providerEnabled('paystack'), false);
  assert.equal(validCheckoutURL('paystack', 'https://checkout.paystack.com/abc'), true);
  for (const url of ['https://checkout.paystack.com.evil.test', 'javascript:alert(1)', 'https://evil.test', 'https://user:pass@checkout.paystack.com']) assert.equal(validCheckoutURL('paystack', url), false);
});
test('webhooks require signatures over the exact bytes; Stripe rejects old signatures', () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example';
  const raw = Buffer.from('{"event":"charge.success","data":{"reference":"test"}}');
  const sig = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  assert.equal(verifyPaystackSignature(raw, sig), true);
  assert.equal(verifyPaystackSignature(Buffer.concat([raw, Buffer.from(' ')]), sig), false);
  assert.equal(verifyPaystackSignature(raw, 'bad'), false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_example'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example';
  const stripe = new Stripe('sk_test_example');
  const payload = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed', data: { object: {} } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_example' });
  assert.equal(parseStripeEvent(Buffer.from(payload), header).id, 'evt_test');
  assert.throws(() => parseStripeEvent(Buffer.from(payload + ' '), header));
  const old = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_example', timestamp: Math.floor(Date.now()/1000)-600 });
  assert.throws(() => parseStripeEvent(Buffer.from(payload), old));
});
test('Paystack initialization uses the durable reference and server amount on every retry', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example';
  const original = globalThis.fetch; const bodies = [];
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ status: true, data: { reference: attempt.provider_reference, access_code: 'access', authorization_url: 'https://checkout.paystack.com/access' } })); };
  try {
    await initializeProvider(attempt); await initializeProvider(attempt);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].amount, 500000); assert.equal(bodies[0].currency, 'NGN');
    assert.equal(bodies[0].metadata.business_id, 'tenant-a');
  } finally { globalThis.fetch = original; }
});
test('Paystack verification rejects a successful transaction for a different tenant', async () => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_example';
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: true, data: { status: 'success', reference: attempt.provider_reference, metadata: { checkout_id: attempt.id, business_id: 'tenant-b', booking_id: attempt.booking_id } } }));
  try { await assert.rejects(verifyProvider(attempt), /reference did not match/); }
  finally { globalThis.fetch = original; }
});

test('Stripe checkout retries keep the same idempotency key, amount and destination', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 'cs_test_example', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_example' }), { headers: { 'content-type': 'application/json' } }); };
  try {
    const stripeAttempt = { ...attempt, provider: 'stripe' };
    await initializeProvider(stripeAttempt); await initializeProvider(stripeAttempt);
    assert.equal(new Headers(calls[0].options.headers).get('Idempotency-Key'), `reserv-checkout-${attempt.id}`);
    assert.equal(calls[0].options.body, calls[1].options.body);
    const body = new URLSearchParams(calls[0].options.body);
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '500000');
    assert.equal(body.get('line_items[0][price_data][currency]'), 'ngn');
    assert.equal(body.get('success_url'), `https://reserv.example/pay/ABCDEFGHIJKL?checkout=${attempt.id}`);
    assert.equal(body.get('metadata[business_id]'), 'tenant-a');
    await assert.rejects(initializeProvider({ ...stripeAttempt, created_at: new Date(Date.now()-25*3600000).toISOString() }), /reconciliation/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});
test('Stripe verification reads provider state, not return URL parameters', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_example';
  const original = globalThis.fetch;
  let paymentStatus = 'unpaid', sessionStatus = 'open';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'cs_test_example', mode: 'payment', object: 'checkout.session', payment_status: paymentStatus, status: sessionStatus, client_reference_id: attempt.id, metadata: { checkout_id: attempt.id, business_id: attempt.business_id, booking_id: attempt.booking_id }, payment_intent: 'pi_example', amount_total: 500000, currency: 'ngn', livemode: false }), { headers: { 'content-type': 'application/json' } });
  try {
    const value = { ...attempt, provider: 'stripe', provider_session: 'cs_test_example' };
    assert.equal((await verifyProvider(value)).paid, false);
    paymentStatus = 'paid'; sessionStatus = 'complete';
    assert.equal((await verifyProvider(value)).paid, true);
    paymentStatus = 'unpaid'; sessionStatus = 'expired';
    assert.equal((await verifyProvider(value)).expired, true);
  } finally { globalThis.fetch = original; }
});
