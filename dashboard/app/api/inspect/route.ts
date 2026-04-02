import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const search = req.nextUrl.searchParams.get("q");

  let sql = `
    SELECT p.id, p.erf_number, p.address_raw, p.suburb, p.city,
           COUNT(pi.id) AS image_count,
           pr.id AS report_id, pr.decision, pr.asbestos_risk,
           pr.created_at AS report_date,
           COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(pr.vision_findings) = 'array' THEN pr.vision_findings ELSE '[]'::jsonb END
           ), 0) AS finding_count
    FROM properties p
    LEFT JOIN property_images pi ON pi.property_id = p.id
    LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let idx = 1;

  if (search) {
    sql += ` AND (p.address_raw ILIKE $${idx} OR p.erf_number ILIKE $${idx} OR p.suburb ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }

  sql += ` GROUP BY p.id, pr.id ORDER BY pr.created_at DESC NULLS LAST LIMIT 100`;

  const rows = await query(sql, params);
  return NextResponse.json(rows);
});
