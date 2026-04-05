import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const [crimePending, crimeTotal, solarPending, solarTotal, ppTotal, ppLatest, suburbs, suburbsWithListings, securityPending, securityTotal, sapsTotal, assist247Suburbs, procompareCompanies] = await Promise.all([
    query(`SELECT COUNT(DISTINCT (p.suburb || '|' || p.city)) as cnt FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed')`),
    query(`SELECT COUNT(*) as cnt FROM area_risk_data WHERE risk_type = 'crime_detailed'`),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE lat IS NOT NULL AND solar_ghi_kwh_year IS NULL`),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE solar_ghi_kwh_year IS NOT NULL`),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE erf_number LIKE 'PP_%'`),
    query(`SELECT created_at FROM properties WHERE erf_number LIKE 'PP_%' ORDER BY created_at DESC LIMIT 1`),
    query(`SELECT COUNT(DISTINCT suburb) as cnt FROM properties WHERE suburb IS NOT NULL`),
    query(`SELECT COUNT(DISTINCT suburb) as cnt FROM properties WHERE suburb IS NOT NULL AND erf_number LIKE 'PP_%'`),
    query(`SELECT COUNT(DISTINCT (p.suburb || '|' || p.city)) as cnt FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND p.lat IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'security_community')`),
    query(`SELECT COUNT(*) as cnt FROM area_risk_data WHERE risk_type = 'security_community'`),
    query(`SELECT COUNT(*) as cnt FROM saps_precincts`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT suburb) as cnt FROM suburb_security_coverage WHERE source = 'assist247'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM security_companies`).catch(() => [{ cnt: 0 }]),
  ]);

  return NextResponse.json({
    crime_pending: parseInt(crimePending[0].cnt),
    crime_total: parseInt(crimeTotal[0].cnt),
    solar_pending: parseInt(solarPending[0].cnt),
    solar_total: parseInt(solarTotal[0].cnt),
    pp_total: parseInt(ppTotal[0].cnt),
    pp_universe: 208500,
    pp_latest: ppLatest[0]?.created_at || null,
    suburbs_tracked: parseInt(suburbs[0].cnt),
    suburbs_with_listings: parseInt(suburbsWithListings[0].cnt),
    security_pending: parseInt(securityPending[0].cnt),
    security_total: parseInt(securityTotal[0].cnt),
    saps_total: parseInt(sapsTotal[0].cnt),
    assist247_suburbs: parseInt(assist247Suburbs[0].cnt),
    procompare_companies: parseInt(procompareCompanies[0].cnt),
  });
});
