import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jbqkskwfjbejixyiuqpn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_6TopOsnadhqteb8xltZiZw_epDDV-cm';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Paper trading config
const MAX_BET = parseFloat(process.env.POLY_MAX_BET || 20);

const CITIES = [
  { name: "Paris", slug: "paris", lat: 49.0097, lon: 2.5479, unit: "C", tz: "Europe/Paris", hist: 0.87 },
  { name: "London", slug: "london", lat: 51.5053, lon: 0.0553, unit: "C", tz: "Europe/London", hist: 0.80 },
  { name: "Chicago", slug: "chicago", lat: 41.9742, lon: -87.9073, unit: "F", tz: "America/Chicago", hist: 0.83 },
  { name: "Buenos Aires", slug: "buenos-aires", lat: -34.5561, lon: -58.4156, unit: "C", tz: "America/Argentina/Buenos_Aires", hist: 0.83 },
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

        // Compute signal
        const buckets = Object.values(forecasts).map(v => getBucket(v, city.unit));
        const bucketCounts = {};
        buckets.forEach(b => bucketCounts[b] = (bucketCounts[b] || 0) + 1);
        const topBucket = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])[0];
        const consensusBucket = topBucket ? topBucket[0] : null;
        const modelsAgreeing = topBucket ? topBucket[1] : 0;

        const marketPrice = market?.find(m => m.title === consensusBucket)?.price ?? null;
        const modelConf = modelsAgreeing >= 3 ? 0.87 : modelsAgreeing >= 2 ? city.hist : 0;
        const edge = (marketPrice != null && modelsAgreeing >= 2) ? modelConf - marketPrice : null;

        let signalType = 'skip';
        if (edge != null && edge > 0.15 && modelsAgreeing >= 2) signalType = 'strong';
        else if (edge != null && edge > 0.05 && modelsAgreeing >= 2) signalType = 'marginal';

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

        // PAPER TRADE on strong signals
        if (signalType === 'strong' && marketPrice != null) {
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

  console.log('Done.');
}

collect().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
