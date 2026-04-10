export default function ReportPage() {
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
        <h1 style={{ fontSize: "28px", fontWeight: 700, color: "#0D1B2A", marginBottom: "12px" }}>
          Surepath Property Report
        </h1>
        <p style={{ fontSize: "16px", color: "#555", lineHeight: 1.6, marginBottom: "24px" }}>
          Payment was cancelled or not completed. No charge has been made.
        </p>
        <p style={{ fontSize: "14px", color: "#555", lineHeight: 1.6 }}>
          To try again, go back to WhatsApp and reply <strong>1</strong> to get a new payment link.
        </p>
      </div>
      <p style={{ marginTop: "24px", fontSize: "12px", color: "#999" }}>
        surepath.co.za
      </p>
    </div>
  );
}
