-- ============================================================
-- Expected local basis by calendar month, per commodity.
-- A personal bias (¢ vs futures, usually negative) used ONLY in
-- the Store-or-Sell comparison: expected basis gain from holding
-- = basis[target month] − basis[current month].
-- ============================================================

create table if not exists carry_basis (
  commodity    text not null references carry_commodities(code),
  month        int  not null check (month between 1 and 12),
  basis_cents  numeric,                 -- null = no opinion for that month
  updated_at   timestamptz not null default now(),
  primary key (commodity, month)
);

alter table carry_basis enable row level security;
create policy carry_basis_all on carry_basis
  for all to anon, authenticated using (true) with check (true);
