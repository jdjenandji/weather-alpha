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

-- Trades table
create table if not exists trades (
  id bigint generated always as identity primary key,
  city text not null,
  target_date date not null,
  bucket text not null,
  price real not null,
  shares real not null,
  cost real not null,
  order_id text,
  signal_type text not null,
  edge real,
  models_agreeing int,
  status text default 'open',
  pnl real,
  created_at timestamptz not null default now()
);
create index if not exists idx_trades_lookup on trades (city, target_date);

-- Trade alerts table (forecast shift monitoring)
create table if not exists trade_alerts (
  id bigint generated always as identity primary key,
  trade_id bigint references trades(id),
  city text not null,
  target_date date not null,
  trade_bucket text not null,
  current_consensus text,
  models_on_bucket int not null,
  state text not null, -- holding, drifting, broken
  detail text,
  model_detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_trade_alerts_lookup on trade_alerts (trade_id, created_at);

-- Backtest results
create table if not exists backtest_results (
  id bigint generated always as identity primary key,
  run_id text not null,
  city text not null,
  target_date date not null,
  actual_temp real,
  actual_bucket text,
  ecmwf_temp real,
  ecmwf_bucket text,
  ecmwf_error real,
  ecmwf_match boolean,
  gfs_temp real,
  gfs_bucket text,
  gfs_error real,
  gfs_match boolean,
  icon_temp real,
  icon_bucket text,
  icon_error real,
  icon_match boolean,
  consensus_bucket text,
  consensus_count int,
  consensus_correct boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_backtest_lookup on backtest_results (run_id, city, target_date);

create table if not exists backtest_summary (
  id bigint generated always as identity primary key,
  run_id text not null,
  city text not null,
  days int not null,
  ecmwf_match_rate real,
  ecmwf_mae real,
  gfs_match_rate real,
  gfs_mae real,
  icon_match_rate real,
  icon_mae real,
  consensus2_rate real,
  consensus2_correct int,
  consensus2_total int,
  consensus3_rate real,
  consensus3_correct int,
  consensus3_total int,
  created_at timestamptz not null default now()
);

-- Historical price timeseries from Polymarket CLOB
create table if not exists price_history (
  id bigint generated always as identity primary key,
  city text not null,
  target_date date not null,
  bucket text not null,
  token_id text not null,
  price real not null,
  timestamp timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_price_history_lookup on price_history (city, target_date, bucket, timestamp);

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

alter table trades enable row level security;
create policy "anon_select_trades" on trades for select to anon using (true);
create policy "anon_insert_trades" on trades for insert to anon with check (true);
create policy "anon_update_trades" on trades for update to anon using (true);

alter table trade_alerts enable row level security;
create policy "anon_select_trade_alerts" on trade_alerts for select to anon using (true);
create policy "anon_insert_trade_alerts" on trade_alerts for insert to anon with check (true);

alter table backtest_results enable row level security;
create policy "anon_select_backtest_results" on backtest_results for select to anon using (true);
create policy "anon_insert_backtest_results" on backtest_results for insert to anon with check (true);
alter table backtest_summary enable row level security;
create policy "anon_select_backtest_summary" on backtest_summary for select to anon using (true);
create policy "anon_insert_backtest_summary" on backtest_summary for insert to anon with check (true);

alter table price_history enable row level security;
create policy "anon_select_price_history" on price_history for select to anon using (true);
create policy "anon_insert_price_history" on price_history for insert to anon with check (true);
