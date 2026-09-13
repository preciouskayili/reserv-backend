import cron, { type ScheduledTask } from 'node-cron';
import { isSupabaseConfigured } from '../lib/supabase.js';
import { providerEnabled } from './providers.js';
import { paymentRepository } from './repository.js';
import { checkoutService } from './service.js';
let task: ScheduledTask | null = null;
let running = false;
export async function reconcilePayments() {
  if (running || !isSupabaseConfigured()) return;
  running = true;
  try {
    for (const attempt of await paymentRepository.pending()) {
      try {
        // Move every attempted check to the end so one unavailable provider cannot starve the queue.
        await paymentRepository.touched(attempt.id);
        if (providerEnabled(attempt.provider)) await checkoutService.reconcile(attempt);
      } catch { console.error('Payment reconciliation will retry checkout', attempt.id); }
    }
  } catch { console.error('Payment reconciliation storage unavailable'); }
  finally { running = false; }
}
export function startPaymentReconciliation() {
  if (task || process.env.ENABLE_PAYMENT_RECONCILIATION === 'false' || !isSupabaseConfigured() || !['paystack','stripe'].some(p => providerEnabled(p as 'paystack' | 'stripe'))) return;
  task = cron.schedule('*/5 * * * *', () => { void reconcilePayments(); });
}
export function stopPaymentReconciliation() { task?.stop(); task = null; }
