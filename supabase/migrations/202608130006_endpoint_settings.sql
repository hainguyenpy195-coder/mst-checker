-- Configurable primary and fallback taxpayer lookup endpoints.
-- Values are HTTPS URL templates and must contain the {taxCode} placeholder.

create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value text not null,
  description text,
  updated_by text,
  updated_at timestamptz not null default now()
);

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

alter table public.app_settings enable row level security;

insert into public.app_settings (setting_key, setting_value, description)
values
  ('primary_tax_lookup_endpoint', 'https://api.xinvoice.vn/gdt-api/tax-payer/{taxCode}', 'Endpoint tra cứu MST chính'),
  ('fallback_tax_lookup_endpoint', 'https://api.vietqr.io/v2/business/{taxCode}', 'Endpoint tra cứu MST dự phòng')
on conflict (setting_key) do nothing;

comment on table public.app_settings is
  'Server-managed application settings. Endpoint values are HTTPS URL templates containing {taxCode}.';
