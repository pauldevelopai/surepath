import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const u = req.nextUrl.searchParams;
  const paymentStatus = u.get("payment_status");
  const reportStatus = u.get("report_status");

  let sql = `
    SELECT o.*, p.address_raw, p.address_normalised, p.suburb, p.city,
           pr.status AS report_status, pr.decision
    FROM orders o
    JOIN properties p ON p.id = o.property_id
    LEFT JOIN property_reports pr ON pr.id = o.report_id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let idx = 1;

  if (paymentStatus) {
    sql += ` AND o.payment_status = $${idx++}`;
    params.push(paymentStatus);
  }
  if (reportStatus) {
    sql += ` AND pr.status = $${idx++}`;
    params.push(reportStatus);
  }
  sql += " ORDER BY o.created_at DESC LIMIT 200";

  const rows = await query(sql, params);
  return NextResponse.json(rows);
});
