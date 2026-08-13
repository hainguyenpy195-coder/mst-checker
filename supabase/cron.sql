-- Supabase Cron configuration for the MST refresh worker.
--
-- Enable pg_cron and pg_net in Supabase Dashboard > Integrations first if the
-- extensions are not available in the SQL Editor.
-- The worker secret must be kept outside Git. Replace the placeholder below
-- only in the SQL Editor, or use Supabase Vault for production.
--
-- pg_cron uses GMT by default, so 05:00 UTC is 12:00 in Vietnam (UTC+7).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'mst-checker-monthly-dispatch') then
    perform cron.unschedule('mst-checker-monthly-dispatch');
  end if;
  if exists (select 1 from cron.job where jobname = 'mst-checker-worker-drain') then
    perform cron.unschedule('mst-checker-worker-drain');
  end if;
end;
$$;

-- At 12:00 Vietnam time on the first day of every month, enqueue every MST.
select cron.schedule(
  'mst-checker-monthly-dispatch',
  '0 5 1 * *',
  $$select public.enqueue_all_taxpayer_refreshes();$$
);

-- Drain queued jobs in small batches. When the queue is empty, the worker
-- claims zero jobs and makes no XInvoice requests.
select cron.schedule(
  'mst-checker-worker-drain',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://aoutafhbtviwjzatblrn.supabase.co/functions/v1/xinvoice-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', 'REPLACE_WITH_REFRESH_WORKER_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);
