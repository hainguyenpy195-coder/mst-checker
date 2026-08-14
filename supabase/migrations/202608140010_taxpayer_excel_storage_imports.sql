-- Store large taxpayer workbooks outside the Vercel Function request body.
-- The application creates signed upload URLs and reads these private objects
-- server-side during preview. No public Storage policy is required.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'taxpayer-imports',
  'taxpayer-imports',
  false,
  20971520,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.taxpayer_excel_imports (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  file_name text not null,
  file_size bigint not null check (file_size > 0),
  actor_username text not null,
  status text not null default 'uploading' check (status in ('uploading', 'previewed', 'committing', 'completed', 'failed', 'cancelled')),
  candidates jsonb not null default '[]'::jsonb,
  preview_stats jsonb not null default '{}'::jsonb,
  source_years jsonb not null default '[]'::jsonb,
  commit_offset integer not null default 0 check (commit_offset >= 0),
  added_tax_codes jsonb not null default '[]'::jsonb,
  added_count integer not null default 0 check (added_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  error text,
  file_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  previewed_at timestamptz,
  completed_at timestamptz
);

create index if not exists taxpayer_excel_imports_actor_created_idx
  on public.taxpayer_excel_imports(actor_username, created_at desc);

create index if not exists taxpayer_excel_imports_status_created_idx
  on public.taxpayer_excel_imports(status, created_at desc);

alter table public.taxpayer_excel_imports enable row level security;

comment on table public.taxpayer_excel_imports is
  'Server-side state for direct-upload taxpayer Excel imports.';

alter table public.taxpayer_activity_logs
  add column if not exists import_id uuid;

alter table public.taxpayer_activity_logs
  alter column tax_code drop not null;

alter table public.taxpayer_activity_logs
  drop constraint if exists taxpayer_activity_logs_action_check;

alter table public.taxpayer_activity_logs
  add constraint taxpayer_activity_logs_action_check
  check (action in ('taxpayer_added', 'taxpayer_deleted', 'excel_imported'));

create unique index if not exists taxpayer_activity_logs_import_id_idx
  on public.taxpayer_activity_logs(import_id)
  where action = 'excel_imported' and import_id is not null;

comment on column public.taxpayer_activity_logs.import_id is
  'The related taxpayer Excel import session for an excel_imported event.';

comment on table public.taxpayer_activity_logs is
  'Audit log for taxpayer additions, deletions, and completed Excel imports.';
