"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass }),
    });
    if (res.ok) {
      router.push("/admin/data/properties");
    } else {
      setError("Invalid credentials");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0D1B2A]">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg p-8 w-80 space-y-4">
        <h1 className="text-2xl font-bold tracking-widest text-center text-[#0D1B2A]">
          SUREPATH
        </h1>
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder="Username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          type="password"
          placeholder="Password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <button className="w-full bg-[#E63946] text-white py-2 rounded font-semibold hover:bg-red-700 transition">
          Log in
        </button>
      </form>
    </div>
  );
}
