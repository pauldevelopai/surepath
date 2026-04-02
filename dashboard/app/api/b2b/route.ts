import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import crypto from "crypto";

export const GET = withAuth(async () => {
  const rows = await query(`
    SELECT ac.*,
      COALESCE(u.total_queries, 0) AS queries_this_month,
      COALESCE(u.total_revenue, 0) AS revenue_this_month
    FROM api_clients ac
    LEFT JOIN (
      SELECT client_id,
        COUNT(*) AS total_queries,
        SUM(billed_amount_zar) AS total_revenue
      FROM api_usage
      WHERE created_at >= date_trunc('month', NOW())
      GROUP BY client_id
    ) u ON u.client_id = ac.id
    ORDER BY ac.created_at DESC
  `);
  return NextResponse.json(rows);
});

export const POST = withAuth(async (req: NextRequest) => {
  const { company_name, tier, rate_limit_per_day, price_per_query_zar } = await req.json();

  const apiKey = `sp_${tier}_${crypto.randomBytes(24).toString("hex")}`;

  const rows = await query(
    `INSERT INTO api_clients (company_name, tier, api_key, rate_limit_per_day, price_per_query_zar, contract_start)
     VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
    [company_name, tier, apiKey, rate_limit_per_day || 1000, price_per_query_zar || 0]
  );

  return NextResponse.json(rows[0]);
});
