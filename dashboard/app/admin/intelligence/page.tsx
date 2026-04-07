"use client";
import { useEffect, useState, useCallback } from "react";
import { formatZAR, formatDate, formatDateTime, severityColor, humanize } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const SCORE_LABELS = ["Specificity", "Accuracy", "Actionability", "Consistency"];

export default function IntelligenceHubPage() {
  const [summary, setSummary] = useState<A | null>(null);
  const [quality, setQuality] = useState<A | null>(null);
  const [dailyCheck, setDailyCheck] = useState<A[] | null>(null);
  const [dataSources, setDataSources] = useState<A[] | null>(null);
  const [prompts, setPrompts] = useState<A[] | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const [qImage, setQImage] = useState<string | null>(null);
  const [qPreview, setQPreview] = useState<string | null>(null);
  const [qMedia, setQMedia] = useState("image/jpeg");
  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [qScores, setQScores] = useState<Record<string, number>>({});
  const [qSaving, setQSaving] = useState(false);
  const [verdicts, setVerdicts] = useState<Record<number, string>>({});
  const [wrongIdx, setWrongIdx] = useState<number | null>(null);
  const [wrongReason, setWrongReason] = useState("");
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<A | null>(null);
  const [benchExpanded, setBenchExpanded] = useState<number | null>(null);
  const [ragEnabled, setRagEnabled] = useState(true);
  const [properties, setProperties] = useState<A[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<string>("");

  const load = useCallback(async (s: string) => {
    const d = await (await fetch(`/api/intelligence?section=${s}`)).json();
    if (s === "summary") setSummary(d.summary);
    if (s === "quality") setQuality(d.quality);
    if (s === "daily_check") setDailyCheck(d.daily_check);
    if (s === "data_sources") setDataSources(d.data_sources);
    if (s === "prompts") setPrompts(d.prompts);
  }, []);

  useEffect(() => {
    load("summary"); load("quality"); load("daily_check"); load("data_sources");
    fetch("/api/intelligence?section=properties_for_test").then(r => r.json()).then(d => { if (d.properties) setProperties(d.properties); }).catch(() => {});
  }, [load]);

  // Actions
  function handlePhoto(f: File) { const r = new FileReader(); r.onload = e => { const d = e.target?.result as string; setQPreview(d); const [h, b] = d.split(","); setQImage(b); setQMedia(h.match(/:(.*?);/)?.[1] || "image/jpeg"); }; r.readAsDataURL(f); }
  async function runCompare() { if (!qImage) return; setQRunning(true); setQResult(null); const d = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_comparison", image_base64: qImage, image_media_type: qMedia, rag_enabled: ragEnabled, property_id: selectedProperty || undefined }) })).json(); setQResult(d); setQRunning(false); }
  async function saveScore() { if (!qResult) return; setQSaving(true); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_quality_run", run_type: "isolated", rag_system: "vision", query_text: "Photo comparison", response_without_rag: qResult.response_without_rag, response_with_rag: qResult.response_with_rag, ...Object.fromEntries(SCORE_LABELS.map(l => [`score_${l.toLowerCase()}`, qScores[l.toLowerCase()]])), notes: `KB: ${qResult.kb_entries_used || 0}` }) }); setQSaving(false); setQResult(null); setQScores({}); setQImage(null); setQPreview(null); load("quality"); }
  async function submitCheck(i: number, v: string, reason?: string) { const item = dailyCheck?.[i]; if (!item) return; setVerdicts(prev => ({ ...prev, [i]: v })); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm_check", item_type: item.type, item_id: item.id || item.image_id, verdict: v, reason: reason || undefined, property_id: item.property_id }) }); }
  async function runBenchmark() { setBenchRunning(true); setBenchResult(null); setBenchExpanded(null); const d = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_benchmark", count: 10, rag_enabled: ragEnabled }) })).json(); setBenchResult(d); setBenchRunning(false); }

  const now = new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Nico's Brain</h1>
      <p className="text-sm text-gray-500 mb-4">Everything feeding Nico, your daily sanity check, and the knowledge base that makes him better over time.</p>

      {/* ─── Data Sources ───────────────────────────────────────────── */}
      {dataSources && (
        <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-bold text-sm">What Nico has</h2>
            <a href="/admin/data/scraper" className="text-[10px] text-blue-600 hover:underline">Run scrapers</a>
          </div>
          <div className="grid grid-cols-4 gap-x-6 gap-y-1">
            {dataSources.map((ds: A) => (
              <div key={ds.name} className="flex items-center justify-between text-[10px] py-0.5 border-b border-gray-50">
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ds.in_rag ? "bg-green-500" : "bg-gray-300"}`} />
                  <span className={ds.count > 0 ? "text-gray-700" : "text-gray-400"}>{ds.name}</span>
                </div>
                <span className={`font-mono ${ds.count > 0 ? "text-gray-900 font-bold" : "text-gray-300"}`}>{Number(ds.count).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-2 text-[8px] text-gray-400">
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" /> In Nico's RAG</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> Collected but not in RAG yet</span>
            {summary?.feedback && <span className="ml-auto">Your feedback: {summary.feedback.positive} confirmed, {summary.feedback.negative} corrected — all feeding Nico's prompt</span>}
          </div>
        </div>
      )}

      {/* ─── Daily Check ────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h2 className="font-bold text-sm">Daily Check — {now}</h2>
            <p className="text-xs text-gray-400">10 random items. Your corrections are the highest-confidence signal in the system.</p>
          </div>
          <button onClick={() => { setVerdicts({}); load("daily_check"); }} className="text-[10px] text-blue-600 hover:underline">New 10</button>
        </div>

        {!dailyCheck ? <p className="text-gray-400 text-xs">Loading...</p> : dailyCheck.length === 0 ? <p className="text-gray-400 text-xs">No data to check yet.</p> : (
          <div className="space-y-2">
            {dailyCheck.map((item: A, idx: number) => {
              const v = verdicts[idx];
              const propLink = item.property_id ? `/admin/data/inspect/${item.property_id}` : null;
              const date = item.created_at ? formatDateTime(item.created_at) : null;
              return (
                <div key={idx} className={`border rounded p-3 ${v === "correct" ? "border-green-200 bg-green-50/20" : v === "incorrect" ? "border-red-200 bg-red-50/20" : ""}`}>
                  <div className="flex items-start gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded text-[7px] font-bold shrink-0 mt-0.5 uppercase ${
                      item.type === "vision_finding" ? "bg-blue-100 text-blue-700" :
                      item.type === "report_decision" ? "bg-purple-100 text-purple-700" :
                      item.type === "knowledge_entry" ? "bg-yellow-100 text-yellow-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>{item.type === "vision_finding" ? "Photo Finding" : item.type === "report_decision" ? "Decision" : item.type === "knowledge_entry" ? "KB Entry" : "Evidence"}</span>
                    {item.severity && <span className={`px-1 rounded text-[7px] shrink-0 ${severityColor[item.severity] || "bg-gray-200"}`}>{item.severity}</span>}
                    {item.confidence_tier && <span className="text-[8px] text-gray-400">Tier {item.confidence_tier}</span>}
                    {date && <span className="text-[8px] text-gray-300 ml-auto">{date}</span>}
                  </div>

                  {/* Full content — never truncated */}
                  <div className="text-xs text-gray-800 mb-1.5">
                    {item.type === "vision_finding" && <>{humanize(item.observation)}</>}
                    {item.type === "report_decision" && <>Decision: <span className="font-bold">{humanize(item.decision)}</span> — {humanize(item.decision_reasoning)}{item.asking_price ? ` (asking ${formatZAR(item.asking_price)})` : ""}</>}
                    {item.type === "knowledge_entry" && <>{item.name}: {humanize(item.description || "")}{item.sa_context ? <><br /><span className="text-blue-600">SA: {item.sa_context}</span></> : ""}{item.cost_min_zar ? ` — ${formatZAR(item.cost_min_zar)}–${formatZAR(item.cost_max_zar)}` : ""}</>}
                    {item.type === "nico_evidence" && <>{humanize(item.output_language || "")}{item.tier_reason ? <><br /><span className="text-gray-500 text-[10px]">Reason: {humanize(item.tier_reason)}</span></> : ""}{item.limitations ? <><br /><span className="text-gray-400 text-[10px]">Can't tell: {humanize(item.limitations)}</span></> : ""}</>}
                  </div>

                  {/* Property link + image */}
                  <div className="flex items-center gap-2 mb-1.5">
                    {item.address_raw && <span className="text-[9px] text-gray-500">{item.address_raw}{item.suburb ? `, ${item.suburb}` : ""}</span>}
                    {propLink && <a href={propLink} className="text-[9px] text-blue-600 hover:underline">View property</a>}
                    {item.image_url && item.image_url.startsWith("http") && <img src={item.image_url} alt="" className="w-16 h-12 object-cover rounded ml-auto" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                  </div>

                  {/* Verdict buttons */}
                  {!v ? (
                    wrongIdx === idx ? (
                      <div className="flex gap-1 items-center">
                        <input className="border rounded px-1.5 py-0.5 text-[9px] w-40" placeholder="What's wrong? (optional)" value={wrongReason} onChange={e => setWrongReason(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { submitCheck(idx, "incorrect", wrongReason); setWrongIdx(null); setWrongReason(""); } }} autoFocus />
                        <button onClick={() => { submitCheck(idx, "incorrect", wrongReason); setWrongIdx(null); setWrongReason(""); }} className="px-2 py-0.5 text-[9px] bg-red-500 text-white rounded">Submit</button>
                        <button onClick={() => { setWrongIdx(null); setWrongReason(""); }} className="text-[9px] text-gray-400">x</button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button onClick={() => submitCheck(idx, "correct")} className="px-2 py-0.5 text-[9px] bg-green-100 text-green-700 rounded hover:bg-green-200">Correct</button>
                        <button onClick={() => setWrongIdx(idx)} className="px-2 py-0.5 text-[9px] bg-red-100 text-red-700 rounded hover:bg-red-200">Wrong</button>
                        <button onClick={() => submitCheck(idx, "unsure")} className="px-2 py-0.5 text-[9px] bg-gray-100 text-gray-500 rounded hover:bg-gray-200">Unsure</button>
                      </div>
                    )
                  ) : <span className={`text-[9px] font-bold ${v === "correct" ? "text-green-600" : v === "incorrect" ? "text-red-600" : "text-gray-400"}`}>Marked: {v}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── Test Nico ──────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-start mb-1">
          <div>
            <h2 className="font-bold text-sm">Test Nico</h2>
            <p className="text-xs text-gray-400 mb-2">Same photo, same model (Sonnet): Nico without KB vs Nico with KB + feedback. Automated signal detection shows whether RAG actually contributes.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setRagEnabled(!ragEnabled)} className={`px-2 py-1 text-[9px] rounded font-bold border ${ragEnabled ? "bg-green-100 text-green-800 border-green-300" : "bg-gray-100 text-gray-500 border-gray-300"}`}>RAG {ragEnabled ? "ON" : "OFF"}</button>
            <button onClick={runBenchmark} disabled={benchRunning} className="px-2 py-1 bg-[#E63946] text-white text-[9px] rounded font-bold disabled:opacity-50">{benchRunning ? "Running..." : "Benchmark 10"}</button>
          </div>
        </div>

        {/* Property selector — gives RAG full context for this property */}
        <div className="flex items-center gap-2 mb-2">
          <select value={selectedProperty} onChange={e => setSelectedProperty(e.target.value)} className="border rounded px-2 py-1 text-xs flex-1">
            <option value="">No property context (test raw photo only)</option>
            {properties.map((p: A) => (
              <option key={p.id} value={p.id}>{p.address_raw || p.suburb || `Property ${p.id}`}{p.suburb ? `, ${p.suburb}` : ""}{p.construction_era ? ` (${p.construction_era})` : ""}</option>
            ))}
          </select>
          {selectedProperty && <span className="text-[8px] text-green-600 shrink-0">RAG will pull all data for this property</span>}
        </div>

        {/* Single photo comparison */}
        <div className="border-2 border-dashed rounded p-3 mb-2 text-center bg-gray-50 hover:bg-gray-100 cursor-pointer"
          onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhoto(f); }}
          onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = ev => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) handlePhoto(f); }; i.click(); }}>
          {qPreview ? <div className="flex items-center justify-center gap-3"><img src={qPreview} alt="" className="w-24 h-18 object-cover rounded" /><button onClick={e => { e.stopPropagation(); runCompare(); }} disabled={qRunning} className="px-3 py-1.5 bg-[#0D1B2A] text-white text-xs rounded font-bold disabled:opacity-50">{qRunning ? "Analysing..." : "Compare"}</button></div> : <span className="text-xs text-gray-500">Drop a photo or click to test a single image</span>}
        </div>

        {/* Single comparison result with signals */}
        {qResult && (
          <div className="mb-3">
            {/* Signal summary bar */}
            {qResult.signals && (
              <div className="flex items-center gap-3 mb-2 p-2 rounded bg-gray-50 border">
                <div className="flex items-center gap-1">
                  <span className={`text-lg font-bold ${qResult.signals.rag_contribution_score >= 50 ? "text-green-600" : qResult.signals.rag_contribution_score >= 25 ? "text-yellow-600" : "text-red-500"}`}>{qResult.signals.rag_contribution_score}</span>
                  <span className="text-[8px] text-gray-400">RAG score</span>
                </div>
                <div className="flex-1 grid grid-cols-4 gap-2 text-[8px]">
                  <div className={qResult.signals.kb_lift > 0 ? "text-green-700" : "text-gray-400"}>
                    KB refs: +{qResult.signals.kb_lift} ({qResult.signals.kb_entries_referenced?.length || 0} total)
                  </div>
                  <div className={qResult.signals.sa_term_lift > 0 ? "text-green-700" : "text-gray-400"}>
                    SA terms: +{qResult.signals.sa_term_lift} ({qResult.signals.sa_terms_rag?.length || 0} total)
                  </div>
                  <div className={qResult.signals.has_cost_ranges_rag ? "text-green-700" : "text-gray-400"}>
                    Cost ranges: {qResult.signals.has_cost_ranges_rag ? "Yes" : "No"} {qResult.signals.uses_zar_rag ? "(ZAR)" : ""}
                  </div>
                  <div>
                    Findings: {qResult.signals.findings_count_baseline} → {qResult.signals.findings_count_rag}
                  </div>
                </div>
              </div>
            )}

            {/* KB entries referenced */}
            {qResult.signals?.kb_entries_referenced?.length > 0 && (
              <div className="mb-2 p-1.5 rounded bg-green-50 border border-green-200">
                <span className="text-[8px] font-bold text-green-700">KB entries referenced: </span>
                <span className="text-[9px] text-green-800">{qResult.signals.kb_entries_referenced.join(", ")}</span>
              </div>
            )}

            {/* SA terms found only in RAG */}
            {qResult.signals && qResult.signals.sa_terms_rag?.filter((t: string) => !qResult.signals.sa_terms_baseline?.includes(t)).length > 0 && (
              <div className="mb-2 p-1.5 rounded bg-blue-50 border border-blue-200">
                <span className="text-[8px] font-bold text-blue-700">SA terms added by RAG: </span>
                <span className="text-[9px] text-blue-800">{qResult.signals.sa_terms_rag.filter((t: string) => !qResult.signals.sa_terms_baseline.includes(t)).join(", ")}</span>
              </div>
            )}

            {/* Side-by-side responses */}
            <div className="grid grid-cols-2 gap-3 mb-2">
              <div>
                <div className="text-[8px] font-bold text-gray-400 uppercase mb-1">Baseline (Nico without KB)</div>
                <div className="bg-gray-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">{qResult.response_without_rag}</div>
              </div>
              <div>
                <div className="text-[8px] font-bold text-green-700 uppercase mb-1">Nico + RAG ({qResult.kb_entries_used || 0} KB, {qResult.rag_sections || 0} sections, {qResult.rag_prompt_length ? Math.round(qResult.rag_prompt_length / 1000) + 'k' : '?'} chars)</div>
                <div className="bg-green-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">{qResult.response_with_rag}</div>
              </div>
            </div>

            {/* Manual scoring */}
            <div className="flex items-center gap-2 flex-wrap">
              {SCORE_LABELS.map(l => { const k = l.toLowerCase(); return (<div key={k} className="flex items-center gap-0.5"><span className="text-[7px] text-gray-500">{l}</span>{[1,2,3,4,5].map(n => <button key={n} onClick={() => setQScores({ ...qScores, [k]: n })} className={`w-4 h-4 rounded text-[7px] ${qScores[k] === n ? "bg-[#0D1B2A] text-white" : "bg-gray-200"}`}>{n}</button>)}</div>); })}
              <button onClick={saveScore} disabled={qSaving || !qScores.specificity} className="px-2 py-1 bg-green-600 text-white text-[9px] rounded disabled:opacity-50 ml-auto">{qSaving ? "..." : "Save"}</button>
            </div>
          </div>
        )}

        {/* Benchmark results */}
        {benchResult && (
          <div className="mt-3 border-t pt-3">
            <h3 className="font-bold text-xs mb-2">Benchmark Results — {benchResult.photos_tested} photos, {benchResult.kb_entries_active} KB entries</h3>

            {benchResult.aggregate && (
              <div className="grid grid-cols-5 gap-2 mb-3">
                <div className="bg-gray-50 rounded p-2 text-center">
                  <div className={`text-xl font-bold ${benchResult.aggregate.avg_rag_contribution_score >= 50 ? "text-green-600" : benchResult.aggregate.avg_rag_contribution_score >= 25 ? "text-yellow-600" : "text-red-500"}`}>{benchResult.aggregate.avg_rag_contribution_score}</div>
                  <div className="text-[7px] text-gray-500 uppercase">Avg RAG Score</div>
                </div>
                <div className="bg-gray-50 rounded p-2 text-center">
                  <div className="text-xl font-bold text-blue-600">+{benchResult.aggregate.avg_kb_lift}</div>
                  <div className="text-[7px] text-gray-500 uppercase">Avg KB Lift</div>
                </div>
                <div className="bg-gray-50 rounded p-2 text-center">
                  <div className="text-xl font-bold text-blue-600">+{benchResult.aggregate.avg_sa_term_lift}</div>
                  <div className="text-[7px] text-gray-500 uppercase">SA Term Lift</div>
                </div>
                <div className="bg-gray-50 rounded p-2 text-center">
                  <div className="text-sm font-bold">{benchResult.aggregate.avg_findings_baseline} → {benchResult.aggregate.avg_findings_rag}</div>
                  <div className="text-[7px] text-gray-500 uppercase">Avg Findings</div>
                </div>
                <div className="bg-gray-50 rounded p-2 text-center">
                  <div className="text-sm font-bold">{benchResult.aggregate.pct_has_cost_ranges}%</div>
                  <div className="text-[7px] text-gray-500 uppercase">Cost Ranges</div>
                </div>
              </div>
            )}

            {/* Quality signals breakdown */}
            {benchResult.aggregate && (
              <div className="flex gap-4 mb-3 text-[9px]">
                <span className={benchResult.aggregate.pct_uses_zar >= 80 ? "text-green-700" : "text-yellow-700"}>ZAR: {benchResult.aggregate.pct_uses_zar}%</span>
                <span className={benchResult.aggregate.pct_has_confidence_tiers >= 80 ? "text-green-700" : "text-yellow-700"}>Confidence tiers: {benchResult.aggregate.pct_has_confidence_tiers}%</span>
                <span className={benchResult.aggregate.pct_has_why_chain >= 80 ? "text-green-700" : "text-yellow-700"}>WHY chain: {benchResult.aggregate.pct_has_why_chain}%</span>
              </div>
            )}

            {/* Per-photo expandable results */}
            <div className="space-y-1">
              {benchResult.results?.map((r: A, idx: number) => (
                <div key={idx} className="border rounded">
                  <button onClick={() => setBenchExpanded(benchExpanded === idx ? null : idx)} className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50">
                    <span className={`text-xs font-bold w-6 text-center rounded ${r.signals?.rag_contribution_score >= 50 ? "text-green-600" : r.signals?.rag_contribution_score >= 25 ? "text-yellow-600" : "text-red-500"}`}>{r.signals?.rag_contribution_score}</span>
                    <span className="text-[9px] flex-1 truncate">{r.address || "Unknown"}{r.suburb ? `, ${r.suburb}` : ""}</span>
                    <span className="text-[8px] text-gray-400">{r.photo_type}</span>
                    {r.signals?.kb_entries_referenced?.length > 0 && <span className="text-[8px] text-green-600">{r.signals.kb_entries_referenced.length} KB</span>}
                    <span className="text-[8px] text-gray-400">{r.signals?.findings_count_baseline}→{r.signals?.findings_count_rag} findings</span>
                    <span className="text-[10px] text-gray-300">{benchExpanded === idx ? "▲" : "▼"}</span>
                  </button>
                  {benchExpanded === idx && (
                    <div className="px-2 pb-2 border-t">
                      {r.signals?.kb_entries_referenced?.length > 0 && (
                        <div className="text-[8px] text-green-700 py-1">KB referenced: {r.signals.kb_entries_referenced.join(", ")}</div>
                      )}
                      {r.signals?.sa_terms_rag?.filter((t: string) => !r.signals?.sa_terms_baseline?.includes(t)).length > 0 && (
                        <div className="text-[8px] text-blue-700 py-1">SA terms added: {r.signals.sa_terms_rag.filter((t: string) => !r.signals.sa_terms_baseline.includes(t)).join(", ")}</div>
                      )}
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        <div><div className="text-[7px] font-bold text-gray-400 uppercase mb-0.5">Baseline</div><div className="bg-gray-50 rounded p-1.5 text-[9px] whitespace-pre-wrap max-h-36 overflow-y-auto">{r.response_without_rag}</div></div>
                        <div><div className="text-[7px] font-bold text-green-700 uppercase mb-0.5">RAG</div><div className="bg-green-50 rounded p-1.5 text-[9px] whitespace-pre-wrap max-h-36 overflow-y-auto">{r.response_with_rag}</div></div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(quality?.runs?.length ?? 0) > 0 && <div className="text-[9px] text-gray-400 mt-1">{quality!.runs.length} comparison{quality!.runs.length !== 1 ? "s" : ""} saved</div>}
      </div>

      {/* ─── Prompts ────────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center">
          <h2 className="font-bold text-sm">Nico's Prompts</h2>
          <button onClick={() => { if (!prompts) load("prompts"); setShowPrompts(!showPrompts); }} className="text-[10px] text-blue-600 hover:underline">{showPrompts ? "Hide" : "Show"}</button>
        </div>
        {showPrompts && prompts && <div className="mt-3 space-y-3">{prompts.map((p: A, i: number) => (
          <div key={i} className="border rounded p-3"><div className="flex justify-between mb-1"><span className="text-xs font-bold">{p.name}</span><span className="text-[8px] text-gray-400 font-mono">{p.source}</span></div><pre className="text-[9px] text-gray-600 whitespace-pre-wrap max-h-48 overflow-y-auto bg-gray-50 rounded p-2">{p.prompt}</pre></div>
        ))}</div>}
      </div>
    </div>
  );
}
