/**
 * Collect real solar irradiance data from EU PVGIS API
 *
 * Source: European Commission Joint Research Centre
 * URL: https://re.jrc.ec.europa.eu/pvg_tools/en/
 * Data: Satellite-measured solar radiation (SARAH3 database), 2005-2023
 * Coverage: Global (works for all of South Africa)
 * Cost: Free
 *
 * Returns actual kWh/m²/year and PV output for any lat/lng coordinate.
 */

const https = require('https');
const pool = require('./db');
const { recordSource } = require('./provenance');

function fetchPVGIS(lat, lng) {
  return new Promise((resolve, reject) => {
    const url = `https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=${lat}&lon=${lng}&peakpower=1&loss=14&outputformat=json`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`PVGIS ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('PVGIS invalid JSON')); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Get solar data for a specific property.
 */
async function getSolarData(propertyId) {
  const { rows } = await pool.query('SELECT id, lat, lng FROM properties WHERE id = $1', [propertyId]);
  if (!rows.length || !rows[0].lat) return null;

  const prop = rows[0];
  const data = await fetchPVGIS(parseFloat(prop.lat), parseFloat(prop.lng));

  const totals = data.outputs.totals.fixed;
  const ghi = totals['H(i)_y']; // kWh/m²/year
  const pvOutput = totals.E_y; // kWh/year per 1kWp system

  // Store
  await pool.query(
    `UPDATE properties SET solar_ghi_kwh_year = $1, solar_pv_output_kwh_year = $2, solar_data_source = 'PVGIS' WHERE id = $3`,
    [ghi, pvOutput, propertyId]
  );

  // Provenance
  const sourceUrl = `https://re.jrc.ec.europa.eu/pvg_tools/en/#api_5.3`;
  await recordSource(propertyId, 'EU PVGIS (JRC)', sourceUrl, 'verified', ['solar_ghi_kwh_year', 'solar_pv_output_kwh_year']);

  return {
    ghi_kwh_m2_year: Math.round(ghi * 10) / 10,
    pv_output_kwh_year: Math.round(pvOutput),
    monthly: data.outputs.monthly.fixed,
  };
}

/**
 * Batch collect solar data for all properties with coordinates but no solar data.
 */
async function collectAll(limit) {
  const { rows } = await pool.query(
    `SELECT id, address_raw FROM properties WHERE lat IS NOT NULL AND solar_ghi_kwh_year IS NULL ORDER BY id ${limit ? `LIMIT ${limit}` : ''}`
  );
  console.log(`${rows.length} properties need solar data`);

  let done = 0;
  for (const p of rows) {
    try {
      const result = await getSolarData(p.id);
      if (result) {
        done++;
        console.log(`  #${p.id}: GHI=${result.ghi_kwh_m2_year} kWh/m²/year, PV=${result.pv_output_kwh_year} kWh/year — ${p.address_raw}`);
      }
    } catch (err) {
      console.error(`  #${p.id}: ERROR — ${err.message}`);
    }
    // PVGIS rate limit — be polite
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Done: ${done}/${rows.length}`);
}

module.exports = { getSolarData, collectAll };

if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
  const limit = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1]) : null;
  collectAll(limit).then(() => pool.end()).catch(err => { console.error(err); pool.end(); });
}
