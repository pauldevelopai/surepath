import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, signToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { user, pass } = await req.json();
  if (!checkCredentials(user, pass)) {
    return NextResponse.json({ error: "Invalid" }, { status: 401 });
  }
  const token = signToken(user);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("token", token, {
    httpOnly: true,
    secure: process.env.FORCE_INSECURE_COOKIES !== "true" && process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 86400,
    path: "/",
  });
  return res;
}
