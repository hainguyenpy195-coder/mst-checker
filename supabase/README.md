# Supabase setup

## Migration

Run all migration files in the Supabase SQL Editor, in order. The second
migration adds the previous-check timestamp, yearly source index and the
service-role refresh request function used by the Vercel API. The third keeps
the older due-date helper for compatibility. The fourth adds targeted claims
and the monthly dispatcher. The fifth ensures retry jobs are not starved by
the initial backfill queue. The eighth disables the old scheduled refresh
jobs; refreshes are now started manually from the application. The ninth adds
legacy short-lived server-side sessions for the previous Cục Thuế CAPTCHA flow.
The invoice migrations add provider-specific lookup URL and lookup code fields;
the current invoice UI opens those provider pages because each provider can use
a different CAPTCHA mechanism.
Migration `202608140007_taxpayer_excel_import.sql` adds the atomic bulk-import
function and targeted worker queue claim used by the Excel import workflow.

## Initial data

Keep the real workbook outside Git. From the project root, generate a local seed:

```powershell
npm run generate:seed -- --input ".\2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx"
```

Review `supabase/seed.sql` and run it privately in the target Supabase project. The generated file is ignored by Git because the public repository must not contain taxpayer data.

## Application login

The internal deployment intentionally does not use Supabase Auth. Vercel checks
`APP_LOGIN_USERNAME` and `APP_LOGIN_PASSWORD` for the administrator account,
then issues a signed httpOnly cookie using `APP_SESSION_SECRET`. The optional
`APP_READONLY_USERNAME` and `APP_READONLY_PASSWORD` configure the readonly
account. Database requests are made only by Next.js server routes with
`SUPABASE_SECRET_KEY`.

The readonly account can view/search the taxpayer and invoice data and import
invoices. Invoice import never creates a missing taxpayer or starts a taxpayer
refresh; the invoice table marks that seller as missing from the aggregate
taxpayer database so an administrator can add and refresh it separately.

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

Run migration `202608130008_manual_refresh_only.sql` (or `cron.sql`) to remove
the old scheduled jobs. Refreshes are started manually from the application:
the overview button queues the full catalogue and drains it in batches, while
the row button sends a targeted `taxCode` request. Excel import sends only the
new MST codes from the workbook through targeted batches. The worker claims at
most ten batch rows per invocation and uses retry/backoff. It must not be
configured to bypass XInvoice limits or use rotating proxies.

## Taxpayer Excel import

The administrator can use **Nhập Excel** on the overview or yearly list. Each
worksheet must be named with a four-digit year or an update label in the form
`T{month}-{year}` (for example `T2-2026`, `T6-2026`, or `T9-2026`). The
importer normalizes both forms to the four-digit year, detects unit headings
such as `I | XƯỞNG DVKT`, and reads all worksheets using only the `Mã số thuế`
column for taxpayer data; other Excel columns are ignored. The master
`taxpayers` table remains one row per MST, while `taxpayer_sources` keeps every
year/unit/source-row occurrence, including MSTs that already exist in the
master table. The yearly view and exports can therefore reproduce the source
workbook grouping, while the overview still deduplicates by MST. Existing MSTs
and invalid rows are reported separately. Large workbooks are uploaded directly
to the private
`taxpayer-imports` Storage bucket; the Vercel API receives only the import
session ID. A completed workbook import is also recorded as an
`excel_imported` event in `taxpayer_activity_logs`.

Hosted Edge Functions provide `SUPABASE_SECRET_KEYS` as a JSON dictionary and
the worker reads its `default` entry. It also accepts the singular
`SUPABASE_SECRET_KEY` for local/server runtimes and the legacy
`SUPABASE_SERVICE_ROLE_KEY` during migration.
