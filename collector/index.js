import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_6TopOsnadhqteb8xltZiZw_epDDV-cm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Paper trading config
const MAX_BET = parseFloat(process.env.POLY_MAX_BET || 20);

const CITIES = [
  { name: "London", slug: "london", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London", conf2: 0.83, conf3: 0.90, minConsensus: 2 },
  { name: "Paris", slug: "paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris", conf2: 0.65, conf3: 0.75, minConsensus: 3 },
  { name: "Chicago", slug: "chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago", conf2: 0.66, conf3: 0.83, minConsensus: 3 },
  // Buenos Aires removed — 60% consensus rate, not tradeable
];

function getBucket(val, unit) {
  if (unit === "F") {
    const b = Math.floor(val / 2) * 2;
    return `${b} to ${b + 1}°F`;
  }
  return `${Math.round(val)}°C`;
}

function formatPolymarketDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  return `${months[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
}

async function fetchForecasts(city, dateStr) {
  const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&start_date=${dateStr}&end_date=${dateStr}&models=ecmwf_ifs025,gfs_seamless,icon_seamless${tempUnit}`;
  
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  const data = await res.json();
  
  const result = {};
  for (const [key, vals] of Object.entries(data.daily || {})) {
    if (key.startsWith("temperature_2m_max")) {
      let model = key.replace("temperature_2m_max_", "").replace("temperature_2m_max", "default");
      model = model.replace("_seamless", "").replace("_ifs025", "");
      if (model === "default") continue; // skip blend
      if (vals[0] != null) result[model] = vals[0];
    }
  }
  return result;
}

async function fetchMarket(city, dateStr) {
  const slug = `highest-temperature-in-${city.slug}-on-${formatPolymarketDate(dateStr)}`;
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data[0]) return null;
    return data[0].markets.map(m => ({
      title: m.groupItemTitle,
      price: parseFloat(JSON.parse(m.outcomePrices)[0]),
      volume: parseFloat(m.volume || "0"),
    })).sort((a, b) => b.price - a.price);
  } catch {
    return null;
  }
}

async function collect() {
  console.log(`[paper] Paper trading mode. Max bet: $${MAX_BET}`);

  const now = new Date();
  const dates = [];
  for (let i = 0; i <= 2; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  console.log(`[${now.toISOString()}] Collecting for dates: ${dates.join(', ')}`);

  for (const city of CITIES) {
    for (const dateStr of dates) {
      try {
        // Fetch forecasts
        const forecasts = await fetchForecasts(city, dateStr);
        const forecastRows = Object.entries(forecasts).map(([model, val]) => ({
          city: city.slug,
          target_date: dateStr,
          model,
          temp_value: val,
          temp_unit: city.unit,
          bucket: getBucket(val, city.unit),
        }));

        if (forecastRows.length > 0) {
          const { error } = await supabase.from('forecasts').insert(forecastRows);
          if (error) console.error(`  forecasts insert error (${city.slug} ${dateStr}):`, error.message);
          else console.log(`  ✓ ${city.slug} ${dateStr}: ${forecastRows.length} forecasts`);
        }

        // Fetch market
        const market = await fetchMarket(city, dateStr);
        if (market && market.length > 0) {
          const marketRows = market.map(m => ({
            city: city.slug,
            target_date: dateStr,
            bucket: m.title,
            price: m.price,
            volume: m.volume,
          }));
          const { error } = await supabase.from('market_prices').insert(marketRows);
          if (error) console.error(`  market_prices insert error (${city.slug} ${dateStr}):`, error.message);
          else console.log(`  ✓ ${city.slug} ${dateStr}: ${marketRows.length} market prices`);
        } else {
          console.log(`  - ${city.slug} ${dateStr}: no market found`);
        }

        // Compute signal (updated per 90-day backtest findings)
        const modelBuckets = {};
        for (const [model, val] of Object.entries(forecasts)) {
          modelBuckets[model] = getBucket(val, city.unit);
        }
        const buckets = Object.values(modelBuckets);
        const bucketCounts = {};
        buckets.forEach(b => bucketCounts[b] = (bucketCounts[b] || 0) + 1);
        const topBucket = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
        const consensusBucket = topBucket ? topBucket[0] : null;
        const modelsAgreeing = topBucket ? topBucket[1] : 0;

        // ECMWF must agree with consensus — if ECMWF disagrees, skip
        const ecmwfBucket = modelBuckets.ecmwf;
        const ecmwfAgrees = ecmwfBucket === consensusBucket;

        const marketPrice = market?.find(m => m.title === consensusBucket)?.price ?? null;
        const modelConf = modelsAgreeing >= 3 ? city.conf3 : modelsAgreeing >= 2 ? city.conf2 : 0;
        const meetsConsensus = modelsAgreeing >= city.minConsensus && ecmwfAgrees;
        const edge = (marketPrice != null && meetsConsensus) ? modelConf - marketPrice : null;

        let signalType = 'skip';
        if (edge != null && edge > 0.15 && meetsConsensus) signalType = 'strong';
        else if (edge != null && edge > 0.05 && meetsConsensus) signalType = 'marginal';
        if (!ecmwfAgrees && modelsAgreeing >= 2) console.log(`  ⚠️ ${city.slug} ${dateStr}: ECMWF disagrees (${ecmwfBucket} vs consensus ${consensusBucket}), skipping`);

        const { error: sigErr } = await supabase.from('signals').insert({
          city: city.slug,
          target_date: dateStr,
          consensus_bucket: consensusBucket,
          models_agreeing: modelsAgreeing,
          model_confidence: modelConf,
          market_price: marketPrice,
          edge,
          signal_type: signalType,
        });
        if (sigErr) console.error(`  signals insert error (${city.slug} ${dateStr}):`, sigErr.message);

        // PAPER TRADE on strong signals (per-city thresholds, ECMWF required)
        if (signalType === 'strong' && marketPrice != null && ecmwfAgrees) {
          const maxBet = parseFloat(process.env.POLY_MAX_BET || 20);

          // Check if we already traded this city+date
          const { data: existing } = await supabase
            .from('trades')
            .select('id')
            .eq('city', city.slug)
            .eq('target_date', dateStr)
            .limit(1);

          if (!existing || existing.length === 0) {
            const price = marketPrice;
            const shares = Math.floor(maxBet / price);
            const cost = +(shares * price).toFixed(2);

            const { error: tradeErr } = await supabase.from('trades').insert({
              city: city.slug,
              target_date: dateStr,
              bucket: consensusBucket,
              price,
              shares,
              cost,
              order_id: 'paper-' + Date.now(),
              signal_type: signalType,
              edge,
              models_agreeing: modelsAgreeing,
              status: 'open',
            });
            if (tradeErr) console.error('  trades insert error:', tradeErr.message);
            else console.log(`  📝 Paper trade: ${city.slug} ${dateStr} ${consensusBucket} YES @ ${(price*100).toFixed(1)}¢ | ${shares} shares | $${cost}`);
          } else {
            console.log(`  ⏭️ Already traded ${city.slug} ${dateStr}, skipping`);
          }
        }

      } catch (err) {
        console.error(`  ERROR ${city.slug} ${dateStr}:`, err.message);
      }

      // Be nice to APIs
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('Collection done. Running monitor...');
  await monitor();
  await resolve();
  console.log('All done.');
}

// ============================================================
// MONITOR — Check open trades for forecast shifts
// ============================================================
async function monitor() {
  const { data: openTrades } = await supabase
    .from('trades')
    .select('*')
    .eq('status', 'open');

  if (!openTrades || openTrades.length === 0) {
    console.log('[monitor] No open trades to monitor');
    return;
  }

  console.log(`[monitor] Checking ${openTrades.length} open trade(s)...`);

  for (const trade of openTrades) {
    const city = CITIES.find(c => c.slug === trade.city);
    if (!city) continue;

    try {
      // Get fresh forecasts
      const forecasts = await fetchForecasts(city, trade.target_date);
      const currentBuckets = Object.entries(forecasts).map(([model, val]) => ({
        model,
        temp: val,
        bucket: getBucket(val, city.unit),
      }));

      // How many models still agree with our trade bucket?
      const agreeing = currentBuckets.filter(m => m.bucket === trade.bucket);
      const disagreeing = currentBuckets.filter(m => m.bucket !== trade.bucket);

      // Current consensus
      const bucketCounts = {};
      currentBuckets.forEach(m => bucketCounts[m.bucket] = (bucketCounts[m.bucket] || 0) + 1);
      const topBucket = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
      const currentConsensus = topBucket ? topBucket[0] : null;
      const consensusCount = topBucket ? topBucket[1] : 0;

      // Determine state
      let state, detail;
      if (agreeing.length === 3) {
        state = 'holding';
        detail = `✅ All 3 models still on ${trade.bucket}`;
      } else if (agreeing.length === 2) {
        state = 'drifting';
        const drifted = disagreeing[0];
        detail = `⚠️ ${drifted.model.toUpperCase()} shifted to ${drifted.bucket} (${drifted.temp.toFixed(1)}${city.unit === 'F' ? '°F' : '°C'}). 2/3 still on ${trade.bucket}`;
      } else if (agreeing.length === 1) {
        state = 'broken';
        detail = `🚨 Consensus flipped to ${currentConsensus} (${consensusCount}/3). Only ${agreeing[0].model.toUpperCase()} still on ${trade.bucket}`;
      } else {
        state = 'broken';
        detail = `🚨 ALL models left ${trade.bucket}. Consensus now ${currentConsensus} (${consensusCount}/3)`;
      }

      const modelDetail = currentBuckets.map(m => `${m.model}=${m.temp.toFixed(1)}→${m.bucket}`).join(', ');
      console.log(`  [${trade.city} ${trade.target_date}] ${detail} | ${modelDetail}`);

      // Get previous alert state to detect changes
      const { data: lastAlert } = await supabase
        .from('trade_alerts')
        .select('state')
        .eq('trade_id', trade.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const previousState = lastAlert?.[0]?.state;

      // Log alert if state changed
      if (state !== previousState) {
        await supabase.from('trade_alerts').insert({
          trade_id: trade.id,
          city: trade.city,
          target_date: trade.target_date,
          trade_bucket: trade.bucket,
          current_consensus: currentConsensus,
          models_on_bucket: agreeing.length,
          state,
          detail,
          model_detail: modelDetail,
        });

        if (state === 'broken') {
          console.log(`  🚨 ALERT: ${trade.city} ${trade.target_date} — trade bucket ${trade.bucket} is BROKEN. Consensus moved to ${currentConsensus}`);
        } else if (state === 'drifting' && previousState === 'holding') {
          console.log(`  ⚠️ ALERT: ${trade.city} ${trade.target_date} — 1 model drifted from ${trade.bucket}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  [monitor] Error checking ${trade.city} ${trade.target_date}:`, err.message);
    }
  }
}

// ============================================================
// RESOLVE — Auto-resolve trades using ERA5 archive
// ============================================================
async function resolve() {
  const today = new Date().toISOString().slice(0, 10);

  // Find open trades where target_date is in the past
  const { data: unresolvedTrades } = await supabase
    .from('trades')
    .select('*')
    .eq('status', 'open')
    .lt('target_date', today);

  if (!unresolvedTrades || unresolvedTrades.length === 0) {
    console.log('[resolve] No trades to resolve');
    return;
  }

  console.log(`[resolve] Resolving ${unresolvedTrades.length} past trade(s)...`);

  for (const trade of unresolvedTrades) {
    const city = CITIES.find(c => c.slug === trade.city);
    if (!city) continue;

    try {
      // Fetch actual high temp from ERA5 archive
      const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&start_date=${trade.target_date}&end_date=${trade.target_date}${tempUnit}`;

      const res = await fetch(url);
      if (!res.ok) { console.log(`  [resolve] Archive API error for ${trade.city} ${trade.target_date}`); continue; }
      const data = await res.json();
      const actual = data.daily?.temperature_2m_max?.[0];
      if (actual == null) { console.log(`  [resolve] No archive data yet for ${trade.city} ${trade.target_date}`); continue; }

      const actualBucket = getBucket(actual, city.unit);
      const won = actualBucket === trade.bucket;
      const pnl = won ? +(trade.shares * (1 - trade.price)).toFixed(2) : -trade.cost;

      const { error } = await supabase
        .from('trades')
        .update({
          status: won ? 'won' : 'lost',
          pnl,
        })
        .eq('id', trade.id);

      if (error) console.error(`  [resolve] Update error:`, error.message);
      else {
        const icon = won ? '✅' : '❌';
        console.log(`  ${icon} ${trade.city} ${trade.target_date}: actual ${actual.toFixed(1)}→${actualBucket} | trade was ${trade.bucket} | ${won ? 'WON' : 'LOST'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  [resolve] Error resolving ${trade.city} ${trade.target_date}:`, err.message);
    }
  }
}

collect().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
