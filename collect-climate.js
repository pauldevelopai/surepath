/**
 * Climate & Weather Risk Collector
 * Uses Open-Meteo (free, no API key) for historical climate data per location.
 * Returns rainfall, temperature extremes, wind, and humidity patterns.
 */
const pool = require('./db');

const OPEN_METEO_BASE = 'https://archive-api.open-meteo.com/v1/archive';

function fetchJSON(url) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Get climate data for a property's location.
 * Uses 5 years of historical data to build a climate profile.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT lat, lng, suburb, city FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]?.lat) return { error: 'not geocoded' };

  const { lat, lng, suburb, city } = rows[0];

  // Get last 5 years of daily data
  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(endDate.getFullYear() - 5);

  const url = `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lng}&start_date=${startDate.toISOString().split('T')[0]}&end_date=${endDate.toISOString().split('T')[0]}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,relative_humidity_2m_mean&timezone=Africa/Johannesburg`;

  console.log(`[climate] Fetching 5-year climate data for ${suburb}...`);
  const data = await fetchJSON(url);

  if (!data?.daily) {
    return { error: 'no climate data returned' };
  }

  const daily = data.daily;
  const temps = daily.temperature_2m_max?.filter(Boolean) || [];
  const mins = daily.temperature_2m_min?.filter(Boolean) || [];
  const rain = daily.precipitation_sum?.filter(Boolean) || [];
  const wind = daily.windspeed_10m_max?.filter(Boolean) || [];
  const humidity = daily.relative_humidity_2m_mean?.filter(Boolean) || [];

  const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;
  const max = arr => arr.length ? Math.round(Math.max(...arr) * 10) / 10 : null;
  const min = arr => arr.length ? Math.round(Math.min(...arr) * 10) / 10 : null;

  // Annual rainfall
  const totalRain = rain.reduce((a, b) => a + b, 0);
  const annualRain = Math.round(totalRain / 5);

  // Damp risk assessment based on climate
  const avgHumidity = avg(humidity);
  const dampRisk = annualRain > 800 && avgHumidity > 70 ? 'HIGH' :
                   annualRain > 500 || avgHumidity > 65 ? 'MEDIUM' : 'LOW';

  // Wind damage risk
  const maxWind = max(wind);
  const windRisk = maxWind > 80 ? 'HIGH' : maxWind > 50 ? 'MEDIUM' : 'LOW';

  // Frost risk (relevant for pipes and gardens)
  const frostDays = mins.filter(t => t <= 0).length;
  const annualFrostDays = Math.round(frostDays / 5);

  const result = {
    suburb, city,
    annual_rainfall_mm: annualRain,
    avg_max_temp: avg(temps),
    avg_min_temp: avg(mins),
    extreme_max_temp: max(temps),
    extreme_min_temp: min(mins),
    avg_humidity: avgHumidity,
    max_wind_kmh: maxWind,
    avg_wind_kmh: avg(wind),
    annual_frost_days: annualFrostDays,
    damp_risk: dampRisk,
    wind_risk: windRisk,
    climate_zone: annualRain > 600 ? 'winter_rainfall' : annualRain > 400 ? 'year_round' : 'summer_rainfall',
    data_years: 5,
  };

  // Store
  try {
    await pool.query(
      `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, data_date)
       VALUES ($1, $2, 'climate', $3, $4, $5, 'open_meteo', CURRENT_DATE)
       ON CONFLICT DO NOTHING`,
      [suburb, city, dampRisk,
       Math.round((annualRain > 800 ? 3 : annualRain > 500 ? 2 : 1) + (maxWind > 80 ? 3 : maxWind > 50 ? 2 : 0) + (annualFrostDays > 10 ? 2 : 0)),
       JSON.stringify(result)]
    );
  } catch {}

  console.log(`[climate] ${suburb}: ${annualRain}mm/yr rain, ${avgHumidity}% humidity, damp risk ${dampRisk}, wind risk ${windRisk}`);
  return result;
}

module.exports = { collectForProperty };
