/**
 * Machine-readable Tier 0 outcomes.
 *
 * Until now the CLI printed text and discarded the `PullRequestOutcome`
 * objects, so a merge or an escalation left no evidence anything else could
 * read (task F114). Every run now writes one JSON array - to `--json=<path>`
 * when asked, otherwise to the outbox - and `forge tier0-ingest` turns those
 * records into notifications (policy B11: autonomous merges reach Dan).
 *
 * Check output is deliberately left out of the record. It is large, it can
 * contain anything the repository's tests print, and the decision reason
 * already names which checks failed.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveOutboxDir,
  writeFileAtomically,
  type EnvironmentLike,
  type Escalation,
} from '@theforge/notify';
import type { Decision } from './policy.js';
import type { PullRequestOutcome } from './runner.js';

export type Tier0Mode = 'execute' | 'dry-run';

export type Tier0CheckRecord = { name: string; command: string; exitCode: number };

export type Tier0OutcomeRecord = {
  repository: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  mode: Tier0Mode;
  action: Decision['action'];
  reason: string;
  hint?: string;
  checks: Tier0CheckRecord[];
  attempts: number;
  merged: boolean;
  mergedAt?: string;
  /**
   * The squash commit on the base branch. Absent in files written before it
   * was recorded (and when the post-merge lookup failed); `forge ci-watch`
   * then asks GitHub for it.
   */
  mergeSha?: string;
  durationMs: number;
  /** HEAD of the TheForge checkout that ran Tier 0, for provenance. */
  tier0Commit: string;
};

export function toOutcomeRecord(
  outcome: PullRequestOutcome,
  mode: Tier0Mode,
  tier0Commit: string,
): Tier0OutcomeRecord {
  const hint = 'hint' in outcome.decision ? outcome.decision.hint : undefined;
  return {
    repository: outcome.pullRequest.repository,
    number: outcome.pullRequest.number,
    title: outcome.pullRequest.title,
    author: outcome.pullRequest.author,
    headSha: outcome.pullRequest.headSha,
    mode,
    action: outcome.decision.action,
    reason: outcome.decision.reason,
    ...(hint !== undefined ? { hint } : {}),
    checks: outcome.checks.map(({ name, command, exitCode }) => ({ name, command, exitCode })),
    attempts: outcome.attempts,
    merged: outcome.merged,
    ...(outcome.mergedAt !== undefined ? { mergedAt: outcome.mergedAt } : {}),
    ...(outcome.mergeSha !== undefined ? { mergeSha: outcome.mergeSha } : {}),
    durationMs: outcome.durationMs,
    tier0Commit,
  };
}

/** `<outbox>/tier0/<timestamp>.json`, the default when `--json` is not given. */
export function outcomeReportPath(env: EnvironmentLike, time: number = Date.now()): string {
  const stamp = new Date(time)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return join(resolveOutboxDir(env), 'tier0', `${stamp}.json`);
}

const OUTCOME_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/;

/**
 * When an outcomes file named by `outcomeReportPath` was written, as epoch
 * milliseconds; undefined for any other name (a `--json=<path>` file), where
 * the caller falls back to the file's mtime.
 */
export function outcomeReportTime(name: string): number | undefined {
  const match = OUTCOME_FILE.exec(name);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export async function writeOutcomeReport(
  path: string,
  records: readonly Tier0OutcomeRecord[],
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFileAtomically(path, `${JSON.stringify(records, null, 2)}\n`);
}

const ACTIONS: ReadonlySet<string> = new Set([
  'merge',
  'escalate',
  'skip',
  'verify-only',
  'deferred',
]);

/**
 * Validate a file's contents before trusting it. The file is written by Tier 0
 * itself, but it sits on disk between runs and is handed to the CLI by path;
 * a wrong path or a hand edit should fail with a reason, not with a stack.
 */
export function parseOutcomeRecords(text: string): Tier0OutcomeRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of Tier 0 outcomes');
  return parsed.map((item, index) => {
    const at = `outcome[${index}]`;
    if (!item || typeof item !== 'object') throw new Error(`${at} is not an object`);
    const record = item as Record<string, unknown>;
    const string = (key: string): string => {
      const value = record[key];
      if (typeof value !== 'string') throw new Error(`${at}.${key} must be a string`);
      return value;
    };
    const number = (key: string): number => {
      const value = record[key];
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${at}.${key} must be a number`);
      return value;
    };
    const action = string('action');
    if (!ACTIONS.has(action)) throw new Error(`${at}.action '${action}' is not a Tier 0 action`);
    const mode = string('mode');
    if (mode !== 'execute' && mode !== 'dry-run')
      throw new Error(`${at}.mode must be execute or dry-run`);
    const checks = Array.isArray(record.checks) ? record.checks : [];
    return {
      repository: string('repository'),
      number: number('number'),
      title: string('title'),
      author: string('author'),
      headSha: string('headSha'),
      mode,
      action: action as Decision['action'],
      reason: string('reason'),
      ...(typeof record.hint === 'string' ? { hint: record.hint } : {}),
      checks: checks.map((check) => {
        const raw = (check ?? {}) as Record<string, unknown>;
        return {
          name: typeof raw.name === 'string' ? raw.name : '',
          command: typeof raw.command === 'string' ? raw.command : '',
          exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : -1,
        };
      }),
      attempts: number('attempts'),
      merged: record.merged === true,
      ...(typeof record.mergedAt === 'string' ? { mergedAt: record.mergedAt } : {}),
      // Recorded from F116 on; older files simply lack it.
      ...(typeof record.mergeSha === 'string' && record.mergeSha
        ? { mergeSha: record.mergeSha }
        : {}),
      durationMs: number('durationMs'),
      tier0Commit: typeof record.tier0Commit === 'string' ? record.tier0Commit : 'unknown',
    };
  });
}

/**
 * The notification a Tier 0 outcome warrants, or null for the ones nobody
 * needs to hear about (skips, verify-only, and a dry run's would-merge).
 * Dedupe is on repository, number and head, so re-ingesting the same file
 * or re-running Tier 0 against an unchanged head says nothing twice.
 */
export function escalationFromOutcomeRecord(
  record: Tier0OutcomeRecord,
  occurredAt: string = record.mergedAt ?? new Date().toISOString(),
): Escalation | null {
  const ref = `${record.repository}#${record.number}`;
  const head = record.headSha.slice(0, 8);
  const failed = record.checks.filter((check) => check.exitCode !== 0).map((check) => check.name);
  const base = {
    project: record.repository,
    task: `PR #${record.number}: ${record.title}`,
    occurredAt,
    evidence: [
      `${ref} at ${record.headSha}`,
      ...(record.mergeSha ? [`merged as ${record.mergeSha}`] : []),
      `checks: ${record.checks.map((check) => `${check.name} exit ${check.exitCode}`).join(', ') || 'none run'}`,
      `attempts ${record.attempts}, ${Math.round(record.durationMs / 1000)} s, Tier 0 at ${record.tier0Commit.slice(0, 8)}`,
    ],
    dedupeKey: `tier0:${record.action}:${ref}@${record.headSha}`,
  };
  if (record.action === 'merge' && record.merged) {
    return {
      ...base,
      kind: 'tier0.merge',
      severity: 'info',
      title: `Tier 0 merged ${ref}: ${record.title}`,
      what: `${record.title} (${ref}, head ${head}) passed ${record.checks.length} checks and was squash-merged without any model involvement. ${record.reason}.`,
      options: [
        {
          label: 'Nothing',
          consequence: 'The merge stands. The branch was deleted on GitHub.',
        },
        {
          label: `Revert on GitHub if the bump turns out to be wrong`,
          consequence:
            'A revert PR restores the previous version; Dependabot will re-open the bump later.',
        },
      ],
      recommendation: 'No action. This is the routine outcome; the next digest lists it.',
      paused: false,
    };
  }
  if (record.action === 'escalate') {
    return {
      ...base,
      kind: 'tier0.escalate',
      severity: 'warn',
      title: `Tier 0 could not merge ${ref}: ${record.title}`,
      what: `${record.reason}.${failed.length ? ` Failed: ${failed.join(', ')}.` : ''}${record.hint ? `\n${record.hint}` : ''}`,
      options: [
        {
          label: 'Comment "@dependabot rebase" on the PR and re-run Tier 0',
          consequence:
            'Dependabot pushes a new head on the current base; the next run verifies it from scratch. Fixes every stale-base case.',
        },
        {
          label: 'Read the failing check output and decide by hand',
          consequence: 'Nothing changes until you merge or close the PR yourself.',
        },
        {
          label: 'Close the PR',
          consequence: 'Dependabot will not re-open this exact bump unless asked.',
        },
      ],
      recommendation: record.hint
        ? 'Try the rebase first; a real failure survives it, a stale base does not.'
        : 'Read the check output before deciding; Tier 0 has no opinion on why it failed.',
      paused: false,
    };
  }
  if (record.action === 'deferred') {
    return {
      ...base,
      kind: 'tier0.deferred',
      severity: 'info',
      title: `Tier 0 deferred ${ref}: ${record.title}`,
      what: `The checks passed but the pre-merge re-check found ${record.reason}. Nothing was merged.${record.hint ? `\n${record.hint}` : ''}`,
      options: [
        {
          label: 'Nothing',
          consequence: 'The next Tier 0 run picks the PR up again once Dependabot has rebased it.',
        },
      ],
      recommendation: 'No action unless it stays deferred across several runs.',
      paused: false,
    };
  }
  return null;
}
