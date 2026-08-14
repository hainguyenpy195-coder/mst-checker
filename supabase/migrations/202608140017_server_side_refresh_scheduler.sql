-- Move the refresh queue drain out of the browser. The queue itself remains
-- the source of truth for progress and pause/resume position.

create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.app_settings (setting_key, setting_value, description)
values (
  'refresh_worker_paused',
  'true',
  'Tạm dừng dispatcher Cron của hàng đợi cập nhật MST'
)
on conflict (setting_key) do nothing;

create or replace function public.is_refresh_worker_paused()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (
      select lower(setting_value) = 'true'
      from public.app_settings
      where setting_key = 'refresh_worker_paused'
    ),
    false
  );
$$;

create or replace function public.set_refresh_worker_paused(p_paused boolean)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.app_settings (setting_key, setting_value, description)
  values (
    'refresh_worker_paused',
    case when p_paused then 'true' else 'false' end,
    'Tạm dừng dispatcher Cron của hàng đợi cập nhật MST'
  )
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value,
        updated_at = now();

  return p_paused;
end;
$$;

revoke all on function public.is_refresh_worker_paused() from public, anon, authenticated;
grant execute on function public.is_refresh_worker_paused() to service_role;
revoke all on function public.set_refresh_worker_paused(boolean) from public, anon, authenticated;
grant execute on function public.set_refresh_worker_paused(boolean) to service_role;

-- Claiming is serialized so a delayed pg_net request cannot start a second
-- batch while the previous batch is still processing. A stale running job is
-- released after ten minutes so an interrupted Edge Function cannot block the
-- queue forever.
create or replace function public.claim_refresh_batch(p_limit integer default 10)
returns setof public.refresh_queue
language plpgsql
security definer set search_path = public
as $$
begin
  if public.is_refresh_worker_paused() then
    return;
  end if;

  if not pg_try_advisory_xact_lock(438190042) then
    return;
  end if;

  update public.refresh_queue
  set state = 'retry',
      locked_at = null,
      run_after = now(),
      last_error = coalesce(last_error, 'Worker bị gián đoạn; hàng đợi đã tự đưa về trạng thái thử lại.'),
      updated_at = now()
  where state = 'running'
    and locked_at is not null
    and locked_at < now() - interval '10 minutes';

  if exists (select 1 from public.refresh_queue where state = 'running') then
    return;
  end if;

  return query
  with candidate_rows as (
    select q.tax_code
    from public.refresh_queue q
    where q.state in ('queued', 'retry')
      and q.run_after <= now()
    order by q.priority desc, q.run_after asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.refresh_queue q
  set state = 'running',
      locked_at = now(),
      updated_at = now()
  from candidate_rows c
  where q.tax_code = c.tax_code
  returning q.*;
end;
$$;

-- The URL and worker secret are intentionally read from Supabase Vault. The
-- migration does not contain deployment secrets. See supabase/README.md for
-- the one-time Vault setup commands.
create or replace function public.dispatch_taxpayer_refresh_worker()
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  project_url text;
  refresh_secret text;
  request_id bigint;
begin
  if public.is_refresh_worker_paused()
    or exists (select 1 from public.refresh_queue where state = 'running')
    or not exists (
      select 1
      from public.refresh_queue
      where state in ('queued', 'retry')
        and run_after <= now()
    ) then
    return null;
  end if;

  select decrypted_secret
  into project_url
  from vault.decrypted_secrets
  where name = 'project_url';

  select decrypted_secret
  into refresh_secret
  from vault.decrypted_secrets
  where name = 'refresh_worker_secret';

  if coalesce(trim(project_url), '') = '' or coalesce(trim(refresh_secret), '') = '' then
    raise warning 'MST refresh dispatcher is not configured: project_url or refresh_worker_secret is missing from Supabase Vault.';
    return null;
  end if;

  select net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/xinvoice-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-refresh-secret', refresh_secret
    ),
    body := '{"refreshMode":"status"}'::jsonb,
    timeout_milliseconds := 60000
  )
  into request_id;

  return request_id;
end;
$$;

revoke all on function public.dispatch_taxpayer_refresh_worker() from public, anon, authenticated;
grant execute on function public.dispatch_taxpayer_refresh_worker() to service_role;

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
