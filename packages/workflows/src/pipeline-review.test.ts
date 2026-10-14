import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest, Run } from '@theforge/contracts';
import { runGit } from '@theforge/git-runtime';
import { DEFAULT_TASK_LIMITS } from '@theforge/guardrails';
import type { ProviderAdapter } from '@theforge/providers';
import {
  AutonomousPipeline,
  DEFAULT_STAGE_TIMEOUT_MS,
  REVIEW_DIFF_LIMIT_BYTES,
  type AutonomousPipelineInput,
  type CheckRunner,
  type ReviewFinding,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

type Script = (
  request: ProviderRequest,
  cwd: string,
  call: number,
) => ProviderEvent[] | Promise<ProviderEvent[]>;

/**
 * The scripted adapter and repository harness of pipeline-routing.test.ts,
 * kept local so each pipeline suite owns its fixtures. Providers are told
 * apart by id and answer per role and per call, which lets the reviewer give
 * one verdict on the first round and another on the second.
 */
class ScriptedProvider implements ProviderAdapter {
  readonly capabilities = {
    streaming: true,
    resume: false,
    tools: true,
    structuredOutput: true,
    usage: true,
  };
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: string,
    private readonly script: Script = defaultScript,
  ) {}
  async diagnose() {
    return { available: true, authenticated: true, detail: `${this.id} is scripted` };
  }
  async *run(
    request: ProviderRequest,
    options: { cwd: string; signal?: AbortSignal },
  ): AsyncGenerator<ProviderEvent> {
    this.requests.push(request);
    const call = this.calls(request.role).length;
    for (const event of await this.script(request, options.cwd, call)) yield event;
  }
  calls(role: ProviderRequest['role']) {
    return this.requests.filter((request) => request.role === role);
  }
}

const usage: ProviderEvent = { type: 'usage', inputTokens: 10, outputTokens: 5, usd: 0.5 };
const completed = (text: string): ProviderEvent[] => [
  { type: 'text_delta', text },
  usage,
  { type: 'completed', output: text },
];
const APPROVED = '{"approved": true, "findings": []}';
const verdict = (approved: boolean, findings: ReviewFinding[]) =>
  JSON.stringify({ approved, findings });
/** What the first live run withheld approval over. */
const LOW: ReviewFinding = {
  severity: 'low',
  claim: 'feature.txt hunk 1: import split across two lines',
  action: 'Join the import onto one line',
};
const HIGH: ReviewFinding = {
  severity: 'high',
  claim: 'feature.txt hunk 1: the new branch has no test',
  action: 'Add a test that exercises the new branch',
};

const defaultScript: Script = async (request, cwd) => {
  if (request.role === 'builder') {
    await writeFile(join(cwd, 'feature.txt'), 'built\n');
    return completed('built');
  }
  if (request.role === 'reviewer') return completed(APPROVED);
  return completed(`${request.role} output`);
};

/**
 * A builder that writes different content on each call, so a repair round
 * actually changes the worktree. `defaultScript` writes the same bytes every
 * time, which no longer reaches a second review round.
 */
const repairingBuilder: Script = async (request, cwd, call) => {
  if (request.role === 'builder') {
    await writeFile(join(cwd, 'feature.txt'), `built, round ${call}\n`);
    return completed('built');
  }
  return defaultScript(request, cwd, call);
};

/** Answer the reviewer with one scripted verdict per round; approve once they run out. */
const reviewing =
  (verdicts: string[]): Script =>
  (request, cwd, call) =>
    request.role === 'reviewer'
      ? completed(verdicts[call - 1] ?? APPROVED)
      : defaultScript(request, cwd, call);

const now = '2026-09-26T00:00:00.000Z';
const roles = { planner: 'codex', critic: 'claude', builder: 'codex', reviewer: 'claude' } as const;

type Recorded = { type: string; payload: Record<string, unknown> };

/**
 * A temporary source repository with one commit, and a managed workspace root
 * for the pipeline to clone and branch it into.
 */
async function harness(overrides: Partial<AutonomousPipelineInput>) {
  const root = join(process.cwd(), '.forge', 'test-tmp');
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, 'forge-review-'));
  temporaryDirectories.push(temp);
  const source = join(temp, 'source');
  await mkdir(source);
  await runGit(['init', '-b', 'main'], source);
  await runGit(['config', 'user.email', 'forge@test.invalid'], source);
  await runGit(['config', 'user.name', 'Forge Test'], source);
  await writeFile(join(source, 'base.txt'), 'base\n');
  await runGit(['add', '.'], source);
  await runGit(['commit', '-m', 'base'], source);
  const workspaceRoot = join(temp, 'managed');
  await mkdir(workspaceRoot, { recursive: true });
  const events: Recorded[] = [];
  const run: Run = {
    id: 'run-review',
    projectId: 'p',
    objective: 'Add a feature file',
    constraints: [],
    state: 'executing',
    budget: { maxUsd: 100, maxTokens: 100_000 },
    spent: { usd: 0, tokens: 0 },
    createdAt: now,
    updatedAt: now,
  };
  const input: AutonomousPipelineInput = {
    run,
    repositoryUrl: source,
    projectId: 'p',
    baseRef: 'main',
    branch: 'forge/review',
    checks: [],
    workspaceRoot,
    providers: [],
    providerRoles: roles,
    backoff: { baseMs: 1, maxMs: 2, jitter: 0 },
    onEvent: (type, payload) => {
      events.push({ type, payload });
    },
    ...overrides,
  };
  const of = (type: string) => events.filter((event) => event.type === type).map((e) => e.payload);
  return { input, events, of };
}

describe('AutonomousPipeline install step', () => {
  const INSTALL = [{ executable: 'npm', args: ['ci'] }];
  const CHECKS = [{ executable: 'npm', args: ['run', 'test'] }];
  const TWO_CHECKS = [
    { executable: 'npm', args: ['run', 'lint'] },
    { executable: 'npm', args: ['run', 'test'] },
  ];

  type RecordedStep = { command: string; network: string | undefined; stopOnFailure: boolean };
  type RunnerCall = {
    command: string;
    network: string | undefined;
    steps: RecordedStep[] | undefined;
  };

  /**
   * A runner that behaves the way the worker does: a stepped action runs its
   * steps in order, ends early only at a failing step marked `stopOnFailure`,
   * and reports the FIRST failure's code. A fake that returned a handwritten
   * result instead would pass no matter what the worker really did with the
   * steps it was sent.
   */
  const recordingRunner = (fail?: string) => {
    const calls: RunnerCall[] = [];
    const outcomeOf = (command: string) =>
      command === fail
        ? { command, code: 1, stdout: '', stderr: 'boom' }
        : { command, code: 0, stdout: '', stderr: '' };
    const runner: CheckRunner = async (action) => {
      const command = [action.executable, ...action.args].join(' ');
      calls.push({
        command,
        network: action.network,
        steps: action.steps?.map((step) => ({
          command: [step.executable, ...step.args].join(' '),
          network: step.network,
          stopOnFailure: step.stopOnFailure === true,
        })),
      });
      if (!action.steps) return outcomeOf(command);
      const steps = [];
      for (const step of action.steps) {
        const outcome = outcomeOf([step.executable, ...step.args].join(' '));
        steps.push(outcome);
        if (outcome.code !== 0 && step.stopOnFailure) break;
      }
      const decisive = steps.find((step) => step.code !== 0) ?? steps[steps.length - 1]!;
      return { code: decisive.code, stdout: decisive.stdout, stderr: decisive.stderr, steps };
    };
    return { calls, runner };
  };

  it('sends the install and the checks as one job, with network on the install alone', async () => {
    // Two things at once, and both are the point of the change. One job,
    // because a worker's workspace does not outlive a job - `npm ci` exited 0
    // in a job of its own on 05/10/2026 and the checks still reported 127 in
    // their own fresh copies. And the boundary per step, so the container that
    // reaches the internet fetches packages and runs nothing else, while the
    // one running the project's commands - and whatever the agent wrote - has
    // no network at all.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { calls, runner } = recordingRunner();
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute({
      ...input,
      checks: CHECKS,
      install: INSTALL,
      checkRunner: runner,
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.steps, `${call.command} must carry both commands as steps`).toEqual([
        { command: 'npm ci', network: 'install', stopOnFailure: true },
        { command: 'npm run test', network: undefined, stopOnFailure: false },
      ]);
      // The action's own command repeats the first step, so a log line or an
      // idempotency key still names something that is actually run.
      expect(call.command).toBe('npm ci');
      // And the job asks for no boundary of its own: each step carries its own,
      // so nothing is granted network by a flag that outlives one command.
      expect(call.network).toBeUndefined();
    }
  });

  it('stops at a failed install instead of running checks that cannot work', async () => {
    // On 04/10/2026 `npm ci` failed on DNS and the three checks that needed its
    // output each reported 127, burying the one line that mattered. The
    // stopping now happens in the worker, under the step's `stopOnFailure`.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { calls, runner } = recordingRunner('npm ci');
    const { input } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute({
      ...input,
      checks: CHECKS,
      install: INSTALL,
      checkRunner: runner,
    });

    expect(result.checks).toEqual([{ command: 'npm ci', code: 1, stdout: '', stderr: 'boom' }]);
    // One verification, because the run ends at a failed one.
    expect(calls).toHaveLength(1);
  });

  it('keeps a passing install in the record and runs every check past a failing one', async () => {
    // Two regressions in one. The install's result used to be thrown away when
    // it passed, which is why eleven attempts never showed whether `npm ci`
    // had run at all. And a failing check must not stop the ones after it: the
    // revision loop fixes what it is shown, so a lint failure hiding a test
    // failure costs a whole extra round.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { runner } = recordingRunner('npm run lint');
    const { input } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute({
      ...input,
      checks: TWO_CHECKS,
      install: INSTALL,
      checkRunner: runner,
    });

    expect(result.checks).toEqual([
      { command: 'npm ci', code: 0, stdout: '', stderr: '' },
      { command: 'npm run lint', code: 1, stdout: '', stderr: 'boom' },
      { command: 'npm run test', code: 0, stdout: '', stderr: '' },
    ]);
  });

  it('fetches the dependencies again for the verification after a repair', async () => {
    // Not an optimisation that was missed: each verification is a new job with
    // a new copy of the workspace, so dependencies installed for the first one
    // are not there for the second.
    const claude = new ScriptedProvider('claude', reviewing([verdict(false, [HIGH])]));
    // The repair has to change something, or the run now stops there.
    const codex = new ScriptedProvider('codex', repairingBuilder);
    const { calls, runner } = recordingRunner();
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute({
      ...input,
      checks: CHECKS,
      install: INSTALL,
      checkRunner: runner,
    });

    // Before the review, after the repair, and the final one.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.steps?.[0]?.command, 'every verification installs first').toBe('npm ci');
    }
  });

  it('refuses a verification whose steps never reached the worker', async () => {
    // The #52 lesson as an assertion, and the one that earned its keep: it
    // caught attempt twelve, where every command ran and passed and the
    // completion route's Zod schema removed the evidence on the way back.
    // Without it that run would have looked like a verification that ran one
    // command and passed.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const stripping: CheckRunner = async () => ({ code: 0, stdout: '', stderr: '' });
    const { input } = await harness({ providers: [claude, codex] });
    await expect(
      new AutonomousPipeline().execute({
        ...input,
        checks: CHECKS,
        install: INSTALL,
        checkRunner: stripping,
      }),
    ).rejects.toThrow('the steps did not survive the round trip');
  });

  it('changes nothing for a project that declares no install step', async () => {
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { calls, runner } = recordingRunner();
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute({ ...input, checks: CHECKS, checkRunner: runner });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.network, 'no install declared, so nothing gets network').toBeUndefined();
      expect(call.steps, 'no install declared, so no stepped job').toBeUndefined();
    }
  });
});

describe('AutonomousPipeline stage timeout', () => {
  it('defaults to the same wall clock the per-task limit allows', () => {
    // The assertion that was missing. Five independent limits bounded how long
    // a stage could run on 04/10/2026 - three of them 15 minutes, one 30 - and
    // nothing anywhere held them to each other, so each was discovered one
    // failed run at a time. This fails if either number is changed alone.
    expect(DEFAULT_STAGE_TIMEOUT_MS).toBe(DEFAULT_TASK_LIMITS.maxWallClockMinutes * 60_000);
    expect(DEFAULT_STAGE_TIMEOUT_MS).toBe(1_800_000);
  });

  it('passes the configured timeout to every provider request', () => {
    // Proven through the request the provider actually receives rather than by
    // timing anything, so it is deterministic. A value that is configurable but
    // never reaches the adapter is the `run.constraints` mistake again.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    return harness({ providers: [claude, codex] }).then(async ({ input }) => {
      await new AutonomousPipeline().execute({ ...input, stageTimeoutMs: 123_456 });
      for (const [label, requests] of [
        ['planner', codex.calls('planner')],
        ['critic', claude.calls('critic')],
        ['builder', codex.calls('builder')],
        ['reviewer', claude.calls('reviewer')],
      ] as const) {
        expect(requests.length, `${label} made no request`).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.timeoutMs, `${label} request timeout`).toBe(123_456);
        }
      }
    });
  });

  it('falls back to the default when the caller names none', async () => {
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute(input);
    expect(codex.calls('planner')[0]!.timeoutMs).toBe(DEFAULT_STAGE_TIMEOUT_MS);
  });
});

describe('AutonomousPipeline run constraints', () => {
  const CONSTRAINTS = ['Do not modify src/lib/auth.ts', 'Do not add any dependency'];

  it('puts the run constraints in front of every stage that can break them', async () => {
    // `run.constraints` was accepted by the API, validated, persisted and read
    // back, and until 04/10/2026 not one stage ever saw it - the pipeline
    // contained no reference to the field at all.
    //
    // Found by running a real objective. It carried "Do not modify
    // src/lib/auth.ts" and "if you find a defect, do not fix it, report it",
    // and the revised plan's step 1 was to change that file. The builder then
    // spent nineteen minutes and 3.65M input tokens implementing it. The cost
    // was the symptom; the constraints never arriving was the cause.
    //
    // Asserted across all four roles rather than one, because a constraint
    // delivered to the builder but not the planner still produces a plan that
    // breaks it, and the planner runs twice - the revision is where the scope
    // actually inflated.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute({
      ...input,
      run: { ...input.run, constraints: CONSTRAINTS },
    });

    const prompts: Array<[string, string]> = [
      ['planner (plan)', codex.calls('planner')[0]!.prompt],
      ['planner (revision)', codex.calls('planner')[1]!.prompt],
      ['critic', claude.calls('critic')[0]!.prompt],
      ['builder', codex.calls('builder')[0]!.prompt],
      ['reviewer', claude.calls('reviewer')[0]!.prompt],
    ];
    for (const [label, prompt] of prompts) {
      for (const constraint of CONSTRAINTS) {
        expect(prompt, `${label} prompt is missing: ${constraint}`).toContain(`- ${constraint}`);
      }
    }
  });

  it('leaves every prompt untouched when the run sets no constraints', async () => {
    // The guard against this change altering anything that already worked: a
    // run without constraints must produce byte-identical prompts.
    const run = async (constraints: string[]) => {
      const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
      const codex = new ScriptedProvider('codex');
      const { input } = await harness({ providers: [claude, codex] });
      await new AutonomousPipeline().execute({
        ...input,
        run: { ...input.run, constraints },
      });
      return {
        planner: codex.calls('planner')[0]!.prompt,
        critic: claude.calls('critic')[0]!.prompt,
        builder: codex.calls('builder')[0]!.prompt,
      };
    };
    const none = await run([]);
    // Whitespace-only entries are dropped, so they must behave as none at all
    // rather than rendering an empty bullet.
    const blank = await run(['   ', '']);
    expect(blank.planner).toBe(none.planner);
    expect(blank.critic).toBe(none.critic);
    expect(blank.builder).toBe(none.builder);
    expect(none.planner).not.toContain('CONSTRAINTS');
    expect(none.builder).not.toContain('CONSTRAINTS');
  });
});

describe('AutonomousPipeline review verdicts', () => {
  it('proceeds to commit without a repair round when approval is withheld over a low finding only', async () => {
    const claude = new ScriptedProvider('claude', reviewing([verdict(false, [LOW])]));
    const codex = new ScriptedProvider('codex');
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    // Everything before integration ran: the only thing left is the push gate.
    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toContain('Approve push');
    expect(result.commit).toHaveLength(40);
    expect(claude.calls('reviewer')).toHaveLength(1);
    expect(codex.calls('builder')).toHaveLength(1);
    // The low finding is recorded, and the disagreement with the reviewer's
    // own flag is visible on the event.
    expect(of('review.completed')).toEqual([
      { round: 1, approved: true, approvedByPolicy: true, findings: [LOW] },
    ]);
    const brief = claude.calls('reviewer')[0]!.prompt;
    expect(brief).toContain('- low: style, naming, formatting; never blocks.');
    expect(brief).toContain('Set "approved" to true when there is no high or critical finding.');
    expect(brief).not.toContain('diff truncated');
    expect(brief).not.toContain('CHANGED FILES');
  });

  it('runs exactly one repair, briefed with the blocking findings only, on a high finding', async () => {
    const claude = new ScriptedProvider(
      'claude',
      reviewing([verdict(false, [LOW, HIGH]), APPROVED]),
    );
    // The repair writes something different from the first build, because a
    // repair that leaves the worktree untouched now ends the run - see the test
    // below. Writing the same bytes twice was never a realistic repair.
    const codex = new ScriptedProvider('codex', repairingBuilder);
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(result.commit).toHaveLength(40);
    expect(claude.calls('reviewer')).toHaveLength(2);
    expect(codex.calls('builder')).toHaveLength(2);
    const repair = codex.calls('builder')[1]!.prompt;
    expect(repair).toContain('and nothing else');
    expect(repair).toContain(
      `BLOCKING FINDINGS (1):\n1. [high] ${HIGH.claim}\n   Action: ${HIGH.action}`,
    );
    expect(repair).not.toContain(LOW.claim);
    expect(repair).not.toContain('2. [');
    expect(of('review.completed')).toEqual([
      { round: 1, approved: false, findings: [LOW, HIGH] },
      { round: 2, approved: true, findings: [] },
    ]);
  });

  it('stops when a repair round leaves the worktree unchanged', async () => {
    // Attempt fourteen of the first real objective. The reviewer correctly
    // reported `src/lib/auth.ts` as modified against a constraint forbidding
    // it - the workspace had been checked out CRLF against LF blobs, so every
    // tracked file looked rewritten - and the repair builder had nothing it
    // could do. The two remaining rounds re-reviewed an identical workspace,
    // came back from the job idempotency cache in the same second, and the run
    // blamed three rounds of stubborn findings.
    const claude = new ScriptedProvider('claude', reviewing([verdict(false, [HIGH])]));
    // `defaultScript`'s builder writes the same bytes every call, which is
    // exactly the dead end under test.
    const codex = new ScriptedProvider('codex');
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);

    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toContain('left the worktree unchanged');
    // One review round, not three. The other two would have re-read an
    // identical workspace.
    expect(claude.calls('reviewer')).toHaveLength(1);
    expect(codex.calls('builder')).toHaveLength(2);
    expect(of('review.completed')).toEqual([{ round: 1, approved: false, findings: [HIGH] }]);
    // The findings are still in the record, because they are what the repair
    // was asked to address and the reader needs to judge them.
    expect(result.review).toContain(HIGH.claim);
    expect(result.commit).toBeUndefined();
  });

  it('shows the reviewer the new files, which are the whole of the work', async () => {
    // The sixteenth obstacle of the first real objective, and the worst
    // control failure of the set. `git diff` excludes untracked files, and a
    // builder asked to add tests produces exactly one untracked file and no
    // tracked change - so the reviewer's prompt contained `DIFF:` followed by a
    // blank line, with no hunk anywhere in its 5,707 characters, and it
    // approved. It then cited a file mode it could only have read off its own
    // container's bind mount, which is what "cite the file and the hunk" is
    // meant to prevent.
    //
    // Nothing failed. The run reached its approval gate with a green review
    // that had seen nothing, which is worse than a failure.
    const claude = new ScriptedProvider('claude', reviewing([APPROVED]));
    const codex = new ScriptedProvider('codex');
    const { input } = await harness({ providers: [claude, codex] });
    await new AutonomousPipeline().execute(input);

    const prompt = claude.calls('reviewer')[0]!.prompt;
    // `defaultScript`'s builder writes one new, untracked file.
    expect(prompt).toContain('+++ b/feature.txt');
    expect(prompt).toContain('@@');
    expect(prompt).toContain('+built');
    // And the DIFF section is not the empty one that shipped.
    expect(prompt).not.toMatch(/DIFF:\s*$/);
  });

  it('cuts a diff over the limit and names every changed file for the reviewer', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex', async (request, cwd, call) => {
      if (request.role === 'builder') {
        // A tracked file grown well past the limit: `git diff` shows tracked
        // changes, and 3000 lines of 100 bytes is about 300 KB of hunk.
        await appendFile(join(cwd, 'base.txt'), `${'x'.repeat(99)}\n`.repeat(3000));
        return completed('built');
      }
      return defaultScript(request, cwd, call);
    });
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(of('review.completed')).toEqual([{ round: 1, approved: true, findings: [] }]);
    const brief = claude.calls('reviewer')[0]!.prompt;
    const header = brief.match(
      /^DIFF \(diff truncated: first (\d+) bytes shown, (\d+) more bytes not shown; the file list below is complete\):$/m,
    );
    expect(header).not.toBeNull();
    const shown = Number(header![1]);
    const omitted = Number(header![2]);
    expect(shown).toBeLessThanOrEqual(REVIEW_DIFF_LIMIT_BYTES);
    expect(shown + omitted).toBeGreaterThan(REVIEW_DIFF_LIMIT_BYTES);
    expect(brief).toContain('CHANGED FILES (git diff --stat):');
    expect(brief).toMatch(/base\.txt\s*\|\s*3000 \+/);
    // The brief carries the bounded diff, not the whole one.
    expect(Buffer.byteLength(brief)).toBeLessThan(REVIEW_DIFF_LIMIT_BYTES + 4096);
  });
});
