-- Invoice numbers are only unique within an issuer and invoice series.
-- Reuse the existing column for the composite identity key to keep the
-- application backward-compatible while changing the uniqueness semantics.

alter table public.invoices
  drop constraint if exists invoices_invoice_number_key_key;

with normalized as (
  select
    id,
    nullif(regexp_replace(upper(coalesce(seller_tax_code, '')), '\s+', '', 'g'), '') as seller_key,
    case
      when nullif(regexp_replace(upper(coalesce(invoice_template_number, '')), '\s+', '', 'g'), '') is null
        and regexp_replace(upper(coalesce(invoice_symbol, '')), '\s+', '', 'g') ~ '^[1-9][A-Z][0-9]{2}[A-Z0-9]{3}$'
        then substring(regexp_replace(upper(invoice_symbol), '\s+', '', 'g') from 1 for 1)
      else nullif(regexp_replace(upper(coalesce(invoice_template_number, '')), '\s+', '', 'g'), '')
    end as template_key,
    case
      when nullif(regexp_replace(upper(coalesce(invoice_template_number, '')), '\s+', '', 'g'), '') is null
        and regexp_replace(upper(coalesce(invoice_symbol, '')), '\s+', '', 'g') ~ '^[1-9][A-Z][0-9]{2}[A-Z0-9]{3}$'
        then substring(regexp_replace(upper(invoice_symbol), '\s+', '', 'g') from 2)
      else nullif(regexp_replace(upper(coalesce(invoice_symbol, '')), '\s+', '', 'g'), '')
    end as symbol_key,
    upper(regexp_replace(invoice_number, '\s+', '', 'g')) as number_key,
    nullif(regexp_replace(coalesce(lookup_url, ''), '\s+', '', 'g'), '') as lookup_url_key,
    nullif(regexp_replace(coalesce(lookup_code, ''), '\s+', '', 'g'), '') as lookup_code_key,
    source_file_sha256
  from public.invoices
)
update public.invoices as invoice
set invoice_number_key = case
  when normalized.seller_key is not null
    and (normalized.template_key is not null or normalized.symbol_key is not null)
    then concat(
      'seller:', normalized.seller_key,
      '|template:', coalesce(normalized.template_key, 'unknown'),
      '|symbol:', coalesce(normalized.symbol_key, 'unknown'),
      '|number:', normalized.number_key
    )
  when normalized.lookup_url_key is not null and normalized.lookup_code_key is not null
    then concat(
      'provider:', normalized.lookup_url_key,
      '|code:', normalized.lookup_code_key,
      '|number:', normalized.number_key
    )
  else concat('file:', normalized.source_file_sha256, '|number:', normalized.number_key)
end
from normalized
where invoice.id = normalized.id;

create unique index if not exists invoices_identity_key_idx
  on public.invoices(invoice_number_key);

comment on column public.invoices.invoice_number_key is
  'Composite normalized invoice identity key; not the invoice number alone.';
