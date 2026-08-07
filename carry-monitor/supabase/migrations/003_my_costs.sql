-- ============================================================
-- Personal cost-of-carry inputs for the Store-or-Sell comparison.
-- These NEVER feed the market %-of-full-carry math (which stays on
-- the CME convention) — they are only compared against it to rank
-- which crops to sell first.
-- ============================================================

create table if not exists carry_my_costs (
  commodity            text primary key references carry_commodities(code),
  storage_cents_month  numeric not null default 4.0,  -- your real storage ¢/bu/month
  updated_at           timestamptz not null default now()
);

insert into carry_my_costs (commodity) values ('ZC'), ('ZS'), ('ZW')
on conflict (commodity) do nothing;

alter table carry_settings
  add column if not exists my_interest_rate_pct numeric not null default 7.5;

alter table carry_my_costs enable row level security;
create policy carry_my_costs_all on carry_my_costs
  for all to anon, authenticated using (true) with check (true);
