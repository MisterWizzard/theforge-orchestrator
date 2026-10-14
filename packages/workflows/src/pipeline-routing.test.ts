import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest, Run } from '@theforge/contracts';
import { runGit } from '@theforge/git-runtime';
import type { ProviderAdapter } from '@theforge/providers';
import { AutonomousPipeline, type AutonomousPipelineInput } from './index.js';

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
 * FakeProvider has a fixed id and one script. Routing is about which of
 * several adapters is called, so these are told apart by id and answer per
 * role and per call, which lets a script fail the first attempt and pass the
 * second.
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
    private readonly available = true,
  ) {}
  async diagnose() {
    return {
      available: this.available,
      authenticated: this.available,
      detail: `${this.id} is scripted`,
    };
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
const failure = (code: string, retryable: boolean): ProviderEvent[] => [
  usage,
  { type: 'error', code, message: `${code} from the fake`, retryable },
];
const APPROVED = '{"approved": true, "findings": []}';

const defaultScript: Script = async (request, cwd) => {
  if (request.role === 'builder') {
    await writeFile(join(cwd, 'feature.txt'), 'built\n');
    return completed('built');
  }
  if (request.role === 'reviewer') return completed(APPROVED);
  return completed(`${request.role} output`);
};

/** What a local model records: tokens and no dollars, as the real adapter reports. */
const freeScript: Script = (request) => [
  { type: 'text_delta', text: `${request.role} output` },
  { type: 'usage', inputTokens: 10, outputTokens: 5, usd: 0 },
  { type: 'completed', output: `${request.role} output` },
];

/** Fail the first call for one role, then behave. */
const failingFirst =
  (role: ProviderRequest['role'], code: string, retryable: boolean, times = 1): Script =>
  (request, cwd, call) =>
    request.role === role && call <= times
      ? failure(code, retryable)
      : defaultScript(request, cwd, call);

const now = '2026-09-26T00:00:00.000Z';
const roles = { planner: 'codex', critic: 'claude', builder: 'codex', reviewer: 'claude' } as const;
/** Usage that puts today over the default $20 ceiling, whatever zone counts the day. */
const overCeiling = () => [{ at: new Date().toISOString(), usd: 25, tokens: 0 }];
const modelOf = (request: ProviderRequest) => (request as { model?: string }).model;

type Recorded = { type: string; payload: Record<string, unknown> };

/**
 * A temporary source repository with one commit, and a managed workspace root
 * for the pipeline to clone and branch it into, as packages/git-runtime tests
 * do. Everything else about the input is a test's own business.
 */
async function harness(overrides: Partial<AutonomousPipelineInput>) {
  const root = join(process.cwd(), '.forge', 'test-tmp');
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, 'forge-routing-'));
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
    id: 'run-routing',
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
    branch: 'forge/routing',
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
  const indexOf = (type: string, nth = 0) =>
    events.findIndex((event, index) => event.type === type && index >= nth);
  return { input, events, of, indexOf };
}

describe('AutonomousPipeline routing', () => {
  it('routes every stage to its configured cloud provider by default', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex');
    const ollama = new ScriptedProvider('ollama');
    const { input, of, indexOf } = await harness({ providers: [claude, codex, ollama] });
    const result = await new AutonomousPipeline().execute(input);
    // Everything before integration ran: the only thing left is the push gate.
    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toContain('Approve push');
    expect(result.classification).toBeUndefined();
    expect(result.commit).toHaveLength(40);
    const decided = of('routing.decided');
    expect(decided.map((d) => [d.role, d.providerId])).toEqual([
      ['planner', 'codex'],
      ['critic', 'claude'],
      ['planner', 'codex'],
      ['builder', 'codex'],
      ['reviewer', 'claude'],
    ]);
    for (const decision of decided) {
      expect(decision).toMatchObject({
        tier: 3,
        tierName: 'cloud',
        model: null,
        ceilingApplied: false,
        requiresLoad: false,
        estimatedLoadSeconds: 0,
        priorFailures: 0,
        allowed: true,
      });
    }
    // The decision is announced before the provider is called.
    expect(indexOf('routing.decided')).toBeLessThan(indexOf('usage.recorded'));
    expect(ollama.requests).toHaveLength(0);
    // A cloud stage puts no model on the request and none on its usage.
    expect([...codex.requests, ...claude.requests].every((r) => modelOf(r) === undefined)).toBe(
      true,
    );
    expect(of('usage.recorded').every((u) => !('model' in u))).toBe(true);
    expect(of('provider.fallback')).toHaveLength(0);
    expect(of('provider.retry')).toHaveLength(0);
  });

  it('sends the planner and the critic to devstral under the ceiling and stops at the builder', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex');
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({
      providers: [claude, codex, ollama],
      usageSource: overCeiling,
      timeZone: 'Australia/Sydney',
      residency: async () => ({ loadedModels: ['qwen3:8b'] }),
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.status).toBe('partially_completed');
    expect(result.classification).toBe('safety_constraint');
    expect(result.blocker).toContain(
      'builder must not run locally; stopping the run at the ceiling',
    );
    // What was produced before the stop is kept for the resume.
    expect(result.plan).toBe('planner output');
    expect(result.critique).toBe('critic output');
    const decided = of('routing.decided');
    expect(decided.map((d) => [d.role, d.providerId, d.tier])).toEqual([
      ['planner', 'ollama', 2],
      ['critic', 'ollama', 2],
      ['planner', 'ollama', 2],
      ['builder', null, 2],
    ]);
    expect(decided[0]).toMatchObject({
      workClass: 'architecture',
      tierName: 'local-coding',
      model: 'devstral-small-2:latest',
      ceilingApplied: true,
      requiresLoad: true,
      estimatedLoadSeconds: 10.6,
      allowed: true,
    });
    expect(decided[3]).toMatchObject({ allowed: false, ceilingApplied: true });
    expect(ollama.calls('planner')).toHaveLength(2);
    expect(ollama.calls('critic')).toHaveLength(1);
    expect(ollama.requests.every((r) => modelOf(r) === 'devstral-small-2:latest')).toBe(true);
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(0);
    const recorded = of('usage.recorded');
    expect(recorded).toHaveLength(3);
    for (const record of recorded) {
      expect(record).toMatchObject({ provider: 'ollama', model: 'devstral-small-2:latest' });
    }
    expect(of('build.completed')).toHaveLength(0);
  });

  it('routes to the cloud when the ceiling has room', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex');
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({
      providers: [claude, codex, ollama],
      usageSource: () => [{ at: new Date().toISOString(), usd: 1, tokens: 0 }],
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(of('routing.decided').every((d) => d.tier === 3 && d.ceilingApplied === false)).toBe(
      true,
    );
    expect(ollama.requests).toHaveLength(0);
  });

  it('retries a retryable error on the same provider and then succeeds', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex', failingFirst('planner', 'RATE_LIMIT', true));
    const { input, of, indexOf } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    // The failed attempt, its retry, then the revision stage.
    expect(codex.calls('planner')).toHaveLength(3);
    expect(claude.calls('planner')).toHaveLength(0);
    expect(of('provider.retry')).toEqual([
      expect.objectContaining({
        role: 'planner',
        provider: 'codex',
        code: 'RATE_LIMIT',
        attempt: 1,
      }),
    ]);
    expect(of('provider.fallback')).toHaveLength(0);
    // A retry is not a new decision; the stage announced itself once.
    expect(of('routing.decided').filter((d) => d.role === 'planner')).toHaveLength(2);
    expect(indexOf('provider.retry')).toBeGreaterThan(indexOf('routing.decided'));
  });

  it('falls back after the retries on one provider are exhausted', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex', failingFirst('planner', 'RATE_LIMIT', true, 2));
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    // Two failed attempts on the first planner stage, then the revision stage.
    expect(codex.calls('planner')).toHaveLength(3);
    expect(of('provider.retry')).toHaveLength(1);
    expect(of('provider.fallback')).toEqual([
      expect.objectContaining({
        role: 'planner',
        from: 'codex',
        to: 'claude',
        code: 'RATE_LIMIT',
        attempt: 2,
      }),
    ]);
    // The first planner stage moved to claude; the revision stage started
    // fresh on the configured provider, which had recovered by then.
    expect(claude.calls('planner')).toHaveLength(1);
    expect(of('routing.decided').filter((d) => d.role === 'planner')).toEqual([
      expect.objectContaining({ providerId: 'codex', priorFailures: 0 }),
      expect.objectContaining({ providerId: 'claude', priorFailures: 1 }),
      expect.objectContaining({ providerId: 'codex', priorFailures: 0 }),
    ]);
  });

  it('falls back to the other cloud provider on a non-retryable error', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider(
      'codex',
      failingFirst('planner', 'PROVIDER_CRASH', false, Number.POSITIVE_INFINITY),
    );
    const { input, of, events } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(of('provider.retry')).toHaveLength(0);
    // Both planner stages fail on codex and go to claude.
    expect(of('provider.fallback')).toEqual([
      expect.objectContaining({
        role: 'planner',
        from: 'codex',
        to: 'claude',
        code: 'PROVIDER_CRASH',
        attempt: 1,
      }),
      expect.objectContaining({ role: 'planner', from: 'codex', to: 'claude' }),
    ]);
    expect(claude.calls('planner')).toHaveLength(2);
    expect(codex.calls('builder')).toHaveLength(1);
    // The substitution is announced, then the new decision.
    const fallback = events.findIndex((event) => event.type === 'provider.fallback');
    const redecided = events.findIndex(
      (event, index) =>
        index > fallback && event.type === 'routing.decided' && event.payload.priorFailures === 1,
    );
    expect(redecided).toBeGreaterThan(fallback);
    expect(events[redecided]?.payload).toMatchObject({ providerId: 'claude', allowed: true });
    expect(String(events[redecided]?.payload.reason)).toContain('codex failed this stage');
  });

  it('fails the stage as before when every cloud provider has failed', async () => {
    const crash = failingFirst('planner', 'PROVIDER_CRASH', false, Number.POSITIVE_INFINITY);
    const claude = new ScriptedProvider('claude', crash);
    const codex = new ScriptedProvider('codex', crash);
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({ providers: [claude, codex, ollama] });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'claude: PROVIDER_CRASH: PROVIDER_CRASH from the fake',
    );
    expect(of('provider.fallback')).toHaveLength(1);
    // Under a ceiling with room, ollama is never a fallback for a cloud stage.
    expect(ollama.requests).toHaveLength(0);
  });

  it('does not retry a builder that left partial edits behind', async () => {
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex', async (request, cwd, call) => {
      if (request.role === 'builder' && call === 1) {
        await writeFile(join(cwd, 'half.txt'), 'partial\n');
        return failure('WORKER_LOST', true);
      }
      return defaultScript(request, cwd, call);
    });
    const { input, of } = await harness({ providers: [claude, codex] });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      /WORKER_LOST.*builder left partial edits in the worktree; not retrying/,
    );
    expect(codex.calls('builder')).toHaveLength(1);
    expect(claude.calls('builder')).toHaveLength(0);
    expect(of('provider.retry')).toHaveLength(0);
    expect(of('provider.fallback')).toHaveLength(0);
  });

  it('catches a reviewer that rewrites a file the builder left untracked', async () => {
    // The read-only check compares `git status` and `git diff` before and
    // after, and neither sees the CONTENTS of an untracked file: status says
    // only `?? feature.txt` and diff ignores it. The test above passes because
    // the reviewer adds a new path, which status does show.
    //
    // A reviewer that rewrote the builder's new file in place changed nothing
    // either command reports, so it went straight through - and a new file is
    // exactly what a builder asked to write tests produces, so that was the
    // likeliest way to defeat the guard rather than an exotic one. Found while
    // adding the no-change repair check, which was blind the same way.
    const claude = new ScriptedProvider('claude', async (request, cwd, call) => {
      if (request.role === 'reviewer') {
        // Same path the builder wrote, different contents, nothing added.
        await writeFile(join(cwd, 'feature.txt'), 'rewritten by the reviewer\n');
        return completed(APPROVED);
      }
      return defaultScript(request, cwd, call);
    });
    const codex = new ScriptedProvider('codex');
    const { input } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toBe(
      'Reviewer modified the assigned worktree; review must be read-only.',
    );
    expect(result.commit).toBeUndefined();
  });

  it('keeps the reviewer read-only across a substitution', async () => {
    const claude = new ScriptedProvider(
      'claude',
      failingFirst('reviewer', 'PROVIDER_CRASH', false, Number.POSITIVE_INFINITY),
    );
    const codex = new ScriptedProvider('codex', async (request, cwd, call) => {
      if (request.role === 'reviewer') {
        await writeFile(join(cwd, 'reviewer-touched.txt'), 'oops\n');
        return completed(APPROVED);
      }
      return defaultScript(request, cwd, call);
    });
    const { input, of } = await harness({ providers: [claude, codex] });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toBe(
      'Reviewer modified the assigned worktree; review must be read-only.',
    );
    expect(of('provider.fallback')).toEqual([
      expect.objectContaining({ role: 'reviewer', from: 'claude', to: 'codex' }),
    ]);
  });

  it('neither retries nor substitutes once the run is aborted', async () => {
    const controller = new AbortController();
    const claude = new ScriptedProvider('claude');
    const codex = new ScriptedProvider('codex', (request, cwd, call) => {
      if (request.role === 'planner') {
        // What the coordinator does when a guard pauses the run mid-call.
        controller.abort(new Error('paused by guard'));
        return failure('SPEND_CEILING', true);
      }
      return defaultScript(request, cwd, call);
    });
    const { input, of } = await harness({ providers: [claude, codex], signal: controller.signal });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow('codex: SPEND_CEILING');
    expect(codex.calls('planner')).toHaveLength(1);
    expect(claude.requests).toHaveLength(0);
    expect(of('provider.retry')).toHaveLength(0);
    expect(of('provider.fallback')).toHaveLength(0);
  });

  it('refuses to start on ollama alone', async () => {
    const { input } = await harness({
      providers: [
        new ScriptedProvider('claude', defaultScript, false),
        new ScriptedProvider('ollama'),
      ],
      providerRoles: {},
    });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'No authenticated cloud provider is available',
    );
  });

  it('refuses a role pinned to ollama', async () => {
    const { input } = await harness({
      providers: [new ScriptedProvider('claude'), new ScriptedProvider('ollama')],
      providerRoles: { planner: 'ollama' },
    });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'planner cannot be pinned to ollama',
    );
  });

  describe('a projected crossing (ADR-028)', () => {
    // The router projects each stage with its role's estimate (planner $0.70,
    // critic $0.25, builder $1.25, reviewer $0.40) against the default $20
    // ceiling, so the day totals below are chosen around those figures.
    const spentToday = (usd: number) => () => [{ at: new Date().toISOString(), usd, tokens: 0 }];

    it('sends the planner and the critic local before the day reaches the ceiling, and stops at the builder', async () => {
      const claude = new ScriptedProvider('claude');
      const codex = new ScriptedProvider('codex');
      const ollama = new ScriptedProvider('ollama', freeScript);
      const { input, of } = await harness({
        providers: [claude, codex, ollama],
        usageSource: spentToday(19.8),
      });
      const result = await new AutonomousPipeline().execute(input);
      expect(result.status).toBe('partially_completed');
      expect(result.classification).toBe('safety_constraint');
      expect(result.blocker).toContain(
        'builder must not run locally; stopping the run at the ceiling',
      );
      expect(result.blocker).toContain('projected $21.05');
      // What was produced before the stop is kept for the resume.
      expect(result.plan).toBe('planner output');
      expect(result.critique).toBe('critic output');
      const decided = of('routing.decided');
      expect(decided.map((d) => [d.role, d.providerId, d.tier, d.estimatedUsd])).toEqual([
        ['planner', 'ollama', 2, 0.7],
        ['critic', 'ollama', 2, 0.25],
        ['planner', 'ollama', 2, 0.7],
        ['builder', null, 2, 1.25],
      ]);
      expect(decided.every((d) => d.ceilingApplied === true)).toBe(true);
      expect(String(decided[0]?.reason)).toContain('projected $20.50 ($19.80 spent on');
      expect(String(decided[1]?.reason)).toContain('projected $20.05 ($19.80 spent on');
      // Nothing was asked of the cloud and nothing was spent on it: no guard
      // ever saw a call to pause the run for.
      expect(claude.requests).toHaveLength(0);
      expect(codex.requests).toHaveLength(0);
      expect(ollama.calls('planner')).toHaveLength(2);
      expect(ollama.calls('critic')).toHaveLength(1);
      const recorded = of('usage.recorded');
      expect(recorded).toHaveLength(3);
      expect(recorded.every((u) => u.provider === 'ollama' && u.usd === 0)).toBe(true);
      expect(of('build.completed')).toHaveLength(0);
    });

    it('keeps a stage on the cloud while its own estimate fits, then routes the rest local', async () => {
      // Per role, not per run: at $19.50 the planner ($0.70) is projected past
      // $20 while the critic ($0.25 -> $19.75) still fits. The critic's recorded
      // $0.50 then reaches the ceiling, so the revision is local for that
      // reason and the builder is refused.
      const claude = new ScriptedProvider('claude');
      const codex = new ScriptedProvider('codex');
      const ollama = new ScriptedProvider('ollama', freeScript);
      const { input, of, events } = await harness({ providers: [claude, codex, ollama] });
      // As the coordinator wires it: the day total includes what the run
      // itself has recorded so far, re-read at every decision.
      input.usageSource = () => [
        { at: new Date().toISOString(), usd: 19.5, tokens: 0 },
        ...events
          .filter((event) => event.type === 'usage.recorded')
          .map((event) => ({
            at: new Date().toISOString(),
            usd: Number(event.payload.usd),
            tokens: 0,
          })),
      ];
      const result = await new AutonomousPipeline().execute(input);
      expect(result.status).toBe('partially_completed');
      expect(result.classification).toBe('safety_constraint');
      const decided = of('routing.decided');
      expect(decided.map((d) => [d.role, d.providerId, d.tier])).toEqual([
        ['planner', 'ollama', 2],
        ['critic', 'claude', 3],
        ['planner', 'ollama', 2],
        ['builder', null, 2],
      ]);
      expect(String(decided[0]?.reason)).toContain('projected $20.20 ($19.50 spent on');
      expect(decided[1]).toMatchObject({ ceilingApplied: false, estimatedUsd: 0.25 });
      expect(String(decided[2]?.reason)).toContain(
        'daily cloud ceiling of $20.00 reached ($20.00 spent on',
      );
      expect(claude.calls('critic')).toHaveLength(1);
      expect(claude.requests).toHaveLength(1);
      expect(codex.requests).toHaveLength(0);
      expect(of('usage.recorded').filter((u) => u.provider === 'claude')).toHaveLength(1);
    });

    it('routes every stage to the cloud while the projections fit, the builder exactly at the ceiling', async () => {
      const claude = new ScriptedProvider('claude');
      const codex = new ScriptedProvider('codex');
      const ollama = new ScriptedProvider('ollama', freeScript);
      const { input, of } = await harness({
        providers: [claude, codex, ollama],
        usageSource: spentToday(18.75),
      });
      const result = await new AutonomousPipeline().execute(input);
      expect(result.blocker).toContain('Approve push');
      const decided = of('routing.decided');
      expect(decided.map((d) => d.role)).toEqual([
        'planner',
        'critic',
        'planner',
        'builder',
        'reviewer',
      ]);
      expect(decided.every((d) => d.tier === 3 && !d.ceilingApplied && d.allowed)).toBe(true);
      expect(decided.map((d) => d.estimatedUsd)).toEqual([0.7, 0.25, 0.7, 1.25, 0.4]);
      expect(ollama.requests).toHaveLength(0);
    });

    it('stops the run without a cloud call when the projection says local and nothing local is online', async () => {
      // Q26: the ceiling is never a reason to spend. With no ollama adapter the
      // planner may run nowhere, so the run stops at its first stage.
      const claude = new ScriptedProvider('claude');
      const codex = new ScriptedProvider('codex');
      const { input, of } = await harness({
        providers: [claude, codex],
        usageSource: spentToday(19.5),
      });
      const result = await new AutonomousPipeline().execute(input);
      expect(result.status).toBe('partially_completed');
      expect(result.classification).toBe('safety_constraint');
      expect(result.blocker).toContain(
        'planner may run locally but no ollama provider is available; stopping the run at the ceiling',
      );
      expect(result.blocker).toContain('projected $20.20');
      expect(result.plan).toBe('');
      expect(of('routing.decided')).toEqual([
        expect.objectContaining({
          role: 'planner',
          tier: 2,
          providerId: null,
          allowed: false,
          ceilingApplied: true,
          estimatedUsd: 0.7,
        }),
      ]);
      expect(claude.requests).toHaveLength(0);
      expect(codex.requests).toHaveLength(0);
      expect(of('usage.recorded')).toHaveLength(0);
      expect(of('plan.completed')).toHaveLength(0);
    });
  });
});

/**
 * ADR-024: claude is the default cloud provider for every role. The harness
 * pins all four roles, as the evidence runs do, so these tests clear the pins
 * and pass their own, and list codex before claude so "first cloud adapter"
 * and "claude" are told apart.
 */
describe('AutonomousPipeline default providers', () => {
  const roleOf = (decisions: Array<Record<string, unknown>>) =>
    decisions.map((d) => [d.role, d.providerId]);

  it('takes claude for every role when no role is pinned', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude');
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({
      providers: [codex, claude, ollama],
      providerRoles: {},
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(roleOf(of('routing.decided'))).toEqual([
      ['planner', 'claude'],
      ['critic', 'claude'],
      ['planner', 'claude'],
      ['builder', 'claude'],
      ['reviewer', 'claude'],
    ]);
    expect(codex.requests).toHaveLength(0);
    expect(ollama.requests).toHaveLength(0);
    expect(of('usage.recorded').every((u) => u.provider === 'claude')).toBe(true);
  });

  it('takes claude for every role when providerRoles is absent altogether', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude');
    const { input, of } = await harness({ providers: [codex, claude] });
    delete (input as { providerRoles?: unknown }).providerRoles;
    await new AutonomousPipeline().execute(input);
    expect(of('routing.decided').every((d) => d.providerId === 'claude')).toBe(true);
    expect(codex.requests).toHaveLength(0);
  });

  it('falls back to the first authenticated cloud provider when claude is not authenticated', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude', defaultScript, false);
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({
      providers: [claude, codex, ollama],
      providerRoles: {},
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(roleOf(of('routing.decided'))).toEqual([
      ['planner', 'codex'],
      ['critic', 'codex'],
      ['planner', 'codex'],
      ['builder', 'codex'],
      ['reviewer', 'codex'],
    ]);
    expect(claude.requests).toHaveLength(0);
    // Local execution is still something only the ceiling grants.
    expect(ollama.requests).toHaveLength(0);
  });

  it('honours a pinned codex role and leaves the others on claude', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude');
    const { input, of } = await harness({
      providers: [codex, claude],
      providerRoles: { builder: 'codex' },
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.blocker).toContain('Approve push');
    expect(roleOf(of('routing.decided'))).toEqual([
      ['planner', 'claude'],
      ['critic', 'claude'],
      ['planner', 'claude'],
      ['builder', 'codex'],
      ['reviewer', 'claude'],
    ]);
    expect(codex.calls('builder')).toHaveLength(1);
    expect(codex.requests).toHaveLength(1);
  });

  it('runs every role on codex when the run pins all four, as an evidence run does', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude');
    const { input, of } = await harness({
      providers: [claude, codex],
      providerRoles: { planner: 'codex', critic: 'codex', builder: 'codex', reviewer: 'codex' },
    });
    await new AutonomousPipeline().execute(input);
    expect(of('routing.decided').every((d) => d.providerId === 'codex')).toBe(true);
    expect(claude.requests).toHaveLength(0);
  });

  it('still refuses a pinned provider that is not authenticated', async () => {
    const codex = new ScriptedProvider('codex', defaultScript, false);
    const claude = new ScriptedProvider('claude');
    const { input } = await harness({
      providers: [claude, codex],
      providerRoles: { reviewer: 'codex' },
    });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'Configured reviewer provider codex is not available',
    );
    expect(claude.requests).toHaveLength(0);
  });

  it('keeps the ceiling routing unchanged for the default provider', async () => {
    const codex = new ScriptedProvider('codex');
    const claude = new ScriptedProvider('claude');
    const ollama = new ScriptedProvider('ollama');
    const { input, of } = await harness({
      providers: [codex, claude, ollama],
      providerRoles: {},
      usageSource: overCeiling,
      timeZone: 'Australia/Sydney',
    });
    const result = await new AutonomousPipeline().execute(input);
    expect(result.status).toBe('partially_completed');
    expect(result.classification).toBe('safety_constraint');
    expect(result.blocker).toContain(
      'builder must not run locally; stopping the run at the ceiling',
    );
    // Under the ceiling the planner and the critic go local; codex, unmetered
    // or not, is never the substitute (ADR-022).
    expect(of('routing.decided').map((d) => [d.role, d.providerId, d.tier])).toEqual([
      ['planner', 'ollama', 2],
      ['critic', 'ollama', 2],
      ['planner', 'ollama', 2],
      ['builder', null, 2],
    ]);
    expect(claude.requests).toHaveLength(0);
    expect(codex.requests).toHaveLength(0);
  });
});
