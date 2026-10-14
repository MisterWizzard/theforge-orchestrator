import type { NextRequest, NextResponse } from 'next/server';
import { LOGIN_PATH } from '../../lib/auth/gate';
import { redirectTo } from '../../lib/auth/redirect';
import { browserOrigin, servedOverHttps } from '../../lib/auth/request';
import { SESSION_COOKIE } from '../../lib/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `/logout`: clears the session cookie and lands on `/login` (ADR-027). GET as
 * well as POST so the layout's plain link and a typed URL both work; the only
 * thing a cross-site request could achieve here is signing the operator out.
 * The token is not tracked server-side, so clearing the cookie is the whole
 * of logging out; the token itself lapses 12 h after it was issued.
 */
function clear(request: NextRequest): NextResponse {
  const url = new URL(request.url);
  const response = redirectTo(LOGIN_PATH, 303, browserOrigin(url, request.headers, process.env));
  response.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'strict',
    secure: servedOverHttps(url, request.headers, process.env),
    path: '/',
    maxAge: 0,
  });
  return response;
}

export { clear as GET, clear as POST };
