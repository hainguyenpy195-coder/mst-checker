-- Requeue taxpayers whose scheduled refresh time has arrived.
-- The Edge Function calls this before claiming its next batch.

create or replace function public.enqueue_due_taxpayer_refreshes(p_limit integer default 50)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  queued_count integer;
begin
  with due_rows as (
    select t.tax_code
    from public.taxpayers t
    left join public.refresh_queue q on q.tax_code = t.tax_code
    where t.next_check_at is not null
      and t.next_check_at <= now()
      and (
        q.tax_code is null
        or q.state in ('success', 'dead_letter')
      )
    order by t.next_check_at asc, t.updated_at asc
    limit greatest(1, least(coalesce(p_limit, 50), 500))
  ),
  upserted as (
    insert into public.refresh_queue (tax_code, priority, state, run_after)
    select tax_code, 0, 'queued', now()
    from due_rows
    on conflict (tax_code) do update
      set priority = greatest(public.refresh_queue.priority, excluded.priority),
          state = 'queued',
          run_after = least(public.refresh_queue.run_after, excluded.run_after),
          last_error = null,
          updated_at = now()
      where public.refresh_queue.state in ('success', 'dead_letter')
    returning 1
  )
  select count(*) into queued_count from upserted;

  return queued_count;
end;
$$;

revoke execute on function public.enqueue_due_taxpayer_refreshes(integer) from public, anon, authenticated;
grant execute on function public.enqueue_due_taxpayer_refreshes(integer) to service_role;
