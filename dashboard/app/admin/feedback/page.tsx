"use client";
import { useEffect, useState, useCallback } from "react";
import { formatDateTime } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = Record<string, any>;

const STATUS_STYLE: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-800",
  in_progress: "bg-blue-100 text-blue-800",
  resolved: "bg-green-100 text-green-800",
};

const SECTION_LABEL: Record<string, string> = {
  general: "General",
  bug: "Bug Report",
  data_quality: "Data Quality",
  feature_request: "Feature Request",
  report: "Report Quality",
};

export default function FeedbackPage() {
  const [items, setItems] = useState<A[] | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(() => {
    fetch("/api/feedback?all=1").then(r => r.json()).then(d => setItems(d.feedback));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function updateStatus(id: number, status: string) {
    await fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_status", id, status }),
    });
    load();
  }

  async function deleteFeedback(id: number) {
    await fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    load();
  }

  if (!items) return <p className="text-gray-500">Loading...</p>;

  const filtered = filter === "all" ? items : items.filter(i => i.status === filter);
  const counts = {
    all: items.length,
    open: items.filter(i => i.status === "open").length,
    in_progress: items.filter(i => i.status === "in_progress").length,
    resolved: items.filter(i => i.status === "resolved").length,
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Feedback</h1>
      <p className="text-sm text-gray-500 mb-4">All feedback submitted via the floating button across the dashboard</p>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4">
        {(["all", "open", "in_progress", "resolved"] as const).map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-xs font-bold ${filter === s ? "bg-[#0D1B2A] text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
            {s === "all" ? "All" : s === "in_progress" ? "In Progress" : s.charAt(0).toUpperCase() + s.slice(1)} ({counts[s]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border rounded-lg p-8 text-center text-gray-400 text-sm">
          {items.length === 0 ? "No feedback yet. Use the ? button in the bottom right to submit feedback from any page." : "No feedback matching this filter."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item: A) => (
            <div key={item.id} className="bg-white border rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${STATUS_STYLE[item.status] || "bg-gray-100"}`}>
                      {item.status === "in_progress" ? "IN PROGRESS" : item.status?.toUpperCase()}
                    </span>
                    {item.feedback_type === "finding_rating" ? (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${item.rating === "good" || item.rating === "correct" ? "bg-green-100 text-green-700" : item.rating === "bad" || item.rating === "incorrect" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"}`}>
                        Finding: {item.rating?.toUpperCase()}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-gray-100 text-gray-600">
                        {SECTION_LABEL[item.section] || item.section}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400">{formatDateTime(item.created_at)}</span>
                  </div>
                  <div className="text-sm mt-1">
                    {item.feedback || (item.feedback_type === "finding_rating" && item.context ? (() => {
                      try {
                        const ctx = typeof item.context === "string" ? JSON.parse(item.context) : item.context;
                        return ctx?.observation || ctx?.what_i_see || ctx?.category || `Rating on finding in ${item.section}`;
                      } catch { return `Rating on finding in ${item.section}`; }
                    })() : "No text")}
                  </div>
                  <div className="flex gap-3 mt-1.5 text-[10px] text-gray-400">
                    {item.page_url && <span>Page: <span className="font-mono">{item.page_url}</span></span>}
                    {item.address_raw && <span>Property: {item.address_raw}{item.suburb ? `, ${item.suburb}` : ""}</span>}
                    {item.finding_hash && <span>Finding: {item.finding_hash}</span>}
                    {item.rating && <span>Rating: {item.rating}</span>}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {item.status !== "in_progress" && (
                    <button onClick={() => updateStatus(item.id, "in_progress")}
                      className="px-2 py-1 text-[10px] bg-blue-50 text-blue-700 rounded hover:bg-blue-100">
                      In Progress
                    </button>
                  )}
                  {item.status !== "resolved" && (
                    <button onClick={() => updateStatus(item.id, "resolved")}
                      className="px-2 py-1 text-[10px] bg-green-50 text-green-700 rounded hover:bg-green-100">
                      Resolve
                    </button>
                  )}
                  {item.status === "resolved" && (
                    <button onClick={() => updateStatus(item.id, "open")}
                      className="px-2 py-1 text-[10px] bg-yellow-50 text-yellow-700 rounded hover:bg-yellow-100">
                      Reopen
                    </button>
                  )}
                  <button onClick={() => deleteFeedback(item.id)}
                    className="px-2 py-1 text-[10px] bg-red-50 text-red-700 rounded hover:bg-red-100">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
