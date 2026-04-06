"use client";
import { useEffect, useState, useCallback, Fragment } from "react";
import { formatZAR, formatDate, severityColor } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const APPLICATIONS: { system: string; name: string; segment: string; status: string; description: string }[] = [
  { system: "property_intelligence", name: "Consumer Buyer Reports", segment: "consumer", status: "primary", description: "Full property inspection reports for individual buyers" },
  { system: "property_intelligence", name: "Insurance Risk Scoring API", segment: "b2b", status: "planned", description: "Risk score endpoint for insurance underwriters" },
  { system: "property_intelligence", name: "Negotiation Strategy Engine", segment: "b2b", status: "building", description: "Data-driven offer recommendations for buyer agents" },
  { system: "property_intelligence", name: "Security Company Heat Maps", segment: "b2b", status: "planned", description: "Crime density + response coverage maps by suburb" },
  { system: "property_intelligence", name: "Solar Canvassing Lists", segment: "b2b", status: "planned", description: "Roof suitability + orientation scoring for solar installers" },
  { system: "vision_condition", name: "Property Condition Reports", segment: "consumer", status: "primary", description: "Visual defect detection and severity scoring" },
  { system: "vision_condition", name: "Insurance Photo Assessment API", segment: "b2b", status: "future", description: "Automated photo-based risk classification for insurers" },
  { system: "vision_condition", name: "Trades Lead Qualifier", segment: "b2b", status: "future", description: "Match defect findings to trade contractors with cost estimates" },
  { system: "vision_condition", name: "Pre-Purchase Inspection Triage", segment: "consumer", status: "future", description: "Prioritise which properties need physical inspection" },
  { system: "vision_condition", name: "Home Maintenance Scheduler", segment: "consumer", status: "future", description: "Recurring maintenance alerts based on building age and materials" },
];

const STATUS_BADGE: Record<string, string> = {
  primary: "bg-green-100 text-green-800",
  building: "bg-blue-100 text-blue-800",
  planned: "bg-yellow-100 text-yellow-800",
  future: "bg-gray-100 text-gray-600",
};

const SCORE_LABELS = ["Specificity", "Accuracy", "Actionability", "Consistency"];

// Starter defect entries — common SA-specific defects to seed the knowledge base
const STARTER_ENTRIES: Omit<A, "id">[] = [
  { name: "Rising Damp (Cape Town)", category: "damp", severity: 4, cost_min_zar: 15000, cost_max_zar: 60000, status: "draft",
    description: "Moisture rising through masonry from ground level due to failed or absent damp-proof course (DPC). Common in pre-1970s Cape Town homes built on clay soils.",
    visual_indicators: "White salt deposits (efflorescence) on lower walls up to ~1m height. Peeling paint at skirting level. Tide-mark staining. Damp smell in closed rooms. Bubbling plaster.",
    sa_context: "Cape Town winter rainfall + clay-heavy soils in Southern Suburbs and Atlantic Seaboard make rising damp endemic. DPC injection costs R300–R500/linear metre. Full replaster after treatment adds R15K–R30K." },
  { name: "Asbestos Cement Sheeting", category: "roof", severity: 5, cost_min_zar: 25000, cost_max_zar: 120000, status: "draft",
    description: "Corrugated or flat cement roofing sheets containing asbestos fibres. Banned in SA since 2008 but present in most pre-1990 buildings.",
    visual_indicators: "Grey corrugated sheets with weathered/chalky surface. Moss or lichen growth common. Sheets may show longitudinal cracking. Different texture from modern fibre-cement (Nutec). Often has old-style ridge caps.",
    sa_context: "Asbestos removal requires licensed contractor per OHS Act. Encapsulation (painting) cheaper at R80–R120/m² but temporary. Full removal R250–R400/m². Sectional title schemes often defer this — check body corporate minutes." },
  { name: "DB Board Non-Compliance", category: "electrical", severity: 5, cost_min_zar: 8000, cost_max_zar: 25000, status: "draft",
    description: "Distribution board (DB board) that does not comply with SANS 10142-1. Required for valid Electrical Certificate of Compliance (ECoC) at property transfer.",
    visual_indicators: "Old-style rewirable fuses instead of circuit breakers. Missing earth leakage (RCD) unit. No surge protection. Exposed wiring. Scorch marks. Board too small for number of circuits. Non-standard breakers.",
    sa_context: "ECoC mandatory for all property sales in SA. Non-compliant DB board is the #1 reason for ECoC failure. Replacement cost R8K–R15K for standard home, R15K–R25K for larger properties with sub-boards. Seller must provide valid ECoC." },
  { name: "Structural Cracking (Foundation Settlement)", category: "structure", severity: 4, cost_min_zar: 20000, cost_max_zar: 150000, status: "draft",
    description: "Diagonal or stair-step cracks in masonry walls indicating differential foundation settlement. Width >3mm requires engineering assessment.",
    visual_indicators: "Diagonal cracks running corner-to-corner on walls. Stair-step pattern following mortar joints in face brick. Cracks wider at top than bottom (or vice versa). Doors/windows that stick or show gaps. Cracks that recur after repair.",
    sa_context: "Common in Joburg dolomite areas and Cape Flats sandy soils. Engineer's report R5K–R15K. Underpinning costs R20K–R150K depending on extent. Check for proximity to large trees (root heave). Clay soils expand/contract seasonally." },
  { name: "Galvanised Pipe Corrosion", category: "plumbing", severity: 3, cost_min_zar: 15000, cost_max_zar: 45000, status: "draft",
    description: "Internal corrosion of galvanised steel water pipes causing reduced flow, brown water, and eventual leaks. Universal in pre-1990 SA homes that haven't been replumbed.",
    visual_indicators: "Visible rust staining at pipe joints. Green/white mineral deposits on galvanised pipes. Reduced water pressure at taps furthest from meter. Brown water on first use in morning. Pipe diameter visibly narrowed at cut sections.",
    sa_context: "Most SA homes pre-1990 have galvanised pipes. Full replumb to CPVC or copper costs R15K–R45K. Often discovered during renovation when walls are opened. Insurance may not cover gradual deterioration. Flexi-hose connections (silver braided) have 5-year lifespan — check age." },
  { name: "Boundary Wall Lean/Crack", category: "structure", severity: 3, cost_min_zar: 5000, cost_max_zar: 35000, status: "draft",
    description: "Freestanding boundary walls leaning or cracking due to inadequate foundations, soil movement, or missing control joints.",
    visual_indicators: "Visible lean away from property. Horizontal cracking along mortar courses. Gaps between wall and pillars. Missing or cracked coping. Pre-cast panels displaced from slots.",
    sa_context: "Pre-cast concrete walls common in SA suburbs — cheaper but prone to lean in expansive clay. Brick boundary walls need control joints every 6m. Rebuild cost R800–R1200/linear metre for 1.8m brick wall. Pre-cast replacement R400–R600/linear metre." },
  { name: "Flat Roof Ponding", category: "roof", severity: 3, cost_min_zar: 8000, cost_max_zar: 40000, status: "draft",
    description: "Water pooling on flat roof sections due to inadequate falls, blocked drainage, or membrane failure.",
    visual_indicators: "Visible water staining in circular patterns on roof surface. Algae/moss growth in low areas. Blistering or bubbling of waterproofing membrane. Water marks on interior ceilings below flat roof sections.",
    sa_context: "Common on Cape Town townhouses and sectional title units with flat roof extensions. Torch-on waterproofing lasts 10–15 years. Re-waterproofing R120–R250/m². Check if body corporate or owner responsibility in sectional title." },
  { name: "Window Frame Deterioration", category: "walls", severity: 2, cost_min_zar: 3000, cost_max_zar: 20000, status: "draft",
    description: "Timber or steel window frames showing rot, rust, or seal failure allowing water ingress and thermal loss.",
    visual_indicators: "Soft/spongy timber at lower corners of wooden frames. Flaking paint revealing bare wood. Rust bleeding from steel frames. Condensation between double-glazed panes (seal failure). Gaps between frame and wall.",
    sa_context: "Timber frames common in Cape Town older homes — meranti or SA pine. Steel frames (Crittall-style) in 1950s–1970s homes. Aluminium replacement R3K–R8K per window. Timber repair R500–R2K per frame if caught early." },
];

type ActionItem = { step: string; detail: string; href?: string; scrollTo?: string; done: boolean };

export default function IntelligenceHubPage() {
  const [summary, setSummary] = useState<A | null>(null);
  const [pipeline, setPipeline] = useState<A[] | null>(null);
  const [knowledge, setKnowledge] = useState<A | null>(null);
  const [quality, setQuality] = useState<A | null>(null);
  const [combined, setCombined] = useState<A | null>(null);
  const [appStats, setAppStats] = useState<A | null>(null);

  const [kbForm, setKbForm] = useState<A | null>(null);
  const [kbSaving, setKbSaving] = useState(false);
  const [qImage, setQImage] = useState<string | null>(null);
  const [qImagePreview, setQImagePreview] = useState<string | null>(null);
  const [qMediaType, setQMediaType] = useState("image/jpeg");
  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [qScores, setQScores] = useState<Record<string, number>>({});
  const [qSaving, setQSaving] = useState(false);
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [topTab, setTopTab] = useState<"hub" | "pipeline" | "combined">("hub");

  const loadSection = useCallback(async (section: string) => {
    const data = await (await fetch(`/api/intelligence?section=${section}`)).json();
    if (section === "summary") setSummary(data.summary);
    if (section === "pipeline") setPipeline(data.pipeline);
    if (section === "knowledge") setKnowledge(data.knowledge);
    if (section === "quality") setQuality(data.quality);
    if (section === "combined") setCombined(data.combined);
    if (section === "applications") setAppStats(data.applications);
  }, []);

  useEffect(() => {
    loadSection("summary");
    loadSection("pipeline");
    loadSection("knowledge");
    loadSection("quality");
    loadSection("combined");
    loadSection("applications");
  }, [loadSection]);

  async function saveKnowledge() {
    if (!kbForm?.name) return;
    setKbSaving(true);
    await fetch("/api/intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_knowledge", ...kbForm }),
    });
    setKbSaving(false);
    setKbForm(null);
    loadSection("knowledge");
    loadSection("summary");
  }

  async function toggleKnowledge(id: number) {
    await fetch("/api/intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle_knowledge", id }),
    });
    loadSection("knowledge");
    loadSection("summary");
  }

  async function runComparison() {
    if (!qImage) return;
    setQRunning(true);
    setQResult(null);
    const data = await (await fetch("/api/intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "run_comparison",
        image_base64: qImage,
        image_media_type: qMediaType,
      }),
    })).json();
    setQResult(data);
    setQRunning(false);
  }

  function handlePhotoDrop(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setQImagePreview(dataUrl);
      // Extract base64 and media type
      const [header, base64] = dataUrl.split(",");
      const mediaType = header.match(/:(.*?);/)?.[1] || "image/jpeg";
      setQImage(base64);
      setQMediaType(mediaType);
    };
    reader.readAsDataURL(file);
  }

  async function saveQualityRun() {
    if (!qResult) return;
    setQSaving(true);
    await fetch("/api/intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save_quality_run", run_type: "isolated", rag_system: "vision_condition",
        query_text: "Photo comparison", image_url: qImagePreview?.substring(0, 200),
        response_without_rag: qResult.response_without_rag,
        response_with_rag: qResult.response_with_rag,
        score_specificity: qScores.specificity, score_accuracy: qScores.accuracy,
        score_actionability: qScores.actionability, score_consistency: qScores.consistency,
        notes: `KB entries used: ${qResult.kb_entries_used || 0}`,
      }),
    });
    setQSaving(false);
    setQResult(null);
    setQScores({});
    setQImage(null);
    setQImagePreview(null);
    loadSection("quality");
    loadSection("summary");
  }

  function avgScore(runs: A[]): string {
    if (!runs?.length) return "—";
    const scored = runs.filter((r: A) => r.score_specificity != null);
    if (!scored.length) return "—";
    const avg = scored.reduce((s: number, r: A) =>
      s + (Number(r.score_specificity) + Number(r.score_accuracy) + Number(r.score_actionability) + Number(r.score_consistency)) / 4, 0
    ) / scored.length;
    return avg.toFixed(1);
  }

  // ─── Build checklist from real data ──────────────────────────────────
  function getActionItems(): ActionItem[] {
    if (!summary) return [];
    const kb = summary.knowledge_base;
    const q = summary.quality;
    const props = summary.properties;
    const imgs = summary.images;

    const kbActive = Number(kb?.active || 0);
    const qualityRuns = Number(q?.runs || 0);
    const geocoded = Number(props?.geocoded || 0);
    const withEra = Number(props?.with_era || 0);
    const deedsCov = Number(summary.deeds_coverage || 0);
    const analysedImages = Number(imgs?.analysed_images || 0);
    const totalImages = Number(imgs?.total_images || 0);

    return [
      { step: `Add defect entries to the knowledge base`,
        detail: kbActive === 0
          ? "No entries yet. Click \"Seed 8 SA Defect Entries\" to get started, then review and activate them."
          : `${kbActive} active, ${Number(kb?.total || 0)} total. Add more as you spot gaps in reports.`,
        scrollTo: "kb-section", done: kbActive >= 10 },

      { step: `Run a quality comparison`,
        detail: qualityRuns === 0
          ? "No comparisons run yet. Test a property question to see if the knowledge base is making a difference."
          : `${qualityRuns} comparisons scored so far.`,
        scrollTo: "quality-section", done: qualityRuns >= 5 },

      { step: `Run scrapers to collect property data`,
        detail: "Crime, solar, water quality, municipal values, security, listings. Hit Run All on the scraper page.",
        href: "/admin/data/scraper", done: geocoded > 100 },

      { step: `Geocode properties — ${geocoded} done`,
        detail: "Needed for Street View, satellite, solar, and crime lookups. Happens automatically during report generation.",
        href: "/admin/data/properties", done: geocoded > 0 && geocoded >= Number(props?.total || 1) * 0.5 },

      { step: `Set construction eras — ${withEra} done`,
        detail: "Enables asbestos, electrical, and plumbing risk scoring by building age.",
        href: "/admin/data/properties", done: withEra > 0 },

      { step: `Run deeds lookups — ${deedsCov} done`,
        detail: "Gets ownership, municipal values, and transfer history from WinDeed.",
        href: "/admin/data/properties", done: deedsCov > 0 },

      { step: `Analyse property photos — ${analysedImages} of ${totalImages.toLocaleString()} done`,
        detail: "Vision analysis uses your knowledge base entries. Run from property inspect pages or during report generation.",
        href: "/admin/data/properties", done: totalImages > 0 && analysedImages >= totalImages * 0.5 },
    ];
  }

  // ─── Seed starter KB entries ────────────────────────────────────────
  const [seeding, setSeeding] = useState(false);
  async function seedStarterEntries() {
    setSeeding(true);
    for (const entry of STARTER_ENTRIES) {
      await fetch("/api/intelligence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_knowledge", ...entry }),
      });
    }
    setSeeding(false);
    loadSection("knowledge");
    loadSection("summary");
  }

  const actions = getActionItems();

  return (
    <div>
      <div className="flex items-end justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold mb-1">RAG Intelligence Hub</h1>
          <p className="text-sm text-gray-500">Two RAG systems powering every Surepath report</p>
        </div>
        <div className="flex gap-1">
          {(["hub", "pipeline", "combined"] as const).map(tab => (
            <button key={tab} onClick={() => setTopTab(tab)}
              className={`px-4 py-1.5 rounded text-xs font-bold ${topTab === tab ? "bg-[#0D1B2A] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
              {tab === "hub" ? "RAG Hub" : tab === "pipeline" ? "Pipeline Monitor" : "Combined Reports"}
            </button>
          ))}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          TAB: RAG HUB
          ═══════════════════════════════════════════════════════════════ */}
      {topTab === "hub" && <>

      {/* Summary cards */}
      {summary && (
        <>
          <div className="grid grid-cols-6 gap-3 mb-4">
            {[
              { label: "Properties", val: Number(summary.properties?.total || 0).toLocaleString(), sub: `${summary.reports?.unique_properties || 0} have reports` },
              { label: "Photos Analysed", val: `${summary.images?.analysed_images || 0} of ${Number(summary.images?.total_images || 0).toLocaleString()}`, sub: `${summary.images?.properties_analysed || 0} properties / ${summary.images?.total_findings || 0} findings` },
              { label: "Reports", val: summary.reports?.complete_reports || 0, sub: `${summary.reports?.with_scores || 0} with full scores` },
              { label: "Deeds Lookups", val: summary.deeds_coverage || 0, sub: "properties with ownership data" },
              { label: "Crime Data", val: `${summary.crime?.suburbs || 0} suburbs`, sub: `${Number(summary.crime?.incidents || 0).toLocaleString()} incidents tracked` },
              { label: "Knowledge Base", val: `${summary.knowledge_base?.active || 0} active`, sub: `${summary.knowledge_base?.total || 0} total defect entries` },
            ].map(c => (
              <div key={c.label} className="bg-white border rounded-lg p-3">
                <div className="text-[9px] text-gray-500 uppercase tracking-wide">{c.label}</div>
                <div className="text-xl font-bold mt-0.5">{c.val}</div>
                <div className="text-[10px] text-gray-400">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* How it works + Action items */}
          <div className="bg-white border rounded-lg p-4 mb-6">
            <div className="flex justify-between items-start mb-3">
              <div className="text-xs font-bold">How the RAG system works</div>
              {Number(summary?.knowledge_base?.total || 0) === 0 && (
                <button onClick={seedStarterEntries} disabled={seeding}
                  className="px-3 py-1.5 bg-[#E63946] text-white text-xs rounded font-bold hover:bg-red-700 disabled:opacity-50 shrink-0">
                  {seeding ? "Adding..." : "Seed 8 SA Defect Entries"}
                </button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4 mb-4">
              <div className="border rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-[#0D1B2A] text-white text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
                  <span className="text-xs font-bold">Teach it what to look for</span>
                </div>
                <p className="text-[10px] text-gray-600 mb-1">Add defect entries in the Knowledge Base below. Describe common SA building problems — what they look like, what they cost, and where they occur.</p>
                <p className="text-[10px] text-gray-600 mb-1">When you set an entry to <span className="font-bold text-green-700">active</span>, it gets included in the prompt every time Claude analyses property photos. The more you add, the better it gets at spotting SA-specific issues.</p>
                <p className="text-[10px] text-gray-400">Start with the 8 seed entries, then add more as you see gaps in reports.</p>
                <button onClick={() => document.getElementById("kb-section")?.scrollIntoView({ behavior: "smooth" })} className="text-[10px] text-blue-600 hover:underline mt-2 block">Go to Knowledge Base</button>
              </div>

              <div className="border rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-[#0D1B2A] text-white text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
                  <span className="text-xs font-bold">Test if it's working</span>
                </div>
                <p className="text-[10px] text-gray-600 mb-1">Ask Nico a property question. The system runs it twice — once with just Nico, once with Nico plus your RAG data. You see both answers side by side.</p>
                <p className="text-[10px] text-gray-600 mb-1">Score the RAG-enhanced answer from 1 to 5 on four dimensions. Over time this shows you whether adding knowledge base entries is actually making reports better.</p>
                <p className="text-[10px] text-gray-400">Run a comparison every time you add or change entries.</p>
                <button onClick={() => document.getElementById("quality-section")?.scrollIntoView({ behavior: "smooth" })} className="text-[10px] text-blue-600 hover:underline mt-2 block">Go to Quality</button>
              </div>

              <div className="border rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-[#0D1B2A] text-white text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
                  <span className="text-xs font-bold">Keep the data fresh</span>
                </div>
                <p className="text-[10px] text-gray-600 mb-1">Go to the <a href="/admin/data/scraper" className="text-blue-600 hover:underline">Scraper page</a> and hit Run All. This collects crime stats, solar data, water quality, security coverage, property listings, and municipal data — all at once.</p>
                <p className="text-[10px] text-gray-600 mb-1">For individual properties, use the <a href="/admin/data/properties" className="text-blue-600 hover:underline">Properties page</a> to run deeds lookups, set construction eras, and trigger photo analysis.</p>
                <p className="text-[10px] text-gray-400">More data on each property = better reports and negotiation intel.</p>
                <a href="/admin/data/scraper" className="text-[10px] text-blue-600 hover:underline mt-2 block">Go to Scrapers</a>
              </div>
            </div>

            {/* Checklist */}
            <div className="text-xs font-bold mb-2">Setup checklist</div>
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div key={i} className="flex items-start gap-2.5 text-xs">
                  <span className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold ${a.done ? "border-green-500 bg-green-50 text-green-600" : "border-gray-300 text-gray-400"}`}>
                    {a.done ? "\u2713" : i + 1}
                  </span>
                  <div className="flex-1">
                    <div className={`font-medium ${a.done ? "text-gray-400 line-through" : ""}`}>{a.step}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">{a.detail}</div>
                  </div>
                  {a.href && <a href={a.href} className="text-[10px] text-blue-600 hover:underline shrink-0 mt-0.5">Open</a>}
                  {a.scrollTo && (
                    <button onClick={() => document.getElementById(a.scrollTo!)?.scrollIntoView({ behavior: "smooth" })} className="text-[10px] text-blue-600 hover:underline shrink-0 mt-0.5">Jump to</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      </>}

      {/* ═══════════════════════════════════════════════════════════════
          TAB: PIPELINE MONITOR
          ═══════════════════════════════════════════════════════════════ */}
      {topTab === "pipeline" && (
      <div className="bg-white border rounded-lg p-4 shadow-sm">
        <p className="text-xs text-gray-400 mb-3">Latest report per property — what each RAG system retrieved, what context was injected, what Claude returned</p>
        {!pipeline ? <p className="text-gray-400 text-sm">Loading...</p> : pipeline.length === 0 ? <p className="text-gray-400 text-sm">No report runs yet</p> : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-[#0D1B2A] text-white text-left">
                <th className="px-2 py-1.5">Property</th>
                <th className="px-2 py-1.5">ERF</th>
                <th className="px-2 py-1.5">Decision</th>
                <th className="px-2 py-1.5 text-right">Photos</th>
                <th className="px-2 py-1.5 text-right">Findings</th>
                <th className="px-2 py-1.5 text-right">Deeds</th>
                <th className="px-2 py-1.5 text-right">Cost</th>
                <th className="px-2 py-1.5">Date</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.map((run: A) => {
                const isExpanded = expandedRun === run.id;
                return (
                  <Fragment key={run.id}>
                    <tr className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedRun(isExpanded ? null : run.id)}>
                      <td className="px-2 py-1.5"><div className="font-medium max-w-xs truncate">{run.address_normalised || run.address_raw}</div><div className="text-[9px] text-gray-400">{run.suburb}, {run.city}</div></td>
                      <td className="px-2 py-1.5 font-mono text-gray-500">{run.erf_number || "—"}</td>
                      <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${run.decision === "BUY" ? "bg-green-100 text-green-800" : run.decision === "NEGOTIATE" ? "bg-yellow-100 text-yellow-800" : run.decision === "INSPECT_FIRST" ? "bg-orange-100 text-orange-800" : "bg-red-100 text-red-800"}`}>{run.decision}</span></td>
                      <td className="px-2 py-1.5 text-right font-mono">{run.analysed_count}/{run.image_count}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{run.finding_count || 0}</td>
                      <td className="px-2 py-1.5 text-right">{run.registered_owner ? <span className="text-green-600">Yes</span> : <span className="text-gray-300">No</span>}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{run.generation_cost_zar ? `R${Number(run.generation_cost_zar).toFixed(2)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-gray-400">{formatDate(run.created_at)}</td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-gray-50"><td colSpan={8} className="px-4 py-3">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">RAG 01 — Property Intelligence</div>
                            <div className="space-y-1 text-xs">
                              {[["Asking Price", run.asking_price ? formatZAR(run.asking_price) : "—"], ["AVM Range", run.avm_low && run.avm_high ? `${formatZAR(run.avm_low)} – ${formatZAR(run.avm_high)}` : "—"], ["Price Verdict", run.price_verdict || "—"], ["Municipal Value", run.municipal_value ? formatZAR(run.municipal_value) : "—"], ["Owner", run.registered_owner || "—"], ["Construction Era", run.construction_era || "not set"], ["Roof Material", run.roof_material || "—"]].map(([l, v]) => <div key={l} className="flex justify-between"><span className="text-gray-500">{l}</span><span className="font-mono">{v}</span></div>)}
                              <div className="flex justify-between"><span className="text-gray-500">Asbestos Risk</span><span className={`px-1 rounded text-[10px] ${severityColor[run.asbestos_risk] || "bg-gray-200"}`}>{run.asbestos_risk || "—"}</span></div>
                              {[["Crime Score", run.crime_risk_score], ["Insurance Risk", run.insurance_risk_score], ["Solar Score", run.solar_suitability_score]].map(([l, v]) => <div key={l as string} className="flex justify-between"><span className="text-gray-500">{l}</span><span className="font-mono">{v != null ? `${v}/100` : "—"}</span></div>)}
                              {run.negotiation_intel?.suggested_offer && <div className="mt-2 bg-blue-50 rounded p-2"><div className="text-[10px] font-bold text-blue-700 mb-1">Negotiation Intel</div><div className="text-xs">Suggested offer: {formatZAR(run.negotiation_intel.suggested_offer)}</div></div>}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">RAG 02 — Vision & Condition</div>
                            <div className="space-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-gray-500">Photos Analysed</span><span className="font-mono">{run.analysed_count}/{run.image_count}</span></div>
                              <div className="flex justify-between"><span className="text-gray-500">Findings</span><span className="font-mono">{run.finding_count || 0}</span></div>
                              {run.structural_flags?.length > 0 && <div className="mt-2"><div className="text-[10px] font-bold text-red-600 mb-1">Structural Flags ({run.structural_flags.length})</div>{run.structural_flags.slice(0, 5).map((f: A, i: number) => <div key={i} className="flex items-start gap-1 mt-0.5"><span className={`px-1 rounded text-[9px] shrink-0 ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span><span className="text-[10px] text-gray-600">{f.observation || f.description}</span></div>)}</div>}
                              {run.repair_estimates?.total_min_zar && <div className="mt-2 bg-orange-50 rounded p-2"><div className="text-[10px] font-bold text-orange-700 mb-1">Repair Estimates</div><div className="text-xs font-mono">{formatZAR(run.repair_estimates.total_min_zar)} – {formatZAR(run.repair_estimates.total_max_zar)}</div></div>}
                              {!run.structural_flags?.length && !run.repair_estimates?.total_min_zar && <div className="text-[10px] text-gray-400 mt-2 italic">No structural flags or repair estimates</div>}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 bg-[#0D1B2A] text-white rounded p-3"><div className="text-[10px] font-bold tracking-wide mb-1">SYNTHESIS</div><div className="text-sm font-bold">{run.decision}</div><div className="text-xs text-gray-300 mt-1">{run.decision_reasoning}</div></div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          TAB: COMBINED REPORTS
          ═══════════════════════════════════════════════════════════════ */}
      {topTab === "combined" && (
      <div className="bg-white border rounded-lg p-4 shadow-sm">
        <p className="text-xs text-gray-400 mb-3">Both RAG systems firing together — how Property Intelligence and Vision & Condition combine at synthesis. One card per property.</p>
        {!combined ? <p className="text-gray-400 text-sm">Loading...</p> : combined.reports?.length === 0 ? <p className="text-gray-400 text-sm">No complete reports yet</p> : (
          <div className="space-y-4">
            {combined.reports?.map((r: A) => (
              <div key={r.id} className="border rounded p-3">
                <div className="flex justify-between items-start mb-3">
                  <div><div className="font-medium text-sm">{r.address_raw}</div><div className="text-[10px] text-gray-400">{r.suburb}, {r.city} | ERF {r.erf_number} | {formatDate(r.created_at)}</div></div>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${r.decision === "BUY" ? "bg-green-100 text-green-800" : r.decision === "NEGOTIATE" ? "bg-yellow-100 text-yellow-800" : r.decision === "INSPECT_FIRST" ? "bg-orange-100 text-orange-800" : "bg-red-100 text-red-800"}`}>{r.decision}</span>
                </div>
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div className="bg-purple-50 rounded p-2">
                    <div className="text-[10px] font-bold text-purple-700 mb-1">Property → Vision Crossover</div>
                    <div className="text-[10px] text-gray-600 space-y-0.5">
                      <div>Era: <span className="font-medium">{r.construction_era || "not set"}</span> → asbestos risk: <span className={`px-1 rounded ${severityColor[r.asbestos_risk] || ""}`}>{r.asbestos_risk || "not scored"}</span></div>
                      <div>Roof: <span className="font-medium">{r.roof_material || "unknown"}</span> | Solar: {r.solar_installed ? "Yes" : "No"} | Security: {r.security_visible ? "Yes" : "No"}</div>
                      {r.registered_owner && <div>Owner: {r.registered_owner} | Municipal: {r.municipal_value ? formatZAR(r.municipal_value) : "—"}</div>}
                    </div>
                  </div>
                  <div className="bg-orange-50 rounded p-2">
                    <div className="text-[10px] font-bold text-orange-700 mb-1">Vision → Negotiation Crossover</div>
                    <div className="text-[10px] text-gray-600 space-y-0.5">
                      <div>Structural flags: {r.structural_flags?.length || 0} | Compliance: {r.compliance_flags?.length || 0}</div>
                      {r.repair_estimates?.total_min_zar != null && <div>Repair cost: {formatZAR(r.repair_estimates.total_min_zar)} – {formatZAR(r.repair_estimates.total_max_zar)}</div>}
                      {r.negotiation_intel?.suggested_offer && <div>Suggested offer: {formatZAR(r.negotiation_intel.suggested_offer)} (asking {formatZAR(r.asking_price)})</div>}
                      {!r.structural_flags?.length && !r.repair_estimates?.total_min_zar && <div className="italic text-gray-400">No vision-driven negotiation data</div>}
                    </div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-[10px] font-bold text-gray-500 mb-1">Risk Scores</div>
                    <div className="text-[10px] space-y-0.5">
                      {[["Insurance Risk", r.insurance_risk_score], ["Crime Risk", r.crime_risk_score], ["Solar Suitability", r.solar_suitability_score]].map(([l, v]) => <div key={l as string} className="flex justify-between"><span>{l}</span><span className="font-mono font-bold">{v != null ? `${v}/100` : "not scored"}</span></div>)}
                      <div className="flex justify-between"><span>Maintenance Est.</span><span className="font-mono font-bold">{r.maintenance_cost_estimate ? formatZAR(r.maintenance_cost_estimate) : "—"}</span></div>
                    </div>
                  </div>
                </div>
                <div className="bg-[#0D1B2A] text-white rounded p-2 text-xs"><span className="text-gray-400 text-[10px]">Decision reasoning: </span>{r.decision_reasoning}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          HUB CONTINUES: KNOWLEDGE BASE (only on hub tab)
          ═══════════════════════════════════════════════════════════════ */}
      {topTab === "hub" && <>

      {/* ═══════════════════════════════════════════════════════════════
          KNOWLEDGE BASE MANAGER
          ═══════════════════════════════════════════════════════════════ */}
      <div id="kb-section" className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Knowledge Base</h2>
        <p className="text-xs text-gray-400 mb-3">Real photos linked to real findings and verified costs. Active entries are included as reference examples in every vision analysis.</p>

        {/* KB Entry Form */}
        {kbForm && (
          <div className="border rounded p-3 mb-4 bg-blue-50">
            <div className="text-xs font-bold mb-2">{kbForm.id ? "Edit" : "New"} Knowledge Entry</div>
            {kbForm.image_url && (
              <div className="mb-2">
                <img src={kbForm.image_url} alt="" className="w-48 h-32 object-cover rounded border" />
                <div className="text-[9px] text-gray-400 mt-1">Linked photo from {kbForm.address_raw || `property ${kbForm.property_id}`}</div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input className="border rounded px-2 py-1 text-xs" placeholder="Defect name (e.g. Rising Damp — Cape Town)" value={kbForm.name} onChange={e => setKbForm({ ...kbForm, name: e.target.value })} />
              <select className="border rounded px-2 py-1 text-xs" value={kbForm.category} onChange={e => setKbForm({ ...kbForm, category: e.target.value })}>
                <option value="">Category...</option>
                {["roof", "walls", "damp", "electrical", "plumbing", "ceiling", "structure", "extension", "security", "vegetation", "environment", "general"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="What Claude found in this photo" value={kbForm.description} onChange={e => setKbForm({ ...kbForm, description: e.target.value })} />
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="What to look for in similar photos (visual indicators)" value={kbForm.visual_indicators} onChange={e => setKbForm({ ...kbForm, visual_indicators: e.target.value })} />
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="SA-specific context — why this matters in this region, local costs, common causes" value={kbForm.sa_context} onChange={e => setKbForm({ ...kbForm, sa_context: e.target.value })} />
            <div className="grid grid-cols-4 gap-2 mb-2">
              <div><label className="text-[9px] text-gray-500">Severity (1-5)</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.severity} onChange={e => setKbForm({ ...kbForm, severity: Number(e.target.value) })}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
              <div><label className="text-[9px] text-gray-500">Actual Cost Min (ZAR)</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" placeholder="0" value={kbForm.cost_min_zar} onChange={e => setKbForm({ ...kbForm, cost_min_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Actual Cost Max (ZAR)</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" placeholder="0" value={kbForm.cost_max_zar} onChange={e => setKbForm({ ...kbForm, cost_max_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Status</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.status} onChange={e => setKbForm({ ...kbForm, status: e.target.value })}><option value="draft">Draft</option><option value="active">Active</option></select></div>
            </div>
            <div className="flex gap-2">
              <button onClick={saveKnowledge} disabled={kbSaving} className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50">{kbSaving ? "Saving..." : "Save"}</button>
              <button onClick={() => setKbForm(null)} className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
            </div>
          </div>
        )}

        {/* Active KB entries with photos */}
        {knowledge?.entries && knowledge.entries.length > 0 && (
          <div className="mb-4">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">{knowledge.entries.filter((e: A) => e.status === "active").length} active / {knowledge.entries.length} total entries</div>
            <div className="grid grid-cols-1 gap-2">
              {knowledge.entries.map((e: A) => (
                <div key={e.id} className={`border rounded p-2 flex gap-3 ${e.status === "active" ? "border-green-200 bg-green-50/30" : "border-gray-200"}`}>
                  {e.image_url ? (
                    <img src={e.image_url} alt="" className="w-24 h-16 object-cover rounded shrink-0" />
                  ) : (
                    <div className="w-24 h-16 bg-gray-100 rounded shrink-0 flex items-center justify-center text-[9px] text-gray-400">No photo</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{e.name}</span>
                      <span className={`px-1 rounded text-[9px] ${severityColor[e.severity >= 4 ? "HIGH" : e.severity === 3 ? "MEDIUM" : "LOW"] || "bg-gray-200"}`}>{e.severity}/5</span>
                      <span className="capitalize text-[9px] text-gray-400">{e.category}</span>
                      {e.cost_min_zar && <span className="text-[9px] font-mono text-gray-500">{formatZAR(e.cost_min_zar)}–{formatZAR(e.cost_max_zar)}</span>}
                    </div>
                    {e.description && <div className="text-[10px] text-gray-600 mt-0.5 truncate">{e.description}</div>}
                    {e.sa_context && <div className="text-[10px] text-blue-600 mt-0.5 truncate">SA: {e.sa_context}</div>}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => toggleKnowledge(e.id)} className={`px-2 py-0.5 rounded text-[9px] font-bold ${e.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>{e.status}</button>
                    <button onClick={() => setKbForm(e)} className="px-2 py-0.5 rounded text-[9px] bg-blue-50 text-blue-600">Edit</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Photo browser — analysed photos with findings, click to add to KB */}
        {knowledge?.analysed_photos && knowledge.analysed_photos.length > 0 && (
          <div>
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Analysed Photos — click a finding to add it to the knowledge base</div>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {knowledge.analysed_photos.map((photo: A) => (
                <div key={photo.image_id} className="border rounded overflow-hidden">
                  <div className="flex">
                    <img src={photo.image_url} alt="" className="w-32 h-24 object-cover shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    <div className="p-2 flex-1 min-w-0">
                      <div className="text-[10px] text-gray-500 truncate">{photo.address_raw}</div>
                      <div className="text-[9px] text-gray-400">{photo.suburb} | {photo.photo_type || photo.image_type}</div>
                    </div>
                  </div>
                  <div className="px-2 pb-2">
                    {(photo.findings || []).map((f: A, fi: number) => (
                      <div key={fi} className="flex items-start gap-1.5 py-1 border-t border-gray-100 first:border-0">
                        <span className={`px-1 rounded text-[8px] shrink-0 mt-0.5 ${severityColor[f.severity] || "bg-gray-200"}`}>{f.severity}</span>
                        <span className="text-[10px] text-gray-700 flex-1">{f.observation}</span>
                        <button onClick={() => {
                          const sevMap: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, COSMETIC: 1 };
                          setKbForm({
                            name: `${(f.category || "").charAt(0).toUpperCase() + (f.category || "").slice(1)} — ${(f.observation || "").substring(0, 40)}`,
                            description: f.observation,
                            visual_indicators: f.observation,
                            sa_context: "",
                            severity: sevMap[f.severity] || 3,
                            cost_min_zar: f.estimated_repair_cost_zar?.min || "",
                            cost_max_zar: f.estimated_repair_cost_zar?.max || "",
                            category: f.category || "",
                            status: "draft",
                            image_id: photo.image_id,
                            image_url: photo.image_url,
                            property_id: photo.property_id,
                            address_raw: photo.address_raw,
                            original_finding: f,
                          });
                          document.getElementById("kb-section")?.scrollIntoView({ behavior: "smooth" });
                        }} className="text-[8px] text-blue-600 hover:underline shrink-0 font-bold whitespace-nowrap">+ Add to KB</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {!knowledge && <p className="text-gray-400 text-sm">Loading...</p>}
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3: QUALITY & IMPROVEMENT
          ═══════════════════════════════════════════════════════════════ */}
      <div id="quality-section" className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Quality Comparison</h2>
        <p className="text-xs text-gray-400 mb-3">Drop a property photo. Same image goes through Claude Vision twice — once with the base prompt, once with your knowledge base entries injected. See the difference.</p>

        {/* Photo drop zone */}
        <div className="border-2 border-dashed rounded-lg p-4 mb-4 text-center bg-gray-50 hover:bg-gray-100 transition cursor-pointer"
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhotoDrop(f); }}
          onClick={() => { const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handlePhotoDrop(f); }; input.click(); }}>
          {qImagePreview ? (
            <div className="flex items-center justify-center gap-4">
              <img src={qImagePreview} alt="" className="w-40 h-28 object-cover rounded" />
              <div>
                <button onClick={runComparison} disabled={qRunning}
                  className="px-5 py-2 bg-[#0D1B2A] text-white text-sm rounded font-bold hover:bg-[#1a2d42] disabled:opacity-50">
                  {qRunning ? "Analysing both..." : "Run Comparison"}
                </button>
                <div className="text-[10px] text-gray-400 mt-1">Or drop a different photo</div>
              </div>
            </div>
          ) : (
            <div>
              <div className="text-sm text-gray-500 font-medium">Drop a property photo here</div>
              <div className="text-[10px] text-gray-400 mt-1">or click to browse — JPG, PNG, WebP</div>
            </div>
          )}
        </div>

        {/* Results side by side */}
        {qResult && (
          <div className="border rounded p-3 mb-4">
            <div className="text-[10px] text-gray-400 mb-2">{qResult.kb_entries_used || 0} knowledge base entries used in the RAG prompt</div>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <div className="text-[10px] font-bold text-red-600 uppercase tracking-wide mb-1">Base Prompt (no RAG)</div>
                <div className="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">{qResult.response_without_rag}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-green-600 uppercase tracking-wide mb-1">With Knowledge Base</div>
                <div className="bg-green-50 rounded p-2 text-xs whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">{qResult.response_with_rag}</div>
              </div>
            </div>
            <div className="border-t pt-3">
              <div className="text-xs font-bold mb-2">Score: did the knowledge base improve the analysis? (1–5)</div>
              <div className="grid grid-cols-4 gap-2 mb-2">
                {SCORE_LABELS.map(label => {
                  const key = label.toLowerCase();
                  return (
                    <div key={key}>
                      <label className="text-[9px] text-gray-500">{label}</label>
                      <div className="flex gap-1">
                        {[1,2,3,4,5].map(n => (
                          <button key={n} onClick={() => setQScores({ ...qScores, [key]: n })}
                            className={`w-6 h-6 rounded text-[10px] font-bold ${qScores[key] === n ? "bg-[#0D1B2A] text-white" : "bg-gray-200 text-gray-600 hover:bg-gray-300"}`}>{n}</button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <button onClick={saveQualityRun} disabled={qSaving || !qScores.specificity}
                className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50">
                {qSaving ? "Saving..." : "Save Score"}
              </button>
            </div>
          </div>
        )}

        {/* Past runs */}
        {quality?.runs && quality.runs.length > 0 && (
          <div>
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">Past Comparisons ({quality.runs.length})</div>
            <table className="w-full text-xs border-collapse">
              <thead><tr className="text-left text-gray-500 border-b"><th className="pb-1">Date</th><th className="pb-1 text-center">Spec</th><th className="pb-1 text-center">Acc</th><th className="pb-1 text-center">Act</th><th className="pb-1 text-center">Con</th><th className="pb-1 text-center">Avg</th><th className="pb-1">Notes</th></tr></thead>
              <tbody>
                {quality.runs.map((r: A) => {
                  const avg = r.score_specificity ? ((Number(r.score_specificity) + Number(r.score_accuracy) + Number(r.score_actionability) + Number(r.score_consistency)) / 4).toFixed(1) : "—";
                  return (
                    <tr key={r.id} className="border-b">
                      <td className="py-1 text-gray-400">{formatDate(r.created_at)}</td>
                      <td className="py-1 text-center font-mono">{r.score_specificity ?? "—"}</td>
                      <td className="py-1 text-center font-mono">{r.score_accuracy ?? "—"}</td>
                      <td className="py-1 text-center font-mono">{r.score_actionability ?? "—"}</td>
                      <td className="py-1 text-center font-mono">{r.score_consistency ?? "—"}</td>
                      <td className="py-1 text-center font-mono font-bold">{avg}</td>
                      <td className="py-1 text-gray-500">{r.notes || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!quality && <p className="text-gray-400 text-sm">Loading...</p>}
      </div>


      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5: APPLICATIONS TRACKER
          ═══════════════════════════════════════════════════════════════ */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Applications Tracker</h2>
        <p className="text-xs text-gray-400 mb-3">Downstream use cases for each RAG system with readiness based on current data quality and coverage</p>

        {!appStats ? <p className="text-gray-400 text-sm">Loading...</p> : (
          <>
            <div className="grid grid-cols-5 gap-2 mb-4">
              {[
                { label: "Unique Properties", val: appStats.report_stats?.unique_properties || 0 },
                { label: "Complete Reports", val: appStats.report_stats?.complete_reports || 0 },
                { label: "Properties Analysed", val: appStats.vision_stats?.properties_analysed || 0 },
                { label: "KB Entries (Active)", val: appStats.knowledge_entries || 0 },
                { label: "Quality Avg Score", val: avgScore(quality?.runs || []) },
              ].map(c => (
                <div key={c.label} className="bg-gray-50 rounded p-2 text-center">
                  <div className="text-lg font-bold">{c.val}</div>
                  <div className="text-[9px] text-gray-500 uppercase">{c.label}</div>
                </div>
              ))}
            </div>

            {["property_intelligence", "vision_condition"].map(system => (
              <div key={system} className="mb-4">
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">
                  {system === "property_intelligence" ? "RAG 01 — Property Intelligence" : "RAG 02 — Vision & Condition"}
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {APPLICATIONS.filter(a => a.system === system).map(app => {
                    let readiness = 0;
                    const reports = Number(appStats.report_stats?.complete_reports || 0);
                    const visionProps = Number(appStats.vision_stats?.properties_analysed || 0);
                    const kbCount = Number(appStats.knowledge_entries || 0);
                    const withScores = Number(appStats.report_stats?.with_scores || 0);

                    if (system === "property_intelligence") {
                      if (reports >= 10) readiness += 25; else readiness += Math.round((reports / 10) * 25);
                      if (withScores >= 5) readiness += 25; else readiness += Math.round((withScores / 5) * 25);
                      if (app.status === "primary") readiness += 50;
                      else if (app.status === "building") readiness += 25;
                    } else {
                      if (visionProps >= 10) readiness += 25; else readiness += Math.round((visionProps / 10) * 25);
                      readiness += Math.min(25, kbCount * 5);
                      if (app.status === "primary") readiness += 50;
                      else if (app.status === "building") readiness += 25;
                    }
                    readiness = Math.min(100, readiness);
                    const barColor = readiness >= 75 ? "bg-green-500" : readiness >= 40 ? "bg-yellow-500" : "bg-gray-300";

                    return (
                      <div key={app.name} className="flex items-center gap-3 border rounded p-2">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 ${STATUS_BADGE[app.status]}`}>{app.status}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] shrink-0 ${app.segment === "b2b" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{app.segment}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium">{app.name}</div>
                          <div className="text-[10px] text-gray-500">{app.description}</div>
                        </div>
                        <div className="w-24 shrink-0">
                          <div className="text-[9px] text-gray-400 text-right mb-0.5">{readiness}% ready</div>
                          <div className="w-full bg-gray-200 rounded-full h-1.5">
                            <div className={`h-1.5 rounded-full ${barColor}`} style={{ width: `${readiness}%` }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      </>}
    </div>
  );
}
