# Production audit — 22 September 2026

The source checks pass, but deployment is not yet verified. Follow [RAILWAY.md](RAILWAY.md) for deployment settings and release checks. The current local configuration fails the production preflight: its JWT secret is unsuitable for production, browser origins point to localhost, and the email sender uses Resend’s default domain. Configure a strong production JWT secret, the deployed HTTPS frontend origin, and a verified email sender before starting in production. A public Aethex webhook URL and online-checkout credentials are also absent locally.

## Missed reminder investigation

The Kingz Cuts reservation was at 10:15am WAT on 22 September, with a two-hour reminder preference. No automatic dispatch claim exists for that booking. The backend was running on the laptop, whose sleep log shows sleep around the expected reminder window; the owner confirmed the server was down. The previous evening’s manual call was reported as busy by Aethex, with zero duration. Its stored queued status has been corrected to busy without placing a new call. The business’s dedicated number and agent were active when checked.

## Fixes from this audit

- Call history now refreshes active provider calls, including connected calls, and retains terminal webhook results when an older poll returns. Provider outages preserve stored history. Refresh work per list request is bounded.
- The automatic scheduler checks immediately on startup, uses business-specific numbers without requiring a global fallback number, logs check outcomes, and returns an error response for failed administrative runs. Settings shows whether automatic calling is available.
- The API limit permits normal polling; OTP and manual-call requests have separate stricter limits. Real OTPs are never returned in development responses.
- Receipt balance validation subtracts refunds and excludes disputed payments.
- Calendar time updates during long sessions, slot calculations use explicit WAT offsets, and the owner workspace refreshes periodically and on focus without replacing a pending save.
- A country change before a number purchase clears the previous selected number. Provisioning tests cover concurrent setup, uncertain purchases, registration retries, and verification requirements without spending money.
- Production startup validates core configuration; Railway frontend builds reject missing or local backend URLs.

## Existing onboarding, profile, theme, and voice changes

Deploy the frontend and backend together. The workspace JSON now retains `business.logoUrl`, `business.icon`, `staff[].avatarUrl`, `settings.ownerStaffId`, and `business.voice.agentConfig`. Existing workspaces remain compatible. Apply `supabase/migrations/20260922_inbound_calls.sql` (also appended to `full_schema.sql`) before deploying; without it, incoming calls cannot be written to call history.

## Behaviour

- `/onboarding` replaces workspace creation dialogs. It collects the owner's full name and optional photo, the business details and optional logo/icon, and the first service. New-workspace links use this route too.
- Settings edits the owner's staff photo and name, business identity, and Light / Dark / System appearance. Appearance persists in the browser. Photos also appear on public staff profiles and booking details.
- `POST /api/upload/image` requires authentication but not a workspace, accepts actual JPG/PNG/WebP bytes up to 5 MB, and saves resized WebP images through Cloudinary. Payment receipts retain their existing private upload flow.
- Booking reminders and unpaid follow-ups are independent. The first unpaid call is eligible one interval after booking creation; later attempts wait the configured interval. Follow-ups stop at the required payment amount, cancellation, completion, or the appointment start, and pause while any payment is under review.
- Dispatch claims use the existing `reminder_claims` text key. Unpaid attempts use `unpaid:` keys; a shared `dispatch:` key prevents concurrent workers from sending a reminder and payment call together. Claims are retained after provider timeouts to avoid immediate redial. There is a five-minute minimum gap between automated calls to the same booking.
- Customers can call a business's dedicated number. The agent answers questions about the address, opening hours, services, prices and policies. It checks real availability, books, reschedules and cancels appointments, reports payment status, and records attendance confirmations. It can also transfer callers to the business phone. Outbound reminder calls use the same tools and include the booking reference.
- Tool requests go to `POST /api/voice/tools/:businessId/:tool`. Each business agent sends an HMAC key derived from `VOICE_TOOLS_SECRET`, and every request must belong to a live Aethex call on that business's own agent. The customer's phone number comes from the provider's call record, not the model. Callers can manage bookings found for their calling number, or any booking whose 12-character reference they give; this matches the web reservation link. Caller ID can be spoofed, so treat phone-number lookup as convenience, not strong identity.
- The agent cannot take payments or send texts. After booking, it reads the reference aloud, and the customer pays from their booking page. Voice actions appear in booking history as "Receptionist" and under Settings → agent activity.
- Active agents are updated automatically, as described in [RAILWAY.md](RAILWAY.md).

## Deployment configuration

Image uploads require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the backend. The authenticated ping and a complete onboarding upload succeeded against the locally configured account. A synthetic PNG was uploaded through the authenticated endpoint before workspace creation, converted to WebP, retrieved, and deleted.

Automatic calling requires the Aethex key, an active dedicated number and agent for each business, `ENABLE_CALL_SCHEDULER=true`, and persistent access to `reminder_claims`. The default schedule checks every five minutes. API credentials and table access were verified locally; no customer call was placed during these checks.

The Aethex agent's `webhook_url` must point to `https://YOUR_BACKEND/api/calls/webhook`. Set `AETHEX_WEBHOOK_SECRET` to the **Aethex tenant signing secret**, not an independently generated shared header value. The receiver verifies `X-Aethex-Signature` against the raw body and rejects timestamps outside five minutes. It handles `call.ended` and `recording.ready` independently. See [Aethex's webhook specification](https://developers.aethexai.com/docs/concepts/webhooks). The deployed webhook URL and signing-secret match have not been verified.

Locally, `PAYSTACK_SECRET_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` are absent. Hosted online checkout remains disabled until a provider is configured; see [PAYMENTS.md](PAYMENTS.md). Never place these credentials in frontend variables.

## Validation

Frontend production build and ESLint pass. Backend build and 31 tests pass, covering workspace isolation, image-field persistence, image rejection, payment verification, follow-up timing/concurrency, and signed call events. Cloudinary responded successfully; hosted `workspace_state`, `reminder_claims`, and `login_challenges` were accessible.

The isolated PostgreSQL payment suite passes repeat migrations, concurrent checkout starts/settlements, refunds, and function permissions. Both production dependency audits report no known vulnerabilities. `pnpm check:production` correctly rejects the current local development settings.

Rendered desktop/mobile checks in both themes remain outstanding because no Browser connection was available. Email delivery, payment settlement, and real calls were not exercised in this release pass. This is not a claim that production deployment has been verified.
