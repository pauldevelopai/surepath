export const metadata = {
  title: "Terms of Service | Surepath",
};

export default function TermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-6">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: 12 April 2026</p>

      <section className="space-y-4 text-sm leading-relaxed">
        <h2 className="text-xl font-bold mt-6">1. About Surepath</h2>
        <p>
          Surepath is a South African property-intelligence service that helps buyers assess the risk profile of a residential property before purchase. We provide defect analysis, crime data, compliance checks, and a written report summarising the risks we find.
        </p>

        <h2 className="text-xl font-bold mt-6">2. Use of the Service</h2>
        <p>
          By using Surepath, you agree to use the service lawfully and in good faith. You must not misrepresent property details when requesting a report, reverse-engineer our findings to harass sellers, or use the data we provide for any illegal purpose.
        </p>

        <h2 className="text-xl font-bold mt-6">3. Information We Provide</h2>
        <p>
          Our reports are based on publicly-available information, photos supplied in listings, and analysis by AI and human reviewers. We flag risks we believe a reasonable buyer should consider, but we do not replace a professional property inspection, a conveyancer, or legal advice. You use our information at your own discretion.
        </p>

        <h2 className="text-xl font-bold mt-6">4. Payments</h2>
        <p>
          Surepath reports are paid for through authorised payment providers (PayFast, Yoco). All prices are shown in South African rand and include applicable VAT where relevant.
        </p>

        <h2 className="text-xl font-bold mt-6">5. Social Media Content</h2>
        <p>
          Surepath produces short-form video content for social platforms such as TikTok and Instagram. These videos are educational and opinion-based. We do not claim to show every risk a property may have; we highlight the ones we can see from the information available to us.
        </p>

        <h2 className="text-xl font-bold mt-6">6. Limitation of Liability</h2>
        <p>
          Surepath is provided &ldquo;as is&rdquo;. We are not liable for losses or decisions a buyer or seller makes based on the information we provide. Always obtain a qualified, in-person property inspection before signing an offer to purchase.
        </p>

        <h2 className="text-xl font-bold mt-6">7. Changes to these Terms</h2>
        <p>
          We may update these terms from time to time. We will post the updated date at the top of this page.
        </p>

        <h2 className="text-xl font-bold mt-6">8. Contact</h2>
        <p>
          WhatsApp: +27 79 219 8649<br />
          Website: <a className="text-blue-600 underline" href="https://surepath.co.za">surepath.co.za</a>
        </p>
      </section>
    </div>
  );
}
