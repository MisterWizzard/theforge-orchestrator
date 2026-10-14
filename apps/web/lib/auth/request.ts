/**
 * What the login and logout routes read off a request. Plain `URL` and
 * `Headers` in, so the tests need no Next request object.
 */
const MAX_SOURCE_LENGTH = 64;

/**
 * The key the failure throttle counts under: the first `x-forwarded-for`
 * hop when a proxy (Tailscale Serve) sets it, else `x-real-ip`, else
 * `direct`. Treated as an opaque label, never parsed as an address.
 */
export function clientSource(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const source = forwarded || headers.get('x-real-ip')?.trim() || 'direct';
  return source.slice(0, MAX_SOURCE_LENGTH);
}

/**
 * Whether the session cookie should carry `Secure`: the request itself is
 * HTTPS, a proxy says the client side is, or the configured web origin is.
 * Plain HTTP over Tailscale stays a working, non-Secure cookie.
 */
export function servedOverHttps(
  url: URL,
  headers: Headers,
  env: Record<string, string | undefined>,
): boolean {
  if (url.protocol === 'https:') return true;
  if (headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase() === 'https')
    return true;
  return (env.FORGE_WEB_ORIGIN ?? '').toLowerCase().startsWith('https:');
}

// A host[:port] as a browser or proxy would send it; anything else is ignored
// rather than built into a URL.
const HOST_SHAPE = /^[A-Za-z0-9.\-_[\]:]{1,253}$/;

/**
 * The origin the browser actually addressed, for building redirects and for
 * the same-origin rule: `x-forwarded-host` (a proxy such as Tailscale Serve),
 * else `Host`, with the scheme from `servedOverHttps`. Self-hosted
 * `next start` reports `request.url` with `localhost` whatever the client
 * typed, so the URL's own origin is only the last resort.
 */
export function browserOrigin(
  url: URL,
  headers: Headers,
  env: Record<string, string | undefined>,
): string {
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwarded || headers.get('host')?.trim();
  if (!host || !HOST_SHAPE.test(host)) return env.FORGE_WEB_ORIGIN || url.origin;
  return `${servedOverHttps(url, headers, env) ? 'https' : 'http'}://${host}`;
}

/**
 * The same rule the `/forge-api` proxy applies to mutations: the browser must
 * say the form came from this site. Non-browser clients do not send these
 * headers and are refused, which is intended; a forged wrong-password storm
 * from another site would otherwise lock the operator's own address out.
 * "This site" is `FORGE_WEB_ORIGIN` when set, else the origin the browser
 * addressed.
 */
export function sameOriginForm(
  url: URL,
  headers: Headers,
  env: Record<string, string | undefined>,
): boolean {
  const expectedOrigin = env.FORGE_WEB_ORIGIN || browserOrigin(url, headers, env);
  return (
    headers.get('origin') === expectedOrigin && headers.get('sec-fetch-site') === 'same-origin'
  );
}
