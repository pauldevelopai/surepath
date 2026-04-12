export const metadata = {
  title: "Privacy Policy | Surepath",
};

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-6">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: 12 April 2026</p>

      <section className="space-y-4 text-sm leading-relaxed">
        <h2 className="text-xl font-bold mt-6">1. Who we are</h2>
        <p>
          Surepath is a South African property-intelligence service. Our WhatsApp contact is +27 79 219 8649 and our website is surepath.co.za.
        </p>

        <h2 className="text-xl font-bold mt-6">2. What information we collect</h2>
        <p>
          When you request a property report we collect the property listing URL you share with us, your WhatsApp number (for delivery of the report), and your name and email if you choose to provide them during payment.
        </p>
        <p>
          When our app connects to third-party platforms like TikTok, we receive an access token from that platform. The access token allows us to post content on your behalf. We store the token securely and do not use it for any purpose outside what you have authorised.
        </p>

        <h2 className="text-xl font-bold mt-6">3. How we use your information</h2>
        <p>
          We use your information to generate the property report you requested, to deliver it to you, to process payments, and to publish content that you have authorised us to publish.
        </p>

        <h2 className="text-xl font-bold mt-6">4. Who we share information with</h2>
        <p>
          We share the minimum information necessary with our payment providers (PayFast, Yoco), hosting providers (AWS, Cloudflare), and AI services used to analyse property images (Anthropic). We do not sell your personal information.
        </p>

        <h2 className="text-xl font-bold mt-6">5. Content generated on your behalf</h2>
        <p>
          Social media content published through our system (including TikTok posts) is created using publicly-available property information, your authorised property findings, and stock footage licensed for commercial use. We do not upload personal or private media without your explicit consent.
        </p>

        <h2 className="text-xl font-bold mt-6">6. Your rights</h2>
        <p>
          You may request a copy of the information we hold about you, or request that we delete it. You may revoke third-party access (e.g. TikTok authorisation) at any time by disconnecting the account.
        </p>

        <h2 className="text-xl font-bold mt-6">7. Data retention</h2>
        <p>
          We retain property report data for as long as it is useful to you. Access tokens are refreshed automatically and can be revoked at any time.
        </p>

        <h2 className="text-xl font-bold mt-6">8. Contact</h2>
        <p>
          For privacy questions, WhatsApp +27 79 219 8649.
        </p>
      </section>
    </div>
  );
}
