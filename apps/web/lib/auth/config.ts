/**
 * Operator login configuration, read from the environment and nothing else.
 *
 * Pure, so the middleware (edge runtime), the login route (node runtime) and
 * the tests share one reading of the rules: the password must exist and be
 * 16+ characters, and the optional session secret, when present, must be 16+
 * characters too. Anything else is "not configured", and not configured means
 * the web app answers nothing but `/login` and `/forge-api/health` (ADR-027).
 *
 * Nothing here logs or returns a value in an error message: the reason strings
 * name the variable and the rule, never the contents.
 */
export const PASSWORD_VARIABLE = 'FORGE_WEB_OPERATOR_PASSWORD';
export const SECRET_VARIABLE = 'FORGE_WEB_SESSION_SECRET';
export const MIN_PASSWORD_LENGTH = 16;
export const MIN_SECRET_LENGTH = 16;

export type OperatorAuth =
  | {
      configured: true;
      password: string;
      /** What the session key is derived from: the secret when set, else the password. */
      keyMaterial: string;
      derivedFromPassword: boolean;
    }
  | { configured: false; reason: string };

export function readOperatorAuth(env: Record<string, string | undefined>): OperatorAuth {
  const password = env[PASSWORD_VARIABLE];
  if (!password) return { configured: false, reason: `${PASSWORD_VARIABLE} is not set` };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      configured: false,
      reason: `${PASSWORD_VARIABLE} is shorter than ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  const secret = env[SECRET_VARIABLE];
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    return {
      configured: false,
      reason: `${SECRET_VARIABLE} is set but shorter than ${MIN_SECRET_LENGTH} characters`,
    };
  }
  return {
    configured: true,
    password,
    keyMaterial: secret || password,
    derivedFromPassword: !secret,
  };
}
