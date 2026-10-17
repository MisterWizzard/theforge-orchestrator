/**
 * A readable account of an approval, built from the two JSON strings the
 * coordinator stores on it.
 *
 * `normalizedAction` is `JSON.stringify({ executable, args, cwd, workerId })`
 * (`normalizeAction` in `@theforge/policy`) and `scope` is
 * `JSON.stringify({ repositoryUrl, baseRef, commit, secretScan? })`. Both are
 * kept exact because the approval digest is bound to them, so the UI formats
 * them rather than the coordinator changing what it stores. Anything that does
 * not parse, or has an unexpected shape, falls back to the original text:
 * showing it unformatted is better than showing nothing for an approval.
 */
export type ApprovalRow = { label: string; value: string; mono: boolean };

export type ApprovalSummary = {
  /** The command as a person would type it, or null when the action is not a command. */
  command: string | null;
  rows: ApprovalRow[];
  /** The exact stored action and scope, pretty-printed, for audit. */
  raw: string;
};

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** Quote an argument only when a shell would need it, so simple commands stay plain. */
function shellWord(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

export function summariseApproval(normalizedAction: string, scope: string): ApprovalSummary {
  const action = parseObject(normalizedAction);
  const scopeObject = parseObject(scope);
  const executable = text(action?.executable);
  const args =
    Array.isArray(action?.args) && action.args.every((item) => typeof item === 'string')
      ? action.args
      : undefined;
  const command =
    executable && args ? [executable, ...args].map((word) => shellWord(word)).join(' ') : null;

  const rows: ApprovalRow[] = [];
  const cwd = text(action?.cwd);
  if (cwd) rows.push({ label: 'Working directory', value: cwd, mono: true });
  const workerId = text(action?.workerId);
  if (workerId) rows.push({ label: 'Worker', value: workerId, mono: true });
  const repositoryUrl = text(scopeObject?.repositoryUrl);
  if (repositoryUrl) rows.push({ label: 'Repository', value: repositoryUrl, mono: true });
  const baseRef = text(scopeObject?.baseRef);
  if (baseRef) rows.push({ label: 'Base branch', value: baseRef, mono: true });
  const commit = text(scopeObject?.commit);
  if (commit) rows.push({ label: 'Commit', value: commit.slice(0, 12), mono: true });
  const secretScan = scopeObject?.secretScan;
  if (secretScan && typeof secretScan === 'object') {
    const evidence = (secretScan as { evidence?: unknown }).evidence;
    rows.push({
      label: 'Secret scan',
      value: Array.isArray(evidence)
        ? `${evidence.length} possible secret${evidence.length === 1 ? '' : 's'} flagged`
        : 'Possible secrets flagged',
      mono: false,
    });
  }

  const raw =
    action || scopeObject
      ? JSON.stringify({ action: action ?? normalizedAction, scope: scopeObject ?? scope }, null, 2)
      : [normalizedAction, scope].filter(Boolean).join('\n');
  return { command: command ?? (action ? null : normalizedAction), rows, raw };
}
