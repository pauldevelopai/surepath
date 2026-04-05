import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import path from "path";

export const GET = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;

  const properties = await query("SELECT * FROM properties WHERE id = $1", [id]);
  if (!properties.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const prop = properties[0];

  let unverifiedFields: string[] = [];
  try {
    const modPath = path.resolve(process.cwd(), "..", "provenance.js");
    const provenance = await import(/* webpackIgnore: true */ modPath);
    const getUnverified = provenance.getUnverifiedFields || provenance.default?.getUnverifiedFields;
    if (getUnverified) unverifiedFields = await getUnverified(parseInt(id));
  } catch {}

  const [reports, images, deeds] = await Promise.all([
    query("SELECT * FROM property_reports WHERE property_id = $1 ORDER BY created_at DESC LIMIT 1", [id]),
    query("SELECT * FROM property_images WHERE property_id = $1 ORDER BY analysed_at DESC NULLS LAST", [id]),
    query("SELECT * FROM deeds_data WHERE property_id = $1 ORDER BY fetched_at DESC LIMIT 1", [id]),
  ]);

  // Crime data with context
  let crimeData = null;
  if (prop.city && prop.suburb) {
    // Get suburb-specific data
    const incidents = await query(
      `SELECT incident_type, COUNT(*) AS cnt
       FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2
       GROUP BY incident_type ORDER BY cnt DESC`,
      [prop.suburb, prop.city]
    );

    const dateRange = await query(
      `SELECT MIN(incident_date) AS earliest, MAX(incident_date) AS latest, COUNT(*) AS total
       FROM crime_incidents WHERE suburb ILIKE $1 AND city ILIKE $2`,
      [prop.suburb, prop.city]
    );

    // City-level comparison — all suburbs
    const suburbRank = await query(
      `SELECT suburb, COUNT(*) AS total
       FROM crime_incidents WHERE city ILIKE $1
       GROUP BY suburb ORDER BY total DESC`,
      [prop.city]
    );

    // City-level totals and date range
    const cityTotals = await query(
      `SELECT MIN(incident_date) AS earliest, MAX(incident_date) AS latest,
              COUNT(*) AS total, COUNT(DISTINCT incident_type) AS types
       FROM crime_incidents WHERE city ILIKE $1`,
      [prop.city]
    );

    // City-level incident breakdown (for when suburb has no data)
    const cityIncidents = await query(
      `SELECT incident_type, COUNT(*) AS cnt
       FROM crime_incidents WHERE city ILIKE $1
       GROUP BY incident_type ORDER BY cnt DESC`,
      [prop.city]
    );

    const range = dateRange[0] || {};
    const total = parseInt(range.total as string) || 0;
    const allSuburbs = suburbRank.map((s: { suburb: string; total: string }) => ({
      suburb: s.suburb, total: parseInt(s.total),
    }));
    const thisRank = allSuburbs.findIndex((s: { suburb: string }) =>
      s.suburb.toLowerCase() === (prop.suburb || "").toLowerCase()
    );

    const hasSuburbData = total > 0;
    const ct = cityTotals[0] || {};

    crimeData = {
      has_suburb_data: hasSuburbData,
      incidents: hasSuburbData ? incidents : cityIncidents,
      incidents_level: hasSuburbData ? "suburb" : "city",
      total: hasSuburbData ? total : parseInt(ct.total as string) || 0,
      earliest: hasSuburbData ? range.earliest : ct.earliest,
      latest: hasSuburbData ? range.latest : ct.latest,
      suburb_rank: thisRank >= 0 ? thisRank + 1 : 0,
      suburbs_in_city: allSuburbs.length,
      suburbs_with_data: allSuburbs.map((s: { suburb: string; total: number }) => s.suburb),
      safest_suburb: allSuburbs.length > 0 ? allSuburbs[allSuburbs.length - 1].suburb : null,
      most_dangerous_suburb: allSuburbs.length > 0 ? allSuburbs[0].suburb : null,
      avg_across_city: allSuburbs.length > 0 ? Math.round(allSuburbs.reduce((s: number, x: { total: number }) => s + x.total, 0) / allSuburbs.length) : 0,
    };
  }

  // Area risk data
  const areaRisks = prop.suburb ? await query(
    "SELECT risk_type, risk_level, risk_score, details, source_name, source_url, data_date FROM area_risk_data WHERE (suburb ILIKE $1 OR suburb = 'ALL') AND city ILIKE $2",
    [prop.suburb, prop.city]
  ) : [];

  // Service providers in this area
  const serviceProviders = prop.city ? await query(
    "SELECT name, trade, rating, review_count, phone, source_name, source_url FROM service_providers WHERE city ILIKE $1 ORDER BY rating DESC NULLS LAST LIMIT 20",
    [prop.city]
  ) : [];

  // Build findings from per-image vision_analysis — deduplicated and filtered
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawFindings: Record<string, any>[] = [];
  for (const img of images) {
    if (!img.vision_analysis?.findings) continue;
    const photoUrl = img.image_url?.startsWith("http") ? img.image_url : null;
    for (const f of img.vision_analysis.findings) {
      if (!f.observation) continue;
      rawFindings.push({ ...f, source_photo: photoUrl });
    }
  }

  // Smart dedup: normalize observation text to catch similar findings
  function findingKey(obs: string) {
    const normalized = obs.toLowerCase()
      .replace(/photos?\s*\d+[\s,and]*/gi, '')
      .replace(/\b(first|second|third|fourth|fifth|third|another|same|also|again|similar)\b/gi, '')
      .replace(/\b(confirmation|confirmed|visible|detected|present|appears?|noted|observed)\b/gi, '')
      .replace(/\b(recommend|should|may|could|cannot|possible|probable|potential|risk of)\b/gi, '')
      .replace(/\b(from this|at this|in this|under|available|current|conditions?|resolution|distance|angle)\b/gi, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized.substring(0, 50);
  }

  const skipPatterns = [
    /not suitable for property inspection/i,
    /no structural defects.*building elements.*inspectable/i,
    /domestic cat/i,
    /road bicycle stored/i,
    /cannot be meaningfully assessed/i,
    /no residential property exterior is visible/i,
    /ceiling not visible in frame/i,
  ];

  const linkedFindings: Record<string, any>[] = [];
  const seenKeys = new Set<string>();
  for (const fi of rawFindings) {
    if (skipPatterns.some(p => p.test(fi.observation))) continue;
    if (fi.severity === 'LOW' && (!fi.estimated_repair_cost_zar || fi.estimated_repair_cost_zar.max === 0) &&
        /no\s+(visible|confirmed|active|defect|crack|stain|sag|leak|damage)/i.test(fi.observation)) continue;
    const key = findingKey(fi.observation);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    linkedFindings.push(fi);
  }

  // Use linked findings if we have them, otherwise fall back to report findings
  const report = reports[0] || null;
  if (report && linkedFindings.length > 0) {
    report._linked_findings = linkedFindings;
  }

  // PDF export history
  const pdfExports = await query(
    "SELECT id, source, phone_number, file_size_bytes, created_at FROM pdf_exports WHERE property_id = $1 ORDER BY created_at DESC LIMIT 20",
    [id]
  );

  // Nico tease from WhatsApp conversation
  let nicoTease = null;
  try {
    const teaseRows = await query(
      "SELECT tease_data FROM conversations WHERE listing_url ILIKE $1 OR input_data ILIKE $1 ORDER BY updated_at DESC LIMIT 1",
      [`%${prop.listing_url?.split('/').pop() || id}%`]
    );
    if (teaseRows[0]?.tease_data) {
      const td = typeof teaseRows[0].tease_data === 'string' ? JSON.parse(teaseRows[0].tease_data) : teaseRows[0].tease_data;
      nicoTease = td.nicoTease || null;
    }
  } catch {}

  return NextResponse.json({
    property: prop,
    sources: prop.data_sources || {},
    unverified_fields: unverifiedFields,
    area_risks: areaRisks,
    report,
    images,
    deeds: deeds[0] || null,
    crime: crimeData,
    service_providers: serviceProviders,
    pdf_exports: pdfExports,
    nico_tease: nicoTease,
  });
});
