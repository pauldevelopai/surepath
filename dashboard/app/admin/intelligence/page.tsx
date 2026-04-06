"use client";
import { useEffect, useState, useCallback } from "react";
import { formatZAR, formatDate, severityColor } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const SCORE_LABELS = ["Specificity", "Accuracy", "Actionability", "Consistency"];

export default function IntelligenceHubPage() {
  const [summary, setSummary] = useState<A | null>(null);
  const [knowledge, setKnowledge] = useState<A | null>(null);
  const [quality, setQuality] = useState<A | null>(null);
  const [dailyCheck, setDailyCheck] = useState<A[] | null>(null);
  const [prompts, setPrompts] = useState<A[] | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const [kbForm, setKbForm] = useState<A | null>(null);
  const [kbSaving, setKbSaving] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<A | null>(null);

  const [qImage, setQImage] = useState<string | null>(null);
  const [qImagePreview, setQImagePreview] = useState<string | null>(null);
  const [qMediaType, setQMediaType] = useState("image/jpeg");
  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [qScores, setQScores] = useState<Record<string, number>>({});
  const [qSaving, setQSaving] = useState(false);
  const [checkVerdicts, setCheckVerdicts] = useState<Record<number, string>>({});

  const load = useCallback(async (section: string) => {
    const data = await (await fetch(`/api/intelligence?section=${section}`)).json();
    if (section === "summary") setSummary(data.summary);
    if (section === "knowledge") setKnowledge(data.knowledge);
    if (section === "quality") setQuality(data.quality);
    if (section === "daily_check") setDailyCheck(data.daily_check);
    if (section === "prompts") setPrompts(data.prompts);
  }, []);

  useEffect(() => { load("summary"); load("knowledge"); load("quality"); load("daily_check"); }, [load]);

  async function saveKb() { if (!kbForm?.name) return; setKbSaving(true); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_knowledge", ...kbForm }) }); setKbSaving(false); setKbForm(null); load("knowledge"); load("summary"); }
  async function toggleKb(id: number) { await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "toggle_knowledge", id }) }); load("knowledge"); load("summary"); }
  async function runAgent() { setAgentRunning(true); setAgentResult(null); const data = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_kb_agent" }) })).json(); setAgentResult(data); setAgentRunning(false); load("knowledge"); load("summary"); }

  function handlePhotoDrop(file: File) { const r = new FileReader(); r.onload = (e) => { const d = e.target?.result as string; setQImagePreview(d); const [h, b] = d.split(","); setQImage(b); setQMediaType(h.match(/:(.*?);/)?.[1] || "image/jpeg"); }; r.readAsDataURL(file); }
  async function runComparison() { if (!qImage) return; setQRunning(true); setQResult(null); const d = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_comparison", image_base64: qImage, image_media_type: qMediaType }) })).json(); setQResult(d); setQRunning(false); }
  async function saveScore() { if (!qResult) return; setQSaving(true); await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_quality_run", run_type: "isolated", rag_system: "vision_condition", query_text: "Photo comparison", response_without_rag: qResult.response_without_rag, response_with_rag: qResult.response_with_rag, score_specificity: qScores.specificity, score_accuracy: qScores.accuracy, score_actionability: qScores.actionability, score_consistency: qScores.consistency, notes: `KB entries: ${qResult.kb_entries_used || 0}` }) }); setQSaving(false); setQResult(null); setQScores({}); setQImage(null); setQImagePreview(null); load("quality"); load("summary"); }

  async function submitCheck(idx: number, verdict: string, reason?: string) {
    const item = dailyCheck?.[idx]; if (!item) return;
    setCheckVerdicts(v => ({ ...v, [idx]: verdict }));
    await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm_check", item_type: item.type, item_id: item.id || item.image_id, verdict, reason, property_id: item.property_id }) });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Nico's Brain</h1>
      <p className="text-sm text-gray-500 mb-4">Everything Nico knows, everything feeding him, and your daily sanity check.</p>

      {/* ─── All Stats ──────────────────────────────────────────────── */}
      {summary && (
        <div className="grid grid-cols-8 gap-2 mb-6">
          {[
            { label: "Properties", val: Number(summary.properties?.total || 0).toLocaleString() },
            { label: "Reports", val: summary.reports?.complete_reports || 0 },
            { label: "Photos Done", val: summary.images?.analysed_images || 0 },
            { label: "Findings", val: summary.images?.total_findings || 0 },
            { label: "KB Active", val: summary.knowledge_base?.active || 0 },
            { label: "Geocoded", val: summary.properties?.geocoded || 0 },
            { label: "Crime Suburbs", val: summary.crime?.suburbs || 0 },
            { label: "Deeds", val: summary.deeds_coverage || 0 },
          ].map(c => (
            <div key={c.label} className="bg-white border rounded p-2 text-center">
              <div className="text-lg font-bold">{c.val}</div>
              <div className="text-[8px] text-gray-500 uppercase">{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ─── Daily Check ────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h2 className="font-bold text-sm">Daily Check</h2>
            <p className="text-xs text-gray-400">10 random items from across the system. Confirm or correct to keep Nico honest.</p>
          </div>
          <button onClick={() => load("daily_check")} className="text-[10px] text-blue-600 hover:underline">Refresh</button>
        </div>

        {!dailyCheck ? <p className="text-gray-400 text-xs">Loading...</p> : dailyCheck.length === 0 ? <p className="text-gray-400 text-xs">No data to check yet — run some reports first.</p> : (
          <div className="space-y-2">
            {dailyCheck.map((item: A, idx: number) => {
              const verdict = checkVerdicts[idx];
              return (
                <div key={idx} className={`border rounded p-3 ${verdict === "correct" ? "border-green-200 bg-green-50/30" : verdict === "incorrect" ? "border-red-200 bg-red-50/30" : ""}`}>
                  <div className="flex items-start gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold shrink-0 mt-0.5 ${
                      item.type === "vision_finding" ? "bg-blue-100 text-blue-700" :
                      item.type === "report_decision" ? "bg-purple-100 text-purple-700" :
                      item.type === "knowledge_entry" ? "bg-yellow-100 text-yellow-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>{item.type === "vision_finding" ? "PHOTO" : item.type === "report_decision" ? "DECISION" : item.type === "knowledge_entry" ? "KB" : "EVIDENCE"}</span>
                    <div className="flex-1">
                      <div className="text-xs">{item.question}</div>
                      {item.image_url && item.image_url.startsWith("http") && <img src={item.image_url} alt="" className="w-24 h-16 object-cover rounded mt-1" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                      {item.severity && <span className={`inline-block mt-1 px-1 rounded text-[8px] ${severityColor[item.severity] || "bg-gray-200"}`}>{item.severity}</span>}
                    </div>
                    {!verdict ? (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => submitCheck(idx, "correct")} className="px-2 py-1 text-[10px] bg-green-100 text-green-700 rounded hover:bg-green-200">Correct</button>
                        <button onClick={() => submitCheck(idx, "incorrect")} className="px-2 py-1 text-[10px] bg-red-100 text-red-700 rounded hover:bg-red-200">Wrong</button>
                        <button onClick={() => submitCheck(idx, "unsure")} className="px-2 py-1 text-[10px] bg-gray-100 text-gray-500 rounded hover:bg-gray-200">Unsure</button>
                      </div>
                    ) : (
                      <span className={`text-[10px] font-bold shrink-0 ${verdict === "correct" ? "text-green-600" : verdict === "incorrect" ? "text-red-600" : "text-gray-400"}`}>{verdict}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── Knowledge Base ─────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="font-bold text-sm">Knowledge Base ({knowledge?.entries?.length || 0})</h2>
            <p className="text-xs text-gray-400">Active entries feed every vision analysis and report. Auto-build reviews existing findings.</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={runAgent} disabled={agentRunning} className="px-3 py-1 bg-[#E63946] text-white text-[10px] rounded font-bold disabled:opacity-50">{agentRunning ? "..." : "Auto-build"}</button>
            <button onClick={() => setKbForm({ name: "", description: "", visual_indicators: "", sa_context: "", severity: 3, cost_min_zar: "", cost_max_zar: "", category: "", status: "draft" })} className="px-3 py-1 bg-[#0D1B2A] text-white text-[10px] rounded">+ Add</button>
          </div>
        </div>
        {agentResult && <div className={`text-xs p-2 rounded mb-2 ${agentResult.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{agentResult.message}</div>}
        {kbForm && (
          <div className="border rounded p-3 mb-3 bg-blue-50">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input className="border rounded px-2 py-1 text-xs" placeholder="Name" value={kbForm.name} onChange={e => setKbForm({ ...kbForm, name: e.target.value })} />
              <select className="border rounded px-2 py-1 text-xs" value={kbForm.category} onChange={e => setKbForm({ ...kbForm, category: e.target.value })}><option value="">Category</option>{["roof","walls","damp","electrical","plumbing","ceiling","structure","extension","security","environment"].map(c => <option key={c} value={c}>{c}</option>)}</select>
            </div>
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="Description and visual indicators" value={kbForm.description} onChange={e => setKbForm({ ...kbForm, description: e.target.value })} />
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="SA context — regional patterns, costs, causes" value={kbForm.sa_context} onChange={e => setKbForm({ ...kbForm, sa_context: e.target.value })} />
            <div className="grid grid-cols-4 gap-2 mb-2">
              <div><label className="text-[9px] text-gray-500">Severity</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.severity} onChange={e => setKbForm({ ...kbForm, severity: Number(e.target.value) })}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
              <div><label className="text-[9px] text-gray-500">Min ZAR</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" value={kbForm.cost_min_zar} onChange={e => setKbForm({ ...kbForm, cost_min_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Max ZAR</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" value={kbForm.cost_max_zar} onChange={e => setKbForm({ ...kbForm, cost_max_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Status</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.status} onChange={e => setKbForm({ ...kbForm, status: e.target.value })}><option value="draft">Draft</option><option value="active">Active</option></select></div>
            </div>
            <div className="flex gap-2"><button onClick={saveKb} disabled={kbSaving} className="px-3 py-1 bg-green-600 text-white text-xs rounded disabled:opacity-50">{kbSaving ? "..." : "Save"}</button><button onClick={() => setKbForm(null)} className="px-3 py-1 text-xs text-gray-500">Cancel</button></div>
          </div>
        )}
        {knowledge?.entries && knowledge.entries.length > 0 && (
          <div className="space-y-1">
            {knowledge.entries.map((e: A) => (
              <div key={e.id} className={`flex items-center gap-2 text-xs border rounded px-2 py-1.5 ${e.status === "active" ? "border-green-200 bg-green-50/30" : ""}`}>
                <button onClick={() => toggleKb(e.id)} className={`px-1 py-0.5 rounded text-[8px] font-bold shrink-0 ${e.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>{e.status}</button>
                <span className={`px-1 rounded text-[8px] shrink-0 ${e.severity >= 4 ? "bg-red-100 text-red-800" : e.severity === 3 ? "bg-yellow-100 text-yellow-800" : "bg-gray-100"}`}>{e.severity}/5</span>
                <span className="capitalize text-gray-400 text-[8px] w-12 shrink-0">{e.category}</span>
                <span className="font-medium flex-1 truncate">{e.name}</span>
                {e.cost_min_zar && <span className="text-[8px] font-mono text-gray-400 shrink-0">{formatZAR(e.cost_min_zar)}–{formatZAR(e.cost_max_zar)}</span>}
                <button onClick={() => setKbForm(e)} className="text-[8px] text-blue-500 shrink-0">edit</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Test Nico ──────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Test Nico</h2>
        <p className="text-xs text-gray-400 mb-3">Same photo: generic Claude Vision vs Nico with knowledge base. See the difference.</p>
        <div className="border-2 border-dashed rounded p-3 mb-3 text-center bg-gray-50 hover:bg-gray-100 cursor-pointer"
          onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhotoDrop(f); }}
          onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = (ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) handlePhotoDrop(f); }; i.click(); }}>
          {qImagePreview ? (
            <div className="flex items-center justify-center gap-3">
              <img src={qImagePreview} alt="" className="w-24 h-18 object-cover rounded" />
              <button onClick={(e) => { e.stopPropagation(); runComparison(); }} disabled={qRunning} className="px-4 py-1.5 bg-[#0D1B2A] text-white text-xs rounded font-bold disabled:opacity-50">{qRunning ? "Analysing..." : "Compare"}</button>
            </div>
          ) : <span className="text-xs text-gray-500">Drop a photo or click</span>}
        </div>
        {qResult && (
          <div className="mb-3">
            <div className="grid grid-cols-2 gap-3 mb-2">
              <div><div className="text-[9px] font-bold text-gray-400 uppercase mb-1">Generic</div><div className="bg-gray-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">{qResult.response_without_rag}</div></div>
              <div><div className="text-[9px] font-bold text-green-700 uppercase mb-1">Nico ({qResult.kb_entries_used || 0} KB entries)</div><div className="bg-green-50 rounded p-2 text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">{qResult.response_with_rag}</div></div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {SCORE_LABELS.map(l => { const k = l.toLowerCase(); return (
                <div key={k} className="flex items-center gap-0.5"><span className="text-[8px] text-gray-500">{l}</span>{[1,2,3,4,5].map(n => <button key={n} onClick={() => setQScores({ ...qScores, [k]: n })} className={`w-4 h-4 rounded text-[8px] ${qScores[k] === n ? "bg-[#0D1B2A] text-white" : "bg-gray-200"}`}>{n}</button>)}</div>
              ); })}
              <button onClick={saveScore} disabled={qSaving || !qScores.specificity} className="px-2 py-1 bg-green-600 text-white text-[10px] rounded disabled:opacity-50 ml-auto">{qSaving ? "..." : "Save"}</button>
            </div>
          </div>
        )}
        {quality?.runs && quality.runs.length > 0 && (
          <div className="text-[10px] text-gray-400 mt-2">{quality.runs.length} comparison{quality.runs.length !== 1 ? "s" : ""} saved</div>
        )}
      </div>

      {/* ─── Nico's Prompts ─────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="font-bold text-sm">Nico's Prompts</h2>
            <p className="text-xs text-gray-400">The system prompts that define how Nico thinks and speaks.</p>
          </div>
          <button onClick={() => { if (!prompts) load("prompts"); setShowPrompts(!showPrompts); }} className="text-[10px] text-blue-600 hover:underline">{showPrompts ? "Hide" : "Show"}</button>
        </div>
        {showPrompts && prompts && (
          <div className="mt-3 space-y-3">
            {prompts.map((p: A, i: number) => (
              <div key={i} className="border rounded p-3">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-bold">{p.name}</span>
                  <span className="text-[9px] text-gray-400 font-mono">{p.source}</span>
                </div>
                <pre className="text-[10px] text-gray-600 whitespace-pre-wrap max-h-60 overflow-y-auto bg-gray-50 rounded p-2">{p.prompt}</pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── Scrapers link ──────────────────────────────────────────── */}
      <div className="text-center text-xs text-gray-400 pb-4">
        All scraper data feeds Nico automatically. <a href="/admin/data/scraper" className="text-blue-600 hover:underline">Run scrapers</a> | <a href="/admin/data/properties" className="text-blue-600 hover:underline">Manage properties</a>
      </div>
    </div>
  );
}
