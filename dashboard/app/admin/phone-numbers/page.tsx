"use client";
import { useEffect, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function PhoneNumbersPage() {
  const [numbers, setNumbers] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/phone-numbers").then(r => r.json()).then(setNumbers);
  }, []);

  async function switchNumber(number: string) {
    setLoading(true);
    setMsg(null);
    const r = await fetch("/api/phone-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "switch", number }),
    });
    const d = await r.json();
    setMsg(d.message || (d.ok ? "Switched" : "Failed"));
    setNumbers(d.numbers || numbers);
    setLoading(false);
  }

  if (!numbers) return <p className="text-gray-500 p-8">Loading...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Phone Numbers</h1>
      <p className="text-sm text-gray-500 mb-4">Manage which WhatsApp number Surepath sends from</p>

      {msg && <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-700 mb-4">{msg}</div>}

      <div className="space-y-3">
        {numbers.available?.map((num: any) => {
          const isActive = num.number === numbers.active;
          return (
            <div key={num.number} className={`border rounded-lg p-4 ${isActive ? "border-green-400 bg-green-50" : "hover:border-gray-300"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {isActive && <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />}
                  <div>
                    <div className="font-bold text-lg">{num.number}</div>
                    <div className="text-sm text-gray-500">{num.label}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {isActive ? (
                    <span className="px-3 py-1.5 bg-green-200 text-green-800 rounded text-sm font-bold">Active</span>
                  ) : (
                    <button
                      onClick={() => switchNumber(num.number)}
                      disabled={loading}
                      className="px-4 py-1.5 bg-[#0D1B2A] text-white rounded text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
                    >
                      {loading ? "Switching..." : "Switch to this number"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 bg-gray-50 border rounded-lg p-4 text-xs text-gray-500">
        <h3 className="font-bold text-gray-600 mb-1">How it works</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>Switching changes which number Surepath sends WhatsApp messages from</li>
          <li>Takes effect immediately — no restart needed</li>
          <li>Make sure the Twilio webhook is configured for the active number</li>
          <li>Webhook URL: <span className="font-mono">http://13.43.118.177/webhook/whatsapp</span></li>
        </ul>
      </div>
    </div>
  );
}
