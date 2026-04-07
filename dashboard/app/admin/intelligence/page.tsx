"use client";
import { useEffect, useState, useCallback } from "react";
import { formatZAR, formatDate, formatDateTime, severityColor, humanize } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

export default function IntelligenceHubPage() {
  const [summary, setSummary] = useState<A | null>(null);
  const [quality, setQuality] = useState<A | null>(null);
  const [dailyCheck, setDailyCheck] = useState<A[] | null>(null);
  const [dataSources, setDataSources] = useState<A[] | null>(null);
  const [prompts, setPrompts] = useState<A[] | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [verdicts, setVerdicts] = useState<Record<number, string>>({});
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<A | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [wrongIdx, setWrongIdx] = useState<number | null>(null);
  const [wrongReason, setWrongReason] = useState("");

  const load = useCallback(async (s: string) => {
    const d = await (await fetch(`/api/intelligence?section=${s}`)).json();
    if (s === "summary") setSummary(d.summary);
    if (s === "quality") setQuality(d.quality);
    if (s === "daily_check") setDailyCheck(d.daily_check);
    if (s === "data_sources") setDataSources(d.data_sources);
    if (s === "prompts") setPrompts(d.prompts);
  }, []);

  useEffect(() => { load("summary"); load("quality"); load("daily_check"); load("data_sources"); }, [load]);

  // Actions
  async function toggleSourceDetail(type: string) {
    if (expandedSource === type) { setExpandedSource(null); setSourceDetail(null); return; }
    setExpandedSource(type); setSourceLoading(true); setSourceDetail(null);
    try {
      const d = await (await fetch(`/api/intelligence?section=data_detail&type=${type}`)).json();
      setSourceDetail(d);
    } catch { setSourceDetail({ error: "Failed to load" }); }
    setSourceLoading(false);
  }

  function handlePhotoDrop(f: File) {
    const r = new FileReader();
    r.onload = async e => {
      const d = e.target?.result as string;
      const [h, b] = d.split(",");
      const media = h.match(/:(.*?);/)?.[1] || "image/jpeg";
      setQRunning(true); setQResult(null);
      const res = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_comparison", image_base64: b, image_media_type: media, rag_enabled: true }) })).json();
      setQResult(res); setQRunning(false);
    };
    r.readAsDataURL(f);
  }
  async function submitCheck(i: number, v: string, reason?: string) { const item = dailyCheck?.[i]; if (!item) return; setVerdicts(prev => ({ ...prev, [i]: v })); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm_check", item_type: item.type, item_id: item.id || item.image_id, verdict: v, reason: reason || undefined, property_id: item.property_id }) }); }

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
          <div className="grid grid-cols-4 gap-x-6 gap-y-0">
            {dataSources.map((ds: A) => (
              <button key={ds.name} onClick={() => ds.type && ds.count > 0 && toggleSourceDetail(ds.type)}
                className={`flex items-center justify-between text-[10px] py-0.5 border-b text-left w-full ${expandedSource === ds.type ? "border-blue-200 bg-blue-50/50" : "border-gray-50"} ${ds.count > 0 ? "hover:bg-gray-50 cursor-pointer" : "cursor-default"}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ds.in_rag ? "bg-green-500" : "bg-gray-300"}`} />
                  <span className={`${ds.count > 0 ? "text-gray-700" : "text-gray-400"} ${expandedSource === ds.type ? "font-bold text-blue-700" : ""}`}>{ds.name}</span>
                </div>
                <span className={`font-mono ${ds.count > 0 ? "text-gray-900 font-bold" : "text-gray-300"}`}>{Number(ds.count).toLocaleString()}</span>
              </button>
            ))}
          </div>

          {/* Expanded data detail panel */}
          {expandedSource && (
            <div className="mt-3 border rounded-lg overflow-hidden">
              <div className="flex justify-between items-center bg-gray-50 px-3 py-2 border-b">
                <span className="text-xs font-bold">{dataSources.find((ds: A) => ds.type === expandedSource)?.name} — {dataSources.find((ds: A) => ds.type === expandedSource)?.detail}</span>
                <button onClick={() => { setExpandedSource(null); setSourceDetail(null); }} className="text-[10px] text-gray-400 hover:text-gray-600">Close</button>
              </div>
              {sourceLoading ? (
                <div className="p-4 text-center text-xs text-gray-400">Loading...</div>
              ) : sourceDetail?.error ? (
                <div className="p-4 text-center text-xs text-red-500">{sourceDetail.error}</div>
              ) : sourceDetail?.rows?.length > 0 ? (() => {
                const cols: string[] = sourceDetail!.columns || Object.keys(sourceDetail!.rows[0]);
                return (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-[10px]">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        {cols.map((col: string) => (
                          <th key={col} className="px-2 py-1 text-left font-medium text-gray-500 uppercase border-b">{col.replace(/_/g, " ")}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sourceDetail!.rows.map((row: A, i: number) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          {cols.map((col: string) => {
                            let val = row[col];
                            if (val === null || val === undefined) val = "—";
                            else if (typeof val === "number" && (col.includes("price") || col.includes("cost") || col.includes("value") || col.includes("zar"))) val = `R${Number(val).toLocaleString()}`;
                            else if (typeof val === "object") val = JSON.stringify(val).substring(0, 80);
                            else val = String(val).substring(0, 100);
                            return <td key={col} className="px-2 py-1 text-gray-700 whitespace-nowrap">{String(val)}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                );
              })() : (
                <div className="p-4 text-center text-xs text-gray-400">No records found</div>
              )}
              {sourceDetail && sourceDetail.total > 0 && <div className="px-3 py-1 text-[9px] text-gray-400 border-t bg-gray-50">Showing {sourceDetail.rows?.length} of {sourceDetail.total} records</div>}
            </div>
          )}

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
        <h2 className="font-bold text-sm mb-1">Test Nico</h2>
        <p className="text-xs text-gray-400 mb-2">Drop a property photo. Left = Base Nico (no data). Right = Nico with everything in the knowledge base.</p>

        <div className={`border-2 border-dashed rounded p-6 text-center ${qRunning ? "bg-yellow-50 border-yellow-300" : "bg-gray-50 hover:bg-gray-100 border-gray-300"} cursor-pointer`}
          onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("border-blue-400", "bg-blue-50"); }}
          onDragLeave={e => { e.currentTarget.classList.remove("border-blue-400", "bg-blue-50"); }}
          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("border-blue-400", "bg-blue-50"); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhotoDrop(f); }}
          onClick={() => { if (qRunning) return; const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = ev => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) handlePhotoDrop(f); }; i.click(); }}>
          {qRunning ? <span className="text-sm text-yellow-700 font-medium">Analysing with both prompts...</span> : <span className="text-xs text-gray-500">Drop a property photo here or click to select</span>}
        </div>

        {qResult && (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[9px] font-bold text-gray-400 uppercase mb-1">Base Nico</div>
                <div className="bg-gray-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto border">{qResult.response_without_rag}</div>
              </div>
              <div>
                <div className="text-[9px] font-bold text-green-700 uppercase mb-1">Nico + Knowledge ({qResult.kb_entries_used || 0} KB entries, {qResult.rag_prompt_length ? Math.round(qResult.rag_prompt_length / 1000) + 'k' : '?'} chars context)</div>
                <div className="bg-green-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto border border-green-200">{qResult.response_with_rag}</div>
              </div>
            </div>
          </div>
        )}
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
