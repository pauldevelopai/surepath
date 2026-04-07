/**
 * SA Electricity Data Collector
 *
 * Collects:
 * 1. Load shedding status from Eskom's public endpoints
 * 2. Electricity tariff rates (Eskom + municipal) for cost estimates
 *
 * No API key required — uses Eskom's public website and published tariff data.
 */
const pool = require('./db');
const https = require('https');

// ─── Current SA electricity tariff rates (2025/2026 financial year) ────
// Source: Eskom tariff booklet + NERSA approval March 2025
// Eskom direct customers: 12.74% increase from 1 April 2025
// Municipal customers: 11.32% increase from 1 July 2025
const TARIFF_DATA = {
  eskom_direct: {
    // Homelight tariff (prepaid, ≤250A supply)
    homelight: {
      block1: { limit_kwh: 350, rate_cents: 294.35 }, // 0-350 kWh
      block2: { rate_cents: 340.89 }, // >350 kWh (simplified from Apr 2025 — flat rate)
      service_charge_cents_per_day: 1465.96 / 30, // monthly charge
    },
    // Homeflex (credit meter, time-of-use)
    homeflex: {
      peak_cents: 456.78,
      standard_cents: 294.35,
      offpeak_cents: 187.42,
    },
  },
  // Municipal tariffs vary but typically add 30-40% markup to Eskom bulk rate
  // These are representative averages for major metros
  municipal: {
    cape_town: { name: 'City of Cape Town', avg_rate_cents: 365, service_charge_rands: 175, source: 'CCT Tariff Schedule 2025/26' },
    johannesburg: { name: 'City of Johannesburg / City Power', avg_rate_cents: 340, service_charge_rands: 160, source: 'City Power 2025/26' },
    tshwane: { name: 'City of Tshwane', avg_rate_cents: 335, service_charge_rands: 150, source: 'Tshwane 2025/26' },
    ethekwini: { name: 'eThekwini (Durban)', avg_rate_cents: 350, service_charge_rands: 165, source: 'eThekwini 2025/26' },
    ekurhuleni: { name: 'Ekurhuleni', avg_rate_cents: 330, service_charge_rands: 155, source: 'Ekurhuleni 2025/26' },
    nelson_mandela_bay: { name: 'Nelson Mandela Bay', avg_rate_cents: 345, service_charge_rands: 145, source: 'NMB 2025/26' },
    default: { name: 'SA Average (Eskom + Municipal)', avg_rate_cents: 329, service_charge_rands: 150, source: 'Eskom residential average 2025/26' },
  },
};

// Map city names to tariff keys
function getCityTariffKey(city) {
  if (!city) return 'default';
  const c = city.toLowerCase().replace(/[^a-z\s]/g, '');
  if (c.includes('cape town')) return 'cape_town';
  if (c.includes('johannesburg') || c.includes('joburg') || c.includes('sandton') || c.includes('randburg')) return 'johannesburg';
  if (c.includes('pretoria') || c.includes('tshwane') || c.includes('centurion')) return 'tshwane';
  if (c.includes('durban') || c.includes('ethekwini') || c.includes('umhlanga') || c.includes('ballito')) return 'ethekwini';
  if (c.includes('ekurhuleni') || c.includes('germiston') || c.includes('boksburg') || c.includes('benoni')) return 'ekurhuleni';
  if (c.includes('port elizabeth') || c.includes('gqeberha') || c.includes('nelson mandela')) return 'nelson_mandela_bay';
  return 'default';
}

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (res) => {
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
 * Get load shedding status from Eskom's public endpoint.
 * Returns current stage and schedule info.
 */
async function getLoadSheddingStatus() {
  // Eskom's public load shedding status endpoint
  const data = await fetchJSON('https://loadshedding.eskom.co.za/LoadShedding/GetStatus');
  // Status: 1 = no load shedding, 2 = stage 1, 3 = stage 2, etc.
  if (data !== null) {
    const stage = typeof data === 'number' ? data - 1 : 0;
    return {
      current_stage: stage,
      status: stage === 0 ? 'No load shedding' : `Stage ${stage}`,
      source: 'loadshedding.eskom.co.za',
    };
  }
  return { current_stage: 0, status: 'Unable to check', source: 'loadshedding.eskom.co.za' };
}

/**
 * Calculate estimated monthly electricity cost for a property.
 */
function estimateElectricityCost(city, bedroomCount = 3) {
  const tariffKey = getCityTariffKey(city);
  const tariff = TARIFF_DATA.municipal[tariffKey] || TARIFF_DATA.municipal.default;

  // Estimated monthly consumption based on household size
  // SA average: 900 kWh/month for a 3-bed house
  const consumptionEstimates = {
    1: 400,  // 1 bed / studio
    2: 650,  // 2 bed
    3: 900,  // 3 bed
    4: 1100, // 4 bed
    5: 1300, // 5+ bed
  };
  const kwh = consumptionEstimates[Math.min(bedroomCount || 3, 5)] || 900;

  const energyCost = Math.round(kwh * tariff.avg_rate_cents / 100);
  const monthlyCost = energyCost + tariff.service_charge_rands;

  return {
    city: city || 'South Africa',
    supplier: tariff.name,
    tariff_source: tariff.source,
    rate_per_kwh_rands: (tariff.avg_rate_cents / 100).toFixed(2),
    estimated_monthly_kwh: kwh,
    estimated_bedrooms: bedroomCount || 3,
    energy_cost_rands: energyCost,
    service_charge_rands: tariff.service_charge_rands,
    monthly_total_rands: monthlyCost,
    annual_total_rands: monthlyCost * 12,
  };
}

/**
 * Collect electricity data for a property and store in area_risk_data.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query('SELECT city, suburb, bedrooms FROM properties WHERE id = $1', [propertyId]);
  if (!rows[0]) return { error: 'property not found' };

  const { city, suburb, bedrooms } = rows[0];

  // Get load shedding status
  const lsStatus = await getLoadSheddingStatus();

  // Calculate electricity cost estimate
  const costEstimate = estimateElectricityCost(city, bedrooms);

  // Store in area_risk_data
  const details = {
    ...costEstimate,
    load_shedding_stage: lsStatus.current_stage,
    load_shedding_status: lsStatus.status,
    checked_at: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO area_risk_data (suburb, city, risk_type, risk_level, risk_score, details, source_name, source_url, data_date)
     VALUES ($1, $2, 'electricity', $3, $4, $5, 'Eskom / Municipal tariffs 2025/26', 'https://www.eskom.co.za/distribution/tariffs-and-charges/', NOW())
     ON CONFLICT DO NOTHING`,
    [
      suburb || 'ALL',
      city,
      costEstimate.monthly_total_rands > 2500 ? 'HIGH' : costEstimate.monthly_total_rands > 1500 ? 'MEDIUM' : 'LOW',
      Math.round(costEstimate.monthly_total_rands / 300), // rough 1-10 score
      JSON.stringify(details),
    ]
  );

  console.log(`[electricity] ${suburb || city}: R${costEstimate.monthly_total_rands}/month (${costEstimate.rate_per_kwh_rands}/kWh), load shedding: ${lsStatus.status}`);

  return details;
}

module.exports = { collectForProperty, estimateElectricityCost, getLoadSheddingStatus, TARIFF_DATA, getCityTariffKey };
