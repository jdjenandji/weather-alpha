# 🌡️ Weather Alpha — Post-Mortem

**Status: ARCHIVED** — No tradeable edge found.

## What This Was

An attempt to trade Polymarket weather temperature markets using ECMWF/GFS/ICON weather model forecasts. The hypothesis: weather models are more accurate than market prices at predicting daily high temperatures, creating exploitable edge.

## What We Built

- **Collector** (`collector/`) — Node.js on Railway, fetched forecasts + market prices every 15 min
- **Dashboard** (`dashboard/index.html`) — Single HTML file with 8 tabs: live signals, delta charts, trades, backtest, model drops, market lag, D0 vs D1 comparison, accuracy by run
- **Backtest** (`backtest/`) — 90-day backtest + Polymarket CLOB historical price scraper

## Why It Doesn't Work

### The Resolution Source Problem

Polymarket London temperature markets resolve against **Weather Underground's EGLC (London City Airport) station data**, not ERA5 reanalysis or model grid cells.

ECMWF/GFS/ICON forecast a grid cell average. The EGLC station consistently reads **~1°C higher** than the grid cell. This is enough to flip the 1°C temperature bucket ~53% of the time.

### The Numbers (90-day backtest, Nov 2025 – Feb 2026)

| Metric | vs ERA5 (wrong) | vs WU/EGLC (correct) |
|--------|-----------------|----------------------|
| D0 same-day accuracy | 86% | **42%** |
| D1 night-before accuracy | 63% | **30%** |
| Edge (w/ market prices) | 37% | **4%** |

A +0.5°C bias correction improves D0 to ~60%, but that's barely breakeven after spread/fees.

### Other Dead Ends

- **Market lag**: Market prices at 05:30 UTC average ~50¢ for the forecast bucket — no systematic mispricing
- **Informational edge**: METAR data from EGLC is public and near-real-time; no speed advantage
- **WU delay**: WU publishes with some delay, but serious traders already watch raw METAR

## Key Lesson

The forecast models are good at predicting what they're designed to predict (grid cell averages). But prediction markets resolve against specific station observations, and the station-vs-grid divergence destroys the edge. Any weather prediction market strategy must start by understanding the **exact resolution source** and whether models can predict it accurately.

## Tech Stack

- Supabase (Postgres) — `market_prices`, `forecasts`, `forecast_accuracy`, `model_drops` tables
- Open-Meteo Previous Runs API — historical forecast snapshots
- Weather Underground API — actual station observations (EGLC)
- Polymarket CLOB API — historical price data
- Chart.js — dashboard visualizations
- Vercel — dashboard hosting
- Railway — collector hosting

## Dashboard

Still live at the Vercel URL if you want to explore the data. The **🔀 D0 vs D1** tab shows the full picture with correct WU actuals.

---

*Built Feb 2026. RIP.*
