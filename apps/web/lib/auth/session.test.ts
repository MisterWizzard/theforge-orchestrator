import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_MS,
  SESSION_TTL_MS,
  TOKEN_VERSION,
  deriveSessionKey,
  issueSessionToken,
  sessionKeyFor,
  verifySessionToken,
} from './session';

// Fixed dummy material; nothing here is a real secret.
const MATERIAL = 'unit-test-operator-password-16+';
const NOW = 1_790_000_000_000;

async function key(material = MATERIAL) {
  return deriveSessionKey(material);
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('session token', () => {
  it('round-trips: a token this key issued verifies to its claims', async () => {
    const k = await key();
    const { token, claims } = await issueSessionToken(k, NOW);
    expect(token.startsWith(`${TOKEN_VERSION}.`)).toBe(true);
    expect(token.split('.')).toHaveLength(3);
    expect(claims).toEqual({ issuedAt: NOW, expiresAt: NOW + SESSION_TTL_MS, nonce: claims.nonce });
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(verifySessionToken(k, token, NOW)).resolves.toEqual(claims);
    await expect(verifySessionToken(k, token, NOW + SESSION_TTL_MS - 1)).resolves.toEqual(claims);
  });

  it('gives every token its own nonce', async () => {
    const k = await key();
    const first = await issueSessionToken(k, NOW);
    const second = await issueSessionToken(k, NOW);
    expect(first.claims.nonce).not.toBe(second.claims.nonce);
    expect(first.token).not.toBe(second.token);
  });

  it('expires exactly 12 h after issue and refuses a token from the future', async () => {
    const k = await key();
    const { token } = await issueSessionToken(k, NOW);
    await expect(verifySessionToken(k, token, NOW + SESSION_TTL_MS)).resolves.toBeNull();
    await expect(verifySessionToken(k, token, NOW + SESSION_TTL_MS + 1)).resolves.toBeNull();
    await expect(verifySessionToken(k, token, NOW - CLOCK_SKEW_MS)).resolves.not.toBeNull();
    await expect(verifySessionToken(k, token, NOW - CLOCK_SKEW_MS - 1)).resolves.toBeNull();
  });

  it('refuses a tampered payload, a tampered signature and a swapped signature', async () => {
    const k = await key();
    const { token } = await issueSessionToken(k, NOW);
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const longer = base64Url(
      JSON.stringify({ issuedAt: NOW, expiresAt: NOW + 10 * SESSION_TTL_MS, nonce: 'x' }),
    );
    await expect(
      verifySessionToken(k, `${version}.${longer}.${signature}`, NOW),
    ).resolves.toBeNull();
    const flipped = signature[0] === 'A' ? 'B' : 'A';
    await expect(
      verifySessionToken(k, `${version}.${payload}.${flipped}${signature.slice(1)}`, NOW),
    ).resolves.toBeNull();
    const other = await issueSessionToken(k, NOW);
    const otherSignature = other.token.split('.')[2];
    await expect(
      verifySessionToken(k, `${version}.${payload}.${otherSignature}`, NOW),
    ).resolves.toBeNull();
  });

  it('refuses a token signed with another key, even one derived from a near-identical material', async () => {
    const k = await key();
    const { token } = await issueSessionToken(k, NOW);
    await expect(verifySessionToken(await key(`${MATERIAL}x`), token, NOW)).resolves.toBeNull();
    await expect(verifySessionToken(await key(MATERIAL), token, NOW)).resolves.not.toBeNull();
  });

  it('refuses a well-signed token whose claims are not a session', async () => {
    const k = await key();
    const sign = async (claims: unknown) => {
      const payload = base64Url(JSON.stringify(claims));
      const signature = await crypto.subtle.sign(
        'HMAC',
        k,
        new TextEncoder().encode(`${TOKEN_VERSION}.${payload}`),
      );
      return `${TOKEN_VERSION}.${payload}.${Buffer.from(signature).toString('base64url')}`;
    };
    // Longer than we ever issue.
    await expect(
      verifySessionToken(
        k,
        await sign({ issuedAt: NOW, expiresAt: NOW + SESSION_TTL_MS + 1, nonce: 'n' }),
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(
      verifySessionToken(k, await sign({ issuedAt: NOW, expiresAt: NOW + 1000 }), NOW),
    ).resolves.toBeNull();
    await expect(
      verifySessionToken(
        k,
        await sign({ issuedAt: 'now', expiresAt: NOW + 1000, nonce: 'n' }),
        NOW,
      ),
    ).resolves.toBeNull();
    await expect(verifySessionToken(k, await sign('not an object'), NOW)).resolves.toBeNull();
    await expect(verifySessionToken(k, await sign(null), NOW)).resolves.toBeNull();
    // And a valid shape still passes through the same signer, so the refusals above are about the claims.
    await expect(
      verifySessionToken(k, await sign({ issuedAt: NOW, expiresAt: NOW + 1000, nonce: 'n' }), NOW),
    ).resolves.toEqual({ issuedAt: NOW, expiresAt: NOW + 1000, nonce: 'n' });
  });

  it('refuses anything that is not a three-part v1 token', async () => {
    const k = await key();
    const { token } = await issueSessionToken(k, NOW);
    for (const bad of [
      undefined,
      null,
      '',
      'v1',
      'v1.',
      'v1..',
      token.replace(/^v1\./, 'v2.'),
      `${token}.extra`,
      token.slice(0, -1),
      `${token.split('.').slice(0, 2).join('.')}.@@@@`,
      `v1.${'A'.repeat(1100)}.${'A'.repeat(43)}`,
      'v1.bm90IGpzb24.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      await expect(verifySessionToken(k, bad, NOW), String(bad)).resolves.toBeNull();
    }
  });

  it('derives the same key for the same material and caches it per process', async () => {
    const a = sessionKeyFor(MATERIAL);
    expect(sessionKeyFor(MATERIAL)).toBe(a);
    const { token } = await issueSessionToken(await a, NOW);
    await expect(
      verifySessionToken(await deriveSessionKey(MATERIAL), token, NOW),
    ).resolves.not.toBeNull();
    const b = sessionKeyFor(`${MATERIAL}-rotated`);
    expect(b).not.toBe(a);
    await expect(verifySessionToken(await b, token, NOW)).resolves.toBeNull();
  });
});
