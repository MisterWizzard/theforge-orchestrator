import { NextResponse, type NextRequest } from 'next/server';
import { readOperatorAuth } from '../../../lib/auth/config';
import { LOGIN_PATH, safeNextPath } from '../../../lib/auth/gate';
import { passwordMatches } from '../../../lib/auth/password';
import { redirectTo } from '../../../lib/auth/redirect';
import {
  browserOrigin,
  clientSource,
  sameOriginForm,
  servedOverHttps,
} from '../../../lib/auth/request';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSessionToken,
  sessionKeyFor,
} from '../../../lib/auth/session';
import { FAILURE_DELAY_MS, LoginThrottle } from '../../../lib/auth/throttle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /login/session`: the login form's target (ADR-027). One field,
 * `password`, plus an optional `next` path. A correct password sets the
 * `forge_session` cookie and sends the operator on; anything else goes back
 * to `/login` with an error code the page turns into a sentence, after the
 * throttle has counted it and a short delay has passed. No username, no
 * JSON body, no hint about which part was wrong.
 */
const throttle = new LoginThrottle();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = readOperatorAuth(process.env);
  const url = new URL(request.url);
  const origin = browserOrigin(url, request.headers, process.env);
  const back = (error: string, next: string) => {
    const query = new URLSearchParams({ error });
    if (next !== '/') query.set('next', next);
    return redirectTo(`${LOGIN_PATH}?${query.toString()}`, 303, origin);
  };
  if (!auth.configured) return back('unconfigured', '/');
  if (!sameOriginForm(url, request.headers, process.env)) {
    return NextResponse.json({ error: 'same_origin_form_required' }, { status: 403 });
  }
  const form = await request.formData().catch(() => null);
  const submitted = form?.get('password') ?? null;
  const nextField = form?.get('next');
  const next = safeNextPath(typeof nextField === 'string' ? nextField : null);
  const source = clientSource(request.headers);
  const now = Date.now();
  if (throttle.lockedFor(source, now) > 0) return back('locked', next);
  if (!passwordMatches(submitted, auth.password)) {
    const outcome = throttle.recordFailure(source, now);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return back(outcome.lockedFor > 0 ? 'locked' : 'invalid', next);
  }
  throttle.reset(source);
  const { token } = await issueSessionToken(await sessionKeyFor(auth.keyMaterial), now);
  const response = redirectTo(next, 303, origin);
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    secure: servedOverHttps(url, request.headers, process.env),
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  return response;
}
