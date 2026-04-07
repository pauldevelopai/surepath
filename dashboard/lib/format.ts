export function formatZAR(amount: number | null | undefined): string {
  if (amount == null) return "N/A";
  return "R" + Number(amount).toLocaleString("en-ZA");
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "N/A";
  return new Date(d).toLocaleDateString("en-ZA", {
    year: "numeric", month: "short", day: "numeric",
  });
}

export function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return "N/A";
  return new Date(d).toLocaleString("en-ZA", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export const severityColor: Record<string, string> = {
  CRITICAL: "bg-red-600 text-white",
  HIGH: "bg-orange-500 text-white",
  MEDIUM: "bg-yellow-400 text-black",
  LOW: "bg-green-500 text-white",
  NEGLIGIBLE: "bg-gray-400 text-white",
  COSMETIC: "bg-gray-300 text-black",
};

export const decisionColor: Record<string, string> = {
  BUY: "text-green-600",
  NEGOTIATE: "text-yellow-600",
  WALK_AWAY: "text-red-600",
};

// Clean up SCREAMING_CASE codes in vision text for display
const CODE_MAP: Record<string, string> = {
  ACTIVE_LEAK: "active leak", MOLD_BLOOM: "mold growth", HISTORIC_STAIN: "old dry stain",
  WATER_STAIN: "water stain", ACTIVE_MOISTURE: "active moisture", EFFLORESCENCE: "efflorescence (salt deposits)",
  MOLD_GROWTH_RISK: "mold risk", SAG: "sagging", NOT_DETECTABLE: "not detectable",
  CONFIRMED_VISIBLE: "confirmed visible",
  WALK_AWAY: "Walk Away", NEGOTIATE: "Negotiate", BUY: "Buy",
};

export function humanize(text: string): string {
  if (!text) return text;
  return text.replace(/\b[A-Z][A-Z_]{2,}\b/g, match => CODE_MAP[match] || match.toLowerCase().replace(/_/g, " "));
}

export const statusColor: Record<string, string> = {
  paid: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  complete: "bg-green-100 text-green-800",
  processing: "bg-blue-100 text-blue-800",
};
