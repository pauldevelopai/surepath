import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import FeedbackButton from "./components/FeedbackButton";
import AdminNav from "./components/AdminNav";

const sections = [
  {
    label: "SALES",
    items: [
      { href: "/admin/sales/orders", label: "Orders" },
      { href: "/admin/sales/analytics", label: "Revenue" },
      { href: "/admin/billing", label: "Billing" },
    ],
  },
  {
    label: "DATA",
    items: [
      { href: "/admin/data/properties", label: "Properties" },
      { href: "/admin/data/scraper", label: "Scraper" },
      { href: "/admin/data/rag-review", label: "RAG Review" },
      { href: "/admin/data/knowledge-base", label: "RAG Seeding" },
      { href: "/admin/services", label: "Service Providers" },
      { href: "/admin/intelligence", label: "Nico's Brain" },
    ],
  },
  {
    label: "MARKETING",
    items: [
      { href: "/admin/content", label: "Create Video" },
      { href: "/admin/videos", label: "Videos" },
      { href: "/admin/viral-lessons", label: "Viral Lessons" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { href: "/admin/conversations", label: "Conversations" },
      { href: "/admin/feedback", label: "Feedback" },
      { href: "/admin/api", label: "Clients & Docs" },
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
        /* Hide every piece of the admin chrome in PDF output */
        aside, header { display: none !important; }
        main { padding: 0 !important; margin: 0 !important; }
        body { background: white !important; }
        .flex.min-h-screen { display: block !important; }
      }
    `}</style>
    <div className="flex min-h-screen">
      <AdminNav sections={sections} user={session.user} />
      {/* Main content — adds top padding on mobile for the fixed header */}
      <main className="flex-1 pt-16 md:pt-6 px-4 md:px-6 pb-6 overflow-auto print:overflow-visible w-full md:w-auto print:pt-0">
        {children}
      </main>
    </div>
    <FeedbackButton />
    </>
  );
}
