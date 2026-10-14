import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, passwordMatches } from './password';

// Fixed dummy values; nothing here is a real secret.
const PASSWORD = 'correct-horse-battery-staple';

describe('passwordMatches', () => {
  it('accepts the exact password and nothing near it', () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(passwordMatches(`${PASSWORD} `, PASSWORD)).toBe(false);
    expect(passwordMatches(PASSWORD.slice(0, -1), PASSWORD)).toBe(false);
    expect(passwordMatches(PASSWORD.toUpperCase(), PASSWORD)).toBe(false);
    expect(passwordMatches(`${PASSWORD}x`, PASSWORD)).toBe(false);
  });

  it('compares fixed-length digests, so lengths that differ never throw and never match', () => {
    expect(passwordMatches('a', PASSWORD)).toBe(false);
    expect(passwordMatches('a'.repeat(200), PASSWORD)).toBe(false);
    expect(() => passwordMatches('short', 'a much longer expected value')).not.toThrow();
  });

  it('is byte-exact for non-ASCII passwords', () => {
    expect(passwordMatches('pässwörd-with-ümlauts', 'pässwörd-with-ümlauts')).toBe(true);
    expect(passwordMatches('pässwörd-with-ümlauts', 'passwörd-with-ümlauts')).toBe(false);
    // Composed and decomposed forms are different passwords, as they are different bytes.
    expect(passwordMatches('café-1234567890', 'café-1234567890')).toBe(false);
  });

  it('refuses a non-string, an empty string and an over-long submission without hashing them', () => {
    for (const bad of [undefined, null, 42, {}, [], '', 'x'.repeat(MAX_PASSWORD_LENGTH + 1)]) {
      expect(passwordMatches(bad, PASSWORD), JSON.stringify(bad) ?? 'undefined').toBe(false);
    }
    expect(passwordMatches('x'.repeat(MAX_PASSWORD_LENGTH), 'x'.repeat(MAX_PASSWORD_LENGTH))).toBe(
      true,
    );
  });
});
