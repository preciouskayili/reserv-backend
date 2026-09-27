# Customer readiness review — 27 September 2026

The current local changes pass automated validation. The production backend at `https://reserv-backend-production-3134.up.railway.app` passes read-only deployment checks, but this is not a verified production launch. The phone setup and frontend changes below still need deployment. No production frontend URL or Browser connection was available; live sign-in, receipt review and calls remain unverified. The local development environment is not evidence of deployed configuration. The earlier audit below is historical.

## Automatic phone setup and transfer-only launch

- Phone setup is automatic, limited to one dedicated number per business. Concurrent workers and repeat requests reuse the assignment; failed registration retries use the existing purchase, and uncertain purchases are reconciled before any new attempt. Workspace edits cannot forge or replace phone assignments. Country changes after a purchase starts are rejected.
- Onboarding remains available without a phone number. There is no manual approval step or approval environment variable. No new database migration is needed. The limit is per business; users may create multiple businesses, and call spending is not metered by this change.
- Disabled Stripe/Paystack choices are hidden; transfer receipts remain available. Existing unfinished checkouts still prevent a second payment method until resolved. Businesses must share their transfer details directly with customers.
- `/health` now reports the deployed Railway commit as `release`. `pnpm check:deployment BACKEND [FRONTEND]` checks health, private-route authentication, a public database lookup, payment options, and optionally frontend login availability and CORS. `EXPECTED_RELEASE` enables an exact commit check.
- Latest checks: backend build and **55 tests**, frontend lint/build and **12 tests** pass. Coverage includes eight concurrent provisioning requests, repeated setup requests, rejected country changes after purchase, existing-number registration, and forged workspace phone fields.
- The live read-only check passed health, private-route protection, a public database read, and payment options. Both hosted payment providers are disabled as intended. Production did not yet report a release SHA, so the updated source has not been verified on Railway.

Setup and deployment instructions are in [RAILWAY.md](RAILWAY.md). These changes are local and uncommitted alongside the earlier voice changes; deploy both repositories together before treating them as active safeguards. Interactive browser QA could not run because no browser was connected. No email, call, number purchase, payment, or production database write was performed.

## Current changes

- The provider's first message is now `{{opening_message}}`. Inbound defaults welcome callers and invite inquiries. Every scheduled or on-demand outbound call supplies a business introduction and named identity check, for example: “Hello, this is the virtual receptionist calling from Bloom Studio. Am I speaking with Ada Okafor?” Appointment or payment details follow identity confirmation.
- The prompt explicitly receives call type, customer, appointment, reference, test mode and transfer availability. It separates reminders, confirmations, payment follow-ups and general follow-ups, with instructions for wrong numbers, voicemail, busy recipients, refunds, failures and human transfer.
- Booking calls derive contact details, service and WAT date/time from the saved reservation. Stale contact numbers, cancelled/completed/past bookings and opted-out numbers are refused. Caller-supplied prompt overrides cannot replace the greeting or test mode.
- Inbound tools support business information, services, prices, policies, availability, booking, reference lookup, rescheduling, cancellation, payment status and attendance. Availability handles ambiguous specialists and can exclude the booking being moved without excluding other conflicts. Public booking validation rejects impossible calendar dates and invalid phone numbers.
- Payment answers distinguish the deposit needed to secure the booking from the full remaining balance. Pending bookings are described as pending payment. A receipt under review is not described as unpaid, and attendance does not approve a payment.
- Wrong-number and stop-call requests persist `customers[].voiceCallsBlocked` in workspace JSON and suppress future outbound calls to that number across matching customer profiles. They do not cancel bookings. An unknown number gets a contact record solely to retain the preference; anonymous callers are directed to the business.
- Settings practice calls have an explicit test flag, use an entered destination instead of a prefilled sample number, and cannot use customer booking, payment or preference tools. The sample appointment is labelled in the form.
- Accepted calls remain successful even if history storage fails; uncertain transport errors advise checking history before redialling. The frontend call timeout is longer than the provider request timeout.
- Agent sync checks run immediately on startup, then every minute, and skip unchanged configurations. Existing agents can sync without Twilio purchasing credentials. Newly created agents receive booking tools before registration. Self-transfers are disabled, and verified call contexts expire after 30 seconds.
- Both repositories pin pnpm 11.11.0. The previous backend pin had three high-severity advisories; the updated production dependency audits pass. The application dependency versions are unchanged.

Aethex documents first-message interpolation and agent defaults in its [personalization guide](https://developers.aethexai.com/docs/concepts/personalization). The pnpm fixes are described in [the proxy configuration advisory](https://github.com/advisories/GHSA-vx52-2968-3vc6), [the linker traversal advisory](https://github.com/advisories/GHSA-c59q-g84q-2gj5), and [the tarball manifest advisory](https://github.com/advisories/GHSA-vq4v-j7r6-jq4m).

## Verified in this pass

- Backend build and **55 tests**: one-number provisioning, voice context, tools, call dispatch, scheduling, provisioning/sync, authentication, tenant isolation, booking conflicts, public privacy, payments and signed webhooks.
- Frontend lint, production build and **12 tests**: action locks, session/navigation handling, API failures, uncertain call dispatch and payment calculations.
- Isolated PostgreSQL suite: repeat migrations, payment invariants, refunds, eight concurrent checkout starts, eight concurrent settlements and function permissions.
- Frozen lockfile installation and production dependency audits for both repositories.
- No customer was called, no message was sent, no number was purchased, and no live database or deployed agent was changed in this pass. Prompt and tool tests do not verify live speech recognition, conversation quality or phone-network delivery.

## Remaining release work

`pnpm check:production` rejects the current local environment for five reasons:

1. `JWT_SECRET` is unsuitable for production.
2. `CLIENT_ORIGIN` contains development origins instead of only deployed HTTPS origins.
3. `EMAIL_FROM` uses the default Resend domain instead of a verified sender.
4. `AETHEX_PUBLIC_WEBHOOK_URL` is absent.
5. `VOICE_TOOLS_SECRET` is absent.

Configure these on the deployment and run the preflight there. Do not infer the deployed settings from the laptop's `.env`. Online-checkout credentials are also absent locally, so hosted checkout remains unavailable unless configured on deployment; transfer receipts are the fallback.

Deploy both repositories together. The new optional call preference lives in existing workspace JSON and needs no new migration. Confirm all existing migrations, especially `20260922_inbound_calls.sql`, are already installed. With the voice variables configured, the backend applies the new opener and tools to active agents automatically. Check the stored `business.voice.agentConfig` against the current fingerprint before release.

Complete the deployed checks in [RAILWAY.md](RAILWAY.md): real email sign-in, mobile/desktop booking and payment screens, public booking through an independent owner session, controlled inbound/outbound calls, wrong-number/opt-out handling, voicemail, human transfer, signed call history, scheduler uptime, and payment settlement if online checkout is enabled. Use phones and test records under the team's control. Caller-ID lookup is convenience identity, not strong authentication; possession of the booking reference remains equivalent to the web management link.

---

# Earlier production audit — 22 September 2026

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
