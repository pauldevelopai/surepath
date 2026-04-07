import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const [crimePending, crimeTotal, solarPending, solarTotal, ppTotal, ppLatest, suburbs, suburbsWithListings, securityPending, securityTotal, sapsTotal, assist247Suburbs, procompareCompanies, waterPending, waterTotal, gvrTotal, schoolsTotal, schoolsPending, climateTotal, climatePending, loadsheddingTotal, soldpricesTotal, fibreTotal, kbTotal, kbActive] = await Promise.all([
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
    query(`SELECT COUNT(DISTINCT p.city) as cnt FROM properties p WHERE p.city IS NOT NULL AND p.water_quality_score IS NULL`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE water_quality_score IS NOT NULL`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE gvr_source IS NOT NULL`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'school_proximity'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (p.suburb || '|' || p.city)) as cnt FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'school_proximity')`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'climate'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (p.suburb || '|' || p.city)) as cnt FROM properties p WHERE p.lat IS NOT NULL AND p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'climate')`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'loadshedding'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'sold_prices'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'fibre_coverage'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM rag_knowledge_entries`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM rag_knowledge_entries WHERE status = 'active'`).catch(() => [{ cnt: 0 }]),
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
    water_pending: parseInt(waterPending[0].cnt),
    water_total: parseInt(waterTotal[0].cnt),
    gvr_total: parseInt(gvrTotal[0].cnt),
    schools_total: parseInt(schoolsTotal[0].cnt),
    schools_pending: parseInt(schoolsPending[0].cnt),
    climate_total: parseInt(climateTotal[0].cnt),
    climate_pending: parseInt(climatePending[0].cnt),
    loadshedding_total: parseInt(loadsheddingTotal[0].cnt),
    soldprices_total: parseInt(soldpricesTotal[0].cnt),
    fibre_total: parseInt(fibreTotal[0].cnt),
    kb_total: parseInt(kbTotal[0].cnt),
    kb_active: parseInt(kbActive[0].cnt),
  });
});
