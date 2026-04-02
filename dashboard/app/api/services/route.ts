import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const u = req.nextUrl.searchParams;
  const city = u.get("city");
  const trade = u.get("trade");
  const search = u.get("q");

  let sql = "SELECT * FROM service_providers WHERE 1=1";
  const params: unknown[] = [];
  let idx = 1;

  if (city) { sql += ` AND city ILIKE $${idx++}`; params.push(`%${city}%`); }
  if (trade) { sql += ` AND trade = $${idx++}`; params.push(trade); }
  if (search) { sql += ` AND (name ILIKE $${idx} OR trade ILIKE $${idx})`; params.push(`%${search}%`); idx++; }

  sql += " ORDER BY rating DESC NULLS LAST, review_count DESC NULLS LAST LIMIT 100";

  const rows = await query(sql, params);

  // Stats
  const stats = await query(`
    SELECT trade, city, COUNT(*) AS cnt, AVG(rating) AS avg_rating
    FROM service_providers GROUP BY trade, city ORDER BY city, trade
  `);

  const cities = await query("SELECT DISTINCT city FROM service_providers ORDER BY city");
  const trades = await query("SELECT DISTINCT trade FROM service_providers ORDER BY trade");

  return NextResponse.json({ providers: rows, stats, cities: cities.map((c: { city: string }) => c.city), trades: trades.map((t: { trade: string }) => t.trade) });
});
