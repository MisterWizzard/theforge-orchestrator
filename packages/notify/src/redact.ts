/**
 * Secret hygiene for everything the notifier writes or throws.
 *
 * The Home Assistant token and the SMTP password are the only secrets this
 * package holds. They must never reach a log line, an outbox file, a thrown
 * error or a notification body. Channels are written so that they do not
 * include them, and this is the second line: every rendered message and every
 * error message passes through here with the configured secrets before it
 * leaves the package.
 */

/** Below this length a "secret" is too short to redact without shredding ordinary text. */
const MIN_SECRET_LENGTH = 6;

export function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    output = output.split(secret).join('[REDACTED]');
    // A secret that travelled base64-encoded (SMTP AUTH PLAIN) is still the secret.
    const encoded = Buffer.from(secret, 'utf8').toString('base64');
    if (encoded.length >= MIN_SECRET_LENGTH) output = output.split(encoded).join('[REDACTED]');
  }
  return output;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : undefined;
    return causeText ? `${error.message}: ${causeText}` : error.message;
  }
  return String(error);
}

export function redactedError(error: unknown, secrets: readonly string[]): string {
  return redact(errorMessage(error), secrets);
}
