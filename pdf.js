const puppeteer = require('puppeteer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const pool = require('./db');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'af-south-1',
});

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'surepath-reports';

// ─── Format helpers ────────────────────────────────────────────────────

function formatZAR(amount) {
  if (amount == null) return 'N/A';
  return 'R' + Number(amount).toLocaleString('en-ZA');
}

function formatDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
}

function severityBadge(severity) {
  const colours = {
    CRITICAL: '#E63946',
    HIGH: '#E67E22',
    MEDIUM: '#F1C40F',
    LOW: '#27AE60',
    NEGLIGIBLE: '#95A5A6',
    COSMETIC: '#BDC3C7',
  };
  const bg = colours[severity] || '#95A5A6';
  const text = severity === 'MEDIUM' || severity === 'LOW' ? '#000' : '#FFF';
  return `<span style="background:${bg};color:${text};padding:2px 8px;border-radius:3px;font-size:11px;font-weight:bold">${severity}</span>`;
}

function riskBar(score, max = 10) {
  const pct = Math.round((score / max) * 100);
  let colour = '#27AE60';
  if (score >= 7) colour = '#E63946';
  else if (score >= 4) colour = '#F1C40F';
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="width:120px;height:12px;background:#E0E0E0;border-radius:6px;overflow:hidden">
      <div style="width:${pct}%;height:100%;background:${colour};border-radius:6px"></div>
    </div>
    <span style="font-weight:bold">${score}/10</span>
  </div>`;
}

// ─── HTML template ─────────────────────────────────────────────────────

function buildHTML(report, property, deeds, images, areaRisks) {
  const r = report;
  const p = property;
  images = images || [];
  areaRisks = areaRisks || [];
  const d = deeds;
  const today = formatDate(new Date());

  // Transfer history rows
  let transferRows = '';
  const transfers = d?.transfer_history || [];
  if (Array.isArray(transfers)) {
    for (const t of transfers) {
      transferRows += `<tr>
        <td>${t.date || 'N/A'}</td>
        <td>${formatZAR(t.price)}</td>
        <td>${t.buyer || 'N/A'}</td>
        <td>${t.seller || 'N/A'}</td>
        <td>${formatZAR(t.bond)}</td>
      </tr>`;
    }
  }

  // Comparables rows
  let compRows = '';
  const comps = r.comparables || [];
  if (Array.isArray(comps)) {
    for (const c of comps) {
      compRows += `<tr>
        <td>${c.address || 'N/A'}</td>
        <td>${formatZAR(c.price)}</td>
        <td>${c.sold_date || 'N/A'}</td>
        <td>${c.size_sqm || 'N/A'} m²</td>
      </tr>`;
    }
  }

  // Vision findings grouped by category
  const findings = r.vision_findings || [];
  const findingsByCategory = {};
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const cat = f.category || f.photo_type || 'other';
    if (!findingsByCategory[cat]) findingsByCategory[cat] = [];
    findingsByCategory[cat].push(f);
  }

  let findingsHTML = '';
  for (const [cat, items] of Object.entries(findingsByCategory)) {
    findingsHTML += `<h3 style="color:#0D1B2A;text-transform:capitalize;margin-top:16px">${cat}</h3>`;
    for (const f of items) {
      findingsHTML += `<div style="background:#F8F9FA;padding:10px 14px;border-left:3px solid #0D1B2A;margin-bottom:8px;border-radius:0 4px 4px 0">
        ${severityBadge(f.severity || 'LOW')}
        <span style="margin-left:8px">${f.observation || f.finding || 'N/A'}</span>
        ${f.estimated_repair_cost_zar ? `<br><small style="color:#666">Estimated repair: ${formatZAR(f.estimated_repair_cost_zar.min)} – ${formatZAR(f.estimated_repair_cost_zar.max)}</small>` : ''}
        ${f.confidence ? `<br><small style="color:#888">Confidence: ${f.confidence}</small>` : ''}
      </div>`;
    }
  }

  // Repair items
  const repairEstimates = r.repair_estimates || {};
  const repairItems = repairEstimates.items || [];
  let repairRows = '';
  for (const item of repairItems) {
    repairRows += `<tr>
      <td style="text-transform:capitalize">${item.category || item.trade_type || 'N/A'}</td>
      <td>${item.description || 'N/A'}</td>
      <td>${formatZAR(item.min)}</td>
      <td>${formatZAR(item.max)}</td>
    </tr>`;
  }

  // Compliance flags
  let complianceHTML = '';
  const complianceFlags = r.compliance_flags || [];
  for (const f of (Array.isArray(complianceFlags) ? complianceFlags : [])) {
    complianceHTML += `<div style="background:#FFF3CD;padding:10px 14px;border-left:3px solid #F1C40F;margin-bottom:8px;border-radius:0 4px 4px 0">
      ${severityBadge(f.severity || 'MEDIUM')}
      <span style="margin-left:8px">${f.observation || 'N/A'}</span>
    </div>`;
  }

  // Structural flags
  let structuralHTML = '';
  const structuralFlags = r.structural_flags || [];
  for (const f of (Array.isArray(structuralFlags) ? structuralFlags : [])) {
    structuralHTML += `<div style="background:#F8D7DA;padding:10px 14px;border-left:3px solid #E63946;margin-bottom:8px;border-radius:0 4px 4px 0">
      ${severityBadge(f.severity || 'HIGH')}
      <span style="margin-left:8px">${f.observation || 'N/A'}</span>
    </div>`;
  }

  // Negotiation intel
  const negIntel = r.negotiation_intel || {};
  const negPoints = negIntel.negotiation_points || [];
  const negSignals = negIntel.motivated_seller_signals || [];

  // Suburb intelligence
  const subIntel = r.suburb_intelligence || {};

  // Trades flags
  const tradesFlags = r.trades_flags || [];
  let tradesHTML = '';
  for (const t of (Array.isArray(tradesFlags) ? tradesFlags : [])) {
    const tradeType = t.trade_type || t.description || 'N/A';
    const items = t.items || [];
    tradesHTML += `<div style="margin-bottom:8px"><strong style="text-transform:capitalize">${tradeType}</strong>`;
    if (Array.isArray(items)) {
      for (const item of items) {
        tradesHTML += `<div style="margin-left:16px;color:#555">• ${item.observation || item.description || 'N/A'}${item.est_cost ? ` (est. ${formatZAR(item.est_cost)})` : ''}</div>`;
      }
    }
    tradesHTML += `</div>`;
  }

  // Decision colour
  const decisionColours = { BUY: '#27AE60', NEGOTIATE: '#F1C40F', INSPECT_FIRST: '#E67E22', WALK_AWAY: '#E63946' };
  const decisionColour = decisionColours[r.decision] || '#0D1B2A';

  // Insurance flags
  const insuranceFlags = r.insurance_flags || [];
  let insuranceHTML = '';
  for (const f of (Array.isArray(insuranceFlags) ? insuranceFlags : [])) {
    const text = typeof f === 'string' ? f : (f.observation || f.flag || JSON.stringify(f));
    insuranceHTML += `<div style="margin-left:16px;color:#555">• ${text}</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    margin: 20mm 15mm 25mm 15mm;
    @bottom-center {
      content: "surepath.co.za | Confidential property report";
      font-size: 9px;
      color: #888;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #222; line-height: 1.5; }
  .page-break { page-break-after: always; }
  h1 { color: #0D1B2A; }
  h2 { color: #0D1B2A; border-bottom: 2px solid #E63946; padding-bottom: 6px; margin: 24px 0 12px 0; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th { background: #0D1B2A; color: #FFF; padding: 8px 10px; text-align: left; font-size: 12px; }
  td { padding: 6px 10px; border-bottom: 1px solid #E0E0E0; font-size: 12px; }
  tr:nth-child(even) { background: #F8F9FA; }
  .footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 9px; color: #888; padding: 10px; }
  .cover { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 90vh; text-align: center; }
  .cover h1 { font-size: 48px; letter-spacing: 8px; color: #0D1B2A; margin-bottom: 40px; }
  .cover .address { font-size: 22px; color: #333; margin-bottom: 12px; }
  .cover .meta { font-size: 14px; color: #666; margin-bottom: 6px; }
  .cover .accent-line { width: 80px; height: 4px; background: #E63946; margin: 20px auto; }
  .score-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
  .score-card { background: #F8F9FA; border-radius: 8px; padding: 16px; }
  .score-card .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
  .decision-box { background: #0D1B2A; color: #FFF; border-radius: 12px; padding: 40px; text-align: center; margin: 30px 0; }
  .decision-box .verdict { font-size: 42px; font-weight: bold; letter-spacing: 4px; }
  .decision-box .reasoning { font-size: 16px; margin-top: 20px; line-height: 1.6; color: #CCC; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <h1>SUREPATH</h1>
  <div class="accent-line"></div>
  <div class="address">${p.street_address || p.address_normalised || p.address_raw}</div>
  <div class="meta">${p.suburb || ''}, ${p.city || ''}, ${p.province || ''}</div>
  <div class="meta">${p.bedrooms || '—'} bed | ${p.bathrooms || '—'} bath | ${p.floor_area_sqm ? p.floor_area_sqm + ' m²' : '—'} | ${p.property_type || ''}</div>
  ${r.asking_price ? `<div class="meta" style="font-size:18px;font-weight:bold;margin-top:10px">${formatZAR(r.asking_price)}</div>` : ''}
  <div class="meta" style="margin-top:20px">Report generated: ${today}</div>
  ${p.listing_url ? `<div class="meta" style="font-size:10px;color:#999;margin-top:5px">Source: ${p.listing_url}</div>` : ''}
  <div class="meta" style="margin-top:30px;color:#999">Confidential property intelligence report</div>
</div>
<div class="page-break"></div>

<!-- OWNERSHIP & DEEDS -->
<h2>Ownership History</h2>
${d ? `<p><strong>Registered Owner:</strong> ${d.registered_owner || 'N/A'}</p>
<p><strong>Title Deed:</strong> ${d.title_deed_ref || 'N/A'}</p>
<p><strong>Municipal Value:</strong> ${formatZAR(d.municipal_value)}</p>` : '<p>No deeds data available yet.</p>'}
${transferRows ? `
<h3 style="margin-top:16px;color:#0D1B2A">Transfer History</h3>
<table>
  <thead><tr><th>Date</th><th>Price</th><th>Buyer</th><th>Seller</th><th>Bond</th></tr></thead>
  <tbody>${transferRows}</tbody>
</table>` : ''}

<!-- PRICE ANALYSIS -->
<h2>Price Analysis</h2>
<table>
  <tr><td><strong>Asking Price</strong></td><td>${formatZAR(r.asking_price)}</td></tr>
  <tr><td><strong>AVM Range</strong></td><td>${formatZAR(r.avm_low)} – ${formatZAR(r.avm_high)}</td></tr>
  <tr><td><strong>Verdict</strong></td><td style="text-transform:uppercase;font-weight:bold;color:${r.price_verdict === 'overpriced' ? '#E63946' : r.price_verdict === 'underpriced' ? '#27AE60' : '#F1C40F'}">${r.price_verdict || 'N/A'}</td></tr>
  ${d ? `<tr><td><strong>Municipal Value</strong></td><td>${formatZAR(d.municipal_value)}</td></tr>` : ''}
</table>

<!-- COMPARABLES -->
${compRows ? `
<h2>Comparable Sales</h2>
<table>
  <thead><tr><th>Address</th><th>Price</th><th>Sold</th><th>Size</th></tr></thead>
  <tbody>${compRows}</tbody>
</table>` : ''}

<!-- SUBURB INTELLIGENCE -->
<h2>Suburb Intelligence</h2>
<table>
  <tr><td><strong>Avg Price/m²</strong></td><td>${formatZAR(subIntel.avg_price_sqm)}/m²</td></tr>
  <tr><td><strong>Median Days on Market</strong></td><td>${subIntel.median_days_on_market || 'N/A'} days</td></tr>
  <tr><td><strong>12-Month Price Trend</strong></td><td>${subIntel.price_trend_12m || 'N/A'}</td></tr>
  <tr><td><strong>Active Listings</strong></td><td>${subIntel.total_active_listings || subIntel.total_listings || 'N/A'}</td></tr>
</table>
<div class="page-break"></div>

<!-- BUILDING AGE RISK -->
<h2>Building Age Risk Assessment</h2>
<p><strong>Construction Era:</strong> ${p.construction_era || 'Unknown'}</p>
<table>
  <thead><tr><th>Risk Category</th><th>Level</th></tr></thead>
  <tbody>
    <tr><td>Asbestos Risk</td><td>${severityBadge(r.asbestos_risk || 'NEGLIGIBLE')}</td></tr>
  </tbody>
</table>

<!-- VISUAL FINDINGS -->
<h2>Visual Inspection Findings</h2>
${findingsHTML || '<p>No visual findings recorded.</p>'}

<!-- STRUCTURAL FLAGS -->
${structuralHTML ? `<h2>Structural Flags</h2>${structuralHTML}` : ''}

<!-- COMPLIANCE FLAGS -->
${complianceHTML ? `<h2>Compliance Flags</h2>${complianceHTML}` : ''}
<div class="page-break"></div>

<!-- WHAT NEEDS FIXING -->
<h2>What Needs Fixing</h2>
${repairRows ? `
<table>
  <thead><tr><th>Category</th><th>Description</th><th>Min Cost</th><th>Max Cost</th></tr></thead>
  <tbody>${repairRows}</tbody>
</table>
<p style="margin-top:10px"><strong>Total Estimated Range:</strong> ${formatZAR(repairEstimates.total_min_zar)} – ${formatZAR(repairEstimates.total_max_zar)}</p>
<p><strong>Maintenance Cost Estimate:</strong> ${formatZAR(r.maintenance_cost_estimate)}</p>` : '<p>No repair items identified.</p>'}

<!-- B2B SCORES -->
<h2>Risk & Suitability Scores</h2>
<div class="score-grid">
  <div class="score-card">
    <div class="label">Insurance Risk</div>
    ${riskBar(r.insurance_risk_score || 0)}
    ${insuranceHTML}
  </div>
  <div class="score-card">
    <div class="label">Crime Risk</div>
    ${riskBar(r.crime_risk_score || 0)}
  </div>
  <div class="score-card">
    <div class="label">Solar Suitability</div>
    ${riskBar(r.solar_suitability_score || 0)}
  </div>
  <div class="score-card">
    <div class="label">Maintenance Estimate</div>
    <div style="font-size:20px;font-weight:bold;margin-top:4px">${formatZAR(r.maintenance_cost_estimate)}</div>
  </div>
</div>

<!-- TRADES FLAGS -->
${tradesHTML ? `<h2>Trades Work Required</h2>${tradesHTML}` : ''}

<!-- NEGOTIATION INTELLIGENCE -->
<h2>Negotiation Intelligence</h2>
<table>
  <tr><td><strong>Days on Market</strong></td><td>${negIntel.days_on_market || 'N/A'}</td></tr>
  <tr><td><strong>Price Reductions</strong></td><td>${negIntel.price_reductions || 0}</td></tr>
  <tr><td><strong>Suggested Offer</strong></td><td style="font-weight:bold;color:#27AE60">${formatZAR(negIntel.suggested_offer)}</td></tr>
</table>
${negPoints.length ? `<p style="margin-top:10px"><strong>Negotiation Points:</strong></p><ul>${negPoints.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
${negSignals.length ? `<p style="margin-top:10px"><strong>Motivated Seller Signals:</strong></p><ul>${negSignals.map(s => `<li>${s}</li>`).join('')}</ul>` : ''}

<!-- PROPERTY PHOTOS -->
${images.filter(i => i.image_url && i.image_url.startsWith('http')).length > 0 ? `
<div class="page-break"></div>
<h2>Property Photos</h2>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
${images.filter(i => i.image_url && i.image_url.startsWith('http')).slice(0, 12).map(img => `
  <div>
    <img src="${img.image_url}" style="width:100%;height:180px;object-fit:cover;border-radius:4px" />
    <div style="font-size:9px;color:#888;margin-top:2px">${img.source} — ${img.image_type || 'listing'}</div>
  </div>
`).join('')}
</div>
` : ''}

<!-- PROPERTY DETAILS -->
<div class="page-break"></div>
<h2>Property Details</h2>
<table>
  <tr><td><strong>Address</strong></td><td>${p.street_address || p.address_normalised || p.address_raw}</td></tr>
  <tr><td><strong>Suburb</strong></td><td>${p.suburb || 'N/A'}, ${p.city || ''}</td></tr>
  ${p.bedrooms ? `<tr><td><strong>Bedrooms</strong></td><td>${p.bedrooms}</td></tr>` : ''}
  ${p.bathrooms ? `<tr><td><strong>Bathrooms</strong></td><td>${p.bathrooms}</td></tr>` : ''}
  ${p.floor_area_sqm ? `<tr><td><strong>Floor Area</strong></td><td>${p.floor_area_sqm} m²</td></tr>` : ''}
  ${p.stand_size_sqm ? `<tr><td><strong>Stand Size</strong></td><td>${p.stand_size_sqm} m²</td></tr>` : ''}
  ${p.property_type ? `<tr><td><strong>Property Type</strong></td><td>${p.property_type}</td></tr>` : ''}
  ${p.construction_era ? `<tr><td><strong>Construction Era</strong></td><td>${p.construction_era}</td></tr>` : ''}
  ${p.parking_spaces ? `<tr><td><strong>Parking</strong></td><td>${p.parking_spaces}</td></tr>` : ''}
  ${p.levies ? `<tr><td><strong>Monthly Levies</strong></td><td>${formatZAR(p.levies)}</td></tr>` : ''}
  ${p.rates_and_taxes ? `<tr><td><strong>Rates &amp; Taxes</strong></td><td>${formatZAR(p.rates_and_taxes)}</td></tr>` : ''}
  ${p.pet_friendly ? `<tr><td><strong>Pet Friendly</strong></td><td>Yes</td></tr>` : ''}
  ${p.roof_material ? `<tr><td><strong>Roof Material</strong></td><td>${p.roof_material}</td></tr>` : ''}
  ${p.roof_orientation ? `<tr><td><strong>Roof Orientation</strong></td><td>${p.roof_orientation}</td></tr>` : ''}
  ${p.solar_installed ? `<tr><td><strong>Solar Installed</strong></td><td>Yes</td></tr>` : ''}
  ${p.agent_name ? `<tr><td><strong>Agent</strong></td><td>${p.agent_name}${p.agency_name ? ` — ${p.agency_name}` : ''}</td></tr>` : ''}
</table>

${p.selling_points && p.selling_points.length > 0 ? `
<h3 style="margin-top:16px;color:#0D1B2A">Key Selling Points</h3>
<ul>${p.selling_points.map(s => `<li>${s}</li>`).join('')}</ul>
` : ''}

<!-- INFRASTRUCTURE & RISK -->
${(p.water_quality_score || p.dolomite_risk || p.flood_zone || areaRisks.length > 0) ? `
<h2>Infrastructure &amp; Environmental Risk</h2>
<table>
  ${p.water_quality_score != null ? `<tr><td><strong>Water Quality</strong></td><td>${p.water_quality_score}/10 ${p.water_quality_score >= 8 ? '— Good' : p.water_quality_score >= 5 ? '— Moderate concern' : '— Poor'}</td></tr>` : ''}
  ${p.sewerage_quality_score != null ? `<tr><td><strong>Sewerage Quality</strong></td><td>${p.sewerage_quality_score}/10 ${p.sewerage_quality_score <= 4 ? '— POOR: risk of backflows' : ''}</td></tr>` : ''}
  ${p.dolomite_risk ? `<tr><td><strong>Dolomite/Sinkhole</strong></td><td>${p.dolomite_risk}</td></tr>` : ''}
  ${p.mining_subsidence_risk ? `<tr><td><strong>Mining Subsidence</strong></td><td>${p.mining_subsidence_risk}</td></tr>` : ''}
  ${p.flood_zone ? `<tr><td><strong>Flood Zone</strong></td><td>Yes — ${p.flood_zone_type || 'check municipal records'}</td></tr>` : ''}
  ${p.heritage_site ? `<tr><td><strong>Heritage Area</strong></td><td>Yes — renovation restrictions apply</td></tr>` : ''}
</table>
` : ''}

<!-- COMPLIANCE -->
${p.electrical_coc_required ? `
<h2>Compliance Certificates Required</h2>
<p style="font-size:11px;color:#666;margin-bottom:10px">Required by law for property transfer — seller's responsibility</p>
<table>
  ${p.electrical_coc_required ? `<tr><td><strong>Electrical CoC</strong></td><td>Required (OHS Act) — R1,500-R5,000</td></tr>` : ''}
  ${p.plumbing_coc_required ? `<tr><td><strong>Plumbing CoC</strong></td><td>Required (Municipal by-laws) — R1,000-R3,000</td></tr>` : ''}
  ${p.beetle_cert_required ? `<tr><td><strong>Beetle Certificate</strong></td><td>Required (WC/KZN) — R3,000-R15,000 if treatment needed</td></tr>` : ''}
  ${p.electric_fence_coc_required ? `<tr><td><strong>Electric Fence CoC</strong></td><td>Required — R500-R1,500</td></tr>` : ''}
</table>
` : ''}

<!-- DATA SOURCES -->
<div class="page-break"></div>
<h2>Data Sources &amp; References</h2>
<p style="font-size:11px;color:#666;margin-bottom:10px">Every data point in this report is traceable to its source</p>
<table>
  <thead><tr><th>Data</th><th>Source</th><th>Confidence</th></tr></thead>
  <tbody>
    ${p.listing_url ? `<tr><td>Listing data</td><td><a href="${p.listing_url}">${p.listing_url.includes('privateproperty') ? 'PrivateProperty' : 'Property24'}</a></td><td>Scraped</td></tr>` : ''}
    ${p.lat ? `<tr><td>Coordinates</td><td>Google Maps Geocoding API</td><td>Verified</td></tr>` : ''}
    ${r.vision_findings && r.vision_findings.length > 0 ? `<tr><td>Visual findings (${Array.isArray(r.vision_findings) ? r.vision_findings.length : 0})</td><td>Anthropic Claude Vision</td><td>AI Estimated</td></tr>` : ''}
    ${d ? `<tr><td>Ownership &amp; deeds</td><td>Windeed (Deeds Office)</td><td>Verified</td></tr>` : ''}
    ${p.water_quality_score != null ? `<tr><td>Water quality</td><td>DWS Blue Drop Report</td><td>Verified</td></tr>` : ''}
    ${p.dolomite_risk ? `<tr><td>Geological risk</td><td>Council for Geoscience</td><td>Verified</td></tr>` : ''}
    ${areaRisks.map(ar => `<tr><td>${ar.risk_type}</td><td><a href="${ar.source_url}">${ar.source_name}</a></td><td>${ar.risk_level || 'N/A'}</td></tr>`).join('')}
    <tr><td>Report synthesis</td><td>Anthropic Claude</td><td>AI Generated</td></tr>
  </tbody>
</table>

<div class="page-break"></div>

<!-- DECISION PAGE -->
<div style="min-height:80vh;display:flex;flex-direction:column;justify-content:center">
  <div class="decision-box">
    <div class="verdict" style="color:${decisionColour}">${r.decision}</div>
    <div class="reasoning">${r.decision_reasoning}</div>
  </div>
  <p style="text-align:center;color:#888;font-size:11px;margin-top:20px">
    This report contains risk indicators based on visual analysis and public data.<br>
    It does not replace a professional building inspection or valuation.<br>
    All findings require on-site verification by qualified professionals.
  </p>
</div>

<div class="footer">surepath.co.za | Confidential property report</div>
</body>
</html>`;
}

// ─── PDF rendering ─────────────────────────────────────────────────────

/**
 * Render a property report as a branded PDF.
 *
 * @param {number} reportId
 * @returns {string} S3 URL of the uploaded PDF
 */
async function renderReport(reportId) {
  // Step 1: Fetch report + property + deeds
  console.log(`[pdf] Fetching report ${reportId}...`);

  const { rows: reportRows } = await pool.query(
    'SELECT * FROM property_reports WHERE id = $1',
    [reportId]
  );
  if (reportRows.length === 0) throw new Error(`Report ${reportId} not found`);
  const report = reportRows[0];

  const { rows: propRows } = await pool.query(
    'SELECT * FROM properties WHERE id = $1',
    [report.property_id]
  );
  const property = propRows[0];

  const { rows: deedsRows } = await pool.query(
    'SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1',
    [report.property_id]
  );
  const deeds = deedsRows[0] || null;

  // Fetch images for the PDF
  const { rows: images } = await pool.query(
    'SELECT image_url, source, image_type, vision_analysis FROM property_images WHERE property_id = $1 ORDER BY source, id',
    [report.property_id]
  );

  // Fetch area risks
  const { rows: areaRisks } = await pool.query(
    "SELECT risk_type, risk_level, risk_score, source_name, source_url FROM area_risk_data WHERE (suburb ILIKE $1 OR suburb = 'ALL') AND city ILIKE $2",
    [property.suburb || '', property.city || '']
  );

  // Step 2: Build HTML
  console.log('[pdf] Building HTML template...');
  const html = buildHTML(report, property, deeds, images, areaRisks);

  // Step 3: Render with Puppeteer
  console.log('[pdf] Rendering PDF with Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '25mm', left: '15mm', right: '15mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#888;padding:5px 0">
      surepath.co.za | Confidential property report
      <span style="float:right;margin-right:15mm">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`,
  });

  await browser.close();
  console.log(`[pdf] PDF rendered: ${pdfBuffer.length} bytes`);

  // Step 4: Upload to S3
  const s3Key = `reports/${property.erf_number}/${reportId}-${Date.now()}.pdf`;
  console.log(`[pdf] Uploading to S3: ${s3Key}...`);

  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    }));

    const pdfUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'af-south-1'}.amazonaws.com/${s3Key}`;

    // Step 5: Update report with PDF URL
    await pool.query(
      'UPDATE property_reports SET pdf_url = $1 WHERE id = $2',
      [pdfUrl, reportId]
    );

    console.log(`[pdf] PDF uploaded: ${pdfUrl}`);
    return pdfUrl;
  } catch (err) {
    // S3 upload failed — save locally as fallback
    console.error(`[pdf] S3 upload failed: ${err.message}`);
    const fs = require('fs');
    const path = require('path');
    const localDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    const filename = `${reportId}-${property.erf_number}.pdf`;
    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, pdfBuffer);

    // Save as a relative URL that the dashboard can serve via public/reports symlink
    const publicUrl = `/reports/${filename}`;
    await pool.query(
      'UPDATE property_reports SET pdf_url = $1 WHERE id = $2',
      [publicUrl, reportId]
    );

    console.log(`[pdf] Saved locally: ${localPath} → ${publicUrl}`);
    return publicUrl;
  }
}

/**
 * Render a report to PDF without S3 — returns the Buffer directly.
 * Useful for testing or streaming to the client.
 */
async function renderReportBuffer(reportId) {
  const { rows: reportRows } = await pool.query(
    'SELECT * FROM property_reports WHERE id = $1',
    [reportId]
  );
  if (reportRows.length === 0) throw new Error(`Report ${reportId} not found`);
  const report = reportRows[0];

  const { rows: propRows } = await pool.query(
    'SELECT * FROM properties WHERE id = $1',
    [report.property_id]
  );
  const property = propRows[0];

  const { rows: deedsRows } = await pool.query(
    'SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1',
    [report.property_id]
  );
  const deeds = deedsRows[0] || null;

  const { rows: images } = await pool.query(
    'SELECT image_url, source, image_type, vision_analysis FROM property_images WHERE property_id = $1 ORDER BY source, id',
    [report.property_id]
  );
  const { rows: areaRisks } = await pool.query(
    "SELECT risk_type, risk_level, risk_score, source_name, source_url FROM area_risk_data WHERE (suburb ILIKE $1 OR suburb = 'ALL') AND city ILIKE $2",
    [property.suburb || '', property.city || '']
  );

  const html = buildHTML(report, property, deeds, images, areaRisks);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '25mm', left: '15mm', right: '15mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#888;padding:5px 0">
      surepath.co.za | Confidential property report
      <span style="float:right;margin-right:15mm">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`,
  });
  await browser.close();

  return pdfBuffer;
}

// ─── Data-driven PDF (no AI synthesis) ────────────────────────────────

/**
 * Build HTML report directly from collected data — no AI synthesis needed.
 * Shows all property data, vision findings, deeds, crime, risk with sources.
 */
function buildDataHTML(property, images, deeds, areaRisks, crimeData) {
  const p = property;
  images = images || [];
  areaRisks = areaRisks || [];
  const d = deeds;
  const today = formatDate(new Date());

  // Separate image types
  const streetview = images.find(i => i.source === 'streetview');
  const satellite = images.find(i => i.source === 'satellite');
  const listingPhotos = images.filter(i => i.source !== 'streetview' && i.source !== 'satellite' && i.image_url && i.image_url.startsWith('http'));

  // Build deduplicated findings from per-image vision analysis
  const findings = [];
  const seenObs = new Set();
  for (const img of images) {
    const va = typeof img.vision_analysis === 'string' ? JSON.parse(img.vision_analysis) : img.vision_analysis;
    if (!va?.findings) continue;
    const photoUrl = img.image_url?.startsWith('http') ? img.image_url : null;
    for (const fi of va.findings) {
      if (!fi.observation) continue;
      const key = fi.observation.toLowerCase();
      if (seenObs.has(key)) continue;
      seenObs.add(key);
      findings.push({ ...fi, source_photo: photoUrl, photo_type: va.photo_type || fi.category || 'other' });
    }
  }

  // Sort by severity
  const sevOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'COSMETIC'];
  findings.sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));

  // Group by category
  const findingsByCategory = {};
  for (const f of findings) {
    const cat = f.category || f.photo_type || 'other';
    if (!findingsByCategory[cat]) findingsByCategory[cat] = [];
    findingsByCategory[cat].push(f);
  }

  let findingsHTML = '';
  for (const [cat, items] of Object.entries(findingsByCategory)) {
    findingsHTML += `<h3 style="color:#0D1B2A;text-transform:capitalize;margin-top:16px">${cat}</h3>`;
    for (const f of items) {
      findingsHTML += `<div style="background:#F8F9FA;padding:10px 14px;border-left:3px solid #0D1B2A;margin-bottom:8px;border-radius:0 4px 4px 0">
        ${severityBadge(f.severity || 'LOW')}
        <span style="margin-left:8px">${f.observation}</span>
        ${f.estimated_repair_cost_zar && f.estimated_repair_cost_zar.max > 0 ? `<br><small style="color:#666">Estimated repair: ${formatZAR(f.estimated_repair_cost_zar.min)} – ${formatZAR(f.estimated_repair_cost_zar.max)}</small>` : ''}
        ${f.confidence ? `<br><small style="color:#888">Confidence: ${f.confidence}</small>` : ''}
        ${f.source_photo ? `<br><small><a href="${f.source_photo}" style="color:#2563EB">View source photo</a></small>` : ''}
      </div>`;
    }
  }

  // Red flags (CRITICAL + HIGH findings, plus environmental)
  const redFlags = [];
  for (const f of findings) {
    if (f.severity === 'CRITICAL' || f.severity === 'HIGH') {
      redFlags.push({ issue: f.observation, severity: f.severity, source: 'Claude Vision' });
    }
  }
  if (p.dolomite_risk === 'CRITICAL' || p.dolomite_risk === 'HIGH') {
    redFlags.push({ issue: `Dolomite/sinkhole risk: ${p.dolomite_risk}`, severity: p.dolomite_risk, source: 'Council for Geoscience' });
  }
  if (p.flood_zone) {
    redFlags.push({ issue: `Flood zone: ${p.flood_zone_type || 'yes'}`, severity: 'HIGH', source: 'Municipal GIS' });
  }
  if (p.sewerage_quality_score != null && p.sewerage_quality_score <= 4) {
    redFlags.push({ issue: `Poor sewerage quality: ${p.sewerage_quality_score}/10`, severity: 'HIGH', source: 'DWS Green Drop' });
  }

  // Repair cost totals from vision findings
  let totalRepairMin = 0, totalRepairMax = 0;
  const repairItems = [];
  for (const f of findings) {
    const cost = f.estimated_repair_cost_zar || {};
    if (cost.max > 0) {
      totalRepairMin += cost.min || 0;
      totalRepairMax += cost.max || 0;
      repairItems.push(f);
    }
  }

  // Transfer history
  let transferRows = '';
  const transfers = d?.transfer_history || [];
  if (Array.isArray(transfers)) {
    for (const t of transfers) {
      transferRows += `<tr>
        <td>${t.date || 'N/A'}</td>
        <td>${formatZAR(t.price)}</td>
        <td>${t.buyer || 'N/A'}</td>
        <td>${t.seller || 'N/A'}</td>
        <td>${formatZAR(t.bond)}</td>
      </tr>`;
    }
  }

  // CrimeHub detailed data
  const crimeDetailed = areaRisks.find(r => r.risk_type === 'crime_detailed');
  const cd = crimeDetailed?.details ? (typeof crimeDetailed.details === 'string' ? JSON.parse(crimeDetailed.details) : crimeDetailed.details) : null;

  // Satellite analysis
  const satVA = satellite ? (typeof satellite.vision_analysis === 'string' ? JSON.parse(satellite.vision_analysis) : satellite.vision_analysis) : null;

  // Streetview analysis
  const svVA = streetview ? (typeof streetview.vision_analysis === 'string' ? JSON.parse(streetview.vision_analysis) : streetview.vision_analysis) : null;

  // Negotiation leverage points from data
  const negPoints = [];
  if (totalRepairMax > 0) negPoints.push(`Estimated repairs: ${formatZAR(totalRepairMin)}–${formatZAR(totalRepairMax)}`);
  if (p.listing_date) {
    const days = Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000);
    if (days > 30) negPoints.push(`On market for ${days} days`);
  }
  if (p.electrical_coc_required) negPoints.push('Electrical CoC required (seller: R1,500–R5,000)');
  if (p.plumbing_coc_required) negPoints.push('Plumbing CoC required (seller: R1,000–R3,000)');
  if (p.beetle_cert_required) negPoints.push('Beetle certificate required (seller: R3,000–R15,000 if treatment)');
  if (p.levies > 3000) negPoints.push(`High levies: ${formatZAR(p.levies)}/month`);

  // Local image helper
  const fs = require('fs');
  const path = require('path');
  function localImgSrc(imgUrl) {
    if (!imgUrl) return null;
    if (imgUrl.startsWith('http')) return imgUrl;
    if (imgUrl.startsWith('/property-images/')) {
      const filePath = path.resolve(process.cwd(), 'dashboard', 'public', imgUrl.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        const ext = filePath.endsWith('.png') ? 'png' : 'jpeg';
        return `data:image/${ext};base64,${fs.readFileSync(filePath).toString('base64')}`;
      }
    }
    // Base64 data URI stored truncated — try loading from file system
    if (imgUrl.startsWith('data:image/')) return null; // truncated base64
    return null;
  }

  const svSrc = streetview ? localImgSrc(streetview.image_url) : null;
  const satSrc = satellite ? localImgSrc(satellite.image_url) : null;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 20mm 15mm 25mm 15mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #222; line-height: 1.5; }
  .page-break { page-break-after: always; }
  h1 { color: #0D1B2A; }
  h2 { color: #0D1B2A; border-bottom: 2px solid #E63946; padding-bottom: 6px; margin: 24px 0 12px 0; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th { background: #0D1B2A; color: #FFF; padding: 8px 10px; text-align: left; font-size: 12px; }
  td { padding: 6px 10px; border-bottom: 1px solid #E0E0E0; font-size: 12px; }
  tr:nth-child(even) { background: #F8F9FA; }
  .cover { display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 90vh; text-align: center; }
  .cover h1 { font-size: 48px; letter-spacing: 8px; color: #0D1B2A; margin-bottom: 40px; }
  .cover .address { font-size: 22px; color: #333; margin-bottom: 12px; }
  .cover .meta { font-size: 14px; color: #666; margin-bottom: 6px; }
  .cover .accent-line { width: 80px; height: 4px; background: #E63946; margin: 20px auto; }
  .rf { background: #FEF2F2; border-left: 3px solid #E63946; padding: 8px 12px; margin-bottom: 6px; border-radius: 0 4px 4px 0; }
  .np { background: #FFFBEB; border-left: 3px solid #F1C40F; padding: 6px 12px; margin-bottom: 4px; border-radius: 0 4px 4px 0; }
  .score-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin: 16px 0; }
  .score-card { background: #F8F9FA; border-radius: 8px; padding: 16px; text-align: center; }
  .score-card .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
  .photos-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }
  .photos-grid img { width: 100%; height: 180px; object-fit: cover; border-radius: 4px; }
  .sv-sat { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 10px 0; }
  .sv-sat img { width: 100%; height: 200px; object-fit: cover; border-radius: 6px; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <h1>SUREPATH</h1>
  <div class="accent-line"></div>
  <div class="address">${p.street_address || p.address_normalised || p.address_raw}</div>
  <div class="meta">${p.suburb || ''}, ${p.city || ''}, ${p.province || ''}</div>
  <div class="meta">${p.bedrooms || '—'} bed | ${p.bathrooms || '—'} bath | ${p.floor_area_sqm ? p.floor_area_sqm + ' m²' : '—'} | ${p.property_type || ''}</div>
  ${p.asking_price ? `<div class="meta" style="font-size:18px;font-weight:bold;margin-top:10px">${formatZAR(p.asking_price)}</div>` : ''}
  <div class="meta" style="margin-top:20px">Report generated: ${today}</div>
  ${p.listing_url ? `<div class="meta" style="font-size:10px;color:#999;margin-top:5px">Source: ${p.listing_url}</div>` : ''}
  <div class="meta" style="margin-top:30px;color:#999">Property Intelligence Report</div>
</div>
<div class="page-break"></div>

<!-- RED FLAGS -->
${redFlags.length > 0 ? `
<h2 style="color:#E63946">Red Flags (${redFlags.length})</h2>
${redFlags.map(rf => `<div class="rf">${severityBadge(rf.severity)} <span style="margin-left:8px">${rf.issue}</span> <span style="float:right;font-size:10px;color:#999">${rf.source}</span></div>`).join('')}
` : ''}

<!-- PROPERTY IMAGERY -->
${(svSrc || satSrc) ? `
<h2>Property Imagery</h2>
<div class="sv-sat">
  ${svSrc ? `<div><img src="${svSrc}" /><div style="font-size:9px;color:#888;text-align:center;margin-top:4px">Street View — Google Maps</div></div>` : ''}
  ${satSrc ? `<div><img src="${satSrc}" /><div style="font-size:9px;color:#888;text-align:center;margin-top:4px">Satellite — Google Maps</div></div>` : ''}
</div>
` : ''}

<!-- STREET VIEW ANALYSIS -->
${svVA?.findings?.length > 0 ? `
<h3 style="color:#0D1B2A;margin-top:12px">Street View Analysis</h3>
${svVA.findings.map(f => `<div style="background:#F8F9FA;padding:8px 12px;margin-bottom:4px;border-radius:4px">${severityBadge(f.severity || 'LOW')} <span style="margin-left:8px">${f.observation}</span></div>`).join('')}
` : ''}

<!-- SATELLITE ANALYSIS -->
${satVA ? `
<h3 style="color:#0D1B2A;margin-top:12px">Satellite Analysis</h3>
<table>
  ${satVA.roof_material && satVA.roof_material !== 'unknown' ? `<tr><td><strong>Roof Material</strong></td><td>${satVA.roof_material}</td></tr>` : ''}
  ${satVA.roof_orientation_estimate && satVA.roof_orientation_estimate !== 'unclear' ? `<tr><td><strong>Roof Orientation</strong></td><td>${satVA.roof_orientation_estimate}</td></tr>` : ''}
  <tr><td><strong>Solar Panels</strong></td><td>${satVA.solar_installed ? 'Visible' : 'None visible'}</td></tr>
  <tr><td><strong>Asbestos Indicators</strong></td><td>${satVA.asbestos_indicators ? 'Present — further inspection recommended' : 'None detected'}</td></tr>
</table>
` : ''}
<div class="page-break"></div>

<!-- PROPERTY DETAILS -->
<h2>Property Details</h2>
<table>
  <tr><td><strong>Address</strong></td><td>${p.street_address || p.address_normalised || p.address_raw}</td></tr>
  <tr><td><strong>Suburb</strong></td><td>${p.suburb || 'N/A'}, ${p.city || ''}</td></tr>
  ${p.bedrooms ? `<tr><td><strong>Bedrooms</strong></td><td>${p.bedrooms}</td></tr>` : ''}
  ${p.bathrooms ? `<tr><td><strong>Bathrooms</strong></td><td>${p.bathrooms}</td></tr>` : ''}
  ${p.floor_area_sqm ? `<tr><td><strong>Floor Area</strong></td><td>${p.floor_area_sqm} m²</td></tr>` : ''}
  ${p.stand_size_sqm ? `<tr><td><strong>Stand Size</strong></td><td>${p.stand_size_sqm} m²</td></tr>` : ''}
  ${p.property_type ? `<tr><td><strong>Property Type</strong></td><td>${p.property_type}</td></tr>` : ''}
  ${p.construction_era ? `<tr><td><strong>Construction Era</strong></td><td>${p.construction_era}</td></tr>` : ''}
  ${p.parking_spaces ? `<tr><td><strong>Parking</strong></td><td>${p.parking_spaces}</td></tr>` : ''}
  ${p.levies ? `<tr><td><strong>Monthly Levies</strong></td><td>${formatZAR(p.levies)}</td></tr>` : ''}
  ${p.rates_and_taxes ? `<tr><td><strong>Rates &amp; Taxes</strong></td><td>${formatZAR(p.rates_and_taxes)}</td></tr>` : ''}
  ${p.roof_material ? `<tr><td><strong>Roof Material</strong></td><td>${p.roof_material}</td></tr>` : ''}
  ${p.roof_orientation ? `<tr><td><strong>Roof Orientation</strong></td><td>${p.roof_orientation}</td></tr>` : ''}
  ${p.agent_name ? `<tr><td><strong>Agent</strong></td><td>${p.agent_name}${p.agency_name ? ' — ' + p.agency_name : ''}</td></tr>` : ''}
</table>

${p.selling_points && p.selling_points.length > 0 ? `
<h3 style="margin-top:16px;color:#0D1B2A">Key Selling Points</h3>
<ul style="margin-left:20px">${p.selling_points.map(s => `<li>${s}</li>`).join('')}</ul>
` : ''}

<!-- FEATURES -->
${(p.has_pool || p.has_garden || p.has_braai || p.has_alarm || p.building_name) ? `
<h3 style="margin-top:16px;color:#0D1B2A">Features</h3>
<div>
${[
  p.building_name && `<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px"><strong>${p.building_name}</strong></span>`,
  p.views && `<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Views: ${p.views}</span>`,
  p.flooring && `<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Flooring: ${p.flooring}</span>`,
  p.has_pool && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Pool</span>',
  p.has_garden && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Garden</span>',
  p.has_braai && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Braai</span>',
  p.has_aircon && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Aircon</span>',
  p.has_alarm && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Alarm</span>',
  p.has_electric_fence && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Electric Fence</span>',
  p.has_cctv && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">CCTV</span>',
  p.has_solar_geyser && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Solar Geyser</span>',
  p.has_fibre && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Fibre</span>',
  p.has_generator && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Generator</span>',
  p.has_borehole && '<span style="display:inline-block;background:#F0F0F0;padding:3px 10px;border-radius:12px;margin:2px;font-size:11px">Borehole</span>',
].filter(Boolean).join('')}
</div>
` : ''}

<!-- OWNERSHIP & DEEDS -->
${d ? `
<h2>Ownership &amp; Deeds</h2>
<table>
  <tr><td><strong>Registered Owner</strong></td><td>${d.registered_owner || 'N/A'}</td></tr>
  <tr><td><strong>Title Deed</strong></td><td>${d.title_deed_ref || 'N/A'}</td></tr>
  <tr><td><strong>Municipal Value</strong></td><td>${formatZAR(d.municipal_value)}</td></tr>
  ${d.municipal_value && p.asking_price ? `<tr><td><strong>Price vs Municipal Value</strong></td><td>${
    p.asking_price > d.municipal_value * 1.3
      ? `${Math.round(((p.asking_price / d.municipal_value) - 1) * 100)}% above — significant premium`
      : p.asking_price > d.municipal_value
      ? `${Math.round(((p.asking_price / d.municipal_value) - 1) * 100)}% above — slight premium`
      : 'At or below — potentially good value'
  }</td></tr>` : ''}
</table>
${transferRows ? `
<h3 style="margin-top:16px;color:#0D1B2A">Transfer History</h3>
<table>
  <thead><tr><th>Date</th><th>Price</th><th>Buyer</th><th>Seller</th><th>Bond</th></tr></thead>
  <tbody>${transferRows}</tbody>
</table>` : ''}
` : ''}
<div class="page-break"></div>

<!-- VISUAL INSPECTION FINDINGS -->
<h2>Visual Inspection (${findings.length} findings)</h2>
${findingsHTML || '<p style="color:#888">No visual findings recorded. Run vision analysis to populate.</p>'}

<!-- ESTIMATED REPAIRS -->
${repairItems.length > 0 ? `
<h2>Estimated Repairs</h2>
<table>
  <thead><tr><th>Category</th><th>Issue</th><th>Min Cost</th><th>Max Cost</th></tr></thead>
  <tbody>
    ${repairItems.map(f => `<tr><td style="text-transform:capitalize">${f.category || 'other'}</td><td>${f.observation}</td><td>${formatZAR(f.estimated_repair_cost_zar.min)}</td><td>${formatZAR(f.estimated_repair_cost_zar.max)}</td></tr>`).join('')}
  </tbody>
</table>
<p style="margin-top:10px"><strong>Total Estimated Range:</strong> ${formatZAR(totalRepairMin)} – ${formatZAR(totalRepairMax)}</p>
` : ''}
<div class="page-break"></div>

<!-- CRIME -->
${cd ? `
<h2>Crime Statistics — ${cd.station_name || p.suburb}</h2>
<table>
  <tr><td><strong>Police Station</strong></td><td>${cd.station_name}</td></tr>
  <tr><td><strong>Latest Year</strong></td><td>${cd.latest_year} (April ${parseInt(cd.latest_year) - 1} – March ${cd.latest_year})</td></tr>
  <tr><td><strong>Total Incidents</strong></td><td style="font-weight:bold">${cd.total_latest?.toLocaleString()}</td></tr>
  ${cd.rate_per_100k ? `<tr><td><strong>Rate per 100,000</strong></td><td>${Math.round(cd.rate_per_100k).toLocaleString()}</td></tr>` : ''}
  ${cd.trend_5yr ? `<tr><td><strong>5-Year Trend</strong></td><td style="font-weight:bold;color:${cd.trend_5yr[cd.trend_5yr.length - 1] < cd.trend_5yr[0] ? '#27AE60' : '#E63946'}">${cd.trend_5yr[cd.trend_5yr.length - 1] < cd.trend_5yr[0] ? 'Improving' : 'Worsening'} (${cd.trend_5yr.join(' → ')})</td></tr>` : ''}
</table>
${cd.categories?.length > 0 ? `
<h3 style="margin-top:12px;color:#0D1B2A">Breakdown by Category</h3>
<table>
  <thead><tr><th>Category</th><th style="text-align:right">Incidents</th></tr></thead>
  <tbody>${cd.categories.sort((a, b) => b.count - a.count).map(c => `<tr><td style="text-transform:capitalize">${c.type}</td><td style="text-align:right;font-weight:bold">${c.count}</td></tr>`).join('')}</tbody>
</table>
<div style="font-size:10px;color:#888;margin-top:4px">Source: CrimeHub — SAPS official statistics</div>
` : ''}
` : `${crimeData?.incidents?.length > 0 ? `
<h2>Crime — ${p.suburb || p.city}</h2>
<table>
  <thead><tr><th>Incident Type</th><th style="text-align:right">Count</th></tr></thead>
  <tbody>${crimeData.incidents.map(c => `<tr><td style="text-transform:capitalize">${(c.incident_type || c.type || '').replace(/_/g, ' ')}</td><td style="text-align:right;font-weight:bold">${c.cnt || c.count}</td></tr>`).join('')}</tbody>
</table>
<div style="font-size:10px;color:#888;margin-top:4px">Source: SAPS Annual Statistics</div>
` : ''}`}

<!-- INFRASTRUCTURE & RISK -->
${(p.water_quality_score != null || p.dolomite_risk || p.flood_zone || p.solar_ghi_kwh_year) ? `
<h2>Infrastructure &amp; Environmental Risk</h2>
<table>
  ${p.water_quality_score != null ? `<tr><td><strong>Water Quality</strong></td><td>${p.water_quality_score}/10 ${p.water_quality_score >= 8 ? '— Good' : p.water_quality_score >= 5 ? '— Moderate' : '— Poor'}</td></tr>` : ''}
  ${p.sewerage_quality_score != null ? `<tr><td><strong>Sewerage Quality</strong></td><td>${p.sewerage_quality_score}/10 ${p.sewerage_quality_score <= 4 ? '— POOR: risk of backflows and contamination' : ''}</td></tr>` : ''}
  ${p.dolomite_risk ? `<tr><td><strong>Dolomite/Sinkhole</strong></td><td>${p.dolomite_risk}</td></tr>` : ''}
  ${p.mining_subsidence_risk ? `<tr><td><strong>Mining Subsidence</strong></td><td>${p.mining_subsidence_risk}</td></tr>` : ''}
  ${p.flood_zone ? `<tr><td><strong>Flood Zone</strong></td><td>Yes — ${p.flood_zone_type || 'check municipal records'}</td></tr>` : ''}
  ${p.heritage_site ? `<tr><td><strong>Heritage Area</strong></td><td>Yes — renovation restrictions apply</td></tr>` : ''}
  ${p.solar_ghi_kwh_year ? `<tr><td><strong>Solar Irradiance (GHI)</strong></td><td>${Number(p.solar_ghi_kwh_year).toFixed(0)} kWh/m²/year</td></tr>` : ''}
  ${p.solar_pv_output_kwh_year ? `<tr><td><strong>PV Output (1kWp)</strong></td><td>${Number(p.solar_pv_output_kwh_year).toFixed(0)} kWh/year</td></tr>` : ''}
</table>
` : ''}

<!-- COMPLIANCE CERTIFICATES -->
${p.electrical_coc_required ? `
<h2>Compliance Certificates Required</h2>
<p style="font-size:11px;color:#666;margin-bottom:10px">Required by law for property transfer — seller's responsibility</p>
<table>
  ${p.electrical_coc_required ? '<tr><td><strong>Electrical CoC</strong></td><td>Required (OHS Act) — R1,500–R5,000</td></tr>' : ''}
  ${p.plumbing_coc_required ? '<tr><td><strong>Plumbing CoC</strong></td><td>Required (Municipal by-laws) — R1,000–R3,000</td></tr>' : ''}
  ${p.beetle_cert_required ? '<tr><td><strong>Beetle Certificate</strong></td><td>Required (WC/KZN) — R3,000–R15,000 if treatment needed</td></tr>' : ''}
  ${p.electric_fence_coc_required ? '<tr><td><strong>Electric Fence CoC</strong></td><td>Required — R500–R1,500</td></tr>' : ''}
</table>
` : ''}

<!-- NEGOTIATION LEVERAGE -->
${negPoints.length > 0 ? `
<h2>Negotiation Leverage</h2>
${negPoints.map(n => `<div class="np">${n}</div>`).join('')}
` : ''}

<!-- LISTING PHOTOS -->
${listingPhotos.length > 0 ? `
<div class="page-break"></div>
<h2>Listing Photos (${listingPhotos.length})</h2>
<div class="photos-grid">
${listingPhotos.slice(0, 12).map(img => `
  <div>
    <img src="${img.image_url}" />
    <div style="font-size:9px;color:#888;margin-top:2px">${img.source} — ${img.image_type || 'listing'}</div>
  </div>
`).join('')}
</div>
` : ''}

<!-- DATA SOURCES -->
<div class="page-break"></div>
<h2>Data Sources &amp; References</h2>
<p style="font-size:11px;color:#666;margin-bottom:10px">Every data point in this report is traceable to its source</p>
<table>
  <thead><tr><th>Data</th><th>Source</th><th>Confidence</th></tr></thead>
  <tbody>
    ${p.listing_url ? `<tr><td>Listing data</td><td>${p.listing_url.includes('privateproperty') ? 'PrivateProperty.co.za' : 'Property24.com'}</td><td>Scraped</td></tr>` : ''}
    ${p.lat ? '<tr><td>Coordinates</td><td>Google Maps Geocoding API</td><td>Verified</td></tr>' : ''}
    ${svSrc ? '<tr><td>Street View</td><td>Google Street View Static API</td><td>Verified</td></tr>' : ''}
    ${satSrc ? '<tr><td>Satellite</td><td>Google Maps Static API</td><td>Verified</td></tr>' : ''}
    ${findings.length > 0 ? `<tr><td>Visual findings (${findings.length})</td><td>Claude Vision (Anthropic)</td><td>AI Estimated</td></tr>` : ''}
    ${d ? '<tr><td>Ownership &amp; deeds</td><td>Windeed (Deeds Office)</td><td>Verified</td></tr>' : ''}
    ${p.water_quality_score != null ? '<tr><td>Water quality</td><td>DWS Blue Drop Report</td><td>Verified</td></tr>' : ''}
    ${p.dolomite_risk ? '<tr><td>Geological risk</td><td>Council for Geoscience</td><td>Verified</td></tr>' : ''}
    ${cd ? '<tr><td>Crime statistics</td><td>CrimeHub — SAPS official data</td><td>Verified</td></tr>' : ''}
    ${p.solar_ghi_kwh_year ? '<tr><td>Solar irradiance</td><td>Global Solar Atlas / PVGIS</td><td>Verified</td></tr>' : ''}
    ${areaRisks.filter(ar => ar.risk_type !== 'crime_detailed').map(ar => `<tr><td>${ar.risk_type.replace(/_/g, ' ')}</td><td>${ar.source_name}</td><td>${ar.risk_level || 'N/A'}</td></tr>`).join('')}
  </tbody>
</table>

<div style="margin-top:40px;padding:20px;background:#F8F9FA;border-radius:8px;text-align:center">
  <p style="color:#888;font-size:11px;line-height:1.6">
    This report contains risk indicators based on visual analysis and public data.<br>
    It does not replace a professional building inspection or valuation.<br>
    All findings require on-site verification by qualified professionals.
  </p>
  <p style="color:#999;font-size:10px;margin-top:12px">surepath.co.za | Confidential property report</p>
</div>

</body>
</html>`;
}

/**
 * Render a data-driven PDF for a property — no AI synthesis required.
 * Fetches all collected data and renders directly.
 *
 * @param {number} propertyId
 * @param {number|null} askingPrice — optional override
 * @returns {{ reportId: number, pdfUrl: string }}
 */
async function renderPropertyPDF(propertyId, askingPrice) {
  console.log(`[pdf] Data-driven PDF for property ${propertyId}...`);

  // Fetch all collected data
  const { rows: propRows } = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]);
  if (propRows.length === 0) throw new Error(`Property ${propertyId} not found`);
  const property = propRows[0];

  if (askingPrice) property.asking_price = askingPrice;

  const { rows: images } = await pool.query(
    'SELECT image_url, source, image_type, vision_analysis FROM property_images WHERE property_id = $1 ORDER BY source, id',
    [propertyId]
  );

  const { rows: deedsRows } = await pool.query(
    'SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1',
    [propertyId]
  );
  const deeds = deedsRows[0] || null;

  const { rows: areaRisks } = await pool.query(
    "SELECT risk_type, risk_level, risk_score, details, source_name, source_url FROM area_risk_data WHERE (suburb ILIKE $1 OR suburb = 'ALL') AND city ILIKE $2",
    [property.suburb || '', property.city || '']
  );

  // Crime data
  let crimeData = null;
  if (property.suburb) {
    const { rows: incidents } = await pool.query(
      "SELECT incident_type, COUNT(*) AS cnt FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2 GROUP BY incident_type ORDER BY cnt DESC",
      [property.suburb, property.city]
    );
    if (incidents.length > 0) crimeData = { incidents };
  }

  // Create a minimal report record
  const { rows: reportRows } = await pool.query(
    `INSERT INTO property_reports (property_id, asking_price, decision, decision_reasoning, status)
     VALUES ($1, $2, 'INSPECT_FIRST', 'Data-driven report — review findings and make your own assessment', 'complete')
     RETURNING id`,
    [propertyId, askingPrice || property.asking_price || 0]
  );
  const reportId = reportRows[0].id;

  // Build HTML and render PDF
  const html = buildDataHTML(property, images, deeds, areaRisks, crimeData);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '20mm', bottom: '25mm', left: '15mm', right: '15mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;text-align:center;font-size:9px;color:#888;padding:5px 0">
      surepath.co.za | Property Intelligence Report
      <span style="float:right;margin-right:15mm">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>`,
  });

  await browser.close();
  console.log(`[pdf] Data PDF rendered: ${pdfBuffer.length} bytes`);

  // Upload to S3
  const s3Key = `reports/${property.erf_number || propertyId}/${reportId}-${Date.now()}.pdf`;
  console.log(`[pdf] Uploading to S3: ${s3Key}...`);

  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    }));

    const pdfUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'af-south-1'}.amazonaws.com/${s3Key}`;
    await pool.query('UPDATE property_reports SET pdf_url = $1 WHERE id = $2', [pdfUrl, reportId]);
    console.log(`[pdf] PDF uploaded: ${pdfUrl}`);
    return { reportId, pdfUrl };
  } catch (err) {
    // S3 failed — save locally
    console.error(`[pdf] S3 upload failed: ${err.message}`);
    const fs = require('fs');
    const path = require('path');
    const localDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    const filename = `${reportId}-${property.erf_number || propertyId}.pdf`;
    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, pdfBuffer);

    const publicUrl = `/reports/${filename}`;
    await pool.query('UPDATE property_reports SET pdf_url = $1 WHERE id = $2', [publicUrl, reportId]);
    console.log(`[pdf] Saved locally: ${localPath} → ${publicUrl}`);
    return { reportId, pdfUrl: publicUrl };
  }
}

// ─── Export inspect page as PDF ───────────────────────────────────────

/**
 * Render the inspect page for a property as a PDF using Puppeteer.
 * This exports the exact same page the user sees in the browser — no AI generation.
 *
 * @param {number} propertyId
 * @param {number|null} askingPrice
 * @param {{ source?: string, phoneNumber?: string }} options
 * @returns {{ reportId: number, pdfUrl: string }}
 */
async function exportInspectPagePDF(propertyId, askingPrice, options = {}) {
  const exportSource = options.source || 'api';
  const exportPhone = options.phoneNumber || null;
  console.log(`[pdf] Exporting inspect page for property ${propertyId}...`);

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'surepath-dev-secret';
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';

  // Generate auth token for Puppeteer to access the page
  const token = jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: '5m' });

  // Dashboard URL — default to localhost:3001 (Next.js dev port)
  const dashboardPort = process.env.DASHBOARD_PORT || '3001';
  const dashboardUrl = `http://localhost:${dashboardPort}/admin/data/inspect/${propertyId}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  // Set auth cookie
  await page.setCookie({
    name: 'token',
    value: token,
    domain: 'localhost',
    path: '/',
  });

  // Navigate to the inspect page
  console.log(`[pdf] Loading ${dashboardUrl}...`);
  await page.goto(dashboardUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for data to load (the page fetches from /api/inspect/[id])
  await page.waitForSelector('section', { timeout: 15000 }).catch(() => {});
  // Extra wait for images to render
  await new Promise(r => setTimeout(r, 2000));

  // Generate PDF with print media (triggers @media print styles which add cover page and hide sidebar)
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
  });

  await browser.close();
  console.log(`[pdf] Inspect page PDF rendered: ${pdfBuffer.length} bytes`);

  // Increment export count and log the export
  await pool.query('UPDATE properties SET pdf_export_count = COALESCE(pdf_export_count, 0) + 1 WHERE id = $1', [propertyId]);
  await pool.query(
    'INSERT INTO pdf_exports (property_id, source, phone_number, file_size_bytes) VALUES ($1, $2, $3, $4)',
    [propertyId, exportSource, exportPhone, pdfBuffer.length]
  ).catch(err => console.error(`[pdf] Export log error: ${err.message}`));

  // Create report record
  const { rows: propRows } = await pool.query('SELECT erf_number, asking_price FROM properties WHERE id = $1', [propertyId]);
  const erfNumber = propRows[0]?.erf_number || propertyId;

  const { rows: reportRows } = await pool.query(
    `INSERT INTO property_reports (property_id, asking_price, decision, decision_reasoning, status)
     VALUES ($1, $2, 'INSPECT_FIRST', 'Data-driven report — exported from property page', 'complete')
     RETURNING id`,
    [propertyId, askingPrice || propRows[0]?.asking_price || 0]
  );
  const reportId = reportRows[0].id;

  // Save PDF — try S3, fallback to local
  const s3Key = `reports/${erfNumber}/${reportId}-${Date.now()}.pdf`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    }));
    const pdfUrl = `https://${S3_BUCKET}.s3.${process.env.AWS_REGION || 'af-south-1'}.amazonaws.com/${s3Key}`;
    await pool.query('UPDATE property_reports SET pdf_url = $1 WHERE id = $2', [pdfUrl, reportId]);
    console.log(`[pdf] PDF uploaded: ${pdfUrl}`);
    return { reportId, pdfUrl };
  } catch (err) {
    console.error(`[pdf] S3 upload failed: ${err.message}`);
    const fs = require('fs');
    const path = require('path');
    const localDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    const filename = `${reportId}-${erfNumber}.pdf`;
    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, pdfBuffer);
    const publicUrl = `/reports/${filename}`;
    await pool.query('UPDATE property_reports SET pdf_url = $1 WHERE id = $2', [publicUrl, reportId]);
    console.log(`[pdf] Saved locally: ${localPath} → ${publicUrl}`);
    return { reportId, pdfUrl: publicUrl };
  }
}

module.exports = { renderReport, renderReportBuffer, renderPropertyPDF, exportInspectPagePDF, buildHTML, buildDataHTML };
