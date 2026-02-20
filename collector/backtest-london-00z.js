// Backtest: ECMWF London D+0, morning 00z run only
// The 00z run is available ~05:30 UTC. For same-day trading, this is the key window.
// In Previous Runs API: Day 1 = the run 12h before latest = the 00z run (since latest = 12z)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpicWtza3dmamJlaml4eWl1cXBuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTYyNzkzOCwiZXhwIjoyMDgxMjAzOTM4fQ.xzpC9MFUT0ZT-z5ZTQArgDjYFuhl4uX07zDeustSp5c';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const LAT = 51.5053, LON = 0.0553;
const PAST_DAYS = 90;

function getBucket(val) { return `${Math.round(val)}°C`; }

async function run() {
  console.log('🌅 BACKTEST: ECMWF London D+0 — Morning 00z Run Only');
  console.log('='.repeat(65));
  console.log('The 00z run drops ~05:30 UTC. You have until ~12:00-15:00 UTC (London high).\n');

  // Fetch ECMWF Previous Runs: Day 1 = 00z morning run (12h before latest 12z)
  // Also fetch Day 0 (12z, afternoon) for comparison
  const url = `https://previous-runs-api.open-meteo.com/v1/forecast?` +
    `latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,temperature_2m_previous_day1` +
    `&models=ecmwf_ifs025&timezone=Europe/London` +
    `&past_days=${PAST_DAYS}&forecast_days=0`;

  console.log('Fetching ECMWF previous runs...');
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.reason);

  // Compute daily max for each run
  const dailyMax = {};
  for (const key of ['temperature_2m', 'temperature_2m_previous_day1']) {
    dailyMax[key] = {};
    for (let i = 0; i < data.hourly.time.length; i++) {
      const v = data.hourly[key][i];
      if (v == null) continue;
      const date = data.hourly.time[i].slice(0, 10);
      if (!dailyMax[key][date] || v > dailyMax[key][date]) dailyMax[key][date] = v;
    }
  }

  // Fetch ERA5 actuals
  const dates = Object.keys(dailyMax['temperature_2m_previous_day1']).sort();
  console.log(`Fetching ERA5 actuals for ${dates.length} days...`);
  const archUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max&timezone=Europe/London&start_date=${dates[0]}&end_date=${dates[dates.length-1]}`;
  const archRes = await fetch(archUrl);
  const archData = await archRes.json();

  const actuals = {};
  if (archData.daily) {
    archData.daily.time.forEach((d, i) => {
      if (archData.daily.temperature_2m_max[i] != null) actuals[d] = archData.daily.temperature_2m_max[i];
    });
  }

  // Run backtest
  console.log(`\n${'─'.repeat(65)}`);
  console.log('DATE        | 00z FCST → BUCKET | ACTUAL → BUCKET | RESULT | Δ°C');
  console.log('─'.repeat(65));

  let wins = 0, losses = 0, total = 0;
  let totalError = 0;
  const resultsByEntry = {}; // entryPrice → { wins, losses, pnl }
  const entryPrices = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];

  for (const ep of entryPrices) {
    resultsByEntry[ep] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
  }

  const dailyResults = [];

  for (const date of dates) {
    const morning = dailyMax['temperature_2m_previous_day1'][date]; // 00z run
    const actual = actuals[date];
    if (morning == null || actual == null) continue;

    const fcBucket = getBucket(morning);
    const actualBucket = getBucket(actual);
    const match = fcBucket === actualBucket;
    const error = Math.abs(morning - actual);

    total++;
    if (match) wins++;
    else losses++;
    totalError += error;

    const icon = match ? '✅' : '❌';
    console.log(`${date}  | ${morning.toFixed(1)}°C → ${fcBucket.padEnd(4)} | ${actual.toFixed(1)}°C → ${actualBucket.padEnd(4)} | ${icon}     | ${error.toFixed(2)}`);

    dailyResults.push({ date, morning, actual, fcBucket, actualBucket, match, error });

    // Simulate P&L at various entry prices
    for (const ep of entryPrices) {
      // Assume we can enter at this price if market is at or below it
      // (We don't know real market prices historically, so this is "if we COULD enter at X")
      resultsByEntry[ep].trades++;
      if (match) {
        resultsByEntry[ep].wins++;
        resultsByEntry[ep].pnl += (1 - ep); // win: payout $1 minus entry
      } else {
        resultsByEntry[ep].losses++;
        resultsByEntry[ep].pnl -= ep; // loss: lose entry
      }
    }
  }

  const rate = (wins / total * 100).toFixed(1);
  const mae = (totalError / total).toFixed(2);

  console.log('─'.repeat(65));
  console.log(`\n📊 RESULTS (${total} days)`);
  console.log(`   Bucket match rate: ${rate}% (${wins}/${total})`);
  console.log(`   MAE: ${mae}°C`);
  console.log(`   Wins: ${wins} | Losses: ${losses}`);

  // Boundary analysis
  const boundaryMisses = dailyResults.filter(r => !r.match && r.error < 0.5);
  const farMisses = dailyResults.filter(r => !r.match && r.error >= 1.0);
  console.log(`\n   Near-boundary misses (<0.5°C off): ${boundaryMisses.length}`);
  console.log(`   Far misses (≥1.0°C off): ${farMisses.length}`);

  // P&L simulation
  console.log(`\n${'─'.repeat(65)}`);
  console.log('💰 P&L SIMULATION (assuming entry at given price, $1 per share)');
  console.log('─'.repeat(65));
  console.log('ENTRY PRICE | WIN RATE | TRADES | P&L/TRADE | TOTAL P&L | EDGE');
  console.log('─'.repeat(65));

  for (const ep of entryPrices) {
    const r = resultsByEntry[ep];
    const winRate = (r.wins / r.trades * 100).toFixed(1);
    const pnlPerTrade = (r.pnl / r.trades).toFixed(3);
    const edge = ((r.wins / r.trades) - ep).toFixed(3);
    const profitable = r.pnl > 0;
    console.log(`    ${(ep*100).toFixed(0)}¢     |  ${winRate}% |   ${r.trades}   |  $${pnlPerTrade.padStart(6)} |  $${r.pnl.toFixed(2).padStart(7)} | ${edge > 0 ? '+' : ''}${(edge*100).toFixed(1)}% ${profitable ? '✅' : '❌'}`);
  }

  // Monthly breakdown
  console.log(`\n${'─'.repeat(65)}`);
  console.log('📅 MONTHLY BREAKDOWN');
  console.log('─'.repeat(65));

  const byMonth = {};
  for (const r of dailyResults) {
    const m = r.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { wins: 0, total: 0, errors: [] };
    byMonth[m].total++;
    if (r.match) byMonth[m].wins++;
    byMonth[m].errors.push(r.error);
  }

  for (const [month, s] of Object.entries(byMonth).sort()) {
    const mRate = (s.wins / s.total * 100).toFixed(1);
    const mMae = (s.errors.reduce((a, b) => a + b, 0) / s.errors.length).toFixed(2);
    console.log(`  ${month}: ${mRate.padStart(5)}% (${s.wins}/${s.total}) MAE ${mMae}°C`);
  }

  // Distribution of errors
  console.log(`\n${'─'.repeat(65)}`);
  console.log('📐 ERROR DISTRIBUTION');
  console.log('─'.repeat(65));
  const buckets = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, Infinity];
  for (let i = 0; i < buckets.length - 1; i++) {
    const count = dailyResults.filter(r => r.error >= buckets[i] && r.error < buckets[i+1]).length;
    const bar = '█'.repeat(Math.round(count / total * 50));
    const label = buckets[i+1] === Infinity ? `≥${buckets[i]}` : `${buckets[i]}-${buckets[i+1]}`;
    console.log(`  ${label.padEnd(8)}°C: ${bar} ${count} (${(count/total*100).toFixed(0)}%)`);
  }

  console.log('\n✅ Done.');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
