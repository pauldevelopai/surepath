import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";
import path from "path";

export const GET = withAuth(async () => {
  // Total costs by service
  const byService = await query(`
    SELECT service, COUNT(*) AS calls,
      SUM(cost_usd) AS total_usd, SUM(cost_zar) AS total_zar,
      SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens
    FROM api_costs GROUP BY service ORDER BY total_zar DESC
  `);

  // Cost by endpoint
  const byEndpoint = await query(`
    SELECT service, endpoint, COUNT(*) AS calls,
      SUM(cost_usd) AS total_usd, SUM(cost_zar) AS total_zar
    FROM api_costs GROUP BY service, endpoint ORDER BY total_zar DESC
  `);

  // Daily costs (last 30 days)
  const daily = await query(`
    SELECT created_at::date AS day, service,
      COUNT(*) AS calls, SUM(cost_zar) AS total_zar
    FROM api_costs
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY day, service ORDER BY day
  `);

  // Cost per property — full breakdown including data size
  const byProperty = await query(`
    SELECT
      p.id, p.address_raw, p.suburb, p.city,
      p.street_address, p.listing_url,
      COALESCE(costs.api_calls, 0) AS api_calls,
      COALESCE(costs.total_zar, 0) AS api_cost_zar,
      COALESCE(costs.total_usd, 0) AS api_cost_usd,
      COALESCE(costs.vision_calls, 0) AS vision_calls,
      COALESCE(costs.vision_zar, 0) AS vision_cost_zar,
      COALESCE(costs.synthesis_calls, 0) AS synthesis_calls,
      COALESCE(costs.synthesis_zar, 0) AS synthesis_cost_zar,
      COALESCE(costs.google_calls, 0) AS google_calls,
      COALESCE(costs.google_zar, 0) AS google_cost_zar,
      COALESCE(img.photo_count, 0) AS photo_count,
      COALESCE(img.total_url_chars, 0) AS photo_data_chars,
      COALESCE(img.analysed_count, 0) AS analysed_photos,
      CASE WHEN pr.id IS NOT NULL THEN true ELSE false END AS has_report,
      COALESCE(jsonb_array_length(
        CASE WHEN jsonb_typeof(pr.vision_findings) = 'array' THEN pr.vision_findings ELSE '[]'::jsonb END
      ), 0) AS finding_count,
      pg_column_size(p.*) AS property_row_bytes,
      p.created_at
    FROM properties p
    LEFT JOIN (
      SELECT property_id,
        COUNT(*) AS api_calls,
        SUM(cost_zar) AS total_zar,
        SUM(cost_usd) AS total_usd,
        COUNT(*) FILTER (WHERE endpoint LIKE 'vision%') AS vision_calls,
        SUM(cost_zar) FILTER (WHERE endpoint LIKE 'vision%') AS vision_zar,
        COUNT(*) FILTER (WHERE endpoint LIKE 'synthesis%') AS synthesis_calls,
        SUM(cost_zar) FILTER (WHERE endpoint LIKE 'synthesis%') AS synthesis_zar,
        COUNT(*) FILTER (WHERE service = 'google') AS google_calls,
        SUM(cost_zar) FILTER (WHERE service = 'google') AS google_zar
      FROM api_costs WHERE property_id IS NOT NULL GROUP BY property_id
    ) costs ON costs.property_id = p.id
    LEFT JOIN (
      SELECT property_id,
        COUNT(*) AS photo_count,
        SUM(length(image_url)) AS total_url_chars,
        COUNT(*) FILTER (WHERE vision_analysis IS NOT NULL) AS analysed_count
      FROM property_images GROUP BY property_id
    ) img ON img.property_id = p.id
    LEFT JOIN property_reports pr ON pr.property_id = p.id AND pr.status = 'complete'
    ORDER BY costs.total_zar DESC NULLS LAST
    LIMIT 100
  `);

  // Totals
  const totals = await query(`
    SELECT
      COUNT(*) AS total_calls,
      COALESCE(SUM(cost_usd), 0) AS total_usd,
      COALESCE(SUM(cost_zar), 0) AS total_zar,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens
    FROM api_costs
  `);

  const today = await query(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(cost_zar), 0) AS total_zar
    FROM api_costs WHERE created_at >= CURRENT_DATE
  `);

  const month = await query(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(cost_zar), 0) AS total_zar
    FROM api_costs WHERE created_at >= date_trunc('month', NOW())
  `);

  // Data size totals
  const dataSize = await query(`
    SELECT
      (SELECT COUNT(*) FROM properties) AS total_properties,
      (SELECT COUNT(*) FROM property_images) AS total_images,
      (SELECT SUM(length(image_url)) FROM property_images) AS total_image_url_chars,
      (SELECT COUNT(*) FROM property_reports) AS total_reports,
      (SELECT pg_total_relation_size('properties')) AS properties_table_bytes,
      (SELECT pg_total_relation_size('property_images')) AS images_table_bytes,
      (SELECT pg_total_relation_size('property_reports')) AS reports_table_bytes
  `);

  // Average cost per property
  const avgCost = await query(`
    SELECT
      AVG(total_zar) AS avg_cost_zar,
      MAX(total_zar) AS max_cost_zar,
      MIN(total_zar) FILTER (WHERE total_zar > 0) AS min_cost_zar
    FROM (
      SELECT property_id, SUM(cost_zar) AS total_zar
      FROM api_costs WHERE property_id IS NOT NULL
      GROUP BY property_id
    ) sub
  `);

  // Recent calls
  const recent = await query(`
    SELECT ac.*, p.address_raw, p.suburb
    FROM api_costs ac
    LEFT JOIN properties p ON p.id = ac.property_id
    ORDER BY ac.created_at DESC LIMIT 50
  `);

  // WhatsApp / Twilio costs
  // Twilio WhatsApp pricing: ~$0.005 per message (utility), ~$0.0042 per session message
  // Using $0.005 per outbound message as estimate
  const TWILIO_COST_PER_MSG_USD = 0.005;
  const whatsapp = await query(`
    SELECT
      COUNT(*) AS total_messages,
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound,
      COUNT(*) FILTER (WHERE media_url IS NOT NULL) AS with_media,
      COUNT(DISTINCT phone_number) AS unique_users,
      MIN(created_at) AS first_message,
      MAX(created_at) AS last_message
    FROM whatsapp_messages
  `);

  const whatsappToday = await query(`
    SELECT
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound
    FROM whatsapp_messages WHERE created_at >= CURRENT_DATE
  `);

  const whatsappMonth = await query(`
    SELECT
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound
    FROM whatsapp_messages WHERE created_at >= date_trunc('month', NOW())
  `);

  const whatsappDaily = await query(`
    SELECT created_at::date AS day, direction, COUNT(*) AS cnt
    FROM whatsapp_messages
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY day, direction ORDER BY day
  `);

  const whatsappRecent = await query(`
    SELECT phone_number, direction, body, media_url, created_at
    FROM whatsapp_messages ORDER BY created_at DESC LIMIT 30
  `);

  const wa = whatsapp[0] || {};
  const waOutbound = Number(wa.outbound || 0);

  // Fetch live exchange rate (cached weekly)
  let exchangeRate = { rate: 18.3, source: "fallback", cached: false, fetched_at: null as string | null };
  try {
    const erPath = path.resolve(process.cwd(), "..", "exchange-rate.js");
    const er = await import(/* webpackIgnore: true */ erPath);
    const getRate = er.getRate || er.default?.getRate;
    if (getRate) exchangeRate = await getRate();
  } catch {}

  const zarRate = exchangeRate.rate;

  return NextResponse.json({
    totals: totals[0],
    today: today[0],
    month: month[0],
    by_service: byService,
    by_endpoint: byEndpoint,
    daily,
    by_property: byProperty,
    data_size: dataSize[0],
    avg_cost: avgCost[0] || { avg_cost_zar: 0, max_cost_zar: 0, min_cost_zar: 0 },
    recent,
    exchange_rate: exchangeRate,
    whatsapp: {
      ...wa,
      cost_per_msg_usd: TWILIO_COST_PER_MSG_USD,
      total_cost_usd: waOutbound * TWILIO_COST_PER_MSG_USD,
      total_cost_zar: Math.round(waOutbound * TWILIO_COST_PER_MSG_USD * zarRate * 100) / 100,
      month_cost_zar: Math.round(Number((whatsappMonth[0] || { outbound: 0 }).outbound) * TWILIO_COST_PER_MSG_USD * zarRate * 100) / 100,
      today: whatsappToday[0] || { outbound: 0, inbound: 0 },
      month: whatsappMonth[0] || { outbound: 0, inbound: 0 },
      daily: whatsappDaily,
      recent: whatsappRecent,
    },
  });
});
