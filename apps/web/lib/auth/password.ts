import { createHash, timingSafeEqual } from 'node:crypto';

/** Longer than any password an operator would type; caps the hashing work an unauthenticated body can ask for. */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Whether `submitted` is the operator password, in constant time with respect
 * to the password: both sides are hashed to a fixed 32 bytes and compared with
 * `timingSafeEqual`, so neither the length nor the first differing byte of the
 * password shapes the timing. Node only; the middleware never sees a password.
 */
export function passwordMatches(submitted: unknown, expected: string): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  if (submitted.length > MAX_PASSWORD_LENGTH) return false;
  const a = createHash('sha256').update(submitted, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
