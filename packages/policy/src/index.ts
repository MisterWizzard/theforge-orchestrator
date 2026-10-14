import { createHash, timingSafeEqual } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ActionClass, Approval } from '@theforge/contracts';

export type CommandAction = { executable: string; args: string[]; cwd: string; workerId?: string };
const destructive = new Set([
  'rm',
  'rmdir',
  'del',
  'format',
  'mkfs',
  'shutdown',
  'reboot',
  'sudo',
  'su',
  'chmod',
  'chown',
]);
const redGit = [
  ['push', '--force'],
  ['reset', '--hard'],
  ['clean', '-f'],
  ['branch', '-D'],
];
const green = new Set([
  'git',
  'pnpm',
  'npm',
  'node',
  'tsx',
  'vitest',
  'tsc',
  'turbo',
  'prettier',
  'eslint',
]);
const remoteGit = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);
const packageMutation = new Set([
  'add',
  'install',
  'i',
  'update',
  'up',
  'remove',
  'uninstall',
  'publish',
  'dlx',
  'exec',
]);
const interpreterFlags = new Set(['-e', '--eval', '-p', '--print', '--input-type']);

export function normalizeAction(action: CommandAction): string {
  if (!action.executable.trim() || action.args.some((arg) => arg.includes('\0')))
    throw new Error('Invalid command');
  return JSON.stringify({
    executable: action.executable.trim(),
    args: action.args,
    cwd: action.cwd,
    workerId: action.workerId ?? null,
  });
}
export function actionDigest(action: CommandAction): string {
  return createHash('sha256').update(normalizeAction(action)).digest('hex');
}
export function classifyAction(
  action: CommandAction,
  workspaceRoot: string,
): { class: ActionClass; reason: string } {
  const executable = (action.executable.split(/[\\/]/).pop()?.toLowerCase() ?? '').replace(
    /\.(?:exe|cmd|bat)$/,
    '',
  );
  if (!isWithin(action.cwd, workspaceRoot))
    return { class: 'red', reason: 'command escapes assigned workspace' };
  if (destructive.has(executable))
    return { class: 'red', reason: 'destructive or privileged executable' };
  if (
    executable === 'git' &&
    redGit.some((pattern) => pattern.every((part) => action.args.includes(part)))
  )
    return { class: 'red', reason: 'destructive Git operation' };
  if (
    executable === 'git' &&
    action.args.some((arg) => arg === '-C' || arg.startsWith('--git-dir'))
  )
    return { class: 'red', reason: 'Git command may select an unmanaged workspace' };
  if (executable === 'git' && remoteGit.has(firstSubcommand(action.args)))
    return { class: 'amber', reason: 'Git network operation requires approval' };
  if (executable === 'node' && action.args.some((arg) => interpreterFlags.has(arg)))
    return { class: 'red', reason: 'inline interpreter execution is not allowlisted' };
  if (
    (executable === 'pnpm' || executable === 'npm') &&
    packageMutation.has(firstSubcommand(action.args))
  )
    return { class: 'amber', reason: 'dependency or package execution requires approval' };
  if (
    action.args.some(
      (arg) =>
        /^https?:\/\//i.test(arg) &&
        ['bash', 'sh', 'zsh', 'powershell', 'pwsh'].includes(executable),
    )
  )
    return { class: 'red', reason: 'remote input passed to a shell' };
  if (action.args.some((arg) => /\.ssh|\.aws|\.config\/gh|\.codex|keychain|credentials/i.test(arg)))
    return { class: 'red', reason: 'secret location access' };
  return green.has(executable)
    ? { class: 'green', reason: 'allowlisted development command' }
    : { class: 'amber', reason: 'non-allowlisted workspace command' };
}
export function approvalAllows(
  approval: Approval,
  action: CommandAction,
  now = new Date(),
): boolean {
  if (approval.status !== 'approved' || new Date(approval.expiresAt) <= now) return false;
  const actual = Buffer.from(actionDigest(action), 'hex');
  const expected = Buffer.from(approval.actionDigest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/**
 * Compare a presented secret with the expected one without leaking where they
 * differ through timing. Both are compared as UTF-8 bytes; a length mismatch
 * is a mismatch. Used for the coordinator and worker bearer tokens.
 */
export function secretEquals(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const actual = Buffer.from(presented, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function isWithin(candidate: string, root: string) {
  const difference = relative(resolve(root), resolve(candidate));
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}

function firstSubcommand(args: string[]) {
  return args.find((arg) => !arg.startsWith('-'))?.toLowerCase() ?? '';
}

/**
 * Generic secret shapes, applied in order after the known values. An entry
 * that names a replacement keeps what it captured (the field name, the word
 * `Bearer`) so the text around the redaction still reads; the others replace
 * their whole match. The two that take a whole value come first, so a token
 * with a shape the narrower patterns only partly cover still goes entirely.
 */
const secretPatterns: Array<{
  pattern: RegExp;
  /**
   * A string is used as `String.replace` uses it, `$1` and all. A function is
   * called per match and may return the match unchanged to decline it, which is
   * how the `name=value` entry below tells a code reference from a literal.
   */
  replacement?: string | ((match: string, ...groups: string[]) => string);
}> = [
  // An HTTP bearer credential, whatever shape the token itself has.
  { pattern: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replacement: '$1[REDACTED]' },
  // A JSON string field named for a credential (token, refresh_token, apiKey,
  // client_secret, password, private_key, credentials...), also when the JSON
  // is itself escaped inside a string. The value goes, the name stays.
  {
    pattern:
      /("[A-Za-z0-9_.-]{0,64}(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_.-]{0,64}\\?"\s*:\s*\\?")(?:[^"\\]|\\[^"])+(?=\\?")/gi,
    replacement: '$1[REDACTED]',
  },
  { pattern: /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { pattern: /\bgh[opurs]_[A-Za-z0-9]{20,}\b/g },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  // A `name=value` or `name: value` pair; the OAuth names are listed rather
  // than any `*_token`, so an unrelated `FOO_TOKEN=` line in prose stays.
  //
  // The value is captured, and an UNQUOTED dotted path of identifiers is
  // declined: see isCodeReference. On 05/10/2026 this rule stopped a commit
  // over `password: mocks.env.SESSION_SECRET,` - a line that reads a mock and
  // contains no credential at all - while the two lines beside it that did hold
  // literal fixture values went through, because `_` is a word character and so
  // `\bpassword` never matches inside `ADMIN_PASSWORD`.
  {
    pattern:
      /\b((?:api[_-]?key|(?:refresh_|access_|id_)?token|(?:client_)?secret|password)\s*[:=]\s*)(['"]?)([^\s'"]{8,})/gi,
    // The field NAME survives and only the value goes, as the JSON rule above
    // already does. It used to replace the whole match, which made the evidence
    // in a secret-scan approval request read `+      [REDACTED]` - a person
    // cannot judge that. Detection is unchanged: the same lines match, and the
    // candidate value is still removed.
    replacement: (match: string, name: string, quote: string, value: string) =>
      quote === '' && isCodeReference(value) ? match : `${name}[REDACTED]`,
  },
  // A JWT: three base64url segments, the first always `eyJ` (an encoded `{"`).
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];
/**
 * A dotted path of identifiers - `mocks.env.SESSION_SECRET`,
 * `process.env.ADMIN_PASSWORD`, `config.auth.password` - which is code that
 * READS a value rather than the value itself. Trailing code punctuation is
 * dropped first, because the value capture is greedy up to whitespace and so
 * takes the comma in `password: mocks.env.SECRET,`.
 *
 * Deliberately NOT a bare identifier, though one is also a reference.
 * `password=hunter2abc` is a valid identifier and is also exactly the shape of
 * a line in a `.env` file, which is the commonest way a real credential reaches
 * a repository; requiring at least one dot keeps that flagged. A quoted value
 * is never a reference either - quotes make it data.
 *
 * This narrows one rule and nothing else. The patterns that recognise a
 * credential by its own shape - JWTs, `sk-`/`ghp_` keys, AWS access key ids,
 * PEM private-key blocks, Bearer values - do not consult this.
 */
function isCodeReference(value: string): boolean {
  const trimmed = value.replace(/[,;)\]}]+$/, '');
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(trimmed);
}

export function redactSecrets(value: string, knownSecrets: string[] = []): string {
  let output = value;
  for (const secret of knownSecrets.filter((item) => item.length >= 6))
    output = output.split(secret).join('[REDACTED]');
  // The two branches read alike on purpose: `String.replace` is overloaded on
  // string and function, and a union of the two matches neither overload, so
  // the narrowing is what picks one.
  for (const { pattern, replacement = '[REDACTED]' } of secretPatterns)
    output =
      typeof replacement === 'string'
        ? output.replace(pattern, replacement)
        : output.replace(pattern, replacement);
  return output;
}
export function containsLikelySecret(value: string): boolean {
  return redactSecrets(value) !== value;
}
export function assertUntrustedText(value: string, maxLength = 200_000): string {
  if (value.length > maxLength) throw new Error('Untrusted text exceeds size limit');
  if (/ignore (all|previous) (instructions|policy)|reveal .*secret|disable .*security/i.test(value))
    throw new Error('Potential prompt injection detected');
  return value;
}
