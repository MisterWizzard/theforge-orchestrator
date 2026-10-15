import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Blocker, Finding, ProviderRequest, Run, Task, Worker } from '@theforge/contracts';
import { ForgeEngine, InMemoryForgeRepository, type Clock } from '@theforge/domain';
import {
  GitHubIntegration,
  GitWorkspaceRuntime,
  runGit,
  SecretScanRefusal,
} from '@theforge/git-runtime';
import {
  DEFAULT_CLOUD_PROVIDER_ID,
  freshTokens,
  isCloudProviderId,
  LOCAL_PROVIDER_ID,
  routeRole,
  type CeilingConfig,
  type PipelineRole,
  type Residency,
  type RoleRouteDecision,
  type UsageRecord as GuardUsageRecord,
} from '@theforge/guardrails';
import { assertUntrustedText, classifyAction, redactSecrets } from '@theforge/policy';
import type { ProviderAdapter } from '@theforge/providers';

export type Lease = {
  attemptId: string;
  taskId: string;
  workerId: string;
  token: string;
  expiresAt: string;
  heartbeatAt: string;
};
export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  constructor(
    private readonly clock: Clock = { now: () => new Date() },
    private readonly ttlMs = 30_000,
  ) {}
  acquire(taskId: string, workerId: string) {
    if (
      [...this.leases.values()].some(
        (lease) => lease.taskId === taskId && new Date(lease.expiresAt) > this.clock.now(),
      )
    )
      throw new Error('Task already leased');
    const now = this.clock.now();
    const lease = {
      attemptId: randomUUID(),
      taskId,
      workerId,
      token: randomUUID(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
    };
    this.leases.set(lease.token, lease);
    return lease;
  }
  heartbeat(token: string) {
    const lease = this.leases.get(token);
    if (!lease || new Date(lease.expiresAt) <= this.clock.now()) throw new Error('Lease expired');
    const now = this.clock.now();
    const next = {
      ...lease,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.leases.set(token, next);
    return next;
  }
  release(token: string) {
    return this.leases.delete(token);
  }
  recoverExpired() {
    const now = this.clock.now();
    const expired = [...this.leases.values()].filter((lease) => new Date(lease.expiresAt) <= now);
    for (const lease of expired) this.leases.delete(lease.token);
    return expired;
  }
  snapshot() {
    return [...this.leases.values()];
  }
}

export function retryDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; jitter?: number } = {},
  random: () => number = Math.random,
) {
  const base = options.baseMs ?? 1_000;
  const maximum = options.maxMs ?? 60_000;
  const jitter = options.jitter ?? 0.2;
  const bounded = Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(bounded * (1 - jitter + random() * jitter * 2));
}

export class WorkerRegistry {
  private readonly workers = new Map<string, Worker>();
  constructor(private readonly expectedTokenDigest: string) {}
  register(input: Omit<Worker, 'status' | 'lastHeartbeatAt'>, token: string) {
    if (!safeEqual(hash(token), this.expectedTokenDigest))
      throw new Error('Worker authentication failed');
    const worker: Worker = {
      ...input,
      status: 'online',
      lastHeartbeatAt: new Date().toISOString(),
    };
    this.workers.set(worker.id, worker);
    return worker;
  }
  heartbeat(id: string) {
    const current = this.workers.get(id);
    if (!current) throw new Error('Unknown worker');
    const worker = {
      ...current,
      status: 'online' as const,
      lastHeartbeatAt: new Date().toISOString(),
    };
    this.workers.set(id, worker);
    return worker;
  }
  eligible(capabilities: string[]) {
    return [...this.workers.values()].filter(
      (worker) =>
        worker.status === 'online' &&
        capabilities.every((cap) => worker.capabilities.includes(cap)),
    );
  }
  static digestToken(token: string) {
    return hash(token);
  }
}

export type ScheduleDecision = { task: Task; worker: Worker; provider: ProviderAdapter };
export class Scheduler {
  constructor(
    private readonly registry: WorkerRegistry,
    private readonly providers: ProviderAdapter[],
    private readonly maxConcurrency = 4,
  ) {}
  async schedule(
    tasks: Task[],
    active: number,
    budgetRemainingUsd: number,
  ): Promise<ScheduleDecision[]> {
    if (active >= this.maxConcurrency || budgetRemainingUsd <= 0) return [];
    const availableProviders = [];
    for (const provider of this.providers) {
      const diagnostic = await provider.diagnose();
      if (diagnostic.available && diagnostic.authenticated) availableProviders.push(provider);
    }
    if (!availableProviders.length) return [];
    const ready = tasks
      .filter((task) => task.state === 'ready')
      .sort((a, b) => b.priority - a.priority);
    const decisions: ScheduleDecision[] = [];
    for (const task of ready) {
      if (decisions.length + active >= this.maxConcurrency) break;
      const worker = this.registry.eligible(task.requiredCapabilities)[0];
      if (worker)
        decisions.push({
          task,
          worker,
          provider: availableProviders[decisions.length % availableProviders.length]!,
        });
    }
    return decisions;
  }
}

export type OrchestrationHooks = {
  context?: (objective: string) => Promise<string>;
  builder?: (task: Task) => Promise<void>;
  verify?: (task: Task) => Promise<boolean>;
  integrate?: () => Promise<{ pullRequestUrl?: string }>;
};
export type RunReport = {
  run: Run;
  tasks: Task[];
  findings: Finding[];
  blockers: Blocker[];
  repairRounds: number;
  pullRequestUrl?: string;
};

export class OrchestrationRun {
  readonly repository: InMemoryForgeRepository;
  readonly engine: ForgeEngine;
  readonly findings: Finding[] = [];
  readonly blockers: Blocker[] = [];
  repairRounds = 0;
  constructor(
    readonly run: Run,
    tasks: Task[],
    private readonly hooks: OrchestrationHooks = {},
    repository?: InMemoryForgeRepository,
  ) {
    this.repository = repository ?? new InMemoryForgeRepository();
    this.engine = new ForgeEngine(this.repository);
    this.repository.runs.set(run.id, structuredClone(run));
    for (const task of tasks) this.repository.tasks.set(task.id, structuredClone(task));
  }
  async execute(): Promise<RunReport> {
    const path = [
      'created',
      'context_gathering',
      'planning',
      'critique',
      'plan_revision',
      'executing',
    ] as const;
    let current = (await this.repository.getRun(this.run.id))!;
    const index = path.indexOf(current.state as (typeof path)[number]);
    if (index < 0 && current.state !== 'executing')
      throw new Error(`Cannot execute a run from ${current.state}`);
    for (const state of path.slice(Math.max(index + 1, 1))) {
      await this.engine.transitionRun(this.run.id, state, `run:${this.run.id}:${state}`);
      current = (await this.repository.getRun(this.run.id))!;
    }
    await this.hooks.context?.(this.run.objective);
    await this.engine.refreshReadiness(this.run.id);
    while (true) {
      const tasks = await this.repository.listTasks(this.run.id);
      const ready = tasks.filter((task) => task.state === 'ready');
      if (!ready.length) break;
      for (const task of ready) {
        await this.engine.transitionTask(
          task.id,
          'in_progress',
          `task:${task.id}:start:${task.attempts}`,
        );
        try {
          await this.hooks.builder?.(task);
          await this.engine.transitionTask(
            task.id,
            'review',
            `task:${task.id}:review:${task.attempts}`,
          );
          let passes = (await this.hooks.verify?.(task)) ?? true;
          let taskRepairRounds = 0;
          while (!passes && taskRepairRounds < 3) {
            taskRepairRounds++;
            this.repairRounds++;
            await this.engine.transitionTask(
              task.id,
              'in_progress',
              `task:${task.id}:repair:${this.repairRounds}`,
            );
            await this.hooks.builder?.(task);
            await this.engine.transitionTask(
              task.id,
              'verification',
              `task:${task.id}:verify:${this.repairRounds}`,
            );
            passes = (await this.hooks.verify?.(task)) ?? true;
          }
          if (!passes) {
            this.pinBlocker(
              task,
              'technical_unknown',
              'Verification failed after bounded repairs',
              'Review failing implementation and evidence',
            );
            continue;
          }
          if (taskRepairRounds === 0)
            await this.engine.transitionTask(
              task.id,
              'verification',
              `task:${task.id}:verify:${task.attempts}`,
            );
          await this.engine.transitionTask(task.id, 'done', `task:${task.id}:done`);
        } catch (error) {
          this.pinBlocker(
            task,
            'technical_unknown',
            error instanceof Error ? error.message : String(error),
            'Resolve task-specific execution failure',
          );
        }
      }
      await this.engine.refreshReadiness(this.run.id);
    }
    const tasks = await this.repository.listTasks(this.run.id);
    const incomplete = tasks.filter(
      (task) => !['done', 'deferred', 'cancelled'].includes(task.state),
    );
    for (const state of ['reviewing', 'verifying'] as const)
      await this.engine.transitionRun(this.run.id, state, `run:${this.run.id}:${state}`);
    let pullRequestUrl: string | undefined;
    if (incomplete.length) {
      await this.engine.transitionRun(
        this.run.id,
        'partially_completed',
        `run:${this.run.id}:partial`,
      );
    } else {
      await this.engine.transitionRun(this.run.id, 'integrating', `run:${this.run.id}:integrating`);
      pullRequestUrl = (await this.hooks.integrate?.())?.pullRequestUrl;
      await this.engine.transitionRun(this.run.id, 'completed', `run:${this.run.id}:completed`);
    }
    const run = (await this.repository.getRun(this.run.id))!;
    return {
      run,
      tasks: await this.repository.listTasks(this.run.id),
      findings: this.findings,
      blockers: this.blockers,
      repairRounds: this.repairRounds,
      ...(pullRequestUrl ? { pullRequestUrl } : {}),
    };
  }
  private pinBlocker(
    task: Task,
    classification: Blocker['classification'],
    summary: string,
    smallestUnblockAction: string,
  ) {
    const blocker: Blocker = {
      id: randomUUID(),
      runId: task.runId,
      taskId: task.id,
      classification,
      summary,
      evidence: [],
      impact: `Task ${task.id} cannot complete`,
      attempts: [summary],
      smallestUnblockAction,
      status: 'active',
    };
    this.blockers.push(blocker);
    const current = this.repository.tasks.get(task.id);
    if (current)
      this.repository.tasks.set(task.id, {
        ...current,
        state: 'blocked',
        updatedAt: new Date().toISOString(),
      });
  }
  snapshot() {
    return structuredClone({
      run: this.repository.runs.get(this.run.id)!,
      tasks: [...this.repository.tasks.values()],
      events: this.repository.events,
      findings: this.findings,
      blockers: this.blockers,
      repairRounds: this.repairRounds,
    });
  }
  static restore(
    snapshot: ReturnType<OrchestrationRun['snapshot']>,
    hooks: OrchestrationHooks = {},
  ) {
    const repository = new InMemoryForgeRepository();
    repository.runs.set(snapshot.run.id, snapshot.run);
    for (const task of snapshot.tasks) repository.tasks.set(task.id, task);
    repository.events.push(...snapshot.events);
    const orchestration = new OrchestrationRun(snapshot.run, snapshot.tasks, hooks, repository);
    orchestration.findings.push(...snapshot.findings);
    orchestration.blockers.push(...snapshot.blockers);
    orchestration.repairRounds = snapshot.repairRounds;
    return orchestration;
  }
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function safeEqual(a: string, b: string) {
  return a.length === b.length && a === b;
}

/**
 * Provider ids the pipeline can route to. Widened here rather than in
 * `@theforge/contracts`: the run-configuration enum there gains 'ollama' with
 * the provider slice, and this union accepts whichever value it produces.
 */
export type PipelineProviderId = 'claude' | 'codex' | 'ollama';

export type AutonomousPipelineInput = {
  run: Run;
  repositoryUrl: string;
  projectId: string;
  baseRef: string;
  branch: string;
  checks: Array<{ executable: string; args: string[] }>;
  workspaceRoot: string;
  providers: ProviderAdapter[];
  /**
   * Wall clock for one provider attempt; `DEFAULT_STAGE_TIMEOUT_MS` when unset.
   * The coordinator passes `FORGE_STAGE_TIMEOUT_MS`. Configurable because the
   * right value depends on the size of the work, and a hardcoded one cannot be
   * raised for a long objective or lowered for a cheap one.
   */
  stageTimeoutMs?: number;
  /**
   * Builds the signal that bounds one provider attempt. Without it the stage
   * uses `AbortSignal.timeout`, which counts wall clock.
   *
   * The coordinator supplies one that does not advance while the halt file is
   * present. Otherwise a halt longer than the stage timeout failed the run
   * anyway: the queue budget correctly paused and the job stayed queued, and
   * then the stage's own clock ran out on a job that had never started. That
   * made `docs/OPERATIONS.md`'s claim - "a halt of any length no longer cancels
   * queued jobs or fails their runs" - only half true.
   */
  stageTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  /**
   * The cloud provider a run pins for a role. A role left out, or set to
   * undefined, runs on the default cloud provider (claude, ADR-024). Local
   * execution is never configured here; the ceiling policy grants it.
   */
  providerRoles?: Partial<Record<PipelineRole, PipelineProviderId | undefined>>;
  checkRunner?: CheckRunner;
  /**
   * Commands that fetch the project's dependencies, run once before the checks
   * and with network access. Empty for a project that declares none, which
   * leaves the behaviour exactly as it was.
   *
   * Separate from `checks` on purpose. The sandbox that runs checks has no
   * network - deliberately, it is what stops an agent reaching anything - so
   * `npm ci` fails there with EAI_AGAIN and a project needing its dependencies
   * could never be verified. Dan's decision of 05/10/2026 was to split the two
   * rather than open the checking box: the container that fetches has network
   * and runs nothing else, then the checks run sealed and find the
   * dependencies waiting in the shared workspace mount.
   */
  install?: Array<{ executable: string; args: string[] }>;
  signal?: AbortSignal;
  checkpoint?: {
    plan?: string;
    critique?: string;
    revisedPlan?: string;
    built?: boolean;
  };
  github?: {
    token: string;
    owner: string;
    repo: string;
    pushApproved: boolean;
    /**
     * The digest of a staged diff a person has already accepted despite the
     * secret scan matching it. Compared to what is staged now, so it cannot
     * carry over to different content.
     */
    approvedSecretDigest?: string;
  };
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void> | void;
  /**
   * Routing inputs (docs/EXECUTION_PROTOCOL.md "Routing and fallback", ADR-022,
   * ADR-028). All optional; without `usageSource` every stage routes to the
   * cloud exactly as before. With it, every stage is placed against the day's
   * spend plus its own role estimate (ROLE_ESTIMATES_USD, the table the
   * coordinator's dispatch guard checks against), so a stage that would carry
   * the day past the ceiling is routed local or refused here rather than
   * paused by the guard. The coordinator wires them at integration:
   *   usageSource - every usage record it holds, in the guard shape
   *                 (`toGuardUsage` from @theforge/guardrails), read again at
   *                 each stage so the previous stage's spend counts;
   *   ceiling     - the CeilingConfig it already builds for its Guards;
   *   timeZone    - FORGE_TIMEZONE, the calendar the ceiling counts in;
   *   residency   - what Ollama has loaded (`listLoadedModels`), asked for
   *                 only when a stage is about to run locally.
   */
  usageSource?: () => readonly GuardUsageRecord[];
  ceiling?: CeilingConfig;
  timeZone?: string;
  residency?: () => Promise<Residency>;
  /** Backoff between retries of one provider's retryable error; tests shrink it. */
  backoff?: { baseMs?: number; maxMs?: number; jitter?: number };
  /**
   * The bounded wait for a worker to advertise a provider (ADR-029).
   *
   * A coordinator that has just started has no online workers for the first
   * moments of its life, so a run resumed across a restart used to evaluate
   * provider availability against an empty fleet and fail instantly with
   * "No authenticated provider is available" - one event before the worker
   * re-registered and re-leased its job. The wait exists for exactly that
   * window and for nothing else: `fleetEmpty` must report false as soon as any
   * worker is online, because an online worker's diagnostics are then the truth
   * about what it advertises, and a provider it genuinely does not advertise
   * (Codex not logged in) must still fail fast.
   *
   * Absent, or `totalMs` 0, resolves availability once, exactly as before.
   */
  providerWait?: {
    /** Bound on the whole wait, in ms. 0 or absent means do not wait. */
    totalMs?: number;
    /** Poll interval, in ms; default PROVIDER_WAIT_POLL_MS. */
    intervalMs?: number;
    /** True only while no worker is online at all - the transient case. */
    fleetEmpty?: () => boolean | Promise<boolean>;
  };
};

export type SecretScanEvidence = {
  /** sha256 of the staged diff this applies to; an approval is pinned to it. */
  digest: string;
  /** The matching lines, values already redacted. */
  evidence: string[];
};

export type AutonomousPipelineResult = {
  status: 'completed' | 'partially_completed';
  workspace: string;
  commit?: string;
  pullRequestUrl?: string;
  plan: string;
  critique: string;
  review: string;
  checks: Array<{ command: string; code: number; stdout: string; stderr: string }>;
  blocker?: string;
  /**
   * Set beside `blocker` when the stop was a policy decision rather than a
   * technical one. The coordinator records `run.finished` with the whole
   * result, and its blocker reads `classification` from that payload.
   */
  classification?: Blocker['classification'];
  /**
   * Set instead of `commit` when the commit-time secret scan matched and no
   * approval covered the staged content. The coordinator turns this into an
   * approval request; see GitWorkspaceRuntime.commit.
   */
  secretScan?: SecretScanEvidence;
};

/** Attempts on one provider before a retryable error counts as a failure. */
const MAX_ATTEMPTS_PER_PROVIDER = 2;
/**
 * Wall clock allowed for one provider attempt, when the caller names none.
 *
 * Thirty minutes, matching `DEFAULT_TASK_LIMITS.maxWallClockMinutes`, because
 * those two numbers bound the same thing and disagreeing is what made them a
 * defect. It was 15 minutes and hardcoded until 04/10/2026, and that was the
 * fifth limit a real builder stage ran into: the first objective pointed at a
 * real repository finished its builder in a shade under 15 minutes on one
 * attempt and was killed at exactly 900,000 ms on the next, doing the same work.
 * A cap a real task lands either side of is a coin toss, not a guard.
 */
export const DEFAULT_STAGE_TIMEOUT_MS = 1_800_000;
const DEFAULT_BACKOFF = { baseMs: 2_000, maxMs: 30_000 };

/** A stage the routing policy refused; execute() turns it into a partial result. */
class StageRefused extends Error {
  constructor(
    readonly blocker: string,
    readonly classification: Blocker['classification'],
  ) {
    super(blocker);
  }
}

type ProviderError = { code: string; message: string; retryable: boolean };
type CollectOutcome = { ok: true; text: string } | { ok: false; error: ProviderError };
type CheckResult = { command: string; code: number; stdout: string; stderr: string };

/** How often the availability wait re-reads the provider diagnostics. */
export const PROVIDER_WAIT_POLL_MS = 1_000;

export type ProviderDiagnosticRecord = {
  provider: string;
  available: boolean;
  authenticated: boolean;
  detail?: string;
};

/**
 * The bounded wait for a worker ran out with the fleet still empty (ADR-029).
 *
 * Distinct from `Error('No authenticated provider is available')` on purpose:
 * that one means an online worker does not advertise what the run needs, which
 * is a real failure, while this one means nobody was there to ask. The
 * coordinator pauses the run on this error instead of failing it, so the work
 * keeps its place until a worker comes back.
 */
export class ProviderWaitExpired extends Error {
  readonly classification: Blocker['classification'] = 'safety_constraint';
  constructor(
    readonly waitedMs: number,
    readonly diagnostics: readonly ProviderDiagnosticRecord[],
  ) {
    super(
      `No worker came online within ${waitedMs} ms to advertise a provider; ` +
        'the run is paused rather than failed and can be resumed once a worker registers',
    );
    this.name = 'ProviderWaitExpired';
  }
}

/**
 * Which adapters a stage may use, waiting for the fleet when - and only when -
 * waiting can change the answer.
 *
 * The first reading is always announced, so the operator sees the cold-start
 * diagnostics in the event trace exactly as before. Polls after that are
 * silent (90 s at one second per poll would otherwise be 270 events); the
 * reading that ends the wait is announced, because that is the one that
 * explains what happened.
 */
async function resolveAvailableProviders(
  input: AutonomousPipelineInput,
): Promise<ProviderAdapter[]> {
  const probe = async () => {
    const usable: ProviderAdapter[] = [];
    const diagnostics: ProviderDiagnosticRecord[] = [];
    for (const provider of input.providers) {
      const diagnostic = await provider.diagnose();
      diagnostics.push({ provider: provider.id, ...diagnostic });
      if (diagnostic.available && diagnostic.authenticated) usable.push(provider);
    }
    return { usable, diagnostics };
  };
  const announce = async (diagnostics: readonly ProviderDiagnosticRecord[]) => {
    for (const diagnostic of diagnostics) await input.onEvent?.('provider.diagnostic', diagnostic);
  };
  let { usable, diagnostics } = await probe();
  await announce(diagnostics);
  const budgetMs = Math.max(0, Math.trunc(input.providerWait?.totalMs ?? 0));
  const fleetEmpty = input.providerWait?.fleetEmpty;
  if (!usable.length && budgetMs > 0 && fleetEmpty && (await fleetEmpty())) {
    const intervalMs = Math.max(
      25,
      Math.trunc(input.providerWait?.intervalMs ?? PROVIDER_WAIT_POLL_MS),
    );
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    await input.onEvent?.('provider.wait_started', {
      reason: 'No worker is online; provider availability cannot be decided yet',
      budgetMs,
      intervalMs,
    });
    let remaining = deadline - Date.now();
    // A worker that comes online ends the wait whatever it advertises: from
    // then on the diagnostics are informative and a missing provider is a
    // genuine failure, not a cold start.
    while (!usable.length && remaining > 0 && (await fleetEmpty())) {
      await sleep(Math.min(intervalMs, remaining), input.signal);
      ({ usable, diagnostics } = await probe());
      remaining = deadline - Date.now();
    }
    const waitedMs = Date.now() - startedAt;
    await announce(diagnostics);
    if (usable.length) {
      await input.onEvent?.('provider.wait_satisfied', {
        waitedMs,
        providers: usable.map((provider) => provider.id),
      });
      return usable;
    }
    // The fleet filled up but advertises nothing this run can use: that is the
    // fail-fast case, and the plain error below says so.
    if (await fleetEmpty()) throw new ProviderWaitExpired(waitedMs, diagnostics);
  }
  if (!usable.length) throw new Error('No authenticated provider is available');
  return usable;
}

export class AutonomousPipeline {
  async execute(input: AutonomousPipelineInput): Promise<AutonomousPipelineResult> {
    const objective = assertUntrustedText(input.run.objective, 20_000);
    // `run.constraints` was accepted by the API, validated, persisted and read
    // back, and until 04/10/2026 **no stage ever saw it** - the whole pipeline
    // contained not one reference to it. A field that looks like it bounds the
    // agents and does nothing is worse than no field: `workflows/src/demo.ts`
    // ships `constraints: ['no destructive actions']`, which anyone would read
    // as enforced.
    //
    // Found the hard way. An objective carrying "Do not modify src/lib/auth.ts"
    // and "if you find a defect, do not fix it, report it" produced a revised
    // plan whose step 1 was to change that file, and a builder that spent
    // nineteen minutes and 3.65M input tokens implementing it. The cost was a
    // symptom; the constraints never arriving was the cause.
    //
    // Sanitised exactly like the objective: this is operator-supplied text that
    // reaches a model, so it goes through `assertUntrustedText` too.
    const constraints = input.run.constraints
      .map((constraint) => assertUntrustedText(constraint, 2_000))
      .filter((constraint) => constraint.trim().length > 0);
    // Rendered once. Empty when there are none, so every prompt below is
    // byte-for-byte unchanged for a run that set no constraints.
    const constraintBlock = constraints.length
      ? `\nCONSTRAINTS (these bound the work; obey them even when the plan, the critique or your own judgement suggests otherwise):\n${constraints
          .map((constraint) => `- ${constraint}`)
          .join('\n')}`
      : '';
    const runtime = new GitWorkspaceRuntime(input.workspaceRoot);
    await runtime.register(input.projectId, input.repositoryUrl);
    const workspaceTaskId = `${input.run.id}-implementation`;
    const workspace = await runtime.createWorktree(
      input.projectId,
      workspaceTaskId,
      input.baseRef,
      input.branch,
    );
    await input.onEvent?.('workspace.ready', { workspace, branch: input.branch });
    const available = await resolveAvailableProviders(input);
    // Local execution is something the ceiling policy grants to a stage, never
    // a default, so each role's cloud provider is chosen among cloud adapters
    // only: a registered ollama adapter must not surface as "the other
    // provider" for the critic or the reviewer.
    const cloud = available.filter((provider) => provider.id !== LOCAL_PROVIDER_ID);
    if (!cloud.length)
      throw new Error(
        'No authenticated cloud provider is available; ollama alone cannot run the builder or the reviewer',
      );
    const selectProvider = (role: PipelineRole) => {
      const configured = input.providerRoles?.[role];
      if (configured === LOCAL_PROVIDER_ID)
        throw new Error(
          `${role} cannot be pinned to ${LOCAL_PROVIDER_ID}; local execution is decided by the ceiling policy`,
        );
      const selected = configured
        ? cloud.find((provider) => provider.id === configured)
        : undefined;
      if (configured && !selected)
        throw new Error(`Configured ${role} provider ${configured} is not available`);
      return selected;
    };
    // One provider by default (ADR-024): claude takes every role it is not
    // pinned away from, so a default run's spend is one provider's spend and
    // Codex only ever appears because a run asked for it. Without an
    // authenticated claude adapter the first authenticated cloud adapter takes
    // every role instead; a pinned role is still honoured or refused above.
    const defaultCloud =
      cloud.find((provider) => provider.id === DEFAULT_CLOUD_PROVIDER_ID) ?? cloud[0]!;
    const planner = selectProvider('planner') ?? defaultCloud;
    const critic = selectProvider('critic') ?? defaultCloud;
    const builder = selectProvider('builder') ?? defaultCloud;
    const reviewer = selectProvider('reviewer') ?? defaultCloud;
    const cloudFor: Record<PipelineRole, ProviderAdapter> = { planner, critic, builder, reviewer };
    const adapters = new Map(available.map((provider) => [provider.id, provider] as const));
    let totalUsd = input.run.spent.usd;
    let totalTokens = input.run.spent.tokens;
    const accountUsage =
      (provider: ProviderAdapter, role: PipelineRole, model: string | null) =>
      async (usage: {
        inputTokens: number;
        cachedInputTokens?: number | undefined;
        outputTokens: number;
        usd: number;
      }) => {
        totalUsd += usage.usd;
        // Fresh tokens, not the raw total, so correcting the Claude adapter's
        // under-reporting in migration 008 does not shrink what a run may do.
        // See `freshTokens`.
        totalTokens += freshTokens(usage);
        await input.onEvent?.('usage.recorded', {
          provider: provider.id,
          role,
          ...(model ? { model } : {}),
          ...usage,
          totalUsd,
          totalTokens,
        });
        if (totalUsd > input.run.budget.maxUsd || totalTokens > input.run.budget.maxTokens)
          throw new Error('Run budget exceeded');
      };
    const recordSession =
      (provider: ProviderAdapter, role: PipelineRole) => async (sessionId: string) =>
        input.onEvent?.('provider.session', { provider: provider.id, role, sessionId });
    /**
     * Place a stage. Usage is read afresh every time so the previous stage's
     * spend counts. Residency is asked for only once the decision is local: it
     * is an HTTP round trip to Ollama and means nothing for a cloud stage. A
     * residency failure never fails the run; the decision is then annotated
     * as a cold load, the conservative reading.
     */
    const decide = async (
      role: PipelineRole,
      priorFailures: number,
      excluded: readonly string[],
    ): Promise<RoleRouteDecision> => {
      const usage = input.usageSource?.();
      const cloudId = cloudFor[role].id;
      const request = {
        role,
        priorFailures,
        availableProviderIds: [...adapters.keys()],
        excludeProviderIds: excluded,
        ...(isCloudProviderId(cloudId) ? { cloudProviderId: cloudId } : {}),
        ...(usage ? { usage } : {}),
        ...(input.ceiling ? { ceiling: input.ceiling } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      };
      const decision = routeRole(request);
      if (decision.tier === 3 || !input.residency) return decision;
      const residency = await input.residency().catch(() => undefined);
      return residency ? routeRole({ ...request, residency }) : decision;
    };
    const announce = (decision: RoleRouteDecision, priorFailures: number) =>
      input.onEvent?.('routing.decided', {
        role: decision.role,
        workClass: decision.workClass,
        tier: decision.tier,
        tierName: decision.tierName,
        providerId: decision.providerId,
        model: decision.model,
        reason: decision.reason,
        ceilingApplied: decision.ceilingApplied,
        estimatedUsd: decision.estimatedUsd,
        requiresLoad: decision.requiresLoad,
        estimatedLoadSeconds: decision.estimatedLoadSeconds,
        priorFailures,
        allowed: decision.allowed,
      });
    /**
     * Run one stage to completion: route it, call the provider, retry a
     * retryable error on the same provider with backoff, and on a
     * non-retryable error or exhausted retries route again with one more
     * failure, which for a cloud stage means the other cloud provider. A
     * refusal on the first decision is the ceiling policy speaking and ends
     * the run as a policy stop; a refusal while falling back means the
     * fallback is exhausted, and the stage fails with the provider's own
     * error, exactly as it did before routing existed.
     */
    const stage = async (role: PipelineRole, prompt: string): Promise<string> => {
      const failed: string[] = [];
      let decision = await decide(role, 0, failed);
      await announce(decision, 0);
      if (!decision.allowed || !decision.providerId)
        throw new StageRefused(decision.reason, 'safety_constraint');
      for (;;) {
        const providerId = decision.providerId;
        const provider = providerId ? adapters.get(providerId) : undefined;
        if (!provider) throw new Error(`${role} routed to unregistered provider ${providerId}`);
        const model = decision.model;
        let attempt = 1;
        let error: ProviderError;
        for (;;) {
          const before =
            role === 'builder' ? await workspaceSnapshot(runtime, workspace) : undefined;
          const outcome = await collectProvider({
            provider,
            run: input.run,
            role,
            prompt,
            model,
            cwd: workspace,
            ...(input.signal ? { signal: input.signal } : {}),
            onUsage: accountUsage(provider, role, model),
            onSession: recordSession(provider, role),
            ...(input.stageTimeoutMs === undefined ? {} : { stageTimeoutMs: input.stageTimeoutMs }),
            ...(input.stageTimeoutSignal ? { stageTimeoutSignal: input.stageTimeoutSignal } : {}),
          });
          if (outcome.ok) return outcome.text;
          error = outcome.error;
          // A paused or cancelled run is aborted from outside; nothing is
          // retried or substituted on its behalf.
          if (input.signal?.aborted) throw providerFailure(provider, error);
          if (before !== undefined && (await workspaceSnapshot(runtime, workspace)) !== before) {
            // A failed builder attempt must leave the worktree as it found it
            // before another attempt runs on top of it. Through the worker
            // that holds by construction: apps/worker executeProviderJob
            // captures a patch only when no error event was emitted, and the
            // coordinator's WorkerProviderAdapter applies a patch only when one
            // came back, so a failure never touches this worktree. An adapter
            // that edits the worktree directly has no such guarantee, and a
            // retry on top of partial edits would compound them, so the stage
            // fails here with the worktree preserved for inspection.
            throw new Error(
              `${provider.id}: ${error.code}: ${error.message} (builder left partial edits in the worktree; not retrying)`,
            );
          }
          if (!error.retryable || attempt >= MAX_ATTEMPTS_PER_PROVIDER) break;
          const delayMs = retryDelayMs(attempt, input.backoff ?? DEFAULT_BACKOFF);
          await input.onEvent?.('provider.retry', {
            role,
            provider: provider.id,
            code: error.code,
            message: error.message,
            attempt,
            delayMs,
          });
          await sleep(delayMs, input.signal);
          attempt += 1;
        }
        failed.push(provider.id);
        const next = await decide(role, failed.length, failed);
        if (!next.allowed || !next.providerId) throw providerFailure(provider, error);
        await input.onEvent?.('provider.fallback', {
          role,
          from: provider.id,
          to: next.providerId,
          code: error.code,
          message: error.message,
          attempt,
          reason: next.reason,
        });
        await announce(next, failed.length);
        decision = next;
      }
    };
    const context = (await runGit(['status', '--short', '--branch'], workspace)).stdout;
    let plan = input.checkpoint?.plan;
    let critique = input.checkpoint?.critique;
    let revised = input.checkpoint?.revisedPlan;
    let review = '';
    let checkResults: CheckResult[] = [];
    try {
      if (!plan) {
        plan = await stage(
          'planner',
          `Create an executable implementation plan for this objective: ${objective}${constraintBlock}\nRepository status:\n${context}\nReturn acceptance criteria, file ownership, risks, and exact checks. Do not edit files yet.`,
        );
        await input.onEvent?.('plan.completed', { provider: planner.id, plan });
      }
      if (!critique) {
        critique = await stage(
          'critic',
          `Independently critique this plan against the objective, its constraints, security policy, missing tests, and unverifiable claims. Return concrete findings. A plan that respects a constraint is not deficient for doing so; say when a constraint is what limits it.${constraintBlock}\n\n${plan}`,
        );
        await input.onEvent?.('critique.completed', { provider: critic.id, critique });
      }
      if (!revised) {
        revised = await stage(
          'planner',
          // "resolve every critique" was the scope-inflation mechanism. The
          // critic correctly spotted a real off-by-one in the module under test,
          // and an unconditional instruction to resolve every finding turned
          // that into "change the production file" - which the objective's
          // constraints forbade. A critique that cannot be acted on within the
          // constraints is now recorded rather than implemented.
          `Revise the plan by resolving every evidence-backed critique that can be resolved within the objective and its constraints. Preserve the objective and do not widen its scope. Where a critique cannot be addressed without breaking a constraint, leave the plan as it is and note the finding for the pull request description instead.${constraintBlock}\nPLAN:\n${plan}\nCRITIQUE:\n${critique}`,
        );
        await input.onEvent?.('plan.revised', { provider: planner.id, revised });
      }
      if (!input.checkpoint?.built) {
        await stage(
          'builder',
          `Implement the revised plan fully in the assigned Git worktree. You may edit only this worktree. Do not push, merge, expose secrets, or weaken tests. Run relevant local checks and leave all intended changes in the worktree. If the plan asks for anything a constraint forbids, skip that step and say so rather than doing it.${constraintBlock}\nOBJECTIVE:\n${objective}\nREVISED PLAN:\n${revised}`,
        );
        await input.onEvent?.('build.completed', { provider: builder.id, workspace });
      }
      checkResults = await runVerification(
        input.install ?? [],
        input.checks,
        workspace,
        input.workspaceRoot,
        input.signal,
        input.checkRunner,
      );
      await input.onEvent?.('verification.completed', {
        passed: checkResults.every((check) => check.code === 0),
        checks: checkResults,
      });
      if (checkResults.some((check) => check.code !== 0)) {
        return {
          status: 'partially_completed',
          workspace,
          plan: revised,
          critique,
          review: 'Deterministic checks failed before review.',
          checks: checkResults,
          blocker: 'Repair failing deterministic checks in the preserved worktree.',
        };
      }
      for (let round = 0; round < 3; round++) {
        // Including new files. `git diff` shows none, and a new file is the
        // whole of the work for an objective like "add the missing tests" - so
        // the reviewer used to be sent an empty diff and approved on nothing.
        // The summary is named in the prompt only when the diff is cut, so the
        // reviewer knows which files it did not see.
        const { diff, stat: changedFiles } = await runtime.diffWithUntracked(workspace);
        // Taken before the stage and compared after it, so the read-only rule
        // holds across a retry or a substitution inside the stage as well.
        const reviewSnapshot = await workspaceSnapshot(runtime, workspace);
        review = await stage(
          'reviewer',
          buildReviewPrompt({ objective, constraints, plan: revised, diff, changedFiles }),
        );
        if ((await workspaceSnapshot(runtime, workspace)) !== reviewSnapshot) {
          return {
            status: 'partially_completed',
            workspace,
            plan: revised,
            critique,
            review,
            checks: checkResults,
            blocker: 'Reviewer modified the assigned worktree; review must be read-only.',
          };
        }
        const verdict = parseReview(review);
        // When parsing fails, keep an excerpt of the raw reviewer text. Previously
        // only the parsed result was persisted, so the one case that most needs
        // the original output for diagnosis was the case without it - the evidence
        // for BLK-010 had to be recovered indirectly from a later repair prompt.
        // `review` is already redacted and boundary-checked upstream.
        const unparsed = verdict.findings.some(
          (finding) =>
            finding.claim === 'Reviewer output lacked a valid verdict' ||
            finding.claim === 'Reviewer verdict JSON was invalid',
        );
        await input.onEvent?.('review.completed', {
          round: round + 1,
          ...verdict,
          ...(unparsed ? { rawReviewExcerpt: review.slice(0, 4000) } : {}),
        });
        if (verdict.approved) break;
        if (round === 2) {
          return {
            status: 'partially_completed',
            workspace,
            plan: revised,
            critique,
            review,
            checks: checkResults,
            blocker: 'Review findings remain after the maximum three repair rounds.',
          };
        }
        // Only the findings that withheld approval reach the builder; see
        // renderRepairPrompt for why the whole review text no longer does.
        // Taken before the repair so the next round can be told apart from this
        // one. A repair that changes nothing cannot change the verdict either.
        const beforeRepair = await workspaceSnapshot(runtime, workspace);
        await stage('builder', renderRepairPrompt(verdict.findings));
        if ((await workspaceSnapshot(runtime, workspace)) === beforeRepair) {
          // On attempt fourteen of the first real objective the reviewer
          // correctly reported a file as modified that no agent had touched -
          // the workspace was checked out CRLF against LF blobs - so the repair
          // builder had nothing it could do and changed nothing. The two
          // remaining rounds then re-reviewed an identical workspace, were
          // served from the job idempotency cache in the same second, and the
          // run reported "findings remain after the maximum three repair
          // rounds". True, and the wrong thing to be told: the record pointed
          // at a stubborn reviewer rather than at a repair that could not act.
          return {
            status: 'partially_completed',
            workspace,
            plan: revised,
            critique,
            review,
            checks: checkResults,
            blocker:
              'The repair round left the worktree unchanged, so a further review would reach the same verdict; the findings above are what it was asked to address.',
          };
        }
        checkResults = await runVerification(
          input.install ?? [],
          input.checks,
          workspace,
          input.workspaceRoot,
          input.signal,
          input.checkRunner,
        );
        if (checkResults.some((check) => check.code !== 0)) {
          return {
            status: 'partially_completed',
            workspace,
            plan: revised,
            critique,
            review,
            checks: checkResults,
            blocker: 'Deterministic checks failed after repair.',
          };
        }
      }
    } catch (error) {
      if (!(error instanceof StageRefused)) throw error;
      // The same shape a failed check ends with, so the coordinator records
      // the blocker from the result; the classification says it was policy.
      return {
        status: 'partially_completed',
        workspace,
        plan: revised ?? plan ?? '',
        critique: critique ?? '',
        review,
        checks: checkResults,
        blocker: error.blocker,
        classification: error.classification,
      };
    }
    checkResults = await runVerification(
      input.install ?? [],
      input.checks,
      workspace,
      input.workspaceRoot,
      input.signal,
      input.checkRunner,
    );
    if (checkResults.some((check) => check.code !== 0)) {
      return {
        status: 'partially_completed',
        workspace,
        plan: revised,
        critique,
        review,
        checks: checkResults,
        blocker: 'Final deterministic checks failed; integration is prohibited.',
      };
    }
    await runGit(['add', '--all'], workspace);
    let commit: string;
    try {
      commit = await runtime.commit(
        workspace,
        `forge: ${input.run.objective.slice(0, 64)}`,
        input.github?.approvedSecretDigest,
      );
    } catch (error) {
      if (!(error instanceof SecretScanRefusal)) throw error;
      // Not a failure: a question. The staged changes stay exactly as they are,
      // and the digest pins them, so the approval a person gives cannot carry
      // over to different content. See GitWorkspaceRuntime.commit.
      await input.onEvent?.('integration.secret_scan_matched', {
        digest: error.digest,
        evidence: error.evidence,
      });
      return {
        status: 'partially_completed',
        workspace,
        plan: revised,
        critique,
        review,
        checks: checkResults,
        secretScan: { digest: error.digest, evidence: error.evidence },
        blocker:
          'The commit-time secret scan matched; approve the staged changes to commit and push them.',
      };
    }
    await input.onEvent?.('integration.committed', { commit });
    if (!input.github?.pushApproved) {
      return {
        status: 'partially_completed',
        workspace,
        commit,
        plan: revised,
        critique,
        review,
        checks: checkResults,
        blocker: 'Approve push of the isolated non-protected branch and draft PR creation.',
      };
    }
    await runGit(['push', '--set-upstream', 'origin', input.branch], workspace);
    const github = new GitHubIntegration(input.github.token);
    const pullRequest = await github.createDraftPullRequest(
      input.github.owner,
      input.github.repo,
      input.branch,
      input.baseRef,
      input.run.objective.slice(0, 120),
      `Automated by TheForge.\n\nChecks:\n${checkResults.map((check) => `- ${check.command}: ${check.code === 0 ? 'pass' : 'fail'}`).join('\n')}`,
    );
    await input.onEvent?.('integration.pull_request_created', { url: pullRequest.url });
    // The branch is on the remote and the pull request exists, so the worktree
    // holds nothing unique. Every other outcome above keeps it: resume and
    // inspection need it (docs/OPERATIONS.md "Worktrees and retries").
    await cleanupWorkspace(runtime, input, workspaceTaskId, workspace);
    return {
      status: 'completed',
      workspace,
      commit,
      pullRequestUrl: pullRequest.url,
      plan: revised,
      critique,
      review,
      checks: checkResults,
    };
  }
}

function providerFailure(provider: ProviderAdapter, error: ProviderError): Error {
  return new Error(`${provider.id}: ${error.code}: ${error.message}`);
}

/**
 * Remove a completed run's worktree and say so. Called only once the branch
 * is pushed and the pull request exists. A directory that will not go - a
 * Windows file lock, most often - is reported rather than fatal: the run is
 * complete either way, and the next createWorktree for the same task id
 * prunes and recreates over whatever is left.
 */
async function cleanupWorkspace(
  runtime: GitWorkspaceRuntime,
  input: AutonomousPipelineInput,
  taskId: string,
  workspace: string,
): Promise<void> {
  try {
    await runtime.cleanup(input.projectId, taskId);
  } catch (error) {
    await input.onEvent?.('workspace.cleanup_failed', {
      workspace,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await input.onEvent?.('workspace.cleaned', { workspace });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () =>
      signal?.reason instanceof Error ? signal.reason : new Error('Provider retry cancelled');
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One provider attempt. An error event ends the attempt and is returned
 * rather than thrown, so the stage above can decide between a retry, a
 * substitution and a failure with the retryable flag in hand.
 */
async function collectProvider(options: {
  provider: ProviderAdapter;
  run: Run;
  role: PipelineRole;
  prompt: string;
  /** Set only for a local decision; a cloud adapter chooses its own model. */
  model: string | null;
  cwd: string;
  signal?: AbortSignal;
  onUsage?: (usage: {
    inputTokens: number;
    cachedInputTokens?: number | undefined;
    outputTokens: number;
    usd: number;
  }) => Promise<void>;
  /** Wall clock for this attempt; `DEFAULT_STAGE_TIMEOUT_MS` when unset. */
  stageTimeoutMs?: number;
  /** Builds that wall clock's signal; the coordinator's ignores halted time. */
  stageTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  onSession?: (sessionId: string) => Promise<void> | void;
}): Promise<CollectOutcome> {
  const { provider, run, role, prompt, model, cwd } = options;
  let text = '';
  let terminal: unknown;
  let reportedSessionId: string | undefined;
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const timeoutSignal =
    options.stageTimeoutSignal?.(stageTimeoutMs) ?? AbortSignal.timeout(stageTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  // `model` joins ProviderRequest with the provider slice; the spread keeps
  // this compiling with and without the field.
  const request: ProviderRequest = {
    runId: run.id,
    taskId: `${run.id}-${role}`,
    role,
    prompt,
    context: [],
    timeoutMs: stageTimeoutMs,
    ...(model ? { model } : {}),
  };
  for await (const event of provider.run(request, { cwd, signal })) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'session' && event.sessionId !== reportedSessionId) {
      reportedSessionId = event.sessionId;
      await options.onSession?.(event.sessionId);
    }
    if (event.type === 'usage') await options.onUsage?.(event);
    if (event.type === 'completed') {
      terminal = event.output;
      if (event.sessionId && event.sessionId !== reportedSessionId) {
        reportedSessionId = event.sessionId;
        await options.onSession?.(event.sessionId);
      }
    }
    if (event.type === 'error')
      return {
        ok: false,
        error: { code: event.code, message: event.message, retryable: event.retryable },
      };
  }
  if (!text && typeof terminal === 'string') text = terminal;
  if (!text.trim())
    return {
      ok: false,
      error: {
        code: 'EMPTY_OUTPUT',
        message: `${provider.id} returned no usable ${role} output`,
        retryable: false,
      },
    };
  return { ok: true, text: assertUntrustedText(redactSecrets(text)) };
}

async function workspaceSnapshot(runtime: GitWorkspaceRuntime, workspace: string) {
  return [
    await runtime.status(workspace),
    await runtime.diff(workspace),
    await runtime.diff(workspace, true),
    await untrackedContent(workspace),
  ].join('\n---\n');
}

/**
 * Each untracked file's path and the hash of its contents.
 *
 * Without this a snapshot cannot tell two versions of a NEW file apart:
 * `git status` says only `?? path`, and `git diff` ignores untracked files
 * entirely. A new file is exactly what a builder asked to write tests produces,
 * so both callers were blind to the case that matters most - the no-change
 * repair check below would have called an edited test file unchanged, and the
 * reviewer read-only check would not have noticed a reviewer rewriting one.
 *
 * `hash-object` reads the files and writes nothing, which is why it is used
 * here rather than the worker's `git add --intent-to-add --all`: that mutates
 * the index, and one of these two callers is a read-only guard.
 */
async function untrackedContent(workspace: string): Promise<string> {
  const listed = await runGit(['ls-files', '--others', '--exclude-standard'], workspace);
  const paths = listed.stdout.split(/\r?\n/).filter(Boolean).sort();
  if (paths.length === 0) return '';
  const hashed = await runGit(['hash-object', '--', ...paths], workspace);
  const hashes = hashed.stdout.split(/\r?\n/).filter(Boolean);
  return paths.map((path, index) => `${hashes[index] ?? 'unhashed'} ${path}`).join('\n');
}

export type ReviewFinding = {
  severity: 'low' | 'medium' | 'high' | 'critical';
  claim: string;
  action: string;
};

/**
 * Bytes of diff the reviewer is shown. The diff used to be interpolated into
 * the prompt whole, so one large generated file could push the objective and
 * the plan out of the reviewer's context, or overflow it. 200 KB is about 50k
 * tokens: room for any change this pipeline should merge in one run, inside
 * every cloud provider's window, with space left for the reviewer's own
 * reasoning. Past the limit the diff is cut at a line boundary and the
 * reviewer is told how much it did not see and which files changed.
 */
export const REVIEW_DIFF_LIMIT_BYTES = 200 * 1024;

/**
 * The reviewer's brief. It defines the severity scale that parseReview
 * applies, so what the reviewer is told blocks a merge is what blocks it, and
 * asks for findings the diff supports with the file and hunk cited. The
 * closing sentence is the verdict contract parseReview reads; keep it as is.
 * The first live run withheld approval over an import split across two
 * lines, and the repair round went to that; the scale puts formatting at
 * `low` and says `low` never blocks.
 */
export function buildReviewPrompt(input: {
  objective: string;
  /** The run's constraints, already sanitised; empty when it set none. */
  constraints?: readonly string[];
  plan: string;
  diff: string;
  /** `git diff --stat` of the same worktree; shown only when the diff is cut. */
  changedFiles: string;
  /** Tests cut a small diff; the pipeline uses the constant. */
  limitBytes?: number;
}): string {
  const limit = input.limitBytes ?? REVIEW_DIFF_LIMIT_BYTES;
  const bytes = Buffer.from(input.diff, 'utf8');
  let diffSection = `DIFF:\n${input.diff}`;
  if (bytes.length > limit) {
    // Cut at the last line break inside the limit so no hunk line is split
    // (and no multibyte character, since '\n' is a single byte).
    const newline = bytes.lastIndexOf(0x0a, limit);
    const cut = newline > 0 ? newline : limit;
    diffSection =
      `DIFF (diff truncated: first ${cut} bytes shown, ${bytes.length - cut} more bytes not shown; the file list below is complete):\n` +
      `${bytes.subarray(0, cut).toString('utf8')}\n` +
      `CHANGED FILES (git diff --stat):\n${input.changedFiles}`;
  }
  return [
    'Review the actual diff against the objective and the revised plan. Be evidence-based: report only findings the diff supports, and cite the file and the hunk in every claim.',
    'Severity scale:',
    '- critical: the change is wrong, unsafe, or violates the objective or a constraint.',
    '- high: must be fixed before merge - a real defect, a missing test for changed behaviour, or a security or data-loss risk.',
    '- medium: should be fixed; does not block the merge.',
    '- low: style, naming, formatting; never blocks.',
    'Formatting, import ordering, and whitespace are never above low.',
    'Set "approved" to true when there is no high or critical finding.',
    'End with a JSON object {"approved":boolean,"findings":[{"severity":"low|medium|high|critical","claim":"...","action":"..."}]}.',
    `OBJECTIVE:\n${input.objective}`,
    // A diff that breaks a stated constraint is a finding, and the reviewer
    // cannot make it if it never learns the constraints.
    ...(input.constraints?.length
      ? [
          `CONSTRAINTS (a change that breaks one of these is a critical finding, however good it is otherwise):\n${input.constraints
            .map((constraint) => `- ${constraint}`)
            .join('\n')}`,
        ]
      : []),
    `PLAN:\n${input.plan}`,
    diffSection,
  ].join('\n');
}

/** The findings that withhold approval: high and critical, nothing below. */
export function blockingFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter(
    (finding) => finding.severity === 'high' || finding.severity === 'critical',
  );
}

/**
 * The builder's repair brief: the blocking findings only, numbered, each with
 * the reviewer's claim and requested action. The previous brief pasted the
 * whole review text under "Repair every review finding", so a reviewer that
 * withheld approval over style spent one of the three repair rounds on style.
 * Low and medium findings stay on the review.completed payload, where the
 * coordinator records them as Findings; they are not repaired here.
 */
export function renderRepairPrompt(findings: readonly ReviewFinding[]): string {
  const blocking = blockingFindings(findings);
  const list = blocking
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.claim}\n   Action: ${finding.action}`,
    )
    .join('\n');
  return (
    'Repair the blocking review findings listed below, and nothing else: do not act on lower-severity findings, do not restyle or reformat code the findings do not name, and do not widen the change. Add new evidence for each repair and rerun the relevant checks. Do not push.\n' +
    `BLOCKING FINDINGS (${blocking.length}):\n${list}`
  );
}

/**
 * Extract every balanced top-level `{...}` span from free text.
 *
 * Providers wrap structured verdicts in prose, markdown fences, or both, and
 * may emit more than one object. Brace counting is string-aware so a `{` or `}`
 * inside a JSON string value does not unbalance the scan.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse a reviewer verdict out of provider output.
 *
 * The previous implementation required the verdict to be the final content of
 * the response *and* to open with `"approved"`:
 *
 *   text.match(/\{\s*"approved"[\s\S]*\}\s*$/)
 *
 * That is not start-anchored, so leading prose was always fine. What it could
 * not survive, verified against the old expression case by case:
 *   - any trailing prose after the verdict, because of the `\}\s*$` anchor;
 *   - a markdown fence, which ends in ``` rather than `}`;
 *   - `approved` appearing anywhere but first in the object;
 *   - two objects in one response, where the greedy `[\s\S]*` spans from the
 *     first `{` to the last `}` and yields unparsable text.
 *
 * Run fbc717e6 spent its entire three-round repair budget on the resulting
 * "Reviewer output lacked a valid verdict" finding while the review itself was
 * fine. That specific claim means the expression did not match at all, which
 * rules out the two-object case and leaves trailing prose, a fence, or key
 * order. See BLK-010.
 *
 * Now: scan for any balanced JSON object carrying an `approved` key, wherever
 * it sits and whatever the key order, and take the last one so a model that
 * revises itself is read at its final answer.
 *
 * Approval is decided by the findings, not by the flag: the round is approved
 * when no finding is high or critical, the rule the prompt states. The
 * reviewer's own `approved` is advisory. When it withholds approval while
 * reporting nothing that blocks, the result is approved with
 * `approvedByPolicy` set, so the disagreement is visible on review.completed
 * instead of costing a repair round, which is what the first live run spent
 * on a split import. `approved: true` beside a high finding is still not
 * approved. Without a parseable verdict the one synthetic finding is high, so
 * that case is never approved.
 */
// Exported for direct testing: a brittle version of this function consumed an
// entire three-round repair budget in run fbc717e6 (BLK-010), so its behaviour
// against real provider output shapes is covered explicitly.
export function parseReview(text: string): {
  approved: boolean;
  findings: ReviewFinding[];
  /** Present only when the reviewer withheld approval but nothing blocks. */
  approvedByPolicy?: true;
} {
  const candidates = extractJsonObjects(text);
  let verdict: { approved?: unknown; findings?: unknown } | undefined;
  let sawUnparsableObject = false;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      sawUnparsableObject = true;
      continue;
    }
    // The `in` check narrows `value` sufficiently; an assertion here is redundant.
    if (typeof value === 'object' && value !== null && 'approved' in value) {
      verdict = value;
    }
  }
  if (!verdict)
    return {
      approved: false,
      findings: [
        invalidReviewFinding(
          sawUnparsableObject
            ? 'Reviewer verdict JSON was invalid'
            : 'Reviewer output lacked a valid verdict',
        ),
      ],
    };
  const findings = Array.isArray(verdict.findings)
    ? verdict.findings.map(normalizeReviewFinding)
    : [];
  const approved = blockingFindings(findings).length === 0;
  return {
    approved,
    findings,
    ...(approved && verdict.approved !== true ? { approvedByPolicy: true as const } : {}),
  };
}

function normalizeReviewFinding(value: unknown): ReviewFinding {
  if (typeof value !== 'object' || value === null)
    return invalidReviewFinding(
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : 'Reviewer returned an empty finding',
    );
  const record = value as Record<string, unknown>;
  const severity = ['low', 'medium', 'high', 'critical'].includes(String(record.severity))
    ? (String(record.severity) as ReviewFinding['severity'])
    : 'medium';
  const claim =
    typeof record.claim === 'string' && record.claim.trim()
      ? record.claim.trim()
      : 'Unspecified review finding';
  const action =
    typeof record.action === 'string' && record.action.trim()
      ? record.action.trim()
      : 'Review and resolve the finding';
  return { severity, claim, action };
}

function invalidReviewFinding(claim: string): ReviewFinding {
  return { severity: 'high', claim, action: 'Return a valid evidence-backed reviewer verdict' };
}

/**
 * How a command is run for verification. The coordinator's sends it to a worker
 * as a sandboxed job; the tests and the local executor spawn it here.
 */
export type CheckRunner = (
  action: {
    executable: string;
    args: string[];
    cwd: string;
    /**
     * `install` asks the worker to run this command in a container with network
     * access, so a project's dependencies can be fetched. Set only for a
     * project's declared install commands; checks never carry it.
     */
    network?: 'install';
    /**
     * Run these commands in order instead, in one workspace, each in its own
     * container. `executable`/`args` repeat the first of them so that a reader
     * of the action's command still sees something true.
     */
    steps?: VerificationStep[];
  },
  signal?: AbortSignal,
) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
  steps?: Array<{ command: string; code: number; stdout: string; stderr: string }>;
}>;

type VerificationStep = {
  executable: string;
  args: string[];
  network?: 'install';
  /** End the sequence if this one fails; set for an install, not for a check. */
  stopOnFailure?: boolean;
};

/**
 * One verification: the project's install commands with network access, then
 * its checks sealed, in one workspace.
 *
 * A project with no install commands takes exactly the path it always did - one
 * runner call per check - so nothing changes for one.
 *
 * With install commands it is a single stepped job, because a worker's
 * workspace does not outlive a job: it materialises `.job-<id>` and removes it
 * in a `finally`. An install in a job of its own therefore installs into a
 * directory that is then deleted, which is how `npm ci` exited 0 on attempt
 * eleven of the first real objective and the three checks that needed its
 * output each still reported 127.
 *
 * This runs before every verification rather than once per run, including after
 * a repair, for the same reason: each verification is a new job with a new copy
 * of the workspace, so the dependencies must be fetched again.
 *
 * Install commands are marked `stopOnFailure` and checks are not: a failed
 * install makes the checks meaningless, while a failed check must not stop the
 * others, because a lint failure hiding a test failure costs a whole extra
 * repair round.
 */
async function runVerification(
  install: Array<{ executable: string; args: string[] }>,
  checks: Array<{ executable: string; args: string[] }>,
  workspace: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  runner?: CheckRunner,
) {
  const assertAllowlisted = (
    command: { executable: string; args: string[] },
    label: string,
  ): void => {
    // An install command is still a command, and being granted network is not a
    // reason to skip classifying it.
    if (
      classifyAction(
        { executable: command.executable, args: command.args, cwd: workspace },
        workspaceRoot,
      ).class !== 'green'
    ) {
      throw new Error(`${label} is not allowlisted: ${command.executable}`);
    }
  };
  for (const step of install) assertAllowlisted(step, 'Install command');
  for (const check of checks) assertAllowlisted(check, 'Verification command');
  if (install.length === 0) return runChecks(checks, workspace, workspaceRoot, signal, runner);
  const steps: VerificationStep[] = [
    ...install.map((step) => ({ ...step, network: 'install' as const, stopOnFailure: true })),
    ...checks.map((check) => ({ executable: check.executable, args: check.args })),
  ];
  const first = steps[0];
  if (!first) throw new Error('A stepped verification needs at least one command');
  if (!runner) {
    // The local executor runs in the real directory, which outlives nothing but
    // also is not copied, so a sequence here is only a loop.
    const outcomes = [];
    for (const step of steps) {
      const result = await spawnCheck(step.executable, step.args, workspace, signal);
      outcomes.push(result);
      if (result.code !== 0 && step.stopOnFailure) break;
    }
    return outcomes;
  }
  const result = await runner(
    { executable: first.executable, args: first.args, cwd: workspace, steps },
    signal,
  );
  const outcomes = result.steps ?? [];
  // The transport allowlists the fields it carries, so a `steps` it does not
  // know about is dropped in silence - which is how #51 shipped with the
  // network flag stripped. Without these two checks that failure would look
  // like a verification that ran one command and passed.
  if (outcomes.length === 0) {
    // Deliberately not "did not reach the worker". On attempt twelve they
    // reached it and every command ran; what was dropped was the result on the
    // way back, and the message sent the investigation to the wrong leg.
    throw new Error(
      'A stepped verification came back with no step results: the steps did not survive the round trip',
    );
  }
  if (outcomes.length < steps.length && outcomes.every((outcome) => outcome.code === 0)) {
    throw new Error(
      `A stepped verification ran ${outcomes.length} of ${steps.length} commands and reported none of them failing`,
    );
  }
  return outcomes;
}

async function runChecks(
  checks: Array<{ executable: string; args: string[] }>,
  workspace: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  runner?: CheckRunner,
) {
  const results = [];
  for (const check of checks) {
    const action = { ...check, cwd: workspace };
    if (classifyAction(action, workspaceRoot).class !== 'green') {
      throw new Error(`Verification command is not allowlisted: ${check.executable}`);
    }
    const result = runner
      ? await runner(action, signal)
      : await spawnCheck(check.executable, check.args, workspace, signal);
    results.push({ command: [check.executable, ...check.args].join(' '), ...result });
  }
  return results;
}

function spawnCheck(executable: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ command: string; code: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(executable, args, { cwd, shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout.on(
        'data',
        (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-1_000_000)),
      );
      child.stderr.on(
        'data',
        (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-1_000_000)),
      );
      child.on('error', (error) =>
        resolve({
          command: [executable, ...args].join(' '),
          code: -1,
          stdout,
          stderr: error.message,
        }),
      );
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        resolve({ command: [executable, ...args].join(' '), code: code ?? -1, stdout, stderr });
      });
    },
  );
}
