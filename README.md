# 🌡️ Weather Alpha

Polymarket weather trading dashboard with historical tracking.

## Architecture

- **Dashboard** (`dashboard/index.html`) — Static HTML, reads from Supabase + live APIs. Deploy anywhere (GitHub Pages, Vercel, or just open locally).
- **Collector** (`collector/`) — Node.js cron job that writes forecasts + Polymarket odds to Supabase every 15 min. Deploy on Railway.

## Tier 1 Cities

| City | ECMWF Accuracy | Station |
|------|---------------|---------|
| Paris | 87% | CDG (LFPG) |
| Chicago | 83% | O'Hare (KORD) |
| Buenos Aires | 83% | EZE (SAEZ) |
| London | 80% | City (EGLC) |

## Setup

### 1. Supabase
Run `supabase/migration.sql` in your Supabase SQL editor.

### 2. Collector (Railway)
1. Push this repo to GitHub
2. Connect to Railway
3. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
4. Set up as a **cron job** (every 15 minutes): `*/15 * * * *`

### 3. Dashboard
Open `dashboard/index.html` in a browser, or deploy to GitHub Pages.

## Features

- **Live signals** — Real-time ECMWF/GFS/ICON forecasts + Polymarket odds
- **Delta charts** — Historical view of model confidence vs market price over time
- **Consensus filter** — Only signals when ≥2/3 models agree on the same bucket
- **Edge calculation** — Model confidence minus market price = your edge
