"use client";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [price, setPrice] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(d => setPrice(d.report_price));
  }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report_price: price }),
    });
    const d = await r.json();
    if (d.ok) setMsg(`Price updated to R${d.report_price}. Server restarted.`);
    else setMsg(d.error || "Failed");
    setSaving(false);
    setTimeout(() => setMsg(null), 5000);
  }

  if (price === null) return <p className="text-gray-500 p-8">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-6">System configuration</p>

      {msg && <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700 mb-4">{msg}</div>}

      <div className="bg-white border rounded-lg p-4 max-w-md">
        <h2 className="font-bold text-sm mb-3">Report Pricing</h2>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-400">R</span>
          <input
            type="number"
            value={price}
            onChange={e => setPrice(parseInt(e.target.value) || 0)}
            className="border rounded px-3 py-2 text-lg font-bold w-32"
            min={0}
            max={10000}
          />
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-[#0D1B2A] text-white rounded text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="text-[10px] text-gray-400 mt-2">This is the price shown to WhatsApp users and charged via PayFast. Changes take effect immediately.</p>
      </div>
    </div>
  );
}
