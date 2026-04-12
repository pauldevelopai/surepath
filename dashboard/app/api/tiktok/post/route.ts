import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const POST = withAuth(async (req: NextRequest) => {
  // eslint-disable-next-line no-eval
  const loadModule = (name: string) => eval('require')(require('path').resolve(process.cwd(), '..', name));
  const { uploadVideo } = loadModule('tiktok.js');

  const { post_id } = await req.json();
  if (!post_id) return NextResponse.json({ error: "post_id required" }, { status: 400 });

  const rows = await query(
    "SELECT final_video_url, script FROM content_posts WHERE id = $1",
    [post_id]
  );
  if (!rows[0]?.final_video_url) {
    return NextResponse.json({ error: "No final video for this post" }, { status: 400 });
  }

  // Pull trending hashtags from DB (refreshed by the trending scraper)
  const tagRows = await query(`
    SELECT tag FROM trending_hashtags WHERE active = TRUE
    ORDER BY
      CASE category WHEN 'brand' THEN 0 WHEN 'tiktok_trending' THEN 1 WHEN 'property' THEN 2 WHEN 'location' THEN 3 ELSE 4 END,
      rank ASC NULLS LAST
    LIMIT 12
  `);
  const hashtags = tagRows.map((r) => `#${r.tag}`).join(' ') || '#surepath #property #southafrica #realestate';

  // WhatsApp contact goes FIRST in the caption so viewers see it before anything else
  const caption = `WhatsApp: +27 79 219 8649\n\n${rows[0].script}\n\nGet your Surepath property report — we find the hidden risks nobody else tells you about.\n\n${hashtags}`;

  try {
    const result = await uploadVideo(rows[0].final_video_url, caption);
    await query(
      "UPDATE content_posts SET tiktok_post_id = $1, status = 'posted', posted_at = NOW() WHERE id = $2",
      [result.publish_id, post_id]
    );
    return NextResponse.json({ message: "Posted to TikTok", ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
