-- Preserve the unit section from each source workbook row. The unit key is
-- stable while the source label keeps the original Excel heading for review.
alter table public.taxpayer_sources
  add column if not exists source_unit_key text,
  add column if not exists source_unit_label text,
  add column if not exists source_unit_order integer;

create index if not exists taxpayer_sources_year_unit_idx
  on public.taxpayer_sources(source_year, source_unit_order, source_unit_key);

-- Keep existing MST master rows unique while allowing a later workbook import
-- to add or refresh source rows for MSTs already present in public.taxpayers.
create or replace function public.import_taxpayer_batch(p_rows jsonb, p_actor_username text)
returns table(tax_code text)
language plpgsql
security definer set search_path = public
as $$
declare
  item jsonb;
  source_item jsonb;
  normalized_code text;
  taxpayer_name text;
  inserted_count integer;
  source_years jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'taxpayer import rows must be an array';
  end if;

  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 200 then
    raise exception 'taxpayer import batch size is invalid';
  end if;

  for item in select value from jsonb_array_elements(p_rows) loop
    normalized_code := regexp_replace(trim(item->>'tax_code'), '\s+', '', 'g');
    if normalized_code !~ '^(\d{10}|\d{10}-\d{3}|\d{12})$' then
      raise exception 'invalid tax code in import batch';
    end if;

    taxpayer_name := nullif(btrim(item->>'name'), '');
    insert into public.taxpayers (tax_code, name, status_group, next_check_at)
    values (normalized_code, taxpayer_name, 'unknown', now())
    on conflict on constraint taxpayers_pkey do nothing;

    get diagnostics inserted_count = row_count;

    if jsonb_typeof(item->'sources') <> 'array' or jsonb_array_length(item->'sources') = 0 then
      raise exception 'taxpayer import source rows are required';
    end if;

    for source_item in select value from jsonb_array_elements(item->'sources') loop
      if coalesce(source_item->>'source_sheet', '') = ''
        or (source_item->>'source_year') !~ '^\d{4}$'
        or (source_item->>'source_sheet') <> (source_item->>'source_year')
        or (source_item->>'source_row') !~ '^\d+$'
        or (coalesce(source_item->>'source_unit_key', '') <> '' and (source_item->>'source_unit_key') !~ '^([a-z0-9]+-)*[a-z0-9]+$')
        or (coalesce(source_item->>'source_unit_order', '') <> '' and (source_item->>'source_unit_order') !~ '^\d+$') then
        raise exception 'invalid taxpayer import source row';
      end if;

      insert into public.taxpayer_sources (
        tax_code,
        source_sheet,
        source_year,
        source_row,
        source_unit_key,
        source_unit_label,
        source_unit_order,
        source_vendor_name,
        source_note
      ) values (
        normalized_code,
        btrim(source_item->>'source_sheet'),
        btrim(source_item->>'source_year'),
        (source_item->>'source_row')::integer,
        nullif(btrim(source_item->>'source_unit_key'), ''),
        nullif(btrim(source_item->>'source_unit_label'), ''),
        case when (source_item->>'source_unit_order') ~ '^\d+$' then (source_item->>'source_unit_order')::integer else null end,
        nullif(btrim(source_item->>'source_vendor_name'), ''),
        nullif(btrim(source_item->>'source_note'), '')
      )
      on conflict (tax_code, source_sheet, source_row) do update set
        source_unit_key = coalesce(excluded.source_unit_key, taxpayer_sources.source_unit_key),
        source_unit_label = coalesce(excluded.source_unit_label, taxpayer_sources.source_unit_label),
        source_unit_order = coalesce(excluded.source_unit_order, taxpayer_sources.source_unit_order),
        source_vendor_name = coalesce(excluded.source_vendor_name, taxpayer_sources.source_vendor_name),
        source_note = coalesce(excluded.source_note, taxpayer_sources.source_note);
    end loop;

    -- Existing taxpayers only need their source occurrences refreshed. New
    -- taxpayers continue through the queue and activity-log workflow below.
    if inserted_count = 0 then
      continue;
    end if;

    select jsonb_agg(distinct source_row_json->>'source_year')
      into source_years
      from jsonb_array_elements(item->'sources') as source_rows(source_row_json);

    insert into public.refresh_queue (tax_code, priority, state, run_after)
    values (normalized_code, 10, 'queued', now())
    on conflict on constraint refresh_queue_pkey do update
    set priority = greatest(public.refresh_queue.priority, excluded.priority),
        state = case
          when public.refresh_queue.state in ('success', 'dead_letter') then 'queued'
          else public.refresh_queue.state
        end,
        run_after = least(public.refresh_queue.run_after, excluded.run_after),
        last_error = null,
        updated_at = now();

    insert into public.taxpayer_activity_logs (
      action,
      tax_code,
      taxpayer_name,
      source_year,
      actor_username,
      details
    ) values (
      'taxpayer_added',
      normalized_code,
      taxpayer_name,
      coalesce((select string_agg(value, ', ' order by value) from jsonb_array_elements_text(source_years) as years(value)), null),
      coalesce(nullif(btrim(p_actor_username), ''), 'unknown'),
      jsonb_build_object('source', 'excel_import', 'source_years', source_years)
    );

    tax_code := normalized_code;
    return next;
  end loop;
end;
$$;
