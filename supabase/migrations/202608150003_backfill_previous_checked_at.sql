-- Backfill the previous lookup timestamp from the latest tracking year.
-- A taxpayer can occur in more than one taxpayer_sources year, so the newest
-- supported year wins when calculating the single taxpayers.previous_checked_at.

with latest_tracking_year as (
  select
    tax_code,
    max(source_year::integer) as source_year
  from public.taxpayer_sources
  where source_year in ('2023', '2024', '2025', '2026')
  group by tax_code
), mapped_dates as (
  select
    tax_code,
    case source_year
      when 2023 then timestamptz '2025-11-14 00:00:00+07'
      when 2024 then timestamptz '2025-12-11 00:00:00+07'
      when 2025 then timestamptz '2026-03-23 00:00:00+07'
      when 2026 then timestamptz '2026-03-23 00:00:00+07'
    end as previous_checked_at
  from latest_tracking_year
)
update public.taxpayers as taxpayers
set previous_checked_at = mapped_dates.previous_checked_at
from mapped_dates
where taxpayers.tax_code = mapped_dates.tax_code
  and mapped_dates.previous_checked_at is not null;
