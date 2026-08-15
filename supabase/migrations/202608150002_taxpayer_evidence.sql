-- Store the current tax lookup screenshot for each taxpayer.
-- The bucket is private because access is mediated by the application session.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'taxpayer-evidence',
  'taxpayer-evidence',
  false,
  4194304,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.taxpayer_evidence (
  tax_code text primary key references public.taxpayers(tax_code) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 4194304),
  uploaded_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists taxpayer_evidence_updated_at_idx
  on public.taxpayer_evidence(updated_at desc);

drop trigger if exists taxpayer_evidence_set_updated_at on public.taxpayer_evidence;
create trigger taxpayer_evidence_set_updated_at
before update on public.taxpayer_evidence
for each row execute function public.set_updated_at();

alter table public.taxpayer_evidence enable row level security;

-- The app uses the server-side service role client for this private resource.
revoke all on public.taxpayer_evidence from public, anon, authenticated;
grant all on public.taxpayer_evidence to service_role;

comment on table public.taxpayer_evidence is
  'The latest private screenshot evidence collected from the tax authority lookup.';
