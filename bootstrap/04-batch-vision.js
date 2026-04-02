#!/usr/bin/env node
/**
 * PHASE 4 — Batch vision analysis on all property photos
 *
 * Runs Claude Haiku on listing photos for properties that don't have
 * vision analysis yet. Populates:
 * - property_images.vision_analysis
 * - property_reports with B2B scores (insurance, solar, trades, asbestos)
 * - properties with roof_material, solar_installed, security_visible
 *
 * Usage:
 *   node bootstrap/04-batch-vision.js                # Process all un-analysed
 *   node bootstrap/04-batch-vision.js --limit 50     # Process max 50 properties
 *   node bootstrap/04-batch-vision.js --dry-run      # Show what would be analysed
 *   node bootstrap/04-batch-vision.js --cost-estimate # Estimate API cost only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const pool = require('../db');
const { analysePropertyImages, aggregateFindings } = require('../vision');
const { classifyEra, AGE_RISK_MATRIX } = require('../synthesis');

const DELAY_MS = 1000; // Between properties

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;
  const dryRun = args.includes('--dry-run');
  const costOnly = args.includes('--cost-estimate');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    await pool.end();
    process.exit(1);
  }

  // Find properties with photos but no vision analysis
  let sql = `
    SELECT DISTINCT p.id, p.address_raw, p.construction_era,
           COUNT(pi.id) AS photo_count
    FROM properties p
    JOIN property_images pi ON pi.property_id = p.id
    WHERE pi.vision_analysis IS NULL
      AND pi.source = 'property24'
    GROUP BY p.id
    ORDER BY photo_count DESC
  `;
  if (limit) sql += ` LIMIT ${limit}`;

  const { rows: properties } = await pool.query(sql);
  console.log(`Found ${properties.length} properties with un-analysed photos`);

  const totalPhotos = properties.reduce((s, p) => s + parseInt(p.photo_count), 0);
  console.log(`Total photos to analyse: ${totalPhotos}`);

  // Cost estimate: Haiku ~$0.25/M input + $1.25/M output, ~1500 tokens per photo
  const estInputTokens = totalPhotos * 1500;
  const estOutputTokens = totalPhotos * 500;
  const estCostUSD = (estInputTokens * 0.25 + estOutputTokens * 1.25) / 1_000_000;
  const estCostZAR = estCostUSD * 18;
  console.log(`Estimated cost: ~$${estCostUSD.toFixed(2)} USD / ~R${estCostZAR.toFixed(2)} ZAR`);

  if (costOnly || dryRun) {
    if (dryRun) {
      for (const p of properties.slice(0, 20)) {
        console.log(`  Would analyse: ${p.address_raw} (${p.photo_count} photos)`);
      }
    }
    await pool.end();
    return;
  }

  let processed = 0;
  let failed = 0;
  let totalFindings = 0;

  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    console.log(`\n[${i + 1}/${properties.length}] ${prop.address_raw} (${prop.photo_count} photos)`);

    try {
      // Get photo URLs for this property
      const { rows: images } = await pool.query(
        `SELECT image_url FROM property_images
         WHERE property_id = $1 AND source = 'property24' AND vision_analysis IS NULL
         ORDER BY id LIMIT 12`,
        [prop.id]
      );

      const photoUrls = images.map(img => img.image_url).filter(url => url.startsWith('http'));

      if (photoUrls.length === 0) {
        console.log('  No valid photo URLs — skipping');
        continue;
      }

      // Run vision analysis
      const result = await analysePropertyImages(photoUrls, prop.id);

      if (!result) {
        console.log('  Vision analysis returned null');
        failed++;
        continue;
      }

      const agg = result.aggregated;
      totalFindings += agg.vision_findings.length;

      // Apply building age risk
      const eraKey = classifyEra(prop.construction_era);
      const ageRisk = AGE_RISK_MATRIX[eraKey];

      // Determine asbestos risk: worst of age-based and vision-based
      let asbestosRisk = agg.asbestos_risk;
      const ageAsbestos = ageRisk.asbestos;
      const riskOrder = ['NEGLIGIBLE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      if (riskOrder.indexOf(ageAsbestos) > riskOrder.indexOf(asbestosRisk)) {
        asbestosRisk = ageAsbestos;
      }

      // Create/update property_report with vision data
      const { rows: existingReports } = await pool.query(
        "SELECT id FROM property_reports WHERE property_id = $1 AND status = 'complete'",
        [prop.id]
      );

      if (existingReports.length > 0) {
        // Update existing report
        await pool.query(
          `UPDATE property_reports SET
             vision_findings = $1, asbestos_risk = $2,
             structural_flags = $3, compliance_flags = $4,
             repair_estimates = $5,
             insurance_risk_score = $6, insurance_flags = $7,
             solar_suitability_score = $8,
             trades_flags = $9, maintenance_cost_estimate = $10,
             last_refreshed_at = NOW()
           WHERE id = $11`,
          [
            JSON.stringify(agg.vision_findings), asbestosRisk,
            JSON.stringify(agg.structural_flags), JSON.stringify(agg.compliance_flags),
            JSON.stringify(agg.repair_estimates),
            agg.insurance_risk_score, JSON.stringify(agg.insurance_flags),
            agg.solar_suitability_score,
            JSON.stringify(agg.trades_flags), agg.maintenance_cost_estimate,
            existingReports[0].id,
          ]
        );
      } else {
        // Create a new vision-only report (no full synthesis)
        await pool.query(
          `INSERT INTO property_reports (
             property_id, vision_findings, asbestos_risk,
             structural_flags, compliance_flags, repair_estimates,
             insurance_risk_score, insurance_flags,
             solar_suitability_score,
             trades_flags, maintenance_cost_estimate,
             decision, decision_reasoning, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'complete')`,
          [
            prop.id,
            JSON.stringify(agg.vision_findings), asbestosRisk,
            JSON.stringify(agg.structural_flags), JSON.stringify(agg.compliance_flags),
            JSON.stringify(agg.repair_estimates),
            agg.insurance_risk_score, JSON.stringify(agg.insurance_flags),
            agg.solar_suitability_score,
            JSON.stringify(agg.trades_flags), agg.maintenance_cost_estimate,
            'INSPECT_FIRST', 'Vision-only analysis — full report requires asking price.',
          ]
        );
      }

      // Update property with vision-derived fields
      await pool.query(
        `UPDATE properties SET
           solar_installed = COALESCE($1, solar_installed),
           security_visible = COALESCE($2, security_visible),
           roof_material = COALESCE($3, roof_material),
           roof_orientation = COALESCE($4, roof_orientation)
         WHERE id = $5`,
        [agg.solar_installed || null, agg.security_visible || null,
         agg.roof_material !== 'unknown' ? agg.roof_material : null,
         agg.roof_orientation !== 'unclear' ? agg.roof_orientation : null,
         prop.id]
      );

      processed++;
      console.log(`  ${agg.vision_findings.length} findings | insurance=${agg.insurance_risk_score}/10 | solar=${agg.solar_suitability_score}/10 | asbestos=${asbestosRisk}`);

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n=== BATCH VISION COMPLETE ===`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total findings: ${totalFindings}`);

  const { rows: dbStats } = await pool.query(`
    SELECT
      COUNT(DISTINCT pi.property_id) FILTER (WHERE pi.vision_analysis IS NOT NULL) AS analysed_properties,
      COUNT(*) FILTER (WHERE pi.vision_analysis IS NOT NULL) AS analysed_images,
      COUNT(*) AS total_images
    FROM property_images pi
  `);
  console.log(`  Images analysed: ${dbStats[0].analysed_images}/${dbStats[0].total_images}`);
  console.log(`  Properties with analysis: ${dbStats[0].analysed_properties}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
