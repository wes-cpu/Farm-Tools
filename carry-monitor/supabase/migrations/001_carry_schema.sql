-- ============================================================
-- Commodity Futures Carry Monitor — database schema
-- All objects are prefixed carry_ so they can live safely
-- inside an existing Supabase project.
-- ============================================================

-- ------------------------------------------------------------
-- Commodities we track. storage_cents_per_bu_month is editable
-- from the Settings screen (CBOT wheat uses a seasonal Variable
-- Storage Rate — adjust it there when CME changes the VSR).
-- ------------------------------------------------------------
create table if not exists carry_commodities (
  code                        text primary key,          -- ZC / ZS / ZW
  name                        text not null,
  month_codes                 text[] not null,           -- listed contract months
  yahoo_suffix                text not null default '.CBT',
  storage_cents_per_bu_month  numeric not null default 5.0,
  updated_at                  timestamptz not null default now()
);

insert into carry_commodities (code, name, month_codes, storage_cents_per_bu_month) values
  ('ZC', 'Corn',     '{H,K,N,U,Z}',     5.0),
  ('ZS', 'Soybeans', '{F,H,K,N,Q,U,X}', 5.0),
  ('ZW', 'Wheat',    '{H,K,N,U,Z}',     5.0)
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- Global settings (single row, id always 1)
-- ------------------------------------------------------------
create table if not exists carry_settings (
  id                 int primary key default 1 check (id = 1),
  alert_email        text not null default 'wes@seifert.farm',
  interest_rate_pct  numeric not null default 7.5,      -- annual %
  digest_frequency   text not null default 'off'
                     check (digest_frequency in ('off','daily','weekly')),
  updated_at         timestamptz not null default now()
);

insert into carry_settings (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- Write-only secrets (anon key can set but never read these).
-- The edge function reads them with the service role.
-- ------------------------------------------------------------
create table if not exists carry_secrets (
  id              int primary key default 1 check (id = 1),
  resend_api_key  text,
  updated_at      timestamptz not null default now()
);

insert into carry_secrets (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- Daily settlement prices per contract
-- ------------------------------------------------------------
create table if not exists carry_prices (
  id           bigint generated always as identity primary key,
  quote_date   date not null,
  symbol       text not null,             -- e.g. ZCH27
  commodity    text not null references carry_commodities(code),
  month_code   text not null,
  year         int  not null,
  price_cents  numeric not null,          -- cents per bushel
  fetched_at   timestamptz not null default now(),
  unique (quote_date, symbol)
);

create index if not exists carry_prices_symbol_idx on carry_prices (symbol, quote_date);

-- ------------------------------------------------------------
-- Daily spread history between consecutive contract months.
-- One row per (date, pair). Rows stop being written once the
-- front contract reaches first notice day.
-- ------------------------------------------------------------
create table if not exists carry_spreads (
  id                  bigint generated always as identity primary key,
  quote_date          date not null,
  commodity           text not null references carry_commodities(code),
  front_symbol        text not null,
  back_symbol         text not null,
  front_price_cents   numeric not null,
  back_price_cents    numeric not null,
  spread_cents        numeric not null,   -- back minus front
  days_between        int not null,       -- front FND -> back FND
  storage_cents_month numeric not null,   -- inputs used that day
  interest_rate_pct   numeric not null,
  full_carry_cents    numeric not null,
  pct_of_full_carry   numeric,            -- null when full carry <= 0
  front_fnd           date not null,      -- first notice day of front
  created_at          timestamptz not null default now(),
  unique (quote_date, front_symbol, back_symbol)
);

create index if not exists carry_spreads_pair_idx
  on carry_spreads (commodity, front_symbol, back_symbol, quote_date);

-- ------------------------------------------------------------
-- User-defined alert targets ("watches")
--   frequency 'once'  -> email on the day the target is first
--                        reached; re-arms after dropping below
--   frequency 'daily' -> email every day it closes at/above target
-- ------------------------------------------------------------
create table if not exists carry_watches (
  id               bigint generated always as identity primary key,
  commodity        text not null references carry_commodities(code),
  front_symbol     text not null,
  back_symbol      text not null,
  target_pct       numeric not null,
  frequency        text not null default 'once' check (frequency in ('once','daily')),
  enabled          boolean not null default true,
  state            text not null default 'below' check (state in ('below','above')),
  last_alert_date  date,
  created_at       timestamptz not null default now(),
  unique (front_symbol, back_symbol)
);

-- ------------------------------------------------------------
-- Log of every email attempt + every daily run
-- ------------------------------------------------------------
create table if not exists carry_alert_log (
  id            bigint generated always as identity primary key,
  sent_at       timestamptz not null default now(),
  watch_id      bigint references carry_watches(id) on delete set null,
  kind          text not null check (kind in ('target','digest','error','test')),
  recipient     text,
  subject       text,
  body_preview  text,
  success       boolean not null,
  error         text
);

create table if not exists carry_run_log (
  id                bigint generated always as identity primary key,
  run_at            timestamptz not null default now(),
  ok                boolean not null,
  contracts_fetched int not null default 0,
  spreads_computed  int not null default 0,
  alerts_sent       int not null default 0,
  message           text
);

-- ------------------------------------------------------------
-- Row level security.
-- Single-user tool: the browser (anon key) may read market data
-- and manage its own settings/watches, but can never read secrets.
-- ------------------------------------------------------------
alter table carry_commodities enable row level security;
alter table carry_settings    enable row level security;
alter table carry_secrets     enable row level security;
alter table carry_prices      enable row level security;
alter table carry_spreads     enable row level security;
alter table carry_watches     enable row level security;
alter table carry_alert_log   enable row level security;
alter table carry_run_log     enable row level security;

-- read-only market data + logs
create policy carry_prices_read    on carry_prices    for select to anon, authenticated using (true);
create policy carry_spreads_read   on carry_spreads   for select to anon, authenticated using (true);
create policy carry_alert_log_read on carry_alert_log for select to anon, authenticated using (true);
create policy carry_run_log_read   on carry_run_log   for select to anon, authenticated using (true);

-- editable configuration
create policy carry_commodities_read   on carry_commodities for select to anon, authenticated using (true);
create policy carry_commodities_update on carry_commodities for update to anon, authenticated using (true) with check (true);

create policy carry_settings_read   on carry_settings for select to anon, authenticated using (true);
create policy carry_settings_update on carry_settings for update to anon, authenticated using (true) with check (true);

create policy carry_watches_all on carry_watches
  for all to anon, authenticated using (true) with check (true);

-- carry_secrets: no anon policies at all -> unreadable/unwritable
-- with the anon key. The two RPCs below are the only doorway.

create or replace function carry_set_resend_key(key text)
returns void
language sql
security definer
set search_path = public
as $$
  update carry_secrets
     set resend_api_key = nullif(trim(key), ''),
         updated_at = now()
   where id = 1;
$$;

create or replace function carry_secret_status()
returns boolean
language sql
security definer
set search_path = public
as $$
  select resend_api_key is not null from carry_secrets where id = 1;
$$;

grant execute on function carry_set_resend_key(text) to anon, authenticated;
grant execute on function carry_secret_status()      to anon, authenticated;
