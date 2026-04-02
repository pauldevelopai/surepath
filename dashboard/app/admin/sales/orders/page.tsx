"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/format";

interface Order {
  id: number;
  phone_number: string;
  address_raw: string;
  address_normalised: string | null;
  price_zar: number;
  payment_status: string;
  report_status: string | null;
  decision: string | null;
  was_resale: boolean;
  created_at: string;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [payFilter, setPayFilter] = useState("");
  const [repFilter, setRepFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams();
    if (payFilter) params.set("payment_status", payFilter);
    if (repFilter) params.set("report_status", repFilter);
    setLoading(true);
    fetch(`/api/orders?${params}`)
      .then((r) => r.json())
      .then(setOrders)
      .finally(() => setLoading(false));
  }, [payFilter, repFilter]);

  const badge = (val: string | null, map: Record<string, string>) => {
    if (!val) return <span className="text-gray-400 text-xs">--</span>;
    const cls = map[val] || "bg-gray-100 text-gray-800";
    return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{val}</span>;
  };

  const payColors: Record<string, string> = {
    paid: "bg-green-100 text-green-800",
    pending: "bg-yellow-100 text-yellow-800",
    failed: "bg-red-100 text-red-800",
  };

  const repColors: Record<string, string> = {
    complete: "bg-green-100 text-green-800",
    processing: "bg-blue-100 text-blue-800",
    pending: "bg-yellow-100 text-yellow-800",
    failed: "bg-red-100 text-red-800",
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Orders</h1>

      <div className="flex gap-4 mb-4">
        <select className="border rounded px-3 py-1.5 text-sm" value={payFilter} onChange={(e) => setPayFilter(e.target.value)}>
          <option value="">All payment statuses</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <select className="border rounded px-3 py-1.5 text-sm" value={repFilter} onChange={(e) => setRepFilter(e.target.value)}>
          <option value="">All report statuses</option>
          <option value="complete">Complete</option>
          <option value="processing">Processing</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#0D1B2A] text-white text-left">
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Payment</th>
              <th className="px-3 py-2">Report</th>
              <th className="px-3 py-2">Resale</th>
              <th className="px-3 py-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr
                key={o.id}
                className="border-b hover:bg-gray-50 cursor-pointer"
                onClick={() => router.push(`/admin/sales/orders/${o.id}`)}
              >
                <td className="px-3 py-2 font-mono">{o.phone_number}</td>
                <td className="px-3 py-2 max-w-xs truncate">{o.address_normalised || o.address_raw}</td>
                <td className="px-3 py-2">R{o.price_zar}</td>
                <td className="px-3 py-2">{badge(o.payment_status, payColors)}</td>
                <td className="px-3 py-2">{badge(o.report_status, repColors)}</td>
                <td className="px-3 py-2">{o.was_resale ? "Yes" : ""}</td>
                <td className="px-3 py-2 text-gray-500">{formatDateTime(o.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && orders.length === 0 && <p className="text-gray-400 mt-4">No orders found.</p>}
    </div>
  );
}
