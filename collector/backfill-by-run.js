// Backfill D+0 accuracy by model run (time-of-day)
// Uses Previous Runs API to get forecasts from specific model initialization times
// ECMWF: 2 runs/day → Day0=latest, Day1=12h ago, Day2=24h ago, Day3=36h ago
// GFS/ICON: 4 runs/day → Day0=latest, Day1=6h ago, Day2=12h ago, Day3=18h ago

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpicWtza3dmamJlaml4eWl1cXBuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTYyNzkzOCwiZXhwIjoyMDgxMjAzOTM4fQ.xzpC9MFUT0ZT-z5ZTQArgDjYFuhl4uX07zDeustSp5c';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CITIES = [
  { name: "London", slug: "london", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London" },
  { name: "Paris", slug: "paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris" },
  { name: "Chicago", slug: "chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago" },
];

// For ECMWF (2 runs/day): each "previous_day" = 12h apart
// Day0 = most recent run, Day1 = 12h before, Day2 = 24h before...
// For D+0 target (same-day): Day0 forecast was made ~0-12h before, Day1 ~12-24h before
const ECMWF_RUN_LABELS = {
  0: 'latest (00z or 12z)',
  1: 'prev run (-12h)',
  2: 'prev run (-24h)',
  3: 'prev run (-36h)',
  4: 'prev run (-48h)',
  5: 'prev run (-60h)',
};

// For GFS/ICON (4 runs/day): each "previous_day" = 6h apart
const GFS_RUN_LABELS = {
  0: 'latest (any)',
  1: 'prev run (-6h)',
  2: 'prev run (-12h)',
  3: 'prev run (-18h)',
  4: 'prev run (-24h)',
  5: 'prev run (-30h)',
};

const PAST_DAYS = 90;
const MAX_PREV = 5;

function getBucket(val, unit) {
  if (unit === "F") {
    const b = Math.floor(val / 2) * 2;
    return `${b} to ${b + 1}°F`;
  }
  return `${Math.round(val)}°C`;
}

async function fetchPrevRuns(city, model, pastDays) {
  const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const prevVars = Array.from({ length: MAX_PREV }, (_, i) =>
    `temperature_2m_previous_day${i + 1}`
  ).join(',');

  const url = `https://previous-runs-api.open-meteo.com/v1/forecast?` +
    `latitude=${city.lat}&longitude=${city.lon}` +
    `&hourly=temperature_2m,${prevVars}` +
    `&models=${model}` +
    `&timezone=${encodeURIComponent(city.tz)}` +
    `&past_days=${pastDays}&forecast_days=0${tempUnit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason);
  return data;
}

function computeDailyMax(hourlyData) {
  const result = {};
  const times = hourlyData.time;
  for (const [key, values] of Object.entries(hourlyData)) {
    if (key === 'time') continue;
    const dailyMax = {};
    for (let i = 0; i < times.length; i++) {
      if (values[i] == null) continue;
      const date = times[i].slice(0, 10);
      if (!dailyMax[date] || values[i] > dailyMax[date]) dailyMax[date] = values[i];
    }
    result[key] = dailyMax;
  }
  return result;
}

async function fetchActuals(city, startDate, endDate) {
  const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&start_date=${startDate}&end_date=${endDate}${tempUnit}`;
  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const result = {};
  if (data.daily) {
    data.daily.time.forEach((d, i) => {
      if (data.daily.temperature_2m_max[i] != null) result[d] = data.daily.temperature_2m_max[i];
    });
  }
  return result;
}

async function run() {
  console.log(`🕐 D+0 Accuracy by Model Run (time-of-day analysis)`);
  console.log(`   90 days, Previous Runs Day 0-${MAX_PREV}\n`);

  const MODELS = [
    { api: 'ecmwf_ifs025', name: 'ecmwf', runsPerDay: 2 },
    { api: 'gfs_seamless', name: 'gfs', runsPerDay: 4 },
    { api: 'icon_seamless', name: 'icon', runsPerDay: 4 },
  ];

  const allAccuracy = {}; // city → model → hoursBeforeResolution → { matches, total, errors }

  for (const city of CITIES) {
    console.log(`\n📍 ${city.name}`);
    allAccuracy[city.slug] = {};

    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - PAST_DAYS);

    console.log(`  Fetching actuals...`);
    const actuals = await fetchActuals(city, startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10));
    console.log(`  Got ${Object.keys(actuals).length} actual values`);

    for (const model of MODELS) {
      console.log(`  Fetching ${model.name.toUpperCase()} previous runs...`);
      allAccuracy[city.slug][model.name] = {};

      try {
        const data = await fetchPrevRuns(city, model.api, PAST_DAYS);
        const dailyMax = computeDailyMax(data.hourly);

        for (let dayOffset = 0; dayOffset <= MAX_PREV; dayOffset++) {
          const key = dayOffset === 0 ? 'temperature_2m' : `temperature_2m_previous_day${dayOffset}`;
          const maxByDate = dailyMax[key];
          if (!maxByDate) continue;

          // Convert dayOffset to hours before resolution
          // ECMWF: 2 runs/day = 12h apart, GFS/ICON: 4 runs/day = 6h apart
          const hoursBack = dayOffset * (24 / model.runsPerDay);
          const runLabel = `${hoursBack}h before`;

          const stats = { matches: 0, total: 0, errors: [] };

          for (const [date, temp] of Object.entries(maxByDate)) {
            const actual = actuals[date];
            if (actual == null) continue;

            const bucket = getBucket(temp, city.unit);
            const actualBucket = getBucket(actual, city.unit);
            stats.total++;
            if (bucket === actualBucket) stats.matches++;
            stats.errors.push(Math.abs(temp - actual));
          }

          allAccuracy[city.slug][model.name][hoursBack] = stats;
        }

        console.log(`    ✓ ${model.name} processed`);
      } catch (e) {
        console.error(`    ✗ ${model.name}: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Print results
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 D+0 ACCURACY BY HOURS BEFORE RESOLUTION');
  console.log(`${'='.repeat(70)}`);

  for (const [citySlug, models] of Object.entries(allAccuracy)) {
    const city = CITIES.find(c => c.slug === citySlug);
    console.log(`\n📍 ${city.name}`);
    console.log(`${'─'.repeat(60)}`);

    for (const [model, hoursBefore] of Object.entries(models)) {
      for (const [h, s] of Object.entries(hoursBefore).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        if (s.total === 0) continue;
        const rate = (s.matches / s.total * 100).toFixed(1);
        const mae = (s.errors.reduce((a, b) => a + b, 0) / s.errors.length).toFixed(2);
        console.log(`  ${model.toUpperCase().padEnd(6)} ${String(h).padStart(3)}h before: ${rate.padStart(5)}% (${s.matches}/${s.total}) MAE ${mae}`);
      }
    }
  }

  // Store to Supabase
  const rows = [];
  for (const [citySlug, models] of Object.entries(allAccuracy)) {
    for (const [model, hoursBefore] of Object.entries(models)) {
      for (const [h, s] of Object.entries(hoursBefore)) {
        if (s.total === 0) continue;
        const mae = s.errors.reduce((a, b) => a + b, 0) / s.errors.length;
        rows.push({
          city: citySlug,
          model: `${model}_${h}h`,
          lead_days: 0,
          bucket_match_rate: s.matches / s.total,
          mae,
          sample_size: s.total,
          computed_at: new Date().toISOString(),
        });
      }
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('forecast_accuracy').upsert(rows, { onConflict: 'city,model,lead_days' });
    if (error) console.error('Upsert error:', error.message);
    else console.log(`\n✅ Stored ${rows.length} accuracy-by-run rows`);
  }

  console.log('\nDone.');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
