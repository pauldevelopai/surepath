import { NextRequest, NextResponse } from "next/server";

// ─── Security middleware ──────────────────────────────────────────────
// Adds security headers to all responses and implements request-level protections.

// Simple in-memory rate limiter for API endpoints
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const API_RATE_LIMIT = 60; // requests per minute per IP
const API_RATE_WINDOW = 60 * 1000; // 1 minute

function checkApiRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);
  if (!record || now > record.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + API_RATE_WINDOW });
    return true;
  }
  record.count++;
  return record.count <= API_RATE_LIMIT;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of requestCounts) {
    if (now > record.resetAt) requestCounts.delete(ip);
  }
}, 5 * 60 * 1000);

export function middleware(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

  // Rate limit API endpoints
  if (req.nextUrl.pathname.startsWith("/api/")) {
    if (!checkApiRateLimit(ip)) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please slow down." },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }
  }

  // Block common bot/scanner user agents
  const ua = req.headers.get("user-agent") || "";
  const blockedBots = /sqlmap|nikto|nmap|masscan|dirsearch|gobuster|wpscan|burp|hydra|metasploit/i;
  if (blockedBots.test(ua)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // HSTS — only in production with HTTPS
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Content Security Policy
  response.headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Next.js requires these
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; "));

  // Remove server identification
  response.headers.delete("X-Powered-By");

  return response;
}

export const config = {
  matcher: [
    // Match all routes except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
