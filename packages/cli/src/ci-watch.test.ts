import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CommandRunner } from '@theforge/tier0';
import type { CommandContext } from './command.js';
import {
  classifyRollup,
  classifyRuns,
  collectMerges,
  createCiWatchCommand,
  NO_RUNS_GRACE_MS,
  postMergeEscalation,
  pruneState,
  readState,
  STATE_RETENTION_MS,
  statePath,
  systemPullRequestEscalation,
  type CiWatchReport,
  type CiWatchState,
  type RollupItem,
  type WorkflowRun,
} from './commands/ci-watch.js';
import { createRegistry } from './registry.js';

/**
 * `forge ci-watch` against a fake `gh`: Tier 0 outcome files in a temporary
 * outbox, scripted answers for `gh run list --commit`, `gh pr list` and the
 * merge commit lookup, and the file outbox as the only channel. Nothing here
 * touches the network.
 */
const NOW = new Date('2026-09-27T03:00:00.000Z');
const REPO = 'MisterWizzard/shopfront';

const sha = (fill: string): string => fill.repeat(40).slice(0, 40);
const SHA_FAIL = sha('a');
const SHA_OK = sha('b');
const SHA_PENDING = sha('c');
const SHA_OLD = sha('d');
const SHA_STALE = sha('e');
const HEAD_FAIL = sha('1');
const HEAD_OK = sha('2');
const HEAD_HUMAN = sha('3');
const HEAD_NEW = sha('4');

const run = (overrides: Partial<WorkflowRun>): WorkflowRun => ({
  databaseId: 1,
  name: 'CI',
  workflowName: 'CI',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.example/example-org/shopfront/actions/runs/1',
  headBranch: 'main',
  headSha: SHA_OK,
  event: 'push',
  updatedAt: '2026-09-27T02:30:00.000Z',
  ...overrides,
});

const checkRun = (overrides: Partial<RollupItem>): RollupItem => ({
  __typename: 'CheckRun',
  name: 'test',
  workflowName: 'CI',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
  detailsUrl: 'https://github.example/example-org/shopfront/actions/runs/9/job/1',
  completedAt: '2026-09-27T02:45:00.000Z',
  ...overrides,
});

type OutcomeRecord = Record<string, unknown>;

/** A Tier 0 outcome as `pnpm tier0 --execute` writes it today. */
const merge = (overrides: OutcomeRecord = {}): OutcomeRecord => ({
  repository: REPO,
  number: 26,
  title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
  author: 'dependabot[bot]',
  headSha: sha('f'),
  mode: 'execute',
  action: 'merge',
  reason: 'all 2 checks passed',
  checks: [{ name: 'test', command: 'pnpm run test', exitCode: 0 }],
  attempts: 1,
  merged: true,
  mergedAt: '2026-09-27T02:00:00.000Z',
  mergeSha: SHA_OK,
  durationMs: 1000,
  tier0Commit: 'e8f7f47',
  ...overrides,
});

type Call = { args: string[] };

type Answers = {
  runs?: Record<string, WorkflowRun[] | Error>;
  pulls?: Record<string, unknown[] | Error>;
  /** PR number -> merge commit oid; null for "not merged"; absent -> the lookup fails. */
  mergeCommit?: Record<string, string | null>;
};

function fakeGh(answers: Answers) {
  const calls: Call[] = [];
  const exec: CommandRunner = async (command, args) => {
    calls.push({ args: [...args] });
    if (command !== 'gh') return { exitCode: 1, output: `unexpected command ${command}` };
    if (args[0] === 'run' && args[1] === 'list') {
      const commit = args[args.indexOf('--commit') + 1] ?? '';
      const answer = answers.runs?.[commit];
      if (answer instanceof Error) return { exitCode: 1, output: answer.message };
      return { exitCode: 0, output: JSON.stringify(answer ?? []) };
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const repository = args[args.indexOf('-R') + 1] ?? '';
      const answer = answers.pulls?.[repository];
      if (answer instanceof Error) return { exitCode: 1, output: answer.message };
      return { exitCode: 0, output: JSON.stringify(answer ?? []) };
    }
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit')) {
      const oid = answers.mergeCommit?.[args[2] ?? ''];
      if (oid === undefined) return { exitCode: 1, output: 'HTTP 404' };
      return {
        exitCode: 0,
        output: JSON.stringify({ mergeCommit: oid === null ? null : { oid } }),
      };
    }
    return { exitCode: 1, output: `no fake for gh ${args.join(' ')}` };
  };
  const runListCommits = () =>
    calls
      .filter((call) => call.args[0] === 'run' && call.args[1] === 'list')
      .map((call) => call.args[call.args.indexOf('--commit') + 1]);
  const prListRepos = () =>
    calls
      .filter((call) => call.args[0] === 'pr' && call.args[1] === 'list')
      .map((call) => call.args[call.args.indexOf('-R') + 1]);
  return { exec, calls, runListCommits, prListRepos };
}

function harness(env: Record<string, string | undefined>, exec: CommandRunner, now = NOW) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: () => {
      throw new Error('ci-watch must not reach for the network');
    },
  };
  const command = createCiWatchCommand({ exec, now: () => now });
  return {
    out,
    err,
    run: (argv: string[]) => createRegistry([command]).run(['ci-watch', ...argv], ctx),
  };
}

let directory: string;
let outbox: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-ci-watch-'));
  outbox = join(directory, 'outbox');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeOutcomes(name: string, records: OutcomeRecord[]): Promise<void> {
  await mkdir(join(outbox, 'tier0'), { recursive: true });
  await writeFile(join(outbox, 'tier0', name), JSON.stringify(records, null, 2));
}

async function readStateFile(): Promise<CiWatchState> {
  return JSON.parse(await readFile(statePath(outbox), 'utf8')) as CiWatchState;
}

/** The escalation files the file outbox wrote, by kind. */
async function outboxKinds(): Promise<string[]> {
  if (!existsSync(outbox)) return [];
  const days = (await readdir(outbox)).filter((name) => /^\d{8}$/.test(name));
  const kinds: string[] = [];
  for (const day of days) {
    for (const name of await readdir(join(outbox, day))) {
      // <compactTimestamp>-<kind>-<tokenised dedupe key>.md
      const match = /^[0-9TZ.]+-(ci\.[a-z_]+)-ci-watch-/.exec(name);
      if (match && name.endsWith('.md')) kinds.push(match[1]!);
    }
  }
  return kinds.sort();
}

describe('classifyRuns', () => {
  it('says none, pending, success, and failure even while other runs are still going', () => {
    expect(classifyRuns([])).toEqual({ outcome: 'none' });
    expect(classifyRuns([run({ status: 'in_progress', conclusion: '' })])).toEqual({
      outcome: 'pending',
      running: 1,
      total: 1,
    });
    expect(classifyRuns([run({ status: 'queued', conclusion: '' }), run({})])).toMatchObject({
      outcome: 'pending',
      running: 1,
      total: 2,
    });
    expect(classifyRuns([run({}), run({ workflowName: 'Deploy' })])).toEqual({
      outcome: 'success',
      total: 2,
    });
    const verdict = classifyRuns([
      run({ status: 'in_progress', conclusion: '' }),
      run({ conclusion: 'failure', workflowName: 'CI', url: 'https://x/1', headBranch: 'main' }),
      run({ conclusion: 'timed_out', workflowName: 'Lint', url: 'https://x/2' }),
    ]);
    expect(verdict).toEqual({
      outcome: 'failure',
      failed: [
        { name: 'CI', url: 'https://x/1' },
        { name: 'Lint', url: 'https://x/2' },
      ],
      total: 3,
      branch: 'main',
      at: '2026-09-27T02:30:00.000Z',
    });
  });

  it('ignores runs GitHub starts on its own behalf (event dynamic), as seen on shopfront', () => {
    // Real shape from `gh run list --commit c8b2fcf0` on MisterWizzard/shopfront, 27/09/2026.
    const dependabot = run({
      name: 'npm_and_yarn in /. for esbuild - Update #1592487556',
      workflowName: 'Dependabot Updates',
      event: 'dynamic',
      conclusion: 'failure',
      url: 'https://github.example/example-org/shopfront/actions/runs/36201164064',
    });
    expect(classifyRuns([dependabot, run({ event: 'push' })])).toEqual({
      outcome: 'success',
      total: 1,
    });
    expect(classifyRuns([dependabot])).toEqual({ outcome: 'none' });
  });

  it('treats cancelled, skipped and neutral as not failed, and action_required as pending', () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral', 'stale'])
      expect(classifyRuns([run({ conclusion })]), conclusion).toEqual({
        outcome: 'success',
        total: 1,
      });
    expect(classifyRuns([run({ conclusion: 'action_required' })])).toMatchObject({
      outcome: 'pending',
    });
    expect(
      classifyRuns([run({ conclusion: 'startup_failure', name: 'Build', workflowName: '' })]),
    ).toMatchObject({ outcome: 'failure', failed: [{ name: 'Build' }] });
  });
});

describe('classifyRollup', () => {
  it('reads check runs and commit statuses alike', () => {
    expect(classifyRollup([])).toEqual({ outcome: 'none' });
    expect(classifyRollup([checkRun({}), checkRun({ name: 'lint' })])).toEqual({
      outcome: 'success',
      total: 2,
    });
    expect(classifyRollup([checkRun({ status: 'IN_PROGRESS', conclusion: '' })])).toEqual({
      outcome: 'pending',
      running: 1,
      total: 1,
    });
    expect(classifyRollup([checkRun({ conclusion: 'ACTION_REQUIRED' })])).toMatchObject({
      outcome: 'pending',
    });
    expect(
      classifyRollup([
        checkRun({ conclusion: 'FAILURE', detailsUrl: 'https://x/job' }),
        checkRun({ name: 'lint', conclusion: 'CANCELLED' }),
      ]),
    ).toEqual({
      outcome: 'failure',
      failed: [{ name: 'CI / test', url: 'https://x/job' }],
      total: 2,
      at: '2026-09-27T02:45:00.000Z',
    });
    expect(
      classifyRollup([
        { __typename: 'StatusContext', context: 'ci/circle', state: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
      ]),
    ).toEqual({ outcome: 'pending', running: 1, total: 2 });
    expect(
      classifyRollup([
        { __typename: 'StatusContext', context: 'ci/circle', state: 'ERROR', targetUrl: 'u' },
      ]),
    ).toEqual({ outcome: 'failure', failed: [{ name: 'ci/circle', url: 'u' }], total: 1 });
  });
});

describe('escalations', () => {
  const failure = {
    outcome: 'failure' as const,
    failed: [{ name: 'CI', url: 'https://github.example/example-org/shopfront/actions/runs/7' }],
    total: 2,
    branch: 'main',
  };

  it('describes a post-merge failure as a warning keyed on the merge commit', () => {
    const escalation = postMergeEscalation(
      {
        repository: REPO,
        number: 26,
        title: 'chore(deps): bump nanoid',
        mergeSha: SHA_FAIL,
        mergedAt: '2026-09-27T02:00:00.000Z',
        file: '20260927T020000Z.json',
      },
      failure,
      '2026-09-27T02:30:00.000Z',
    );
    expect(escalation).toMatchObject({
      kind: 'ci.post_merge_failed',
      severity: 'warn',
      paused: false,
      project: REPO,
      task: 'PR #26: chore(deps): bump nanoid',
      title: 'CI failed on shopfront main after Tier 0 merge of #26',
      dedupeKey: `ci-watch:merge:${REPO}@${SHA_FAIL}`,
      occurredAt: '2026-09-27T02:30:00.000Z',
    });
    expect(escalation.what).toContain('1 of 2 workflow runs on main at aaaaaaaa failed');
    expect(escalation.evidence).toEqual([
      'run: https://github.example/example-org/shopfront/actions/runs/7',
      `merge commit ${SHA_FAIL}`,
      `${REPO}#26 merged 2026-09-27T02:00:00.000Z`,
      'outcomes file 20260927T020000Z.json',
    ]);
    expect(escalation.options.map((option) => option.label)).toEqual([
      'Open the failing run and read the job log',
      'Open a revert of aaaaaaaa on GitHub',
      'Re-run the failed jobs',
    ]);
  });

  it('describes a system PR failure as a warning keyed on the head', () => {
    const escalation = systemPullRequestEscalation(
      {
        repository: REPO,
        number: 45,
        title: 'Add retry to fetch',
        headSha: HEAD_FAIL,
        headBranch: 'forge/0f0f0f0f',
        url: 'https://github.example/example-org/shopfront/pull/45',
      },
      { ...failure, failed: [{ name: 'CI / test', url: 'https://x/job' }] },
      '2026-09-27T02:45:00.000Z',
    );
    expect(escalation).toMatchObject({
      kind: 'ci.system_pr_failed',
      severity: 'warn',
      title: 'CI failed on shopfront PR #45 opened by TheForge',
      dedupeKey: `ci-watch:pr:${REPO}#45@${HEAD_FAIL}`,
    });
    expect(escalation.what).toContain('at head 11111111 on forge/0f0f0f0f: CI / test');
    expect(escalation.evidence).toEqual([
      'run: https://x/job',
      `${REPO}#45 https://github.example/example-org/shopfront/pull/45`,
      `head ${HEAD_FAIL} on forge/0f0f0f0f`,
    ]);
  });
});

describe('collectMerges', () => {
  it('reads executed merges in the window, old shape included, and skips the rest', async () => {
    await writeOutcomes('20260927T020000Z.json', [
      merge(),
      merge({ number: 27, mergeSha: undefined }),
      merge({ number: 28, mode: 'dry-run' }),
      merge({ number: 29, action: 'escalate', merged: false, mergeSha: undefined }),
      merge({ number: 30, action: 'verify-only', merged: false, mergeSha: undefined }),
    ]);
    // Two days old: outside a 48 h window from NOW.
    await writeOutcomes('20260925T010000Z.json', [merge({ number: 20, mergeSha: SHA_STALE })]);
    await writeOutcomes('broken.json', [{ nope: true }]);
    const collected = await collectMerges(outbox, NOW.getTime() - 48 * 3_600_000);
    expect(collected.files).toBe(2);
    expect(collected.merges).toEqual([
      {
        repository: REPO,
        number: 26,
        title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
        file: '20260927T020000Z.json',
        mergedAt: '2026-09-27T02:00:00.000Z',
        mergeSha: SHA_OK,
      },
      expect.objectContaining({ number: 27 }),
    ]);
    expect('mergeSha' in collected.merges[1]!).toBe(false);
    expect(collected.unreadable).toEqual([
      expect.stringMatching(/^broken\.json: outcome\[0\]\.action must be a string/),
    ]);
  });

  it('is empty without a tier0 folder', async () => {
    expect(await collectMerges(outbox, 0)).toEqual({
      directory: join(outbox, 'tier0'),
      files: 0,
      merges: [],
      unreadable: [],
    });
  });
});

describe('state file', () => {
  it('starts empty, survives a malformed file, and prunes old markers', async () => {
    const path = statePath(outbox);
    expect(await readState(path)).toEqual({
      state: { version: 1, merges: {}, pullRequests: {}, mergeCommits: {} },
    });
    await mkdir(join(outbox, 'ci-watch'), { recursive: true });
    await writeFile(path, '{not json');
    const malformed = await readState(path);
    expect(malformed.state.merges).toEqual({});
    expect(malformed.warning).toMatch(/^state malformed, starting empty/);
    await writeFile(
      path,
      JSON.stringify({
        merges: {
          good: { outcome: 'success', checkedAt: '2026-09-27T00:00:00.000Z', junk: 1 },
          bad: { outcome: 'maybe', checkedAt: '2026-09-27T00:00:00.000Z' },
          older: { outcome: 'none', checkedAt: '2026-08-01T00:00:00.000Z' },
        },
        pullRequests: 'nope',
      }),
    );
    const { state } = await readState(path);
    expect(Object.keys(state.merges)).toEqual(['good', 'older']);
    expect(state.merges.good).toEqual({
      outcome: 'success',
      checkedAt: '2026-09-27T00:00:00.000Z',
    });
    const pruned = pruneState(state, NOW.getTime());
    expect(Object.keys(pruned.merges)).toEqual(['good']);
    expect(NOW.getTime() - Date.parse('2026-08-01T00:00:00.000Z')).toBeGreaterThan(
      STATE_RETENTION_MS,
    );
  });
});

describe('forge ci-watch', () => {
  const systemPull = (overrides: Record<string, unknown> = {}) => ({
    number: 45,
    title: 'Add retry to fetch',
    headRefName: 'forge/0f0f0f0f',
    headRefOid: HEAD_FAIL,
    url: 'https://github.example/example-org/shopfront/pull/45',
    updatedAt: '2026-09-27T02:40:00.000Z',
    statusCheckRollup: [checkRun({ conclusion: 'FAILURE' })],
    ...overrides,
  });

  const answers = (): Answers => ({
    runs: {
      [SHA_FAIL]: [
        run({ headSha: SHA_FAIL, conclusion: 'failure', url: 'https://x/runs/1' }),
        run({ headSha: SHA_FAIL, workflowName: 'Deploy', status: 'in_progress', conclusion: '' }),
      ],
      [SHA_OK]: [run({})],
      [SHA_PENDING]: [run({ headSha: SHA_PENDING, status: 'queued', conclusion: '' })],
      [SHA_OLD]: [run({ headSha: SHA_OLD })],
      [SHA_STALE]: [run({ headSha: SHA_STALE, conclusion: 'failure' })],
    },
    pulls: {
      [REPO]: [
        systemPull(),
        systemPull({
          number: 46,
          headRefName: 'forge/1e1e1e1e',
          headRefOid: HEAD_OK,
          statusCheckRollup: [checkRun({})],
        }),
        // A human's PR, failing: not the system's, never mentioned.
        systemPull({ number: 47, headRefName: 'fix/typo', headRefOid: HEAD_HUMAN }),
      ],
    },
    mergeCommit: { '29': SHA_OLD },
  });

  async function seed(): Promise<void> {
    await writeOutcomes('20260927T020000Z.json', [
      merge({ number: 26, mergeSha: SHA_FAIL }),
      merge({ number: 27, mergeSha: SHA_OK }),
      merge({ number: 28, mergeSha: SHA_PENDING }),
      merge({ number: 29, mergeSha: undefined }),
      merge({ number: 30, mode: 'dry-run', mergeSha: undefined }),
      merge({ number: 31, action: 'escalate', merged: false, mergeSha: undefined }),
    ]);
    // Outside the window: its failing run must never be asked for.
    await writeOutcomes('20260924T010000Z.json', [merge({ number: 20, mergeSha: SHA_STALE })]);
  }

  it('escalates failures once, records successes, leaves pending alone, and is quiet next time', async () => {
    await seed();
    const gh = fakeGh(answers());
    const { run: forge, out, err } = harness({ FORGE_OUTBOX_DIR: outbox }, gh.exec);

    expect(await forge([])).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`outbox: ${outbox}`);
    expect(out[1]).toBe(`state: ${statePath(outbox)}`);
    // The swept repositories are the merge allowlist, in sorted order. Derived
    // rather than restated: adding a repository to policy B4 should not break a
    // test about outcome files and merge counts.
    const swept = [...DEFAULT_CONFIG.mergeAllowlist].sort().join(', ');
    expect(out[2]).toBe(
      `window: last 48 h (since 2026-09-25T03:00:00.000Z); 1 outcome file(s), 4 Tier 0 merge(s); repositories: ${swept}`,
    );
    expect(out.slice(3)).toEqual([
      `merge ${REPO}#26 @ aaaaaaaa: FAILED (CI) -> ci.post_merge_failed -> file sent (attempt 1)`,
      `merge ${REPO}#27 @ bbbbbbbb: success (1 run(s)), recorded`,
      `merge ${REPO}#28 @ cccccccc: pending (1 of 1 still going)`,
      `merge ${REPO}#29 @ dddddddd: success (1 run(s)), recorded`,
      `pr ${REPO}#45 @ 11111111: FAILED (CI / test) -> ci.system_pr_failed -> file sent (attempt 1)`,
      `pr ${REPO}#46 @ 22222222: success (1 check(s)), recorded`,
      '2 escalated, 3 recorded, 1 pending, 0 already decided, 0 error(s)',
    ]);
    // The old-shape record was looked up; the stale file's SHA was never asked for.
    expect(gh.runListCommits()).toEqual([SHA_FAIL, SHA_OK, SHA_PENDING, SHA_OLD]);
    expect(gh.calls.filter((call) => call.args.includes('mergeCommit'))).toHaveLength(1);
    expect(gh.prListRepos()).toEqual([...DEFAULT_CONFIG.mergeAllowlist].sort());
    expect(await outboxKinds()).toEqual(['ci.post_merge_failed', 'ci.system_pr_failed']);

    const state = await readStateFile();
    expect(state).toEqual({
      version: 1,
      merges: {
        [`${REPO}@${SHA_FAIL}`]: {
          outcome: 'failure',
          checkedAt: NOW.toISOString(),
          notified: true,
          detail: 'CI',
          runUrl: 'https://x/runs/1',
        },
        [`${REPO}@${SHA_OK}`]: { outcome: 'success', checkedAt: NOW.toISOString() },
        [`${REPO}@${SHA_OLD}`]: { outcome: 'success', checkedAt: NOW.toISOString() },
      },
      pullRequests: {
        [`${REPO}#45@${HEAD_FAIL}`]: {
          outcome: 'failure',
          checkedAt: NOW.toISOString(),
          notified: true,
          detail: 'CI / test',
          runUrl: 'https://github.example/example-org/shopfront/actions/runs/9/job/1',
        },
        [`${REPO}#46@${HEAD_OK}`]: { outcome: 'success', checkedAt: NOW.toISOString() },
      },
      // The old-shape record's merge commit, learned once and kept.
      mergeCommits: { [`${REPO}#29`]: SHA_OLD },
    });

    // Half an hour later: the pending merge has now failed and PR 46 has a new
    // head that fails too. Exactly those two are new; everything else is known.
    const later = new Date(NOW.getTime() + 30 * 60_000);
    const next = answers();
    next.runs![SHA_PENDING] = [run({ headSha: SHA_PENDING, conclusion: 'failure', url: 'u2' })];
    next.pulls![REPO] = [
      systemPull(),
      systemPull({
        number: 46,
        headRefName: 'forge/1e1e1e1e',
        headRefOid: HEAD_NEW,
        statusCheckRollup: [checkRun({ conclusion: 'TIMED_OUT', detailsUrl: 'u3' })],
      }),
    ];
    const gh2 = fakeGh(next);
    const second = harness({ FORGE_OUTBOX_DIR: outbox }, gh2.exec, later);
    expect(await second.run([])).toBe(0);
    expect(second.out.slice(3)).toEqual([
      `merge ${REPO}#28 @ cccccccc: FAILED (CI) -> ci.post_merge_failed -> file sent (attempt 1)`,
      `pr ${REPO}#46 @ 44444444: FAILED (CI / test) -> ci.system_pr_failed -> file sent (attempt 1)`,
      // Known: merges #26, #27, #29 and PR #45; PR #46 moved its head, so it is new.
      '2 escalated, 0 recorded, 0 pending, 4 already decided, 0 error(s)',
    ]);
    expect(gh2.runListCommits()).toEqual([SHA_PENDING]);
    expect(gh2.calls.filter((call) => call.args.includes('mergeCommit'))).toHaveLength(0);
    expect(await outboxKinds()).toEqual([
      'ci.post_merge_failed',
      'ci.post_merge_failed',
      'ci.system_pr_failed',
      'ci.system_pr_failed',
    ]);

    // And a third run, nothing new: no GitHub call beyond listing the PRs.
    const third = harness({ FORGE_OUTBOX_DIR: outbox }, fakeGh(next).exec, later);
    expect(await third.run([])).toBe(0);
    expect(third.out.at(-1)).toBe(
      '0 escalated, 0 recorded, 0 pending, 6 already decided, 0 error(s)',
    );
    expect(Object.keys((await readStateFile()).merges)).toHaveLength(4);
  });

  it('--dry-run says what it would send and writes neither state nor outbox', async () => {
    await seed();
    const gh = fakeGh(answers());
    const { run: forge, out } = harness({ FORGE_OUTBOX_DIR: outbox }, gh.exec);
    expect(await forge(['--dry-run'])).toBe(0);
    expect(out[1]).toBe(`state: ${statePath(outbox)} (dry run: not written)`);
    expect(out).toContain(
      `merge ${REPO}#26 @ aaaaaaaa: FAILED (CI) -> would send ci.post_merge_failed`,
    );
    expect(out).toContain(
      `pr ${REPO}#45 @ 11111111: FAILED (CI / test) -> would send ci.system_pr_failed`,
    );
    expect(out.at(-1)).toBe(
      'dry run: 2 would be escalated, 3 recorded, 1 pending, 0 already decided, 0 error(s)',
    );
    expect(existsSync(statePath(outbox))).toBe(false);
    expect(await outboxKinds()).toEqual([]);
    expect(existsSync(join(outbox, 'dedupe-index.json'))).toBe(false);
  });

  it('--json prints one report document', async () => {
    await seed();
    const { run: forge, out } = harness({ FORGE_OUTBOX_DIR: outbox }, fakeGh(answers()).exec);
    expect(await forge(['--json', '--hours=24'])).toBe(0);
    expect(out).toHaveLength(1);
    const report = JSON.parse(out[0]!) as CiWatchReport;
    expect(report).toMatchObject({
      dryRun: false,
      window: { hours: 24, since: '2026-09-26T03:00:00.000Z', until: NOW.toISOString() },
      outboxDir: outbox,
      statePath: statePath(outbox),
      files: 1,
      unreadable: [],
      repositories: [...DEFAULT_CONFIG.mergeAllowlist].sort(),
      summary: { escalated: 2, recorded: 3, pending: 1, known: 0, errors: 0 },
    });
    expect(report.merges.map((item) => [item.number, item.outcome])).toEqual([
      [26, 'escalated'],
      [27, 'recorded'],
      [28, 'pending'],
      [29, 'recorded'],
    ]);
    expect(report.merges[0]!.delivery?.outcome).toBe('sent');
    expect(report.pullRequests.map((item) => [item.number, item.outcome])).toEqual([
      [45, 'escalated'],
      [46, 'recorded'],
    ]);
  });

  it('reports a gh failure, keeps going, and exits 1', async () => {
    await seed();
    const broken = answers();
    broken.runs![SHA_OK] = new Error('gh: HTTP 502 Bad Gateway');
    broken.pulls![REPO] = new Error('gh: not logged in');
    const { run: forge, out } = harness({ FORGE_OUTBOX_DIR: outbox }, fakeGh(broken).exec);
    expect(await forge([])).toBe(1);
    expect(out).toContain(
      `merge ${REPO}#27 @ bbbbbbbb: error: gh run list failed: gh: HTTP 502 Bad Gateway`,
    );
    expect(out).toContain(`pr ${REPO}: error: gh pr list failed: gh: not logged in`);
    expect(out.at(-1)).toBe('1 escalated, 1 recorded, 1 pending, 0 already decided, 2 error(s)');
    // The failure that could be read was still escalated and remembered.
    const state = await readStateFile();
    expect(Object.keys(state.merges).sort()).toEqual([`${REPO}@${SHA_FAIL}`, `${REPO}@${SHA_OLD}`]);
  });

  it('asks again for a merge commit it cannot learn, and records a merge with no runs after the grace', async () => {
    await writeOutcomes('20260927T020000Z.json', [
      merge({ number: 29, mergeSha: undefined }),
      // Merged well over six hours ago and GitHub has no run for it: recorded as none.
      merge({ number: 32, mergeSha: sha('9'), mergedAt: '2026-09-26T10:00:00.000Z' }),
      // Merged just now with no run yet: pending.
      merge({ number: 33, mergeSha: sha('8'), mergedAt: '2026-09-27T02:58:00.000Z' }),
    ]);
    const gh = fakeGh({ mergeCommit: { '29': null } });
    const { run: forge, out } = harness({ FORGE_OUTBOX_DIR: outbox }, gh.exec);
    expect(await forge([])).toBe(0);
    expect(out.slice(3)).toEqual([
      `merge ${REPO}#29: merge commit unknown, will ask again next run`,
      `merge ${REPO}#32 @ 99999999: no workflow runs after ${NO_RUNS_GRACE_MS / 3_600_000} h, recorded`,
      `merge ${REPO}#33 @ 88888888: no workflow runs yet`,
      '0 escalated, 1 recorded, 2 pending, 0 already decided, 0 error(s)',
    ]);
    expect((await readStateFile()).merges).toEqual({
      [`${REPO}@${sha('9')}`]: {
        outcome: 'none',
        checkedAt: NOW.toISOString(),
        detail: 'no workflow runs',
      },
    });
    // Next run asks for #29 again and, once GitHub knows the SHA, decides it.
    const gh2 = fakeGh({ mergeCommit: { '29': SHA_OLD }, runs: { [SHA_OLD]: [run({})] } });
    const second = harness({ FORGE_OUTBOX_DIR: outbox }, gh2.exec);
    expect(await second.run([])).toBe(0);
    expect(second.out).toContain(`merge ${REPO}#29 @ dddddddd: success (1 run(s)), recorded`);
  });

  it('adds --repo repositories to the pull request sweep, and validates its flags', async () => {
    const gh = fakeGh({
      pulls: {
        'MisterWizzard/other': [
          systemPull({ number: 3, headRefName: 'forge/abababab', headRefOid: HEAD_FAIL }),
        ],
      },
    });
    const { run: forge, out, err } = harness({ FORGE_OUTBOX_DIR: outbox }, gh.exec);
    expect(await forge(['--repo=MisterWizzard/other'])).toBe(0);
    // Repositories are swept in sorted order: the allowlist plus --repo.
    expect(gh.prListRepos()).toEqual(
      [...DEFAULT_CONFIG.mergeAllowlist, 'MisterWizzard/other'].sort(),
    );
    expect(out).toContain(
      'pr MisterWizzard/other#3 @ 11111111: FAILED (CI / test) -> ci.system_pr_failed -> file sent (attempt 1)',
    );

    expect(await forge(['--hours=0'])).toBe(2);
    expect(err.at(-1)).toContain('--hours needs a positive number');
    expect(await forge(['--hours'])).toBe(2);
    expect(await forge(['--repo'])).toBe(2);
    expect(err.at(-1)).toContain('--repo needs owner/name');
    expect(await forge(['--repo=not a repo'])).toBe(2);
    expect(err.at(-1)).toContain("--repo 'not a repo' is not owner/name");
  });
});
