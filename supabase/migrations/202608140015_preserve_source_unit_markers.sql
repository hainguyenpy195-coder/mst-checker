-- Keep the exact unit marker from the workbook, including legacy values such
-- as II.1 and II.2. The numeric order remains only a sort position.
alter table public.taxpayer_sources
  add column if not exists source_unit_marker text;

alter table public.taxpayer_source_units
  add column if not exists source_unit_marker text;

update public.taxpayer_source_units
set source_unit_marker = case source_unit_order
  when 1 then 'I'
  when 2 then 'II'
  when 3 then 'III'
  when 4 then 'IV'
  when 5 then 'V'
  when 6 then 'VI'
  when 7 then 'VII'
  when 8 then 'VIII'
  else source_unit_order::text
end
where source_unit_marker is null;

alter table public.taxpayer_source_units
  alter column source_unit_marker set not null;

alter table public.taxpayer_source_units
  drop constraint if exists taxpayer_source_units_pkey;

alter table public.taxpayer_source_units
  add constraint taxpayer_source_units_pkey
  primary key (source_year, source_unit_key, source_unit_marker);

drop index if exists public.taxpayer_source_units_year_order_idx;
create index taxpayer_source_units_year_order_idx
  on public.taxpayer_source_units(source_year, source_unit_order, source_unit_marker, source_unit_key);

-- Backfill the already imported workbook so the old nested headings are not
-- flattened while deploying the new parser.
update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'I', source_unit_order = 1 where source_year = '2023' and source_row between 4 and 427;
update public.taxpayer_sources set source_unit_key = 'phong-tckt', source_unit_label = 'PHÒNG TCKT', source_unit_marker = 'II', source_unit_order = 2 where source_year = '2023' and source_row between 429 and 444;
update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'II.1', source_unit_order = 3 where source_year = '2023' and source_row between 446 and 502;
update public.taxpayer_sources set source_unit_key = 'phong-khkd', source_unit_label = 'Phòng KHKD', source_unit_marker = 'II.2', source_unit_order = 4 where source_year = '2023' and source_row between 504 and 535;
update public.taxpayer_sources set source_unit_key = 'phong-ktatcl', source_unit_label = 'Phòng KTATCL', source_unit_marker = 'II.3', source_unit_order = 5 where source_year = '2023' and source_row between 537 and 571;
update public.taxpayer_sources set source_unit_key = 'phong-ncpt', source_unit_label = 'Phòng NCPT', source_unit_marker = 'II.4', source_unit_order = 6 where source_year = '2023' and source_row between 573 and 581;
update public.taxpayer_sources set source_unit_key = 'phong-tccbld', source_unit_label = 'Phòng TCCBLĐ', source_unit_marker = 'II.5', source_unit_order = 7 where source_year = '2023' and source_row between 583 and 605;
update public.taxpayer_sources set source_unit_key = 'tt-huan-luyen-cns', source_unit_label = 'TT huấn luyện CNS', source_unit_marker = 'II.7', source_unit_order = 8 where source_year = '2023' and source_row between 607 and 630;
update public.taxpayer_sources set source_unit_key = 'vpct', source_unit_label = 'VPCT chính', source_unit_marker = 'II.8', source_unit_order = 9 where source_year = '2023' and source_row between 632 and 819;

update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'I', source_unit_order = 1 where source_year = '2024' and source_row between 4 and 213;
update public.taxpayer_sources set source_unit_key = 'phong-tckt', source_unit_label = 'PHÒNG TCKT', source_unit_marker = 'II', source_unit_order = 2 where source_year = '2024' and source_row between 215 and 232;
update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'II.1', source_unit_order = 3 where source_year = '2024' and source_row between 234 and 234;
update public.taxpayer_sources set source_unit_key = 'phong-khkd', source_unit_label = 'Phòng KHKD', source_unit_marker = 'II.2', source_unit_order = 4 where source_year = '2024' and source_row between 236 and 243;
update public.taxpayer_sources set source_unit_key = 'phong-ktatcl', source_unit_label = 'Phòng KTATCL', source_unit_marker = 'II.3', source_unit_order = 5 where source_year = '2024' and source_row between 245 and 255;
update public.taxpayer_sources set source_unit_key = 'phong-ncpt', source_unit_label = 'Phòng NCPT', source_unit_marker = 'II.4', source_unit_order = 6 where source_year = '2024' and source_row between 257 and 258;
update public.taxpayer_sources set source_unit_key = 'phong-tccbld', source_unit_label = 'Phòng TCCBLĐ', source_unit_marker = 'II.5', source_unit_order = 7 where source_year = '2024' and source_row between 260 and 261;
update public.taxpayer_sources set source_unit_key = 'tt-huan-luyen-cns', source_unit_label = 'TT huấn luyện CNS', source_unit_marker = 'II.7', source_unit_order = 8 where source_year = '2024' and source_row between 263 and 268;
update public.taxpayer_sources set source_unit_key = 'vpct', source_unit_label = 'VPCT', source_unit_marker = 'II.8', source_unit_order = 9 where source_year = '2024' and source_row between 270 and 456;

update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'I', source_unit_order = 1 where source_year = '2025' and source_row between 4 and 642;
update public.taxpayer_sources set source_unit_key = 'phong-tckt', source_unit_label = 'PHÒNG TCKT', source_unit_marker = 'II', source_unit_order = 2 where source_year = '2025' and source_row between 644 and 658;
update public.taxpayer_sources set source_unit_key = 'phong-khkd', source_unit_label = 'Phòng KHKD', source_unit_marker = 'II.2', source_unit_order = 3 where source_year = '2025' and source_row between 660 and 690;
update public.taxpayer_sources set source_unit_key = 'phong-ktatcl', source_unit_label = 'Phòng KTATCL', source_unit_marker = 'II.3', source_unit_order = 4 where source_year = '2025' and source_row between 692 and 709;
update public.taxpayer_sources set source_unit_key = 'phong-ncpt', source_unit_label = 'Phòng NCPT', source_unit_marker = 'II.4', source_unit_order = 5 where source_year = '2025' and source_row between 711 and 717;
update public.taxpayer_sources set source_unit_key = 'phong-tccbld', source_unit_label = 'Phòng TCCBLĐ', source_unit_marker = 'II.5', source_unit_order = 6 where source_year = '2025' and source_row between 719 and 730;
update public.taxpayer_sources set source_unit_key = 'tt-huan-luyen-cns', source_unit_label = 'TT huấn luyện CNS', source_unit_marker = 'II.7', source_unit_order = 7 where source_year = '2025' and source_row between 732 and 744;
update public.taxpayer_sources set source_unit_key = 'vpct', source_unit_label = 'VPCT', source_unit_marker = 'II.8', source_unit_order = 8 where source_year = '2025' and source_row between 746 and 853;

update public.taxpayer_sources set source_unit_key = 'xuong-dvkt', source_unit_label = 'XƯỞNG DVKT', source_unit_marker = 'I', source_unit_order = 1 where source_year = '2026' and source_row between 4 and 156;
update public.taxpayer_sources set source_unit_key = 'phong-ktatcl', source_unit_label = 'Phòng KTATCL', source_unit_marker = 'IV', source_unit_order = 4 where source_year = '2026' and source_row between 160 and 163;
update public.taxpayer_sources set source_unit_key = 'phong-ncpt', source_unit_label = 'Phòng NCPT', source_unit_marker = 'V', source_unit_order = 5 where source_year = '2026' and source_row between 165 and 165;
update public.taxpayer_sources set source_unit_key = 'vpct', source_unit_label = 'VPCT', source_unit_marker = 'VIII', source_unit_order = 8 where source_year = '2026' and source_row between 169 and 176;

insert into public.taxpayer_source_units (source_year, source_unit_key, source_unit_label, source_unit_marker, source_unit_order) values
  ('2023', 'xuong-dvkt', 'XƯỞNG DVKT', 'I', 1),
  ('2023', 'phong-tckt', 'PHÒNG TCKT', 'II', 2),
  ('2023', 'xuong-dvkt', 'XƯỞNG DVKT', 'II.1', 3),
  ('2023', 'phong-khkd', 'Phòng KHKD', 'II.2', 4),
  ('2023', 'phong-ktatcl', 'Phòng KTATCL', 'II.3', 5),
  ('2023', 'phong-ncpt', 'Phòng NCPT', 'II.4', 6),
  ('2023', 'phong-tccbld', 'Phòng TCCBLĐ', 'II.5', 7),
  ('2023', 'tt-huan-luyen-cns', 'TT huấn luyện CNS', 'II.7', 8),
  ('2023', 'vpct', 'VPCT chính', 'II.8', 9),
  ('2024', 'xuong-dvkt', 'XƯỞNG DVKT', 'I', 1),
  ('2024', 'phong-tckt', 'PHÒNG TCKT', 'II', 2),
  ('2024', 'xuong-dvkt', 'XƯỞNG DVKT', 'II.1', 3),
  ('2024', 'phong-khkd', 'Phòng KHKD', 'II.2', 4),
  ('2024', 'phong-ktatcl', 'Phòng KTATCL', 'II.3', 5),
  ('2024', 'phong-ncpt', 'Phòng NCPT', 'II.4', 6),
  ('2024', 'phong-tccbld', 'Phòng TCCBLĐ', 'II.5', 7),
  ('2024', 'tt-huan-luyen-cns', 'TT huấn luyện CNS', 'II.7', 8),
  ('2024', 'vpct', 'VPCT', 'II.8', 9),
  ('2025', 'xuong-dvkt', 'XƯỞNG DVKT', 'I', 1),
  ('2025', 'phong-tckt', 'PHÒNG TCKT', 'II', 2),
  ('2025', 'phong-khkd', 'Phòng KHKD', 'II.2', 3),
  ('2025', 'phong-ktatcl', 'Phòng KTATCL', 'II.3', 4),
  ('2025', 'phong-ncpt', 'Phòng NCPT', 'II.4', 5),
  ('2025', 'phong-tccbld', 'Phòng TCCBLĐ', 'II.5', 6),
  ('2025', 'tt-huan-luyen-cns', 'TT huấn luyện CNS', 'II.7', 7),
  ('2025', 'vpct', 'VPCT', 'II.8', 8),
  ('2026', 'xuong-dvkt', 'XƯỞNG DVKT', 'I', 1),
  ('2026', 'phong-tckt', 'PHÒNG TCKT', 'II', 2),
  ('2026', 'phong-khkd', 'Phòng KHKD', 'III', 3),
  ('2026', 'phong-ktatcl', 'Phòng KTATCL', 'IV', 4),
  ('2026', 'phong-ncpt', 'Phòng NCPT', 'V', 5),
  ('2026', 'phong-tccbld', 'Phòng TCCBLĐ', 'VI', 6),
  ('2026', 'tt-huan-luyen-cns', 'TT huấn luyện CNS', 'VII', 7),
  ('2026', 'vpct', 'VPCT', 'VIII', 8)
on conflict (source_year, source_unit_key, source_unit_marker) do update set
  source_unit_label = excluded.source_unit_label,
  source_unit_order = excluded.source_unit_order,
  updated_at = now();

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
        source_note = coalesce(excluded.source_note, taxpayer_sources.source_note);
    end loop;

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

create or replace function public.replace_taxpayer_source_units(p_source_years jsonb, p_units jsonb)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  unit_item jsonb;
begin
  if jsonb_typeof(p_source_years) <> 'array' or jsonb_typeof(p_units) <> 'array' then
    raise exception 'taxpayer source units payload must be arrays';
  end if;

  delete from public.taxpayer_source_units
  where source_year in (select value from jsonb_array_elements_text(p_source_years));

  for unit_item in select value from jsonb_array_elements(p_units) loop
    if (unit_item->>'source_year') !~ '^\d{4}$'
      or (unit_item->>'source_unit_key') !~ '^([a-z0-9]+-)*[a-z0-9]+$'
      or coalesce(btrim(unit_item->>'source_unit_label'), '') = ''
      or (unit_item->>'source_unit_marker') !~ '^[IVXLCDMivxlcdm]+(\.\s*[0-9]+)?\.?$'
      or (unit_item->>'source_unit_order') !~ '^\d+$' then
      raise exception 'invalid taxpayer source unit';
    end if;

    insert into public.taxpayer_source_units (
      source_year,
      source_unit_key,
      source_unit_label,
      source_unit_marker,
      source_unit_order
    ) values (
      btrim(unit_item->>'source_year'),
      btrim(unit_item->>'source_unit_key'),
      btrim(unit_item->>'source_unit_label'),
      btrim(unit_item->>'source_unit_marker'),
      (unit_item->>'source_unit_order')::integer
    )
    on conflict (source_year, source_unit_key, source_unit_marker) do update set
      source_unit_label = excluded.source_unit_label,
      source_unit_order = excluded.source_unit_order,
      updated_at = now();
  end loop;
end;
$$;

revoke all on function public.import_taxpayer_batch(jsonb, text) from public, anon, authenticated;
grant execute on function public.import_taxpayer_batch(jsonb, text) to service_role;
revoke all on function public.replace_taxpayer_source_units(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_taxpayer_source_units(jsonb, jsonb) to service_role;
