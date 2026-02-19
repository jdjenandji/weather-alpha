// Scrape historical Polymarket prices for resolved weather markets
// Stores full price timeseries in Supabase for realistic backtest P&L

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_6TopOsnadhqteb8xltZiZw_epDDV-cm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CITIES = [
  { name: "London", slug: "london" },
  { name: "Paris", slug: "paris" },
  { name: "Chicago", slug: "chicago" },
];

const DAYS_BACK = 30; // scrape last 30 days of resolved markets

function formatSlugDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  return `${months[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
}

function dateRange(daysBack) {
  const dates = [];
  const now = new Date();
  for (let i = daysBack; i >= 1; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function fetchPriceHistory(tokenId) {
  const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=max&fidelity=30`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.history || []).map(h => ({
    timestamp: new Date(h.t * 1000).toISOString(),
    price: h.p,
  }));
}

async function scrape() {
  const dates = dateRange(DAYS_BACK);
  console.log(`Scraping ${dates.length} days × ${CITIES.length} cities = ${dates.length * CITIES.length} markets\n`);

  let totalPoints = 0;
  let marketsFound = 0;
  let marketsMissing = 0;

  for (const dateStr of dates) {
    for (const city of CITIES) {
      const slugDate = formatSlugDate(dateStr);
      const eventSlug = `highest-temperature-in-${city.slug}-on-${slugDate}`;

      try {
        // Fetch event to get all markets + token IDs
        const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${eventSlug}`);
        const events = await res.json();

        if (!events[0]) {
          console.log(`  ✗ ${city.slug} ${dateStr}: no event found`);
          marketsMissing++;
          continue;
        }

        const event = events[0];
        const markets = event.markets;

        let datePoints = 0;

        for (const market of markets) {
          const bucket = market.groupItemTitle;
          const tokenIds = JSON.parse(market.clobTokenIds);
          const yesTokenId = tokenIds[0];

          // Fetch price history for YES token
          const history = await fetchPriceHistory(yesTokenId);

          if (history.length === 0) continue;

          // Insert into Supabase
          const rows = history.map(h => ({
            city: city.slug,
            target_date: dateStr,
            bucket,
            token_id: yesTokenId,
            price: h.price,
            timestamp: h.timestamp,
          }));

          // Insert in chunks
          for (let i = 0; i < rows.length; i += 100) {
            const chunk = rows.slice(i, i + 100);
            const { error } = await supabase.from('price_history').insert(chunk);
            if (error) {
              console.error(`  ❌ Insert error ${city.slug} ${dateStr} ${bucket}:`, error.message);
              break;
            }
          }

          datePoints += history.length;
          totalPoints += history.length;
        }

        marketsFound++;
        console.log(`  ✓ ${city.slug} ${dateStr}: ${markets.length} buckets, ${datePoints} price points`);

      } catch (err) {
        console.error(`  ❌ ${city.slug} ${dateStr}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 300)); // rate limit
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done. ${marketsFound} markets found, ${marketsMissing} missing.`);
  console.log(`${totalPoints} total price points stored.`);

  // Now compute realistic entry prices for our backtest
  await computeRealisticEntries();
}

async function computeRealisticEntries() {
  console.log('\n📊 Computing realistic entry prices...\n');

  // For each backtest result where consensus was correct,
  // find what the market price was at ~06:00 UTC (after ECMWF 00z drop)
  // and at ~11:00 UTC (market open)

  const { data: backtestDays } = await supabase
    .from('backtest_results')
    .select('city, target_date, consensus_bucket, consensus_count, consensus_correct')
    .gte('consensus_count', 2)
    .order('target_date', { ascending: true });

  if (!backtestDays || backtestDays.length === 0) {
    console.log('No backtest data to analyze');
    return;
  }

  const entries = { at06: [], at11: [], at14: [] };

  for (const day of backtestDays) {
    if (!day.consensus_bucket) continue;

    // Fetch price history for this bucket
    const { data: prices } = await supabase
      .from('price_history')
      .select('price, timestamp')
      .eq('city', day.city)
      .eq('target_date', day.target_date)
      .eq('bucket', day.consensus_bucket)
      .order('timestamp', { ascending: true });

    if (!prices || prices.length === 0) continue;

    // Find prices at key times (D-1, since we'd trade the day before)
    // Markets are created D-2, so for a Feb 20 target, market exists from ~Feb 18
    // We'd enter after ECMWF 00z on D-1 (Feb 19 ~06:00)
    const targetDate = new Date(day.target_date + 'T00:00:00Z');
    const dMinus1 = new Date(targetDate);
    dMinus1.setUTCDate(dMinus1.getUTCDate() - 1);
    const dMinus1Str = dMinus1.toISOString().slice(0, 10);

    // Find closest price to 06:00, 11:00, 14:00 on D-1
    for (const [label, hour] of [['at06', 6], ['at11', 11], ['at14', 14]]) {
      const targetTime = new Date(`${dMinus1Str}T${String(hour).padStart(2,'0')}:00:00Z`);
      let closest = null;
      let closestDist = Infinity;

      for (const p of prices) {
        const dist = Math.abs(new Date(p.timestamp).getTime() - targetTime.getTime());
        if (dist < closestDist) {
          closestDist = dist;
          closest = p;
        }
      }

      // Only use if within 2 hours of target
      if (closest && closestDist < 2 * 60 * 60 * 1000) {
        entries[label].push({
          city: day.city,
          date: day.target_date,
          bucket: day.consensus_bucket,
          correct: day.consensus_correct,
          price: closest.price,
          time: closest.timestamp,
        });
      }
    }
  }

  // Print analysis
  for (const [label, data] of Object.entries(entries)) {
    if (data.length === 0) continue;
    const hour = label.replace('at', '');
    console.log(`\n📍 Entry at ${hour}:00 UTC (D-1) — ${data.length} data points`);

    const correct = data.filter(d => d.correct);
    const incorrect = data.filter(d => !d.correct);
    const avgPriceCorrect = correct.length > 0 ? correct.reduce((s, d) => s + d.price, 0) / correct.length : 0;
    const avgPriceIncorrect = incorrect.length > 0 ? incorrect.reduce((s, d) => s + d.price, 0) / incorrect.length : 0;
    const avgPriceAll = data.reduce((s, d) => s + d.price, 0) / data.length;

    console.log(`  Avg entry price (all): ${(avgPriceAll*100).toFixed(1)}¢`);
    console.log(`  Avg entry price (winners): ${(avgPriceCorrect*100).toFixed(1)}¢`);
    console.log(`  Avg entry price (losers): ${(avgPriceIncorrect*100).toFixed(1)}¢`);

    // Simulate P&L with $20 bets
    let totalPnl = 0;
    let wins = 0, losses = 0;
    for (const d of data) {
      const shares = Math.floor(20 / d.price);
      if (shares < 1) continue;
      const cost = shares * d.price;
      if (d.correct) {
        totalPnl += shares - cost; // win: shares × $1 - cost
        wins++;
      } else {
        totalPnl -= cost;
        losses++;
      }
    }
    console.log(`  Simulated P&L ($20/trade): ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} | ${wins}W/${losses}L (${(wins/(wins+losses)*100).toFixed(0)}%)`);
  }

  // Per-city breakdown at 06:00
  console.log('\n📍 Per-city at 06:00 UTC:');
  const at06 = entries.at06;
  for (const citySlug of ['london', 'paris', 'chicago']) {
    const cityData = at06.filter(d => d.city === citySlug);
    if (cityData.length === 0) continue;
    const correct = cityData.filter(d => d.correct);
    const avgPrice = cityData.reduce((s, d) => s + d.price, 0) / cityData.length;
    let pnl = 0;
    cityData.forEach(d => {
      const shares = Math.floor(20 / d.price);
      if (shares < 1) return;
      pnl += d.correct ? (shares - shares * d.price) : -(shares * d.price);
    });
    console.log(`  ${citySlug}: ${correct.length}/${cityData.length} correct (${(correct.length/cityData.length*100).toFixed(0)}%) | avg entry ${(avgPrice*100).toFixed(1)}¢ | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }
}

scrape().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
