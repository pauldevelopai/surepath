"use client";
import { useEffect, useState, useCallback } from "react";
import { formatDate, formatDateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATE_COLORS: Record<string, string> = {
  awaiting_property: "bg-gray-100 text-gray-600",
  scraping: "bg-blue-100 text-blue-700",
  tease_sent: "bg-amber-100 text-amber-700",
  payment_pending: "bg-orange-100 text-orange-700",
  generating: "bg-purple-100 text-purple-700",
  report_ready: "bg-green-100 text-green-700",
};

export default function ConversationsPage() {
  const [users, setUsers] = useState<any[] | null>(null);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    fetch("/api/conversations").then(r => r.json()).then(d => setUsers(d.users || []));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  async function openUser(phone: string) {
    setSelectedPhone(phone);
    setDetailLoading(true);
    const d = await (await fetch(`/api/conversations?phone=${encodeURIComponent(phone)}`)).json();
    setDetail(d);
    setDetailLoading(false);
  }

  if (!users) return <p className="text-gray-500 p-8">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Conversations</h1>
      <p className="text-sm text-gray-500 mb-4">WhatsApp users, messages, and conversation state</p>

      <div className="flex gap-4" style={{ height: "calc(100vh - 180px)" }}>
        {/* User list */}
        <div className="w-80 shrink-0 overflow-y-auto border rounded-lg bg-white">
          {users.length === 0 ? (
            <p className="text-gray-400 text-sm p-4">No conversations yet</p>
          ) : users.map(u => (
            <button key={u.phone_number} onClick={() => openUser(u.phone_number)}
              className={`w-full text-left p-3 border-b hover:bg-gray-50 ${selectedPhone === u.phone_number ? "bg-blue-50" : ""}`}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-mono text-sm font-bold">{u.phone_number}</div>
                  <div className="text-[10px] text-gray-400">{u.total_messages} messages · {formatDate(u.last_message_at)}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {u.state && (
                    <span className={"px-1.5 py-0.5 rounded text-[8px] font-bold " + (STATE_COLORS[u.state] || "bg-gray-100 text-gray-600")}>
                      {u.state.replace(/_/g, " ")}
                    </span>
                  )}
                  {Number(u.paid_count) > 0 && <span className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-green-200 text-green-800">{u.paid_count} paid</span>}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Chat view */}
        <div className="flex-1 border rounded-lg bg-white flex flex-col">
          {!selectedPhone ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Select a user to view their conversation</div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading...</div>
          ) : detail ? (
            <>
              {/* Header */}
              <div className="p-3 border-b bg-gray-50">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold">{detail.phone}</span>
                    {detail.conversation && (
                      <span className={"ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold " + (STATE_COLORS[detail.conversation.state] || "bg-gray-100")}>
                        {detail.conversation.state?.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {detail.messages?.length || 0} messages · {detail.orders?.length || 0} orders
                    {detail.conversation?.listing_url && (
                      <a href={detail.conversation.listing_url} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline ml-2">Current listing</a>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[#e5ddd5]">
                {(detail.messages || []).map((m: any) => (
                  <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-[#dcf8c6] text-gray-800" : "bg-white text-gray-800"}`}>
                      <div className="whitespace-pre-wrap break-words">{m.body || (m.media_url ? "[Media]" : "—")}</div>
                      <div className="text-[9px] text-gray-400 text-right mt-1">{formatDateTime(m.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Orders */}
              {detail.orders?.length > 0 && (
                <div className="p-3 border-t bg-gray-50">
                  <div className="text-[10px] text-gray-500 font-bold mb-1">Orders</div>
                  <div className="flex gap-2 flex-wrap">
                    {detail.orders.map((o: any) => (
                      <div key={o.id} className={`text-[10px] px-2 py-1 rounded ${o.payment_status === "paid" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                        #{o.id} · R{o.price_zar} · {o.payment_status} · {formatDate(o.created_at)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
