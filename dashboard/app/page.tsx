import type { Metadata } from "next";
import { SiteHeader, SiteFooter } from "./components/SiteChrome";

export const metadata: Metadata = {
  title: "Surepath — Catch hidden property problems before you buy",
  description:
    "Surepath checks South African property listings for damp, structural defects, crime risk, deed history and infrastructure issues. Paste a Property24 or PrivateProperty link on WhatsApp and get a full risk report in minutes.",
  openGraph: {
    title: "Surepath — Property due diligence on WhatsApp",
    description:
      "Paste any Property24 or PrivateProperty link. Get a full risk report — defects, crime, deeds, infrastructure — in minutes.",
    url: "https://surepath.co.za",
    siteName: "Surepath",
    locale: "en_ZA",
    type: "website",
  },
};

const WHATSAPP_NUMBER = "27792198649";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi Surepath, I'd like to check a property")}`;
const REPORT_PRICE = "R169";

export default function HomePage() {
  return (
    <div className="bg-white text-gray-900">
      <SiteHeader />

      {/* ─── Hero ────────────────────────────────────────────────── */}
      <section className="bg-gradient-to-b from-[#0D1B2A] to-[#152844] text-white">
        <div className="max-w-6xl mx-auto px-5 py-20 md:py-28 grid md:grid-cols-2 gap-10 items-center">
          <div>
            <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-3">South African property due diligence</p>
            <h1 className="text-4xl md:text-5xl font-black leading-tight mb-5">
              Don&apos;t buy a house with <span className="text-[#E63946]">hidden problems.</span>
            </h1>
            <p className="text-lg text-gray-300 mb-7 leading-relaxed">
              Paste any Property24 or PrivateProperty link into WhatsApp. Surepath analyses the listing photos for defects, pulls deeds and crime data, and gives you a full risk report — before you put down a cent.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href={WHATSAPP_LINK}
                className="bg-[#E63946] text-white font-semibold px-6 py-3 rounded-md hover:bg-red-700 transition flex items-center gap-2"
                target="_blank" rel="noopener noreferrer"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.149-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                Start on WhatsApp
              </a>
              <a href="#how" className="border border-white/20 text-white font-semibold px-6 py-3 rounded-md hover:bg-white/10 transition">
                See how it works
              </a>
            </div>
            <p className="text-xs text-gray-400 mt-5">First check is free · Full report {REPORT_PRICE} · Delivered in minutes</p>
          </div>

          <div className="relative">
            <div className="bg-white rounded-2xl shadow-2xl p-5 max-w-sm mx-auto">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b">
                <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center text-white">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
                </div>
                <div>
                  <div className="font-bold text-sm text-gray-900">Surepath</div>
                  <div className="text-[10px] text-gray-500">online</div>
                </div>
              </div>
              <div className="space-y-2 text-sm text-gray-800">
                <div className="bg-gray-100 rounded-lg p-2.5 max-w-[80%]">Welcome to Surepath 👋 Paste a property link and I&apos;ll check it for you.</div>
                <div className="bg-[#DCF8C6] rounded-lg p-2.5 max-w-[80%] ml-auto">privateproperty.co.za/for-sale/...</div>
                <div className="bg-gray-100 rounded-lg p-2.5 max-w-[90%]">
                  <div className="font-semibold mb-1">3 bed · R2,450,000 · Linden, JHB</div>
                  <div className="text-xs text-gray-600">Found 2 risk flags in the photos. Possible roof damp + crack near patio doors.</div>
                </div>
                <div className="bg-gray-100 rounded-lg p-2.5 max-w-[80%] text-xs text-gray-600">
                  Reply *1* for full report ({REPORT_PRICE}) — crime stats, deeds, repair estimates, all flags.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── How it works ────────────────────────────────────────── */}
      <section id="how" className="py-20 bg-gray-50">
        <div className="max-w-6xl mx-auto px-5">
          <div className="text-center mb-14">
            <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-2">How it works</p>
            <h2 className="text-3xl md:text-4xl font-bold text-[#0D1B2A]">From listing link to full report in three steps</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { n: "1", t: "Paste the listing link", d: "Send any Property24 or PrivateProperty URL to our WhatsApp number. We pull the listing photos, address, price, and listing description automatically." },
              { n: "2", t: "We analyse and gather data", d: "Our AI inspects every photo for defects (damp, cracks, roof issues). In parallel we pull crime stats, municipal valuation, deeds history, fibre, schools, climate and load-shedding data for the area." },
              { n: "3", t: "Get your risk report", d: `Receive a structured WhatsApp message with all findings, evidence photos, repair cost estimates and source links. Every flag is traceable. ${REPORT_PRICE} per full report — first preview is free.` },
            ].map((s) => (
              <div key={s.n} className="bg-white rounded-xl p-7 border border-gray-200 shadow-sm">
                <div className="w-11 h-11 rounded-full bg-[#E63946] text-white flex items-center justify-center font-black mb-4">{s.n}</div>
                <h3 className="font-bold text-lg text-[#0D1B2A] mb-2">{s.t}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── What we check ───────────────────────────────────────── */}
      <section id="checks" className="py-20 bg-white">
        <div className="max-w-6xl mx-auto px-5">
          <div className="text-center mb-14">
            <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-2">What we check</p>
            <h2 className="text-3xl md:text-4xl font-bold text-[#0D1B2A]">Every report draws from 20+ live data sources</h2>
            <p className="text-gray-600 mt-3 max-w-2xl mx-auto">No agent shows you this. We do the homework so you can negotiate with facts, not feelings.</p>
          </div>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-5">
            {[
              { t: "Photo defect detection", d: "AI vision spots damp, cracks, roof problems, electrical hazards and signs of poor maintenance in listing photos." },
              { t: "Crime statistics", d: "Latest SAPS precinct data — robbery, burglary, vehicle theft trends for the actual suburb." },
              { t: "Deeds & ownership history", d: "Previous owners, sale prices, bond history and any flags on title — pulled from public deeds sources." },
              { t: "Municipal valuation", d: "Official municipal value, stand size, zoning and rates for six metros — useful for spotting overpriced listings." },
              { t: "Sold prices & price trends", d: "Recent comparable sales in the suburb plus 5-year price growth, so you know what fair value looks like." },
              { t: "Crime + security coverage", d: "Nearest SAPS station, CPF contacts, and which armed-response companies cover the suburb." },
              { t: "Schools nearby", d: "All schools within 3km with ratings — important for resale value as much as for buyers with kids." },
              { t: "Climate & damp risk", d: "5-year rainfall, humidity and wind data — exposes properties prone to damp or storm damage." },
              { t: "Load shedding & electricity", d: "Suburb load-shedding schedule and stage history, plus tariff estimates for monthly running costs." },
              { t: "Fibre coverage", d: "Which ISPs (Openserve, Vumatel, Frogfoot) actually have infrastructure at the address." },
              { t: "Solar viability", d: "Satellite-measured irradiance for the property — shows realistic solar payback before you spend on a system." },
              { t: "True cost of buying", d: "Transfer duty, bond costs, attorney fees and agent commission — the real number you pay, not just the asking price." },
            ].map((c) => (
              <div key={c.t} className="border border-gray-200 rounded-lg p-5 hover:border-[#E63946] hover:shadow-md transition">
                <div className="w-2 h-2 rounded-full bg-[#E63946] mb-3" />
                <h3 className="font-bold text-[#0D1B2A] mb-1.5">{c.t}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── TikTok integration (required for review) ────────────── */}
      <section id="tiktok" className="py-20 bg-[#0D1B2A] text-white">
        <div className="max-w-6xl mx-auto px-5">
          <div className="text-center mb-12">
            <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-2">For our creators</p>
            <h2 className="text-3xl md:text-4xl font-bold">TikTok publishing for property educators</h2>
            <p className="text-gray-300 mt-3 max-w-2xl mx-auto">
              Surepath produces short property-tip videos every day — defects to watch out for, cost-of-buying breakdowns, suburb spotlights. Verified property educators on our team can connect their TikTok account and publish those videos directly.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-10 items-center">
            <div className="bg-white/5 border border-white/10 rounded-xl p-7">
              <h3 className="text-xl font-bold mb-4">How the TikTok integration works</h3>
              <ol className="space-y-4 text-sm text-gray-300">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#E63946] text-white text-xs font-bold flex items-center justify-center mt-0.5">1</span>
                  <div>
                    <span className="font-semibold text-white">Login with TikTok.</span> A creator on our team clicks <em>Connect TikTok</em> in the Surepath admin. They&apos;re sent to TikTok&apos;s OAuth screen to grant access.
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#E63946] text-white text-xs font-bold flex items-center justify-center mt-0.5">2</span>
                  <div>
                    <span className="font-semibold text-white">Permissions requested.</span> We request <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">user.info.basic</code>, <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">user.info.profile</code>, <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">user.info.stats</code>, <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">video.list</code>, <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">video.upload</code> and <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">video.publish</code>. We use the profile fields to display the connected account, and the video scopes to upload Surepath-produced content as drafts or scheduled posts.
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#E63946] text-white text-xs font-bold flex items-center justify-center mt-0.5">3</span>
                  <div>
                    <span className="font-semibold text-white">Review and publish.</span> The creator picks one of our auto-generated property videos, edits the caption and hashtags, then either saves it to their TikTok drafts (Upload) or publishes it directly (Direct Post). We use Webhooks to track post status and update our dashboard.
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#E63946] text-white text-xs font-bold flex items-center justify-center mt-0.5">4</span>
                  <div>
                    <span className="font-semibold text-white">Stats and history.</span> The <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">video.list</code> and <code className="bg-black/40 px-1.5 py-0.5 rounded text-[11px]">user.info.stats</code> scopes let us show the creator how their Surepath posts performed (views, likes, follower growth) inside the same dashboard.
                  </div>
                </li>
              </ol>
            </div>

            <div>
              <h3 className="text-xl font-bold mb-4">What we publish</h3>
              <ul className="space-y-3 text-sm text-gray-300 leading-relaxed mb-6">
                <li className="flex gap-3"><span className="text-[#E63946]">▸</span> Short educational clips — &quot;5 things to check before buying in [suburb]&quot;.</li>
                <li className="flex gap-3"><span className="text-[#E63946]">▸</span> Defect spotlights — what damp, rising moisture or a structural crack actually looks like.</li>
                <li className="flex gap-3"><span className="text-[#E63946]">▸</span> Cost-of-buying breakdowns — transfer duty, bond costs, what the true price is.</li>
                <li className="flex gap-3"><span className="text-[#E63946]">▸</span> Suburb intelligence — crime trends, fibre availability, schools.</li>
              </ul>
              <p className="text-xs text-gray-400 leading-relaxed">
                All footage is either licensed stock (Pexels, Mixkit, Unsplash) or original Surepath material. We do not upload personal media or content unrelated to property education. Creators retain full control — we never post without their explicit approval inside the dashboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Pricing ─────────────────────────────────────────────── */}
      <section id="pricing" className="py-20 bg-gray-50">
        <div className="max-w-3xl mx-auto px-5 text-center">
          <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-2">Pricing</p>
          <h2 className="text-3xl md:text-4xl font-bold text-[#0D1B2A] mb-3">One report, one fixed price</h2>
          <p className="text-gray-600 mb-10">No subscription. No agent fees. No add-ons.</p>

          <div className="grid md:grid-cols-2 gap-5">
            <div className="bg-white border border-gray-200 rounded-xl p-7 text-left">
              <div className="text-sm text-gray-500 mb-1">First preview</div>
              <div className="text-3xl font-black text-[#0D1B2A] mb-3">Free</div>
              <ul className="text-sm text-gray-700 space-y-2">
                <li>✓ Listing summary & price check</li>
                <li>✓ Top risk flags from listing photos</li>
                <li>✓ Quick suburb context</li>
              </ul>
            </div>
            <div className="bg-[#0D1B2A] text-white rounded-xl p-7 text-left border-2 border-[#E63946] relative">
              <div className="absolute -top-3 right-5 bg-[#E63946] text-white text-[10px] font-bold px-2 py-1 rounded uppercase">Most popular</div>
              <div className="text-sm text-gray-300 mb-1">Full report</div>
              <div className="text-3xl font-black mb-3">{REPORT_PRICE}<span className="text-base text-gray-400 font-normal"> · once-off</span></div>
              <ul className="text-sm text-gray-200 space-y-2">
                <li>✓ Every defect found in the photos with source images</li>
                <li>✓ Crime, deeds, valuation, sold prices for the area</li>
                <li>✓ Climate, load-shedding, fibre, schools, solar viability</li>
                <li>✓ True cost of buying — transfer duty + bond + fees</li>
                <li>✓ Delivered to WhatsApp in minutes</li>
              </ul>
            </div>
          </div>

          <a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer"
             className="inline-block mt-10 bg-[#E63946] text-white font-semibold px-7 py-3 rounded-md hover:bg-red-700 transition">
            Check a property now →
          </a>
        </div>
      </section>

      {/* ─── FAQ ─────────────────────────────────────────────────── */}
      <section id="faq" className="py-20 bg-white">
        <div className="max-w-3xl mx-auto px-5">
          <div className="text-center mb-12">
            <p className="text-[#E63946] font-semibold text-sm uppercase tracking-wider mb-2">FAQ</p>
            <h2 className="text-3xl md:text-4xl font-bold text-[#0D1B2A]">Questions buyers ask us</h2>
          </div>
          <div className="space-y-4">
            {[
              { q: "Do I have to install anything?", a: "No. Surepath runs entirely on WhatsApp. Just message us the listing link." },
              { q: "Which listing sites do you support?", a: "Property24 and PrivateProperty for now — those cover the vast majority of South African residential listings. Other sources are coming." },
              { q: "How long does the report take?", a: "Preview comes back in under a minute. The full report is typically ready within five to ten minutes once you pay." },
              { q: "How do you analyse the photos?", a: "We use Anthropic Claude vision models trained to spot common South African defects — rising damp, ceiling water damage, plaster cracks, rusted roof sheets, electrical and plumbing red flags." },
              { q: "Where does your crime and deeds data come from?", a: "Crime data comes from SAPS precinct statistics. Deeds and ownership history come from official deeds-office sources. Municipal valuation rolls come direct from each metro." },
              { q: "Is there a monthly fee?", a: "No. You pay per report, only when you want a full one. No subscriptions." },
              { q: "What happens to my information?", a: "We store the property link and your WhatsApp number to deliver the report. We do not sell your data. Full details are in our Privacy Policy." },
            ].map((f, i) => (
              <details key={i} className="border border-gray-200 rounded-lg p-4 group">
                <summary className="font-semibold text-[#0D1B2A] cursor-pointer flex justify-between items-center">
                  {f.q}
                  <span className="text-[#E63946] text-xl group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="text-sm text-gray-700 mt-3 leading-relaxed">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────────────────────── */}
      <section className="bg-[#E63946] text-white py-16">
        <div className="max-w-3xl mx-auto px-5 text-center">
          <h2 className="text-3xl md:text-4xl font-black mb-4">Check a property in the next two minutes</h2>
          <p className="text-white/90 mb-7">Free preview. Full report only if you want it.</p>
          <a
            href={WHATSAPP_LINK}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-white text-[#E63946] font-bold px-7 py-3 rounded-md hover:bg-gray-100 transition"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/></svg>
            Open WhatsApp
          </a>
          <p className="text-xs text-white/70 mt-4">+27 79 219 8649</p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
