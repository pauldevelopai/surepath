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
  const [rag, setRag] = useState<A | null>(null);
  const [showRag, setShowRag] = useState(false);
  const [ragTestQuery, setRagTestQuery] = useState("");
  const [ragTestResult, setRagTestResult] = useState<A | null>(null);
  const [ragTestLoading, setRagTestLoading] = useState(false);

  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [verdicts, setVerdicts] = useState<Record<number, string>>({});
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [sourceDetail, setSourceDetail] = useState<A | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourcePage, setSourcePage] = useState(1);
  const [sourceSearch, setSourceSearch] = useState("");
  const [wrongIdx, setWrongIdx] = useState<number | null>(null);
  const [wrongReason, setWrongReason] = useState("");

  const load = useCallback(async (s: string) => {
    const d = await (await fetch(`/api/intelligence?section=${s}`)).json();
    if (s === "summary") setSummary(d.summary);
    if (s === "quality") setQuality(d.quality);
    if (s === "daily_check") setDailyCheck(d.daily_check);
    if (s === "data_sources") setDataSources(d.data_sources);
    if (s === "prompts") setPrompts(d.prompts);
    if (s === "rag") setRag(d.rag);
  }, []);

  useEffect(() => { load("summary"); load("quality"); load("daily_check"); load("data_sources"); }, [load]);

  // Actions
  async function loadSourceDetail(type: string, pg = 1, srch = "") {
    setSourceLoading(true); setSourceDetail(null);
    try {
      const d = await (await fetch(`/api/intelligence?section=data_detail&type=${type}&page=${pg}&search=${encodeURIComponent(srch)}`)).json();
      setSourceDetail(d);
    } catch { setSourceDetail({ error: "Failed to load" }); }
    setSourceLoading(false);
  }
  function toggleSourceDetail(type: string) {
    if (expandedSource === type) { setExpandedSource(null); setSourceDetail(null); return; }
    setExpandedSource(type); setSourcePage(1); setSourceSearch(""); loadSourceDetail(type, 1, "");
  }
  function goPage(pg: number) { if (!expandedSource) return; setSourcePage(pg); loadSourceDetail(expandedSource, pg, sourceSearch); }
  function doSearch(srch: string) { if (!expandedSource) return; setSourceSearch(srch); setSourcePage(1); loadSourceDetail(expandedSource, 1, srch); }

  function handlePhotoDrop(f: File) {
    const r = new FileReader();
    r.onload = async e => {
      const d = e.target?.result as string;
      const [h, b] = d.split(",");
      const media = h.match(/:(.*?);/)?.[1] || "image/jpeg";
      setQRunning(true); setQResult(null);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout
        const resp = await fetch("/api/intelligence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run_comparison", image_base64: b, image_media_type: media, rag_enabled: true }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) {
          setQResult({ error: `Server error: ${resp.status} ${resp.statusText}` });
        } else {
          const res = await resp.json();
          setQResult(res);
        }
      } catch (err) {
        setQResult({ error: err instanceof Error && err.name === "AbortError" ? "Timed out after 2 minutes — try a smaller image" : `Failed: ${err instanceof Error ? err.message : "unknown error"}` });
      }
      setQRunning(false);
    };
    r.readAsDataURL(f);
  }
  async function submitCheck(i: number, v: string, reason?: string) { const item = dailyCheck?.[i]; if (!item) return; setVerdicts(prev => ({ ...prev, [i]: v })); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm_check", item_type: item.type, item_id: item.id || item.image_id, verdict: v, reason: reason || undefined, property_id: item.property_id }) }); }

  const now = new Date().toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Nico's Brain</h1>
      <p className="text-sm text-gray-500 mb-4">Everything feeding Nico, your daily sanity check, and the Knowledge Base that makes him better over time.</p>

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
              <div className="flex justify-between items-center bg-gray-50 px-3 py-2 border-b gap-2">
                <span className="text-xs font-bold shrink-0">{dataSources.find((ds: A) => ds.type === expandedSource)?.name}</span>
                <input type="text" placeholder="Search..." value={sourceSearch} onChange={e => doSearch(e.target.value)}
                  className="border rounded px-2 py-0.5 text-[10px] flex-1 max-w-xs" />
                <span className="text-[9px] text-gray-400 shrink-0">{sourceDetail?.total?.toLocaleString() || "?"} records</span>
                <button onClick={() => { setExpandedSource(null); setSourceDetail(null); }} className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0">Close</button>
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
                      {sourceDetail!.rows.map((row: A, i: number) => {
                        const link = row._link as string | undefined;
                        const isExternal = link?.startsWith("http");
                        return (
                        <tr key={i} className={`border-b border-gray-50 ${link ? "hover:bg-blue-50 cursor-pointer" : "hover:bg-gray-50"}`}
                          onClick={() => { if (link) window.open(isExternal ? link : link, isExternal ? "_blank" : "_blank", "noopener"); }}>
                          {cols.map((col: string) => {
                            let val = row[col];
                            if (val === null || val === undefined) val = "—";
                            else if (typeof val === "number" && (col.includes("price") || col.includes("cost") || col.includes("value") || col.includes("zar"))) val = `R${Number(val).toLocaleString()}`;
                            else if (typeof val === "object") val = JSON.stringify(val).substring(0, 80);
                            else val = String(val).substring(0, 100);
                            return <td key={col} className={`px-2 py-1 whitespace-nowrap ${link ? "text-blue-700" : "text-gray-700"}`}>{String(val)}</td>;
                          })}
                          {link && <td className="px-1 text-blue-400 text-[8px]">↗</td>}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                );
              })() : (
                <div className="p-4 text-center text-xs text-gray-400">No records found</div>
              )}
              {sourceDetail && sourceDetail.total > 0 && (
                <div className="flex items-center justify-between px-3 py-1.5 border-t bg-gray-50">
                  <span className="text-[9px] text-gray-400">Page {sourceDetail.page} of {sourceDetail.totalPages} ({sourceDetail.total?.toLocaleString()} records)</span>
                  <div className="flex gap-1">
                    <button onClick={() => goPage(1)} disabled={sourceDetail.page <= 1} className="px-2 py-0.5 text-[9px] rounded bg-gray-200 disabled:opacity-30 hover:bg-gray-300">First</button>
                    <button onClick={() => goPage(sourceDetail.page - 1)} disabled={sourceDetail.page <= 1} className="px-2 py-0.5 text-[9px] rounded bg-gray-200 disabled:opacity-30 hover:bg-gray-300">Prev</button>
                    <button onClick={() => goPage(sourceDetail.page + 1)} disabled={sourceDetail.page >= sourceDetail.totalPages} className="px-2 py-0.5 text-[9px] rounded bg-gray-200 disabled:opacity-30 hover:bg-gray-300">Next</button>
                    <button onClick={() => goPage(sourceDetail.totalPages)} disabled={sourceDetail.page >= sourceDetail.totalPages} className="px-2 py-0.5 text-[9px] rounded bg-gray-200 disabled:opacity-30 hover:bg-gray-300">Last</button>
                  </div>
                </div>
              )}
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
                    }`}>{item.type === "vision_finding" ? "Photo Finding" : item.type === "report_decision" ? "Decision" : item.type === "knowledge_entry" ? "Article" : "Evidence"}</span>
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
        <p className="text-xs text-gray-400 mb-2">Drop a property photo. Left = Base Nico (no data). Right = Nico with everything in the Knowledge Base.</p>

        <div className={`border-2 border-dashed rounded p-6 text-center ${qRunning ? "bg-yellow-50 border-yellow-300" : "bg-gray-50 hover:bg-gray-100 border-gray-300"} cursor-pointer`}
          onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("border-blue-400", "bg-blue-50"); }}
          onDragLeave={e => { e.currentTarget.classList.remove("border-blue-400", "bg-blue-50"); }}
          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("border-blue-400", "bg-blue-50"); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhotoDrop(f); }}
          onClick={() => { if (qRunning) return; const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = ev => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) handlePhotoDrop(f); }; i.click(); }}>
          {qRunning ? <span className="text-sm text-yellow-700 font-medium">Analysing with both prompts...</span> : <span className="text-xs text-gray-500">Drop a property photo here or click to select</span>}
        </div>

        {qResult && (
          <div className="mt-3">
            {qResult.error ? (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{qResult.error}</div>
            ) : (<>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[9px] font-bold text-gray-400 uppercase mb-1">Base Nico ({qResult.baseline_prompt_length ? Math.round(qResult.baseline_prompt_length / 1000) + 'k' : '?'} chars)</div>
                  <div className="bg-gray-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto border">{qResult.response_without_rag}</div>
                </div>
                <div>
                  <div className="text-[9px] font-bold text-green-700 uppercase mb-1">Nico + RAG ({qResult.rag_retrieval?.chunks_returned || qResult.kb_entries_used || 0} chunks, {qResult.rag_prompt_length ? Math.round(qResult.rag_prompt_length / 1000) + 'k' : '?'} chars context)</div>
                  <div className="bg-green-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto border border-green-200">{qResult.response_with_rag}</div>
                </div>
              </div>

              {/* RAG retrieval details */}
              {qResult.rag_retrieval && (
                <div className="mt-3 bg-blue-50 border border-blue-200 rounded p-3">
                  <div className="text-[9px] font-bold text-blue-700 uppercase mb-2">RAG Retrieval Details</div>
                  <div className="grid grid-cols-5 gap-2 text-center mb-2">
                    <div className="bg-white rounded p-1">
                      <div className="text-sm font-bold">{qResult.rag_retrieval.chunks_returned}</div>
                      <div className="text-[8px] text-gray-500">chunks</div>
                    </div>
                    <div className="bg-white rounded p-1">
                      <div className="text-sm font-bold">{(qResult.rag_retrieval.layers_hit || []).length}</div>
                      <div className="text-[8px] text-gray-500">layers</div>
                    </div>
                    <div className="bg-white rounded p-1">
                      <div className="text-sm font-bold">{Number(qResult.rag_retrieval.top_score).toFixed(3)}</div>
                      <div className="text-[8px] text-gray-500">top score</div>
                    </div>
                    <div className="bg-white rounded p-1">
                      <div className="text-sm font-bold">{Number(qResult.rag_retrieval.avg_score).toFixed(3)}</div>
                      <div className="text-[8px] text-gray-500">avg score</div>
                    </div>
                    <div className="bg-white rounded p-1">
                      <div className="text-sm font-bold">{qResult.rag_retrieval.duration_ms}ms</div>
                      <div className="text-[8px] text-gray-500">latency</div>
                    </div>
                  </div>
                  <div className="text-[8px] text-blue-600 mb-1">Layers: {(qResult.rag_retrieval.layers_hit || []).join(", ")}</div>
                  <div className="text-[8px] text-gray-500 mb-2 truncate" title={qResult.rag_retrieval.query_text}>Query: {qResult.rag_retrieval.query_text}</div>
                  {(qResult.rag_retrieval.chunks || []).length > 0 && (
                    <div className="max-h-32 overflow-y-auto">
                      {qResult.rag_retrieval.chunks.map((c: A, i: number) => (
                        <div key={i} className="flex items-start gap-1.5 text-[8px] py-0.5 border-b border-blue-100">
                          <span className={`px-1 rounded shrink-0 ${
                            c.layer === 'knowledge' ? 'bg-yellow-100 text-yellow-700' :
                            c.layer === 'evidence' ? 'bg-purple-100 text-purple-700' :
                            c.layer === 'live' ? 'bg-green-100 text-green-700' :
                            c.layer === 'crime' ? 'bg-red-100 text-red-700' :
                            c.layer === 'security' ? 'bg-orange-100 text-orange-700' :
                            c.layer === 'property' ? 'bg-indigo-100 text-indigo-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>{c.layer}</span>
                          <span className="text-gray-600">{c.name || c.suburb || c.text_preview?.substring(0, 80)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>)}
          </div>
        )}
      </div>

      {/* ─── RAG ───────────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center">
          <h2 className="font-bold text-sm">Vector RAG</h2>
          <button onClick={() => { if (!rag) load("rag"); setShowRag(!showRag); }} className="text-[10px] text-blue-600 hover:underline">{showRag ? "Hide" : "Show"}</button>
        </div>

        {showRag && rag && (
          <div className="mt-3 space-y-4">
            {/* Chunk inventory */}
            <div>
              <h3 className="text-xs font-bold mb-1">Chunk Inventory ({rag.chunks?.total?.toLocaleString() || 0} total)</h3>
              <div className="grid grid-cols-4 gap-2">
                {(rag.chunks?.by_layer || []).map((l: A) => (
                  <div key={l.layer} className="bg-gray-50 rounded p-2 text-center">
                    <div className="text-lg font-bold">{Number(l.count).toLocaleString()}</div>
                    <div className="text-[9px] text-gray-500">{l.layer}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Quality stats */}
            {rag.quality && Number(rag.quality.total_retrievals) > 0 && (
              <div>
                <h3 className="text-xs font-bold mb-1">Retrieval Quality</h3>
                <div className="grid grid-cols-6 gap-2 text-center">
                  <div className="bg-blue-50 rounded p-2">
                    <div className="text-sm font-bold">{rag.quality.total_retrievals}</div>
                    <div className="text-[9px] text-gray-500">retrievals</div>
                  </div>
                  <div className="bg-green-50 rounded p-2">
                    <div className="text-sm font-bold">{Number(rag.quality.avg_chunks).toFixed(1)}</div>
                    <div className="text-[9px] text-gray-500">avg chunks</div>
                  </div>
                  <div className="bg-green-50 rounded p-2">
                    <div className="text-sm font-bold">{Number(rag.quality.overall_avg_score).toFixed(3)}</div>
                    <div className="text-[9px] text-gray-500">avg score</div>
                  </div>
                  <div className="bg-green-50 rounded p-2">
                    <div className="text-sm font-bold">{Number(rag.quality.overall_top_score).toFixed(3)}</div>
                    <div className="text-[9px] text-gray-500">top score</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-sm font-bold">{rag.quality.avg_duration_ms}ms</div>
                    <div className="text-[9px] text-gray-500">avg latency</div>
                  </div>
                  <div className={`rounded p-2 ${Number(rag.quality.fallback_count) > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                    <div className="text-sm font-bold">{rag.quality.fallback_count}</div>
                    <div className="text-[9px] text-gray-500">fallbacks</div>
                  </div>
                </div>
              </div>
            )}

            {/* Top articles */}
            {(rag.top_articles || []).length > 0 && (
              <div>
                <h3 className="text-xs font-bold mb-1">Most Retrieved Articles</h3>
                <div className="space-y-0.5">
                  {rag.top_articles.map((a: A, i: number) => (
                    <div key={i} className="flex justify-between text-[10px] py-0.5 border-b border-gray-50">
                      <span>{a.name}</span>
                      <span className="text-gray-400">{a.times_retrieved}x (avg {Number(a.avg_score).toFixed(3)})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent retrievals */}
            {(rag.recent || []).length > 0 && (
              <div>
                <h3 className="text-xs font-bold mb-1">Recent Retrievals</h3>
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-[9px]">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-1">Time</th>
                        <th className="text-left p-1">Query</th>
                        <th className="text-right p-1">Chunks</th>
                        <th className="text-left p-1">Layers</th>
                        <th className="text-right p-1">Top</th>
                        <th className="text-right p-1">Avg</th>
                        <th className="text-right p-1">ms</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rag.recent.map((r: A) => (
                        <tr key={r.id} className={`border-b border-gray-50 ${r.fallback_used ? 'bg-red-50' : ''}`}>
                          <td className="p-1 text-gray-400 whitespace-nowrap">{new Date(r.created_at).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                          <td className="p-1 max-w-[200px] truncate" title={r.query_text}>{r.fallback_used ? "FALLBACK" : r.query_text?.substring(0, 60)}</td>
                          <td className="p-1 text-right font-mono">{r.chunks_returned}</td>
                          <td className="p-1">{(r.layers_hit || []).join(", ")}</td>
                          <td className="p-1 text-right font-mono">{Number(r.top_score).toFixed(3)}</td>
                          <td className="p-1 text-right font-mono">{Number(r.avg_score).toFixed(3)}</td>
                          <td className="p-1 text-right font-mono">{r.duration_ms}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Test retrieval */}
            <div>
              <h3 className="text-xs font-bold mb-1">Test Retrieval</h3>
              <div className="flex gap-2">
                <input type="text" value={ragTestQuery} onChange={e => setRagTestQuery(e.target.value)}
                  placeholder="e.g. pre-1977 asbestos roof Centurion Gauteng"
                  className="flex-1 border rounded px-2 py-1 text-xs"
                  onKeyDown={e => { if (e.key === "Enter" && ragTestQuery.trim()) { setRagTestLoading(true); fetch(`/api/intelligence?section=rag_test&q=${encodeURIComponent(ragTestQuery)}`).then(r => r.json()).then(d => { setRagTestResult(d.rag_test || d); setRagTestLoading(false); }).catch(() => setRagTestLoading(false)); } }} />
                <button onClick={() => { if (!ragTestQuery.trim()) return; setRagTestLoading(true); fetch(`/api/intelligence?section=rag_test&q=${encodeURIComponent(ragTestQuery)}`).then(r => r.json()).then(d => { setRagTestResult(d.rag_test || d); setRagTestLoading(false); }).catch(() => setRagTestLoading(false)); }}
                  disabled={ragTestLoading || !ragTestQuery.trim()}
                  className="bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700 disabled:opacity-50">
                  {ragTestLoading ? "..." : "Search"}
                </button>
              </div>
              {ragTestResult?.results && (
                <div className="mt-2 max-h-48 overflow-y-auto">
                  {ragTestResult.results.map((r: A, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-[9px] py-1 border-b border-gray-50">
                      <span className={`px-1 rounded font-mono ${
                        r.layer === 'knowledge' ? 'bg-yellow-100 text-yellow-700' :
                        r.layer === 'evidence' ? 'bg-blue-100 text-blue-700' :
                        r.layer === 'live' ? 'bg-green-100 text-green-700' :
                        r.layer === 'property' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>{r.layer}</span>
                      <span className="font-mono text-gray-400 w-10 text-right shrink-0">{r.score.toFixed(3)}</span>
                      <span className="flex-1">{r.text}</span>
                    </div>
                  ))}
                </div>
              )}
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
