import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

function f(n: number | null | undefined) { return n != null ? `R${Number(n).toLocaleString()}` : "N/A"; }
function fZAR(n: number | null | undefined) { return f(n); }
function fd(d: string | Date | null | undefined) { if (!d) return ""; return new Date(d).toLocaleDateString("en-ZA", { year: "numeric", month: "short", day: "numeric" }); }
function sev(s: string) {
  const c: A = { CRITICAL: "#E63946", HIGH: "#E67E22", MEDIUM: "#F1C40F", LOW: "#27AE60", COSMETIC: "#BDC3C7" };
  const t = s === "MEDIUM" || s === "LOW" || s === "COSMETIC" ? "#000" : "#FFF";
  return `<span style="background:${c[s] || "#999"};color:${t};padding:2px 6px;border-radius:3px;font-size:9px;font-weight:bold;white-space:nowrap">${s}</span>`;
}
function bar(val: number, label: string) {
  const col = val >= 7 ? "#E63946" : val >= 4 ? "#F1C40F" : "#27AE60";
  return `<div style="text-align:center"><div style="font-size:28px;font-weight:bold">${val}<span style="font-size:12px;color:#888">/10</span></div><div style="width:100%;height:6px;background:#E0E0E0;border-radius:3px;margin:4px 0"><div style="width:${val*10}%;height:6px;background:${col};border-radius:3px"></div></div><div style="font-size:9px;color:#888">${label}</div></div>`;
}

// Convert a local image file to a base64 data URI for embedding in HTML
function localImgToDataUri(imgUrl: string): string | null {
  if (imgUrl.startsWith("http")) return imgUrl;
  if (imgUrl.startsWith("/property-images/")) {
    const filePath = path.resolve(process.cwd(), "public", imgUrl.replace(/^\//, ""));
    if (fs.existsSync(filePath)) {
      const ext = filePath.endsWith(".png") ? "png" : "jpeg";
      return `data:image/${ext};base64,${fs.readFileSync(filePath).toString("base64")}`;
    }
  }
  return null;
}

export const POST = withAuth(async (req: NextRequest) => {
  const { property_id } = await req.json();

  const props = await query("SELECT * FROM properties WHERE id = $1", [property_id]);
  if (!props.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = props[0] as A;

  const reports = await query("SELECT * FROM property_reports WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1", [property_id]);
  const r = (reports[0] || {}) as A;

  const allImages = await query("SELECT image_url, source, image_type, vision_analysis FROM property_images WHERE property_id = $1 ORDER BY source, id", [property_id]) as A[];
  const deeds = await query("SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1", [property_id]);
  const d = (deeds[0] || null) as A | null;

  const crimeData = p.suburb ? await query("SELECT incident_type, COUNT(*) AS cnt FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2 GROUP BY incident_type ORDER BY cnt DESC", [p.suburb, p.city]) as A[] : [];

  // Photos — separate by type
  const streetview = allImages.find((i: A) => i.source === "streetview");
  const satellite = allImages.find((i: A) => i.source === "satellite");
  const listingPhotos = allImages.filter((i: A) => i.source !== "streetview" && i.source !== "satellite" && i.image_url.startsWith("http"));

  // Build findings from per-image data — link each finding to its source photo
  const findings: A[] = [];
  const seenObs = new Set<string>();
  for (const img of allImages) {
    if (!img.vision_analysis?.findings) continue;
    const photoUrl = img.image_url?.startsWith("http") ? img.image_url : null;
    for (const fi of img.vision_analysis.findings) {
      if (!fi.observation) continue;
      const key = fi.observation.toLowerCase();
      if (seenObs.has(key)) continue;
      seenObs.add(key);
      findings.push({ ...fi, source_photo: photoUrl });
    }
  }
  // Fall back to report findings if no per-image data
  if (findings.length === 0) {
    for (const fi of (r.vision_findings || [])) {
      if (fi.observation && fi.severity) findings.push(fi);
      else if (Array.isArray(fi.findings)) for (const inner of fi.findings) if (inner.observation) findings.push(inner);
    }
  }
  const sortedFindings = [...findings].sort((a, b) => ["CRITICAL","HIGH","MEDIUM","LOW","COSMETIC"].indexOf(a.severity) - ["CRITICAL","HIGH","MEDIUM","LOW","COSMETIC"].indexOf(b.severity));

  // Red flags
  const redFlags: A[] = [];
  for (const fi of findings) { if (fi.severity === "CRITICAL" || fi.severity === "HIGH") redFlags.push({ issue: fi.observation, severity: fi.severity, source: "Claude Vision" }); }
  if (r.asbestos_risk === "CRITICAL" || r.asbestos_risk === "HIGH") redFlags.push({ issue: `Asbestos risk: ${r.asbestos_risk}`, severity: r.asbestos_risk, source: "Building age analysis" });
  if (p.dolomite_risk === "CRITICAL" || p.dolomite_risk === "HIGH") redFlags.push({ issue: `Dolomite/sinkhole: ${p.dolomite_risk}`, severity: p.dolomite_risk, source: "Council for Geoscience" });
  if (p.flood_zone) redFlags.push({ issue: `Flood zone: ${p.flood_zone_type}`, severity: "HIGH", source: "Municipal GIS" });
  // Crime — check if suburb has high crime relative to city
  if (crimeData.length === 0 && p.suburb) redFlags.push({ issue: `No SAPS crime data for ${p.suburb} — unable to assess`, severity: "MEDIUM", source: "SAPS" });

  // Negotiation
  const neg: string[] = [];
  if (r.repair_estimates?.total_max_zar > 0) neg.push(`Repairs: ${f(r.repair_estimates.total_min_zar)}–${f(r.repair_estimates.total_max_zar)}`);
  if (p.listing_date) { const days = Math.floor((Date.now() - new Date(p.listing_date).getTime()) / 86400000); if (days > 30) neg.push(`On market ${days} days`); }
  if (p.electrical_coc_required) neg.push("Electrical CoC required (seller: R1,500-R5,000)");
  if (p.plumbing_coc_required) neg.push("Plumbing CoC required (seller: R1,000-R3,000)");
  if (p.beetle_cert_required) neg.push("Beetle cert required (seller: R3,000-R15,000 if treatment)");
  if (p.levies > 3000) neg.push(`High levies: ${f(p.levies)}/month`);

  const today = fd(new Date());
  const dc = r.decision === "BUY" ? "#27AE60" : r.decision === "NEGOTIATE" ? "#F1C40F" : r.decision === "WALK_AWAY" ? "#E63946" : "#E67E22";

  // Build street view / satellite data URIs
  const svUri = streetview ? localImgToDataUri(streetview.image_url) : null;
  const satUri = satellite ? localImgToDataUri(satellite.image_url) : null;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#222;line-height:1.5}
  .pg{page-break-after:always;padding:10mm}
  .pg:last-child{page-break-after:auto}
  h1{color:#0D1B2A;font-size:13px;border-bottom:2px solid #E63946;padding-bottom:3px;margin:14px 0 6px}
  h2{color:#0D1B2A;font-size:11px;margin:10px 0 4px}
  table{width:100%;border-collapse:collapse;margin:4px 0}
  th{background:#0D1B2A;color:#FFF;padding:4px 6px;text-align:left;font-size:9px}
  td{padding:3px 6px;border-bottom:1px solid #E8E8E8;font-size:10px}
  .photos{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin:6px 0}
  .photos img{width:100%;height:120px;object-fit:cover;border-radius:3px}
  .sv-sat{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}
  .sv-sat img{width:100%;height:160px;object-fit:cover;border-radius:4px}
  .decision{background:#0D1B2A;color:#FFF;border-radius:8px;padding:20px;text-align:center;margin:10px 0}
  .scores{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:8px 0}
  .rf{background:#FEF2F2;border-left:3px solid #E63946;padding:5px 8px;margin-bottom:3px;border-radius:0 3px 3px 0;font-size:10px}
  .np{background:#FFFBEB;border-left:3px solid #F1C40F;padding:4px 8px;margin-bottom:3px;border-radius:0 3px 3px 0;font-size:10px}
  .fi{display:flex;gap:4px;align-items:flex-start;padding:4px 6px;margin-bottom:2px;background:#F8F9FA;border-radius:3px;font-size:10px}
  .feat{display:inline-block;background:#F0F0F0;padding:2px 8px;border-radius:10px;font-size:9px;margin:2px}
  .ft{text-align:center;font-size:8px;color:#888;margin-top:12px}
</style></head><body>

<!-- COVER -->
<div class="pg" style="text-align:center;padding-top:60px">
  <div style="font-size:36px;font-weight:bold;letter-spacing:6px;color:#0D1B2A">SUREPATH</div>
  <div style="width:60px;height:3px;background:#E63946;margin:12px auto"></div>
  <div style="font-size:16px;color:#333;margin:16px 0">${p.street_address || p.address_normalised || p.address_raw}</div>
  <div style="color:#666">${p.suburb || ""}, ${p.city || ""}, ${p.province || ""}</div>
  <div style="color:#666;margin-top:4px">${p.bedrooms || "—"} bed | ${p.bathrooms || "—"} bath | ${p.floor_area_sqm ? p.floor_area_sqm + " m²" : "—"} | ${p.property_type || ""}</div>
  ${p.asking_price ? `<div style="font-size:24px;font-weight:bold;margin-top:20px">${f(p.asking_price)}</div>` : ""}
  <div style="margin-top:30px;color:#999;font-size:10px">Report generated: ${today}</div>
  ${p.listing_url ? `<div style="font-size:7px;color:#BBB;margin-top:6px;word-break:break-all">Source: ${p.listing_url}</div>` : ""}
  <div style="margin-top:50px;color:#CCC;font-size:9px">Confidential Property Intelligence Report</div>
</div>

<!-- DECISION + PHOTOS -->
<div class="pg">
  <div class="decision">
    <div style="font-size:30px;font-weight:bold;letter-spacing:3px;color:${dc}">${r.decision || "PENDING"}</div>
    <div style="color:#CCC;margin-top:6px;font-size:11px;max-width:500px;margin-left:auto;margin-right:auto">${r.decision_reasoning || "Generate AI report for recommendation"}</div>
  </div>
  ${r.insurance_risk_score ? `<div class="scores">${bar(r.insurance_risk_score,"Insurance Risk")}${bar(r.solar_suitability_score || 0,"Solar Suitability")}${bar(r.crime_risk_score || 0,"Crime Risk")}</div>` : ""}

  ${(svUri || satUri) ? `<h1>Property Imagery</h1><div class="sv-sat">${svUri ? `<div><img src="${svUri}" /><div style="font-size:8px;color:#888;text-align:center">Street View — Google Maps</div></div>` : ""}${satUri ? `<div><img src="${satUri}" /><div style="font-size:8px;color:#888;text-align:center">Satellite — Google Maps</div></div>` : ""}</div>` : ""}

  ${listingPhotos.length > 0 ? `<h1>Listing Photos (${listingPhotos.length})</h1><div class="photos">${listingPhotos.slice(0, 12).map((img: A) => `<img src="${img.image_url}" />`).join("")}</div>` : ""}
</div>

<!-- DETAILS -->
<div class="pg">
  <h1>Property Details</h1>
  <table>
    ${[
      p.street_address && ["Address", p.street_address],
      ["Suburb", `${p.suburb || "—"}, ${p.city || ""}`],
      p.bedrooms && ["Bedrooms", p.bedrooms],
      p.bathrooms && ["Bathrooms", p.bathrooms],
      p.floor_area_sqm && ["Floor Area", p.floor_area_sqm + " m²"],
      p.stand_size_sqm && ["Stand", p.stand_size_sqm + " m²"],
      p.property_type && ["Type", p.property_type],
      p.construction_era && ["Era", p.construction_era],
      p.levies && ["Monthly Levies", f(p.levies)],
      p.rates_and_taxes && ["Rates & Taxes", f(p.rates_and_taxes)],
      p.parking_spaces && ["Parking", p.parking_spaces],
      p.roof_material && ["Roof Material", p.roof_material],
      p.roof_orientation && ["Roof Orientation", p.roof_orientation],
      p.agent_name && ["Agent", `${p.agent_name}${p.agency_name ? " — " + p.agency_name : ""}`],
      d?.registered_owner && ["Owner", d.registered_owner],
      d?.municipal_value && ["Municipal Value", f(d.municipal_value)],
    ].filter(Boolean).map(r => `<tr><td style="width:140px"><strong>${(r as string[])[0]}</strong></td><td>${(r as string[])[1]}</td></tr>`).join("")}
  </table>

  ${p.selling_points?.length > 0 ? `<h1>Key Selling Points</h1><ul style="margin-left:16px">${p.selling_points.map((s: string) => `<li>${s}</li>`).join("")}</ul>` : ""}
  ${Array.isArray(p.near_amenities) && p.near_amenities.length > 0 ? `<h2>Near Amenities</h2><div>${p.near_amenities.join(" · ")}</div>` : ""}

  ${(p.has_pool || p.has_garden || p.has_braai || p.has_alarm || p.building_name) ? `<h1>Features</h1><div>${[
    p.building_name && `<span class="feat"><strong>${p.building_name}</strong></span>`,
    p.views && `<span class="feat">Views: ${p.views}</span>`,
    p.flooring && `<span class="feat">Flooring: ${p.flooring}</span>`,
    p.has_pool && `<span class="feat">Pool</span>`, p.has_garden && `<span class="feat">Garden</span>`,
    p.has_braai && `<span class="feat">Braai</span>`, p.has_aircon && `<span class="feat">Aircon</span>`,
    p.has_alarm && `<span class="feat">Alarm</span>`, p.has_electric_fence && `<span class="feat">Electric Fence</span>`,
    p.has_cctv && `<span class="feat">CCTV</span>`, p.has_solar_geyser && `<span class="feat">Solar Geyser</span>`,
    p.has_fibre && `<span class="feat">Fibre</span>`, p.has_generator && `<span class="feat">Generator</span>`,
    p.has_borehole && `<span class="feat">Borehole</span>`, p.airbnb_friendly && `<span class="feat">Airbnb Friendly</span>`,
    p.security_details && `<span class="feat">Security: ${p.security_details}</span>`,
  ].filter(Boolean).join("")}</div>` : ""}

  <!-- STREET VIEW FINDINGS -->
  ${streetview?.vision_analysis?.findings?.length > 0 ? `<h1>Street View Analysis</h1>${streetview.vision_analysis.findings.map((fi: A) => `<div class="fi">${sev(fi.severity || "LOW")} <span>${fi.observation}</span></div>`).join("")}` : ""}

  <!-- SATELLITE FINDINGS -->
  ${satellite?.vision_analysis ? `<h1>Satellite Analysis</h1><table>${[
    satellite.vision_analysis.roof_material && satellite.vision_analysis.roof_material !== "unknown" && ["Roof Material", satellite.vision_analysis.roof_material],
    satellite.vision_analysis.roof_orientation_estimate && satellite.vision_analysis.roof_orientation_estimate !== "unclear" && ["Roof Orientation", satellite.vision_analysis.roof_orientation_estimate],
    ["Solar Panels", satellite.vision_analysis.solar_installed ? "Visible" : "None visible"],
    ["Asbestos Indicators", satellite.vision_analysis.asbestos_indicators ? "Present" : "None detected"],
  ].filter(Boolean).map(r => `<tr><td style="width:140px"><strong>${(r as string[])[0]}</strong></td><td>${(r as string[])[1]}</td></tr>`).join("")}</table>` : ""}
</div>

<!-- FINDINGS + RISKS -->
<div class="pg">
  ${redFlags.length > 0 ? `<h1 style="color:#E63946">Red Flags (${redFlags.length})</h1>${redFlags.map(rf => `<div class="rf">${sev(rf.severity)} ${rf.issue} <span style="float:right;font-size:8px;color:#999">${rf.source}</span></div>`).join("")}` : ""}

  ${sortedFindings.length > 0 ? `<h1>Visual Inspection (${sortedFindings.length} findings)</h1>${sortedFindings.map(fi => `<div class="fi">${sev(fi.severity)} <span style="flex:1">${fi.observation}${fi.estimated_repair_cost_zar && fi.estimated_repair_cost_zar.max > 0 ? ` <span style="color:#888">(${fZAR(fi.estimated_repair_cost_zar.min)}–${fZAR(fi.estimated_repair_cost_zar.max)})</span>` : ""}${fi.source_photo ? ` <a href="${fi.source_photo}" style="color:#2563EB;font-size:8px">[view photo]</a>` : ""}</span></div>`).join("")}` : ""}

  ${r.repair_estimates?.items?.length > 0 ? `<h1>Repair Estimates</h1><table><thead><tr><th>Category</th><th>Description</th><th>Min</th><th>Max</th></tr></thead><tbody>${r.repair_estimates.items.filter((i: A) => i.description && i.description !== "N/A").map((i: A) => `<tr><td>${i.category}</td><td>${i.description}</td><td>${f(i.min)}</td><td>${f(i.max)}</td></tr>`).join("")}</tbody></table><div style="font-weight:bold;margin-top:4px">Total: ${f(r.repair_estimates.total_min_zar)}–${f(r.repair_estimates.total_max_zar)}</div>` : ""}

  ${p.water_quality_score != null ? `<h1>Infrastructure & Risk</h1><table>${[
    p.water_quality_score != null && ["Water Quality", `${p.water_quality_score}/10 ${p.water_quality_score >= 8 ? "— Good" : p.water_quality_score >= 5 ? "— Moderate" : "— Poor"}`],
    p.sewerage_quality_score != null && ["Sewerage", `${p.sewerage_quality_score}/10 ${p.sewerage_quality_score <= 4 ? "— POOR" : ""}`],
    p.dolomite_risk && ["Dolomite/Sinkhole", p.dolomite_risk],
    p.flood_zone && ["Flood Zone", `Yes — ${p.flood_zone_type}`],
    p.heritage_site && ["Heritage Area", "Yes — restrictions apply"],
  ].filter(Boolean).map(r => `<tr><td style="width:140px"><strong>${(r as string[])[0]}</strong></td><td>${(r as string[])[1]}</td></tr>`).join("")}</table>` : ""}

  ${crimeData.length > 0 ? `<h1>Crime — ${p.suburb}</h1><table>${crimeData.map((c: A) => `<tr><td style="text-transform:capitalize">${c.incident_type.replace(/_/g," ")}</td><td style="text-align:right;font-weight:bold">${c.cnt}</td></tr>`).join("")}</table>` : ""}

  ${p.electrical_coc_required ? `<h1>Compliance Certificates Required</h1><table>${[
    p.electrical_coc_required && ["Electrical CoC", "Required (OHS Act) — R1,500-R5,000"],
    p.plumbing_coc_required && ["Plumbing CoC", "Required (Municipal) — R1,000-R3,000"],
    p.beetle_cert_required && ["Beetle Certificate", "Required (WC/KZN) — R3,000-R15,000"],
    p.electric_fence_coc_required && ["Electric Fence CoC", "Required — R500-R1,500"],
  ].filter(Boolean).map(r => `<tr><td style="width:140px"><strong>${(r as string[])[0]}</strong></td><td>${(r as string[])[1]}</td></tr>`).join("")}</table>` : ""}

  ${neg.length > 0 ? `<h1>Negotiation Leverage</h1>${neg.map(n => `<div class="np">${n}</div>`).join("")}` : ""}

  <h1>Data Sources</h1>
  <table><thead><tr><th>Data</th><th>Source</th><th>Confidence</th></tr></thead><tbody>
    ${p.listing_url ? `<tr><td>Listing</td><td>${p.listing_url.includes("privateproperty") ? "PrivateProperty.co.za" : "Property24.com"}</td><td>Scraped</td></tr>` : ""}
    ${p.lat ? `<tr><td>Coordinates</td><td>Google Maps Geocoding API</td><td>Verified</td></tr>` : ""}
    ${svUri ? `<tr><td>Street View</td><td>Google Street View Static API</td><td>Verified</td></tr>` : ""}
    ${satUri ? `<tr><td>Satellite</td><td>Google Maps Static API</td><td>Verified</td></tr>` : ""}
    ${findings.length > 0 ? `<tr><td>Visual findings (${findings.length})</td><td>Claude Vision (Anthropic)</td><td>AI Estimated</td></tr>` : ""}
    ${d ? `<tr><td>Ownership</td><td>Windeed (Deeds Office)</td><td>Verified</td></tr>` : ""}
    ${p.water_quality_score != null ? `<tr><td>Water/Sewerage</td><td>DWS Blue/Green Drop</td><td>Verified</td></tr>` : ""}
    ${crimeData.length > 0 ? `<tr><td>Crime data</td><td>SAPS Annual Statistics</td><td>Verified</td></tr>` : ""}
    ${p.extracted_features ? `<tr><td>Extracted features</td><td>Claude (Anthropic)</td><td>AI Estimated</td></tr>` : ""}
    ${r.decision ? `<tr><td>Report synthesis</td><td>Claude (Anthropic)</td><td>AI Generated</td></tr>` : ""}
  </tbody></table>

  <div class="ft">surepath.co.za | Confidential property report | All findings are risk indicators requiring on-site verification by qualified professionals</div>
</div>
</body></html>`;

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "8mm", bottom: "10mm", left: "8mm", right: "8mm" } });
  await browser.close();

  return new NextResponse(pdfBuffer, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="surepath-report-${property_id}.pdf"` } });
});
