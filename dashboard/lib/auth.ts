import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const JWT_SECRET = process.env.JWT_SECRET || "surepath-dev-secret";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "surepath2025";

export function signToken(user: string): string {
  return jwt.sign({ user }, JWT_SECRET, { expiresIn: "24h" });
}

export function verifyToken(token: string): { user: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { user: string };
  } catch {
    return null;
  }
}

export function checkCredentials(user: string, pass: string): boolean {
  return user === ADMIN_USER && pass === ADMIN_PASS;
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
