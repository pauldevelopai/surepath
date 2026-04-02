import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;

  const clients = await query("SELECT * FROM api_clients WHERE id = $1", [id]);
  if (!clients.length) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const usageByEndpoint = await query(`
    SELECT endpoint, COUNT(*) AS queries,
      SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) AS cache_hits,
      SUM(billed_amount_zar) AS revenue
    FROM api_usage WHERE client_id = $1
    AND created_at >= date_trunc('month', NOW())
    GROUP BY endpoint
  `, [id]);

  const dailyUsage = await query(`
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS queries
    FROM api_usage WHERE client_id = $1
    AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY day ORDER BY day
  `, [id]);

  return NextResponse.json({
    client: clients[0],
    usage_by_endpoint: usageByEndpoint,
    daily_usage: dailyUsage,
  });
}) as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponse>;
