-- ============================================================
-- Switch full-carry inputs from personal costs to the market
-- (CME/CBOT) convention:
--   storage  = exchange premium charge, ¢/bu/day
--              corn/soybeans 26.5/100 ¢/day (eff. Jan 2 2025,
--              CBOT filing 24-443); Chicago wheat VSR-governed,
--              currently 16.5/100 ¢/day
--   interest = 3-month SOFR + 200 bps on the front price,
--              360-day count (CME VSR financial-full-carry rule),
--              SOFR fetched daily from the NY Fed public API
-- ============================================================

alter table carry_commodities
  add column if not exists storage_cents_per_bu_day numeric,
  add column if not exists storage_note text;

update carry_commodities set
  storage_cents_per_bu_day = 0.265,
  storage_note = 'CBOT premium charge, effective Jan 2 2025 (filing 24-443)'
where code in ('ZC','ZS');

update carry_commodities set
  storage_cents_per_bu_day = 0.165,
  storage_note = 'CME Variable Storage Rate (VSR) — re-evaluated each delivery cycle'
where code = 'ZW';

alter table carry_settings
  add column if not exists interest_spread_bps int not null default 200,
  add column if not exists sofr_90d_pct numeric,          -- last fetched NY Fed 90-day SOFR average
  add column if not exists sofr_fetched_on date;

-- record the market convention inputs per daily spread row
alter table carry_spreads
  add column if not exists storage_cents_day numeric,
  add column if not exists rate_note text;               -- e.g. 'SOFR90 4.31% + 200bp (NY Fed 2026-07-17)'
