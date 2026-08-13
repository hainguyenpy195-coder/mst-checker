-- Do not let an older initial backfill starve jobs waiting for retry.

create or replace function public.claim_refresh_batch(p_limit integer default 10)
returns setof public.refresh_queue
language plpgsql
security definer set search_path = public
as $$
begin
  return query
  with candidate_rows as (
    select q.tax_code
    from public.refresh_queue q
    where q.state in ('queued', 'retry')
      and q.run_after <= now()
    order by
      case when q.state = 'retry' then 0 else 1 end,
      q.priority desc,
      q.run_after asc
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

revoke execute on function public.claim_refresh_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_refresh_batch(integer) to service_role;
