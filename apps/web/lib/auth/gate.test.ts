import { describe, expect, it } from 'vitest';
import { gate, isPublicPath, loginLocation, safeNextPath, type GateInput } from './gate';

const base: GateInput = {
  pathname: '/',
  search: '',
  method: 'GET',
  configured: true,
  authenticated: false,
};

function decide(overrides: Partial<GateInput>) {
  return gate({ ...base, ...overrides });
}

describe('gate', () => {
  it('sends an unauthenticated page request to /login, remembering where it was going', () => {
    expect(decide({})).toEqual({ kind: 'redirect', location: '/login' });
    expect(decide({ pathname: '/settings' })).toEqual({
      kind: 'redirect',
      location: '/login?next=%2Fsettings',
    });
    expect(decide({ pathname: '/runs/run-1', search: '?tab=tasks' })).toEqual({
      kind: 'redirect',
      location: '/login?next=%2Fruns%2Frun-1%3Ftab%3Dtasks',
    });
    expect(decide({ pathname: '/settings', method: 'POST' })).toEqual({
      kind: 'redirect',
      location: '/login?next=%2Fsettings',
    });
  });

  it('answers an unauthenticated API call with 401, never a redirect', () => {
    expect(decide({ pathname: '/forge-api/runs' })).toEqual({ kind: 'unauthorized' });
    expect(decide({ pathname: '/forge-api/projects', method: 'POST' })).toEqual({
      kind: 'unauthorized',
    });
    expect(decide({ pathname: '/forge-api/runs/1/events' })).toEqual({ kind: 'unauthorized' });
    // Only the exact health path is open; anything that merely starts with it is not.
    expect(decide({ pathname: '/forge-api/health' })).toEqual({ kind: 'allow' });
    expect(decide({ pathname: '/forge-api/health/../runs' })).toEqual({ kind: 'unauthorized' });
    expect(decide({ pathname: '/forge-api/healthz' })).toEqual({ kind: 'unauthorized' });
  });

  it('lets a valid session through everywhere, and sends it home from the login form', () => {
    for (const pathname of ['/', '/settings', '/runs/run-1', '/forge-api/runs', '/logout']) {
      expect(decide({ pathname, authenticated: true }), pathname).toEqual({ kind: 'allow' });
    }
    expect(decide({ pathname: '/login', authenticated: true })).toEqual({
      kind: 'redirect',
      location: '/',
    });
    expect(
      decide({ pathname: '/login', search: '?next=%2Fsettings', authenticated: true }),
    ).toEqual({ kind: 'redirect', location: '/' });
    // The form's own POST target is left alone so a fresh sign-in still works.
    expect(decide({ pathname: '/login/session', method: 'POST', authenticated: true })).toEqual({
      kind: 'allow',
    });
  });

  it('leaves the public paths and Next assets open without a session', () => {
    for (const pathname of [
      '/login',
      '/login/session',
      '/logout',
      '/forge-api/health',
      '/_next/static/chunks/main.js',
      '/favicon.ico',
    ]) {
      expect(isPublicPath(pathname), pathname).toBe(true);
      expect(decide({ pathname }), pathname).toEqual({ kind: 'allow' });
    }
    for (const pathname of ['/loginx', '/logout/now', '/runs', '/forge-api/runs']) {
      expect(isPublicPath(pathname), pathname).toBe(false);
    }
  });

  it('fails closed with 503 when login is not configured, except for the public paths', () => {
    expect(decide({ configured: false })).toEqual({ kind: 'unconfigured', api: false });
    expect(decide({ configured: false, pathname: '/settings' })).toEqual({
      kind: 'unconfigured',
      api: false,
    });
    expect(decide({ configured: false, pathname: '/forge-api/runs' })).toEqual({
      kind: 'unconfigured',
      api: true,
    });
    // A cookie cannot help: with no key there is no valid session.
    expect(decide({ configured: false, authenticated: true, pathname: '/' })).toEqual({
      kind: 'unconfigured',
      api: false,
    });
    expect(decide({ configured: false, pathname: '/login' })).toEqual({ kind: 'allow' });
    expect(decide({ configured: false, pathname: '/logout' })).toEqual({ kind: 'allow' });
    expect(decide({ configured: false, pathname: '/forge-api/health' })).toEqual({ kind: 'allow' });
  });
});

describe('safeNextPath', () => {
  it('keeps a path on this site, query and all', () => {
    expect(safeNextPath('/settings')).toBe('/settings');
    expect(safeNextPath('/runs/run-1?tab=tasks#top')).toBe('/runs/run-1?tab=tasks#top');
    expect(safeNextPath('/')).toBe('/');
  });

  it('falls back to / for anything that could leave the site or loop', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'settings',
      'https://attacker.invalid/',
      '//attacker.invalid/',
      '/\\attacker.invalid',
      '/settings\r\nSet-Cookie: x=y',
      '/set tings',
      '/login',
      '/login?error=invalid',
      '/login/session',
      '/logout',
      `/${'a'.repeat(3000)}`,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBe('/');
    }
  });
});

describe('loginLocation', () => {
  it('omits next for the home page and encodes it otherwise', () => {
    expect(loginLocation('/', '')).toBe('/login');
    expect(loginLocation('/', '?x=1')).toBe('/login?next=%2F%3Fx%3D1');
    expect(loginLocation('/settings', '')).toBe('/login?next=%2Fsettings');
    expect(loginLocation('/login', '?error=invalid')).toBe('/login');
  });
});
