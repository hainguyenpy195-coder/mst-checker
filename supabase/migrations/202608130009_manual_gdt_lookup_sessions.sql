-- Short-lived server-side sessions for the user-assisted Cục Thuế lookup.
-- The upstream cookie must never be exposed to the browser.

create table if not exists public.manual_lookup_sessions (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  tax_code text not null references public.taxpayers(tax_code) on delete cascade,
  upstream_cookie text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists manual_lookup_sessions_expiry_idx
  on public.manual_lookup_sessions(expires_at);

alter table public.manual_lookup_sessions enable row level security;

revoke all on public.manual_lookup_sessions from public, anon, authenticated;
grant all on public.manual_lookup_sessions to service_role;

comment on table public.manual_lookup_sessions is
  'Short-lived server-side Cục Thuế CAPTCHA sessions; upstream cookies are never sent to clients.';
