import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";

/**
 * Starts the TikTok OAuth flow — redirects to TikTok's authorization page.
 * User must be logged into admin (withAuth) to initiate this.
 */
export const GET = withAuth(async () => {
  // eslint-disable-next-line no-eval
  const loadModule = (name: string) => eval('require')(require('path').resolve(process.cwd(), '..', name));
  const { getAuthorizeUrl } = loadModule('tiktok.js');

  try {
    const state = Math.random().toString(36).slice(2);
    const url = getAuthorizeUrl(state);
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
