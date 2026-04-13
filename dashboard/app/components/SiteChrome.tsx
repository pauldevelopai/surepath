import Link from "next/link";

const WHATSAPP_NUMBER = "27792198649";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi Surepath, I'd like to check a property")}`;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-gray-200">
      <div className="max-w-6xl mx-auto px-5 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-[#E63946] flex items-center justify-center text-white font-black text-sm">S</div>
          <span className="font-bold text-lg text-[#0D1B2A]">Surepath</span>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-sm text-gray-700">
          <Link href="/#how" className="hover:text-[#E63946]">How it works</Link>
          <Link href="/#checks" className="hover:text-[#E63946]">What we check</Link>
          <Link href="/#tiktok" className="hover:text-[#E63946]">TikTok integration</Link>
          <Link href="/#pricing" className="hover:text-[#E63946]">Pricing</Link>
          <Link href="/#faq" className="hover:text-[#E63946]">FAQ</Link>
        </nav>
        <a
          href={WHATSAPP_LINK}
          className="bg-[#E63946] text-white text-sm font-semibold px-4 py-2 rounded-md hover:bg-red-700 transition"
          target="_blank" rel="noopener noreferrer"
        >
          Start on WhatsApp
        </a>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-[#0D1B2A] text-gray-400 py-12 mt-16">
      <div className="max-w-6xl mx-auto px-5 grid md:grid-cols-4 gap-8 text-sm">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-7 h-7 rounded-md bg-[#E63946] flex items-center justify-center text-white font-black text-xs">S</div>
            <span className="font-bold text-white">Surepath</span>
          </div>
          <p className="text-xs leading-relaxed">South African property due diligence on WhatsApp. Photos analysed, deeds checked, risks flagged.</p>
        </div>
        <div>
          <div className="font-semibold text-white mb-3">Product</div>
          <ul className="space-y-2 text-xs">
            <li><Link href="/#how" className="hover:text-white">How it works</Link></li>
            <li><Link href="/#checks" className="hover:text-white">What we check</Link></li>
            <li><Link href="/#pricing" className="hover:text-white">Pricing</Link></li>
            <li><Link href="/#faq" className="hover:text-white">FAQ</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-semibold text-white mb-3">Company</div>
          <ul className="space-y-2 text-xs">
            <li><Link href="/privacy" className="hover:text-white">Privacy Policy</Link></li>
            <li><Link href="/terms" className="hover:text-white">Terms of Service</Link></li>
            <li><Link href="/#tiktok" className="hover:text-white">TikTok integration</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-semibold text-white mb-3">Contact</div>
          <ul className="space-y-2 text-xs">
            <li><a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer" className="hover:text-white">WhatsApp +27 79 219 8649</a></li>
            <li>South Africa</li>
          </ul>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-5 mt-10 pt-6 border-t border-gray-800 text-xs flex flex-wrap justify-between gap-3">
        <span>© {new Date().getUTCFullYear()} Surepath. All rights reserved.</span>
        <span>surepath.co.za</span>
      </div>
    </footer>
  );
}
