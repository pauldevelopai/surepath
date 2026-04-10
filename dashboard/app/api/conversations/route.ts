import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async (req: NextRequest) => {
  const phone = req.nextUrl.searchParams.get("phone");

  if (phone) {
    // Get messages for a specific user
    const messages = await query(
      `SELECT id, phone_number, direction, body, media_url, twilio_sid, created_at
       FROM whatsapp_messages WHERE phone_number = $1
       ORDER BY created_at ASC`,
      [phone]
    );
    const conv = await query(
      `SELECT state, listing_url, input_data, asking_price, tease_data, updated_at
       FROM conversations WHERE phone_number = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [phone]
    );
    const orders = await query(
      `SELECT id, price_zar, payment_status, created_at
       FROM orders WHERE phone_number = $1
       ORDER BY created_at DESC`,
      [phone]
    );
    return NextResponse.json({
      phone,
      messages,
      conversation: conv[0] || null,
      orders,
    });
  }

  // List all users with message counts
  const users = await query(`
    SELECT
      wm.phone_number,
      COUNT(*) AS total_messages,
      COUNT(*) FILTER (WHERE wm.direction = 'inbound') AS inbound,
      COUNT(*) FILTER (WHERE wm.direction = 'outbound') AS outbound,
      MAX(wm.created_at) AS last_message_at,
      MIN(wm.created_at) AS first_message_at,
      c.state,
      c.listing_url,
      (SELECT COUNT(*) FROM orders o WHERE o.phone_number = wm.phone_number) AS order_count,
      (SELECT COUNT(*) FROM orders o WHERE o.phone_number = wm.phone_number AND o.payment_status = 'paid') AS paid_count
    FROM whatsapp_messages wm
    LEFT JOIN LATERAL (
      SELECT state, listing_url FROM conversations
      WHERE phone_number = wm.phone_number
      ORDER BY updated_at DESC LIMIT 1
    ) c ON true
    GROUP BY wm.phone_number, c.state, c.listing_url
    ORDER BY MAX(wm.created_at) DESC
  `);

  return NextResponse.json({ users });
});
