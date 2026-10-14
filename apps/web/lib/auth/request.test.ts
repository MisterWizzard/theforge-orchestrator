import { describe, expect, it } from 'vitest';
import { browserOrigin, clientSource, sameOriginForm, servedOverHttps } from './request';

const http = new URL('http://127.0.0.1:3000/login/session');
const https = new URL('https://forge.example.ts.net/login/session');

describe('clientSource', () => {
  it('prefers the first forwarded hop, then x-real-ip, then a fixed label', () => {
    expect(clientSource(new Headers({ 'x-forwarded-for': '100.64.0.7, 10.0.0.1' }))).toBe(
      '100.64.0.7',
    );
    expect(clientSource(new Headers({ 'x-real-ip': ' 100.64.0.8 ' }))).toBe('100.64.0.8');
    expect(clientSource(new Headers())).toBe('direct');
    expect(clientSource(new Headers({ 'x-forwarded-for': '' }))).toBe('direct');
  });

  it('caps the label so a hostile header cannot grow the throttle map', () => {
    expect(clientSource(new Headers({ 'x-forwarded-for': 'a'.repeat(500) }))).toHaveLength(64);
  });
});

describe('servedOverHttps', () => {
  it('is true for an https request, a proxy that says https, or an https web origin', () => {
    expect(servedOverHttps(https, new Headers(), {})).toBe(true);
    expect(servedOverHttps(http, new Headers({ 'x-forwarded-proto': 'https' }), {})).toBe(true);
    expect(servedOverHttps(http, new Headers({ 'x-forwarded-proto': 'HTTPS, http' }), {})).toBe(
      true,
    );
    expect(
      servedOverHttps(http, new Headers(), { FORGE_WEB_ORIGIN: 'https://forge.example.ts.net' }),
    ).toBe(true);
  });

  it('is false for plain http, so the cookie still works over Tailscale without TLS', () => {
    expect(servedOverHttps(http, new Headers(), {})).toBe(false);
    expect(servedOverHttps(http, new Headers({ 'x-forwarded-proto': 'http' }), {})).toBe(false);
    expect(
      servedOverHttps(http, new Headers(), { FORGE_WEB_ORIGIN: 'http://127.0.0.1:3000' }),
    ).toBe(false);
  });
});

describe('browserOrigin', () => {
  // `next start` reports request.url as localhost whatever the client typed.
  const reported = new URL('http://localhost:3000/settings');

  it('is the Host the browser addressed, with the scheme it used', () => {
    expect(browserOrigin(reported, new Headers({ host: '127.0.0.1:3000' }), {})).toBe(
      'http://127.0.0.1:3000',
    );
    expect(
      browserOrigin(
        reported,
        new Headers({ host: 'forge.example.ts.net', 'x-forwarded-proto': 'https' }),
        {},
      ),
    ).toBe('https://forge.example.ts.net');
    expect(
      browserOrigin(
        reported,
        new Headers({ host: '127.0.0.1:3000', 'x-forwarded-host': 'forge.example.ts.net, inner' }),
        {},
      ),
    ).toBe('http://forge.example.ts.net');
  });

  it('falls back to FORGE_WEB_ORIGIN, then the reported URL, when no usable host arrives', () => {
    expect(browserOrigin(reported, new Headers(), { FORGE_WEB_ORIGIN: 'http://forge.local' })).toBe(
      'http://forge.local',
    );
    expect(browserOrigin(reported, new Headers(), {})).toBe('http://localhost:3000');
    expect(browserOrigin(reported, new Headers({ host: 'bad host/with?junk' }), {})).toBe(
      'http://localhost:3000',
    );
    expect(browserOrigin(reported, new Headers({ host: 'x'.repeat(300) }), {})).toBe(
      'http://localhost:3000',
    );
  });
});

describe('sameOriginForm', () => {
  const browser = (origin: string, site = 'same-origin') =>
    new Headers({ origin, 'sec-fetch-site': site });

  it('accepts a form the browser says came from this site', () => {
    expect(sameOriginForm(http, browser('http://127.0.0.1:3000'), {})).toBe(true);
    expect(
      sameOriginForm(http, browser('http://forge.local:3000'), {
        FORGE_WEB_ORIGIN: 'http://forge.local:3000',
      }),
    ).toBe(true);
  });

  it('falls back to the Host the browser addressed, not the URL Next reports', () => {
    // `next start` reports request.url as localhost whatever the client typed.
    const reported = new URL('http://localhost:3000/login/session');
    const headers = browser('http://127.0.0.1:3000');
    headers.set('host', '127.0.0.1:3000');
    expect(sameOriginForm(reported, headers, {})).toBe(true);
    expect(sameOriginForm(reported, headers, { FORGE_WEB_ORIGIN: '' })).toBe(true);
    // Behind TLS the expected scheme follows the proxy's word.
    const tls = browser('https://forge.example.ts.net');
    tls.set('host', 'forge.example.ts.net');
    tls.set('x-forwarded-proto', 'https');
    expect(sameOriginForm(reported, tls, {})).toBe(true);
    tls.delete('x-forwarded-proto');
    expect(sameOriginForm(reported, tls, {})).toBe(false);
    // A configured origin always wins over the Host header.
    expect(sameOriginForm(reported, headers, { FORGE_WEB_ORIGIN: 'http://forge.local:3000' })).toBe(
      false,
    );
  });

  it('refuses another origin, a cross-site fetch, or a client that sends neither header', () => {
    expect(sameOriginForm(http, browser('https://attacker.invalid'), {})).toBe(false);
    expect(sameOriginForm(http, browser('http://127.0.0.1:3000', 'cross-site'), {})).toBe(false);
    expect(sameOriginForm(http, browser('http://127.0.0.1:3000', 'none'), {})).toBe(false);
    expect(sameOriginForm(http, new Headers(), {})).toBe(false);
    expect(
      sameOriginForm(http, browser('http://127.0.0.1:3000'), {
        FORGE_WEB_ORIGIN: 'http://forge.local:3000',
      }),
    ).toBe(false);
  });
});
