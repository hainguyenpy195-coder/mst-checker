-- Invoice extraction, verification and monthly AI scan quota.

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null,
  invoice_number_key text not null unique,
  seller_tax_code text,
  seller_name text,
  invoice_template_number text,
  invoice_symbol text,
  invoice_date text,
  tax_amount numeric(24, 2),
  total_amount numeric(24, 2),
  currency text,
  extracted_text text,
  extracted_payload jsonb,
  source_file_name text not null,
  source_file_mime_type text not null,
  source_file_size integer not null check (source_file_size > 0),
  source_file_sha256 text not null,
  extracted_model text not null,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'valid', 'invalid', 'error')),
  verification_message text,
  verification_result jsonb,
  verified_at timestamptz,
  imported_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoices_created_at_idx
  on public.invoices(created_at desc);

create index if not exists invoices_status_idx
  on public.invoices(verification_status, created_at desc);

create index if not exists invoices_seller_tax_code_idx
  on public.invoices(seller_tax_code);

drop trigger if exists invoices_set_updated_at on public.invoices;
create trigger invoices_set_updated_at
before update on public.invoices
for each row execute function public.set_updated_at();

create table if not exists public.invoice_verification_sessions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  username text not null,
  upstream_cookie text not null,
  form_action text not null,
  hidden_fields jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists invoice_verification_sessions_expiry_idx
  on public.invoice_verification_sessions(expires_at);

create index if not exists invoice_verification_sessions_user_idx
  on public.invoice_verification_sessions(username, created_at desc);

create table if not exists public.invoice_scan_usage (
  month_start date primary key,
  scan_count integer not null default 0 check (scan_count >= 0),
  monthly_limit integer not null default 200 check (monthly_limit > 0),
  updated_at timestamptz not null default now()
);

create or replace function public.consume_invoice_scan_quota(p_limit integer default 200)
returns table(allowed boolean, used_count integer, monthly_limit integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_month date := date_trunc('month', timezone('Asia/Ho_Chi_Minh', now()))::date;
  requested_limit integer := greatest(1, least(coalesce(p_limit, 200), 100000));
  next_count integer;
  existing_count integer;
  existing_limit integer;
begin
  insert into public.invoice_scan_usage (month_start, scan_count, monthly_limit)
  values (current_month, 1, requested_limit)
  on conflict (month_start) do update
  set scan_count = public.invoice_scan_usage.scan_count + 1,
      monthly_limit = requested_limit,
      updated_at = now()
  where public.invoice_scan_usage.scan_count < requested_limit
  returning invoice_scan_usage.scan_count into next_count;

  if found then
    return query select true, next_count, requested_limit;
    return;
  end if;

  select scan_count, monthly_limit
  into existing_count, existing_limit
  from public.invoice_scan_usage
  where month_start = current_month;

  return query select false, coalesce(existing_count, 0), coalesce(existing_limit, requested_limit);
end;
$$;

alter table public.invoices enable row level security;
alter table public.invoice_verification_sessions enable row level security;
alter table public.invoice_scan_usage enable row level security;

revoke all on public.invoices from public, anon, authenticated;
revoke all on public.invoice_verification_sessions from public, anon, authenticated;
revoke all on public.invoice_scan_usage from public, anon, authenticated;
grant all on public.invoices to service_role;
grant all on public.invoice_verification_sessions to service_role;
grant all on public.invoice_scan_usage to service_role;

revoke all on function public.consume_invoice_scan_quota(integer) from public, anon, authenticated;
grant execute on function public.consume_invoice_scan_quota(integer) to service_role;

comment on table public.invoices is
  'One row per normalized invoice number, including AI extraction and tax-site verification.';

comment on table public.invoice_verification_sessions is
  'Short-lived server-side sessions for the Cục Thuế invoice CAPTCHA flow.';

comment on table public.invoice_scan_usage is
  'Atomic monthly counter for invoice extraction attempts sent to the AI Gateway.';
