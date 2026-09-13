import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { HttpError } from '../domain/workspace.js';

export type Provider = 'paystack' | 'stripe';
export interface Attempt {
  id: string; business_id: string; booking_id: string; reservation_code: string;
  provider: Provider; live_mode: boolean; choice: 'deposit' | 'full'; email: string;
  amount_minor: number; currency: string; status: 'initializing' | 'pending' | 'succeeded' | 'expired';
  provider_reference: string; provider_session: string | null; provider_transaction: string | null;
  checkout_url: string | null; return_url: string; created_at: string; needs_review: boolean;
}
export interface Verification { paid: boolean; expired?: boolean; transaction?: string; amount?: number; currency?: string; live?: boolean; }

export function checkoutOrigin(): string | null {
  try {
    const url = new URL(process.env.PAYMENT_RETURN_URL || '');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
export function providerEnabled(provider: Provider) {
  if (!checkoutOrigin()) return false;
  return provider === 'paystack'
    ? /^sk_(test|live)_\S+$/.test(process.env.PAYSTACK_SECRET_KEY || '')
    : /^sk_(test|live)_\S+$/.test(process.env.STRIPE_SECRET_KEY || '') && /^whsec_\S+$/.test(process.env.STRIPE_WEBHOOK_SECRET || '');
}
export const liveMode = (provider: Provider) => (provider === 'paystack' ? process.env.PAYSTACK_SECRET_KEY : process.env.STRIPE_SECRET_KEY)?.startsWith('sk_live_') ?? false;
const stripeClient = () => new Stripe(process.env.STRIPE_SECRET_KEY || '', { timeout: 12000, maxNetworkRetries: 1 });

export function validCheckoutURL(provider: Provider, raw: string) {
  try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && url.hostname === (provider === 'paystack' ? 'checkout.paystack.com' : 'checkout.stripe.com'); }
  catch { return false; }
}
async function paystack(path: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`https://api.paystack.co${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
    });
  } catch { throw new HttpError(503, 'Paystack has not confirmed this request yet. Retry this same checkout.'); }
  const data = await response.json().catch(() => null) as any;
  if (!response.ok || !data?.status) throw new HttpError(503, 'Paystack could not complete this request. Your existing checkout is preserved; try again.');
  return data.data;
}
export async function initializeProvider(attempt: Attempt): Promise<{ session: string; url: string }> {
  if (attempt.live_mode !== liveMode(attempt.provider)) throw new HttpError(409, 'This checkout belongs to a different payment environment. Contact the studio.');
  const callback = `${attempt.return_url}/pay/${attempt.reservation_code}?checkout=${attempt.id}`;
  if (attempt.provider === 'paystack') {
    const data = await paystack('/transaction/initialize', { email: attempt.email, amount: attempt.amount_minor, currency: attempt.currency,
      reference: attempt.provider_reference, callback_url: callback,
      metadata: { checkout_id: attempt.id, business_id: attempt.business_id, booking_id: attempt.booking_id },
    });
    if (data.reference !== attempt.provider_reference || typeof data.access_code !== 'string' || !validCheckoutURL('paystack', data.authorization_url)) throw new HttpError(502, 'Paystack returned an invalid checkout. Please retry.');
    return { session: data.access_code, url: data.authorization_url };
  }
  // Stripe may prune idempotency keys after 24h. Never initialize the same attempt beyond that boundary.
  if (Date.now() - Date.parse(attempt.created_at) > 23 * 3600000) throw new HttpError(409, 'This checkout needs reconciliation before another can be opened. Contact the studio.');
  const session = await stripeClient().checkout.sessions.create({
    mode: 'payment', payment_method_types: ['card'], customer_email: attempt.email,
    client_reference_id: attempt.id, metadata: { checkout_id: attempt.id, business_id: attempt.business_id, booking_id: attempt.booking_id },
    payment_intent_data: { metadata: { checkout_id: attempt.id, business_id: attempt.business_id, booking_id: attempt.booking_id } },
    line_items: [{ quantity: 1, price_data: { currency: 'ngn', unit_amount: attempt.amount_minor, product_data: { name: 'Reservation payment' } } }],
    success_url: callback, cancel_url: `${callback}&cancelled=1`,
  }, { idempotencyKey: `reserv-checkout-${attempt.id}` });
  if (!session.url || !validCheckoutURL('stripe', session.url)) throw new HttpError(502, 'Stripe did not return a valid checkout URL.');
  return { session: session.id, url: session.url };
}
export async function verifyProvider(attempt: Attempt): Promise<Verification> {
  if (attempt.live_mode !== liveMode(attempt.provider)) throw new HttpError(409, 'This checkout uses a different payment environment. Contact the studio.');
  if (attempt.provider === 'paystack') {
    const data = await paystack(`/transaction/verify/${encodeURIComponent(attempt.provider_reference)}`);
    if (data.reference !== attempt.provider_reference || data.metadata?.checkout_id !== attempt.id || data.metadata?.business_id !== attempt.business_id || data.metadata?.booking_id !== attempt.booking_id) throw new HttpError(409, 'Payment reference did not match this reservation.');
    if (!['test','live'].includes(data.domain)) throw new HttpError(409, 'Payment environment could not be verified.');
    return { paid: data.status === 'success', transaction: data.reference, amount: data.amount, currency: data.currency, live: data.domain === 'live' };
  }
  if (!attempt.provider_session) return { paid: false };
  const session = await stripeClient().checkout.sessions.retrieve(attempt.provider_session);
  if (session.mode !== 'payment' || session.client_reference_id !== attempt.id || session.metadata?.checkout_id !== attempt.id || session.metadata?.business_id !== attempt.business_id || session.metadata?.booking_id !== attempt.booking_id) throw new HttpError(409, 'Payment reference did not match this reservation.');
  return { paid: session.payment_status === 'paid', expired: session.status === 'expired', transaction: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id, amount: session.amount_total ?? undefined, currency: session.currency?.toUpperCase(), live: session.livemode };
}
export function verifyPaystackSignature(raw: Buffer, signature: string | undefined) {
  if (!process.env.PAYSTACK_SECRET_KEY || !signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
export function parseStripeEvent(raw: Buffer, signature: string) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhooks are not configured');
  return stripeClient().webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

export interface Adjustment { checkoutId?: string; reference: string; external: string; kind: 'refund' | 'dispute'; amount: number; originalAmount: number; currency: string; live: boolean; }
export async function paystackAdjustment(kind: 'refund' | 'dispute', id: string): Promise<Adjustment | null> {
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid adjustment reference');
  const data = await paystack(`/${kind}/${id}`);
  if (kind === 'refund' && data.status !== 'processed') return null;
  let transaction = data.transaction;
  if (typeof transaction !== 'object' || transaction === null) transaction = await paystack(`/transaction/${encodeURIComponent(String(transaction))}`);
  if (typeof transaction.reference !== 'string' || !['live','test'].includes(transaction.domain)) throw new HttpError(409, 'Could not verify adjusted payment');
  return { reference: transaction.reference, external: `${kind}-${id}`, kind, amount: kind === 'refund' ? data.amount : 0, originalAmount: transaction.amount, currency: transaction.currency, live: transaction.domain === 'live' };
}
export async function stripeAdjustment(kind: 'refund' | 'dispute', object: { id: string; charge?: string | { id: string } }): Promise<Adjustment> {
  const client = stripeClient();
  const chargeId = kind === 'refund' ? object.id : typeof object.charge === 'string' ? object.charge : object.charge?.id;
  if (!chargeId) throw new HttpError(400, 'Missing charge reference');
  const charge = await client.charges.retrieve(chargeId);
  const reference = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!reference) throw new HttpError(409, 'Missing payment reference');
  return { checkoutId: charge.metadata?.checkout_id, reference, external: kind === 'refund' ? `refund-total-${charge.id}` : `dispute-${object.id}`, kind, amount: kind === 'refund' ? charge.amount_refunded : 0, originalAmount: charge.amount, currency: charge.currency.toUpperCase(), live: charge.livemode };
}
