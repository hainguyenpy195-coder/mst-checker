-- Track a manually cancelled refresh job without presenting it as a failure.
alter table public.refresh_queue
  drop constraint if exists refresh_queue_state_check;

alter table public.refresh_queue
  add constraint refresh_queue_state_check
  check (state in ('queued', 'running', 'success', 'retry', 'dead_letter', 'cancelled'));

create or replace function public.cancel_pending_taxpayer_refreshes()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  cancelled_count integer;
begin
  with cancelled_rows as (
    update public.refresh_queue
    set state = 'cancelled',
        locked_at = null,
        last_error = null,
        updated_at = now()
    where state in ('queued', 'retry')
    returning 1
  )
  select count(*) into cancelled_count from cancelled_rows;

  return cancelled_count;
end;
$$;

revoke all on function public.cancel_pending_taxpayer_refreshes() from public, anon, authenticated;
grant execute on function public.cancel_pending_taxpayer_refreshes() to service_role;

create or replace function public.request_taxpayer_refresh(p_tax_code text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  normalized_code text := regexp_replace(trim(p_tax_code), '\s+', '', 'g');
begin
  if not exists (select 1 from public.taxpayers where tax_code = normalized_code) then
    return;
  end if;

  insert into public.refresh_queue (tax_code, priority, state, run_after)
  values (normalized_code, 10, 'queued', now())
  on conflict (tax_code) do update
  set priority = greatest(public.refresh_queue.priority, excluded.priority),
      state = case
        when public.refresh_queue.state in ('success', 'dead_letter', 'cancelled') then 'queued'
        else public.refresh_queue.state
      end,
      run_after = least(public.refresh_queue.run_after, excluded.run_after),
      last_error = null,
      updated_at = now();
end;
$$;

revoke execute on function public.request_taxpayer_refresh(text) from public, anon, authenticated;
grant execute on function public.request_taxpayer_refresh(text) to service_role;

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
        or q.state in ('success', 'dead_letter', 'cancelled')
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
      where public.refresh_queue.state in ('success', 'dead_letter', 'cancelled')
    returning 1
  )
  select count(*) into queued_count from upserted;

  return queued_count;
end;
$$;

revoke execute on function public.enqueue_due_taxpayer_refreshes(integer) from public, anon, authenticated;
grant execute on function public.enqueue_due_taxpayer_refreshes(integer) to service_role;
