import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: {
    default: "Surepath — South African property due diligence on WhatsApp",
    template: "%s | Surepath",
  },
  description:
    "Paste any Property24 or PrivateProperty link on WhatsApp. Surepath checks listing photos for damp, cracks and roof issues, pulls crime stats, deeds, valuation and infrastructure data, and gives you a full risk report in minutes.",
  metadataBase: new URL("https://surepath.co.za"),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0D1B2A",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen">{children}</body>
    </html>
  );
}
