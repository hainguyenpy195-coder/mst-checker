-- Supabase Cron setup for the MST refresh worker.
--
-- The worker drain runs every minute, but the dispatcher returns immediately
-- while refresh_worker_paused is true or there is no due queue row. The
-- application starts a full refresh by enqueueing rows; it does not call the
-- Edge Function directly.

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

  perform cron.schedule(
    'mst-checker-worker-drain',
    '* * * * *',
    'select public.dispatch_taxpayer_refresh_worker();'
  );
end;
$$;
