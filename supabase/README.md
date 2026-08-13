# Supabase setup

## Migration

Run `migrations/202608130001_initial_schema.sql` in the Supabase SQL Editor. It creates the taxpayer tables, the approval profile workflow, RLS policies and the refresh queue functions.

## Initial data

Keep the real workbook outside Git. From the project root, generate a local seed:

```powershell
npm run generate:seed -- --input ".\2023, 2024, 2025, T2-26 (Trụ sở chính).xlsx"
```

Review `supabase/seed.sql` and run it privately in the target Supabase project. The generated file is ignored by Git because the public repository must not contain taxpayer data.

## Auth approval

The database trigger creates a `profiles` row with `approval_status = 'pending'` when a user signs in for the first time. An administrator can approve the user in the Table Editor:

```sql
update public.profiles
set approval_status = 'approved', approved_at = now()
where email = 'user@example.com';
```

For the first administrator, update the role and approval status directly from the SQL Editor after verifying the account email.

## XInvoice worker

Deploy `functions/xinvoice-refresh` and set the following Edge Function secrets:

- `XINVOICE_CLIENT_ID`
- `XINVOICE_API_KEY`
- `REFRESH_WORKER_SECRET`

Then adapt `cron.sql` to the project URL and run it. The worker claims at most ten rows per invocation and uses retry/backoff. It must not be configured to bypass XInvoice limits or use rotating proxies.
