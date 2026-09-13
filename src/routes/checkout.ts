import { Router, raw } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../domain/workspace.js';
import { workspaces, publicState } from '../services/workspaces.js';
import { isSupabaseConfigured } from '../lib/supabase.js';
import { paystackAdjustment, stripeAdjustment, type Adjustment, checkoutOrigin, providerEnabled, liveMode, verifyPaystackSignature, parseStripeEvent, type Provider } from '../payments/providers.js';
import { paymentRepository } from '../payments/repository.js';
import { checkoutService, publicAttempt } from '../payments/service.js';

async function recordAdjustment(provider: Provider, adjustment: Adjustment | null) {
  if (!adjustment) return;
  let attempt = await paymentRepository.find(provider === 'paystack' ? 'provider_reference' : 'provider_transaction', adjustment.reference, provider);
  if (!attempt && provider === 'stripe' && z.string().uuid().safeParse(adjustment.checkoutId).success) attempt = await paymentRepository.find('id', adjustment.checkoutId!, 'stripe');
  if (!attempt) return;
  if (!Number.isSafeInteger(adjustment.amount) || adjustment.amount < 0 || adjustment.amount > attempt.amount_minor || adjustment.originalAmount !== attempt.amount_minor || adjustment.currency !== attempt.currency || adjustment.live !== attempt.live_mode) throw new HttpError(409, 'Payment adjustment does not match checkout');
  await checkoutService.reconcile(attempt);
  await paymentRepository.adjust(attempt.id, adjustment);
}
export const checkoutWebhooks = Router();
checkoutWebhooks.use(raw({ type: 'application/json', limit: '256kb' }));
checkoutWebhooks.post('/paystack', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifyPaystackSignature(req.body, req.get('x-paystack-signature'))) throw new HttpError(400, 'Invalid webhook signature');
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid webhook body'); }
  if (event.event === 'refund.processed' || ['charge.dispute.create','charge.dispute.remind','charge.dispute.resolve'].includes(event.event)) {
    await recordAdjustment('paystack', await paystackAdjustment(event.event === 'refund.processed' ? 'refund' : 'dispute', String(event.data?.id)));
    return res.json({ received: true });
  }
  if (event.event !== 'charge.success') return res.json({ received: true });
  if (typeof event.data?.reference !== 'string') throw new HttpError(400, 'Missing payment reference');
  const attempt = await paymentRepository.find('provider_reference', event.data.reference, 'paystack');
  if (attempt) await checkoutService.reconcile(attempt);
  // A valid event for another product in the merchant account does not belong to Reserv.
  res.json({ received: true });
});
checkoutWebhooks.post('/stripe', async (req, res) => {
  let event;
  try { if (!Buffer.isBuffer(req.body)) throw new Error(); event = parseStripeEvent(req.body, req.get('stripe-signature') || ''); }
  catch { throw new HttpError(400, 'Invalid webhook signature'); }
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
    await recordAdjustment('stripe', await stripeAdjustment(event.type === 'charge.refunded' ? 'refund' : 'dispute', event.data.object as { id: string; charge?: string }));
    return res.json({ received: true });
  }
  if (!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)) return res.json({ received: true });
  const session = event.data.object as { id: string; metadata?: { checkout_id?: string } };
  const id = z.string().uuid().safeParse(session.metadata?.checkout_id);
  if (id.success) {
    const attempt = await paymentRepository.find('id', id.data, 'stripe');
    if (attempt) {
      if (!attempt.provider_session) throw new HttpError(503, 'Checkout initialization is still being recorded; retry delivery');
      if (attempt.provider_session !== session.id) throw new HttpError(400, 'Session does not match checkout');
      await checkoutService.reconcile(attempt);
    }
  }
  res.json({ received: true });
});

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control','no-store'); next(); });
router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }));
router.get('/options', (_req, res) => {
  res.json({ providers: (['paystack','stripe'] as Provider[]).map(id => ({ id, enabled: isSupabaseConfigured() && providerEnabled(id) })) });
});
router.get('/reservation/:code', async (req, res) => {
  const code = String(req.params.code);
  await workspaces.byCode(code);
  const attempt = await paymentRepository.active(code);
  res.json({ attempt: attempt ? publicAttempt(attempt) : null });
});
const input = z.object({ provider: z.enum(['paystack','stripe']), choice: z.enum(['deposit','full']), email: z.string().trim().email().max(254), idempotencyKey: z.string().uuid() }).strict();
router.post('/reservation/:code', async (req, res) => {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Enter a valid email and payment option.');
  const code = String(req.params.code);
  if (!/^[A-Z0-9]{12}$/.test(code)) throw new HttpError(404, 'Reservation not found');
  const { provider, choice, email, idempotencyKey } = parsed.data;
  if (!providerEnabled(provider)) throw new HttpError(503, 'This payment method is not available yet.');
  const attempt = await paymentRepository.reserve({ code, provider, live: liveMode(provider), choice, email: email.toLowerCase(), key: idempotencyKey, returnURL: checkoutOrigin()! });
  const result = await checkoutService.begin(attempt);
  res.json({ attempt: publicAttempt(result), snapshot: publicState(await workspaces.byCode(code), code) });
});
router.post('/reservation/:code/verify', async (req, res) => {
  const id = z.object({ checkoutId: z.string().uuid() }).strict().safeParse(req.body);
  if (!id.success) throw new HttpError(400, 'Invalid checkout reference');
  const code = String(req.params.code);
  const attempt = await paymentRepository.find('id', id.data.checkoutId);
  if (!attempt || attempt.reservation_code !== code) throw new HttpError(404, 'Checkout not found');
  const result = await checkoutService.reconcile(attempt);
  res.json({ attempt: publicAttempt(result), snapshot: publicState(await workspaces.byCode(code), code) });
});
export default router;
