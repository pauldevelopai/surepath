import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const rows = await query(`
    SELECT id, source_url, platform, caption, hashtags, hook_text,
           view_count, like_count, comment_count, share_count, duration_sec,
           niche, hook_style, what_worked, one_line_lesson, score, active, created_at
    FROM viral_lessons ORDER BY active DESC, score DESC NULLS LAST, created_at DESC LIMIT 100
  `);
  return NextResponse.json({ lessons: rows });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const {
    source_url, caption, hashtags, hook_text,
    view_count, like_count, comment_count, share_count, duration_sec, niche,
  } = body;

  if (!caption && !source_url) {
    return NextResponse.json({ error: "caption or source_url required" }, { status: 400 });
  }

  // Use Claude to extract the lesson
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: `You analyse viral TikTok videos in the property/real-estate niche and extract what made them work — for use as training examples for our AI script generator.

Given a viral video's caption, hashtags, hook text and engagement numbers, identify:
1. hook_style: one of "direct attack" | "shock claim" | "insider secret" | "loss warning" | "visual reveal" | "command" | "question hook" | "storytime" | "pattern interrupt"
2. what_worked: 1-2 sentence analysis of the specific technique that drove engagement
3. one_line_lesson: a single actionable rule we can apply to our own scripts (max 20 words)

Be specific and tactical. "Use emotional hooks" is useless. "Open with a rand-amount loss ('You're about to lose R200k') creates urgency" is useful.

Return JSON: { "hook_style": "...", "what_worked": "...", "one_line_lesson": "..." }`,
    messages: [{
      role: "user",
      content: `Analyse this viral TikTok:

Caption: ${caption || '(not provided)'}
Hook text: ${hook_text || '(not provided)'}
Hashtags: ${hashtags || '(not provided)'}
Views: ${view_count || 'unknown'}
Likes: ${like_count || 'unknown'}
Comments: ${comment_count || 'unknown'}
Shares: ${share_count || 'unknown'}
Duration: ${duration_sec || 'unknown'}s
Niche: ${niche || 'property'}

Return JSON only.`,
    }],
  });

  let text = message.content[0].type === "text" ? message.content[0].text : "";
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text);

  // Simple engagement score (for ranking top lessons)
  const views = Number(view_count) || 0;
  const likes = Number(like_count) || 0;
  const comments = Number(comment_count) || 0;
  const shares = Number(share_count) || 0;
  const score = views > 0
    ? ((likes + comments * 3 + shares * 5) / views) * 100000
    : (likes + comments + shares);

  const rows = await query(
    `INSERT INTO viral_lessons
      (source_url, caption, hashtags, hook_text, view_count, like_count,
       comment_count, share_count, duration_sec, niche,
       hook_style, what_worked, one_line_lesson, score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      source_url || null, caption || null, hashtags || null, hook_text || null,
      views || null, likes || null, comments || null, shares || null, duration_sec || null,
      niche || 'property', parsed.hook_style, parsed.what_worked, parsed.one_line_lesson, score,
    ]
  );

  return NextResponse.json({ id: rows[0].id, ...parsed, score });
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await query("DELETE FROM viral_lessons WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
});

export const PATCH = withAuth(async (req: NextRequest) => {
  const { id, active } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await query("UPDATE viral_lessons SET active = $1 WHERE id = $2", [!!active, id]);
  return NextResponse.json({ ok: true });
});
