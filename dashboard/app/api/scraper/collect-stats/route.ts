import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const [crimePending, crimeTotal, solarPending, solarTotal, ppTotal, ppLatest, suburbs, suburbsWithListings, securityPending, securityTotal, sapsTotal, assist247Suburbs, procompareCompanies, waterPending, waterTotal, gvrTotal, schoolsTotal, schoolsPending, climateTotal, climatePending, loadsheddingTotal, soldpricesTotal, fibreTotal, kbTotal, kbActive, electricityTotal, ragChunksByLayer, ragLastSeeded, ragPending, pricetrendsTotal, pricetrendsPending, propertycostsTotal, propertycostsPending] = await Promise.all([
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
    query(`SELECT COUNT(DISTINCT city) as cnt FROM area_risk_data WHERE risk_type = 'electricity'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT layer, COUNT(*) as count FROM rag_chunks GROUP BY layer ORDER BY count DESC`).catch(() => []),
    query(`SELECT MAX(updated_at) as last_seeded FROM rag_chunks`).catch(() => [{ last_seeded: null }]),
    // RAG pending: count source rows NOT yet in rag_chunks per source table
    Promise.all([
      query(`SELECT COUNT(*) as cnt FROM properties p WHERE p.suburb IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'properties' AND rc.source_id = p.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM area_risk_data ard WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'area_risk_data' AND rc.source_id = ard.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM holly_evidence he WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'holly_evidence' AND rc.source_id = he.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM property_images pi WHERE pi.vision_analysis IS NOT NULL AND jsonb_typeof(pi.vision_analysis->'findings') = 'array' AND jsonb_array_length(pi.vision_analysis->'findings') > 0 AND NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'property_images' AND rc.source_id = pi.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM security_companies sc WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'security_companies' AND rc.source_id = sc.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM property_reports pr WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'property_reports' AND rc.source_id = pr.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM data_feedback df WHERE NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'data_feedback' AND rc.source_id = df.id)`).catch(() => [{ cnt: 0 }]),
      query(`SELECT COUNT(*) as cnt FROM rag_knowledge_entries rke WHERE rke.status = 'active' AND NOT EXISTS (SELECT 1 FROM rag_chunks rc WHERE rc.source_table = 'rag_knowledge_entries' AND rc.source_id = rke.id)`).catch(() => [{ cnt: 0 }]),
    ]),
    query(`SELECT COUNT(DISTINCT (suburb || '|' || city)) as cnt FROM area_risk_data WHERE risk_type = 'price_trends'`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(DISTINCT (p.suburb || '|' || p.city)) as cnt FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'price_trends')`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE extra_costs_json IS NOT NULL`).catch(() => [{ cnt: 0 }]),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE asking_price > 0 AND suburb IS NOT NULL AND extra_costs_json IS NULL`).catch(() => [{ cnt: 0 }]),
  ]);

  const chunks: Record<string, number> = {};
  let totalChunks = 0;
  for (const r of ragChunksByLayer) {
    chunks[r.layer] = parseInt(r.count);
    totalChunks += parseInt(r.count);
  }

  const ragPendingResults = ragPending as { cnt: number | string }[][];
  const pendingBySource: Record<string, { pending: number; layer: string }> = {
    properties:           { pending: parseInt(String(ragPendingResults[0][0].cnt)), layer: "property" },
    area_risk_data:       { pending: parseInt(String(ragPendingResults[1][0].cnt)), layer: "live / crime" },
    holly_evidence:       { pending: parseInt(String(ragPendingResults[2][0].cnt)), layer: "evidence" },
    property_images:      { pending: parseInt(String(ragPendingResults[3][0].cnt)), layer: "vision" },
    security_companies:   { pending: parseInt(String(ragPendingResults[4][0].cnt)), layer: "security_company" },
    property_reports:     { pending: parseInt(String(ragPendingResults[5][0].cnt)), layer: "report" },
    data_feedback:        { pending: parseInt(String(ragPendingResults[6][0].cnt)), layer: "feedback" },
    articles: { pending: parseInt(String(ragPendingResults[7][0].cnt)), layer: "articles" },
  };

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
    electricity_total: parseInt(electricityTotal[0].cnt),
    pricetrends_total: parseInt(pricetrendsTotal[0].cnt),
    pricetrends_pending: parseInt(pricetrendsPending[0].cnt),
    propertycosts_total: parseInt(propertycostsTotal[0].cnt),
    propertycosts_pending: parseInt(propertycostsPending[0].cnt),
    rag_chunks_by_layer: chunks,
    rag_total_chunks: totalChunks,
    rag_last_seeded: ragLastSeeded[0]?.last_seeded || null,
    rag_pending_by_source: pendingBySource,
  });
});
