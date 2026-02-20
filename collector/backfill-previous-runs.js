// Backfill forecasts from Open-Meteo Previous Runs API
// Gets actual forecast snapshots (not reanalysis) from past model runs
// Data available from Jan 2024 for most models, GFS temp from Apr 2021

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpicWtza3dmamJlaml4eWl1cXBuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTYyNzkzOCwiZXhwIjoyMDgxMjAzOTM4fQ.xzpC9MFUT0ZT-z5ZTQArgDjYFuhl4uX07zDeustSp5c';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CITIES = [
  { name: "London", slug: "london", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London" },
  { name: "Paris", slug: "paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris" },
  { name: "Chicago", slug: "chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago" },
];

const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
const MODEL_NAMES = { ecmwf_ifs025: 'ecmwf', gfs_seamless: 'gfs', icon_seamless: 'icon' };
const MAX_PREVIOUS_DAYS = 5; // Day 0 (latest) through Day 5
const PAST_DAYS = 90; // How far back to fetch

function getBucket(val, unit) {
  if (unit === "F") {
    const b = Math.floor(val / 2) * 2;
    return `${b} to ${b + 1}°F`;
  }
  return `${Math.round(val)}°C`;
}

async function fetchPreviousRuns(city, model, pastDays) {
  const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const prevVars = Array.from({ length: MAX_PREVIOUS_DAYS }, (_, i) =>
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
  if (data.error) throw new Error(data.reason || 'API error');
  return data;
}

function computeDailyMax(hourlyData) {
  // Returns { variable_key: { date: maxTemp } }
  const result = {};
  const times = hourlyData.time;

  for (const [key, values] of Object.entries(hourlyData)) {
    if (key === 'time') continue;
    const dailyMax = {};
    for (let i = 0; i < times.length; i++) {
      if (values[i] == null) continue;
      const date = times[i].slice(0, 10);
      if (!dailyMax[date] || values[i] > dailyMax[date]) {
        dailyMax[date] = values[i];
      }
    }
    result[key] = dailyMax;
  }
  return result;
}

async function fetchActuals(city, startDate, endDate) {
  const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const url = `https://archive-api.open-meteo.com/v1/archive?` +
    `latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_max` +
    `&timezone=${encodeURIComponent(city.tz)}` +
    `&start_date=${startDate}&end_date=${endDate}${tempUnit}`;

  const res = await fetch(url);
  if (!res.ok) return {};
  const data = await res.json();
  const result = {};
  if (data.daily) {
    data.daily.time.forEach((d, i) => {
      if (data.daily.temperature_2m_max[i] != null) {
        result[d] = data.daily.temperature_2m_max[i];
      }
    });
  }
  return result;
}

async function run() {
  console.log(`\n🔄 Backfilling forecast history from Previous Runs API`);
  console.log(`   Past days: ${PAST_DAYS} | Previous runs: Day 0-${MAX_PREVIOUS_DAYS}\n`);

  const allRows = [];
  const accuracyData = {}; // city → model → lead_days → { matches, total, errors }

  for (const city of CITIES) {
    console.log(`\n📍 ${city.name}`);

    // Fetch actuals for comparison
    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - PAST_DAYS);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    console.log(`  Fetching ERA5 actuals ${startStr} → ${endStr}...`);
    const actuals = await fetchActuals(city, startStr, endStr);
    console.log(`  Got ${Object.keys(actuals).length} actual values`);

    for (const model of MODELS) {
      const modelName = MODEL_NAMES[model];
      console.log(`  Fetching ${modelName.toUpperCase()} previous runs...`);

      try {
        const data = await fetchPreviousRuns(city, model, PAST_DAYS);
        const dailyMax = computeDailyMax(data.hourly);

        // Process each "day" (run age)
        for (let dayOffset = 0; dayOffset <= MAX_PREVIOUS_DAYS; dayOffset++) {
          const key = dayOffset === 0 ? 'temperature_2m' : `temperature_2m_previous_day${dayOffset}`;
          const maxByDate = dailyMax[key];
          if (!maxByDate) continue;

          for (const [date, temp] of Object.entries(maxByDate)) {
            const bucket = getBucket(temp, city.unit);
            // lead_days: dayOffset is how many runs ago, which roughly equals lead days
            // Day 0 = latest run (D+0 for today, D+1 for tomorrow)
            // Day 1 = run from yesterday, etc.
            // For a past date, the effective lead is dayOffset
            const leadDays = dayOffset;

            // Synthesize a collected_at timestamp (run was ~dayOffset days before the target date)
            const targetDate = new Date(date + 'T12:00:00Z');
            const collectedAt = new Date(targetDate.getTime() - dayOffset * 86400000);

            allRows.push({
              city: city.slug,
              target_date: date,
              model: modelName,
              temp_value: temp,
              temp_unit: city.unit,
              bucket,
              lead_days: leadDays,
              model_run: `backfill_day${dayOffset}`,
              collected_at: collectedAt.toISOString(),
            });

            // Compute accuracy if we have actuals
            const actual = actuals[date];
            if (actual != null) {
              const actualBucket = getBucket(actual, city.unit);
              const match = bucket === actualBucket;
              const error = Math.abs(temp - actual);

              if (!accuracyData[city.slug]) accuracyData[city.slug] = {};
              if (!accuracyData[city.slug][modelName]) accuracyData[city.slug][modelName] = {};
              if (!accuracyData[city.slug][modelName][leadDays]) {
                accuracyData[city.slug][modelName][leadDays] = { matches: 0, total: 0, errors: [] };
              }
              const s = accuracyData[city.slug][modelName][leadDays];
              s.total++;
              if (match) s.matches++;
              s.errors.push(error);
            }
          }
        }

        console.log(`    ✓ ${modelName}: processed`);
      } catch (e) {
        console.error(`    ✗ ${modelName}: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 500)); // rate limit
    }

    // Compute consensus accuracy
    // Group by date+leadDays, find consensus bucket, compare to actual
    const snapshots = {}; // `${date}|${leadDays}` → { models: { model: bucket } }
    for (const row of allRows.filter(r => r.city === city.slug)) {
      const key = `${row.target_date}|${row.lead_days}`;
      if (!snapshots[key]) snapshots[key] = { date: row.target_date, leadDays: row.lead_days, models: {} };
      snapshots[key].models[row.model] = row.bucket;
    }

    for (const snap of Object.values(snapshots)) {
      const actual = actuals[snap.date];
      if (actual == null) continue;
      const actualBucket = getBucket(actual, city.unit);
      const buckets = Object.values(snap.models);
      const counts = {};
      buckets.forEach(b => counts[b] = (counts[b] || 0) + 1);
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (!top) continue;
      const consensusBucket = top[0];
      const agreement = top[1];

      for (const minCons of [1, 2, 3]) {
        if (agreement < minCons) continue;
        const modelKey = `consensus_gte${minCons}`;
        if (!accuracyData[city.slug][modelKey]) accuracyData[city.slug][modelKey] = {};
        if (!accuracyData[city.slug][modelKey][snap.leadDays]) {
          accuracyData[city.slug][modelKey][snap.leadDays] = { matches: 0, total: 0, errors: [] };
        }
        const s = accuracyData[city.slug][modelKey][snap.leadDays];
        s.total++;
        if (consensusBucket === actualBucket) s.matches++;
      }
    }
  }

  // Print accuracy summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 ACCURACY BY LEAD TIME (from Previous Runs backfill)');
  console.log(`${'='.repeat(70)}`);

  for (const [citySlug, models] of Object.entries(accuracyData)) {
    const city = CITIES.find(c => c.slug === citySlug);
    console.log(`\n📍 ${city.name}`);
    console.log(`${'─'.repeat(60)}`);

    for (const [model, leads] of Object.entries(models).sort()) {
      for (const [ld, s] of Object.entries(leads).sort((a, b) => a[0] - b[0])) {
        const rate = (s.matches / s.total * 100).toFixed(1);
        const mae = s.errors.length > 0
          ? (s.errors.reduce((a, b) => a + b, 0) / s.errors.length).toFixed(2)
          : '-';
        console.log(`  ${model.padEnd(16)} D+${ld}: ${rate.padStart(5)}% (${s.matches}/${s.total})${mae !== '-' ? ` MAE ${mae}` : ''}`);
      }
    }
  }

  // Insert forecast rows into Supabase
  console.log(`\n💾 Inserting ${allRows.length} forecast rows into Supabase...`);
  let inserted = 0;
  for (let i = 0; i < allRows.length; i += 100) {
    const chunk = allRows.slice(i, i + 100);
    let { error } = await supabase.from('forecasts').insert(chunk);
    if (error && (error.message?.includes('lead_days') || error.message?.includes('model_run'))) {
      const compat = chunk.map(({ lead_days, model_run, ...rest }) => rest);
      ({ error } = await supabase.from('forecasts').insert(compat));
    }
    if (error) {
      console.error(`  Chunk ${i}: ${error.message}`);
    } else {
      inserted += chunk.length;
    }
  }
  console.log(`  ✅ Inserted ${inserted}/${allRows.length} rows`);

  // Insert accuracy data
  const accuracyRows = [];
  for (const [citySlug, models] of Object.entries(accuracyData)) {
    for (const [model, leads] of Object.entries(models)) {
      for (const [ld, s] of Object.entries(leads)) {
        const mae = s.errors.length > 0
          ? s.errors.reduce((a, b) => a + b, 0) / s.errors.length
          : null;
        accuracyRows.push({
          city: citySlug,
          model,
          lead_days: parseInt(ld),
          bucket_match_rate: s.matches / s.total,
          mae,
          sample_size: s.total,
          computed_at: new Date().toISOString(),
        });
      }
    }
  }

  if (accuracyRows.length > 0) {
    const { error } = await supabase.from('forecast_accuracy').upsert(accuracyRows, {
      onConflict: 'city,model,lead_days',
    });
    if (error) console.error(`  Accuracy upsert error: ${error.message}`);
    else console.log(`  ✅ Stored ${accuracyRows.length} accuracy rows`);
  }

  console.log('\n✅ Backfill complete!');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
