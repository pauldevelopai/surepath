import { NextRequest, NextResponse } from "next/server";

/**
 * TikTok OAuth callback — receives the code, exchanges it for a token, saves the account.
 * NOTE: This route is intentionally NOT behind withAuth because TikTok redirects the
 * browser here without our session cookies. If the OAuth exchange succeeds, we redirect
 * back to /admin/content with a success message.
 */
export async function GET(req: NextRequest) {
  // eslint-disable-next-line no-eval
  const loadModule = (name: string) => eval('require')(require('path').resolve(process.cwd(), '..', name));
  const { exchangeCodeForToken, saveAccount } = loadModule('tiktok.js');

  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/admin/content?tiktok_error=${encodeURIComponent(error)}`, process.env.PUBLIC_BASE_URL || 'https://surepath.co.za'));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/admin/content?tiktok_error=missing_code', process.env.PUBLIC_BASE_URL || 'https://surepath.co.za'));
  }

  try {
    const tokenResponse = await exchangeCodeForToken(code);
    await saveAccount(tokenResponse);
    return NextResponse.redirect(new URL('/admin/content?tiktok_connected=1', process.env.PUBLIC_BASE_URL || 'https://surepath.co.za'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.redirect(new URL(`/admin/content?tiktok_error=${encodeURIComponent(message)}`, process.env.PUBLIC_BASE_URL || 'https://surepath.co.za'));
  }
}
