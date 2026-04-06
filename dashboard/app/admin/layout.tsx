import Link from "next/link";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import FeedbackButton from "./components/FeedbackButton";

const sections = [
  {
    label: "SALES",
    items: [
      { href: "/admin/sales/orders", label: "Orders" },
      { href: "/admin/sales/analytics", label: "Money" },
    ],
  },
  {
    label: "DATA",
    items: [
      { href: "/admin/data/properties", label: "Properties" },
      { href: "/admin/data/scraper", label: "Scraper" },
      { href: "/admin/services", label: "Service Providers" },
    ],
  },
  {
    label: "MARKETING",
    items: [
      { href: "/admin/content", label: "Create Video" },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { href: "/admin/intelligence", label: "Nico's Brain" },
    ],
  },
  {
    label: "API",
    items: [
      { href: "/admin/api", label: "Clients & Docs" },
      { href: "/admin/billing", label: "Billing" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { href: "/admin/feedback", label: "Feedback" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <>
    <style>{`
      @media print {
        aside { display: none !important; }
        main { padding: 0 !important; }
        .flex.min-h-screen { display: block !important; }
        body { background: white !important; }
      }
    `}</style>
    <div className="flex min-h-screen">
      <aside className="w-56 bg-[#0D1B2A] text-white flex flex-col shrink-0 print:hidden">
        <div className="p-4 text-xl font-bold tracking-widest border-b border-white/10">
          SUREPATH
        </div>
        <nav className="flex-1 p-3 space-y-4 overflow-y-auto">
          {sections.map((s) => (
            <div key={s.label}>
              <div className="text-[10px] font-bold tracking-widest text-gray-500 px-2 mb-1">
                {s.label}
              </div>
              {s.items.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="block px-3 py-1.5 rounded text-sm hover:bg-white/10 transition"
                >
                  {n.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-white/10 text-xs text-gray-400">
          {session.user}
        </div>
      </aside>
      <main className="flex-1 p-6 overflow-auto print:overflow-visible">{children}</main>
    </div>
    <FeedbackButton />
    </>
  );
}
