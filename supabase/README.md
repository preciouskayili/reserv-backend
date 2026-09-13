# Installing the database

Use `backend` as the Supabase working directory. Do not run the CLI from `backend/src`.

For the SQL Editor, run the complete `full_schema.sql` file as the database owner. It includes the base tables before the workspace migrations and does not insert the Bloom sample studio. A project that already has these tables can run it again. It does not reset the database.

For the CLI, from the backend directory:

```sh
pnpx supabase link --project-ref YOUR_PROJECT_REF
pnpx supabase db push --dry-run
pnpx supabase db push
```

Use your Supabase **database password** when prompted. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are API credentials and do not authenticate the PostgreSQL connection. For automation, the CLI reads SUPABASE_DB_PASSWORD from the shell environment; putting it in an arbitrary .env file does not automatically export it to the CLI. Do not put a real password directly in command history.

If linking created `.temp` files under `src/supabase`, link again from `backend`; those files are not the migrations. A connection-terminated/temp-role error occurs before any SQL executes. Confirm the database password, project status and database connection settings in the dashboard. Do not use `db reset` to solve this.

If migrations were already run using SQL Editor, review the remote migration history before using CLI push. Use Supabase's migration repair workflow only for migrations you have verified were applied.

The backend deliberately reports an unavailable database instead of silently saving live workspace data to a local file. Any earlier local data file is left untouched and is not automatically imported or assigned to another account.

Reference: https://supabase.com/docs/reference/cli/supabase-db-push

## Verification and launch status

The combined SQL was checked against isolated PostgreSQL, including a second application, workspace creation, revision conflicts, OTP cooldown, wrong codes and replay rejection. This does not verify your hosted Supabase instance. The local check supplies placeholder Supabase roles and a storage bucket table; storage uploads require a live integration check.

Before launching, apply the migration in your project and verify a new account can create a workspace, book through its public link, upload a transfer receipt and review that receipt as its owner. Verify email delivery from your own approved sender. Online gateway checkout is disabled until a payment provider is integrated. Configure the registered Aethex outbound number and agent before enabling automatic calls. Browser-based desktop/mobile visual checks remain outstanding.

## Environment keys

- `SUPABASE_URL`: your project's API endpoint; it is not a PostgreSQL connection string.
- `SUPABASE_SERVICE_ROLE_KEY`: backend-only database and private storage access. Never expose it in frontend variables.
- `SUPABASE_ANON_KEY`: not required by this backend's server-mediated workspace flow.
- `SUPABASE_DB_PASSWORD`: database password used by the migration CLI, exported in your terminal when needed. This is separate from the API keys.
- `JWT_SECRET`: a strong random secret of at least 32 characters for session signatures.
- `RESEND_API_KEY` and `EMAIL_FROM`: email delivery credentials and verified sender for sign-in codes.
- `AETHEX_API_KEY`, `AETHEX_AGENT_ID`, `AETHEX_FROM_NUMBER`: voice provider access, configured agent and registered outgoing number.
- `AETHEX_WEBHOOK_SECRET`: shared secret checked on incoming call updates.
- `ENABLE_CALL_SCHEDULER`, `CALL_REMINDER_CRON`, `CRON_SECRET`: automatic reminder enablement, schedule and authenticated external trigger.
- `CLIENT_ORIGIN`: allowed frontend origins; `TRUST_PROXY_HOPS`: your deployment's actual reverse proxy depth.
- `CLOUDINARY_*`: optional business image asset uploads. Payment receipts use private Supabase Storage.

There is no owner-email allowlist: anyone can sign in and create a workspace. Ownership comes from workspace membership, not an environment variable.
