-- Automatically register invoice seller tax codes in the taxpayer catalogue.
-- The function is intentionally service-role only because invoice import runs
-- through the server-side Next.js API.

create or replace function public.ensure_invoice_taxpayer(
  p_tax_code text,
  p_name text default null,
  p_source_year text default null,
  p_source_note text default null
)
returns table(
  tax_code text,
  created boolean,
  source_created boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := regexp_replace(
    replace(replace(trim(coalesce(p_tax_code, '')), '–', '-'), '—', '-'),
    '\s+', '', 'g'
  );
  normalized_year text := case
    when coalesce(p_source_year, '') ~ '^\d{4}$' then p_source_year
    else extract(year from timezone('Asia/Ho_Chi_Minh', now()))::text
  end;
  inserted_tax_code text;
  inserted_source_id bigint;
begin
  if normalized_code !~ '^(\d{10}|\d{10}-\d{3}|\d{12})$' then
    raise exception 'invalid tax code format';
  end if;

  insert into public.taxpayers (tax_code, name, status_group, next_check_at)
  values (
    normalized_code,
    nullif(trim(coalesce(p_name, '')), ''),
    'unknown',
    now()
  )
  on conflict (tax_code) do nothing
  returning public.taxpayers.tax_code into inserted_tax_code;

  -- Keep an existing trusted name, but fill a missing name from the invoice.
  update public.taxpayers
  set name = nullif(trim(coalesce(p_name, '')), '')
  where tax_code = normalized_code
    and name is null
    and nullif(trim(coalesce(p_name, '')), '') is not null;

  -- The existing tax/year/source-row unique index prevents duplicate invoice
  -- source rows for the same seller and year. ON CONFLICT without a target also
  -- handles an already existing manually-added source row for that year.
  insert into public.taxpayer_sources (
    tax_code,
    source_sheet,
    source_year,
    source_row,
    source_vendor_name,
    source_note
  )
  values (
    normalized_code,
    'INVOICE',
    normalized_year,
    null,
    nullif(trim(coalesce(p_name, '')), ''),
    nullif(trim(coalesce(p_source_note, '')), '')
  )
  on conflict do nothing
  returning id into inserted_source_id;

  if inserted_tax_code is not null then
    insert into public.refresh_queue (tax_code, priority, state, run_after)
    values (normalized_code, 20, 'queued', now())
    on conflict (tax_code) do update
    set priority = greatest(public.refresh_queue.priority, excluded.priority),
        state = case
          when public.refresh_queue.state in ('success', 'dead_letter') then 'queued'
          else public.refresh_queue.state
        end,
        run_after = least(public.refresh_queue.run_after, excluded.run_after),
        last_error = null,
        updated_at = now();
  end if;

  return query
  select normalized_code, inserted_tax_code is not null, inserted_source_id is not null;
end;
$$;

revoke all on function public.ensure_invoice_taxpayer(text, text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_invoice_taxpayer(text, text, text, text) to service_role;

comment on function public.ensure_invoice_taxpayer(text, text, text, text) is
  'Creates an invoice seller taxpayer/source row once and queues a targeted refresh for newly discovered tax codes.';
