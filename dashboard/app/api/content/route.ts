import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

export const GET = withAuth(async () => {
  const rows = await query("SELECT * FROM content_posts ORDER BY created_at DESC LIMIT 50");
  return NextResponse.json(rows);
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, pillar, topic, script, post_id } = await req.json();

  if (action === "generate_script") {
    // Call Claude API to generate script
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();

    const message = await client.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 2048,
      system: `You are Nico, a South African property expert who creates short-form video content. You speak with authority and urgency. Your style: punchy, direct, no fluff. Every video has a strong hook in the first 3 seconds, builds tension, and ends with a clear CTA to use Surepath.

Content pillars:
- Warning: "Don't buy until you read this" style
- Comparison: Before/after, good vs bad deals
- Reality Check: Exposing what agents won't tell you
- Inspection Reveal: Showing real defects found by Surepath
- Market Signal: Data-driven market insights

Format your response as JSON:
{
  "hook": "first 3 seconds hook text",
  "script": "full script (60-90 seconds when read aloud)",
  "cta": "call to action text"
}`,
      messages: [{
        role: "user",
        content: `Create a ${pillar} video about: ${topic}\n\nReturn JSON only.`,
      }],
    });

    let text = message.content[0].type === "text" ? message.content[0].text : "";
    if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text);

    // Save to DB
    const rows = await query(
      `INSERT INTO content_posts (pillar, hook, script, cta, status)
       VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [pillar, parsed.hook, parsed.script, parsed.cta]
    );

    return NextResponse.json({ id: rows[0].id, ...parsed });
  }

  if (action === "update_script") {
    await query("UPDATE content_posts SET script = $1 WHERE id = $2", [script, post_id]);
    return NextResponse.json({ ok: true });
  }

  if (action === "generate_audio") {
    // ElevenLabs placeholder
    return NextResponse.json({ audio_url: null, message: "ElevenLabs integration pending — set ELEVENLABS_API_KEY" });
  }

  if (action === "generate_video") {
    // HeyGen placeholder
    return NextResponse.json({ video_url: null, message: "HeyGen integration pending — set HEYGEN_API_KEY" });
  }

  if (action === "compose_final") {
    // FFmpeg placeholder
    return NextResponse.json({ final_url: null, message: "FFmpeg composition pending — server-side processing" });
  }

  if (action === "publish") {
    await query(
      "UPDATE content_posts SET status = 'posted', posted_at = NOW() WHERE id = $1",
      [post_id]
    );
    return NextResponse.json({ message: "Publishing to Instagram, TikTok, YouTube — API integrations pending" });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
