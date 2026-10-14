import { NextResponse, type NextRequest } from 'next/server';
import { readOperatorAuth } from './lib/auth/config';
import { gate } from './lib/auth/gate';
import { redirectTo } from './lib/auth/redirect';
import { browserOrigin } from './lib/auth/request';
import { SESSION_COOKIE, sessionKeyFor, verifySessionToken } from './lib/auth/session';

/**
 * Operator login for every page and every `/forge-api/*` call (ADR-027).
 *
 * Runs before any route: a request with no valid `forge_session` cookie is
 * sent to `/login` (pages) or answered 401 (API); with login not configured
 * everything but `/login`, `/logout` and `/forge-api/health` is a 503. The
 * policy itself is `lib/auth/gate.ts`; this file only reads the cookie and
 * turns a decision into a response. The existing same-origin JSON check on
 * mutations stays in the proxy route behind this.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const auth = readOperatorAuth(process.env);
  const { pathname, search } = request.nextUrl;
  let authenticated = false;
  if (auth.configured) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      const key = await sessionKeyFor(auth.keyMaterial);
      authenticated = (await verifySessionToken(key, token)) !== null;
    }
  }
  const decision = gate({
    pathname,
    search,
    method: request.method,
    configured: auth.configured,
    authenticated,
  });
  switch (decision.kind) {
    case 'allow':
      return NextResponse.next();
    case 'redirect':
      return redirectTo(
        decision.location,
        request.method === 'GET' || request.method === 'HEAD' ? 307 : 303,
        browserOrigin(new URL(request.url), request.headers, process.env),
      );
    case 'unauthorized':
      return json({ error: 'operator_login_required' }, 401);
    case 'unconfigured': {
      const reason = auth.configured ? 'operator login is not configured' : auth.reason;
      return decision.api
        ? json({ error: 'operator_login_not_configured', detail: reason }, 503)
        : html(notConfiguredPage(reason), 503);
    }
  }
}

function json(body: Record<string, string>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notConfiguredPage(reason: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator login not configured</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#f3f2eb;color:#181915;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
main{width:100%;max-width:440px;background:#fcfbf6;border:1px solid #deddd4;border-radius:16px;padding:28px;box-sizing:border-box}
h1{font:500 24px/1.15 Georgia,serif;letter-spacing:-.03em;margin:0 0 12px}
p{margin:0 0 10px;font-size:14px;line-height:1.55;color:#4b4d45}
code{background:#eceae0;padding:2px 5px;border-radius:5px;font-size:12px}
</style>
</head>
<body>
<main role="alert">
<h1>Operator login is not configured</h1>
<p>${escapeHtml(reason)}. The control centre answers nothing until it is.</p>
<p>Set <code>FORGE_WEB_OPERATOR_PASSWORD</code> (16 or more characters) in <code>.env</code> and restart the web app. <code>FORGE_WEB_SESSION_SECRET</code> is optional. See <code>docs/OPERATIONS.md</code>, "Operator login".</p>
</main>
</body>
</html>
`;
}
