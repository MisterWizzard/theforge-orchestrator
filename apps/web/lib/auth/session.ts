/**
 * The operator session token: `v1.<claims>.<signature>`, where the claims are
 * base64url JSON `{ issuedAt, expiresAt, nonce }` and the signature is an
 * HMAC-SHA256 over `v1.<claims>` with a key derived by HKDF-SHA256 from
 * `FORGE_WEB_SESSION_SECRET`, or from the operator password when no secret is
 * set, so one variable is enough (ADR-027).
 *
 * Web Crypto only, deliberately: the same module verifies in the middleware,
 * which runs on Next's edge runtime, and issues in the login route, which runs
 * on node. `crypto.subtle.verify` is constant time; nothing here compares a
 * secret with `===`.
 */
export const SESSION_COOKIE = 'forge_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A token whose `issuedAt` is further in the future than this is refused. */
export const CLOCK_SKEW_MS = 60_000;
export const TOKEN_VERSION = 'v1';
const MAX_TOKEN_LENGTH = 1024;
const SIGNATURE_BYTES = 32;
// Fixed and public: they separate this key from any other use of the same
// material; the secrecy is entirely in the material.
const HKDF_SALT = 'theforge-web-session';
const HKDF_INFO = 'forge_session hmac-sha256 v1';

export type SessionClaims = { issuedAt: number; expiresAt: number; nonce: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function deriveSessionKey(material: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

let cachedMaterial: string | undefined;
let cachedKey: Promise<CryptoKey> | undefined;

/** The derived key for this material, computed once per process (or per change). */
export function sessionKeyFor(material: string): Promise<CryptoKey> {
  if (!cachedKey || cachedMaterial !== material) {
    cachedMaterial = material;
    cachedKey = deriveSessionKey(material);
  }
  return cachedKey;
}

export async function issueSessionToken(
  key: CryptoKey,
  now = Date.now(),
): Promise<{ token: string; claims: SessionClaims }> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const claims: SessionClaims = { issuedAt: now, expiresAt: now + SESSION_TTL_MS, nonce };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signed = `${TOKEN_VERSION}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  return { token: `${signed}.${toBase64Url(new Uint8Array(signature))}`, claims };
}

/**
 * The claims of a token this key signed, still within its lifetime; `null`
 * for anything else (absent, malformed, tampered, another key, expired, or
 * claiming a longer life than we ever issue).
 */
export async function verifySessionToken(
  key: CryptoKey,
  token: string | null | undefined,
  now = Date.now(),
): Promise<SessionClaims | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
    return null;
  const parts = token.split('.');
  const [version, payload, signature] = parts;
  if (parts.length !== 3 || version !== TOKEN_VERSION || !payload || !signature) return null;
  const signatureBytes = fromBase64Url(signature);
  const payloadBytes = fromBase64Url(payload);
  if (!signatureBytes || !payloadBytes || signatureBytes.length !== SIGNATURE_BYTES) return null;
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(`${TOKEN_VERSION}.${payload}`),
  );
  if (!valid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isClaims(parsed)) return null;
  if (parsed.expiresAt <= now) return null;
  if (parsed.issuedAt > now + CLOCK_SKEW_MS) return null;
  if (parsed.expiresAt - parsed.issuedAt > SESSION_TTL_MS) return null;
  return parsed;
}

function isClaims(value: unknown): value is SessionClaims {
  if (typeof value !== 'object' || value === null) return false;
  const { issuedAt, expiresAt, nonce } = value as Record<string, unknown>;
  return (
    typeof issuedAt === 'number' &&
    Number.isFinite(issuedAt) &&
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt > issuedAt &&
    typeof nonce === 'string' &&
    nonce.length > 0
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
