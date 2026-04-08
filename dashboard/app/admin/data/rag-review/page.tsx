"use client";
import { useEffect, useState, useCallback } from "react";
import { formatDate } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS_COLORS: Record<string, string> = {
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
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

export default function RAGReviewPage() {
  const [summary, setSummary] = useState<any[] | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadSummary = useCallback(() => {
    fetch("/api/rag-review").then(r => r.json()).then(d => setSummary(d.sources));
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  async function loadDetail(source: string, pg = 1, f = "all") {
    setDetail(null);
    const d = await (await fetch(`/api/rag-review?source=${source}&page=${pg}&filter=${f}`)).json();
    setDetail(d);
    setSelected(new Set());
    setSelectAll(false);
  }

  function openSource(key: string) {
    setSelectedSource(key);
    setFilter("all");
    setPage(1);
    loadDetail(key, 1, "all");
  }

  function changePage(pg: number) {
    setPage(pg);
    if (selectedSource) loadDetail(selectedSource, pg, filter);
  }

  function changeFilter(f: string) {
    setFilter(f);
    setPage(1);
    if (selectedSource) loadDetail(selectedSource, 1, f);
  }

  function toggleSelect(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectAll) {
      setSelected(new Set());
    } else {
      setSelected(new Set((detail?.rows || []).map((r: any) => r.id)));
    }
    setSelectAll(!selectAll);
  }

  async function updateStatus(status: string) {
    if (!selectedSource || selected.size === 0) return;
    setActionMsg(`Updating ${selected.size} items...`);
    await fetch("/api/rag-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_status", source: selectedSource, ids: [...selected], status }),
    });
    setActionMsg(`${selected.size} items set to ${status}`);
    loadDetail(selectedSource, page, filter);
    loadSummary();
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function bulkAction(action: string) {
    if (!selectedSource) return;
    const label = action === "bulk_approve_all" ? "approving" : "rejecting";
    if (!confirm(`Are you sure you want to ${label} ALL items in this source?`)) return;
    setActionMsg(`${label} all...`);
    await fetch("/api/rag-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, source: selectedSource }),
    });
    setActionMsg("Done");
    loadDetail(selectedSource, page, filter);
    loadSummary();
    setTimeout(() => setActionMsg(null), 3000);
  }

  function previewText(source: string, row: any): string {
    switch (source) {
      case "area_risk_data":
        return `${row.risk_type}: ${row.suburb}, ${row.city} — ${row.risk_level || ""} (score ${row.risk_score || "?"})`;
      case "properties":
        return `${row.address_raw || row.suburb} — ${row.bedrooms || "?"}bed ${row.property_type || ""} R${row.asking_price ? Number(row.asking_price).toLocaleString() : "?"}`;
      case "holly_evidence":
        return `[${row.severity}] ${row.category}: ${(row.what_i_see || row.observation || "").substring(0, 120)}`;
      case "security_companies":
        return `${row.name} — ${row.province || "?"} ${row.armed_response ? "[armed]" : ""} ${row.google_rating ? row.google_rating + "★" : ""}`;
      case "property_reports":
        return `${row.address_raw || row.suburb}: ${row.decision || "no decision"}`;
      case "data_feedback":
        return `[${row.rating || "?"}] ${row.section}: ${(row.feedback || row.finding_hash || "").substring(0, 100)}`;
      case "rag_knowledge_entries":
        return `[${row.category}] ${row.name} — severity ${row.severity}/5 (${row.status})`;
      default:
        return JSON.stringify(row).substring(0, 100);
    }
  }

  if (!summary) return <p className="text-gray-500 p-8">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">RAG Data Review</h1>
      <p className="text-sm text-gray-500 mb-4">Review, approve, or reject scraped data before it enters the RAG knowledge base</p>

      {/* Source summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {summary.map(s => {
          const isActive = selectedSource === s.key;
          return (
            <button key={s.key} onClick={() => openSource(s.key)}
              className={`text-left border rounded-lg p-3 transition ${isActive ? "border-blue-500 bg-blue-50" : "hover:border-gray-300"}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={"w-2 h-2 rounded-full " + (LAYER_COLORS[s.layer] || "bg-gray-400")} />
                <span className="font-bold text-sm">{s.label}</span>
              </div>
              <div className="text-[10px] text-gray-400 mb-2">{s.layer} layer</div>
              <div className="grid grid-cols-3 gap-1 text-center">
                <div className="bg-gray-50 rounded p-1">
                  <div className="text-sm font-bold">{Number(s.total).toLocaleString()}</div>
                  <div className="text-[8px] text-gray-400">total</div>
                </div>
                <div className="bg-green-50 rounded p-1">
                  <div className="text-sm font-bold text-green-700">{Number(s.in_rag).toLocaleString()}</div>
                  <div className="text-[8px] text-gray-400">in RAG</div>
                </div>
                <div className={Number(s.rejected) > 0 ? "bg-red-50 rounded p-1" : "bg-gray-50 rounded p-1"}>
                  <div className={"text-sm font-bold " + (Number(s.rejected) > 0 ? "text-red-600" : "")}>{Number(s.rejected)}</div>
                  <div className="text-[8px] text-gray-400">rejected</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Detail view */}
      {selectedSource && detail && (
        <div className="bg-white border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-bold text-sm">{detail.label}</h2>
              <span className="text-[10px] text-gray-400">{detail.total.toLocaleString()} items — layer: {detail.layer}</span>
            </div>
            <div className="flex gap-2">
              {selected.size > 0 && (
                <>
                  <button onClick={() => updateStatus("approved")} className="px-3 py-1 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-700">
                    Approve ({selected.size})
                  </button>
                  <button onClick={() => updateStatus("rejected")} className="px-3 py-1 bg-red-600 text-white rounded text-xs font-semibold hover:bg-red-700">
                    Reject ({selected.size})
                  </button>
                  <button onClick={() => updateStatus("pending_review")} className="px-3 py-1 bg-yellow-500 text-white rounded text-xs font-semibold hover:bg-yellow-600">
                    Flag for Review ({selected.size})
                  </button>
                </>
              )}
              <button onClick={() => bulkAction("bulk_approve_all")} className="px-3 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200">
                Approve All
              </button>
            </div>
          </div>

          {actionMsg && <div className="text-xs text-blue-600 mb-2">{actionMsg}</div>}

          {/* Filters */}
          <div className="flex gap-1 mb-3">
            {["all", "approved", "rejected", "pending_review", "not_in_rag"].map(f => (
              <button key={f} onClick={() => changeFilter(f)}
                className={`px-2 py-1 rounded text-[10px] font-bold ${filter === f ? "bg-[#0D1B2A] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                {f === "not_in_rag" ? "Not in RAG" : f === "pending_review" ? "Flagged" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Table */}
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-1 w-8"><input type="checkbox" checked={selectAll} onChange={toggleSelectAll} /></th>
                <th className="pb-1">Preview</th>
                <th className="pb-1 w-24">Status</th>
                <th className="pb-1 w-20">Source</th>
                <th className="pb-1 w-24">Date</th>
              </tr>
            </thead>
            <tbody>
              {(detail.rows || []).map((row: any) => (
                <tr key={row.id} className="border-b hover:bg-gray-50">
                  <td className="py-1.5"><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleSelect(row.id)} /></td>
                  <td className="py-1.5 max-w-lg">
                    <div className="truncate">{previewText(selectedSource, row)}</div>
                    {row.details_preview && <div className="text-[9px] text-gray-400 truncate mt-0.5">{row.details_preview}</div>}
                  </td>
                  <td className="py-1.5">
                    <span className={"px-1.5 py-0.5 rounded text-[9px] font-bold " + (STATUS_COLORS[row.rag_status] || "bg-gray-100 text-gray-600")}>
                      {(row.rag_status || "approved").toUpperCase()}
                    </span>
                  </td>
                  <td className="py-1.5 text-gray-400">{row.source_name || row.risk_type || selectedSource.split("_")[0]}</td>
                  <td className="py-1.5 text-gray-400">{row.created_at ? formatDate(row.created_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {detail.rows?.length === 0 && <p className="text-gray-400 text-sm mt-4 text-center">No items matching this filter.</p>}

          {/* Pagination */}
          {detail.pages > 1 && (
            <div className="flex justify-center gap-1 mt-3">
              {Array.from({ length: Math.min(detail.pages, 20) }, (_, i) => i + 1).map(pg => (
                <button key={pg} onClick={() => changePage(pg)}
                  className={`w-7 h-7 rounded text-xs ${pg === page ? "bg-[#0D1B2A] text-white" : "bg-gray-100 hover:bg-gray-200"}`}>
                  {pg}
                </button>
              ))}
              {detail.pages > 20 && <span className="text-xs text-gray-400 self-center">...{detail.pages}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
