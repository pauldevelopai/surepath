"use client";
import { useEffect, useState, useCallback } from "react";
import { formatDate } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS_COLORS: Record<string, string> = {
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  pending: "bg-amber-100 text-amber-800",
  pending_review: "bg-yellow-100 text-yellow-800",
};

const LAYER_COLORS: Record<string, string> = {
  "live / crime": "bg-sky-600",
  property: "bg-blue-600",
  evidence: "bg-red-600",
  security_company: "bg-cyan-700",
  report: "bg-green-600",
  feedback: "bg-orange-600",
  knowledge: "bg-amber-600",
};

function formatZAR(n: number | null) { return n ? `R${Number(n).toLocaleString()}` : ""; }

export default function RAGReviewPage() {
  const [summary, setSummary] = useState<any[] | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allSelected, setAllSelected] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    fetch("/api/rag-review").then(r => r.json()).then(d => setSummary(d.sources));
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  async function loadDetail(source: string, pg = 1, f = "all") {
    setDetail(null);
    setExpanded(null);
    setAllSelected(false);
    const d = await (await fetch(`/api/rag-review?source=${source}&page=${pg}&filter=${f}`)).json();
    setDetail(d);
    setSelected(new Set());
  }

  function openSource(key: string) {
    setSelectedSource(key);
    setFilter("all");
    setPage(1);
    loadDetail(key, 1, "all");
  }

  function changePage(pg: number) { setPage(pg); if (selectedSource) loadDetail(selectedSource, pg, filter); }
  function changeFilter(f: string) { setFilter(f); setPage(1); if (selectedSource) loadDetail(selectedSource, 1, f); }

  function toggleSelect(id: number) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function post(body: any) {
    setActionMsg("Updating...");
    await fetch("/api/rag-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setActionMsg("Done");
    if (selectedSource) loadDetail(selectedSource, page, filter);
    loadSummary();
    setTimeout(() => setActionMsg(null), 2000);
  }

  if (!summary) return <p className="text-gray-500 p-8">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">RAG Review</h1>
      <p className="text-sm text-gray-500 mb-4">Review scraped data before it gets seeded. Pending items need your approval. Only approved items enter RAG.</p>

      {/* Source summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {summary.map(s => (
          <button key={s.key} onClick={() => openSource(s.key)}
            className={`text-left border rounded-lg p-3 transition ${selectedSource === s.key ? "border-blue-500 bg-blue-50" : "hover:border-gray-300"}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className={"w-2 h-2 rounded-full " + (LAYER_COLORS[s.layer] || "bg-gray-400")} />
              <span className="font-bold text-xs">{s.label}</span>
            </div>
            <div className="text-[9px] text-gray-400 mb-2">{s.layer} layer</div>
            <div className="flex gap-1 text-center flex-wrap">
              <div className="bg-gray-50 rounded p-1 flex-1"><div className="text-sm font-bold">{Number(s.total).toLocaleString()}</div><div className="text-[8px] text-gray-400">total</div></div>
              {Number(s.pending) > 0 && <div className="bg-amber-50 rounded p-1 flex-1"><div className="text-sm font-bold text-amber-600">{Number(s.pending).toLocaleString()}</div><div className="text-[8px] text-amber-500">pending</div></div>}
              <div className="bg-green-50 rounded p-1 flex-1"><div className="text-sm font-bold text-green-700">{Number(s.approved).toLocaleString()}</div><div className="text-[8px] text-gray-400">approved</div></div>
              {Number(s.rejected) > 0 && <div className="bg-red-50 rounded p-1 flex-1"><div className="text-sm font-bold text-red-600">{Number(s.rejected)}</div><div className="text-[8px] text-gray-400">rejected</div></div>}
            </div>
          </button>
        ))}
      </div>

      {/* Detail view */}
      {selectedSource && detail && (
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-bold text-sm">{detail.label}</h2>
              <span className="text-[10px] text-gray-400">{detail.total.toLocaleString()} items — layer: {detail.layer}</span>
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <button onClick={() => {
                if (allSelected) { setAllSelected(false); setSelected(new Set()); }
                else { setAllSelected(true); setSelected(new Set((detail?.rows || []).map((r: any) => r.id))); }
              }} className="px-3 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200">
                {allSelected ? "Deselect All" : `Select All (${detail.total.toLocaleString()})`}
              </button>
              {(selected.size > 0 || allSelected) && (<>
                <button onClick={() => {
                  if (allSelected) post({ action: "bulk_update_filtered", source: selectedSource, status: "approved", filter });
                  else post({ action: "update_status", source: selectedSource, ids: [...selected], status: "approved" });
                }} className="px-3 py-1 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700">
                  Approve {allSelected ? `All (${detail.total.toLocaleString()})` : `(${selected.size})`}
                </button>
                <button onClick={() => {
                  if (allSelected) post({ action: "bulk_update_filtered", source: selectedSource, status: "rejected", filter });
                  else post({ action: "update_status", source: selectedSource, ids: [...selected], status: "rejected" });
                }} className="px-3 py-1 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700">
                  Reject {allSelected ? `All (${detail.total.toLocaleString()})` : `(${selected.size})`}
                </button>
                {selectedSource === "rag_knowledge_entries" && (<>
                  <button onClick={() => {
                    if (allSelected) post({ action: "bulk_activate_filtered", filter });
                    else post({ action: "activate_knowledge", ids: [...selected] });
                  }} className="px-3 py-1 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700">
                    Activate {allSelected ? `All (${detail.total.toLocaleString()})` : `(${selected.size})`}
                  </button>
                </>)}
              </>)}
              {actionMsg && <span className="text-xs text-blue-600 self-center">{actionMsg}</span>}
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-1 mb-3">
            {["all", "pending", "approved", "rejected", "not_in_rag"].map(f => (
              <button key={f} onClick={() => changeFilter(f)}
                className={`px-2 py-1 rounded text-[10px] font-bold ${filter === f ? "bg-[#0D1B2A] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                {f === "not_in_rag" ? "Not in RAG" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Items */}
          <div className="space-y-1">
            {(detail.rows || []).map((row: any) => {
              const isExpanded = expanded === row.id;
              return (
                <div key={row.id} className={`border rounded ${isExpanded ? "border-blue-300 bg-blue-50/30" : "hover:bg-gray-50"}`}>
                  {/* Summary row */}
                  <div className="flex items-center gap-2 px-3 py-2 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : row.id)}>
                    <input type="checkbox" checked={selected.has(row.id)} onChange={(e) => { e.stopPropagation(); toggleSelect(row.id); }} onClick={e => e.stopPropagation()} />
                    <span className={"px-1.5 py-0.5 rounded text-[8px] font-bold shrink-0 " + (STATUS_COLORS[row.rag_status] || "bg-gray-100 text-gray-600")}>
                      {(row.rag_status || "approved").toUpperCase()}
                    </span>
                    {selectedSource === "rag_knowledge_entries" && (
                      <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold shrink-0 ${row.status === "active" ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-600"}`}>
                        {row.status?.toUpperCase()}
                      </span>
                    )}
                    <span className="text-xs flex-1 truncate">{renderTitle(selectedSource, row)}</span>
                    <span className="text-[9px] text-gray-400 shrink-0">{row.created_at ? formatDate(row.created_at) : ""}</span>
                    <span className="text-gray-300 text-xs">{isExpanded ? "▲" : "▼"}</span>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-3 border-t bg-white">
                      {renderDetail(selectedSource, row)}
                      <div className="flex gap-2 mt-3 pt-2 border-t">
                        <button onClick={() => post({ action: "update_status", source: selectedSource, ids: [row.id], status: "approved" })} className="px-3 py-1 bg-green-100 text-green-700 rounded text-xs hover:bg-green-200">Approve</button>
                        <button onClick={() => post({ action: "update_status", source: selectedSource, ids: [row.id], status: "rejected" })} className="px-3 py-1 bg-red-100 text-red-700 rounded text-xs hover:bg-red-200">Reject</button>
                        <button onClick={() => post({ action: "update_status", source: selectedSource, ids: [row.id], status: "pending_review" })} className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded text-xs hover:bg-yellow-200">Flag</button>
                        {selectedSource === "rag_knowledge_entries" && (<>
                          <button onClick={() => post({ action: "activate_knowledge", ids: [row.id] })} className="px-3 py-1 bg-blue-100 text-blue-700 rounded text-xs hover:bg-blue-200">Activate for RAG</button>
                        </>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {detail.rows?.length === 0 && <p className="text-gray-400 text-sm mt-4 text-center">No items matching this filter.</p>}

          {/* Pagination */}
          {detail.pages > 1 && (
            <div className="flex justify-center gap-1 mt-3">
              {page > 1 && <button onClick={() => changePage(page - 1)} className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200">Prev</button>}
              {Array.from({ length: Math.min(detail.pages, 10) }, (_, i) => {
                const pg = detail.pages <= 10 ? i + 1 : Math.max(1, page - 4) + i;
                if (pg > detail.pages) return null;
                return <button key={pg} onClick={() => changePage(pg)} className={`w-7 h-7 rounded text-xs ${pg === page ? "bg-[#0D1B2A] text-white" : "bg-gray-100 hover:bg-gray-200"}`}>{pg}</button>;
              })}
              {page < detail.pages && <button onClick={() => changePage(page + 1)} className="px-2 py-1 rounded text-xs bg-gray-100 hover:bg-gray-200">Next</button>}
              <span className="text-[10px] text-gray-400 self-center ml-2">Page {page} of {detail.pages}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderTitle(source: string, row: any): string {
  switch (source) {
    case "area_risk_data": return `[${row.risk_type}] ${row.suburb}, ${row.city} — ${row.risk_level || ""} (${row.source_name || ""})`;
    case "properties": return `${row.address_raw || row.suburb} — ${row.bedrooms || "?"}bed R${row.asking_price ? Number(row.asking_price).toLocaleString() : "?"}`;
    case "holly_evidence": return `[${row.severity}/${row.category}] ${(row.what_i_see || row.observation || "").substring(0, 100)}`;
    case "security_companies": return `${row.name} — ${row.province || ""} ${row.armed_response ? "[armed]" : ""} ${row.google_rating ? row.google_rating + "★" : ""}`;
    case "property_reports": return `${row.address_raw || row.suburb}: ${row.decision || "no decision"}`;
    case "data_feedback": return `[${row.rating || "?"}] ${row.section}: ${(row.feedback || "").substring(0, 80)}`;
    case "rag_knowledge_entries": return `[${row.category}] ${row.name} — severity ${row.severity}/5`;
    default: return String(row.id);
  }
}

function renderDetail(source: string, row: any) {
  switch (source) {
    case "rag_knowledge_entries":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Name:</span> {row.name}</div>
          <div><span className="font-bold text-gray-600">Category:</span> {row.category} | <span className="font-bold text-gray-600">Severity:</span> {row.severity}/5</div>
          {row.description && <div className="bg-gray-50 rounded p-3"><span className="font-bold text-gray-600 block text-xs mb-1">Description</span><p className="text-gray-700 whitespace-pre-wrap">{row.description}</p></div>}
          {row.visual_indicators && <div className="bg-yellow-50 rounded p-3"><span className="font-bold text-yellow-700 block text-xs mb-1">What to look for</span><p className="text-yellow-800">{row.visual_indicators}</p></div>}
          {row.sa_context && <div className="bg-blue-50 rounded p-3"><span className="font-bold text-blue-700 block text-xs mb-1">SA Context</span><p className="text-blue-800">{row.sa_context}</p></div>}
          {(row.cost_min_zar || row.cost_max_zar) && <div><span className="font-bold text-gray-600">Repair cost:</span> {formatZAR(row.cost_min_zar)} – {formatZAR(row.cost_max_zar)}</div>}
          {row.source_url && <div><span className="font-bold text-gray-600">Source:</span> <a href={row.source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{row.source_url}</a></div>}
          <div className="text-[10px] text-gray-400">Status: {row.status} | RAG status: {row.rag_status} | ID: {row.id}</div>
        </div>
      );

    case "area_risk_data": {
      let details: any = {};
      try { details = typeof row.details_json === "string" ? JSON.parse(row.details_json) : (row.details_json || {}); } catch {}
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Type:</span> {row.risk_type} | <span className="font-bold text-gray-600">Location:</span> {row.suburb}, {row.city}</div>
          <div><span className="font-bold text-gray-600">Risk level:</span> {row.risk_level || "—"} | <span className="font-bold text-gray-600">Score:</span> {row.risk_score ?? "—"}/10</div>
          <div><span className="font-bold text-gray-600">Source:</span> {row.source_name} {row.source_url && <a href={row.source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline ml-1">{row.source_url}</a>}</div>
          {Object.keys(details).length > 0 && (
            <div className="bg-gray-50 rounded p-3">
              <span className="font-bold text-gray-600 block text-xs mb-1">Full data</span>
              <pre className="text-[11px] text-gray-700 whitespace-pre-wrap max-h-64 overflow-y-auto">{JSON.stringify(details, null, 2)}</pre>
            </div>
          )}
          <div className="text-[10px] text-gray-400">Date: {row.data_date || "—"} | ID: {row.id}</div>
        </div>
      );
    }

    case "holly_evidence":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Category:</span> {row.category} | <span className="font-bold text-gray-600">Severity:</span> {row.severity} | <span className="font-bold text-gray-600">Location:</span> {row.suburb}, {row.city}</div>
          {row.what_i_see && <div className="bg-gray-50 rounded p-3"><span className="font-bold text-gray-600 block text-xs mb-1">What I see</span><p>{row.what_i_see}</p></div>}
          {row.observation && <div className="bg-yellow-50 rounded p-3"><span className="font-bold text-yellow-700 block text-xs mb-1">Observation</span><p>{row.observation}</p></div>}
        </div>
      );

    case "property_reports":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Property:</span> {row.address_raw || row.suburb}, {row.city}</div>
          <div><span className="font-bold text-gray-600">Decision:</span> <span className="font-bold">{row.decision || "none"}</span></div>
        </div>
      );

    case "security_companies":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Company:</span> {row.name}</div>
          <div><span className="font-bold text-gray-600">Province:</span> {row.province || "—"} | Armed response: {row.armed_response ? "Yes" : "No"} | Rating: {row.google_rating || "—"}★</div>
        </div>
      );

    case "data_feedback":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Section:</span> {row.section} | <span className="font-bold text-gray-600">Rating:</span> {row.rating}</div>
          {row.feedback && <div className="bg-gray-50 rounded p-3"><p>{row.feedback}</p></div>}
          {row.finding_hash && <div className="text-[10px] text-gray-400">Finding: {row.finding_hash}</div>}
        </div>
      );

    case "properties":
      return (
        <div className="mt-3 space-y-2 text-sm">
          <div><span className="font-bold text-gray-600">Address:</span> {row.address_raw}</div>
          <div><span className="font-bold text-gray-600">Location:</span> {row.suburb}, {row.city}</div>
          <div>{row.bedrooms && `${row.bedrooms} bed`} {row.property_type && `· ${row.property_type}`} {row.asking_price && `· ${formatZAR(row.asking_price)}`}</div>
        </div>
      );

    default:
      return <pre className="mt-3 text-[11px] text-gray-600 whitespace-pre-wrap">{JSON.stringify(row, null, 2)}</pre>;
  }
}
