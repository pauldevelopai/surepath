"use client";
import Link from "next/link";
import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string };
type NavSection = { label: string; items: NavItem[] };

export default function AdminNav({ sections, user }: { sections: NavSection[]; user: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  // Lock body scroll when drawer open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      {/* Mobile top bar — visible on small screens only, hidden when printing */}
      <header className="md:hidden print:hidden fixed top-0 left-0 right-0 h-12 bg-[#0D1B2A] text-white flex items-center justify-between px-3 z-40 border-b border-white/10">
        <button
          aria-label="Open menu"
          onClick={() => setOpen(true)}
          className="p-2 -ml-2 hover:bg-white/10 rounded"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="font-bold tracking-widest text-sm">SUREPATH</div>
        <div className="w-8" />
      </header>

      {/* Backdrop for mobile drawer */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-40"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — always visible on md+, drawer on mobile */}
      <aside
        className={`
          fixed md:static top-0 left-0 h-screen md:h-auto md:min-h-screen
          w-64 md:w-56 bg-[#0D1B2A] text-white flex flex-col shrink-0 z-50
          transition-transform duration-200 ease-out
          ${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0
          print:hidden
        `}
      >
        <div className="p-4 text-xl font-bold tracking-widest border-b border-white/10 flex justify-between items-center">
          <span>SUREPATH</span>
          <button
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="md:hidden p-1 -mr-1 hover:bg-white/10 rounded"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 p-3 space-y-4 overflow-y-auto">
          {sections.map((s) => (
            <div key={s.label}>
              <div className="text-[10px] font-bold tracking-widest text-gray-500 px-2 mb-1">
                {s.label}
              </div>
              {s.items.map((n) => {
                const active = pathname === n.href || pathname?.startsWith(n.href + "/");
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`block px-3 py-2 md:py-1.5 rounded text-sm transition ${active ? "bg-white/15" : "hover:bg-white/10"}`}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-white/10 text-xs text-gray-400">{user}</div>
      </aside>
    </>
  );
}
