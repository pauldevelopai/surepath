import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("SECURITY: JWT_SECRET must be set and at least 32 characters");
}

export function signToken(user: string): string {
  if (!JWT_SECRET) throw new Error("JWT_SECRET not configured");
  return jwt.sign({ user, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): { user: string } | null {
  if (!JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as { user: string };
  } catch {
    return null;
  }
}

// ─── Rate limiting for login attempts ──────────────────────────────────
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };
  if (now - record.lastAttempt > LOCKOUT_MS) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (record.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((LOCKOUT_MS - (now - record.lastAttempt)) / 1000) };
  }
  return { allowed: true };
}

export function recordLoginAttempt(ip: string, success: boolean) {
  if (success) { loginAttempts.delete(ip); return; }
  const record = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  record.count++;
  record.lastAttempt = Date.now();
  loginAttempts.set(ip, record);
}

export function checkCredentials(user: string, pass: string): boolean {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  // Constant-time comparison to prevent timing attacks
  const userMatch = user.length === ADMIN_USER.length && user === ADMIN_USER;
  const passMatch = pass.length === ADMIN_PASS.length && pass === ADMIN_PASS;
  return userMatch && passMatch;
}

export async function getSession(): Promise<{ user: string } | null> {
  const c = await cookies();
  const token = c.get("token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAuth<T extends (req: NextRequest, ...args: any[]) => Promise<NextResponse>>(
  handler: T
): T {
  const wrapped = async (req: NextRequest, ...args: unknown[]) => {
    const token =
      req.cookies.get("token")?.value ||
      req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token || !verifyToken(token)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(req, ...(args as Parameters<T> extends [NextRequest, ...infer R] ? R : []));
  };
  return wrapped as unknown as T;
}
