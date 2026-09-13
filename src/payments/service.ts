import { HttpError } from '../domain/workspace.js';
import { paymentRepository } from './repository.js';
import { initializeProvider, verifyProvider, type Attempt } from './providers.js';

// Dependencies are explicit so failures and callback/webhook races can be tested without live money.
export class CheckoutService {
  constructor(private repo = paymentRepository, private initialize = initializeProvider, private verify = verifyProvider) {}
  async reconcile(attempt: Attempt): Promise<Attempt> {
    if (attempt.status === 'succeeded' || attempt.status === 'expired') return attempt;
    const result = await this.verify(attempt);
    if (result.paid) {
      if (!result.transaction || !Number.isSafeInteger(result.amount) || result.amount !== attempt.amount_minor || result.currency !== attempt.currency || result.live !== attempt.live_mode) throw new HttpError(409, 'Payment verification did not match the expected amount, currency or environment. Contact the studio.');
      return this.repo.settle(attempt.id, result);
    }
    if (result.expired && attempt.provider === 'stripe') {
      await this.repo.expire(attempt.id);
      return { ...attempt, status: 'expired' };
    }
    return attempt;
  }
  async begin(attempt: Attempt): Promise<Attempt> {
    if (attempt.status === 'succeeded' || attempt.status === 'expired') return attempt;
    if (attempt.checkout_url) return this.reconcile(attempt);
    if (!await this.repo.claim(attempt.id)) throw new HttpError(409, 'Checkout is being prepared. Please wait a minute, then retry.');
    try {
      const result = await this.initialize(attempt);
      await this.repo.initialized(attempt.id, result.session, result.url);
      return (await this.repo.find('id', attempt.id))!;
    } catch (error) {
      // A timeout is ambiguous. Keep the durable reference and lease, and check for payment.
      // Never release this booking to a second provider just because a network request failed.
      try { const verified = await this.reconcile(attempt); if (verified.status === 'succeeded') return verified; } catch { /* Original request error is more useful. */ }
      throw error;
    }
  }
}
export const checkoutService = new CheckoutService();
export const publicAttempt = (a: Attempt) => ({ id: a.id, provider: a.provider, choice: a.choice, amount: a.amount_minor / 100, status: a.status, url: a.status === 'pending' ? a.checkout_url : null, needsReview: a.needs_review });
