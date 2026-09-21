# Release notes: onboarding, profiles, themes, and voice follow-ups

Deploy the frontend and backend together. The workspace JSON now retains `business.logoUrl`, `business.icon`, `staff[].avatarUrl`, and `settings.ownerStaffId`. Existing workspaces remain compatible. No new database migration is required for this release; the existing workspace and operations migrations must be installed.

## Behaviour

- `/onboarding` replaces workspace creation dialogs. It collects the owner's full name and optional photo, the business details and optional logo/icon, and the first service. New-workspace links use this route too.
- Settings edits the owner's staff photo and name, business identity, and Light / Dark / System appearance. Appearance persists in the browser. Photos also appear on public staff profiles and booking details.
- `POST /api/upload/image` requires authentication but not a workspace, accepts actual JPG/PNG/WebP bytes up to 5 MB, and saves resized WebP images through Cloudinary. Payment receipts retain their existing private upload flow.
- Booking reminders and unpaid follow-ups are independent. The first unpaid call is eligible one interval after booking creation; later attempts wait the configured interval. Follow-ups stop at the required payment amount, cancellation, completion, or the appointment start, and pause while any payment is under review.
- Dispatch claims use the existing `reminder_claims` text key. Unpaid attempts use `unpaid:` keys; a shared `dispatch:` key prevents concurrent workers from sending a reminder and payment call together. Claims are retained after provider timeouts to avoid immediate redial. There is a five-minute minimum gap between automated calls to the same booking.
- The current assistant reminds customers and discusses the supplied appointment details. It does not change bookings or save customer confirmation automatically.

## Deployment configuration

Image uploads require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the backend. The authenticated ping and a complete onboarding upload succeeded against the locally configured account. A synthetic PNG was uploaded through the authenticated endpoint before workspace creation, converted to WebP, retrieved, and deleted.

Automatic calling requires the Aethex key, agent ID, registered outbound number, `ENABLE_CALL_SCHEDULER=true`, and persistent access to `reminder_claims`. The default schedule checks every five minutes. API credentials and table access were verified locally; no customer call was placed during these checks.

The Aethex agent's `webhook_url` must point to `https://YOUR_BACKEND/api/calls/webhook`. Set `AETHEX_WEBHOOK_SECRET` to the **Aethex tenant signing secret**, not an independently generated shared header value. The receiver verifies `X-Aethex-Signature` against the raw body and rejects timestamps outside five minutes. It handles `call.ended` and `recording.ready` independently. See [Aethex's webhook specification](https://developers.aethexai.com/docs/concepts/webhooks). The deployed webhook URL and signing-secret match have not been verified.

Locally, `PAYSTACK_SECRET_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` are absent. Hosted online checkout remains disabled until a provider is configured; see [PAYMENTS.md](PAYMENTS.md). Never place these credentials in frontend variables.

## Validation

Frontend production build and ESLint pass. Backend build and 22 tests pass, covering workspace isolation, image-field persistence, image rejection, payment verification, follow-up timing/concurrency, and signed call events. Cloudinary responded successfully; hosted `workspace_state`, `reminder_claims`, and `login_challenges` were accessible.

Rendered desktop/mobile checks in both themes remain outstanding because no Browser connection was available. Email delivery, payment settlement, and real calls were not exercised in this release pass. This is not a claim that production deployment has been verified.
