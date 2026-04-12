import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

/**
 * Returns the top N trending hashtags suitable for a TikTok/Instagram caption.
 * Mix: brand + highest-ranked trending + location + property baseline.
 */
export const GET = withAuth(async () => {
  const rows = await query(`
    SELECT tag, category, rank, score, source
    FROM trending_hashtags
    WHERE active = TRUE
    ORDER BY
      CASE category WHEN 'brand' THEN 0 WHEN 'tiktok_trending' THEN 1 WHEN 'property' THEN 2 WHEN 'location' THEN 3 ELSE 4 END,
      rank ASC NULLS LAST,
      tag ASC
    LIMIT 15
  `);

  return NextResponse.json({ hashtags: rows });
});
