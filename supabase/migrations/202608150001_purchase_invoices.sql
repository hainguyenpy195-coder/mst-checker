-- Purchase invoice Excel import. The importer stores one accounting row per
-- worksheet row and deduplicates only an identical full-row fingerprint.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'purchase-invoice-imports',
  'purchase-invoice-imports',
  false,
  20971520,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.purchase_invoice_imports (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  file_name text not null,
  file_size bigint not null check (file_size > 0),
  actor_username text not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'previewed', 'committing', 'completed', 'failed', 'cancelled')),
  candidates jsonb not null default '[]'::jsonb,
  preview_stats jsonb not null default '{}'::jsonb,
  commit_offset integer not null default 0 check (commit_offset >= 0),
  added_count integer not null default 0 check (added_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  invalid_count integer not null default 0 check (invalid_count >= 0),
  error text,
  file_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  previewed_at timestamptz,
  completed_at timestamptz
);

create index if not exists purchase_invoice_imports_actor_created_idx
  on public.purchase_invoice_imports(actor_username, created_at desc);

create index if not exists purchase_invoice_imports_status_created_idx
  on public.purchase_invoice_imports(status, created_at desc);

create table if not exists public.purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  row_fingerprint text not null unique check (char_length(row_fingerprint) between 32 and 255),
  -- This is the user-approved comparison key (MST + ký hiệu + số HĐ + ngày
  -- phát hành + giá trị trước thuế). It is intentionally not unique because
  -- different accounting rows of the same invoice must be retained.
  invoice_identity_key text,
  invoice_number text,
  invoice_issue_date date,
  seller_name text,
  seller_tax_code text,
  invoice_symbol text,
  invoice_template_number text,
  goods_services text,
  net_amount numeric(24, 2),
  deductible_vat_amount numeric(24, 2),
  accounting_voucher text,
  accounting_date date,
  tax_rate text,
  description text,
  department_code text,
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  source_stt integer,
  raw_payload jsonb not null default '{}'::jsonb,
  import_id uuid references public.purchase_invoice_imports(id) on delete set null,
  imported_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchase_invoices_issue_date_idx
  on public.purchase_invoices(invoice_issue_date desc nulls last, created_at desc);

create index if not exists purchase_invoices_seller_tax_code_idx
  on public.purchase_invoices(seller_tax_code);

create index if not exists purchase_invoices_invoice_number_idx
  on public.purchase_invoices(invoice_number);

create index if not exists purchase_invoices_identity_key_idx
  on public.purchase_invoices(invoice_identity_key)
  where invoice_identity_key is not null;

create index if not exists purchase_invoices_import_id_idx
  on public.purchase_invoices(import_id, created_at desc);

drop trigger if exists purchase_invoices_set_updated_at on public.purchase_invoices;
create trigger purchase_invoices_set_updated_at
before update on public.purchase_invoices
for each row execute function public.set_updated_at();

alter table public.purchase_invoice_imports enable row level security;
alter table public.purchase_invoices enable row level security;

revoke all on public.purchase_invoice_imports from public, anon, authenticated;
revoke all on public.purchase_invoices from public, anon, authenticated;
grant all on public.purchase_invoice_imports to service_role;
grant all on public.purchase_invoices to service_role;

comment on table public.purchase_invoice_imports is
  'Server-side state for private, staged purchase invoice Excel imports.';

comment on table public.purchase_invoices is
  'Purchase invoice accounting rows imported from Excel. row_fingerprint prevents only exact re-import duplicates.';
