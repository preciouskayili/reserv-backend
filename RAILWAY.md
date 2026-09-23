# Deploy Reserv to Railway

Create two persistent services, one from each repository: `backend` and `frontend`. These are separate Git repositories, so each service uses its repository root. Keep the existing Supabase project and private receipts bucket; no Railway disk is needed for uploads.

## Service settings

| Setting | Backend | Frontend |
| --- | --- | --- |
| Build | `pnpm install --frozen-lockfile && pnpm build` | `pnpm install --frozen-lockfile && pnpm build` |
| Start | `pnpm start` | `pnpm start` |
| Health check | `/health` | `/login` |
| Restart policy | Always | Always |
| Serverless / sleeping | **Disabled** | Disabled for initial launch |
| Replicas | 1 initially | 1 initially |

Use a supported Node 22.13+ runtime and pnpm 11.9.0. Leave Railway's `PORT` variable in place. Generate HTTPS domains for both services before building the frontend. Do not configure a Railway cron schedule on the backend service: its Node scheduler runs inside the persistent API process.

Railway's health check checks deployment startup, not continuous uptime. Monitor `/health` externally and inspect the protected `/api/calls/cron/status` endpoint using `x-cron-secret`. The default call check should advance about every five minutes; alert if it stops advancing for ten minutes. Scheduler outcomes are written to backend logs. A process restart performs an immediate reminder check, but a booking whose appointment has already started is never called retrospectively.

See Railway's current [persistent service guidance](https://docs.railway.com/build-deploy), [sleep settings](https://docs.railway.com/deployments/serverless), and [health-check behavior](https://docs.railway.com/deployments/healthchecks). Settings are documented here instead of introducing a new legacy `railway.json`; Railway has deprecated that format for new configuration.

## Backend variables

Copy private credentials into Railway Variables, never the frontend repository or build variables.

- `NODE_ENV=production`
- `CLIENT_ORIGIN=https://YOUR_FRONTEND_DOMAIN` (comma-separated exact origins if needed)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`: a stable random secret of at least 32 characters
- `RESEND_API_KEY`, `EMAIL_FROM`: use an address on your verified Resend domain, not `onboarding@resend.dev`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `AETHEX_API_KEY`, `AETHEX_AGENT_ID` (template for new business agents)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; the same Twilio account must be connected in Aethex
- `ENABLE_CALL_SCHEDULER=true`, `CALL_REMINDER_CRON=*/5 * * * *`
- `CRON_SECRET`: a separate random secret for administrative scheduler endpoints
- `AETHEX_PUBLIC_WEBHOOK_URL=https://YOUR_BACKEND_DOMAIN/api/calls/webhook`
- `AETHEX_WEBHOOK_SECRET`: the Aethex tenant signing secret
- `VOICE_TOOLS_SECRET`: a separate random secret of at least 32 characters (`openssl rand -hex 32`). It authenticates the booking tools each business agent calls during a phone call. Production startup refuses to run without it when `AETHEX_API_KEY` is set.
- `TRUST_PROXY_HOPS`: the actual number of trusted reverse proxies in your deployment. Confirm against the deployed network path; don't blindly trust all forwarded headers.

Dedicated business numbers and agents are stored in Supabase. `AETHEX_FROM_NUMBER` is a legacy fallback and is not required by the automatic scheduler when businesses have their own active numbers. Number-country choice does not change appointment timezone: the current application schedules in WAT (UTC+01:00), with NGN prices.

Within a minute of startup, the backend updates every active business agent (including the existing Kingz Cuts agent) with the current prompt, webhook URL, transfer number (the business phone) and booking tools. It repeats this whenever the business phone, name, `VOICE_TOOLS_SECRET` or `AETHEX_PUBLIC_WEBHOOK_URL` changes. A failed update is logged and retried after 15 minutes. Verify a signed call event reaches the deployed endpoint. Call-history polling repairs missed status events but does not replace recording/transcript webhooks.

For hosted payment checkout, also configure `PAYMENT_RETURN_URL=https://YOUR_FRONTEND_DOMAIN` and Paystack or Stripe credentials as described in [PAYMENTS.md](PAYMENTS.md). Without them, online payment buttons stay unavailable and transfer receipt submission remains available. Stripe also needs its webhook signing secret. Configure the production provider webhook endpoints before accepting online payments.

Run `pnpm check:production` with the intended deployment variables. It checks variable presence and safe production settings without contacting providers, placing calls, purchasing numbers, or sending email. A pass is configuration validation, not proof of successful delivery.

## Frontend variables

Set `NEXT_PUBLIC_API_URL=https://YOUR_BACKEND_DOMAIN` **before building**. Next.js embeds this URL in browser assets; changing it requires a rebuild. The Railway build now rejects a missing or local backend URL.

Set `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` if using location search. Restrict this browser key to your production frontend domain and the required Maps APIs. Never add backend service-role, payment, Twilio, email, or voice secrets here.

## Release checks on the deployed domains

1. Run `pnpm test` and `pnpm test:payments:db` in the backend, and `pnpm build` / `pnpm lint` in the frontend. The database test uses an isolated temporary local PostgreSQL instance.
2. Apply `supabase/migrations/20260922_inbound_calls.sql` (it only widens the allowed call types, so inbound calls can be logged), and confirm the existing Supabase schema and operations/payment migrations are installed. Do not reset or replace the production database. Check private receipt uploads and signed owner-only receipt access.
3. Sign in with a real email address, complete onboarding, then reload. Verify name, profile photo, business icon/logo, and theme persist and appear on the public business page.
4. Book an appointment with a phone you control, with enough time before its start for the configured reminder. Leave the laptop/backend dev process off. Confirm the deployed scheduler places one call and its final status appears in Reserv.
5. Call the business number from a phone you control. Ask for the address and opening hours, ask for open times, book an appointment, then call again to reschedule and cancel it. Confirm each change appears on the calendar and under Settings → agent activity, and that the call appears in call logs as an incoming call. Ask to speak to a person to check transfer.
6. Check number provisioning with a deliberate test business if needed: it purchases a paid Twilio number. Existing active businesses must keep their current numbers on retries/restarts.
7. If enabling online checkout, verify a payment through its signed webhook and confirm that a duplicate event does not duplicate payment. Start with provider test mode; complete a controlled live check before taking customer payments.
8. Check booking, rescheduling, cancellation, payments, onboarding, and Settings on mobile and desktop in both themes. Confirm new public bookings appear on the owner's calendar without a reload.

Do not mark the release verified until these checks pass on the deployed URLs.
