import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type PullRequestFacts } from './policy.js';
import { listCandidates, lookupMergeSha, verifyPullRequest, type CommandRunner } from './runner.js';

const pr = (overrides: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  repository: 'example-org/shopfront',
  number: 26,
  author: 'dependabot[bot]',
  title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
  headSha: 'abcdef1234567890abcdef1234567890abcdef12',
  mergeable: true,
  behindBase: false,
  ...overrides,
});

type Call = { command: string; args: string[]; stdin?: string };

const MERGE_SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * A process runner that answers `gh pr view` from `view`, `gh pr merge` and
 * `gh pr comment` from the given exit codes, and everything else (clone,
 * fetch, checkout, install, checks) with success. Records every call.
 */
function fakeExec(options: {
  view?: { exitCode?: number; output: string } | undefined;
  /** Answer to the post-merge `gh pr view --json mergeCommit`; defaults to a SHA. */
  mergeCommit?: { exitCode?: number; output: string } | undefined;
  merge?: number;
  comment?: number;
  checks?: Record<string, number>;
}) {
  const calls: Call[] = [];
  const exec: CommandRunner = async (command, args, _cwd, stdin) => {
    calls.push({ command, args: [...args], ...(stdin !== undefined ? { stdin } : {}) });
    if (
      command === 'gh' &&
      args[0] === 'pr' &&
      args[1] === 'view' &&
      args.includes('mergeCommit')
    ) {
      return {
        exitCode: options.mergeCommit?.exitCode ?? 0,
        output: options.mergeCommit?.output ?? JSON.stringify({ mergeCommit: { oid: MERGE_SHA } }),
      };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return { exitCode: options.view?.exitCode ?? 0, output: options.view?.output ?? '' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      return { exitCode: options.merge ?? 0, output: options.merge ? 'merge failed' : 'merged' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
      return { exitCode: options.comment ?? 0, output: options.comment ? 'comment failed' : 'ok' };
    }
    if (args[0] === 'run') {
      return { exitCode: options.checks?.[args[1] ?? ''] ?? 0, output: 'check output' };
    }
    return { exitCode: 0, output: '' };
  };
  const gh = () =>
    calls.filter((call) => call.command === 'gh').map((call) => call.args.slice(0, 3).join(' '));
  return { exec, calls, gh };
}

const clean = {
  output: JSON.stringify({
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: pr().headSha,
  }),
};

describe('verifyPullRequest merge path', () => {
  it('re-checks mergeability right before merging, then merges and stamps mergedAt', async () => {
    const fake = fakeExec({ view: clean });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
      now: () => Date.parse('2026-09-26T01:00:00Z'),
    });
    expect(outcome.decision.action).toBe('merge');
    expect(outcome.merged).toBe(true);
    expect(outcome.mergedAt).toBe('2026-09-26T01:00:00.000Z');
    expect(outcome.mergeSha).toBe(MERGE_SHA);
    expect(outcome.checks.map((check) => check.name)).toEqual(['install', 'test', 'lint']);
    // The last three GitHub calls: the re-check, the merge, then the merge
    // commit lookup, in that order.
    expect(fake.gh().slice(-3)).toEqual(['pr view 26', 'pr merge 26', 'pr view 26']);
    const view = fake.calls.find((call) => call.args[1] === 'view')!;
    expect(view.args).toEqual([
      'pr',
      'view',
      '26',
      '-R',
      'example-org/shopfront',
      '--json',
      'mergeable,mergeStateStatus,headRefOid',
    ]);
    expect(fake.calls.find((call) => call.args[1] === 'merge')!.args).toEqual([
      'pr',
      'merge',
      '26',
      '-R',
      'example-org/shopfront',
      '--squash',
      '--delete-branch',
    ]);
    expect(fake.calls.at(-1)!.args).toEqual([
      'pr',
      'view',
      '26',
      '-R',
      'example-org/shopfront',
      '--json',
      'mergeCommit',
    ]);
  });

  it('keeps the merge and leaves mergeSha unset when the merge commit cannot be read back', async () => {
    for (const mergeCommit of [
      { exitCode: 1, output: 'HTTP 502' },
      { output: 'not json' },
      { output: JSON.stringify({ mergeCommit: null }) },
      { output: JSON.stringify({ mergeCommit: { oid: 'not a sha' } }) },
    ]) {
      const fake = fakeExec({ view: clean, mergeCommit });
      const outcome = await verifyPullRequest(pr(), {
        repository: 'example-org/shopfront',
        execute: true,
        exec: fake.exec,
        now: () => Date.parse('2026-09-26T01:00:00Z'),
      });
      expect(outcome.merged, mergeCommit.output).toBe(true);
      expect(outcome.mergeSha, mergeCommit.output).toBeUndefined();
      expect('mergeSha' in outcome, mergeCommit.output).toBe(false);
    }
  });

  it('exposes the merge commit lookup for outcome files that predate it', async () => {
    const fake = fakeExec({});
    expect(
      await lookupMergeSha({ repository: 'example-org/shopfront', number: 26 }, fake.exec),
    ).toBe(MERGE_SHA);
    expect(fake.gh()).toEqual(['pr view 26']);
  });

  it('defers instead of merging when the base moved, and asks Dependabot to rebase over stdin', async () => {
    const fake = fakeExec({
      view: {
        output: JSON.stringify({
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          headRefOid: pr().headSha,
        }),
      },
    });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
    });
    expect(outcome.merged).toBe(false);
    expect(outcome.mergedAt).toBeUndefined();
    expect(outcome.decision).toEqual({
      action: 'deferred',
      reason: 'merge state is BEHIND, not CLEAN; the base moved since the checks ran',
      hint: 'Asked Dependabot to rebase ("@dependabot rebase"). Re-run Tier 0 once the new head is pushed; nothing else is needed.',
    });
    expect(fake.gh()).not.toContain('pr merge 26');
    const comment = fake.calls.find((call) => call.args[1] === 'comment')!;
    // The body travels on stdin so no space or @ has to pass the argument guard.
    expect(comment.args).toEqual([
      'pr',
      'comment',
      '26',
      '-R',
      'example-org/shopfront',
      '--body-file',
      '-',
    ]);
    expect(comment.stdin).toBe('@dependabot rebase\n');
  });

  it('defers on a conflict, a moved head, an unparseable answer and a failed re-check', async () => {
    const cases: Array<[string, { exitCode?: number; output: string }, RegExp]> = [
      [
        'conflict',
        {
          output: JSON.stringify({
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
            headRefOid: pr().headSha,
          }),
        },
        /mergeable=CONFLICTING/,
      ],
      [
        'moved head',
        {
          output: JSON.stringify({
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            headRefOid: 'ffffffff00000000ffffffff00000000ffffffff',
          }),
        },
        /head moved from abcdef12 to ffffffff/,
      ],
      ['garbage', { output: 'not json' }, /could not parse/],
      [
        'gh failure',
        { exitCode: 1, output: 'HTTP 502' },
        /could not re-check mergeability: HTTP 502/,
      ],
    ];
    for (const [label, view, reason] of cases) {
      const fake = fakeExec({ view });
      const outcome = await verifyPullRequest(pr(), {
        repository: 'example-org/shopfront',
        execute: true,
        exec: fake.exec,
      });
      expect(outcome.decision.action, label).toBe('deferred');
      expect(outcome.decision.reason, label).toMatch(reason);
      expect(outcome.merged, label).toBe(false);
      expect(fake.gh(), label).not.toContain('pr merge 26');
    }
  });

  it('accepts HAS_HOOKS as clean', async () => {
    const fake = fakeExec({
      view: {
        output: JSON.stringify({
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'HAS_HOOKS',
          headRefOid: pr().headSha,
        }),
      },
    });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
    });
    expect(outcome.merged).toBe(true);
  });

  it('gates the rebase comment on the configured trusted authors, not on a hard-coded name', async () => {
    const fake = fakeExec({
      view: {
        output: JSON.stringify({
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          headRefOid: pr().headSha,
        }),
      },
    });
    const outcome = await verifyPullRequest(pr({ author: 'renovate[bot]' }), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
      config: { ...DEFAULT_CONFIG, trustedAuthors: ['renovate[bot]'] },
    });
    expect(outcome.decision.action).toBe('deferred');
    expect(fake.gh()).toContain('pr comment 26');
  });

  it('reports a failed rebase comment in the hint rather than pretending it worked', async () => {
    const fake = fakeExec({
      view: {
        output: JSON.stringify({
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          headRefOid: pr().headSha,
        }),
      },
      comment: 1,
    });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
    });
    expect(outcome.decision).toMatchObject({ action: 'deferred' });
    expect((outcome.decision as { hint?: string }).hint).toContain(
      'comment "@dependabot rebase" by hand',
    );
  });

  it('never re-checks or merges in a dry run', async () => {
    const fake = fakeExec({ view: clean });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      exec: fake.exec,
    });
    expect(outcome.decision.action).toBe('merge');
    expect(outcome.merged).toBe(false);
    expect(fake.gh()).toEqual(['repo clone example-org/shopfront']);
  });

  it('escalates with a non-stale hint when the merge command itself fails', async () => {
    const fake = fakeExec({ view: clean, merge: 1 });
    const outcome = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      execute: true,
      exec: fake.exec,
    });
    expect(outcome.decision).toMatchObject({
      action: 'escalate',
      reason: 'merge command failed: merge failed',
    });
    expect((outcome.decision as { hint?: string }).hint).toContain('not a stale base');
    expect(outcome.merged).toBe(false);
  });

  it('carries the stale-base hint on a preflight escalation and on failed checks after the retry', async () => {
    const behind = await verifyPullRequest(pr({ behindBase: true }), {
      repository: 'example-org/shopfront',
      exec: fakeExec({}).exec,
    });
    expect(behind.decision.action).toBe('escalate');
    expect((behind.decision as { hint?: string }).hint).toMatch(/A rebase may resolve this/);
    expect(behind.attempts).toBe(0);

    const fake = fakeExec({ checks: { lint: 1 } });
    const failed = await verifyPullRequest(pr(), {
      repository: 'example-org/shopfront',
      exec: fake.exec,
    });
    expect(failed.decision.action).toBe('escalate');
    expect(failed.decision.reason).toContain('lint (exit 1)');
    expect((failed.decision as { hint?: string }).hint).toMatch(/A rebase may resolve this/);
    expect(failed.attempts).toBe(2);
    expect(fake.gh().filter((call) => call.startsWith('repo clone'))).toHaveLength(2);
  });
});

describe('listCandidates', () => {
  it('maps the gh JSON into facts', async () => {
    const fake = fakeExec({});
    const exec: CommandRunner = async (command, args, cwd, stdin) => {
      if (args[1] === 'list') {
        return {
          exitCode: 0,
          output: JSON.stringify([
            {
              number: 3,
              title: 't',
              author: { login: 'dependabot[bot]' },
              headRefOid: 'abc',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'BEHIND',
            },
          ]),
        };
      }
      return fake.exec(command, args, cwd, stdin);
    };
    expect(await listCandidates('example-org/shopfront', 5, exec)).toEqual([
      {
        repository: 'example-org/shopfront',
        number: 3,
        author: 'dependabot[bot]',
        title: 't',
        headSha: 'abc',
        mergeable: true,
        behindBase: true,
      },
    ]);
  });
});
