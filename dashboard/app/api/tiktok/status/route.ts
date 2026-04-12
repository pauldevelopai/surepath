import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const rows = await query(
    "SELECT open_id, display_name, access_token_expires_at, is_active FROM tiktok_accounts WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1"
  );

  const clientKey = process.env.TIKTOK_CLIENT_KEY;

  if (rows.length === 0) {
    return NextResponse.json({
      connected: false,
      configured: !!clientKey,
    });
  }

  return NextResponse.json({
    connected: true,
    configured: !!clientKey,
    account: {
      open_id: rows[0].open_id,
      display_name: rows[0].display_name,
      expires_at: rows[0].access_token_expires_at,
    },
  });
});
