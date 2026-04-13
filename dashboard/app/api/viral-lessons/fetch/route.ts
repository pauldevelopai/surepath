import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";

/**
 * Fetch TikTok video metadata from a public URL.
 * Uses tikwm.com's free public API (no key required).
 * Returns caption, hashtags, views, likes, comments, shares, duration.
 */
export const POST = withAuth(async (req: NextRequest) => {
  const { url } = await req.json();
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=0`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `tikwm returned ${res.status}` }, { status: 502 });
    }
    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      return NextResponse.json({ error: json.msg || "Failed to fetch video data" }, { status: 502 });
    }

    const d = json.data;
    const caption: string = d.title || "";
    const hashtagsFromCaption = (caption.match(/#\w+/g) || []).join(" ");

    return NextResponse.json({
      ok: true,
      source_url: url,
      caption,
      hashtags: hashtagsFromCaption,
      hook_text: caption.split(/[.!?\n]/)[0]?.trim().slice(0, 120) || "",
      view_count: d.play_count || 0,
      like_count: d.digg_count || 0,
      comment_count: d.comment_count || 0,
      share_count: d.share_count || 0,
      duration_sec: d.duration || 0,
      author: d.author?.unique_id || "",
      thumbnail: d.cover || "",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Fetch failed: ${message}` }, { status: 500 });
  }
});
