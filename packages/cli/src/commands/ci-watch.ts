/**
 * `forge ci-watch`: CI failures on touched work, outside the coordinator.
 *
 * Policy B11 names "CI failure on touched work" as a reason to reach Dan. The
 * coordinator already covers its own runs (`ci.failed` and friends in
 * apps/coordinator/src/escalation.ts). Two kinds of touched work happen after
 * the coordinator has let go, and nothing watched them until now (ADR-026):
 *
 *   (a) the post-merge CI run on an allowlisted repository's default branch
 *       after a Tier 0 merge - Tier 0 ran the repository's checks locally,
 *       but the workflow on GitHub is the one that counts;
 *   (b) CI on a pull request the system itself opened - the pipeline pushes
 *       `forge/<run>` and opens a draft PR, then its run completes.
 *
 * Both become a **warn** escalation with a link to the run. A small state file
 * remembers every merge commit and PR head already decided, so a run every
 * half hour is quiet unless something new failed. GitHub is reached the way
 * Tier 0 reaches it: through the `gh` CLI via an injectable `CommandRunner`,
 * so the tests feed it JSON and no token is ever handled here.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createNotifierFromEnv,
  writeFileAtomically,
  type Escalation,
  type NotifierReport,
} from '@theforge/notify';
import {
  DEFAULT_CONFIG,
  lookupMergeSha,
  outcomeReportTime,
  parseOutcomeRecords,
  runCommand,
  type CommandRunner,
} from '@theforge/tier0';
import { parseArgs, type Command } from '../command.js';
import { formatReport } from './tier0-ingest.js';

/**
 * The marker for a pull request the system opened. Both PR paths push a head
 * branch named `forge/<first 8 of the run id>` (apps/coordinator/src/server.ts
 * and the workflow's `input.branch`); no label is applied and the body text
 * differs between them, so the branch prefix is the one marker set in code.
 */
export const SYSTEM_BRANCH_PREFIX = 'forge/';
export const DEFAULT_HOURS = 48;
/**
 * A merge commit or PR head with no workflow run at all after this long is
 * recorded as having none, so a repository without CI stops being queried.
 */
export const NO_RUNS_GRACE_MS = 6 * 60 * 60 * 1_000;
/** Markers older than this are dropped from the state file. */
export const STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
/**
 * Runs GitHub starts on its own behalf rather than from the repository's
 * workflows: `event: dynamic` is the Dependabot Updates job, CodeQL default
 * setup and the like. Observed on shopfront merge c8b2fcf0 (27/09/2026): the
 * "Dependabot Updates" run failed while the repository's CI passed. Those are
 * not CI on the touched work, so they are left out before deciding.
 */
const IGNORED_RUN_EVENTS = new Set(['dynamic']);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

/** One row of `gh run list --json`. */
export type WorkflowRun = {
  databaseId?: number;
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  headBranch?: string;
  headSha?: string;
  event?: string;
  updatedAt?: string;
};

/** One item of a pull request's `statusCheckRollup` (a CheckRun or a StatusContext). */
export type RollupItem = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
  completedAt?: string;
};

export type FailedCheck = { name: string; url: string };

export type CiVerdict =
  | { outcome: 'failure'; failed: FailedCheck[]; total: number; branch?: string; at?: string }
  | { outcome: 'success'; total: number }
  | { outcome: 'pending'; running: number; total: number }
  | { outcome: 'none' };

/**
 * What the workflow runs for one commit say. A completed failure wins even
 * while other runs are still going: a failure is a failure. `cancelled`,
 * `skipped`, `neutral` and `stale` are not failures; `action_required` is a
 * run waiting on someone, so it counts as pending.
 */
export function classifyRuns(allRuns: readonly WorkflowRun[]): CiVerdict {
  const runs = allRuns.filter((run) => !IGNORED_RUN_EVENTS.has((run.event ?? '').toLowerCase()));
  if (runs.length === 0) return { outcome: 'none' };
  const failed: FailedCheck[] = [];
  let running = 0;
  let branch: string | undefined;
  let at: string | undefined;
  for (const run of runs) {
    const status = (run.status ?? '').toLowerCase();
    const conclusion = (run.conclusion ?? '').toLowerCase();
    if (status !== 'completed' || conclusion === 'action_required') {
      running += 1;
      continue;
    }
    if (FAILED_CONCLUSIONS.has(conclusion)) {
      failed.push({ name: run.workflowName || run.name || 'workflow', url: run.url ?? '' });
      branch ??= run.headBranch;
      if (run.updatedAt && (!at || run.updatedAt > at)) at = run.updatedAt;
    }
  }
  if (failed.length)
    return {
      outcome: 'failure',
      failed,
      total: runs.length,
      ...(branch !== undefined ? { branch } : {}),
      ...(at !== undefined ? { at } : {}),
    };
  if (running) return { outcome: 'pending', running, total: runs.length };
  return { outcome: 'success', total: runs.length };
}

/** The same verdict from a pull request's check rollup. */
export function classifyRollup(items: readonly RollupItem[]): CiVerdict {
  if (items.length === 0) return { outcome: 'none' };
  const failed: FailedCheck[] = [];
  let running = 0;
  let at: string | undefined;
  for (const item of items) {
    const isStatusContext = item.__typename === 'StatusContext' || item.state !== undefined;
    if (isStatusContext) {
      const state = (item.state ?? '').toUpperCase();
      if (state === 'FAILURE' || state === 'ERROR')
        failed.push({ name: item.context ?? 'status', url: item.targetUrl ?? '' });
      else if (state !== 'SUCCESS') running += 1;
      continue;
    }
    const status = (item.status ?? '').toUpperCase();
    const conclusion = (item.conclusion ?? '').toUpperCase();
    if (status !== 'COMPLETED' || conclusion === 'ACTION_REQUIRED') {
      running += 1;
      continue;
    }
    if (FAILED_CONCLUSIONS.has(conclusion.toLowerCase())) {
      failed.push({
        name: item.workflowName
          ? `${item.workflowName} / ${item.name ?? 'job'}`
          : (item.name ?? 'check'),
        url: item.detailsUrl ?? '',
      });
      if (item.completedAt && (!at || item.completedAt > at)) at = item.completedAt;
    }
  }
  if (failed.length)
    return { outcome: 'failure', failed, total: items.length, ...(at !== undefined ? { at } : {}) };
  if (running) return { outcome: 'pending', running, total: items.length };
  return { outcome: 'success', total: items.length };
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export type MergeTarget = {
  repository: string;
  number: number;
  title: string;
  mergeSha: string;
  mergedAt?: string;
  /** The outcomes file the merge was read from, for the evidence list. */
  file: string;
};

export type PullRequestTarget = {
  repository: string;
  number: number;
  title: string;
  headSha: string;
  headBranch: string;
  url: string;
  updatedAt?: string;
};

type Failure = Extract<CiVerdict, { outcome: 'failure' }>;

const shortName = (repository: string): string => repository.split('/')[1] ?? repository;
const shortSha = (sha: string): string => sha.slice(0, 8);
const nameList = (failed: readonly FailedCheck[]): string =>
  failed.map((check) => check.name).join(', ');
const runLinks = (failed: readonly FailedCheck[]): string[] =>
  failed.filter((check) => check.url).map((check) => `run: ${check.url}`);

export function mergeDedupeKey(repository: string, mergeSha: string): string {
  return `ci-watch:merge:${repository}@${mergeSha}`;
}

export function pullRequestDedupeKey(repository: string, number: number, headSha: string): string {
  return `ci-watch:pr:${repository}#${number}@${headSha}`;
}

export function postMergeEscalation(
  target: MergeTarget,
  verdict: Failure,
  occurredAt: string,
): Escalation {
  const branch = verdict.branch ?? 'the default branch';
  const ref = `${target.repository}#${target.number}`;
  return {
    kind: 'ci.post_merge_failed',
    severity: 'warn',
    title: `CI failed on ${shortName(target.repository)} ${branch} after Tier 0 merge of #${target.number}`,
    what: `${verdict.failed.length} of ${verdict.total} workflow runs on ${branch} at ${shortSha(target.mergeSha)} failed after Tier 0 squash-merged ${ref} (${target.title}): ${nameList(verdict.failed)}. Tier 0's own checks passed before the merge, so either the workflow covers more than the local checks or the bump interacts with something merged since.`,
    project: target.repository,
    task: `PR #${target.number}: ${target.title}`,
    options: [
      {
        label: 'Open the failing run and read the job log',
        consequence: 'Nothing changes; the branch stays as merged until you decide.',
      },
      {
        label: `Open a revert of ${shortSha(target.mergeSha)} on GitHub`,
        consequence:
          'A revert PR restores the previous version once merged; Dependabot re-opens the bump later.',
      },
      {
        label: 'Re-run the failed jobs',
        consequence:
          'Settles a flaky run. If it fails again the failure is real and this message is not repeated for the same merge.',
      },
    ],
    recommendation:
      'Read the run first. A revert is one click and restores the previous version; re-run only if the log looks like infrastructure rather than the change.',
    evidence: [
      ...runLinks(verdict.failed),
      `merge commit ${target.mergeSha}`,
      `${ref}${target.mergedAt ? ` merged ${target.mergedAt}` : ''}`,
      `outcomes file ${target.file}`,
    ],
    paused: false,
    dedupeKey: mergeDedupeKey(target.repository, target.mergeSha),
    occurredAt,
  };
}

export function systemPullRequestEscalation(
  target: PullRequestTarget,
  verdict: Failure,
  occurredAt: string,
): Escalation {
  const ref = `${target.repository}#${target.number}`;
  return {
    kind: 'ci.system_pr_failed',
    severity: 'warn',
    title: `CI failed on ${shortName(target.repository)} PR #${target.number} opened by TheForge`,
    what: `${verdict.failed.length} of ${verdict.total} checks failed on ${ref} (${target.title}) at head ${shortSha(target.headSha)} on ${target.headBranch}: ${nameList(verdict.failed)}. The pipeline's own verification passed before the branch was pushed; the repository's workflow disagrees.`,
    project: target.repository,
    task: `PR #${target.number}: ${target.title}`,
    options: [
      {
        label: 'Open the failing check and read the log',
        consequence: 'Nothing changes; the draft PR stays open.',
      },
      {
        label: 'Close the pull request',
        consequence: 'The branch stays on GitHub; a new run would open a new PR.',
      },
      {
        label: 'Fix it on the branch by hand',
        consequence:
          'A new head SHA is watched afresh and a repeat failure produces one new message.',
      },
    ],
    recommendation:
      'Read the check first; a draft PR blocks nothing, so there is no hurry beyond knowing.',
    evidence: [
      ...runLinks(verdict.failed),
      `${ref} ${target.url}`,
      `head ${target.headSha} on ${target.headBranch}`,
    ],
    paused: false,
    dedupeKey: pullRequestDedupeKey(target.repository, target.number, target.headSha),
    occurredAt,
  };
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export type CiMarker = {
  outcome: 'success' | 'failure' | 'none';
  checkedAt: string;
  runUrl?: string;
  /** For a failure: whether the escalation went out (a dry run records nothing). */
  notified?: boolean;
  detail?: string;
};

export type CiWatchState = {
  version: 1;
  /** `<repository>@<merge sha>` -> marker. */
  merges: Record<string, CiMarker>;
  /** `<repository>#<number>@<head sha>` -> marker. */
  pullRequests: Record<string, CiMarker>;
  /**
   * `<repository>#<number>` -> merge commit learned from GitHub for an
   * outcomes file that predates `mergeSha`, so the lookup happens once, not
   * every half hour for as long as the file is inside the window.
   */
  mergeCommits: Record<string, string>;
};

export const mergeKey = (repository: string, mergeSha: string): string =>
  `${repository}@${mergeSha}`;
export const pullRequestKey = (repository: string, number: number, headSha: string): string =>
  `${repository}#${number}@${headSha}`;

export function statePath(outboxDir: string): string {
  return join(outboxDir, 'ci-watch', 'state.json');
}

const emptyState = (): CiWatchState => ({
  version: 1,
  merges: {},
  pullRequests: {},
  mergeCommits: {},
});

function mergeCommits(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && SHA.test(entry[1]),
    ),
  );
}

function markers(value: unknown): Record<string, CiMarker> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, CiMarker> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const marker = raw as Record<string, unknown>;
    if (
      (marker.outcome !== 'success' && marker.outcome !== 'failure' && marker.outcome !== 'none') ||
      typeof marker.checkedAt !== 'string'
    )
      continue;
    result[key] = {
      outcome: marker.outcome,
      checkedAt: marker.checkedAt,
      ...(typeof marker.runUrl === 'string' ? { runUrl: marker.runUrl } : {}),
      ...(typeof marker.notified === 'boolean' ? { notified: marker.notified } : {}),
      ...(typeof marker.detail === 'string' ? { detail: marker.detail } : {}),
    };
  }
  return result;
}

/**
 * The state file, or an empty state when it does not exist. A malformed file
 * is reported and treated as empty: the worst case is one repeated message,
 * which the notifier's own six-hour dedupe still catches.
 */
export async function readState(path: string): Promise<{ state: CiWatchState; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState() };
    return {
      state: emptyState(),
      warning: `state unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return {
      state: {
        version: 1,
        merges: markers(parsed.merges),
        pullRequests: markers(parsed.pullRequests),
        mergeCommits: mergeCommits(parsed.mergeCommits),
      },
    };
  } catch (error) {
    return {
      state: emptyState(),
      warning: `state malformed, starting empty: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeState(path: string, state: CiWatchState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Drop markers older than the retention so the file stays small. */
export function pruneState(state: CiWatchState, nowMs: number): CiWatchState {
  const keep = (table: Record<string, CiMarker>): Record<string, CiMarker> =>
    Object.fromEntries(
      Object.entries(table).filter(([, marker]) => {
        const at = Date.parse(marker.checkedAt);
        return Number.isNaN(at) || nowMs - at < STATE_RETENTION_MS;
      }),
    );
  return {
    version: 1,
    merges: keep(state.merges),
    pullRequests: keep(state.pullRequests),
    mergeCommits: state.mergeCommits,
  };
}

// ---------------------------------------------------------------------------
// GitHub, through gh
// ---------------------------------------------------------------------------

const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** The workflow runs GitHub has for one commit, whatever branch or event. */
export async function listRunsForCommit(
  repository: string,
  sha: string,
  exec: CommandRunner,
): Promise<WorkflowRun[]> {
  const result = await exec(
    'gh',
    [
      'run',
      'list',
      '-R',
      repository,
      '--commit',
      sha,
      '--limit',
      '50',
      '--json',
      'databaseId,name,workflowName,status,conclusion,url,headBranch,headSha,event,updatedAt',
    ],
    process.cwd(),
  );
  if (result.exitCode !== 0) throw new Error(`gh run list failed: ${clip(result.output)}`);
  const rows = JSON.parse(result.output) as unknown;
  if (!Array.isArray(rows)) throw new Error('gh run list did not return an array');
  return rows as WorkflowRun[];
}

export type SystemPullRequest = PullRequestTarget & { rollup: RollupItem[] };

/** Open pull requests whose head branch carries the system prefix. */
export async function listSystemPullRequests(
  repository: string,
  exec: CommandRunner,
): Promise<SystemPullRequest[]> {
  const result = await exec(
    'gh',
    [
      'pr',
      'list',
      '-R',
      repository,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,headRefName,headRefOid,url,updatedAt,statusCheckRollup',
    ],
    process.cwd(),
  );
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${clip(result.output)}`);
  const rows = JSON.parse(result.output) as unknown;
  if (!Array.isArray(rows)) throw new Error('gh pr list did not return an array');
  const found: SystemPullRequest[] = [];
  for (const raw of rows as Record<string, unknown>[]) {
    const headBranch = typeof raw.headRefName === 'string' ? raw.headRefName : '';
    if (!headBranch.startsWith(SYSTEM_BRANCH_PREFIX)) continue;
    if (typeof raw.number !== 'number' || typeof raw.headRefOid !== 'string') continue;
    found.push({
      repository,
      number: raw.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      headSha: raw.headRefOid,
      headBranch,
      url: typeof raw.url === 'string' ? raw.url : '',
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      rollup: Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as RollupItem[]) : [],
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tier 0 outcomes in the window
// ---------------------------------------------------------------------------

export type MergeCandidate = Omit<MergeTarget, 'mergeSha'> & { mergeSha?: string };

export type CollectedMerges = {
  directory: string;
  files: number;
  merges: MergeCandidate[];
  unreadable: string[];
};

/** Every executed Tier 0 merge in the outcomes files written since `sinceMs`. */
export async function collectMerges(outboxDir: string, sinceMs: number): Promise<CollectedMerges> {
  const directory = join(outboxDir, 'tier0');
  const result: CollectedMerges = { directory, files: 0, merges: [], unreadable: [] };
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    throw error;
  }
  for (const name of names) {
    const writtenAt = outcomeReportTime(name) ?? (await stat(join(directory, name))).mtimeMs;
    if (writtenAt < sinceMs) continue;
    result.files += 1;
    let records;
    try {
      records = parseOutcomeRecords(await readFile(join(directory, name), 'utf8'));
    } catch (error) {
      result.unreadable.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const record of records) {
      if (record.action !== 'merge' || !record.merged || record.mode !== 'execute') continue;
      result.merges.push({
        repository: record.repository,
        number: record.number,
        title: record.title,
        file: name,
        ...(record.mergedAt !== undefined ? { mergedAt: record.mergedAt } : {}),
        ...(record.mergeSha !== undefined ? { mergeSha: record.mergeSha } : {}),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export type CiWatchCommandOptions = {
  /** Process runner for `gh`; defaults to spawning it. */
  exec?: CommandRunner;
  now?: () => Date;
};

export type WatchOutcome =
  'escalated' | 'would-escalate' | 'recorded' | 'pending' | 'known' | 'unknown-sha' | 'error';

export type MergeResult = {
  repository: string;
  number: number;
  mergeSha?: string;
  outcome: WatchOutcome;
  detail: string;
  runUrl?: string;
  delivery?: NotifierReport;
};

export type PullRequestResult = {
  repository: string;
  number: number;
  headSha: string;
  outcome: WatchOutcome;
  detail: string;
  runUrl?: string;
  delivery?: NotifierReport;
};

export type CiWatchReport = {
  dryRun: boolean;
  window: { hours: number; since: string; until: string };
  outboxDir: string;
  statePath: string;
  files: number;
  unreadable: string[];
  repositories: string[];
  merges: MergeResult[];
  pullRequests: PullRequestResult[];
  summary: { escalated: number; recorded: number; pending: number; known: number; errors: number };
};

export function createCiWatchCommand(options: CiWatchCommandOptions = {}): Command {
  const exec = options.exec ?? runCommand;
  const clock = options.now ?? (() => new Date());
  return {
    name: 'ci-watch',
    describe:
      'Escalate CI failures on Tier 0 merges and on pull requests TheForge opened (warn, once per commit)',
    usage: '[--hours=48] [--repo=owner/name,...] [--dry-run] [--json]',
    async run(argv, ctx) {
      const { flags } = parseArgs(argv);
      const fail = (message: string): number => {
        ctx.stderr(`forge ci-watch: ${message}`);
        return 2;
      };
      const rawHours = flags.get('hours');
      const hours = rawHours === undefined ? DEFAULT_HOURS : Number(rawHours);
      if (rawHours === true || !Number.isFinite(hours) || hours <= 0)
        return fail('--hours needs a positive number of hours, e.g. --hours=48');
      const rawRepos = flags.get('repo');
      if (rawRepos === true) return fail('--repo needs owner/name, comma separated');
      const extraRepos = (rawRepos ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      for (const repository of extraRepos)
        if (!REPOSITORY.test(repository)) return fail(`--repo '${repository}' is not owner/name`);
      const dryRun = flags.has('dry-run');
      const json = flags.has('json');

      const now = clock();
      const nowMs = now.getTime();
      const sinceMs = nowMs - hours * 60 * 60 * 1_000;
      const { notifier, config } = createNotifierFromEnv(ctx.env, {
        fetch: ctx.fetch,
        log: (line) => ctx.stderr(line),
        now: () => nowMs,
      });
      const path = statePath(config.outboxDir);
      const lines: string[] = [];
      const say = (line: string) => lines.push(line);

      const { state: loaded, warning } = await readState(path);
      if (warning) ctx.stderr(`forge ci-watch: ${warning}`);
      const state = pruneState(loaded, nowMs);

      let collected: CollectedMerges;
      try {
        collected = await collectMerges(config.outboxDir, sinceMs);
      } catch (error) {
        return fail(
          `cannot read Tier 0 outcomes under ${config.outboxDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const repositories = [
        ...new Set([
          ...DEFAULT_CONFIG.mergeAllowlist,
          ...collected.merges.map((merge) => merge.repository),
          ...extraRepos,
        ]),
      ].sort();

      const report: CiWatchReport = {
        dryRun,
        window: { hours, since: new Date(sinceMs).toISOString(), until: now.toISOString() },
        outboxDir: config.outboxDir,
        statePath: path,
        files: collected.files,
        unreadable: collected.unreadable,
        repositories,
        merges: [],
        pullRequests: [],
        summary: { escalated: 0, recorded: 0, pending: 0, known: 0, errors: 0 },
      };
      let channelFailed = false;
      const checkedAt = now.toISOString();

      const deliver = async (
        escalation: Escalation,
      ): Promise<{ outcome: WatchOutcome; detail: string; delivery?: NotifierReport }> => {
        if (dryRun) {
          report.summary.escalated += 1;
          return { outcome: 'would-escalate', detail: `would send ${escalation.kind}` };
        }
        const delivery = await notifier.notify(escalation);
        if (delivery.outcome === 'failed' || delivery.channels.some((c) => c.status === 'failed'))
          channelFailed = true;
        report.summary.escalated += 1;
        return {
          outcome: 'escalated',
          detail: `${escalation.kind} -> ${formatReport(delivery)}`,
          delivery,
        };
      };

      try {
        for (const candidate of collected.merges) {
          const label = `merge ${candidate.repository}#${candidate.number}`;
          const prKey = `${candidate.repository}#${candidate.number}`;
          let mergeSha = candidate.mergeSha ?? state.mergeCommits[prKey];
          if (!mergeSha || !SHA.test(mergeSha)) {
            // Written before the SHA was recorded (or the lookup failed then).
            try {
              mergeSha = await lookupMergeSha(candidate, exec);
              if (mergeSha) state.mergeCommits[prKey] = mergeSha;
            } catch (error) {
              mergeSha = undefined;
              ctx.stderr(
                `forge ci-watch: ${label}: merge commit lookup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (!mergeSha) {
            report.merges.push({
              repository: candidate.repository,
              number: candidate.number,
              outcome: 'unknown-sha',
              detail: 'merge commit unknown; asked GitHub and got nothing, will ask again',
            });
            report.summary.pending += 1;
            say(`${label}: merge commit unknown, will ask again next run`);
            continue;
          }
          const target: MergeTarget = { ...candidate, mergeSha };
          const key = mergeKey(target.repository, mergeSha);
          const known = state.merges[key];
          const base = { repository: target.repository, number: target.number, mergeSha };
          if (known) {
            report.merges.push({
              ...base,
              outcome: 'known',
              detail: `${known.outcome} recorded ${known.checkedAt}`,
              ...(known.runUrl ? { runUrl: known.runUrl } : {}),
            });
            report.summary.known += 1;
            continue;
          }
          let verdict: CiVerdict;
          try {
            verdict = classifyRuns(await listRunsForCommit(target.repository, mergeSha, exec));
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            report.merges.push({ ...base, outcome: 'error', detail });
            report.summary.errors += 1;
            say(`${label} @ ${shortSha(mergeSha)}: error: ${detail}`);
            continue;
          }
          const short = `${label} @ ${shortSha(mergeSha)}`;
          if (verdict.outcome === 'failure') {
            const escalation = postMergeEscalation(target, verdict, verdict.at ?? checkedAt);
            const sent = await deliver(escalation);
            const runUrl = verdict.failed.find((check) => check.url)?.url;
            if (!dryRun)
              state.merges[key] = {
                outcome: 'failure',
                checkedAt,
                notified: sent.delivery?.outcome === 'sent',
                detail: nameList(verdict.failed),
                ...(runUrl ? { runUrl } : {}),
              };
            report.merges.push({ ...base, ...sent, ...(runUrl ? { runUrl } : {}) });
            say(`${short}: FAILED (${nameList(verdict.failed)}) -> ${sent.detail}`);
          } else if (verdict.outcome === 'success') {
            if (!dryRun) state.merges[key] = { outcome: 'success', checkedAt };
            report.merges.push({
              ...base,
              outcome: 'recorded',
              detail: `success, ${verdict.total} run(s)`,
            });
            report.summary.recorded += 1;
            say(`${short}: success (${verdict.total} run(s)), recorded`);
          } else if (verdict.outcome === 'pending') {
            report.merges.push({
              ...base,
              outcome: 'pending',
              detail: `${verdict.running} of ${verdict.total} run(s) still going`,
            });
            report.summary.pending += 1;
            say(`${short}: pending (${verdict.running} of ${verdict.total} still going)`);
          } else {
            const mergedMs = target.mergedAt ? Date.parse(target.mergedAt) : NaN;
            const stale = !Number.isNaN(mergedMs) && nowMs - mergedMs > NO_RUNS_GRACE_MS;
            if (stale) {
              if (!dryRun)
                state.merges[key] = { outcome: 'none', checkedAt, detail: 'no workflow runs' };
              report.merges.push({ ...base, outcome: 'recorded', detail: 'no workflow runs' });
              report.summary.recorded += 1;
              say(`${short}: no workflow runs after ${NO_RUNS_GRACE_MS / 3_600_000} h, recorded`);
            } else {
              report.merges.push({ ...base, outcome: 'pending', detail: 'no workflow runs yet' });
              report.summary.pending += 1;
              say(`${short}: no workflow runs yet`);
            }
          }
        }

        for (const repository of repositories) {
          let pulls: SystemPullRequest[];
          try {
            pulls = await listSystemPullRequests(repository, exec);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            report.pullRequests.push({
              repository,
              number: 0,
              headSha: '',
              outcome: 'error',
              detail,
            });
            report.summary.errors += 1;
            say(`pr ${repository}: error: ${detail}`);
            continue;
          }
          for (const pull of pulls) {
            const key = pullRequestKey(repository, pull.number, pull.headSha);
            const base = { repository, number: pull.number, headSha: pull.headSha };
            const label = `pr ${repository}#${pull.number} @ ${shortSha(pull.headSha)}`;
            const known = state.pullRequests[key];
            if (known) {
              report.pullRequests.push({
                ...base,
                outcome: 'known',
                detail: `${known.outcome} recorded ${known.checkedAt}`,
                ...(known.runUrl ? { runUrl: known.runUrl } : {}),
              });
              report.summary.known += 1;
              continue;
            }
            const verdict = classifyRollup(pull.rollup);
            if (verdict.outcome === 'failure') {
              const escalation = systemPullRequestEscalation(
                pull,
                verdict,
                verdict.at ?? checkedAt,
              );
              const sent = await deliver(escalation);
              const runUrl = verdict.failed.find((check) => check.url)?.url;
              if (!dryRun)
                state.pullRequests[key] = {
                  outcome: 'failure',
                  checkedAt,
                  notified: sent.delivery?.outcome === 'sent',
                  detail: nameList(verdict.failed),
                  ...(runUrl ? { runUrl } : {}),
                };
              report.pullRequests.push({ ...base, ...sent, ...(runUrl ? { runUrl } : {}) });
              say(`${label}: FAILED (${nameList(verdict.failed)}) -> ${sent.detail}`);
            } else if (verdict.outcome === 'success') {
              if (!dryRun) state.pullRequests[key] = { outcome: 'success', checkedAt };
              report.pullRequests.push({
                ...base,
                outcome: 'recorded',
                detail: `success, ${verdict.total} check(s)`,
              });
              report.summary.recorded += 1;
              say(`${label}: success (${verdict.total} check(s)), recorded`);
            } else if (verdict.outcome === 'pending') {
              report.pullRequests.push({
                ...base,
                outcome: 'pending',
                detail: `${verdict.running} of ${verdict.total} check(s) still going`,
              });
              report.summary.pending += 1;
              say(`${label}: pending (${verdict.running} of ${verdict.total} still going)`);
            } else {
              const updatedMs = pull.updatedAt ? Date.parse(pull.updatedAt) : NaN;
              const stale = !Number.isNaN(updatedMs) && nowMs - updatedMs > NO_RUNS_GRACE_MS;
              if (stale) {
                if (!dryRun)
                  state.pullRequests[key] = { outcome: 'none', checkedAt, detail: 'no checks' };
                report.pullRequests.push({ ...base, outcome: 'recorded', detail: 'no checks' });
                report.summary.recorded += 1;
                say(`${label}: no checks after ${NO_RUNS_GRACE_MS / 3_600_000} h, recorded`);
              } else {
                report.pullRequests.push({ ...base, outcome: 'pending', detail: 'no checks yet' });
                report.summary.pending += 1;
                say(`${label}: no checks yet`);
              }
            }
          }
        }
      } finally {
        await notifier.close();
      }

      if (!dryRun) {
        try {
          await writeState(path, state);
        } catch (error) {
          ctx.stderr(
            `forge ci-watch: state not saved: ${error instanceof Error ? error.message : String(error)}`,
          );
          report.summary.errors += 1;
        }
      }

      if (json) {
        ctx.stdout(JSON.stringify(report));
      } else {
        ctx.stdout(`outbox: ${config.outboxDir}`);
        ctx.stdout(`state: ${path}${dryRun ? ' (dry run: not written)' : ''}`);
        ctx.stdout(
          `window: last ${hours} h (since ${report.window.since}); ${collected.files} outcome file(s), ${collected.merges.length} Tier 0 merge(s); repositories: ${repositories.join(', ')}`,
        );
        for (const item of collected.unreadable) ctx.stdout(`unreadable: ${item}`);
        for (const line of lines) ctx.stdout(line);
        const s = report.summary;
        ctx.stdout(
          `${dryRun ? 'dry run: ' : ''}${s.escalated} ${dryRun ? 'would be escalated' : 'escalated'}, ${s.recorded} recorded, ${s.pending} pending, ${s.known} already decided, ${s.errors} error(s)`,
        );
      }
      return report.summary.errors || channelFailed ? 1 : 0;
    },
  };
}

export const ciWatchCommand: Command = createCiWatchCommand();
