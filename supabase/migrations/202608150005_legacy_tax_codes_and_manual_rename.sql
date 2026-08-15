-- Preserve legacy 11-digit tax codes entered as text and support correcting a
-- tax code already stored in the catalogue without losing related records.

alter table public.taxpayer_activity_logs
  drop constraint if exists taxpayer_activity_logs_action_check;

alter table public.taxpayer_activity_logs
  add constraint taxpayer_activity_logs_action_check
  check (action in ('taxpayer_added', 'taxpayer_deleted', 'excel_imported', 'taxpayer_code_updated'));

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
    if normalized_code !~ '^(\d{10}|\d{11}|\d{10}-\d{3}|\d{12})$' then
      raise exception 'invalid tax code in import batch';
    end if;

    if jsonb_typeof(item->'sources') <> 'array' or jsonb_array_length(item->'sources') = 0 then
      raise exception 'taxpayer import source rows are required';
    end if;

    taxpayer_name := null;
    select nullif(btrim(source_row->>'source_vendor_name'), '')
      into taxpayer_name
      from jsonb_array_elements(item->'sources') as source_rows(source_row)
     where nullif(btrim(source_row->>'source_vendor_name'), '') is not null
     limit 1;

    insert into public.taxpayers (
      tax_code,
      name,
      status_group,
      next_check_at,
      needs_manual_review,
      manual_review_reason,
      name_source
    ) values (
      normalized_code,
      taxpayer_name,
      'unknown',
      now(),
      taxpayer_name is not null,
      case when taxpayer_name is not null then 'Tên Excel đang chờ đối chiếu với endpoint hoặc Cục Thuế.' else null end,
      case when taxpayer_name is not null then 'excel_reference' else 'unknown' end
    )
    on conflict on constraint taxpayers_pkey do nothing;

    get diagnostics inserted_count = row_count;

    if inserted_count = 0 and taxpayer_name is not null then
      update public.taxpayers
      set name = taxpayer_name,
          needs_manual_review = true,
          manual_review_reason = 'Tên Excel đang chờ đối chiếu với endpoint hoặc Cục Thuế.',
          name_source = 'excel_reference'
      where tax_code = normalized_code;
    end if;

    for source_item in select value from jsonb_array_elements(item->'sources') loop
      if coalesce(source_item->>'source_sheet', '') = ''
        or (source_item->>'source_year') !~ '^\d{4}$'
        or (source_item->>'source_sheet') <> (source_item->>'source_year')
        or (source_item->>'source_row') !~ '^\d+$'
        or (coalesce(source_item->>'source_unit_key', '') <> '' and (source_item->>'source_unit_key') !~ '^([a-z0-9]+-)*[a-z0-9]+$')
        or (coalesce(source_item->>'source_unit_marker', '') <> '' and (source_item->>'source_unit_marker') !~ '^[IVXLCDMivxlcdm]+(\.\s*[0-9]+)?\.?$')
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
        source_unit_marker,
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
        nullif(btrim(source_item->>'source_unit_marker'), ''),
        case when (source_item->>'source_unit_order') ~ '^\d+$' then (source_item->>'source_unit_order')::integer else null end,
        nullif(btrim(source_item->>'source_vendor_name'), ''),
        nullif(btrim(source_item->>'source_note'), '')
      )
      on conflict on constraint taxpayer_sources_tax_code_source_sheet_source_row_key do update set
        source_unit_key = coalesce(excluded.source_unit_key, taxpayer_sources.source_unit_key),
        source_unit_label = coalesce(excluded.source_unit_label, taxpayer_sources.source_unit_label),
        source_unit_marker = coalesce(excluded.source_unit_marker, taxpayer_sources.source_unit_marker),
        source_unit_order = coalesce(excluded.source_unit_order, taxpayer_sources.source_unit_order),
        source_vendor_name = coalesce(excluded.source_vendor_name, taxpayer_sources.source_vendor_name),
        source_note = coalesce(excluded.source_note, taxpayer_sources.source_note),
        source_imported_at = now();
    end loop;

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

    if inserted_count = 0 then
      continue;
    end if;

    select jsonb_agg(distinct source_row_json->>'source_year')
      into source_years
      from jsonb_array_elements(item->'sources') as source_rows(source_row_json);

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
      jsonb_build_object('source', 'excel_import', 'source_years', source_years, 'reference_name', taxpayer_name)
    );

    tax_code := normalized_code;
    return next;
  end loop;
end;
$$;

revoke all on function public.import_taxpayer_batch(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_taxpayer_batch(jsonb, text) to service_role;

create or replace function public.rename_taxpayer_code(
  p_old_tax_code text,
  p_new_tax_code text,
  p_actor_username text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  old_code text := regexp_replace(replace(replace(trim(coalesce(p_old_tax_code, '')), '–', '-'), '—', '-'), '\s+', '', 'g');
  new_code text := regexp_replace(replace(replace(trim(coalesce(p_new_tax_code, '')), '–', '-'), '—', '-'), '\s+', '', 'g');
  taxpayer_name text;
  source_years text;
begin
  if old_code !~ '^(\d{10}|\d{11}|\d{10}-\d{3}|\d{12})$'
    or new_code !~ '^(\d{10}|\d{11}|\d{10}-\d{3}|\d{12})$' then
    raise exception 'invalid tax code format';
  end if;

  if old_code = new_code then
    return;
  end if;

  select name
    into taxpayer_name
    from public.taxpayers
   where tax_code = old_code
   for update;

  if not found then
    raise exception 'taxpayer not found';
  end if;

  if exists (select 1 from public.taxpayers where tax_code = new_code) then
    raise exception 'taxpayer code already exists';
  end if;

  select string_agg(distinct source_year, ', ' order by source_year)
    into source_years
    from public.taxpayer_sources
   where tax_code = old_code
     and source_year is not null;

  insert into public.taxpayers (
    tax_code,
    name,
    org_type,
    address,
    tax_department,
    status,
    status_group,
    source_updated_at,
    previous_checked_at,
    last_checked_at,
    status_changed_at,
    last_error,
    consecutive_failures,
    next_check_at,
    raw_current_response,
    created_at,
    needs_manual_review,
    manual_review_reason,
    name_source
  )
  select
    new_code,
    name,
    org_type,
    address,
    tax_department,
    status,
    status_group,
    source_updated_at,
    previous_checked_at,
    last_checked_at,
    status_changed_at,
    last_error,
    consecutive_failures,
    next_check_at,
    raw_current_response,
    created_at,
    needs_manual_review,
    manual_review_reason,
    name_source
    from public.taxpayers
   where tax_code = old_code;

  update public.taxpayer_sources
     set tax_code = new_code
   where tax_code = old_code;

  update public.taxpayer_status_history
     set tax_code = new_code
   where tax_code = old_code;

  update public.refresh_queue
     set tax_code = new_code,
         priority = greatest(priority, 20),
         state = 'queued',
         run_after = now(),
         locked_at = null,
         last_error = null,
         updated_at = now()
   where tax_code = old_code;

  insert into public.refresh_queue (tax_code, priority, state, run_after)
  values (new_code, 20, 'queued', now())
  on conflict (tax_code) do update
  set priority = greatest(public.refresh_queue.priority, excluded.priority),
      state = 'queued',
      run_after = now(),
      locked_at = null,
      last_error = null,
      updated_at = now();

  update public.manual_lookup_sessions
     set tax_code = new_code
   where tax_code = old_code;

  update public.taxpayer_evidence
     set tax_code = new_code
   where tax_code = old_code;

  delete from public.taxpayers
   where tax_code = old_code;

  insert into public.taxpayer_activity_logs (
    action,
    tax_code,
    taxpayer_name,
    source_year,
    actor_username,
    details
  ) values (
    'taxpayer_code_updated',
    new_code,
    taxpayer_name,
    source_years,
    coalesce(nullif(btrim(p_actor_username), ''), 'unknown'),
    jsonb_build_object('old_tax_code', old_code, 'new_tax_code', new_code)
  );
end;
$$;

revoke all on function public.rename_taxpayer_code(text, text, text) from public, anon, authenticated;
grant execute on function public.rename_taxpayer_code(text, text, text) to service_role;
