"use client";
import { useEffect, useState, useCallback } from "react";
import { formatZAR, formatDate, formatDateTime, severityColor, humanize } from "@/lib/format";

const AVAILABLE_MODELS = [
  { id: "claude-3-haiku-20240307", label: "Haiku 3 (cheapest)", cost: "$0.25/$1.25 per M tokens" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", cost: "$0.80/$4 per M tokens" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 (recommended)", cost: "$3/$15 per M tokens" },
  { id: "claude-opus-4-6", label: "Opus 4.6 (most capable)", cost: "$15/$75 per M tokens" },
];

const ROLE_LABELS: Record<string, { label: string; desc: string }> = {
  vision: { label: "Photo Analysis", desc: "Listing photos, Street View, satellite — the main cost driver" },
  synthesis: { label: "Report Synthesis", desc: "Final property report with decisions and risk scores" },
  tease: { label: "WhatsApp Tease", desc: "2-sentence property preview sent before the report" },
  extract: { label: "Feature Extraction", desc: "Extract structured data from listing descriptions" },
};

function ModelConfig() {
  const [config, setConfig] = useState<Record<string, string> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/intelligence?section=model_config").then(r => r.json()).then(d => {
      setConfig(d.config || {});
      setDefaults(d.defaults || {});
    });
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    const r = await fetch("/api/intelligence", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_model_config", config }),
    });
    const d = await r.json();
    if (d.ok) { setConfig(d.config); setMsg("Saved — takes effect on next API call"); }
    else setMsg("Error: " + d.error);
    setSaving(false);
    setTimeout(() => setMsg(null), 4000);
  }

  if (!config) return null;

  return (
    <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h2 className="font-bold text-sm">Model Configuration</h2>
          <p className="text-[10px] text-gray-400">Choose which Claude model to use for each task. Lower models save money, higher models improve quality.</p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-green-600">{msg}</span>}
          <button onClick={save} disabled={saving} className="px-4 py-1.5 bg-[#0D1B2A] text-white rounded text-xs font-semibold hover:bg-gray-800 disabled:opacity-50">
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
      <div className="space-y-3">
        {Object.entries(ROLE_LABELS).map(([role, info]) => (
          <div key={role} className="flex items-center gap-4 bg-gray-50 rounded p-3">
            <div className="w-40 shrink-0">
              <div className="text-xs font-bold">{info.label}</div>
              <div className="text-[9px] text-gray-400">{info.desc}</div>
            </div>
            <select
              value={config[role] || defaults[role] || ""}
              onChange={e => setConfig({ ...config, [role]: e.target.value })}
              className="flex-1 border rounded px-2 py-1.5 text-sm bg-white"
            >
              {AVAILABLE_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label} — {m.cost}</option>
              ))}
            </select>
            {config[role] !== defaults[role] && (
              <button onClick={() => setConfig({ ...config, [role]: defaults[role] })} className="text-[9px] text-blue-500 hover:underline shrink-0">
                Reset to default
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
  const [sampleImages, setSampleImages] = useState<A[] | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [recipe, setRecipe] = useState<A | null>(null);
  const [showRecipe, setShowRecipe] = useState(false);
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

  function resizeImage(file: File, maxDim = 1200): Promise<{ base64: string; mediaType: string }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        const [header, data] = dataUrl.split(",");
        const mediaType = header.match(/:(.*?);/)?.[1] || "image/jpeg";
        resolve({ base64: data, mediaType });
      };
      img.onerror = () => {
        // Fallback: send original
        const reader = new FileReader();
        reader.onload = (e) => {
          const d = e.target?.result as string;
          const [h, b] = d.split(",");
          resolve({ base64: b, mediaType: h.match(/:(.*?);/)?.[1] || "image/jpeg" });
        };
        reader.readAsDataURL(file);
      };
      img.src = URL.createObjectURL(file);
    });
  }

  async function handleUrlTest(url: string) {
    setQRunning(true); setQResult(null);
    try {
      // Submit URL — server downloads the image
      const submitResp = await fetch("/api/intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_comparison_url", image_url: url, rag_enabled: true }),
      });
      if (!submitResp.ok) { setQResult({ error: `Submit failed: ${submitResp.status}` }); setQRunning(false); return; }
      const { job_id } = await submitResp.json();
      if (!job_id) { setQResult({ error: "No job_id returned" }); setQRunning(false); return; }

      // Poll for result
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const pollResp = await fetch("/api/intelligence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "poll_comparison", job_id }),
          });
          const data = await pollResp.json();
          if (data.status === "done") { setQResult(data); setQRunning(false); return; }
          if (data.status === "error") { setQResult({ error: data.error }); setQRunning(false); return; }
        } catch {}
      }
      setQResult({ error: "Timed out after 3 minutes" });
    } catch (err) {
      setQResult({ error: err instanceof Error ? err.message : "Unknown error" });
    }
    setQRunning(false);
  }

  async function handlePhotoDrop(f: File) {
    setQRunning(true); setQResult(null);
    try {
      // Resize image
      let base64: string, mediaType: string;
      try {
        const resized = await resizeImage(f);
        base64 = resized.base64;
        mediaType = resized.mediaType;
      } catch (resizeErr) {
        // Fallback: read raw file
        const buf = await f.arrayBuffer();
        base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        mediaType = f.type || "image/jpeg";
      }

      const payloadSize = base64.length;
      console.log(`[test-nico] Image: ${f.name}, payload: ${Math.round(payloadSize / 1024)}KB`);

      // Step 1: Submit job via XMLHttpRequest (more reliable than fetch for large bodies)
      const jobId = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/intelligence");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.timeout = 30000;
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.job_id) resolve(data.job_id);
            else reject(new Error(data.error || `No job_id (HTTP ${xhr.status})`));
          } catch { reject(new Error(`Bad response: ${xhr.responseText.substring(0, 100)}`)); }
        };
        xhr.onerror = () => reject(new Error(`Upload failed (${payloadSize} bytes) — try a smaller image`));
        xhr.ontimeout = () => reject(new Error("Upload timed out"));
        xhr.send(JSON.stringify({ action: "run_comparison", image_base64: base64, image_media_type: mediaType, rag_enabled: true }));
      });

      console.log(`[test-nico] Job submitted: ${jobId}`);

      // Step 2: Poll for result every 3 seconds
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const pollResp = await fetch("/api/intelligence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "poll_comparison", job_id: jobId }),
          });
          const data = await pollResp.json();
          if (data.status === "done") { setQResult(data); setQRunning(false); return; }
          if (data.status === "error") { setQResult({ error: data.error }); setQRunning(false); return; }
        } catch { /* network blip — keep polling */ }
      }
      setQResult({ error: "Timed out after 3 minutes" });
    } catch (err) {
      setQResult({ error: err instanceof Error ? err.message : "Unknown error" });
    }
    setQRunning(false);
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

      {/* ─── Model Configuration ─────────────────────────────────── */}
      <ModelConfig />

      {/* ─── Test Nico ──────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Test Nico</h2>
        <p className="text-xs text-gray-400 mb-2">Pick a property image from the database or paste a URL. Compares Base Nico vs Nico + RAG.</p>

        {/* Image picker from DB */}
        <div className="mb-3">
          <button
            onClick={async () => { setSampleLoading(true); const d = await (await fetch("/api/intelligence?section=sample_images")).json(); setSampleImages(d.images || []); setSampleLoading(false); }}
            className="text-xs text-blue-600 hover:underline mb-2"
          >{sampleLoading ? "Loading..." : sampleImages ? "Refresh images" : "Pick from database"}</button>
          {sampleImages && sampleImages.length > 0 && (
            <div className="grid grid-cols-6 gap-2 mb-2">
              {sampleImages.map((img: A) => (
                <button key={img.id} onClick={() => { if (!qRunning) handleUrlTest(img.image_url); }}
                  disabled={qRunning}
                  className="relative group rounded overflow-hidden border hover:border-blue-500 disabled:opacity-50"
                  title={`${img.address_raw || img.suburb} — ${img.photo_type || img.image_type || "photo"}`}
                >
                  <img src={img.image_url} alt="" className="w-full h-16 object-cover" loading="lazy" />
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[8px] text-white truncate">
                    {img.suburb}{img.construction_era ? ` · ${img.construction_era}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 mb-2">
          <input type="text" placeholder="Or paste image URL..." className="flex-1 border rounded px-3 py-2 text-sm"
            onKeyDown={e => { if (e.key === "Enter") { const url = (e.target as HTMLInputElement).value.trim(); if (url && !qRunning) handleUrlTest(url); } }}
            id="test-nico-url" disabled={qRunning} />
          <button onClick={() => { const el = document.getElementById("test-nico-url") as HTMLInputElement; if (el?.value.trim() && !qRunning) handleUrlTest(el.value.trim()); }}
            disabled={qRunning} className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">
            {qRunning ? "Analysing..." : "Test"}
          </button>
        </div>

        {qRunning && <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-700 text-center">Running Nico without RAG vs Nico with RAG — takes about 60 seconds...</div>}

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
                  <div className="text-[8px] text-blue-600 mb-1">Layers: {(qResult.rag_retrieval.layers_hit || []).map((l: string) => l === "knowledge" ? "articles" : l).join(", ")}</div>
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
                          }`}>{c.layer === "knowledge" ? "articles" : c.layer}</span>
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

      {/* ─── Nico's Recipe ────────────────────────────────────────── */}
      <div className="bg-[#0D1B2A] text-white rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="font-bold text-sm">Nico&apos;s Recipe</h2>
            <p className="text-[10px] text-gray-400">What prompts, models, RAG layers, and data Nico uses for each activity</p>
          </div>
          <button onClick={() => { if (!recipe) fetch("/api/intelligence?section=nico_recipe").then(r => r.json()).then(d => setRecipe(d.recipe)); setShowRecipe(!showRecipe); }}
            className="text-[10px] text-blue-400 hover:underline">{showRecipe ? "Hide" : "Show recipe"}</button>
        </div>

        {showRecipe && recipe && (
          <div className="mt-4 space-y-4">
            {/* Activities */}
            <div>
              <h3 className="text-xs font-bold text-gray-300 mb-2">Activities</h3>
              <div className="space-y-2">
                {recipe.activities?.map((a: A, i: number) => (
                  <div key={i} className="bg-white/5 rounded p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-sm">{a.name}</span>
                      <span className="text-[9px] px-1.5 py-0.5 bg-blue-900 rounded font-mono">{a.model}</span>
                      <span className="text-[9px] text-gray-400 ml-auto">{a.cost}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-[10px]">
                      <div>
                        <div className="text-gray-500 font-bold mb-0.5">Inputs</div>
                        {a.inputs?.map((inp: string, ii: number) => <div key={ii} className="text-gray-300">{inp}</div>)}
                      </div>
                      <div>
                        <div className="text-gray-500 font-bold mb-0.5">RAG</div>
                        {a.rag?.enabled ? (
                          <>
                            <div className="text-green-400">Enabled — {a.rag.budget}</div>
                            <div className="text-gray-400">Layers: {a.rag.layers?.join(", ")}</div>
                            <div className="text-gray-500 truncate" title={a.rag.query}>Query: {a.rag.query}</div>
                          </>
                        ) : <div className="text-gray-600">Not used</div>}
                      </div>
                      <div>
                        <div className="text-gray-500 font-bold mb-0.5">Output</div>
                        <div className="text-gray-300">{a.output}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* RAG Layers */}
            <div>
              <h3 className="text-xs font-bold text-gray-300 mb-2">RAG Layers</h3>
              <div className="grid grid-cols-2 gap-2">
                {recipe.rag_layers?.map((l: A) => (
                  <div key={l.layer} className="bg-white/5 rounded p-2 text-[10px]">
                    <div className="flex justify-between">
                      <span className="font-bold text-amber-400">{l.layer}</span>
                      <span className="text-gray-500 font-mono">{l.source}</span>
                    </div>
                    <div className="text-gray-400">{l.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Embedding & Reseed */}
            <div className="grid grid-cols-2 gap-4 text-[10px]">
              <div className="bg-white/5 rounded p-2">
                <div className="text-gray-500 font-bold mb-0.5">Embedding Model</div>
                <div className="text-gray-300">{recipe.embedding?.model} ({recipe.embedding?.dims} dims)</div>
                <div className="text-gray-500">{recipe.embedding?.library}</div>
                <div className="text-gray-500">Index: {recipe.embedding?.index}</div>
              </div>
              <div className="bg-white/5 rounded p-2">
                <div className="text-gray-500 font-bold mb-0.5">RAG Re-seed Schedule</div>
                <div className="text-gray-300">{recipe.reseed?.schedule}</div>
                <div className="text-gray-300">{recipe.reseed?.manual}</div>
                <div className="text-amber-400">{recipe.reseed?.auto}</div>
              </div>
            </div>
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
                    <div className="text-[9px] text-gray-500">{l.layer === "knowledge" ? "articles" : l.layer}</div>
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
                      }`}>{r.layer === "knowledge" ? "articles" : r.layer}</span>
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
