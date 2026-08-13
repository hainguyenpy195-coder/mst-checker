# Supabase setup

## Migration

Run all five migration files in the Supabase SQL Editor, in order. The second
migration adds the previous-check timestamp, yearly source index and the
service-role refresh request function used by the Vercel API. The third keeps
the older due-date helper for compatibility. The fourth adds targeted claims
and the monthly dispatcher. The fifth ensures retry jobs are not starved by
the initial backfill queue.

## Initial data

Keep the real workbook outside Git. From the project root, generate a local seed:

```powershell
npm run generate:seed -- --input ".\2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx"
```

Review `supabase/seed.sql` and run it privately in the target Supabase project. The generated file is ignored by Git because the public repository must not contain taxpayer data.

## Application login

The internal deployment intentionally does not use Supabase Auth. Vercel checks
`APP_LOGIN_USERNAME` and `APP_LOGIN_PASSWORD`, then issues a signed httpOnly
cookie using `APP_SESSION_SECRET`. Database requests are made only by Next.js
server routes with `SUPABASE_SECRET_KEY`.

## XInvoice worker

Deploy `functions/xinvoice-refresh` and set the following Edge Function secret:

- `REFRESH_WORKER_SECRET`

The XInvoice tax-payer endpoint is public and does not require `client-id` or
`api-key`. The worker sends only the requested tax code and an `Accept` header.
If XInvoice returns a temporary error or rate limit, the worker makes one
fallback request to the public VietQR business endpoint. VietQR only supplies
partial business information, so missing fields such as organization type and
tax department remain unchanged in the database.

Deploy the function with JWT gateway verification disabled because the cron call
uses the dedicated `x-refresh-secret` header:

```powershell
supabase functions deploy xinvoice-refresh --no-verify-jwt
```

Then adapt `cron.sql` to the project URL and run it. The monthly dispatcher
enqueues all taxpayers at 12:00 Vietnam time on the first day of each month;
the minute-level drain only claims work while the queue is non-empty. This
drain also completes the first backfill already placed in the queue by the
seed. A manual refresh or a newly added MST sends a targeted `taxCode` request
and the worker claims only that one code. The worker claims at most ten batch
rows per invocation and uses retry/backoff. It must not be configured to
bypass XInvoice limits or use rotating proxies.

Hosted Edge Functions provide `SUPABASE_SECRET_KEYS` as a JSON dictionary and
the worker reads its `default` entry. It also accepts the singular
`SUPABASE_SECRET_KEY` for local/server runtimes and the legacy
`SUPABASE_SERVICE_ROLE_KEY` during migration.
