-- Keep workbook unit headings even when a unit has no taxpayer rows.
create table if not exists public.taxpayer_source_units (
  source_year text not null check (source_year ~ '^\d{4}$'),
  source_unit_key text not null check (source_unit_key ~ '^([a-z0-9]+-)*[a-z0-9]+$'),
  source_unit_label text not null,
  source_unit_order integer not null check (source_unit_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_year, source_unit_key)
);

create index if not exists taxpayer_source_units_year_order_idx
  on public.taxpayer_source_units(source_year, source_unit_order, source_unit_key);

alter table public.taxpayer_source_units enable row level security;

comment on table public.taxpayer_source_units is
  'Workbook unit headings, including sections with no taxpayer source rows.';

-- Persist the headings found during preview until the commit batches finish.
alter table public.taxpayer_excel_imports
  add column if not exists source_units jsonb not null default '[]'::jsonb;
