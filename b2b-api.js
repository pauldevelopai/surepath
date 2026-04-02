const express = require('express');
const pool = require('./db');
const { geocode } = require('./maps');
const { generateReport } = require('./pipeline');

const router = express.Router();

router.use(express.json());

// ─── Auth middleware ───────────────────────────────────────────────────

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key', code: 'AUTH_MISSING' });
  }

  const apiKey = authHeader.replace('Bearer ', '').trim();

  // Look up client
  const { rows: clients } = await pool.query(
    'SELECT * FROM api_clients WHERE api_key = $1 AND active = TRUE',
    [apiKey]
  );

  if (clients.length === 0) {
    return res.status(401).json({ error: 'Invalid API key', code: 'AUTH_INVALID' });
  }

  const client = clients[0];

  // Rate limit check
  const { rows: usage } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM api_usage
     WHERE client_id = $1 AND created_at >= CURRENT_DATE`,
    [client.id]
  );

  if (parseInt(usage[0].cnt) >= client.rate_limit_per_day) {
    return res.status(429).json({ error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
  }

  req.apiClient = client;
  req._startTime = Date.now();
  next();
}

// ─── Usage logging ─────────────────────────────────────────────────────

async function logUsage(req, endpoint, propertyId, wasCacheHit) {
  const responseTimeMs = Date.now() - req._startTime;
  const billedAmount = req.apiClient.price_per_query_zar || 0;

  await pool.query(
    `INSERT INTO api_usage (client_id, property_id, endpoint, was_cache_hit, response_time_ms, billed_amount_zar)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.apiClient.id, propertyId, endpoint, wasCacheHit, responseTimeMs, billedAmount]
  );
}

// ─── Cache logic: find property + recent report by address ─────────────

async function resolvePropertyAndReport(address) {
  // Step 1: Geocode
  const geo = await geocode(address);

  let property = null;
  let report = null;
  let wasCacheHit = false;

  if (geo) {
    // Step 2: Find nearest property within 50m (~0.00045 degrees)
    const { rows: nearby } = await pool.query(
      `SELECT p.*, pr.id AS report_id, pr.created_at AS report_created,
              pr.insurance_risk_score, pr.insurance_flags, pr.crime_risk_score,
              pr.solar_suitability_score, pr.trades_flags, pr.maintenance_cost_estimate,
              pr.asbestos_risk, pr.vision_findings, pr.structural_flags,
              pr.compliance_flags, pr.repair_estimates, pr.negotiation_intel,
              pr.decision, pr.decision_reasoning, pr.asking_price,
              pr.avm_low, pr.avm_high, pr.price_verdict, pr.comparables,
              pr.suburb_intelligence, pr.pdf_url, pr.status AS report_status
       FROM properties p
       LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
       WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
         AND ABS(p.lat - $1) < 0.00045
         AND ABS(p.lng - $2) < 0.00045
       ORDER BY pr.created_at DESC NULLS LAST
       LIMIT 1`,
      [geo.lat, geo.lng]
    );

    if (nearby.length > 0) {
      property = nearby[0];

      // Step 3: Check if report is < 90 days old
      if (property.report_id && property.report_created) {
        const ageMs = Date.now() - new Date(property.report_created).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

        if (ageDays < 90) {
          report = property; // has all report fields joined
          report._age_days = ageDays;
          wasCacheHit = true;
        }
      }
    }
  }

  // Also try exact erf_number match
  if (!property) {
    const { rows: exact } = await pool.query(
      `SELECT p.*, pr.id AS report_id, pr.created_at AS report_created,
              pr.insurance_risk_score, pr.insurance_flags, pr.crime_risk_score,
              pr.solar_suitability_score, pr.trades_flags, pr.maintenance_cost_estimate,
              pr.asbestos_risk, pr.vision_findings, pr.structural_flags,
              pr.compliance_flags, pr.repair_estimates, pr.negotiation_intel,
              pr.decision, pr.decision_reasoning, pr.asking_price,
              pr.avm_low, pr.avm_high, pr.price_verdict, pr.comparables,
              pr.suburb_intelligence, pr.pdf_url, pr.status AS report_status
       FROM properties p
       LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
       WHERE p.address_raw ILIKE $1 OR p.address_normalised ILIKE $1
       ORDER BY pr.created_at DESC NULLS LAST
       LIMIT 1`,
      [`%${address}%`]
    );

    if (exact.length > 0) {
      property = exact[0];
      if (property.report_id && property.report_created) {
        const ageMs = Date.now() - new Date(property.report_created).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        if (ageDays < 90) {
          report = property;
          report._age_days = ageDays;
          wasCacheHit = true;
        }
      }
    }
  }

  return { property, report, wasCacheHit, geo };
}

// If no cached report, generate one
async function ensureReport(address, askingPrice) {
  let { property, report, wasCacheHit } = await resolvePropertyAndReport(address);

  if (report && wasCacheHit) {
    return { report, property, wasCacheHit: true };
  }

  // Generate fresh report
  const result = await generateReport(address, askingPrice || 0, 'b2b-api');

  // Re-fetch the full report
  const { rows: freshReports } = await pool.query(
    `SELECT p.*, pr.*,
            pr.created_at AS report_created
     FROM property_reports pr
     JOIN properties p ON p.id = pr.property_id
     WHERE pr.id = $1`,
    [result.report_id]
  );

  return {
    report: freshReports[0],
    property: freshReports[0],
    wasCacheHit: false,
  };
}

// ─── Apply auth to all /api/v1 routes ──────────────────────────────────

router.use('/api/v1', authMiddleware);

// ─── POST /api/v1/risk/insurance ───────────────────────────────────────

router.post('/api/v1/risk/insurance', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required', code: 'MISSING_FIELD' });

    const { report, property, wasCacheHit } = await ensureReport(address);

    const ageDays = report._age_days ?? Math.floor((Date.now() - new Date(report.report_created).getTime()) / 86400000);

    await logUsage(req, 'risk/insurance', property.id, wasCacheHit);

    res.json({
      insurance_risk_score: report.insurance_risk_score,
      insurance_flags: report.insurance_flags || [],
      maintenance_cost_estimate: report.maintenance_cost_estimate,
      asbestos_risk: report.asbestos_risk,
      report_age_days: ageDays,
      erf_number: property.erf_number,
    });
  } catch (err) {
    console.error('[b2b] risk/insurance error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/v1/risk/crime ───────────────────────────────────────────

router.post('/api/v1/risk/crime', async (req, res) => {
  try {
    const { address, radius_km } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required', code: 'MISSING_FIELD' });

    const { report, property, wasCacheHit } = await ensureReport(address);

    // Get crime incident breakdown from crime_incidents table
    const radiusDeg = (radius_km || 2) * 0.009; // ~1km = 0.009 degrees
    let incidentBreakdown = {};
    let sapsDataPeriod = 'N/A';

    if (property.lat && property.lng) {
      const { rows: incidents } = await pool.query(
        `SELECT incident_type, COUNT(*) AS cnt
         FROM crime_incidents
         WHERE ABS(lat - $1) < $3 AND ABS(lng - $2) < $3
         GROUP BY incident_type`,
        [property.lat, property.lng, radiusDeg]
      );
      for (const r of incidents) {
        incidentBreakdown[r.incident_type] = parseInt(r.cnt);
      }

      const { rows: period } = await pool.query(
        `SELECT MIN(incident_date) AS start_date, MAX(incident_date) AS end_date
         FROM crime_incidents
         WHERE ABS(lat - $1) < $2 AND ABS(lng - $2) < $2`,
        [property.lat, radiusDeg]
      );
      if (period[0]?.start_date) {
        sapsDataPeriod = `${period[0].start_date} to ${period[0].end_date}`;
      }
    }

    // Fallback: use suburb-level data
    if (Object.keys(incidentBreakdown).length === 0 && property.suburb) {
      const { rows: suburbIncidents } = await pool.query(
        `SELECT incident_type, COUNT(*) AS cnt
         FROM crime_incidents
         WHERE suburb ILIKE $1
         GROUP BY incident_type`,
        [property.suburb]
      );
      for (const r of suburbIncidents) {
        incidentBreakdown[r.incident_type] = parseInt(r.cnt);
      }
    }

    const ageDays = report._age_days ?? Math.floor((Date.now() - new Date(report.report_created).getTime()) / 86400000);

    await logUsage(req, 'risk/crime', property.id, wasCacheHit);

    res.json({
      crime_risk_score: report.crime_risk_score,
      suburb: property.suburb,
      incident_breakdown: incidentBreakdown,
      saps_data_period: sapsDataPeriod,
      report_age_days: ageDays,
    });
  } catch (err) {
    console.error('[b2b] risk/crime error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/v1/solar/suitability ────────────────────────────────────

router.post('/api/v1/solar/suitability', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required', code: 'MISSING_FIELD' });

    const { report, property, wasCacheHit } = await ensureReport(address);

    // Recommend system size based on floor area
    const floorArea = property.floor_area_sqm || 150;
    const recommendedKw = Math.round(floorArea * 0.03 * 10) / 10; // ~3W per sqm heuristic

    const ageDays = report._age_days ?? Math.floor((Date.now() - new Date(report.report_created).getTime()) / 86400000);

    await logUsage(req, 'solar/suitability', property.id, wasCacheHit);

    res.json({
      solar_suitability_score: report.solar_suitability_score,
      solar_installed: property.solar_installed || false,
      roof_material: property.roof_material || 'unknown',
      roof_orientation: property.roof_orientation || 'unclear',
      recommended_system_size_kw: recommendedKw,
      erf_number: property.erf_number,
    });
  } catch (err) {
    console.error('[b2b] solar/suitability error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/v1/leads/trades ─────────────────────────────────────────

router.post('/api/v1/leads/trades', async (req, res) => {
  try {
    const { suburb, city, trade_type, min_severity } = req.body;
    if (!suburb || !city) return res.status(400).json({ error: 'suburb and city are required', code: 'MISSING_FIELD' });

    const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'COSMETIC'];
    const minIdx = severityOrder.indexOf(min_severity || 'MEDIUM');
    const allowedSeverities = severityOrder.slice(0, minIdx + 1);

    // Find properties with trades_flags in the specified suburb
    let sql = `
      SELECT p.address_raw, p.address_normalised, p.erf_number,
             pr.trades_flags, pr.repair_estimates, pr.created_at AS report_date
      FROM property_reports pr
      JOIN properties p ON p.id = pr.property_id
      WHERE p.suburb ILIKE $1 AND p.city ILIKE $2
        AND pr.status = 'complete'
        AND pr.trades_flags IS NOT NULL
    `;
    const params = [suburb, city];

    const { rows } = await pool.query(sql, params);

    // Filter and shape results
    const properties = [];
    for (const r of rows) {
      const flags = r.trades_flags || [];
      const matchingFlags = [];

      for (const flag of (Array.isArray(flags) ? flags : [])) {
        // Filter by trade_type if specified
        if (trade_type && flag.trade_type !== trade_type) continue;

        const items = flag.items || [];
        for (const item of items) {
          const sev = item.severity || 'MEDIUM';
          if (allowedSeverities.includes(sev)) {
            matchingFlags.push(item.observation || item.description || flag.trade_type);
          }
        }
      }

      if (matchingFlags.length > 0) {
        const estimates = r.repair_estimates || {};
        properties.push({
          address: r.address_normalised || r.address_raw,
          erf_number: r.erf_number,
          trade_flags: matchingFlags,
          estimated_job_value: {
            min: estimates.total_min_zar || 0,
            max: estimates.total_max_zar || 0,
          },
          report_date: r.report_date,
        });
      }
    }

    await logUsage(req, 'leads/trades', null, true);

    res.json({ count: properties.length, properties });
  } catch (err) {
    console.error('[b2b] leads/trades error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/v1/leads/solar ──────────────────────────────────────────

router.post('/api/v1/leads/solar', async (req, res) => {
  try {
    const { suburb, city, filters } = req.body;
    if (!suburb || !city) return res.status(400).json({ error: 'suburb and city are required', code: 'MISSING_FIELD' });

    const f = filters || {};

    let sql = `
      SELECT p.address_raw, p.address_normalised, p.erf_number,
             p.construction_era, p.roof_material, p.roof_orientation, p.solar_installed,
             pr.solar_suitability_score
      FROM property_reports pr
      JOIN properties p ON p.id = pr.property_id
      WHERE p.suburb ILIKE $1 AND p.city ILIKE $2
        AND pr.status = 'complete'
        AND pr.solar_suitability_score IS NOT NULL
    `;
    const params = [suburb, city];
    let idx = 3;

    if (f.no_solar) {
      sql += ' AND (p.solar_installed = FALSE OR p.solar_installed IS NULL)';
    }
    if (f.min_roof_score) {
      sql += ` AND pr.solar_suitability_score >= $${idx++}`;
      params.push(f.min_roof_score);
    }

    sql += ' ORDER BY pr.solar_suitability_score DESC LIMIT 100';

    const { rows } = await pool.query(sql, params);

    // Filter by max_build_year in JS (construction_era is text)
    let results = rows;
    if (f.max_build_year) {
      results = rows.filter(r => {
        if (!r.construction_era) return true;
        const yearMatch = r.construction_era.match(/(\d{4})/);
        if (!yearMatch) return true;
        return parseInt(yearMatch[1]) <= f.max_build_year;
      });
    }

    const properties = results.map(r => ({
      address: r.address_normalised || r.address_raw,
      erf_number: r.erf_number,
      solar_suitability_score: r.solar_suitability_score,
      roof_material: r.roof_material || 'unknown',
      roof_orientation: r.roof_orientation || 'unclear',
      construction_era: r.construction_era || 'unknown',
    }));

    await logUsage(req, 'leads/solar', null, true);

    res.json({ count: properties.length, properties });
  } catch (err) {
    console.error('[b2b] leads/solar error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── GET /api/v1/heat-map/crime ────────────────────────────────────────

router.get('/api/v1/heat-map/crime', async (req, res) => {
  try {
    const { suburb, city } = req.query;
    if (!suburb || !city) return res.status(400).json({ error: 'suburb and city query params are required', code: 'MISSING_FIELD' });

    const { rows: incidents } = await pool.query(
      `SELECT incident_type, COUNT(*) AS cnt
       FROM crime_incidents
       WHERE suburb ILIKE $1 AND city ILIKE $2
       GROUP BY incident_type`,
      [suburb, city]
    );

    const incidentCounts = {};
    let total = 0;
    for (const r of incidents) {
      incidentCounts[r.incident_type] = parseInt(r.cnt);
      total += parseInt(r.cnt);
    }

    const { rows: period } = await pool.query(
      `SELECT MIN(incident_date) AS start_date, MAX(incident_date) AS end_date,
              MAX(created_at) AS last_updated
       FROM crime_incidents
       WHERE suburb ILIKE $1 AND city ILIKE $2`,
      [suburb, city]
    );

    const p = period[0] || {};
    const coveragePeriod = p.start_date ? `${p.start_date} to ${p.end_date}` : 'No data';

    await logUsage(req, 'heat-map/crime', null, true);

    res.json({
      suburb,
      city,
      incident_counts: incidentCounts,
      total_incidents: total,
      coverage_period: coveragePeriod,
      last_updated: p.last_updated || null,
    });
  } catch (err) {
    console.error('[b2b] heat-map/crime error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

// ─── POST /api/v1/report/full ──────────────────────────────────────────

router.post('/api/v1/report/full', async (req, res) => {
  try {
    const { address, asking_price } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required', code: 'MISSING_FIELD' });

    const { report, property, wasCacheHit } = await ensureReport(address, asking_price);

    const ageDays = report._age_days ?? Math.floor((Date.now() - new Date(report.report_created || report.created_at).getTime()) / 86400000);

    // Bill at enterprise rate — use client's price or 5x default
    const billedAmount = (req.apiClient.price_per_query_zar || 0) * 5;
    const responseTimeMs = Date.now() - req._startTime;

    await pool.query(
      `INSERT INTO api_usage (client_id, property_id, endpoint, was_cache_hit, response_time_ms, billed_amount_zar)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.apiClient.id, property.id, 'report/full', wasCacheHit, responseTimeMs, billedAmount]
    );

    res.json({
      erf_number: property.erf_number,
      address: property.address_normalised || property.address_raw,
      suburb: property.suburb,
      city: property.city,
      province: property.province,
      property_type: property.property_type,
      stand_size_sqm: property.stand_size_sqm,
      floor_area_sqm: property.floor_area_sqm,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      construction_era: property.construction_era,
      asking_price: report.asking_price,
      avm_low: report.avm_low,
      avm_high: report.avm_high,
      price_verdict: report.price_verdict,
      comparables: report.comparables,
      suburb_intelligence: report.suburb_intelligence,
      vision_findings: report.vision_findings,
      asbestos_risk: report.asbestos_risk,
      structural_flags: report.structural_flags,
      compliance_flags: report.compliance_flags,
      repair_estimates: report.repair_estimates,
      negotiation_intel: report.negotiation_intel,
      decision: report.decision,
      decision_reasoning: report.decision_reasoning,
      insurance_risk_score: report.insurance_risk_score,
      insurance_flags: report.insurance_flags,
      crime_risk_score: report.crime_risk_score,
      solar_suitability_score: report.solar_suitability_score,
      trades_flags: report.trades_flags,
      maintenance_cost_estimate: report.maintenance_cost_estimate,
      solar_installed: property.solar_installed,
      security_visible: property.security_visible,
      roof_material: property.roof_material,
      roof_orientation: property.roof_orientation,
      pdf_url: report.pdf_url,
      report_age_days: ageDays,
      was_cache_hit: wasCacheHit,
    });
  } catch (err) {
    console.error('[b2b] report/full error:', err);
    res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
