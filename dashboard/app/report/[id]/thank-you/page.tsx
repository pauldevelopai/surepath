export default function ThankYouPage() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      background: "#F8F9FA",
      padding: "20px",
      textAlign: "center",
    }}>
      <div style={{
        background: "#fff",
        borderRadius: "16px",
        padding: "48px 36px",
        maxWidth: "440px",
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
      }}>
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#10003;</div>
        <h1 style={{ fontSize: "28px", fontWeight: 700, color: "#0D1B2A", marginBottom: "12px" }}>
          Payment Received
        </h1>
        <p style={{ fontSize: "16px", color: "#555", lineHeight: 1.6, marginBottom: "24px" }}>
          Thank you! Your Surepath property report is being generated now.
          It takes a few minutes — we&apos;ll send it to you on WhatsApp as soon as it&apos;s ready.
        </p>
        <div style={{
          background: "#F0F7FF",
          borderRadius: "8px",
          padding: "16px",
          fontSize: "14px",
          color: "#333",
        }}>
          You can close this page and return to WhatsApp.
        </div>
      </div>
      <p style={{ marginTop: "24px", fontSize: "12px", color: "#999" }}>
        surepath.co.za
      </p>
    </div>
  );
}
