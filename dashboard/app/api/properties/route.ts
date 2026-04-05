import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const u = req.nextUrl.searchParams;
  const search = u.get("q");
  const suburb = u.get("suburb");
  const hasReport = u.get("has_report");
  const hasPhotos = u.get("has_photos");
  const hasCoords = u.get("has_coords");
  const page = Math.max(1, parseInt(u.get("page") || "1"));
  const perPage = 500;
  const offset = (page - 1) * perPage;

  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (search) {
    whereClauses.push(`(p.address_raw ILIKE $${idx} OR p.erf_number ILIKE $${idx} OR p.suburb ILIKE $${idx} OR p.city ILIKE $${idx} OR p.listing_url ILIKE $${idx} OR p.address_normalised ILIKE $${idx} OR p.street_address ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }
  if (suburb) { whereClauses.push(`p.suburb ILIKE $${idx++}`); params.push(`%${suburb}%`); }
  if (hasReport === "true") whereClauses.push("pr.id IS NOT NULL");
  if (hasReport === "false") whereClauses.push("pr.id IS NULL");
  if (hasCoords === "true") whereClauses.push("p.lat IS NOT NULL");
  if (hasCoords === "false") whereClauses.push("p.lat IS NULL");

  const whereSQL = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

  const fromJoin = `FROM properties p
    LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'`;

  const countResult = await query(`SELECT COUNT(DISTINCT p.id) AS total ${fromJoin} ${whereSQL}`, params);
  const total = parseInt(countResult[0]?.total) || 0;

  const sql = `
    SELECT p.id, p.erf_number, p.address_raw, p.address_normalised,
           p.suburb, p.city, p.province,
           p.lat, p.lng, p.bedrooms, p.bathrooms, p.floor_area_sqm,
           p.stand_size_sqm, p.property_type, p.construction_era,
           p.roof_material, p.roof_orientation, p.solar_installed, p.security_visible,
           p.suburb_crime_score, p.created_at,
           p.listing_date, p.last_scraped_at, p.asking_price, p.street_address,
           p.listing_url, p.agent_name, p.agency_name, p.description,
           pr.id AS report_id, pr.decision, pr.asbestos_risk,
           pr.insurance_risk_score, pr.solar_suitability_score, pr.crime_risk_score,
           pr.maintenance_cost_estimate, pr.status AS report_status,
           pr.asking_price, pr.created_at AS report_date,
           (SELECT COUNT(*) FROM property_images pi WHERE pi.property_id = p.id) AS photo_count,
           (SELECT COUNT(*) FROM property_images pi WHERE pi.property_id = p.id AND pi.vision_analysis IS NOT NULL) AS analysed_count,
           (SELECT COUNT(*) FROM deeds_data d WHERE d.property_id = p.id) AS has_deeds
    ${fromJoin}
    ${whereSQL}
    ORDER BY p.created_at DESC
    LIMIT ${perPage} OFFSET ${offset}
  `;

  const rows = await query(sql, params);

  // Global stats across ALL properties (not just current page)
  const globalStats = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE lat IS NOT NULL) AS geocoded,
      COUNT(*) FILTER (WHERE id IN (SELECT DISTINCT property_id FROM property_images)) AS with_photos,
      COUNT(*) FILTER (WHERE id IN (SELECT DISTINCT property_id FROM property_images WHERE vision_analysis IS NOT NULL)) AS vision_done,
      COUNT(*) FILTER (WHERE id IN (SELECT DISTINCT property_id FROM property_reports WHERE status = 'complete')) AS with_reports,
      COUNT(*) FILTER (WHERE id IN (SELECT DISTINCT property_id FROM deeds_data)) AS with_deeds
    FROM properties
  `);

  return NextResponse.json({
    rows, total, page, perPage, totalPages: Math.ceil(total / perPage),
    stats: {
      total: parseInt(globalStats[0].total),
      geocoded: parseInt(globalStats[0].geocoded),
      with_photos: parseInt(globalStats[0].with_photos),
      vision_done: parseInt(globalStats[0].vision_done),
      with_reports: parseInt(globalStats[0].with_reports),
      with_deeds: parseInt(globalStats[0].with_deeds),
    },
  });
});
