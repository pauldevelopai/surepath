import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withAuth } from "@/lib/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export const GET = withAuth(async (req: NextRequest) => {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "insights") {
    // Pull tease insights from WhatsApp conversations + properties with vision findings
    const insights: A[] = [];

    // From conversations (tease_data has Nico's analysis)
    const convs = await query(
      "SELECT tease_data, listing_url FROM conversations WHERE tease_data IS NOT NULL ORDER BY updated_at DESC LIMIT 20"
    );
    for (const c of convs) {
      const t = typeof c.tease_data === "string" ? JSON.parse(c.tease_data) : c.tease_data;
      if (t?.address && t?.nicoTease) {
        insights.push({
          source: "whatsapp",
          address: t.address,
          askingPrice: t.askingPrice,
          bedrooms: t.bedrooms,
          bathrooms: t.bathrooms,
          nicoTease: t.nicoTease,
          topRiskFlags: t.topRiskFlags || [],
          listingUrl: c.listing_url,
        });
      }
    }

    // From properties with vision findings (not already in conversations)
    const seenAddresses = new Set(insights.map(i => i.address));
    const props = await query(`
      SELECT p.id, p.address_raw, p.address_normalised, p.asking_price, p.bedrooms, p.bathrooms, p.listing_url
      FROM properties p
      WHERE EXISTS (
        SELECT 1 FROM property_images pi
        WHERE pi.property_id = p.id AND pi.vision_analysis IS NOT NULL
      )
      ORDER BY p.id DESC LIMIT 30
    `);

    for (const p of props) {
      const addr = p.address_normalised || p.address_raw;
      if (seenAddresses.has(addr)) continue;

      // Get top risk flags from vision findings
      const imgs = await query(
        "SELECT vision_analysis FROM property_images WHERE property_id = $1 AND vision_analysis IS NOT NULL LIMIT 6",
        [p.id]
      );
      const flags: string[] = [];
      for (const img of imgs) {
        const va = typeof img.vision_analysis === "string" ? JSON.parse(img.vision_analysis) : img.vision_analysis;
        for (const f of (va?.findings || [])) {
          if ((f.severity === "CRITICAL" || f.severity === "HIGH") && f.observation) {
            flags.push(f.observation);
          }
        }
      }
      if (flags.length > 0) {
        insights.push({
          source: "vision",
          address: addr,
          askingPrice: p.asking_price,
          bedrooms: p.bedrooms,
          bathrooms: p.bathrooms,
          nicoTease: null,
          topRiskFlags: flags.slice(0, 5),
          listingUrl: p.listing_url,
          propertyId: p.id,
        });
      }
    }

    // From Nico's evidence (holly_evidence) — compelling buyer-facing statements
    try {
      const evidence = await query(`
        SELECT he.what_it_means, he.defect_or_risk, he.severity, he.confidence_tier,
               he.image_url, he.property_id,
               p.address_raw, p.suburb, p.asking_price
        FROM holly_evidence he
        JOIN properties p ON p.id = he.property_id
        WHERE he.what_it_means IS NOT NULL AND he.what_it_means != ''
          AND he.severity IN ('CRITICAL', 'HIGH', 'MEDIUM')
        ORDER BY he.created_at DESC LIMIT 10
      `);
      for (const e of evidence) {
        const addr = e.address_raw;
        if (seenAddresses.has(addr)) continue;
        seenAddresses.add(addr);
        insights.push({
          source: "nico_evidence",
          address: addr,
          askingPrice: e.asking_price,
          nicoTease: e.what_it_means,
          topRiskFlags: [e.defect_or_risk].filter(Boolean),
          propertyId: e.property_id,
          severity: e.severity,
          tier: e.confidence_tier,
        });
      }
    } catch {}

    return NextResponse.json({ insights });
  }

  const rows = await query("SELECT * FROM content_posts ORDER BY created_at DESC LIMIT 50");
  return NextResponse.json(rows);
});

export const POST = withAuth(async (req: NextRequest) => {
  const { action, pillar, topic, script, post_id, insight, tease_text } = await req.json();
  // Dynamic require to load Node modules from parent dir (bypass webpack static analysis)
  // eslint-disable-next-line no-eval
  const loadModule = (name: string) => eval('require')(require('path').resolve(process.cwd(), '..', name));

  if (action === "generate_script") {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();

    // Build context from insight if provided
    let insightContext = "";
    if (insight) {
      insightContext = `\n\nReal property insight to base this on:
Property: ${insight.address}
Price: R${insight.askingPrice ? Number(insight.askingPrice).toLocaleString() : "unknown"}
${insight.bedrooms ? `${insight.bedrooms} bed, ${insight.bathrooms || "?"} bath` : ""}
${insight.nicoTease ? `Nico's take: ${insight.nicoTease}` : ""}
Risk flags found:
${(insight.topRiskFlags || []).map((f: string) => `- ${f}`).join("\n")}

Use these REAL findings as the basis for the script. Reference the actual issues found. Do not invent problems that aren't in the risk flags.`;
    }

    // If the user refined the tease text, use it as the hook direction
    const teaseDirection = tease_text
      ? `\n\nThe user has refined the hook to: "${tease_text}". Use this as the opening line or closely adapt it. Do not discard it.`
      : "";

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are Nico — South African, ex-property agent, 38-42. Calm, direct, slightly contrarian. You've inspected hundreds of properties and you don't sugarcoat anything. You make 10-second Instagram Reels and TikToks that stop the scroll.

RULES FOR 10-SECOND VIDEOS:
- Total script must be 25-35 words MAX. That's it. Read it aloud — if it takes more than 10 seconds, cut it.
- Hook (first 2 seconds): one punchy line that makes someone stop scrolling. A question, a shock, or a bold claim.
- Body (5 seconds): one specific finding or insight. Be concrete — name the defect, the number, the risk. No filler.
- CTA (3 seconds): one short line driving to Surepath. "Send me your listing" or "Link in bio — Surepath checks it for free."
- Write in plain South African English. Short sentences. No estate-agent speak. No "however", "that said", "it's important to note".
- Sound like a mate warning you, not a presenter reading a script.

Content pillars:
- Warning: "Don't buy until you see this"
- Comparison: Before/after, good vs bad
- Reality Check: What agents won't tell you
- Inspection Reveal: Real defects Surepath found
- Market Signal: Data-driven market takes

Format as JSON:
{
  "hook": "2-second opening line — must stop the scroll",
  "script": "full 10-second script (25-35 words total including hook and CTA)",
  "cta": "short CTA — 1 sentence max"
}`,
      messages: [{
        role: "user",
        content: `Create a ${pillar.replace(/_/g, " ")} 10-second reel script about: ${topic}${insightContext}${teaseDirection}\n\nReturn JSON only.`,
      }],
    });

    let text = message.content[0].type === "text" ? message.content[0].text : "";
    if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text);

    // Save to DB (include property_id if from insight)
    const propertyId = insight?.propertyId || null;
    const rows = await query(
      `INSERT INTO content_posts (pillar, hook, script, cta, status, property_id)
       VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING id`,
      [pillar, parsed.hook, parsed.script, parsed.cta, propertyId]
    );

    return NextResponse.json({ id: rows[0].id, ...parsed });
  }

  if (action === "update_script") {
    await query("UPDATE content_posts SET script = $1 WHERE id = $2", [script, post_id]);
    return NextResponse.json({ ok: true });
  }

  if (action === "generate_audio") {
    try {
      const { generateVoice } = loadModule('voice.js');
      // Get the script text from the post
      const rows = await query("SELECT script, hook, cta FROM content_posts WHERE id = $1", [post_id]);
      if (!rows[0]) return NextResponse.json({ error: "Post not found" }, { status: 404 });
      const fullScript = `${rows[0].hook}. ${rows[0].script}. ${rows[0].cta}`;
      const audioUrl = await generateVoice(fullScript, undefined, post_id);
      return NextResponse.json({ audio_url: audioUrl, message: "Audio generated" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === "generate_captions") {
    try {
      const { generateCaptions } = loadModule('captions.js');
      const { estimateDuration } = loadModule('voice.js');

      const rows = await query("SELECT audio_url, hook, script, cta FROM content_posts WHERE id = $1", [post_id]);
      if (!rows[0]?.audio_url) return NextResponse.json({ error: "No audio yet" }, { status: 400 });

      // Build full script text and estimate duration from audio file size
      const fullScript = `${rows[0].hook}. ${rows[0].script}. ${rows[0].cta}`;

      // Fetch audio to get file size for duration estimate
      const audioRes = await fetch(rows[0].audio_url, { method: 'HEAD' });
      const contentLength = parseInt(audioRes.headers.get('content-length') || '0');
      const durationSec = contentLength > 0 ? estimateDuration(Buffer.alloc(contentLength)) : 10;

      const srtContent = generateCaptions(fullScript, durationSec);
      await query("UPDATE content_posts SET srt_content = $1 WHERE id = $2", [srtContent, post_id]);
      return NextResponse.json({ message: "Captions generated from script" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === "compose_final") {
    try {
      const { composeVideo } = loadModule('compose.js');
      const rows = await query(
        "SELECT audio_url, srt_content, hook, property_id FROM content_posts WHERE id = $1",
        [post_id]
      );
      if (!rows[0]?.audio_url) return NextResponse.json({ error: "No audio yet" }, { status: 400 });
      if (!rows[0]?.srt_content) return NextResponse.json({ error: "No captions yet — generate captions first" }, { status: 400 });

      const propertyId = rows[0].property_id || null;
      const outputName = `nico-reel-${post_id}-${Date.now()}`;

      const finalUrl = await composeVideo(
        rows[0].audio_url,
        rows[0].srt_content,
        propertyId,
        rows[0].hook,
        outputName,
        post_id
      );
      return NextResponse.json({ final_url: finalUrl, message: "Video composed" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (action === "publish") {
    try {
      const { publishToAll } = loadModule('publish.js');
      const rows = await query("SELECT final_video_url, script, hook, cta FROM content_posts WHERE id = $1", [post_id]);
      if (!rows[0]?.final_video_url) return NextResponse.json({ error: "No final video yet" }, { status: 400 });
      const caption = `${rows[0].hook}\n\n${rows[0].script}\n\n${rows[0].cta}\n\n#surepath #property #southafrica #realestate`;
      const result = await publishToAll(rows[0].final_video_url, caption, post_id);
      return NextResponse.json({ message: "Published", ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
});
