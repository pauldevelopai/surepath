import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const [crimePending, crimeTotal, solarPending, solarTotal, suburbs] = await Promise.all([
    query(`SELECT COUNT(*) as cnt FROM properties p WHERE p.suburb IS NOT NULL AND p.city IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM area_risk_data ard WHERE ard.suburb ILIKE p.suburb AND ard.city ILIKE p.city AND ard.risk_type = 'crime_detailed')`),
    query(`SELECT COUNT(*) as cnt FROM area_risk_data WHERE risk_type = 'crime_detailed'`),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE lat IS NOT NULL AND solar_ghi_kwh_year IS NULL`),
    query(`SELECT COUNT(*) as cnt FROM properties WHERE solar_ghi_kwh_year IS NOT NULL`),
    query(`SELECT COUNT(DISTINCT suburb) as cnt FROM properties WHERE suburb IS NOT NULL`),
  ]);

  return NextResponse.json({
    crime_pending: parseInt(crimePending[0].cnt),
    crime_total: parseInt(crimeTotal[0].cnt),
    solar_pending: parseInt(solarPending[0].cnt),
    solar_total: parseInt(solarTotal[0].cnt),
    suburbs_tracked: parseInt(suburbs[0].cnt),
    listings_discovered: 0,
  });
});
