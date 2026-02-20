// Backfill: what was the market price of the ECMWF-predicted bucket at 00z drop time (~05:30 UTC)?
// Fetches Polymarket price history for each day's predicted bucket

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpicWtza3dmamJlaml4eWl1cXBuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTYyNzkzOCwiZXhwIjoyMDgxMjAzOTM4fQ.xzpC9MFUT0ZT-z5ZTQArgDjYFuhl4uX07zDeustSp5c';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const LAT = 51.5053, LON = 0.0553;
const ECMWF_DROP_HOUR = 5.5; // ~05:30 UTC

function getBucket(val) { return `${Math.round(val)}°C`; }

function formatPolymarketDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  return `${months[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
}

async function fetchMarketTokens(dateStr) {
  const slug = `highest-temperature-in-london-on-${formatPolymarketDate(dateStr)}`;
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data[0]) return null;
    return data[0].markets.map(m => ({
      title: m.groupItemTitle,
      tokenId: JSON.parse(m.clobTokenIds)[0],
      currentPrice: parseFloat(JSON.parse(m.outcomePrices)[0]),
    }));
  } catch { return null; }
}

async function fetchPriceHistory(tokenId) {
  try {
    const res = await fetch(`https://clob.polymarket.com/prices-history?market=${tokenId}&interval=all&fidelity=60`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.history || []).map(p => ({ t: p.t, price: p.p }));
  } catch { return []; }
}

function findPriceAtTime(history, targetUnix) {
  // Find the price closest to but before the target time
  let best = null;
  for (const p of history) {
    if (p.t <= targetUnix + 1800) { // within 30 min after is ok too
      if (!best || Math.abs(p.t - targetUnix) < Math.abs(best.t - targetUnix)) {
        best = p;
      }
    }
  }
  return best;
}

async function run() {
  console.log('💹 Backfilling market prices at ECMWF 00z drop time (~05:30 UTC)');
  console.log('='.repeat(65));

  // Fetch ECMWF 00z forecasts (Day 1 from Previous Runs)
  const url = `https://previous-runs-api.open-meteo.com/v1/forecast?` +
    `latitude=${LAT}&longitude=${LON}&hourly=temperature_2m_previous_day1` +
    `&models=ecmwf_ifs025&timezone=Europe/London&past_days=90&forecast_days=0`;

  const fcRes = await fetch(url);
  const fcData = await fcRes.json();

  const dailyMax = {};
  for (let i = 0; i < fcData.hourly.time.length; i++) {
    const v = fcData.hourly.temperature_2m_previous_day1[i];
    if (v == null) continue;
    const d = fcData.hourly.time[i].slice(0, 10);
    if (!dailyMax[d] || v > dailyMax[d]) dailyMax[d] = v;
  }

  // Fetch ERA5 actuals
  const dates = Object.keys(dailyMax).sort();
  const archRes = await fetch(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max&timezone=Europe/London&start_date=${dates[0]}&end_date=${dates[dates.length-1]}`
  );
  const archData = await archRes.json();
  const actuals = {};
  archData.daily?.time.forEach((d, i) => { if (archData.daily.temperature_2m_max[i] != null) actuals[d] = archData.daily.temperature_2m_max[i]; });

  console.log(`\nFetching Polymarket price history for ${dates.length} dates...\n`);
  console.log('DATE        | ECMWF BUCKET | PRICE@05:30 | ACTUAL | MATCH | EDGE    | P&L@$1');
  console.log('─'.repeat(80));

  const results = [];
  let totalPnl = 0;
  let tradesWithPrice = 0;

  for (const date of dates) {
    const fc = dailyMax[date];
    const actual = actuals[date];
    if (fc == null || actual == null) continue;

    const fcBucket = getBucket(fc);
    const actualBucket = getBucket(actual);
    const match = fcBucket === actualBucket;

    // Try to get market data
    const markets = await fetchMarketTokens(date);
    let priceAtDrop = null;

    if (markets) {
      const target = markets.find(m => m.title === fcBucket);
      if (target) {
        const history = await fetchPriceHistory(target.tokenId);
        // Target time: 05:30 UTC on the target date
        const dropTime = new Date(date + 'T05:30:00Z').getTime() / 1000;
        const found = findPriceAtTime(history, dropTime);
        if (found) {
          priceAtDrop = found.price;
        }
      }
    }

    const edge = priceAtDrop != null ? (match ? 1 : 0) - priceAtDrop : null;
    const pnl = priceAtDrop != null ? (match ? (1 - priceAtDrop) : -priceAtDrop) : null;

    if (pnl != null) {
      totalPnl += pnl;
      tradesWithPrice++;
    }

    const priceStr = priceAtDrop != null ? `${(priceAtDrop * 100).toFixed(1)}¢`.padStart(8) : '    N/A ';
    const edgeStr = priceAtDrop != null ? `${((match ? 1 : 0) - priceAtDrop > 0 ? '+' : '')}${(((match ? 1 : 0) - priceAtDrop) * 100).toFixed(1)}%` : 'N/A';
    const pnlStr = pnl != null ? `$${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` : 'N/A';

    console.log(`${date}  | ${fcBucket.padEnd(8)} | ${priceStr} | ${actualBucket.padEnd(4)} | ${match ? '✅' : '❌'}    | ${edgeStr.padStart(7)} | ${pnlStr}`);

    results.push({ date, fc, fcBucket, actual: actuals[date], actualBucket, match, priceAtDrop });

    // Store to Supabase
    if (priceAtDrop != null) {
      await supabase.from('market_at_drop').upsert({
        city: 'london',
        target_date: date,
        model: 'ecmwf',
        model_run: '00z',
        predicted_bucket: fcBucket,
        actual_bucket: actualBucket,
        bucket_match: match,
        market_price_at_drop: priceAtDrop,
        drop_time_utc: new Date(date + 'T05:30:00Z').toISOString(),
        edge: match ? (1 - priceAtDrop) : -priceAtDrop,
      }, { onConflict: 'city,target_date,model_run' }).then(({ error }) => {
        if (error && !error.message?.includes('market_at_drop')) { /* table might not exist */ }
      });
    }

    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  const withPrices = results.filter(r => r.priceAtDrop != null);
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`\n📊 SUMMARY`);
  console.log(`  Days with price data: ${withPrices.length}/${results.length}`);
  if (withPrices.length > 0) {
    const avgPrice = withPrices.reduce((s, r) => s + r.priceAtDrop, 0) / withPrices.length;
    const winsWithPrice = withPrices.filter(r => r.match).length;
    console.log(`  Avg market price at 05:30: ${(avgPrice * 100).toFixed(1)}¢`);
    console.log(`  Win rate (w/ prices): ${(winsWithPrice / withPrices.length * 100).toFixed(1)}%`);
    console.log(`  Total P&L: $${totalPnl.toFixed(2)} (${tradesWithPrice} trades)`);
    console.log(`  P&L per trade: $${(totalPnl / tradesWithPrice).toFixed(3)}`);
  }

  console.log('\n✅ Done');
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
