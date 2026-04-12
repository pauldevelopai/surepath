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
    // LEFT JOIN to properties so we can pull photos for the video
    const convs = await query(`
      SELECT c.tease_data, c.listing_url, p.id AS property_id
      FROM conversations c
      LEFT JOIN properties p ON p.listing_url = c.listing_url
      WHERE c.tease_data IS NOT NULL
      ORDER BY c.updated_at DESC LIMIT 20
    `);
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
          propertyId: c.property_id || null,
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

    // Flag insights that already have a video generated from them
    // Lookup: property_id → { count, lastPosted, anyPosted }
    const videoStats = await query(`
      SELECT property_id,
             COUNT(*) AS video_count,
             MAX(created_at) AS last_created,
             BOOL_OR(tiktok_post_id IS NOT NULL OR instagram_post_id IS NOT NULL OR youtube_post_id IS NOT NULL) AS any_posted
      FROM content_posts
      WHERE property_id IS NOT NULL
      GROUP BY property_id
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statsByProperty = new Map<number, A>();
    for (const row of videoStats) {
      statsByProperty.set(Number(row.property_id), {
        videoCount: Number(row.video_count),
        lastCreated: row.last_created,
        anyPosted: row.any_posted,
      });
    }

    for (const ins of insights) {
      if (ins.propertyId && statsByProperty.has(ins.propertyId)) {
        const s = statsByProperty.get(ins.propertyId)!;
        ins.videoCount = s.videoCount;
        ins.lastVideoAt = s.lastCreated;
        ins.anyPosted = s.anyPosted;
      } else {
        ins.videoCount = 0;
      }
    }

    return NextResponse.json({ insights });
  }

  if (action === "list") {
    const page = Math.max(1, parseInt(req.nextUrl.searchParams.get("page") || "1"));
    const perPage = 10;
    const offset = (page - 1) * perPage;

    const countRows = await query("SELECT COUNT(*)::int AS n FROM content_posts");
    const total = countRows[0].n;

    const rows = await query(`
      SELECT cp.id, cp.pillar, cp.hook, cp.script, cp.cta, cp.status,
             cp.audio_url, cp.final_video_url, cp.srt_content,
             cp.tiktok_post_id, cp.instagram_post_id, cp.youtube_post_id,
             cp.property_id, cp.posted_at, cp.created_at, cp.downloaded_at,
             p.address_raw, p.address_normalised, p.asking_price
      FROM content_posts cp
      LEFT JOIN properties p ON p.id = cp.property_id
      ORDER BY cp.created_at DESC
      LIMIT $1 OFFSET $2
    `, [perPage, offset]);
    return NextResponse.json({ videos: rows, page, perPage, total, totalPages: Math.ceil(total / perPage) });
  }

  if (action === "mark_downloaded") {
    return NextResponse.json({ error: "use POST" }, { status: 400 });
  }

  const rows = await query("SELECT * FROM content_posts ORDER BY created_at DESC LIMIT 50");
  return NextResponse.json(rows);
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await query("DELETE FROM content_posts WHERE id = $1", [id]);
  return NextResponse.json({ ok: true });
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

    // Viral lesson context — inject top active lessons as few-shot examples
    let viralContext = "";
    try {
      const lessonRows = await query(`
        SELECT hook_style, one_line_lesson, hook_text, what_worked
        FROM viral_lessons WHERE active = TRUE
        ORDER BY score DESC NULLS LAST, created_at DESC
        LIMIT 6
      `);
      if (lessonRows.length > 0) {
        viralContext = `\n\nVIRAL LESSONS — proven techniques from TikTok videos that went viral in this niche. Apply them:\n` +
          lessonRows.map((l, i) => `${i + 1}. [${l.hook_style}] ${l.one_line_lesson}${l.hook_text ? ` — e.g. "${l.hook_text}"` : ''}`).join('\n');
      }
    } catch (e) {
      console.error('[content] viral lessons query failed:', e);
    }

    // RAG retrieval — pull real defect knowledge, costs, SA context
    let ragContext = "";
    try {
      const { retrieve, formatForPrompt } = loadModule('rag.js');
      // Build a query from topic + top risk flag for best matching
      const queryParts = [topic];
      if (insight?.topRiskFlags?.[0]) queryParts.push(insight.topRiskFlags[0]);
      if (tease_text) queryParts.push(tease_text);
      const query = queryParts.filter(Boolean).join(' ');

      const chunks = await retrieve(query, { topK: 8, minScore: 0.4 });
      if (chunks && chunks.length > 0) {
        const formatted = formatForPrompt(chunks);
        ragContext = `\n\nREAL KNOWLEDGE BASE (use ONLY these facts — do NOT fabricate numbers, timeframes, or details beyond what's here):\n${formatted}`;
      }
    } catch (e) {
      console.error('[content] RAG retrieval failed:', e);
    }

    // If the user refined the tease text, use it as the hook direction
    const teaseDirection = tease_text
      ? `\n\nThe user has refined the hook to: "${tease_text}". Use this as the opening line or closely adapt it. Do not discard it.`
      : "";

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are Nico — South African ex-property agent, 38-42. You've inspected hundreds of homes and watched people lose their life savings on bad buys. You make 10-second TikToks and Reels that go viral because they scare people into checking a property before they buy it.

YOUR ANGLE:
Buying a house is the biggest decision most people make. A single missed problem costs them their deposit, their savings, sometimes their marriage. Surepath exposes the hidden secrets on a property — the stuff the agent, the seller, and the listing site will NEVER tell you. Every script positions Surepath as the insider that reveals what nobody else will.

CURRENCY RULE — ALWAYS SPELL OUT AMOUNTS IN WORDS:
The voice is ElevenLabs, which reads "R580k" as garbled letters. NEVER write "R" as a prefix.
- WRONG: "R580k", "R1.2m", "R580,000", "R100k"
- RIGHT: "five hundred and eighty thousand rand", "one point two million rand", "a hundred thousand rand"
- For the asking price given in the insight, convert it to words. E.g. R5 120 000 → "five point one million rand".
- Use "rand" (singular, never "rands") — that's the correct South African usage when spoken.
- If you don't want to say the exact number, use general terms: "half a million", "over a million", "R580k" is BANNED — say "just under six hundred thousand rand" or similar.

NO FABRICATION RULE — ZERO TOLERANCE:
You may ONLY use numbers that are EXPLICITLY provided in the INSIGHT section (asking price, bedrooms, bathrooms) or the KNOWLEDGE BASE section below (specific cost ranges).
NEVER invent:
- Specific rand amounts (NOT "R25,000 disaster", NOT "R180k to replace")
- Timeframes ("24 hours", "3 days", "2 weeks")
- Percentages ("73% of flats", "9 out of 10")
- Counts ("500 homes", "hundreds of clients")
- Sample statistics

INSTEAD, use plain-language stakes:
- "thousands in repairs"
- "years of hidden debt"
- "a disaster waiting"
- "your whole deposit"
- "a debt bomb"

If you need to name a cost, ONLY use cost ranges that appear in the knowledge base, formatted naturally. If there's no specific number available, don't make one up.

STRUCTURE — three SEPARATE fields that will be concatenated for audio:
hook + script + cta = the complete spoken video.
DO NOT repeat the hook inside the script field. DO NOT repeat content across fields. Every word counts — wasted words kill virality.

Total word budget: 22-28 words MAXIMUM across ALL THREE fields combined.
This is the HARDEST rule. 30 words ≈ 12 seconds of speech. 38 words ≈ 18 seconds. TOO LONG.
Aim for 25 words. Read aloud at conversational pace — must fit in 10 seconds.
- hook: 4-6 words
- script: 10-14 words (the middle — punch + stakes)
- cta: 7-10 words (tactical advice + Surepath as insider)
Count your words. If total exceeds 28, rewrite — cut adjectives, cut softeners, cut setup.

THE VIRAL FORMULA — FOLLOW EXACTLY:

1. HOOK (0-2 seconds, 5-8 words):
   SALACIOUS. ACCUSATORY. SCROLL-STOPPING. The hook must feel like a scandal or an attack.
   It must create immediate emotion: fear, outrage, curiosity, disbelief.
   IMPORTANT: the first words should reference something the viewer SEES in the opening frame — a real property photo (exterior, kitchen, bathroom, etc). Phrases like "This house...", "This flat...", "This kitchen...", "Look at this...", "See this..." work because they LAND on the image. Don't open with something abstract that doesn't match a real photo.

   FORBIDDEN hook patterns — do NOT use these:
   - Describing the property ("Durban CBD flat. R580k. Looks reasonable.") — BORING SETUP, not a hook
   - Questions ("Is this a good deal?") — questions lose on TikTok
   - Soft openers ("Here's why...", "Let me tell you...", "So I saw...")
   - Anything with "actually", "honestly", "maybe"
   - Stating facts the viewer already sees

   REQUIRED — use ONE of these viral patterns:
   - DIRECT ACCUSATION: "Your agent is hiding this." / "They lied to you about this flat."
   - LOSS ALARM: "You're about to lose R200k." / "This listing just cost you your deposit."
   - COMMAND: "Stop. Don't sign that." / "Walk away. Right now."
   - TABOO TRUTH: "Nobody talks about what's in the walls here." / "The levies are a scam."
   - SHOCK AUTHORITY: "I opened the DB board. I nearly vomited." / "500 inspections. Never seen this."
   - DEBT BOMB: "You're buying a debt bomb." / "This flat is a trap."
   - PUBLIC SHAMING: "Whoever listed this should be in jail." / "This is how agents rob you."

   The hook should feel like it was screamed at you across a bar. Not presented. Not narrated. ATTACKED.

2. PUNCH + STAKES (goes in the 'script' field, 12-18 words):
   The middle of the video. Deliver ONE specific, visceral finding, THEN name what they lose.
   - GOOD: "The roof beams are rotten. R180k to replace. Agent hid it. That's your deposit gone."
   - BAD: "Get the body corporate statements" (that's homework, not a punch)
   - Must be something the viewer can SEE in their head.
   - Name the money, the defect, the consequence. Be concrete.

3. CTA (goes in the 'cta' field, 8-12 words) — THE MOST IMPORTANT PART:
   Give REAL TACTICAL ADVICE the viewer can act on TODAY. Then position Surepath as the source of the hidden secrets nobody else will tell them.

   THE FORMULA: [specific tactical advice] + [Surepath as the source of hidden truths].

   GOOD examples (real advice + Surepath as insider):
   - "Demand three years of levy statements. Surepath knows what the agent won't tell you."
   - "Check the DB board behind the panel. Surepath shows you the hidden ones."
   - "Ask for the CoC. Surepath has the real compliance history."
   - "Walk the street at 8pm. Surepath has the crime data the listing hides."
   - "Read the body corporate minutes. Surepath flags the debt nobody mentions."

   BAD examples (do NOT write these):
   - "DM me the listing" (demand, no advice)
   - "Surepath checks it in 24 hours" (FABRICATION — no such timeframe is promised)
   - "Surepath checks it for free" (maybe true, maybe not — don't promise specifics)
   - "Link in bio" / "Check out Surepath" (no value)
   - Any specific timeframe, price, or guarantee that wasn't given to you

   Position Surepath as: the insider who knows the secrets. The source of the truth the agent, the seller, and the listing site are hiding. NOT a "service" or "app" or "check-in-X-hours" tool.

   The viewer should walk away having LEARNED something — even if they never use Surepath. That's what makes them share, save, and come back.

HARD RULES:
- Total: 25-35 words MAX across all 4 sections
- No estate-agent speak: no "property", say "house" or "flat". No "acquire", say "buy".
- No softeners: no "actually", "maybe", "a bit", "slightly", "however", "that said"
- No generic advice: every line must be specific to the property or shocking as a statement
- South African English. Use SA context (load-shedding, rates, levies, CoC, body corporate)
- Sound URGENT. Sound ALARMED. This is someone warning their mate, not a presenter.

CONTENT PILLARS (adapt formula to pillar):
- Warning: lead with the loss ("You're about to lose R580k")
- Comparison: lead with the gap ("Same street. R400k difference. Here's why.")
- Reality Check: lead with the lie ("Your agent lied about this.")
- Inspection Reveal: lead with the horror ("I opened the DB board. Asbestos.")
- Market Signal: lead with the data ("73% of Durban flats have this problem.")

Format as JSON — ONE complete script that flows hook → punch → stakes → CTA as a single spoken piece:
{
  "script": "The COMPLETE 22-28 word script that the voice will read aloud. Must flow naturally from salacious opener through specific finding + stakes to real tactical advice with Surepath as insider."
}

CRITICAL RULES:
- Total script = 22-28 words MAXIMUM. At conversational pace, 25 words ≈ 10 seconds.
- One flowing monologue — no section headers, no labels, just the spoken lines.
- Every word earns its place. Cut filler. No "actually", "honestly", "basically".

Before returning: count your words. If over 28, cut ruthlessly. Read the opener aloud — if it doesn't feel like you're yelling at a mate who's about to make a mistake, rewrite it. Check the ending — did you give real tactical advice, or just demand a DM? Real advice wins.`,
      messages: [{
        role: "user",
        content: `Create a ${pillar.replace(/_/g, " ")} 10-second viral reel script about: ${topic}${insightContext}${viralContext}${ragContext}${teaseDirection}\n\nRemember: apply the viral lessons where relevant. 22-28 words TOTAL. NO fabrication. NO repetition. Return JSON only.`,
      }],
    });

    let text = message.content[0].type === "text" ? message.content[0].text : "";
    if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text);

    // Save to DB — hook/cta columns kept for backwards compat but we only use script
    const propertyId = insight?.propertyId || null;
    const firstSentence = (parsed.script.split(/[.!?]/)[0] || '').trim();
    const lastSentence = (parsed.script.split(/[.!?]/).filter(Boolean).pop() || '').trim();
    const rows = await query(
      `INSERT INTO content_posts (pillar, hook, script, cta, status, property_id)
       VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING id`,
      [pillar, firstSentence, parsed.script, lastSentence, propertyId]
    );

    return NextResponse.json({ id: rows[0].id, script: parsed.script });
  }

  if (action === "update_script") {
    await query("UPDATE content_posts SET script = $1 WHERE id = $2", [script, post_id]);
    return NextResponse.json({ ok: true });
  }

  if (action === "mark_downloaded") {
    await query("UPDATE content_posts SET downloaded_at = NOW() WHERE id = $1", [post_id]);
    return NextResponse.json({ ok: true });
  }

  if (action === "generate_audio") {
    try {
      const { generateVoice } = loadModule('voice.js');
      const rows = await query("SELECT script FROM content_posts WHERE id = $1", [post_id]);
      if (!rows[0]?.script) return NextResponse.json({ error: "No script yet" }, { status: 400 });
      const audioUrl = await generateVoice(rows[0].script, undefined, post_id);
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

      const rows = await query("SELECT audio_url, script FROM content_posts WHERE id = $1", [post_id]);
      if (!rows[0]?.audio_url) return NextResponse.json({ error: "No audio yet" }, { status: 400 });

      const audioRes = await fetch(rows[0].audio_url, { method: 'HEAD' });
      const contentLength = parseInt(audioRes.headers.get('content-length') || '0');
      const durationSec = contentLength > 0 ? estimateDuration(Buffer.alloc(contentLength)) : 10;

      const srtContent = generateCaptions(rows[0].script, durationSec);
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
      const { buildShotList } = loadModule('visuals.js');
      const { estimateDuration } = loadModule('voice.js');

      const rows = await query(
        "SELECT audio_url, srt_content, script, property_id FROM content_posts WHERE id = $1",
        [post_id]
      );
      if (!rows[0]?.audio_url) return NextResponse.json({ error: "No audio yet" }, { status: 400 });
      if (!rows[0]?.srt_content) return NextResponse.json({ error: "No captions yet — generate captions first" }, { status: 400 });

      const propertyId = rows[0].property_id || null;
      const outputName = `nico-reel-${post_id}-${Date.now()}`;

      // Build shot list — break script into beats and match visuals
      const fullScript = rows[0].script;
      const audioHead = await fetch(rows[0].audio_url, { method: 'HEAD' });
      const audioBytes = parseInt(audioHead.headers.get('content-length') || '0');
      const durationSec = audioBytes > 0 ? estimateDuration(Buffer.alloc(audioBytes)) : 10;

      let shotList = null;
      try {
        shotList = await buildShotList(fullScript, durationSec, propertyId);
      } catch (e) {
        console.error('[content] Shot list build failed, compose will use fallback:', e);
      }

      const firstSentence = (rows[0].script.split(/[.!?]/)[0] || '').trim();
      const finalUrl = await composeVideo(
        rows[0].audio_url,
        rows[0].srt_content,
        propertyId,
        firstSentence,
        outputName,
        post_id,
        shotList
      );
      return NextResponse.json({ final_url: finalUrl, shots: shotList?.length || 0, message: "Video composed" });
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
