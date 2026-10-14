import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, MIN_SECRET_LENGTH, readOperatorAuth } from './config';

// Fixed dummy values; nothing here is a real secret.
const PASSWORD = 'unit-test-operator-password';
const SECRET = 'unit-test-session-secret-value';

describe('readOperatorAuth', () => {
  it('is not configured without a password, and says which variable', () => {
    expect(readOperatorAuth({})).toEqual({
      configured: false,
      reason: 'FORGE_WEB_OPERATOR_PASSWORD is not set',
    });
    expect(readOperatorAuth({ FORGE_WEB_OPERATOR_PASSWORD: '' })).toEqual({
      configured: false,
      reason: 'FORGE_WEB_OPERATOR_PASSWORD is not set',
    });
  });

  it('is not configured with a password under 16 characters, and never echoes it', () => {
    const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
    const result = readOperatorAuth({ FORGE_WEB_OPERATOR_PASSWORD: short });
    expect(result).toEqual({
      configured: false,
      reason: 'FORGE_WEB_OPERATOR_PASSWORD is shorter than 16 characters',
    });
    expect(JSON.stringify(result)).not.toContain(short);
  });

  it('derives the session key material from the password when no secret is set', () => {
    const exact = 'y'.repeat(MIN_PASSWORD_LENGTH);
    expect(readOperatorAuth({ FORGE_WEB_OPERATOR_PASSWORD: exact })).toEqual({
      configured: true,
      password: exact,
      keyMaterial: exact,
      derivedFromPassword: true,
    });
    expect(
      readOperatorAuth({ FORGE_WEB_OPERATOR_PASSWORD: PASSWORD, FORGE_WEB_SESSION_SECRET: '' }),
    ).toMatchObject({ configured: true, keyMaterial: PASSWORD, derivedFromPassword: true });
  });

  it('uses the session secret as key material when it is set and long enough', () => {
    expect(
      readOperatorAuth({
        FORGE_WEB_OPERATOR_PASSWORD: PASSWORD,
        FORGE_WEB_SESSION_SECRET: SECRET,
      }),
    ).toEqual({
      configured: true,
      password: PASSWORD,
      keyMaterial: SECRET,
      derivedFromPassword: false,
    });
    const short = 's'.repeat(MIN_SECRET_LENGTH - 1);
    expect(
      readOperatorAuth({ FORGE_WEB_OPERATOR_PASSWORD: PASSWORD, FORGE_WEB_SESSION_SECRET: short }),
    ).toEqual({
      configured: false,
      reason: 'FORGE_WEB_SESSION_SECRET is set but shorter than 16 characters',
    });
  });

  it('ignores every other variable', () => {
    expect(
      readOperatorAuth({ FORGE_COORDINATOR_TOKEN: 'z'.repeat(40), FORGE_WEB_ORIGIN: 'http://x' }),
    ).toEqual({ configured: false, reason: 'FORGE_WEB_OPERATOR_PASSWORD is not set' });
  });
});
