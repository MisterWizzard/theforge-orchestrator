/**
 * The middleware's decision, as a pure function of the request's path, method
 * and the two facts the middleware establishes (is login configured, does the
 * request carry a valid session), so the whole policy is unit-tested without
 * a server (ADR-027).
 *
 * Public without a session: `/login` and everything under it (the page and
 * the form's POST target), `/logout`, `/forge-api/health`, and Next's own
 * assets. Everything else needs a session: a `/forge-api/*` call without one
 * gets 401 JSON, a page without one is sent to `/login?next=...`. When login
 * is not configured nothing but the public set answers at all: 503, as a page
 * or as JSON, never the app.
 */
export type GateInput = {
  pathname: string;
  search: string;
  method: string;
  configured: boolean;
  authenticated: boolean;
};

export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'redirect'; location: string }
  | { kind: 'unauthorized' }
  | { kind: 'unconfigured'; api: boolean };

export const LOGIN_PATH = '/login';
export const LOGOUT_PATH = '/logout';
export const API_PREFIX = '/forge-api/';
export const HEALTH_PATH = '/forge-api/health';
const MAX_NEXT_LENGTH = 2048;
const DELETE_CODE = 0x7f;
const FIRST_PRINTABLE_CODE = 0x20;

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX);
}

export function isNextAsset(pathname: string): boolean {
  return pathname.startsWith('/_next/') || pathname === '/favicon.ico';
}

export function isPublicPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    pathname.startsWith(`${LOGIN_PATH}/`) ||
    pathname === LOGOUT_PATH ||
    pathname === HEALTH_PATH ||
    isNextAsset(pathname)
  );
}

/** A C0 control, DEL, or any whitespace (`trim` knows every Unicode space and line terminator). */
function hasControlOrWhitespace(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE || code === DELETE_CODE || character.trim() === '') {
      return true;
    }
  }
  return false;
}

/**
 * A `next` value the login flow may send the operator to afterwards: a path
 * on this site, or `/` for anything else. Refuses protocol-relative and
 * backslash forms, control characters and whitespace, and the login pages
 * themselves.
 */
export function safeNextPath(candidate: string | null | undefined): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/';
  if (candidate.length > MAX_NEXT_LENGTH) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (hasControlOrWhitespace(candidate)) return '/';
  const pathname = candidate.split(/[?#]/, 1)[0] ?? '/';
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return '/';
  if (pathname === LOGOUT_PATH) return '/';
  return candidate;
}

/** Where an unauthenticated page request is sent: `/login`, remembering anything but the home page. */
export function loginLocation(pathname: string, search: string): string {
  const next = safeNextPath(`${pathname}${search}`);
  return next === '/' ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

export function gate(input: GateInput): GateDecision {
  const { pathname, search, method, configured, authenticated } = input;
  if (!configured) {
    return isPublicPath(pathname)
      ? { kind: 'allow' }
      : { kind: 'unconfigured', api: isApiPath(pathname) };
  }
  if (isPublicPath(pathname)) {
    // A signed-in operator asking for the form goes home instead.
    if (authenticated && pathname === LOGIN_PATH && (method === 'GET' || method === 'HEAD')) {
      return { kind: 'redirect', location: '/' };
    }
    return { kind: 'allow' };
  }
  if (authenticated) return { kind: 'allow' };
  if (isApiPath(pathname)) return { kind: 'unauthorized' };
  return { kind: 'redirect', location: loginLocation(pathname, search) };
}
