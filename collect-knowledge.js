/**
 * SA Construction & Property Knowledge Collector
 *
 * Scrapes SA construction, DIY, housing, and gardening knowledge from
 * publicly available web sources. Uses Claude to extract structured
 * defect/material/standard entries for Nico's knowledge base.
 *
 * Sources:
 * - SA building standards and compliance (SANS, NHBRC)
 * - SA construction cost guides
 * - Property defect databases
 * - Regional construction material knowledge
 * - DIY and home maintenance guides (SA-specific)
 */
const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const client = new Anthropic();

// ─── SA-specific knowledge sources ──────────────────────────────────────
// Each source has a URL, topic category, and extraction focus
const KNOWLEDGE_SOURCES = [
  // SA building defects and inspection
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/common-building-defects-and-how-to-spot-them', topic: 'defects', focus: 'Common SA building defects, visual indicators, repair methods' },
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/damp-in-your-home', topic: 'damp', focus: 'Damp types in SA homes, causes, treatment costs' },
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/roof-types-south-africa', topic: 'roof', focus: 'SA roof types, materials, common problems, lifespan' },
  { url: 'https://www.sahomeowner.co.za/home-improvement/plumbing', topic: 'plumbing', focus: 'SA plumbing standards, pipe materials, geyser regulations' },
  { url: 'https://www.sahomeowner.co.za/home-improvement/electrical', topic: 'electrical', focus: 'SA electrical compliance, ECoC, DB board standards' },

  // SA construction costs
  { url: 'https://www.statssa.gov.za/publications/P0141/P0141January2024.pdf', topic: 'costs', focus: 'SA building material costs, construction cost indices' },

  // Asbestos in SA
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/asbestos-in-south-african-homes', topic: 'asbestos', focus: 'Asbestos identification, regulations, removal costs in SA' },

  // SA garden and landscaping
  { url: 'https://www.sahomeowner.co.za/gardening/indigenous-plants-for-south-african-gardens', topic: 'garden', focus: 'Indigenous plants, water-wise gardening, garden walls' },

  // Structural issues
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/foundation-problems', topic: 'structure', focus: 'Foundation issues in SA, dolomite risk, subsidence signs' },

  // Compliance and regulations
  { url: 'https://www.nhbrc.org.za/home-building-manual/', topic: 'compliance', focus: 'NHBRC standards, building regulations, warranty requirements' },

  // Waterproofing
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/waterproofing-your-home', topic: 'damp', focus: 'Waterproofing methods, DPC, flat roof waterproofing costs' },

  // Security features
  { url: 'https://www.sahomeowner.co.za/home-improvement/security', topic: 'security', focus: 'SA home security features, electric fencing, burglar bars, CCTV' },

  // Paint and external walls
  { url: 'https://www.sahomeowner.co.za/building-and-renovating/exterior-paint-guide', topic: 'walls', focus: 'Exterior paint types, wall coating, crack treatment, SA weather impact' },

  // Solar in SA
  { url: 'https://www.sahomeowner.co.za/home-improvement/solar-power', topic: 'solar', focus: 'Solar installation SA, inverter types, compliance, roof suitability' },
];

function fetchPage(url, timeout = 15000) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SurePath Knowledge Collector',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, timeout).then(resolve);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
  });
}

/**
 * Strip HTML to get readable text content.
 * Keeps structure (headings, lists, paragraphs) but removes tags.
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 12000); // Limit to ~12k chars to fit in Claude context
}

/**
 * Use Claude to extract structured KB entries from scraped web content.
 */
async function extractKnowledgeEntries(text, source) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: `You are a South African property inspection expert building a knowledge base for an AI vision system that analyses property photos.

Extract SPECIFIC, ACTIONABLE knowledge entries from the provided web content. Each entry should teach the vision system something it can use when looking at property photos.

GOOD entries have:
- A specific defect, material, or building feature with VISUAL INDICATORS (what to look for in a photo)
- SA-specific context (why this matters in South Africa — regional climate, building era, local materials, regulations)
- Severity (1-5 scale: 1=cosmetic, 2=low, 3=medium, 4=high, 5=critical)
- Cost estimates in ZAR at current SA rates (if available from the content)
- A category: roof, walls, damp, electrical, plumbing, ceiling, structure, extension, security, environment, solar

BAD entries: generic advice, interior decoration, things invisible in photos, non-SA content.

Return a JSON array. If the content has nothing useful, return an empty array [].

[{
  "name": "Short, specific name (e.g. 'Rising damp — Cape Town coastal face brick')",
  "description": "What this is, why it happens, how it presents",
  "visual_indicators": "Exactly what the AI should look for in photos — colours, patterns, locations on the building",
  "sa_context": "Why this matters specifically in South Africa — era, region, regulation, climate factor",
  "category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension|security|environment|solar",
  "severity": 1-5,
  "cost_min_zar": number or null,
  "cost_max_zar": number or null
}]

Quality over quantity. 2-4 excellent entries per source is ideal. Return ONLY valid JSON.`,
    messages: [{
      role: 'user',
      content: `Extract SA property knowledge entries from this web page.\n\nSource: ${source.url}\nTopic: ${source.topic}\nFocus: ${source.focus}\n\nContent:\n${text}`,
    }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
  try {
    let cleaned = raw;
    if (cleaned.includes('```')) cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const jStart = cleaned.indexOf('[');
    const jEnd = cleaned.lastIndexOf(']');
    if (jStart >= 0 && jEnd > jStart) cleaned = cleaned.substring(jStart, jEnd + 1);
    return JSON.parse(cleaned);
  } catch {
    console.log(`  [WARN] Could not parse Claude response for ${source.url}`);
    return [];
  }
}

/**
 * Main collection function — scrape sources and extract KB entries.
 */
async function collectKnowledge() {
  // Check what we already have to avoid duplicates
  const { rows: existing } = await pool.query(
    'SELECT name, description FROM rag_knowledge_entries'
  );
  const existingNames = new Set(existing.map(e => e.name.toLowerCase()));

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const source of KNOWLEDGE_SOURCES) {
    console.log(`[knowledge] Fetching: ${source.url}`);

    const result = await fetchPage(source.url);
    if (!result.ok) {
      console.log(`  [SKIP] HTTP ${result.status} — ${source.url}`);
      totalErrors++;
      continue;
    }

    const text = htmlToText(result.body);
    if (text.length < 200) {
      console.log(`  [SKIP] Too little content (${text.length} chars)`);
      totalErrors++;
      continue;
    }

    console.log(`  [OK] ${text.length} chars of content, extracting entries...`);

    try {
      const entries = await extractKnowledgeEntries(text, source);

      if (!Array.isArray(entries) || entries.length === 0) {
        console.log(`  [SKIP] No entries extracted`);
        continue;
      }

      for (const entry of entries) {
        if (!entry.name || !entry.category) continue;

        // Skip if we already have something with the same name
        if (existingNames.has(entry.name.toLowerCase())) {
          console.log(`  [DUP] ${entry.name}`);
          totalSkipped++;
          continue;
        }

        await pool.query(
          `INSERT INTO rag_knowledge_entries
           (name, description, visual_indicators, sa_context, severity, cost_min_zar, cost_max_zar, category, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')`,
          [
            entry.name,
            entry.description || null,
            entry.visual_indicators || null,
            entry.sa_context || null,
            entry.severity || 3,
            entry.cost_min_zar || null,
            entry.cost_max_zar || null,
            entry.category,
          ]
        );

        existingNames.add(entry.name.toLowerCase());
        totalCreated++;
        console.log(`  [+] ${entry.name} [${entry.category}, severity ${entry.severity}/5${entry.cost_min_zar ? `, R${entry.cost_min_zar}–R${entry.cost_max_zar}` : ''}]`);
      }
    } catch (err) {
      console.log(`  [ERROR] ${err.message}`);
      totalErrors++;
    }

    // Rate limit — don't hammer sources
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n=== Knowledge collection complete: ${totalCreated} created, ${totalSkipped} duplicates, ${totalErrors} errors ===`);
  return { created: totalCreated, skipped: totalSkipped, errors: totalErrors };
}

// Run directly if called from command line
if (require.main === module) {
  collectKnowledge()
    .then(() => pool.end())
    .catch(err => { console.error(err); pool.end(); process.exit(1); });
}

module.exports = { collectKnowledge };
