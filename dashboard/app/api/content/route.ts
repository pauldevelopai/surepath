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
    const { rows: convs } = await query(
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
    const { rows: props } = await query(`
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
      const { rows: imgs } = await query(
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
  const { action, pillar, topic, script, post_id, insight } = await req.json();

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

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: `You are Nico, a South African ex-property agent, aged 38-42. You are calm, direct, and slightly contrarian. You've seen a lot of properties and you don't sugarcoat things. You create short-form video scripts for Instagram Reels and TikTok about property risks in South Africa.

Your style: punchy, direct, no fluff. Every video has a strong hook in the first 3 seconds, builds tension with real findings, and ends with a clear CTA to use Surepath. Write in plain conversational South African English. Do not use estate agent language. Do not say "however" or "that said".

Content pillars:
- Warning: "Don't buy until you read this" style
- Comparison: Before/after, good vs bad deals
- Reality Check: Exposing what agents won't tell you
- Inspection Reveal: Showing real defects found by Surepath
- Market Signal: Data-driven market insights

Format your response as JSON:
{
  "hook": "first 3 seconds hook text — must grab attention immediately",
  "script": "full script (60-90 seconds when read aloud). Reference real findings if provided. Be specific, not generic.",
  "cta": "call to action — drive to Surepath WhatsApp or website"
}`,
      messages: [{
        role: "user",
        content: `Create a ${pillar.replace(/_/g, " ")} video script about: ${topic}${insightContext}\n\nReturn JSON only.`,
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
    return NextResponse.json({ audio_url: null, message: "ElevenLabs integration pending — set ELEVENLABS_API_KEY" });
  }

  if (action === "generate_video") {
    return NextResponse.json({ video_url: null, message: "HeyGen integration pending — set HEYGEN_API_KEY" });
  }

  if (action === "compose_final") {
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
