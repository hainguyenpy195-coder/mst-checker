-- Configure this after deploying the Edge Function.
-- Replace the URL, project ref and secret before executing in Supabase SQL Editor.
-- Supabase Free Cron can run this once per minute; the Edge Function itself only
-- claims a small batch and respects XInvoice rate limits.

select cron.schedule(
  'mst-checker-xinvoice-refresh',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/xinvoice-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', 'REPLACE_WITH_REFRESH_WORKER_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);
