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

  // KB
  const [kbForm, setKbForm] = useState<A | null>(null);
  const [kbSaving, setKbSaving] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<A | null>(null);

  // Comparison
  const [qImage, setQImage] = useState<string | null>(null);
  const [qImagePreview, setQImagePreview] = useState<string | null>(null);
  const [qMediaType, setQMediaType] = useState("image/jpeg");
  const [qRunning, setQRunning] = useState(false);
  const [qResult, setQResult] = useState<A | null>(null);
  const [qScores, setQScores] = useState<Record<string, number>>({});
  const [qSaving, setQSaving] = useState(false);

  const load = useCallback(async (section: string) => {
    const data = await (await fetch(`/api/intelligence?section=${section}`)).json();
    if (section === "summary") setSummary(data.summary);
    if (section === "knowledge") setKnowledge(data.knowledge);
    if (section === "quality") setQuality(data.quality);
  }, []);

  useEffect(() => { load("summary"); load("knowledge"); load("quality"); }, [load]);

  // ─── KB actions ─────────────────────────────────────────────────────
  async function saveKb() {
    if (!kbForm?.name) return;
    setKbSaving(true);
    await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_knowledge", ...kbForm }) });
    setKbSaving(false); setKbForm(null); load("knowledge"); load("summary");
  }
  async function toggleKb(id: number) {
    await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle_knowledge", id }) });
    load("knowledge"); load("summary");
  }
  async function runAgent() {
    setAgentRunning(true); setAgentResult(null);
    const data = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run_kb_agent" }) })).json();
    setAgentResult(data); setAgentRunning(false); load("knowledge"); load("summary");
  }

  // ─── Comparison actions ─────────────────────────────────────────────
  function handlePhotoDrop(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      setQImagePreview(dataUrl);
      const [header, base64] = dataUrl.split(",");
      setQImage(base64);
      setQMediaType(header.match(/:(.*?);/)?.[1] || "image/jpeg");
    };
    reader.readAsDataURL(file);
  }
  async function runComparison() {
    if (!qImage) return;
    setQRunning(true); setQResult(null);
    const data = await (await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run_comparison", image_base64: qImage, image_media_type: qMediaType }) })).json();
    setQResult(data); setQRunning(false);
  }
  async function saveScore() {
    if (!qResult) return;
    setQSaving(true);
    await fetch("/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_quality_run", run_type: "isolated", rag_system: "vision_condition",
        query_text: "Photo comparison", response_without_rag: qResult.response_without_rag,
        response_with_rag: qResult.response_with_rag, score_specificity: qScores.specificity,
        score_accuracy: qScores.accuracy, score_actionability: qScores.actionability,
        score_consistency: qScores.consistency, notes: `KB entries: ${qResult.kb_entries_used || 0}` }) });
    setQSaving(false); setQResult(null); setQScores({}); setQImage(null); setQImagePreview(null); load("quality"); load("summary");
  }

  const kbActive = Number(summary?.knowledge_base?.active || 0);
  const kbTotal = Number(summary?.knowledge_base?.total || 0);
  const qualityRuns = Number(summary?.quality?.runs || 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Nico's Brain</h1>
      <p className="text-sm text-gray-500 mb-4">What Nico knows, how he's improving, and what he still needs to learn. Nico sees the photos, reads the data, and tells buyers what matters.</p>

      {/* ─── Stats ──────────────────────────────────────────────────── */}
      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { label: "Properties", val: Number(summary.properties?.total || 0).toLocaleString(), sub: `${summary.reports?.unique_properties || 0} with reports` },
            { label: "Photos Analysed", val: `${summary.images?.analysed_images || 0}`, sub: `${summary.images?.properties_analysed || 0} properties, ${summary.images?.total_findings || 0} findings` },
            { label: "Knowledge Entries", val: `${kbActive} active`, sub: `${kbTotal} total — feeds every analysis` },
            { label: "Quality Score", val: qualityRuns > 0 ? (Number(summary.quality?.avg_score) || 0).toFixed(1) + "/5" : "—", sub: `${qualityRuns} comparison${qualityRuns !== 1 ? "s" : ""} run` },
          ].map(c => (
            <div key={c.label} className="bg-white border rounded-lg p-3">
              <div className="text-[9px] text-gray-500 uppercase tracking-wide">{c.label}</div>
              <div className="text-xl font-bold mt-0.5">{c.val}</div>
              <div className="text-[10px] text-gray-400">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* ─── What Nico knows (Knowledge Base) ───────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <div className="flex justify-between items-start mb-3">
          <div>
            <h2 className="font-bold text-sm">What Nico knows</h2>
            <p className="text-xs text-gray-400">Each active entry teaches Nico what to look for in photos and what it costs. Built from real findings and your expertise.</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={runAgent} disabled={agentRunning}
              className="px-3 py-1.5 bg-[#E63946] text-white text-xs rounded font-bold hover:bg-red-700 disabled:opacity-50">
              {agentRunning ? "Reviewing..." : "Auto-build from photos"}
            </button>
            <button onClick={() => setKbForm({ name: "", description: "", visual_indicators: "", sa_context: "", severity: 3, cost_min_zar: "", cost_max_zar: "", category: "", status: "draft" })}
              className="px-3 py-1.5 bg-[#0D1B2A] text-white text-xs rounded hover:bg-[#1a2d42]">+ Add</button>
          </div>
        </div>

        {agentResult && (
          <div className={`text-xs p-2 rounded mb-3 ${agentResult.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
            {agentResult.message}
          </div>
        )}

        {/* Form */}
        {kbForm && (
          <div className="border rounded p-3 mb-3 bg-blue-50">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input className="border rounded px-2 py-1 text-xs" placeholder="Name (e.g. Rising Damp — Cape Town)" value={kbForm.name} onChange={e => setKbForm({ ...kbForm, name: e.target.value })} />
              <select className="border rounded px-2 py-1 text-xs" value={kbForm.category} onChange={e => setKbForm({ ...kbForm, category: e.target.value })}>
                <option value="">Category...</option>
                {["roof", "walls", "damp", "electrical", "plumbing", "ceiling", "structure", "extension", "security", "environment", "general"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="What it is and what it looks like" value={kbForm.description} onChange={e => setKbForm({ ...kbForm, description: e.target.value })} />
            <textarea className="border rounded px-2 py-1 text-xs w-full mb-2" rows={2} placeholder="SA-specific context — why it matters here, local costs, common causes" value={kbForm.sa_context} onChange={e => setKbForm({ ...kbForm, sa_context: e.target.value })} />
            <div className="grid grid-cols-4 gap-2 mb-2">
              <div><label className="text-[9px] text-gray-500">Severity (1-5)</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.severity} onChange={e => setKbForm({ ...kbForm, severity: Number(e.target.value) })}>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
              <div><label className="text-[9px] text-gray-500">Cost Min (ZAR)</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" value={kbForm.cost_min_zar} onChange={e => setKbForm({ ...kbForm, cost_min_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Cost Max (ZAR)</label><input className="border rounded px-2 py-1 text-xs w-full" type="number" value={kbForm.cost_max_zar} onChange={e => setKbForm({ ...kbForm, cost_max_zar: e.target.value })} /></div>
              <div><label className="text-[9px] text-gray-500">Status</label><select className="border rounded px-2 py-1 text-xs w-full" value={kbForm.status} onChange={e => setKbForm({ ...kbForm, status: e.target.value })}><option value="draft">Draft</option><option value="active">Active</option></select></div>
            </div>
            <div className="flex gap-2">
              <button onClick={saveKb} disabled={kbSaving} className="px-3 py-1 bg-green-600 text-white text-xs rounded disabled:opacity-50">{kbSaving ? "Saving..." : "Save"}</button>
              <button onClick={() => setKbForm(null)} className="px-3 py-1 text-xs text-gray-500">Cancel</button>
            </div>
          </div>
        )}

        {/* Entries */}
        {knowledge?.entries && knowledge.entries.length > 0 ? (
          <div className="space-y-1">
            {knowledge.entries.map((e: A) => (
              <div key={e.id} className={`flex items-center gap-3 text-xs border rounded px-3 py-2 ${e.status === "active" ? "border-green-200 bg-green-50/30" : ""}`}>
                <button onClick={() => toggleKb(e.id)} className={`px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 ${e.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}>{e.status}</button>
                <span className={`px-1 rounded text-[9px] shrink-0 ${e.severity >= 4 ? "bg-red-100 text-red-800" : e.severity === 3 ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-600"}`}>{e.severity}/5</span>
                <span className="capitalize text-gray-400 text-[9px] w-14 shrink-0">{e.category}</span>
                <span className="font-medium flex-1 truncate">{e.name}</span>
                {e.cost_min_zar && <span className="text-[9px] font-mono text-gray-400 shrink-0">{formatZAR(e.cost_min_zar)}–{formatZAR(e.cost_max_zar)}</span>}
                <button onClick={() => setKbForm(e)} className="text-[9px] text-blue-500 shrink-0">edit</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-400 text-xs">No entries yet. Click "Auto-build from photos" to have Nico review existing findings and create draft entries, or add your own.</p>
        )}
      </div>

      {/* ─── Test Nico (Comparison) ─────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
        <h2 className="font-bold text-sm mb-1">Test Nico</h2>
        <p className="text-xs text-gray-400 mb-3">Drop a photo. Same image goes through Claude Vision (generic) vs Nico (with knowledge base). See the difference.</p>

        <div className="border-2 border-dashed rounded-lg p-4 mb-3 text-center bg-gray-50 hover:bg-gray-100 transition cursor-pointer"
          onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("image/")) handlePhotoDrop(f); }}
          onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = (ev) => { const f = (ev.target as HTMLInputElement).files?.[0]; if (f) handlePhotoDrop(f); }; i.click(); }}>
          {qImagePreview ? (
            <div className="flex items-center justify-center gap-4">
              <img src={qImagePreview} alt="" className="w-32 h-24 object-cover rounded" />
              <button onClick={(e) => { e.stopPropagation(); runComparison(); }} disabled={qRunning}
                className="px-4 py-2 bg-[#0D1B2A] text-white text-sm rounded font-bold hover:bg-[#1a2d42] disabled:opacity-50">
                {qRunning ? "Analysing..." : "Compare"}
              </button>
            </div>
          ) : (
            <div className="text-sm text-gray-500">Drop a property photo here <span className="text-gray-400 text-xs">(or click)</span></div>
          )}
        </div>

        {qResult && (
          <div className="mb-3">
            <div className="text-[10px] text-gray-400 mb-2">{qResult.kb_entries_used || 0} knowledge entries used</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <div className="text-[10px] font-bold text-gray-400 uppercase mb-1">Generic Claude Vision</div>
                <div className="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">{qResult.response_without_rag}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-green-700 uppercase mb-1">Nico (with knowledge base)</div>
                <div className="bg-green-50 rounded p-2 text-xs whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">{qResult.response_with_rag}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-bold">Score:</span>
              {SCORE_LABELS.map(label => {
                const key = label.toLowerCase();
                return (
                  <div key={key} className="flex items-center gap-1">
                    <span className="text-[9px] text-gray-500">{label}</span>
                    {[1,2,3,4,5].map(n => (
                      <button key={n} onClick={() => setQScores({ ...qScores, [key]: n })}
                        className={`w-5 h-5 rounded text-[9px] font-bold ${qScores[key] === n ? "bg-[#0D1B2A] text-white" : "bg-gray-200 text-gray-500"}`}>{n}</button>
                    ))}
                  </div>
                );
              })}
              <button onClick={saveScore} disabled={qSaving || !qScores.specificity}
                className="px-3 py-1 bg-green-600 text-white text-xs rounded disabled:opacity-50 ml-auto">{qSaving ? "..." : "Save"}</button>
            </div>
          </div>
        )}

        {quality?.runs && quality.runs.length > 0 && (
          <table className="w-full text-xs border-collapse mt-2">
            <thead><tr className="text-left text-gray-400 text-[9px] border-b"><th className="pb-1">Date</th><th className="pb-1 text-center">S</th><th className="pb-1 text-center">A</th><th className="pb-1 text-center">A</th><th className="pb-1 text-center">C</th><th className="pb-1 text-center">Avg</th><th className="pb-1">Notes</th></tr></thead>
            <tbody>
              {quality.runs.slice(0, 10).map((r: A) => {
                const avg = r.score_specificity ? ((Number(r.score_specificity) + Number(r.score_accuracy) + Number(r.score_actionability) + Number(r.score_consistency)) / 4).toFixed(1) : "—";
                return (
                  <tr key={r.id} className="border-b"><td className="py-1 text-gray-400">{formatDate(r.created_at)}</td>
                    <td className="py-1 text-center font-mono">{r.score_specificity ?? "—"}</td><td className="py-1 text-center font-mono">{r.score_accuracy ?? "—"}</td>
                    <td className="py-1 text-center font-mono">{r.score_actionability ?? "—"}</td><td className="py-1 text-center font-mono">{r.score_consistency ?? "—"}</td>
                    <td className="py-1 text-center font-mono font-bold">{avg}</td><td className="py-1 text-gray-400">{r.notes || ""}</td></tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── Data Coverage ──────────────────────────────────────────── */}
      {summary && (
        <div className="bg-white border rounded-lg p-4 shadow-sm mb-6">
          <h2 className="font-bold text-sm mb-1">Data feeding Nico</h2>
          <p className="text-xs text-gray-400 mb-3">Everything the scrapers collect goes into Nico's context. More data = better reports. <a href="/admin/data/scraper" className="text-blue-600 hover:underline">Run scrapers</a></p>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: "Geocoded", val: summary.properties?.geocoded || 0, total: summary.properties?.total },
              { label: "Crime Data", val: summary.crime?.suburbs || 0, sub: "suburbs" },
              { label: "Deeds", val: summary.deeds_coverage || 0, sub: "properties" },
              { label: "Vision", val: summary.images?.properties_analysed || 0, sub: "properties" },
            ].map(c => (
              <div key={c.label} className="bg-gray-50 rounded p-2 text-center">
                <div className="text-lg font-bold">{c.val}{c.total ? <span className="text-xs text-gray-400 font-normal">/{Number(c.total).toLocaleString()}</span> : null}</div>
                <div className="text-[9px] text-gray-500 uppercase">{c.label}{c.sub ? ` (${c.sub})` : ""}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
