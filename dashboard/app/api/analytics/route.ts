import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const [
    ordersToday, ordersMonth,
    revenueToday, revenueMonth,
    resaleStats, newProps,
    dailyOrders, topSuburbs,
    decisions, defects,
    b2bRevenue,
  ] = await Promise.all([
    query("SELECT COUNT(*) AS c FROM orders WHERE created_at >= CURRENT_DATE"),
    query("SELECT COUNT(*) AS c FROM orders WHERE created_at >= date_trunc('month', NOW())"),
    query("SELECT COALESCE(SUM(price_zar),0) AS r FROM orders WHERE payment_status='paid' AND created_at >= CURRENT_DATE"),
    query("SELECT COALESCE(SUM(price_zar),0) AS r FROM orders WHERE payment_status='paid' AND created_at >= date_trunc('month', NOW())"),
    query("SELECT COUNT(*) FILTER (WHERE was_resale) AS resales, COUNT(*) AS total FROM orders WHERE created_at >= date_trunc('month', NOW())"),
    query("SELECT COUNT(*) AS c FROM properties WHERE created_at >= NOW() - INTERVAL '7 days'"),
    query(`SELECT created_at::date AS day, COUNT(*) AS c FROM orders
           WHERE created_at >= NOW() - INTERVAL '30 days'
           GROUP BY day ORDER BY day`),
    query(`SELECT p.suburb, COUNT(*) AS c FROM orders o
           JOIN properties p ON p.id = o.property_id
           WHERE o.created_at >= date_trunc('month', NOW()) AND p.suburb IS NOT NULL
           GROUP BY p.suburb ORDER BY c DESC LIMIT 10`),
    query(`SELECT decision, COUNT(*) AS c FROM property_reports
           WHERE status='complete' AND created_at >= date_trunc('month', NOW())
           GROUP BY decision`),
    query(`SELECT f->>'category' AS category, COUNT(*) AS c
           FROM property_reports pr,
           jsonb_array_elements(CASE WHEN jsonb_typeof(pr.vision_findings) = 'array' THEN pr.vision_findings ELSE '[]'::jsonb END) AS f
           WHERE pr.status='complete' AND pr.created_at >= date_trunc('month', NOW())
           GROUP BY category ORDER BY c DESC LIMIT 10`),
    query("SELECT COALESCE(SUM(billed_amount_zar),0) AS r FROM api_usage WHERE created_at >= date_trunc('month', NOW())"),
  ]);

  const rs = resaleStats[0];
  return NextResponse.json({
    orders_today: Number(ordersToday[0].c),
    orders_month: Number(ordersMonth[0].c),
    revenue_today: Number(revenueToday[0].r),
    revenue_month: Number(revenueMonth[0].r) + Number(b2bRevenue[0].r),
    b2b_revenue_month: Number(b2bRevenue[0].r),
    resale_pct: rs.total > 0 ? Math.round((rs.resales / rs.total) * 100) : 0,
    new_properties_week: Number(newProps[0].c),
    daily_orders: dailyOrders,
    top_suburbs: topSuburbs,
    decisions,
    defects,
  });
});
