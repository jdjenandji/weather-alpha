# Weather Alpha Dashboard — Full Spec

## Overview
A Polymarket weather trading dashboard with:
1. **Collector** (Node.js) — runs on Railway as a cron, writes forecasts + market odds to Supabase every 15 min
2. **Dashboard** (single `index.html`) — reads from Supabase, shows Tier 1 cities + time-series charts of forecast confidence vs market price

## Supabase
- URL: `https://jbqkskwfjbejixyiuqpn.supabase.co`
- Anon key: `sb_publishable_6TopOsnadhqteb8xltZiZw_epDDV-cm`

### Tables to create (provide SQL migration file `supabase/migration.sql`)

**`forecasts`**
- `id` bigint generated always as identity primary key
- `city` text not null (paris, london, chicago, buenos-aires)
- `target_date` date not null (the date the forecast is for)
- `model` text not null (ecmwf, gfs, icon)
- `temp_value` real not null (raw forecast temp)
- `temp_unit` text not null (C or F)
- `bucket` text not null (e.g. "8°C" or "32-33°F")
- `collected_at` timestamptz not null default now()
- Index on (city, target_date, collected_at)

**`market_prices`**
- `id` bigint generated always as identity primary key
- `city` text not null
- `target_date` date not null
- `bucket` text not null (the market outcome, e.g. "8°C", "32-33°F")
- `price` real not null (0-1, the YES price)
- `volume` real
- `collected_at` timestamptz not null default now()
- Index on (city, target_date, bucket, collected_at)

**`signals`**
- `id` bigint generated always as identity primary key
- `city` text not null
- `target_date` date not null
- `consensus_bucket` text (null if no consensus)
- `models_agreeing` int not null
- `model_confidence` real (historical accuracy for this city)
- `market_price` real (price of consensus bucket)
- `edge` real (model_confidence - market_price)
- `signal_type` text not null (strong, marginal, skip)
- `collected_at` timestamptz not null default now()

Enable RLS on all tables. Add a policy allowing anon SELECT on all tables and anon INSERT on all tables (the collector uses the anon key).

## Tier 1 Cities ONLY

```js
const CITIES = [
  { name: "Paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris", slug: "paris", hist: 0.87 },
  { name: "London", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London", slug: "london", hist: 0.80 },
  { name: "Chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago", slug: "chicago", hist: 0.83 },
  { name: "Buenos Aires", lat: -34.5561, lon: -58.4156, unit: "C", tz: "America/Argentina/Buenos_Aires", slug: "buenos-aires", hist: 0.83 },
];
```

## Collector (`collector/index.js`)

- Node.js, uses `@supabase/supabase-js`
- Fetches forecasts from Open-Meteo for each city × (today, tomorrow, day after)
- Fetches Polymarket odds from `https://gamma-api.polymarket.com/events?slug=highest-temperature-in-{slug}-on-{date}`
- Computes consensus signal
- Writes all data to Supabase tables (forecasts, market_prices, signals)
- `package.json` with start script
- Should be deployable on Railway as a cron job (just runs once and exits)
- Include a `Dockerfile` or `railway.json` if helpful

### Open-Meteo API
```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max&timezone={tz}&start_date={date}&end_date={date}&models=ecmwf_ifs025,gfs_seamless,icon_seamless&temperature_unit=fahrenheit (only for F cities)
```

### Polymarket API
```
https://gamma-api.polymarket.com/events?slug=highest-temperature-in-{slug}-on-{month}-{day}-{year}
```
Date format in slug: `january-19-2026` (lowercase month name, day without leading zero, 4-digit year)

Response: array of events, each has `markets` array. Each market has:
- `groupItemTitle` — the bucket label
- `outcomePrices` — JSON string array, first element is YES price
- `volume` — string
- `clobTokenIds` — JSON string array

### Bucket logic
- Celsius cities: `Math.round(temp)` → bucket label `"X°C"`
- Fahrenheit cities: `Math.floor(temp / 2) * 2` → bucket label `"X to X+1°F"` (check actual Polymarket labels)

### Consensus logic
- Get bucket for each model
- If ≥2/3 agree → consensus bucket = that bucket
- Model confidence = city.hist (historical accuracy)
- Edge = model_confidence - market_price_of_consensus_bucket
- Signal: strong (edge > 0.15 && consensus), marginal (edge > 0.05 && consensus), skip otherwise

## Dashboard (`dashboard/index.html`)

Single HTML file, no build step. Uses:
- Supabase JS client (CDN)
- Chart.js (CDN) for time-series graphs

### Layout
1. **Summary bar** — signals today, strong count, best edge
2. **City cards** (4 cards, one per Tier 1 city) showing:
   - Latest forecasts from 3 models
   - Consensus signal badge
   - Top 5 market prices with bars
   - Edge calculation
3. **📈 Time-series chart per city** (the key new feature):
   - X axis: time (collected_at)
   - Y axis left: model forecast confidence / probability (0-100%)
   - Y axis right: market price of consensus bucket (0-100%)
   - Lines: "Model Confidence" (flat line at city hist %), "Market Price" (from market_prices table for the consensus bucket)
   - Shaded area between them = the edge/delta
   - One chart per city, showing data for the next upcoming target_date
   - User can toggle between target dates

### Style
- Dark theme (black/dark gray background, green/red accents)
- Same aesthetic as existing dashboard
- Mobile responsive

## File Structure
```
/
├── collector/
│   ├── index.js
│   ├── package.json
│   └── Dockerfile
├── dashboard/
│   └── index.html
├── supabase/
│   └── migration.sql
├── railway.json
└── README.md
```

## Important Notes
- The collector should be idempotent — running it multiple times just adds more data points
- Dashboard reads only, collector writes only
- All times in UTC
- Keep it simple — no frameworks, no build steps for dashboard
- The Supabase anon key is fine for both read and write (RLS policies allow it)
