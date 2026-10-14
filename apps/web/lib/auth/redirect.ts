import { NextResponse } from 'next/server';

/**
 * A redirect to a site-relative path, made absolute against the origin the
 * browser actually used (`browserOrigin`: an IP, a tailnet name, a proxy's
 * hostname), never against Next's own idea of the host. Self-hosted
 * `next start` reports `request.url` as `http://localhost:<port>/...`, so a
 * redirect built from it sends a browser at `127.0.0.1` to `localhost`, where
 * its cookie is not; and the middleware adapter insists on an absolute
 * `Location`, so a relative one is not an option there. `location` must start
 * with a single `/` (`safeNextPath` guarantees that for user-supplied values).
 */
export function redirectTo(location: string, status: 303 | 307, origin: string): NextResponse {
  if (!location.startsWith('/') || location.startsWith('//')) {
    throw new Error('redirectTo takes a site-relative path');
  }
  const response = NextResponse.redirect(new URL(location, origin), status);
  response.headers.set('cache-control', 'no-store');
  return response;
}
