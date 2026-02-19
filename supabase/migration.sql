-- Weather Alpha: Supabase migration

-- Forecasts table
create table if not exists forecasts (
  id bigint generated always as identity primary key,
  city text not null,
  target_date date not null,
  model text not null,
  temp_value real not null,
  temp_unit text not null,
  bucket text not null,
  collected_at timestamptz not null default now()
);
create index if not exists idx_forecasts_lookup on forecasts (city, target_date, collected_at);

-- Market prices table
create table if not exists market_prices (
  id bigint generated always as identity primary key,
  city text not null,
  target_date date not null,
  bucket text not null,
  price real not null,
  volume real,
  collected_at timestamptz not null default now()
);
create index if not exists idx_market_lookup on market_prices (city, target_date, bucket, collected_at);

-- Signals table
create table if not exists signals (
  id bigint generated always as identity primary key,
  city text not null,
  target_date date not null,
  consensus_bucket text,
  models_agreeing int not null,
  model_confidence real,
  market_price real,
  edge real,
  signal_type text not null,
  collected_at timestamptz not null default now()
);
create index if not exists idx_signals_lookup on signals (city, target_date, collected_at);

-- RLS
alter table forecasts enable row level security;
alter table market_prices enable row level security;
alter table signals enable row level security;

create policy "anon_select_forecasts" on forecasts for select to anon using (true);
create policy "anon_insert_forecasts" on forecasts for insert to anon with check (true);
create policy "anon_select_market_prices" on market_prices for select to anon using (true);
create policy "anon_insert_market_prices" on market_prices for insert to anon with check (true);
create policy "anon_select_signals" on signals for select to anon using (true);
create policy "anon_insert_signals" on signals for insert to anon with check (true);
