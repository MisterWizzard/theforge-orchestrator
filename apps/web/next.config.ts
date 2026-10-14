import type { NextConfig } from 'next';
const config: NextConfig = {
  reactStrictMode: true,
  // The middleware adapter otherwise rewrites a redirect to `127.0.0.1` as
  // `localhost` (its URL normalisation folds every loopback name together),
  // which sends the browser to a host where its session cookie is not.
  // Redirects are built on the Host the browser addressed (ADR-027).
  skipMiddlewareUrlNormalize: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // Under `no-referrer` Chromium sends `Origin: null` on a form
        // navigation, which the login route's same-origin rule would refuse
        // (a fetch() keeps its origin, so the proxy is unaffected). The login
        // page has no outbound links, so `same-origin` leaks nothing. Later
        // entries override earlier ones for the same key.
        source: '/login',
        headers: [{ key: 'Referrer-Policy', value: 'same-origin' }],
      },
    ];
  },
};
export default config;
