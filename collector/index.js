import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_6TopOsnadhqteb8xltZiZw_epDDV-cm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Paper trading config
const MAX_BET = parseFloat(process.env.POLY_MAX_BET || 20);

const CITIES = [
  // Confidence values from 90-day Previous Runs backfill (real forecasts, not reanalysis)
  // conf[leadDays][agreement] = bucket match rate
  { name: "London", slug: "london", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London", minConsensus: 1,
    conf: {
      0: { 1: 0.81, 2: 0.83, 3: 0.91 },
      1: { 1: 0.57, 2: 0.58, 3: 0.68 },
      2: { 1: 0.52, 2: 0.55, 3: 0.65 },
    }},
  { name: "Paris", slug: "paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris", minConsensus: 3,
    conf: {
      0: { 1: 0.61, 2: 0.66, 3: 0.76 },
      1: { 1: 0.42, 2: 0.44, 3: 0.47 },
      2: { 1: 0.32, 2: 0.32, 3: 0.33 },
    }},
  { name: "Chicago", slug: "chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago", minConsensus: 3,
    conf: {
      0: { 1: 0.70, 2: 0.66, 3: 0.82 },
      1: { 1: 0.30, 2: 0.27, 3: 0.17 },
      2: { 1: 0.22, 2: 0.23, 3: 0.13 },
    }},
  // Buenos Aires removed — 60% consensus rate, not tradeable
];

function getConf(city, leadDays, agreement) {
  const ld = Math.min(leadDays, 2); // clamp to max we have data for
  return city.conf?.[ld]?.[Math.min(agreement, 3)] || 0;
}

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
      tokenId: JSON.parse(m.clobTokenIds)[0],
    })).sort((a, b) => b.price - a.price);
  } catch {
    return null;
  }
}

async function fetchAndStoreDepth(city, dateStr, consensusBucket, market, modelConf) {
  if (!consensusBucket || !market) return;
  const target = market.find(m => m.title === consensusBucket);
  if (!target || !target.tokenId) return;

  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${target.tokenId}`);
    if (!res.ok) return;
    const book = await res.json();
    const asks = (book.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

    // Calculate available size at prices where we still have edge (price < modelConf)
    const maxPrice = Math.min(modelConf, parseFloat(process.env.POLY_MAX_ENTRY || 0.50));
    const edgeAsks = asks.filter(a => parseFloat(a.price) <= maxPrice);
    const totalSize = edgeAsks.reduce((s, a) => s + parseFloat(a.size), 0);
    const totalCost = edgeAsks.reduce((s, a) => s + parseFloat(a.size) * parseFloat(a.price), 0);
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
    const bestAskSize = asks.length > 0 ? parseFloat(asks[0].size) : null;

    // Store depth snapshot
    const levels = edgeAsks.slice(0, 10).map(a => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    await supabase.from('order_depth').insert({
      city: city.slug,
      target_date: dateStr,
      bucket: consensusBucket,
      model_conf: modelConf,
      max_entry: maxPrice,
      best_ask: bestAsk,
      best_ask_size: bestAskSize,
      available_size: totalSize,
      available_cost: totalCost,
      levels: JSON.stringify(levels),
      num_levels: edgeAsks.length,
    });

    if (totalSize > 0) {
      console.log(`  📊 Depth ${city.slug} ${dateStr} ${consensusBucket}: ${edgeAsks.length} levels, ${totalSize.toFixed(0)} shares @ ≤${(maxPrice*100).toFixed(0)}¢ ($${totalCost.toFixed(0)})`);
    } else {
      console.log(`  📊 Depth ${city.slug} ${dateStr} ${consensusBucket}: no asks ≤${(maxPrice*100).toFixed(0)}¢ (best ask: ${bestAsk ? (bestAsk*100).toFixed(1)+'¢' : 'none'})`);
    }
  } catch (err) {
    // Non-critical, don't fail the run
    console.log(`  📊 Depth fetch failed for ${city.slug} ${dateStr}: ${err.message}`);
  }
}

async function collect() {
  console.log(`[paper] Paper trading mode. Max bet: $${MAX_BET}`);

  const now = new Date();
  const dates = [];
  // D+0 for trading signals, D+1 for market price tracking (entry window analysis)
  for (let i = 0; i <= 1; i++) {
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
        // Calculate lead days (0 = same day, 1 = tomorrow, 2 = day after)
        const leadDays = Math.round((new Date(dateStr + 'T12:00:00Z') - now) / 86400000);

        // Determine most recent model run cycle based on current UTC hour
        // ECMWF: 00z available ~05:30, 12z ~17:30
        // GFS/ICON: 00z ~04:00, 06z ~10:00, 12z ~16:00, 18z ~22:00
        const h = now.getUTCHours();
        const ecmwfRun = h >= 18 ? '12z' : h >= 6 ? '00z' : '12z_prev';
        const gfsIconRun = h >= 22 ? '18z' : h >= 16 ? '12z' : h >= 10 ? '06z' : h >= 4 ? '00z' : '18z_prev';

        const forecastRows = Object.entries(forecasts).map(([model, val]) => ({
          city: city.slug,
          target_date: dateStr,
          model,
          temp_value: val,
          temp_unit: city.unit,
          bucket: getBucket(val, city.unit),
          lead_days: leadDays,
          model_run: model === 'ecmwf' ? ecmwfRun : gfsIconRun,
        }));

        if (forecastRows.length > 0) {
          let { error } = await supabase.from('forecasts').insert(forecastRows);
          if (error && (error.message?.includes('lead_days') || error.message?.includes('model_run'))) {
            // Columns don't exist yet, retry without them
            const rowsCompat = forecastRows.map(({ lead_days, model_run, ...rest }) => rest);
            ({ error } = await supabase.from('forecasts').insert(rowsCompat));
          }
          if (error) console.error(`  forecasts insert error (${city.slug} ${dateStr}):`, error.message);
          else console.log(`  ✓ ${city.slug} ${dateStr}: ${forecastRows.length} forecasts (D+${leadDays})`);
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
        const modelConf = getConf(city, leadDays, modelsAgreeing);
        const meetsConsensus = modelsAgreeing >= city.minConsensus && ecmwfAgrees;
        const edge = (marketPrice != null && meetsConsensus) ? modelConf - marketPrice : null;

        let signalType = 'skip';
        if (edge != null && edge > 0.15 && meetsConsensus) signalType = 'strong';
        else if (edge != null && edge > 0.05 && meetsConsensus) signalType = 'marginal';
        if (!ecmwfAgrees && modelsAgreeing >= 2) console.log(`  ⚠️ ${city.slug} ${dateStr}: ECMWF disagrees (${ecmwfBucket} vs consensus ${consensusBucket}), skipping`);
        if (signalType === 'strong' && marketPrice != null && marketPrice > parseFloat(process.env.POLY_MAX_ENTRY || 0.50)) console.log(`  💰 ${city.slug} ${dateStr}: market already at ${(marketPrice*100).toFixed(1)}¢ (>${(parseFloat(process.env.POLY_MAX_ENTRY || 0.50)*100)}¢ cap), no edge`);

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

        // Fetch order book depth for tradeable signals
        if (meetsConsensus && signalType !== 'skip') {
          await fetchAndStoreDepth(city, dateStr, consensusBucket, market, modelConf);
        }

        // PAPER TRADE on strong signals (per-city thresholds, ECMWF required)
        const MAX_ENTRY_PRICE = parseFloat(process.env.POLY_MAX_ENTRY || 0.50);
        if (signalType === 'strong' && marketPrice != null && ecmwfAgrees && marketPrice <= MAX_ENTRY_PRICE) {
          const maxBet = parseFloat(process.env.POLY_MAX_BET || 20);

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
  await computeAccuracy();
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

// ============================================================
// ACCURACY — Compute forecast accuracy by lead time from stored data
// ============================================================
async function computeAccuracy() {
  console.log('[accuracy] Computing forecast accuracy by lead time...');

  for (const city of CITIES) {
    // Get all resolved trades to find dates with known actuals
    const { data: resolvedTrades } = await supabase
      .from('trades')
      .select('target_date, bucket, status')
      .eq('city', city.slug)
      .in('status', ['won', 'lost']);

    if (!resolvedTrades || resolvedTrades.length === 0) continue;

    // Get ERA5 actuals for those dates
    const targetDates = [...new Set(resolvedTrades.map(t => t.target_date))].sort();
    if (targetDates.length === 0) continue;

    const tempUnit = city.unit === "F" ? "&temperature_unit=fahrenheit" : "";
    let actualByDate = {};
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&start_date=${targetDates[0]}&end_date=${targetDates[targetDates.length - 1]}${tempUnit}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.daily) {
          data.daily.time.forEach((d, i) => {
            if (data.daily.temperature_2m_max[i] != null) {
              actualByDate[d] = data.daily.temperature_2m_max[i];
            }
          });
        }
      }
    } catch (e) {
      console.error(`[accuracy] ERA5 fetch error for ${city.slug}:`, e.message);
      continue;
    }

    // Get all stored forecasts for these dates
    const { data: storedForecasts } = await supabase
      .from('forecasts')
      .select('target_date, model, temp_value, bucket, lead_days, collected_at')
      .eq('city', city.slug)
      .in('target_date', targetDates)
      .order('collected_at', { ascending: true });

    if (!storedForecasts || storedForecasts.length === 0) continue;

    // Group by model → lead_days → accuracy
    const stats = {}; // model → lead_days → { matches, total, errors[] }
    // For each date, use the LAST forecast at each lead_days (most recent snapshot)
    const lastForecast = {}; // `${model}|${target_date}|${lead_days}` → row
    for (const fc of storedForecasts) {
      const key = `${fc.model}|${fc.target_date}|${fc.lead_days ?? 'null'}`;
      lastForecast[key] = fc;
    }

    for (const [key, fc] of Object.entries(lastForecast)) {
      const actual = actualByDate[fc.target_date];
      if (actual == null || fc.lead_days == null) continue;

      const actualBucket = getBucket(actual, city.unit);
      const match = fc.bucket === actualBucket;
      const error = Math.abs(fc.temp_value - actual);

      if (!stats[fc.model]) stats[fc.model] = {};
      if (!stats[fc.model][fc.lead_days]) stats[fc.model][fc.lead_days] = { matches: 0, total: 0, errors: [] };

      stats[fc.model][fc.lead_days].matches += match ? 1 : 0;
      stats[fc.model][fc.lead_days].total += 1;
      stats[fc.model][fc.lead_days].errors.push(error);
    }

    // Also compute consensus accuracy by lead_days
    // Group stored forecasts by target_date + lead_days snapshot
    const snapshots = {}; // `${target_date}|${lead_days}` → { model: bucket }
    for (const [key, fc] of Object.entries(lastForecast)) {
      if (fc.lead_days == null) continue;
      const skey = `${fc.target_date}|${fc.lead_days}`;
      if (!snapshots[skey]) snapshots[skey] = { target_date: fc.target_date, lead_days: fc.lead_days, models: {} };
      snapshots[skey].models[fc.model] = fc.bucket;
    }

    const consensusStats = {}; // lead_days → { matches, total }
    for (const snap of Object.values(snapshots)) {
      const actual = actualByDate[snap.target_date];
      if (actual == null) continue;
      const actualBucket = getBucket(actual, city.unit);

      const buckets = Object.values(snap.models);
      const counts = {};
      buckets.forEach(b => counts[b] = (counts[b] || 0) + 1);
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (!top) continue;

      const consensusBucket = top[0];
      const agreement = top[1];

      if (!consensusStats[snap.lead_days]) consensusStats[snap.lead_days] = {};
      for (const minCons of [1, 2, 3]) {
        if (!consensusStats[snap.lead_days][minCons]) consensusStats[snap.lead_days][minCons] = { matches: 0, total: 0 };
        if (agreement >= minCons) {
          consensusStats[snap.lead_days][minCons].total++;
          if (consensusBucket === actualBucket) consensusStats[snap.lead_days][minCons].matches++;
        }
      }
    }

    // Print results
    console.log(`\n  📊 ${city.name} — Forecast Accuracy by Lead Time (from ${Object.keys(actualByDate).length} resolved days)`);
    for (const model of Object.keys(stats).sort()) {
      for (const ld of Object.keys(stats[model]).sort((a, b) => a - b)) {
        const s = stats[model][ld];
        const mae = (s.errors.reduce((a, b) => a + b, 0) / s.errors.length).toFixed(2);
        const rate = (s.matches / s.total * 100).toFixed(1);
        console.log(`    ${model.toUpperCase().padEnd(6)} D+${ld}: ${rate}% bucket match (${s.matches}/${s.total}) | MAE ${mae}${city.unit === 'F' ? '°F' : '°C'}`);
      }
    }
    for (const ld of Object.keys(consensusStats).sort((a, b) => a - b)) {
      for (const minCons of [1, 2, 3]) {
        const s = consensusStats[ld][minCons];
        if (s && s.total > 0) {
          console.log(`    CONS≥${minCons}/3 D+${ld}: ${(s.matches / s.total * 100).toFixed(1)}% (${s.matches}/${s.total})`);
        }
      }
    }

    // Store accuracy summary to Supabase
    const accuracyRows = [];
    for (const model of Object.keys(stats)) {
      for (const ld of Object.keys(stats[model])) {
        const s = stats[model][ld];
        const mae = s.errors.reduce((a, b) => a + b, 0) / s.errors.length;
        accuracyRows.push({
          city: city.slug,
          model,
          lead_days: parseInt(ld),
          bucket_match_rate: s.matches / s.total,
          mae,
          sample_size: s.total,
          computed_at: new Date().toISOString(),
        });
      }
    }
    for (const ld of Object.keys(consensusStats)) {
      for (const minCons of [1, 2, 3]) {
        const s = consensusStats[ld][minCons];
        if (s && s.total > 0) {
          accuracyRows.push({
            city: city.slug,
            model: `consensus_gte${minCons}`,
            lead_days: parseInt(ld),
            bucket_match_rate: s.matches / s.total,
            mae: null,
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
      if (error) console.error(`[accuracy] Upsert error:`, error.message);
      else console.log(`  ✅ Stored ${accuracyRows.length} accuracy rows for ${city.name}`);
    }
  }
}

// Check if this is a targeted ECMWF drop run
// Run extra checks around known drop times: 00z at ~05:30 UTC, 12z at ~17:30 UTC
// Model drop windows (UTC). Each model releases ~3.5-4h after init time.
// ECMWF: 2x/day — 00z (~05:30), 12z (~17:30)
// GFS:   4x/day — 00z (~04:00), 06z (~10:00), 12z (~16:00), 18z (~22:00)
// ICON:  4x/day — 00z (~04:00), 06z (~10:00), 12z (~16:00), 18z (~22:00)
const DROP_WINDOWS = [
  // { hour, minFrom, minTo, models[], runLabel }
  // 04:00-04:30 — GFS 00z, ICON 00z
  { hour: 4, minFrom: 0, minTo: 30, models: ['gfs', 'icon'], run: '00z' },
  // 05:20-06:05 — ECMWF 00z (+ GFS/ICON may still be updating)
  { hour: 5, minFrom: 20, minTo: 59, models: ['ecmwf', 'gfs', 'icon'], run: '00z' },
  { hour: 6, minFrom: 0, minTo: 5, models: ['ecmwf'], run: '00z' },
  // 09:45-10:30 — GFS 06z, ICON 06z
  { hour: 9, minFrom: 45, minTo: 59, models: ['gfs', 'icon'], run: '06z' },
  { hour: 10, minFrom: 0, minTo: 30, models: ['gfs', 'icon'], run: '06z' },
  // 15:45-16:30 — GFS 12z, ICON 12z
  { hour: 15, minFrom: 45, minTo: 59, models: ['gfs', 'icon'], run: '12z' },
  { hour: 16, minFrom: 0, minTo: 30, models: ['gfs', 'icon'], run: '12z' },
  // 17:20-18:05 — ECMWF 12z
  { hour: 17, minFrom: 20, minTo: 59, models: ['ecmwf', 'gfs', 'icon'], run: '12z' },
  { hour: 18, minFrom: 0, minTo: 5, models: ['ecmwf'], run: '12z' },
  // 21:45-22:30 — GFS 18z, ICON 18z
  { hour: 21, minFrom: 45, minTo: 59, models: ['gfs', 'icon'], run: '18z' },
  { hour: 22, minFrom: 0, minTo: 30, models: ['gfs', 'icon'], run: '18z' },
];

function getActiveDropWindow(hour, min) {
  return DROP_WINDOWS.find(w => w.hour === hour && min >= w.minFrom && min <= w.minTo);
}

async function checkModelDrops(window) {
  console.log(`[model-watch] ${window.run} drop window. Checking: ${window.models.join(', ')}...`);

  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dateStr = tomorrow.toISOString().slice(0, 10);
  const city = CITIES.find(c => c.slug === 'london');
  const forecasts = await fetchForecasts(city, dateStr);

  for (const model of window.models) {
    const newVal = forecasts[model];
    if (newVal == null) continue;

    const { data: lastFc } = await supabase
      .from('forecasts')
      .select('temp_value, collected_at')
      .eq('city', 'london')
      .eq('target_date', dateStr)
      .eq('model', model)
      .order('collected_at', { ascending: false })
      .limit(1);

    const lastVal = lastFc?.[0]?.temp_value;

    if (lastVal != null && Math.abs(newVal - lastVal) > 0.05) {
      console.log(`[model-watch] 🔔 ${model.toUpperCase()} ${window.run} DROP DETECTED! London ${dateStr}: ${lastVal}→${newVal}°C (Δ${(newVal - lastVal).toFixed(2)})`);
    } else if (lastVal != null) {
      console.log(`[model-watch] ${model.toUpperCase()}: no change (${lastVal}→${newVal})`);
    } else {
      console.log(`[model-watch] ${model.toUpperCase()}: first reading ${newVal}°C`);
    }
  }
}

async function main() {
  const hour = new Date().getUTCHours();
  const min = new Date().getUTCMinutes();

  // Full collection every 15 min (0, 15, 30, 45)
  const isFullRun = min % 15 < 5;

  // Check if we're in any model drop window
  const dropWindow = getActiveDropWindow(hour, min);

  if (!isFullRun && !dropWindow) {
    console.log(`[scheduler] Off-cycle run (${hour}:${String(min).padStart(2,'0')} UTC), not in drop window. Skipping.`);
    return;
  }

  if (dropWindow && !isFullRun) {
    console.log(`[scheduler] 🔔 ${dropWindow.models.map(m => m.toUpperCase()).join('+')} ${dropWindow.run} drop window — running extra collection`);
  }

  await collect();

  if (dropWindow) {
    await checkModelDrops(dropWindow);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
