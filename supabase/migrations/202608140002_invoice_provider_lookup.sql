-- Provider-specific invoice lookup details printed on each invoice.

alter table public.invoices
  add column if not exists lookup_url text,
  add column if not exists lookup_code text;

comment on column public.invoices.lookup_url is
  'Invoice provider lookup URL printed on the invoice.';

comment on column public.invoices.lookup_code is
  'Invoice provider lookup code printed on the invoice.';
