/**
 * Tier 0 runner — the I/O half.
 *
 * Verifies machine-generated dependency pull requests by actually checking them
 * out and running the repository's own checks, then applies the decision from
 * `policy.ts`. No language model is involved at any point; that is the entire
 * reason this exists. The full AI pipeline costs roughly $2.50 per task, and a
 * dependency bump is a package manager command and a test run.
 *
 * GitHub access goes through the `gh` CLI rather than an HTTP client, so this
 * inherits the operator's existing authentication and never handles a token.
 * Every process the runner starts goes through one `CommandRunner`, which the
 * tests replace with a fake so the merge path can be exercised end to end
 * without a network.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decide,
  shouldRetry,
  DEFAULT_CONFIG,
  type CheckResult,
  type Decision,
  type PullRequestFacts,
  type Tier0Config,
} from './policy.js';

const MAX_OUTPUT = 20_000;

export type CommandResult = { exitCode: number; output: string };

/**
 * Runs one process to completion. `stdin`, when given, is written to the child
 * and closed; it exists so a pull request comment body can be passed through
 * `--body-file -` without loosening the argument guard below.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  stdin?: string,
) => Promise<CommandResult>;

export type RunOptions = {
  repository: string;
  /** Check script names to run, in order. */
  checks?: readonly string[];
  config?: Tier0Config;
  /**
   * Whether merges may actually happen. Defaults to false: the runner reports
   * what it would do and changes nothing. Acting requires an explicit opt-in.
   */
  execute?: boolean;
  /** Limit how many pull requests to process. */
  limit?: number;
  onLog?: (line: string) => void;
  /** Process runner; defaults to spawning real processes. */
  exec?: CommandRunner;
  now?: () => number;
};

export type PullRequestOutcome = {
  pullRequest: PullRequestFacts;
  checks: CheckResult[];
  decision: Decision;
  attempts: number;
  merged: boolean;
  /** ISO 8601, present only when `merged` is true. */
  mergedAt?: string;
  /**
   * The squash commit the merge put on the base branch, present when `merged`
   * is true and GitHub answered the post-merge lookup. `forge ci-watch` uses
   * it to find the CI run the merge triggered.
   */
  mergeSha?: string;
  durationMs: number;
};

function truncate(value: string): string {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n…[truncated]` : value;
}

/**
 * Quote a single argument for the Windows command interpreter.
 *
 * Node warns that passing an `args` array together with `shell: true` is unsafe,
 * because the arguments are concatenated rather than escaped. Windows needs a
 * shell for the `.cmd` shims that npm, pnpm, npx and gh install, so the shell
 * cannot simply be dropped. Instead the command line is assembled here, with
 * every argument quoted, and handed over as a single pre-formed string.
 */
function quoteForWindowsShell(value: string): string {
  // Double any backslashes that precede the closing quote, then escape quotes.
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Guard against anything shell-significant reaching a command line.
 *
 * Arguments here are built in code rather than taken from pull request content,
 * but the repository name arrives from the CLI and flows into `gh` invocations.
 * Rejecting it outright is cheaper than reasoning about whether each call site
 * happens to be safe.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9._\-/\\:@=,+]*$/;

export function assertSafeArgument(value: string, label: string): void {
  if (!SAFE_ARGUMENT.test(value)) {
    throw new Error(`Refusing to run: ${label} contains unsupported characters: ${value}`);
  }
}

/**
 * The environment for `gh` and `git` children. `.env` carries a GITHUB_TOKEN scoped
 * to the acceptance fixture (S0.3) for the pipeline's pushes; `gh` prefers GH_TOKEN
 * and GITHUB_TOKEN over its own login, so with either present it cannot see the
 * allowlisted private repositories (BLK-015). Tier 0 and ci-watch must run `gh`
 * as the logged-in operator, so both variables are withheld from the child.
 */
export function commandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const rest: Record<string, string | undefined> = { ...source };
  delete rest.GITHUB_TOKEN;
  delete rest.GH_TOKEN;
  return { ...rest, CI: '1', GIT_TERMINAL_PROMPT: '0' };
}

export const runCommand: CommandRunner = async (command, args, cwd, stdin) => {
  for (const argument of args) assertSafeArgument(argument, 'command argument');
  return new Promise((resolve) => {
    const onWindows = process.platform === 'win32';
    // On Windows pass one fully quoted string and no args array, so nothing is
    // concatenated unescaped. Elsewhere no shell is involved at all.
    const child = onWindows
      ? spawn([command, ...args].map(quoteForWindowsShell).join(' '), {
          cwd,
          shell: true,
          env: commandEnvironment(),
        })
      : spawn(command, [...args], {
          cwd,
          shell: false,
          env: commandEnvironment(),
        });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ exitCode: -1, output: `${output}\n${String(error)}` }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, output: truncate(output) }));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
};

/** Ask GitHub for the open pull requests Tier 0 should consider. */
export async function listCandidates(
  repository: string,
  limit = 50,
  exec: CommandRunner = runCommand,
): Promise<PullRequestFacts[]> {
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
      String(limit),
      '--json',
      'number,title,author,headRefOid,mergeable,mergeStateStatus',
    ],
    process.cwd(),
  );
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${result.output}`);
  const rows = JSON.parse(result.output) as Array<{
    number: number;
    title: string;
    author: { login: string };
    headRefOid: string;
    mergeable: string;
    mergeStateStatus: string;
  }>;
  return rows.map((row) => ({
    repository,
    number: row.number,
    author: row.author?.login ?? 'unknown',
    title: row.title,
    headSha: row.headRefOid,
    mergeable: row.mergeable === 'MERGEABLE',
    // BEHIND means the base moved on; checks would not describe the merged result.
    behindBase: row.mergeStateStatus === 'BEHIND',
  }));
}

/** Detect the package manager from whichever lockfile the repository ships. */
function installCommand(directory: string): { command: string; args: string[] } {
  if (existsSync(join(directory, 'pnpm-lock.yaml')))
    return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
  if (existsSync(join(directory, 'yarn.lock')))
    return { command: 'yarn', args: ['install', '--frozen-lockfile'] };
  if (existsSync(join(directory, 'package-lock.json'))) return { command: 'npm', args: ['ci'] };
  return { command: 'npm', args: ['install'] };
}

async function verifyOnce(
  pr: PullRequestFacts,
  checkNames: readonly string[],
  onLog: (line: string) => void,
  exec: CommandRunner,
): Promise<CheckResult[]> {
  const workspace = await mkdtemp(join(tmpdir(), `tier0-${pr.number}-`));
  try {
    onLog(`  checking out #${pr.number} at ${pr.headSha.slice(0, 8)}`);
    const checkout = await exec(
      'gh',
      ['repo', 'clone', pr.repository, workspace, '--', '--depth', '50'],
      process.cwd(),
    );
    if (checkout.exitCode !== 0)
      return [
        {
          name: 'checkout',
          command: 'gh repo clone',
          exitCode: checkout.exitCode,
          output: checkout.output,
        },
      ];

    // Check out the exact head commit the decision will be recorded against,
    // so the evidence and the merge refer to the same code.
    const fetch = await exec('git', ['fetch', 'origin', pr.headSha], workspace);
    if (fetch.exitCode !== 0)
      return [
        {
          name: 'fetch',
          command: `git fetch origin ${pr.headSha}`,
          exitCode: fetch.exitCode,
          output: fetch.output,
        },
      ];
    const checkoutSha = await exec('git', ['checkout', '--detach', pr.headSha], workspace);
    if (checkoutSha.exitCode !== 0)
      return [
        {
          name: 'checkout-sha',
          command: `git checkout ${pr.headSha}`,
          exitCode: checkoutSha.exitCode,
          output: checkoutSha.output,
        },
      ];

    const install = installCommand(workspace);
    onLog(`  ${install.command} ${install.args.join(' ')}`);
    const installed = await exec(install.command, install.args, workspace);
    const results: CheckResult[] = [
      {
        name: 'install',
        command: `${install.command} ${install.args.join(' ')}`,
        exitCode: installed.exitCode,
        output: installed.output,
      },
    ];
    if (installed.exitCode !== 0) return results;

    for (const name of checkNames) {
      onLog(`  ${install.command} run ${name}`);
      const checked = await exec(install.command, ['run', name], workspace);
      results.push({
        name,
        command: `${install.command} run ${name}`,
        exitCode: checked.exitCode,
        output: checked.output,
      });
    }
    return results;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * GitHub's merge-state values that mean "merging now produces exactly what was
 * verified". HAS_HOOKS is CLEAN with pre-receive hooks present; UNSTABLE,
 * BLOCKED, BEHIND, DIRTY and UNKNOWN are not.
 */
const CLEAN_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);

/**
 * Re-read mergeability immediately before merging.
 *
 * Observed twice on shopfront: a merge landing between Tier 0's preflight and its
 * own `gh pr merge` made the next pull request's base stale, and GitHub
 * answered "Pull Request has merge conflicts" / "merge commit cannot be
 * cleanly created". Minutes of install and test had passed since the
 * preflight, which is plenty of time for Dependabot's other PRs to move the
 * base. Checking again costs one API call and turns a failed merge into a
 * deliberate deferral.
 */
async function recheckBeforeMerge(
  pr: PullRequestFacts,
  exec: CommandRunner,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const view = await exec(
    'gh',
    [
      'pr',
      'view',
      String(pr.number),
      '-R',
      pr.repository,
      '--json',
      'mergeable,mergeStateStatus,headRefOid',
    ],
    process.cwd(),
  );
  if (view.exitCode !== 0) {
    return { ok: false, reason: `could not re-check mergeability: ${view.output.slice(0, 300)}` };
  }
  let state: { mergeable?: unknown; mergeStateStatus?: unknown; headRefOid?: unknown };
  try {
    state = JSON.parse(view.output) as typeof state;
  } catch {
    return {
      ok: false,
      reason: `could not parse the mergeability re-check: ${view.output.slice(0, 300)}`,
    };
  }
  if (typeof state.headRefOid === 'string' && state.headRefOid !== pr.headSha) {
    return {
      ok: false,
      reason: `the head moved from ${pr.headSha.slice(0, 8)} to ${state.headRefOid.slice(0, 8)} since the checks ran`,
    };
  }
  if (state.mergeable !== 'MERGEABLE') {
    return { ok: false, reason: `GitHub now reports mergeable=${String(state.mergeable)}` };
  }
  if (!CLEAN_MERGE_STATES.has(String(state.mergeStateStatus))) {
    return {
      ok: false,
      reason: `merge state is ${String(state.mergeStateStatus)}, not CLEAN; the base moved since the checks ran`,
    };
  }
  return { ok: true };
}

export async function verifyPullRequest(
  pr: PullRequestFacts,
  options: RunOptions,
): Promise<PullRequestOutcome> {
  const started = Date.now();
  const config = options.config ?? DEFAULT_CONFIG;
  const onLog = options.onLog ?? (() => {});
  const checkNames = options.checks ?? ['test', 'lint'];
  const exec = options.exec ?? runCommand;
  const now = options.now ?? Date.now;

  // Decide once without checks to catch disqualifiers - wrong author, conflict,
  // stale base - before spending minutes on an install and a test run.
  const preflight = decide(
    pr,
    [{ name: 'preflight', command: '', exitCode: 0, output: '' }],
    config,
  );
  if (preflight.action === 'skip' || preflight.action === 'escalate') {
    return {
      pullRequest: pr,
      checks: [],
      decision: preflight,
      attempts: 0,
      merged: false,
      durationMs: Date.now() - started,
    };
  }

  let checks: CheckResult[] = [];
  let attempts = 0;
  let decision: Decision;
  do {
    attempts += 1;
    if (attempts > 1) onLog(`  retrying (attempt ${attempts}) per policy C3`);
    checks = await verifyOnce(pr, checkNames, onLog, exec);
    decision = decide(pr, checks, config);
  } while (decision.action === 'escalate' && shouldRetry(attempts));

  let merged = false;
  let mergedAt: string | undefined;
  let mergeSha: string | undefined;
  if (decision.action === 'merge' && options.execute) {
    const recheck = await recheckBeforeMerge(pr, exec);
    if (!recheck.ok) {
      onLog(`  not merging #${pr.number}: ${recheck.reason}`);
      // Only Dependabot understands the comment, and only trusted authors get
      // this far; the check is kept explicit so a config change cannot make
      // Tier 0 talk to humans' pull requests.
      let hint =
        'Re-run Tier 0 once the pull request has been rebased; the checks will run against the new head.';
      if (config.trustedAuthors.includes(pr.author)) {
        const comment = await exec(
          'gh',
          ['pr', 'comment', String(pr.number), '-R', pr.repository, '--body-file', '-'],
          process.cwd(),
          '@dependabot rebase\n',
        );
        hint =
          comment.exitCode === 0
            ? 'Asked Dependabot to rebase ("@dependabot rebase"). Re-run Tier 0 once the new head is pushed; nothing else is needed.'
            : `Tried to ask Dependabot to rebase but the comment failed (${comment.output.slice(0, 200)}); comment "@dependabot rebase" by hand, then re-run Tier 0.`;
        onLog(
          comment.exitCode === 0
            ? '  asked Dependabot to rebase'
            : '  could not post the rebase comment',
        );
      }
      decision = { action: 'deferred', reason: recheck.reason, hint };
    } else {
      onLog(`  merging #${pr.number}`);
      const result = await exec(
        'gh',
        ['pr', 'merge', String(pr.number), '-R', pr.repository, '--squash', '--delete-branch'],
        process.cwd(),
      );
      merged = result.exitCode === 0;
      if (merged) {
        mergedAt = new Date(now()).toISOString();
        // `gh pr merge` prints nothing machine-readable, so ask for the merge
        // commit separately. A failed lookup leaves mergeSha unset; the merge
        // itself stands, and `forge ci-watch` looks the SHA up again later.
        mergeSha = await lookupMergeSha(pr, exec);
        onLog(
          mergeSha
            ? `  merged as ${mergeSha.slice(0, 8)}`
            : '  merged; the merge commit could not be read back yet',
        );
      } else {
        decision = {
          action: 'escalate',
          reason: `merge command failed: ${result.output.slice(0, 300)}`,
          hint: 'The pre-merge re-check passed, so this is not a stale base. Read the gh output; a branch-protection rule or a GitHub outage is more likely than a fault in the change.',
        };
      }
    }
  }

  return {
    pullRequest: pr,
    checks,
    decision,
    attempts,
    merged,
    ...(mergedAt !== undefined ? { mergedAt } : {}),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    durationMs: Date.now() - started,
  };
}

/**
 * The merge commit GitHub recorded for a pull request, or undefined when the
 * lookup fails or the answer is not a SHA. Shared with `forge ci-watch`, which
 * uses it for outcome files written before the SHA was recorded.
 */
export async function lookupMergeSha(
  pr: Pick<PullRequestFacts, 'repository' | 'number'>,
  exec: CommandRunner = runCommand,
): Promise<string | undefined> {
  const view = await exec(
    'gh',
    ['pr', 'view', String(pr.number), '-R', pr.repository, '--json', 'mergeCommit'],
    process.cwd(),
  );
  if (view.exitCode !== 0) return undefined;
  try {
    const parsed = JSON.parse(view.output) as { mergeCommit?: { oid?: unknown } | null };
    const oid = parsed.mergeCommit?.oid;
    return typeof oid === 'string' && /^[0-9a-f]{7,40}$/i.test(oid) ? oid : undefined;
  } catch {
    return undefined;
  }
}
