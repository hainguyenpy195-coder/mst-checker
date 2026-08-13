-- Application-level login migration.
-- The Vercel server is the only database client for this deployment. Supabase
-- Auth tables are kept for compatibility, but taxpayer reads/writes go through
-- the server-side secret key and this refresh function is service-role only.

alter table public.taxpayers
  add column if not exists previous_checked_at timestamptz;

create index if not exists taxpayer_sources_year_idx
  on public.taxpayer_sources(source_year);

-- A manually added MST has no workbook row number. Keep one source entry per
-- MST/year for those records while preserving the existing workbook constraint.
create unique index if not exists taxpayer_sources_tax_year_null_row_idx
  on public.taxpayer_sources (tax_code, source_year, coalesce(source_row, -1));

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
        when public.refresh_queue.state in ('success', 'dead_letter') then 'queued'
        else public.refresh_queue.state
      end,
      run_after = least(public.refresh_queue.run_after, excluded.run_after),
      last_error = null,
      updated_at = now();
end;
$$;

revoke execute on function public.request_taxpayer_refresh(text) from public, anon, authenticated;
grant execute on function public.request_taxpayer_refresh(text) to service_role;

comment on column public.taxpayers.previous_checked_at is
  'The successful check timestamp immediately before last_checked_at.';
