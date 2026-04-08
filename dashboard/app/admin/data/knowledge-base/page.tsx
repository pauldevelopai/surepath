"use client";
import { useEffect, useState, useCallback } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAYER_COLORS: Record<string, string> = {
  articles: "bg-amber-600", knowledge: "bg-amber-600", evidence: "bg-red-600", vision: "bg-purple-600",
  live: "bg-sky-600", crime: "bg-red-800", security: "bg-teal-600",
  report: "bg-green-600", feedback: "bg-orange-600", property: "bg-blue-600",
  security_company: "bg-cyan-700",
};

export default function KnowledgeBasePage() {
  const [stats, setStats] = useState<any>(null);
  const [reseeding, setReseeding] = useState(false);
  const [reseedLog, setReseedLog] = useState<string[]>([]);
  const [scraperData, setScraperData] = useState<any>(null);

  const load = useCallback(() => {
    fetch("/api/scraper/collect-stats").then(r => r.json()).then(setStats).catch(() => {});
    fetch("/api/scraper").then(r => r.json()).then(setScraperData).catch(() => {});
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function reseed() {
    setReseeding(true);
    setReseedLog(["Starting RAG re-seed..."]);
    await fetch("/api/scraper", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rag_reseed" }) });
    // Poll for log
    const poll = setInterval(async () => {
      try {
        const d = await (await fetch("/api/scraper")).json();
        const proc = (d.scraper_processes || []).find((p: any) => p.name === "rag-reseed");
        if (proc?.log) setReseedLog(proc.log.slice(-30));
        if (!proc?.running && reseedLog.length > 1) { clearInterval(poll); setReseeding(false); load(); }
      } catch {}
    }, 3000);
  }

  const s = stats || {};
  const ragLayers: Record<string, number> = s.rag_chunks_by_layer || {};
  const ragTotal: number = s.rag_total_chunks || 0;
  const ragLastSeeded: string | null = s.rag_last_seeded || null;
  const ragPending: Record<string, { pending: number; layer: string }> = s.rag_pending_by_source || {};
  const totalRagPending = Object.values(ragPending).reduce((sum, v) => sum + (v.pending || 0), 0);

  // Check if rag-reseed process is running
  const reseedProc = (scraperData?.scraper_processes || []).find((p: any) => p.name === "rag-reseed");
  const reseedRunning = reseeding || reseedProc?.running;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Knowledge Base</h1>
      <p className="text-sm text-gray-500 mb-4">RAG vector store — chunks embedded from approved data. Re-seed to update.</p>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white border rounded-lg p-4">
          <div className="text-[9px] text-gray-500 uppercase tracking-wide">Total Chunks</div>
          <div className="text-3xl font-bold mt-1">{ragTotal.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">Embedded in vector store</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-[9px] text-gray-500 uppercase tracking-wide">Pending</div>
          <div className="text-3xl font-bold mt-1 text-amber-600">{totalRagPending.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">Approved data not yet seeded</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-[9px] text-gray-500 uppercase tracking-wide">Last Seeded</div>
          <div className="text-lg font-bold mt-1">{ragLastSeeded ? new Date(ragLastSeeded).toLocaleString() : "Never"}</div>
          <div className="text-[10px] text-gray-400">Daily 3am auto-seed via PM2</div>
        </div>
        <div className="bg-white border rounded-lg p-4 flex flex-col justify-between">
          <div className="text-[9px] text-gray-500 uppercase tracking-wide">Actions</div>
          <button
            onClick={reseed}
            disabled={reseedRunning}
            className={`mt-2 px-4 py-2 rounded text-sm font-semibold ${reseedRunning ? "bg-gray-300 text-gray-500" : "bg-[#E63946] text-white hover:bg-red-700"}`}
          >
            {reseedRunning ? "Re-seeding..." : "Re-seed RAG Now"}
          </button>
          <div className="text-[9px] text-gray-400 mt-1">Only seeds approved data</div>
        </div>
      </div>

      {/* Layer breakdown */}
      <div className="bg-white border rounded-lg p-4 mb-6">
        <h2 className="font-bold text-sm mb-3">Chunks by Layer</h2>
        <div className="space-y-2">
          {Object.entries(ragLayers)
            .sort(([, a], [, b]) => b - a)
            .map(([layer, count]) => {
              const pct = ragTotal > 0 ? Math.round((count / ragTotal) * 100) : 0;
              return (
                <div key={layer} className="flex items-center gap-3">
                  <div className="w-32 shrink-0 flex items-center gap-2">
                    <span className={"w-2.5 h-2.5 rounded-full " + (LAYER_COLORS[layer] || "bg-gray-400")} />
                    <span className="text-xs font-semibold">{layer === "knowledge" ? "articles" : layer}</span>
                  </div>
                  <div className="flex-1">
                    <div className="h-5 bg-gray-100 rounded-full overflow-hidden relative">
                      <div className={"h-full rounded-full " + (LAYER_COLORS[layer] || "bg-gray-400")} style={{ width: `${Math.max(pct, 1)}%` }} />
                      <span className="absolute right-2 top-0.5 text-[10px] font-mono font-bold text-gray-600">{count.toLocaleString()}</span>
                    </div>
                  </div>
                  <span className="text-[10px] text-gray-500 w-10 text-right">{pct}%</span>
                </div>
              );
            })}
        </div>
      </div>

      {/* Pending data */}
      {totalRagPending > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm text-amber-800 mb-2">Data Waiting to be Seeded</h2>
          <p className="text-xs text-amber-600 mb-3">These approved items will be embedded into RAG on the next re-seed.</p>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(ragPending)
              .filter(([, v]) => v.pending > 0)
              .sort(([, a], [, b]) => b.pending - a.pending)
              .map(([source, info]) => (
                <div key={source} className="flex justify-between text-xs bg-white rounded px-3 py-2 border border-amber-100">
                  <span className="text-gray-700">{source.replace(/_/g, " ")}</span>
                  <span className="text-amber-700 font-mono font-bold">{info.pending.toLocaleString()} &rarr; {info.layer}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Re-seed log */}
      {(reseedRunning || reseedLog.length > 1) && (
        <div className="bg-[#0D1B2A] rounded-lg p-4 mb-6">
          <h2 className="font-bold text-sm text-gray-200 mb-2">Re-seed Log</h2>
          <div className="font-mono text-[10px] max-h-64 overflow-y-auto space-y-0.5">
            {(reseedProc?.log || reseedLog).slice(-30).map((line: string, i: number) => (
              <div key={i} className={line.includes("ERROR") ? "text-red-400" : line.includes("Done") || line.includes("complete") ? "text-green-400" : "text-gray-400"}>{line}</div>
            ))}
            {reseedRunning && <div className="text-gray-500 animate-pulse">Running...</div>}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="bg-gray-50 border rounded-lg p-4 text-xs text-gray-500">
        <h3 className="font-bold text-gray-600 mb-1">How RAG seeding works</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>Only data with <span className="font-bold text-green-700">rag_status = approved</span> gets embedded</li>
          <li>Pending and rejected items are excluded</li>
          <li>Incremental — unchanged chunks are skipped (no re-embedding)</li>
          <li>Auto-seeds daily at 3am via PM2 cron</li>
          <li>Manual re-seed via the button above</li>
          <li>Review and approve data on the <a href="/admin/data/rag-review" className="text-blue-600 hover:underline">RAG Review</a> page</li>
        </ul>
      </div>
    </div>
  );
}
