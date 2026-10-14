import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest, Run } from '@theforge/contracts';
import { runGit } from '@theforge/git-runtime';
import type { ProviderAdapter } from '@theforge/providers';
import { AutonomousPipeline, ProviderWaitExpired, type AutonomousPipelineInput } from './index.js';

/**
 * ADR-029. The coordinator and the worker are separate processes; when the
 * coordinator is killed and restarted, it is up and serving before the worker
 * has re-registered. Provider availability used to be read once in that window
 * and every in-flight run died on it:
 *
 *   provider.diagnostic {provider: claude, available: false,
 *                        detail: "No online worker advertises provider:claude"}
 *   run.failed          {message: "No authenticated provider is available"}
 *   worker_job.leased   {workerId: nodee-worker-1}   <- one event later
 *
 * These tests pin the three behaviours that fixes it: wait while the fleet is
 * empty, fail fast when it is not, and end a spent wait in a pause.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** What the coordinator's worker registry looks like from the pipeline's side. */
type Fleet = { empty: boolean };

/**
 * A provider that is available only while a worker is online, which is what
 * WorkerProviderAdapter.diagnose() reports in the coordinator. `probes` counts
 * the readings, so a test can prove the resolution polled rather than answered
 * once.
 */
class FleetProvider implements ProviderAdapter {
  readonly capabilities = {
    streaming: true,
    resume: false,
    tools: true,
    structuredOutput: true,
    usage: true,
  };
  probes = 0;
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: string,
    private readonly fleet: Fleet,
    /** False for a provider an online worker does not advertise (Codex not logged in). */
    private readonly advertised = true,
    /**
     * The reading on which the worker is back. Counted rather than timed: the
     * worktree clone before the first reading takes a few hundred milliseconds,
     * so a wall-clock timer would have re-registered the worker before the
     * cold-start reading ever happened and the wait would never begin.
     */
    private readonly registersAtProbe?: number,
  ) {}
  async diagnose() {
    this.probes += 1;
    if (this.registersAtProbe !== undefined && this.probes >= this.registersAtProbe)
      this.fleet.empty = false;
    const capable = this.advertised && !this.fleet.empty;
    return {
      available: capable,
      authenticated: capable,
      detail: capable
        ? `${this.id} is available on a fake worker`
        : `No online worker advertises provider:${this.id}`,
    };
  }
  async *run(
    request: ProviderRequest,
    options: { cwd: string; signal?: AbortSignal },
  ): AsyncGenerator<ProviderEvent> {
    this.requests.push(request);
    for (const event of await script(request, options.cwd)) yield event;
  }
}

const usage: ProviderEvent = { type: 'usage', inputTokens: 10, outputTokens: 5, usd: 0.5 };
const completed = (text: string): ProviderEvent[] => [
  { type: 'text_delta', text },
  usage,
  { type: 'completed', output: text },
];
const APPROVED = '{"approved": true, "findings": []}';
const script = async (request: ProviderRequest, cwd: string): Promise<ProviderEvent[]> => {
  if (request.role === 'builder') {
    await writeFile(join(cwd, 'feature.txt'), 'built\n');
    return completed('built');
  }
  if (request.role === 'reviewer') return completed(APPROVED);
  return completed(`${request.role} output`);
};

const now = '2026-09-27T00:00:00.000Z';
type Recorded = { type: string; payload: Record<string, unknown> };

async function harness(overrides: Partial<AutonomousPipelineInput>) {
  const root = join(process.cwd(), '.forge', 'test-tmp');
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, 'forge-provider-wait-'));
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
    id: 'run-provider-wait',
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
    branch: 'forge/provider-wait',
    checks: [],
    workspaceRoot,
    providers: [],
    backoff: { baseMs: 1, maxMs: 2, jitter: 0 },
    onEvent: (type, payload) => {
      events.push({ type, payload });
    },
    ...overrides,
  };
  const of = (type: string) => events.filter((event) => event.type === type).map((e) => e.payload);
  return { input, events, of };
}

describe('AutonomousPipeline provider availability (ADR-029)', () => {
  it('waits for a worker to advertise a provider and then runs the stage', async () => {
    // The worker re-registers a moment after the coordinator is back, exactly
    // as the measured trace shows it doing one event after run.failed.
    const fleet: Fleet = { empty: true };
    const claude = new FleetProvider('claude', fleet, true, 3);
    const { input, of } = await harness({
      providers: [claude],
      providerWait: { totalMs: 5_000, intervalMs: 25, fleetEmpty: () => fleet.empty },
    });
    const result = await new AutonomousPipeline().execute(input);

    // The run reached the push gate: nothing failed on the cold reading.
    expect(result.status).toBe('partially_completed');
    expect(result.blocker).toContain('Approve push');
    expect(result.plan).toBe('planner output');
    expect(of('provider.wait_started')).toHaveLength(1);
    expect(of('provider.wait_started')[0]).toMatchObject({ budgetMs: 5_000, intervalMs: 25 });
    const satisfied = of('provider.wait_satisfied');
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0]).toMatchObject({ providers: ['claude'] });
    expect(Number(satisfied[0]?.waitedMs)).toBeGreaterThan(0);
    // It polled rather than answering once, and both readings are in the trace:
    // the cold-start one and the one that ended the wait.
    expect(claude.probes).toBeGreaterThan(1);
    const diagnostics = of('provider.diagnostic');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ provider: 'claude', available: false });
    expect(diagnostics[1]).toMatchObject({ provider: 'claude', available: true });
  });

  it('still fails at once when a worker is online but does not advertise the provider', async () => {
    // Codex not logged in: the worker is there, its answer is informative, and
    // waiting cannot change it. A generous budget must not be spent.
    const fleet: Fleet = { empty: false };
    const codex = new FleetProvider('codex', fleet, false);
    const { input, of } = await harness({
      providers: [codex],
      providerWait: { totalMs: 600_000, intervalMs: 20, fleetEmpty: () => fleet.empty },
    });
    const startedAt = Date.now();
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'No authenticated provider is available',
    );
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(codex.probes).toBe(1);
    expect(of('provider.wait_started')).toHaveLength(0);
  });

  it('bounds the wait and ends it in a pause rather than a hang or a failure', async () => {
    const fleet: Fleet = { empty: true };
    const claude = new FleetProvider('claude', fleet);
    const { input, of } = await harness({
      providers: [claude],
      providerWait: { totalMs: 300, intervalMs: 25, fleetEmpty: () => fleet.empty },
    });
    const startedAt = Date.now();
    const failure = await new AutonomousPipeline()
      .execute(input)
      .then(() => undefined)
      .catch((error: unknown) => error);
    const elapsed = Date.now() - startedAt;

    // A typed pause, not the plain failure: the coordinator pauses the run on
    // this error instead of failing it.
    expect(failure).toBeInstanceOf(ProviderWaitExpired);
    const expired = failure as ProviderWaitExpired;
    expect(expired.classification).toBe('safety_constraint');
    expect(expired.message).toContain('paused rather than failed');
    expect(expired.waitedMs).toBeGreaterThanOrEqual(250);
    expect(expired.diagnostics).toEqual([
      expect.objectContaining({
        provider: 'claude',
        available: false,
        detail: 'No online worker advertises provider:claude',
      }),
    ]);
    // Bounded: it neither hung nor waited appreciably past its budget.
    expect(elapsed).toBeLessThan(15_000);
    expect(of('provider.wait_started')).toHaveLength(1);
    expect(of('provider.wait_satisfied')).toHaveLength(0);
  });

  it('resolves availability once, as before, when no wait is configured', async () => {
    const fleet: Fleet = { empty: true };
    const claude = new FleetProvider('claude', fleet);
    const { input, of } = await harness({ providers: [claude] });
    await expect(new AutonomousPipeline().execute(input)).rejects.toThrow(
      'No authenticated provider is available',
    );
    expect(claude.probes).toBe(1);
    expect(of('provider.wait_started')).toHaveLength(0);
  });
});
