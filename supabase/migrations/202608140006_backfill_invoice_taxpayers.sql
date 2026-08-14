-- Backfill seller tax codes from invoices imported before automatic taxpayer
-- synchronization was enabled. The statements are idempotent and only add
-- seller tax codes that are not already in the taxpayer catalogue.

create temporary table invoice_seller_backfill on commit drop as
with normalized_invoices as (
  select
    regexp_replace(
      replace(replace(trim(i.seller_tax_code), '–', '-'), '—', '-'),
      '\s+', '', 'g'
    ) as tax_code,
    nullif(trim(i.seller_name), '') as seller_name,
    coalesce(
      (regexp_match(coalesce(i.invoice_date, ''), '(19[0-9]{2}|20[0-9]{2})'))[1],
      extract(year from timezone('Asia/Ho_Chi_Minh', now()))::text
    ) as source_year,
    left('Tự động bổ sung từ hóa đơn: ' || coalesce(i.source_file_name, ''), 500) as source_note,
    i.created_at
  from public.invoices i
  where i.seller_tax_code is not null
), candidates as (
  select distinct on (normalized_invoices.tax_code)
    normalized_invoices.tax_code,
    normalized_invoices.seller_name,
    normalized_invoices.source_year,
    normalized_invoices.source_note
  from normalized_invoices
  where normalized_invoices.tax_code ~ '^([0-9]{10}|[0-9]{10}-[0-9]{3}|[0-9]{12})$'
    and not exists (
      select 1
      from public.taxpayers t
      where t.tax_code = normalized_invoices.tax_code
    )
  order by normalized_invoices.tax_code, normalized_invoices.created_at desc
)
select * from candidates;

insert into public.taxpayers (tax_code, name, status_group, next_check_at)
select tax_code, seller_name, 'unknown', now()
from invoice_seller_backfill
on conflict on constraint taxpayers_pkey do nothing;

insert into public.taxpayer_sources (
  tax_code,
  source_sheet,
  source_year,
  source_row,
  source_vendor_name,
  source_note
)
select tax_code, 'INVOICE', source_year, null, seller_name, source_note
from invoice_seller_backfill
on conflict do nothing;

insert into public.refresh_queue (tax_code, priority, state, run_after)
select tax_code, 20, 'queued', now()
from invoice_seller_backfill
on conflict on constraint refresh_queue_pkey do nothing;
