#!/usr/bin/env node
/**
 * BUILD TRAINING DATA
 *
 * Takes all property data from multiple sources and normalizes it into
 * the training_data table for AI pattern learning.
 *
 * Run after scraping, geocoding, vision analysis, or any data collection.
 *
 * Usage:
 *   node bootstrap/build-training-data.js
 *   node bootstrap/build-training-data.js --stats   # Show training stats only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const pool = require('../db');

async function buildTrainingData() {
  // Get all properties with their reports
  const { rows: properties } = await pool.query(`
    SELECT p.*,
           pr.insurance_risk_score, pr.solar_suitability_score, pr.crime_risk_score,
           pr.asbestos_risk, pr.maintenance_cost_estimate, pr.decision,
           pr.vision_findings, pr.repair_estimates,
           (SELECT COUNT(*) FROM property_images pi WHERE pi.property_id = p.id) AS photo_count
    FROM properties p
    LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
    ORDER BY p.id
  `);

  console.log(`Processing ${properties.length} properties...`);
  let updated = 0;

  for (const p of properties) {
    // Calculate days on market
    const daysOnMarket = p.listing_date
      ? Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000)
      : null;

    // Count findings
    const findings = p.vision_findings || [];
    const totalFindings = Array.isArray(findings) ? findings.length : 0;
    const criticalFindings = Array.isArray(findings)
      ? findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').length
      : 0;

    // Repair cost
    const repairMax = p.repair_estimates?.total_max_zar || null;

    // Data completeness — count non-null important fields
    const importantFields = [
      p.asking_price, p.floor_area_sqm, p.bedrooms, p.bathrooms,
      p.property_type, p.suburb, p.city, p.lat,
      p.description, p.levies, p.rates_and_taxes,
      p.agent_name, p.listing_date,
    ];
    const completeness = importantFields.filter(f => f != null).length / importantFields.length;

    // Security features
    const hasSecurity = p.has_alarm || p.has_electric_fence || p.has_cctv || p.security_visible || false;

    // Upsert training data
    await pool.query(`
      INSERT INTO training_data (
        property_id, price_zar, price_per_sqm, floor_area_sqm, stand_size_sqm,
        bedrooms, bathrooms, parking_total, floor_number, levies_monthly, rates_monthly,
        days_on_market, suburb, city, property_type,
        pet_friendly, furnished, has_pool, has_garden, has_braai,
        has_balcony, has_aircon, has_security, airbnb_friendly,
        crime_score, insurance_risk_score, solar_suitability_score, asbestos_risk,
        total_findings, critical_findings, repair_cost_max,
        decision, data_completeness, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,NOW()
      )
      ON CONFLICT (property_id) DO UPDATE SET
        price_zar=EXCLUDED.price_zar, price_per_sqm=EXCLUDED.price_per_sqm,
        floor_area_sqm=EXCLUDED.floor_area_sqm, stand_size_sqm=EXCLUDED.stand_size_sqm,
        bedrooms=EXCLUDED.bedrooms, bathrooms=EXCLUDED.bathrooms,
        parking_total=EXCLUDED.parking_total, floor_number=EXCLUDED.floor_number,
        levies_monthly=EXCLUDED.levies_monthly, rates_monthly=EXCLUDED.rates_monthly,
        days_on_market=EXCLUDED.days_on_market, suburb=EXCLUDED.suburb, city=EXCLUDED.city,
        property_type=EXCLUDED.property_type, pet_friendly=EXCLUDED.pet_friendly,
        furnished=EXCLUDED.furnished, has_pool=EXCLUDED.has_pool, has_garden=EXCLUDED.has_garden,
        has_braai=EXCLUDED.has_braai, has_balcony=EXCLUDED.has_balcony, has_aircon=EXCLUDED.has_aircon,
        has_security=EXCLUDED.has_security, airbnb_friendly=EXCLUDED.airbnb_friendly,
        crime_score=EXCLUDED.crime_score, insurance_risk_score=EXCLUDED.insurance_risk_score,
        solar_suitability_score=EXCLUDED.solar_suitability_score, asbestos_risk=EXCLUDED.asbestos_risk,
        total_findings=EXCLUDED.total_findings, critical_findings=EXCLUDED.critical_findings,
        repair_cost_max=EXCLUDED.repair_cost_max, decision=EXCLUDED.decision,
        data_completeness=EXCLUDED.data_completeness, updated_at=NOW()
    `, [
      p.id, p.asking_price,
      (p.asking_price && p.floor_area_sqm) ? Math.round(p.asking_price / p.floor_area_sqm) : null,
      p.floor_area_sqm, p.stand_size_sqm, p.bedrooms, p.bathrooms,
      (p.parking_spaces || 0) + (p.garages || 0),
      p.floor_number, p.levies, p.rates_and_taxes,
      daysOnMarket, p.suburb, p.city, p.property_type,
      p.pet_friendly || false, p.furnished || false,
      p.has_pool || false, p.has_garden || false, p.has_braai || false,
      p.has_balcony || false, p.has_aircon || false, hasSecurity, p.airbnb_friendly || false,
      p.suburb_crime_score || p.crime_risk_score, p.insurance_risk_score, p.solar_suitability_score,
      p.asbestos_risk, totalFindings, criticalFindings, repairMax,
      p.decision, Math.round(completeness * 100) / 100,
    ]);

    updated++;
  }

  console.log(`Updated ${updated} training records`);
}

async function showStats() {
  console.log('\n=== TRAINING DATA STATS ===\n');

  const { rows: total } = await pool.query('SELECT COUNT(*) AS c FROM training_data');
  console.log(`Total records: ${total[0].c}`);

  const { rows: completeness } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE data_completeness >= 0.8) AS high,
      COUNT(*) FILTER (WHERE data_completeness >= 0.5 AND data_completeness < 0.8) AS medium,
      COUNT(*) FILTER (WHERE data_completeness < 0.5) AS low
    FROM training_data
  `);
  const c = completeness[0];
  console.log(`Completeness: ${c.high} high (>80%) | ${c.medium} medium (50-80%) | ${c.low} low (<50%)`);

  const { rows: byCity } = await pool.query(
    'SELECT city, COUNT(*) AS c, AVG(price_zar) AS avg_price FROM training_data WHERE price_zar IS NOT NULL GROUP BY city ORDER BY c DESC'
  );
  console.log('\nBy city:');
  for (const r of byCity) console.log(`  ${r.city}: ${r.c} properties, avg R${Math.round(r.avg_price).toLocaleString()}`);

  const { rows: byType } = await pool.query(
    'SELECT property_type, COUNT(*) AS c FROM training_data WHERE property_type IS NOT NULL GROUP BY property_type ORDER BY c DESC'
  );
  console.log('\nBy type:');
  for (const r of byType) console.log(`  ${r.property_type}: ${r.c}`);

  const { rows: priceRange } = await pool.query(
    'SELECT MIN(price_zar) AS min, MAX(price_zar) AS max, AVG(price_zar) AS avg FROM training_data WHERE price_zar IS NOT NULL'
  );
  const pr = priceRange[0];
  console.log(`\nPrice range: R${parseInt(pr.min).toLocaleString()} — R${parseInt(pr.max).toLocaleString()} (avg R${Math.round(pr.avg).toLocaleString()})`);

  const { rows: withFindings } = await pool.query(
    'SELECT COUNT(*) AS c FROM training_data WHERE total_findings > 0'
  );
  console.log(`With vision findings: ${withFindings[0].c}`);
}

async function main() {
  if (process.argv.includes('--stats')) { await showStats(); }
  else { await buildTrainingData(); await showStats(); }
  await pool.end();
}

main().catch(err => { console.error(err); pool.end(); process.exit(1); });
