-- Disable scheduled refreshes. The application now starts refreshes manually.

create extension if not exists pg_cron;

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
