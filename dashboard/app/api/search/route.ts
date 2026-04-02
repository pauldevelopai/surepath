import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q");
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const term = `%${q}%`;

  // Search across multiple tables in parallel
  const [properties, agents, suburbs, findings, risks] = await Promise.all([
    // Properties — address, description, building name
    query(`
      SELECT id, 'property' AS type, address_raw AS title,
        COALESCE(street_address, suburb || ', ' || city) AS subtitle,
        asking_price, bedrooms, bathrooms, property_type
      FROM properties
      WHERE address_raw ILIKE $1 OR street_address ILIKE $1 OR description ILIKE $1
        OR building_name ILIKE $1 OR erf_number ILIKE $1
      LIMIT 20
    `, [term]),

    // Agents
    query(`
      SELECT DISTINCT agent_name AS title, agency_name AS subtitle, 'agent' AS type,
        COUNT(*) AS count
      FROM properties
      WHERE (agent_name ILIKE $1 OR agency_name ILIKE $1) AND agent_name IS NOT NULL
      GROUP BY agent_name, agency_name
      ORDER BY count DESC LIMIT 10
    `, [term]),

    // Suburbs — aggregate stats
    query(`
      SELECT suburb || ', ' || city AS title, 'suburb' AS type,
        COUNT(*) AS count,
        AVG(asking_price) FILTER (WHERE asking_price IS NOT NULL) AS avg_price,
        suburb, city
      FROM properties
      WHERE suburb ILIKE $1 OR city ILIKE $1
      GROUP BY suburb, city
      ORDER BY count DESC LIMIT 10
    `, [term]),

    // Vision findings
    query(`
      SELECT p.id, 'finding' AS type, p.address_raw AS title,
        f->>'observation' AS subtitle,
        f->>'severity' AS severity,
        f->>'category' AS category
      FROM property_reports pr
      JOIN properties p ON p.id = pr.property_id,
      jsonb_array_elements(
        CASE WHEN jsonb_typeof(pr.vision_findings) = 'array' THEN pr.vision_findings ELSE '[]'::jsonb END
      ) AS f
      WHERE f->>'observation' ILIKE $1 OR f->>'category' ILIKE $1
      LIMIT 15
    `, [term]),

    // Area risks
    query(`
      SELECT risk_type || ' — ' || suburb || ', ' || city AS title,
        'risk' AS type,
        risk_level AS subtitle,
        source_name, source_url
      FROM area_risk_data
      WHERE suburb ILIKE $1 OR city ILIKE $1 OR risk_type ILIKE $1
      LIMIT 10
    `, [term]),
  ]);

  return NextResponse.json({
    results: [
      ...properties.map((r: Record<string, unknown>) => ({ ...r, category: "Properties" })),
      ...suburbs.map((r: Record<string, unknown>) => ({ ...r, category: "Suburbs" })),
      ...agents.map((r: Record<string, unknown>) => ({ ...r, category: "Agents" })),
      ...findings.map((r: Record<string, unknown>) => ({ ...r, category: "Findings" })),
      ...risks.map((r: Record<string, unknown>) => ({ ...r, category: "Risk Data" })),
    ],
    counts: {
      properties: properties.length,
      suburbs: suburbs.length,
      agents: agents.length,
      findings: findings.length,
      risks: risks.length,
    },
  });
});
