import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, signToken, checkRateLimit, recordLoginAttempt } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

  // Rate limit check
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter || 900) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { user, pass } = body;
  if (!user || !pass || typeof user !== "string" || typeof pass !== "string") {
    return NextResponse.json({ error: "Invalid" }, { status: 401 });
  }

  if (!checkCredentials(user, pass)) {
    recordLoginAttempt(ip, false);
    return NextResponse.json({ error: "Invalid" }, { status: 401 });
  }

  recordLoginAttempt(ip, true);
  const token = signToken(user);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 43200, // 12 hours
    path: "/",
  });
  return res;
}
