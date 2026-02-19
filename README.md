# 🌡️ Weather Alpha

Automated Polymarket weather trading bot with multi-model forecast consensus, real-time monitoring, and historical backtesting.

## How It Works

1. **Collect** — Fetches ECMWF, GFS, ICON forecasts + Polymarket odds every 5 min
2. **Signal** — Detects when models agree on a temperature bucket that the market underprices
3. **Trade** — Auto paper-trades strong signals (real trading ready, pending geo-proxy)
4. **Monitor** — Tracks forecast shifts against open positions (HOLDING → DRIFTING → BROKEN)
5. **Resolve** — Auto-closes trades using ERA5 archive actuals, calculates P&L

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌───────────┐
│  Open-Meteo  │────▶│          │────▶│  Supabase  │
│  (forecasts) │     │ Collector│     │  (7 tables)│
├─────────────┤     │ (Railway)│     └─────┬─────┘
│  Polymarket  │────▶│  */5 min │           │
│  (odds+CLOB) │     └──────────┘     ┌─────▼─────┐
└─────────────┘                       │ Dashboard  │
                                      │ (static)   │
                                      └───────────┘
```

- **Collector** (`collector/`) — Node.js, runs on Railway cron every 5 min. Writes forecasts, market prices, signals, paper trades, alerts to Supabase.
- **Dashboard** (`dashboard/index.html`) — Single HTML file, no build step. Reads from Supabase + live APIs. Chart.js for visualizations.
- **Backtest** (`backtest/`) — 90-day backtest + historical Polymarket price scraper.

## Trading Logic (v2)

Based on 90-day backtest (Nov 2025 → Feb 2026):

### Active Markets

| City | Station | Consensus Req | Win Rate (≥2/3) | Win Rate (3/3) | ECMWF MAE |
|------|---------|--------------|-----------------|----------------|-----------|
| 🇬🇧 London | EGLC | ≥2/3 (primary) | **83%** | **90%** | 0.17°C |
| 🇫🇷 Paris | LFPG | 3/3 only | 65% | **75%** | 0.29°C |
| 🇺🇸 Chicago | KORD | 3/3 only | 66% | **83%** | 0.42°F |

Buenos Aires removed — 60% consensus rate, not tradeable.

### Signal Filters

1. **ECMWF must agree** — If ECMWF disagrees with consensus, skip (ECMWF is the best model for all cities)
2. **Per-city consensus threshold** — London ≥2/3, Paris and Chicago need 3/3
3. **Edge > 15%** — Model confidence minus market price must exceed 15%
4. **Max entry price ≤ 50¢** — If market already agrees, there's no edge
5. **One trade per city per date** — No doubling down
6. **Forecast shift monitor** — Alerts on DRIFTING (1 model left) and BROKEN (consensus flipped)

### ECMWF Drop Detection

ECMWF 00z drops at ~05:30 UTC, 12z at ~17:30 UTC. The collector runs every 5 min but only does full collection on 15-min marks — **except during drop windows** (05:20-06:00 and 17:20-18:00 UTC) where it runs every cycle to catch new forecasts within ~2.5 min.

### Key Finding: Entry Timing

From 31,802 historical Polymarket price points:

| Entry Time (D-1) | London | Chicago | Paris |
|-------------------|--------|---------|-------|
| 06:00 UTC (post-00z) | **33.6¢** | 41.4¢ | 49.0¢ |
| 11:00 UTC | 37.8¢ | 42.4¢ | 49.4¢ |
| 18:00 UTC (post-12z) | 39.1¢ | 49.7¢ | 56.3¢ |

06:00 UTC is the cheapest entry — right after the ECMWF 00z drop.

## Dashboard Tabs

1. **📡 Live Signals** — Real-time forecasts + Polymarket odds with v2 logic (ECMWF check, tier badges, per-city thresholds)
2. **📈 Delta Charts** — Time-series: ECMWF forecast temp vs market favorite temp
3. **💰 Trades** — Paper trades with current price, unrealized P&L, forecast monitor alerts
4. **📊 Backtest** — 90-day results, model accuracy charts, monthly breakdown, realistic P&L from historical prices
5. **🧠 Trading Logic** — Full strategy documentation, signal flow, learnings

## Supabase Tables

| Table | Purpose |
|-------|---------|
| `forecasts` | ECMWF/GFS/ICON forecast temps per city per date |
| `market_prices` | Polymarket odds per bucket per collection |
| `signals` | Computed signals (consensus, edge, signal type) |
| `trades` | Paper trades (entry, cost, shares, status, P&L) |
| `trade_alerts` | Forecast shift alerts (holding/drifting/broken) |
| `backtest_results` | 90-day daily backtest data |
| `backtest_summary` | Per-city backtest summary stats |
| `price_history` | Historical Polymarket CLOB price timeseries |

## Setup

### 1. Supabase
Run `supabase/migration.sql` in your Supabase SQL editor.

### 2. Collector (Railway)
Connect repo to Railway, create a cron service:
- **Root Directory:** `collector`
- **Build:** `npm install`
- **Start:** `node index.js`
- **Cron:** `*/5 * * * *`
- **Env vars:**
  - `SUPABASE_URL`
  - `SUPABASE_KEY`
  - `POLY_MAX_BET` (default: 20)
  - `POLY_MAX_ENTRY` (default: 0.50)

### 3. Dashboard (Railway)
Same repo, separate service:
- **Root Directory:** `dashboard`
- **Start:** `npx serve -s . -l $PORT`

### 4. Backtest (manual)
```bash
cd backtest && npm install
node backtest.js          # 90-day model accuracy backtest
node scrape-history.js    # Scrape Polymarket historical prices
```

## Data Sources

| Source | Purpose |
|--------|---------|
| [Open-Meteo](https://open-meteo.com) | ECMWF IFS 0.25°, GFS, ICON forecasts + ERA5 archive |
| [Polymarket Gamma API](https://gamma-api.polymarket.com) | Market odds, event slugs |
| [Polymarket CLOB](https://clob.polymarket.com) | Historical prices, order books |
| [Weather Underground](https://wunderground.com) | Resolution source (airport METAR stations) |

## Live Trading (TODO)

Currently paper trading only. Live trading via `@polymarket/clob-client` is implemented in `collector/trader.js` but disabled due to Polymarket geo-restrictions (EU/US blocked). Requires a proxy in an allowed country (Canada, Brazil, Japan, etc.).
