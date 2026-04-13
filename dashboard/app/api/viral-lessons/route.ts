import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const rows = await query(`
    SELECT id, source_url, platform, caption, hashtags, hook_text,
           view_count, like_count, comment_count, share_count, duration_sec,
           niche, hook_style, what_worked, one_line_lesson, score, active,
           is_own_content, rag_chunk_key, created_at
    FROM viral_lessons ORDER BY active DESC, is_own_content DESC, score DESC NULLS LAST, created_at DESC LIMIT 100
  `);
  return NextResponse.json({ lessons: rows });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const {
    source_url, caption, hashtags, hook_text,
    view_count, like_count, comment_count, share_count, duration_sec, niche,
    is_own_content,
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
  let score = views > 0
    ? ((likes + comments * 3 + shares * 5) / views) * 100000
    : (likes + comments + shares);
  // Our own viral content gets a big boost so it surfaces first in the top 6
  if (is_own_content) score = score * 10 + 10000;

  const rows = await query(
    `INSERT INTO viral_lessons
      (source_url, caption, hashtags, hook_text, view_count, like_count,
       comment_count, share_count, duration_sec, niche,
       hook_style, what_worked, one_line_lesson, score, is_own_content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      source_url || null, caption || null, hashtags || null, hook_text || null,
      views || null, likes || null, comments || null, shares || null, duration_sec || null,
      niche || 'property', parsed.hook_style, parsed.what_worked, parsed.one_line_lesson,
      score, !!is_own_content,
    ]
  );
  const lessonId = rows[0].id;

  // Seed into RAG so the script generator can retrieve relevant lessons semantically
  try {
    // eslint-disable-next-line no-eval
    const loadModule = (name: string) => eval('require')(require('path').resolve(process.cwd(), '..', name));
    const { upsertChunk } = loadModule('rag.js');

    const marker = is_own_content ? 'SUREPATH OWN VIRAL VIDEO' : 'VIRAL REFERENCE';
    const chunkText = [
      `${marker} [${parsed.hook_style}]`,
      hook_text ? `Hook: "${hook_text}"` : null,
      `What worked: ${parsed.what_worked}`,
      `Lesson: ${parsed.one_line_lesson}`,
      caption ? `Full caption: ${caption.substring(0, 300)}` : null,
    ].filter(Boolean).join('\n');

    const chunkKey = `viral_lesson_${lessonId}`;
    await upsertChunk(chunkText, {
      hook_style: parsed.hook_style,
      is_own: !!is_own_content,
      score,
      source_url: source_url || null,
    }, 'viral_lesson', 'viral_lessons', lessonId, chunkKey);

    await query('UPDATE viral_lessons SET rag_chunk_key = $1 WHERE id = $2', [chunkKey, lessonId]);
  } catch (e) {
    console.error('[viral-lessons] RAG seeding failed:', e);
  }

  return NextResponse.json({ id: lessonId, ...parsed, score, is_own_content: !!is_own_content });
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
