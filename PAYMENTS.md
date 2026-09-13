# Booking payments

Paystack and Stripe use hosted checkout. Secret keys belong only in the backend. No publishable payment key is needed in the frontend. The checkout page fetches provider availability from the backend; Stripe remains visible but disabled until configured.

This implementation collects **NGN booking payments into the platform's merchant account**. Workspace ownership isolates records, but does not automatically split payouts. Paystack subaccounts / Stripe Connect onboarding are separate from this checkout implementation. Do not describe workspace payouts as automatic.

## Enable

1. Apply `supabase/migrations/20260916_checkout.sql` after the earlier migrations. For a fresh database, use `supabase/full_schema.sql`. Neither file resets data.
2. Set the following backend variables, using your actual frontend origin:

   ```dotenv
   PAYMENT_RETURN_URL=https://your-frontend.example
   PAYSTACK_SECRET_KEY=your_paystack_secret_key
   # Leave both blank to keep Stripe disabled:
   STRIPE_SECRET_KEY=
   STRIPE_WEBHOOK_SECRET=
   ENABLE_PAYMENT_RECONCILIATION=true
   ```

3. In Paystack's dashboard, configure the webhook URL as `https://your-backend.example/api/payments/webhooks/paystack`. Paystack signs events with the same secret key. No separate Paystack webhook secret is required.
4. When ready for Stripe, set its secret key and create a webhook destination at `https://your-backend.example/api/payments/webhooks/stripe`. Copy that destination's signing secret into `STRIPE_WEBHOOK_SECRET`. Subscribe to:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`
5. Restart the backend after changing environment variables. Refresh the payment page. The provider becomes enabled without a frontend code change or rebuild. Keep `CLIENT_ORIGIN` consistent with the frontend origin.

`PAYMENT_RETURN_URL` must be an origin with no path or query. Production requires HTTPS and live keys; test keys intentionally do not enable checkout under `NODE_ENV=production`. Use an isolated development/staging database for test payments, and a Stripe account that supports NGN. Never switch an existing checkout between test and live credentials.

Adding environment variables does not configure provider dashboards or apply database migrations: those one-time steps are required. Invalid keys, unsupported merchant capabilities, or missing migrations produce errors rather than simulated payment success.

## Correctness and recovery

- The backend determines deposit/full balance from the reservation. Amounts sent to providers are integer kobo; currency is NGN. Client-supplied amounts are not accepted.
- A database row lock and unique partial index allow one open checkout per booking, including across processes and browser tabs. Repeating a client idempotency key returns its original attempt; multiple keys for the same open choice reuse the active attempt.
- Stripe receives a stable idempotency key. Paystack receives a stable unique transaction reference. Initialization leases prevent concurrent outbound requests. Neither provider gets a fresh charge reference after a timeout.
- A return URL is not proof of payment. The server independently retrieves provider state and checks reference, tenant/booking metadata, amount, currency and test/live mode.
- Raw-body signatures protect webhooks. Stripe's timestamp tolerance rejects stale signed requests. Database settlement deduplicates by attempt and provider transaction, atomically inserts the payment, updates booking status and increments the workspace revision. Old snapshots cannot erase a settled payment.
- Receipt uploads and price edits cannot race an open checkout. Closing the provider tab preserves the original checkout. Stripe's verified expired sessions allow a new attempt. Paystack attempts are not automatically retired on an ambiguous failure or browser cancellation because an old payment link might still accept payment.
- A payment arriving after cancellation is recorded and marked for studio attention; it never reactivates the reservation.
- With `ENABLE_PAYMENT_RECONCILIATION` enabled, the backend checks up to 25 oldest unresolved attempts every five minutes. Failures stay eligible for retries. Webhooks and customer status checks use the same idempotent settlement operation. Keep the backend running for scheduled recovery.
- Refunds are initiated in the provider dashboard. Signed refund/dispute notifications are fetched again from the provider, deduplicated, and recorded atomically. Net paid totals exclude refunded funds and disputed payments. Refund/dispute bookings pause further checkout; disputes remain flagged for operator review even after closure, to avoid automatically collecting money again.

## Operator attention

For an initialization whose provider response and checkout URL were lost, the original reference remains reserved. Retry the same checkout. If the provider cannot return the original checkout, reconcile it in the provider dashboard before altering the record. **Do not delete an open attempt or mark it expired just to unblock a customer**: its original link might still accept money. Stripe initialization is not replayed after 23 hours because its idempotency retention is finite. Webhook deliveries that arrive before initialization/settlement return a retryable error.

Inspect `checkout_attempts.needs_review` and the Payments page's **Needs attention** filter for late payments, refunds and disputes. Provider references are retained on payment records. Business owners cannot edit verified gateway amounts or refund/dispute flags through workspace saves. This release does not initiate refunds, automatically resolve disputes, or move funds between workspace accounts.

## Verification

```sh
pnpm test
pnpm test:payments:db
```

The database suite requires local PostgreSQL executables (`initdb`, `pg_ctl`, `psql`). It creates and removes its own isolated cluster; it does not use your Supabase credentials. It checks replay-safe migration, row locks under simultaneous requests, duplicate settlement, wrong amounts/currencies, receipt and price-change races, refunds, cancelled bookings and function permissions.

Before accepting live payments, complete a sandbox booking with each enabled provider and confirm webhook delivery, a return without success parameters, closing the tab before return, payment failure, partial refund and duplicate delivery. Automated tests use mocked provider responses; they do not certify live merchant credentials. Browser visual verification was unavailable in this session.

Provider references: [Paystack verification](https://paystack.com/docs/payments/verify-payments/), [Paystack webhooks](https://paystack.com/docs/payments/webhooks/), [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment), [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).
