-- Targeted refresh for a newly added or manually refreshed taxpayer, plus the
-- monthly dispatcher used by the queue worker.

create or replace function public.claim_refresh_job(p_tax_code text)
returns setof public.refresh_queue
language plpgsql
security definer set search_path = public
as $$
declare
  normalized_code text := regexp_replace(trim(p_tax_code), '\s+', '', 'g');
begin
  return query
  with candidate_rows as (
    select q.tax_code
    from public.refresh_queue q
    where q.tax_code = normalized_code
      and q.state in ('queued', 'retry')
      and q.run_after <= now()
    for update skip locked
    limit 1
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

create or replace function public.enqueue_all_taxpayer_refreshes()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  queued_count integer;
begin
  with upserted as (
    insert into public.refresh_queue (tax_code, priority, state, attempts, run_after, locked_at, last_error)
    select t.tax_code, 0, 'queued', 0, now(), null, null
    from public.taxpayers t
    on conflict (tax_code) do update
    set priority = greatest(public.refresh_queue.priority, excluded.priority),
        state = case when public.refresh_queue.state = 'running' then public.refresh_queue.state else 'queued' end,
        attempts = case when public.refresh_queue.state = 'running' then public.refresh_queue.attempts else 0 end,
        run_after = case when public.refresh_queue.state = 'running' then public.refresh_queue.run_after else excluded.run_after end,
        locked_at = case when public.refresh_queue.state = 'running' then public.refresh_queue.locked_at else null end,
        last_error = null,
        updated_at = now()
    returning 1
  )
  select count(*) into queued_count from upserted;

  return queued_count;
end;
$$;

revoke execute on function public.claim_refresh_job(text) from public, anon, authenticated;
grant execute on function public.claim_refresh_job(text) to service_role;
revoke execute on function public.enqueue_all_taxpayer_refreshes() from public, anon, authenticated;
grant execute on function public.enqueue_all_taxpayer_refreshes() to service_role;
