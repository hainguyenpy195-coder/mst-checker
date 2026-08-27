-- Targeted refresh for taxpayers that have errors

create or replace function public.enqueue_error_taxpayer_refreshes()
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
    where t.last_error is not null
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

revoke execute on function public.enqueue_error_taxpayer_refreshes() from public, anon, authenticated;
grant execute on function public.enqueue_error_taxpayer_refreshes() to service_role;
