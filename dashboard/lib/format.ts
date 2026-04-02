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
  INSPECT_FIRST: "text-orange-500",
  WALK_AWAY: "text-red-600",
};

export const statusColor: Record<string, string> = {
  paid: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  failed: "bg-red-100 text-red-800",
  complete: "bg-green-100 text-green-800",
  processing: "bg-blue-100 text-blue-800",
};
