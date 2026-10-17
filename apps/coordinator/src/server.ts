import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_PATCH_BYTES,
  MAX_RAW_TAIL_BYTES,
  RunSchema,
  TaskSchema,
  ProviderEventSchema,
  ProviderRequestSchema,
  RunConfigurationSchema,
  EnvironmentError,
  formatEnvironmentError,
  providerIds,
  type AgentMessage,
  type Approval,
  type Artifact,
  type Blocker,
  type Decision,
  type Finding,
  type ForgeEvent,
  type ProviderId,
  type ProviderRequest,
  type Run,
  type Task,
  roles,
  type UsageRecord,
  type Worker,
} from '@theforge/contracts';
import {
  createDatabase,
  PostgresForgeRepository,
  type ReclaimedWorkerJobLease,
  type WorkerJob,
  type WorkerJobAction,
  type WorkerWorkspaceSnapshot,
} from '@theforge/db';
import {
  applyGitPatch,
  GitHubIntegration,
  GitWorkspaceRuntime,
  pushBranchWithGitHubToken,
  runGit,
  SecretScanRefusal,
} from '@theforge/git-runtime';
import type { ProviderAdapter } from '@theforge/providers';
import { ForgeLogger, Metrics } from '@theforge/observability';
import {
  actionDigest,
  classifyAction,
  normalizeAction,
  redactSecrets,
  secretEquals,
} from '@theforge/policy';
import { checkRedis, MemoryTaskQueue, RedisTaskQueue } from '@theforge/queue';
import {
  AutonomousPipeline,
  PROVIDER_WAIT_POLL_MS,
  ProviderWaitExpired,
} from '@theforge/workflows';
import {
  budgetConfigFromValues,
  ceilingConfigFromValues,
  checkHalt,
  readHaltFile,
  removeHaltFile,
  resolveHaltFilePath,
  TIER_MODELS,
  toGuardUsage,
  writeHaltFile,
} from '@theforge/guardrails';
import { createNotifierFromEnv } from '@theforge/notify';

import { environmentFileDescription, loadEnvironment, type CoordinatorEnvironment } from './env.js';
import { Guards, type SpendRefusal } from './guards.js';
import { providerAvailability } from './provider-diagnostic.js';
import { createEscalationHook } from './escalation.js';

/**
 * Configuration is the one failure an operator has to fix by hand, so it is
 * reported as one line per variable with a remedy, not as a zod stack trace.
 */
function loadCoordinatorEnvironment(): CoordinatorEnvironment {
  try {
    return loadEnvironment();
  } catch (error) {
    if (!(error instanceof EnvironmentError)) throw error;
    console.error(formatEnvironmentError(error, environmentFileDescription()));
    process.exit(1);
  }
}
const env = loadCoordinatorEnvironment();
const app = Fastify({ logger: false, bodyLimit: 16_000_000 });
await app.register(cors, { origin: env.FORGE_WEB_ORIGIN });
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const workerEndpoint =
    request.url === '/api/workers/register' ||
    /^\/api\/workers\/[^/]+\/(?:heartbeat|jobs(?:\/|\?|$))/.test(request.url);
  if (workerEndpoint) return;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(token, env.FORGE_COORDINATOR_TOKEN)) {
    return reply.code(401).send({ error: 'coordinator_token_invalid' });
  }
});
const logger = new ForgeLogger();
const metrics = new Metrics();
const sql = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : undefined;
const durable = sql ? new PostgresForgeRepository(sql) : undefined;
const jobQueue = env.REDIS_URL
  ? new RedisTaskQueue(env.REDIS_URL, 'theforge:worker-jobs')
  : new MemoryTaskQueue();
const runs = new Map<string, Run>();
type Project = {
  id: string;
  name: string;
  repositoryUrl: string;
  baseRef: string;
  checks: Array<{ executable: string; args: string[] }>;
  /**
   * Commands that fetch dependencies, run before the checks in a container
   * that HAS network access and runs nothing else. Per project and empty by
   * default (Dan's decision, 05/10/2026): a project that does not ask for it
   * keeps a sandbox with no network at all, so a new project cannot silently
   * inherit a weaker boundary.
   */
  install: Array<{ executable: string; args: string[] }>;
};
const projects = new Map<string, Project>();
const tasks = new Map<string, Task[]>();
const workers = new Map<string, Worker>();
const workerSessions = new Map<string, { workerId: string; expiresAt: number }>();
const workerJobs = new Map<string, WorkerJob>();
/**
 * Kill switch. Policy B13 requires both a command and a file because they fail
 * differently: a command needs a responsive process and a working shell, while
 * a file can be created from anywhere - a file manager, a network share, a
 * phone. The file is the only state. The API writes and removes it rather than
 * keeping a flag in memory, so a halt survives a restart and the CLI, the API
 * and a hand-made file can never disagree about whether the system is stopped.
 */
const haltFilePath = resolveHaltFilePath({
  workspaceRoot: env.FORGE_WORKSPACE_ROOT,
  haltFile: env.FORGE_HALT_FILE,
});
/**
 * Escalation to Dan (policy B9, B11). Built once from the validated
 * environment; without FORGE_HA_TOKEN and FORGE_SMTP_PASSWORD it degrades to
 * the file outbox, which is always on. The suite gets a throwaway outbox under
 * the temporary directory so a test run never writes into the real one.
 */
const escalations = createEscalationHook({
  notifier: createNotifierFromEnv(
    {
      FORGE_HA_URL: env.FORGE_HA_URL,
      FORGE_HA_TOKEN: env.FORGE_HA_TOKEN,
      FORGE_HA_NOTIFY_SERVICE: env.FORGE_HA_NOTIFY_SERVICE,
      FORGE_SMTP_HOST: env.FORGE_SMTP_HOST,
      FORGE_SMTP_PORT: String(env.FORGE_SMTP_PORT),
      FORGE_SMTP_USER: env.FORGE_SMTP_USER,
      FORGE_SMTP_PASSWORD: env.FORGE_SMTP_PASSWORD,
      FORGE_NOTIFY_EMAIL_TO: env.FORGE_NOTIFY_EMAIL_TO,
      FORGE_WORKSPACE_ROOT: env.FORGE_WORKSPACE_ROOT,
      FORGE_OUTBOX_DIR:
        env.FORGE_OUTBOX_DIR ??
        (process.env.NODE_ENV === 'test'
          ? resolve(tmpdir(), `theforge-outbox.test-${randomUUID()}`)
          : undefined),
    },
    { log: (line) => logger.log({ level: 'warn', message: line }) },
  ).notifier,
  recorder: durable,
  log: (level, message, runId) => logger.log({ level, message, ...(runId ? { runId } : {}) }),
  context: (runId) => {
    const run = runs.get(runId);
    const project = run ? projects.get(run.projectId) : undefined;
    return {
      ...(project ? { project: project.name } : {}),
      ...(run ? { task: run.objective.slice(0, 80) } : {}),
    };
  },
});

const approvals = new Map<string, Approval>();
const integrationExecutions = new Set<string>();
const pendingIntegrations = new Map<
  string,
  {
    runId: string;
    workspace: string;
    branch: string;
    baseRef: string;
    repositoryUrl: string;
    /**
     * The commit the approval was raised against, pinned so an approval cannot
     * push content nobody looked at. Absent when the commit has not been made
     * yet, which happens when the secret scan matched: then `secretDigest`
     * pins the staged diff instead and the commit is made on approval.
     */
    commit?: string;
    secretDigest?: string;
  }
>();
const activeExecutions = new Map<string, AbortController>();
const events = new Map<string, Array<Record<string, unknown>>>();
const messages = new Map<string, AgentMessage[]>();
const findings = new Map<string, Finding[]>();
const decisions = new Map<string, Decision[]>();
const blockers = new Map<string, Blocker[]>();
const artifacts = new Map<string, Artifact[]>();
const usageRecords = new Map<string, UsageRecord[]>();
const eventSubscribers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
/**
 * Guardrails wired into dispatch (docs/OPERATIONS.md "Guardrails in dispatch").
 * Constructed before the durable replay below so that every replayed usage
 * record reaches `onUsageRecorded` through persistStructuredEvidence, the same
 * path live records take. The seed from `usageSource` is a belt-and-braces
 * second delivery of the same records; the day total is idempotent by record
 * id, so the two never double count. Free memory is read on this host: the
 * coordinator and the worker share the machine, so the coordinator's reading is
 * the one the memory floor is about (packages/guardrails/src/limits.ts).
 */
const guards = new Guards({
  ceiling: ceilingConfigFromValues({
    dailyUsd: env.FORGE_DAILY_CEILING_USD,
    warnAtFraction: env.FORGE_CEILING_WARN_FRACTION,
  }),
  budget: budgetConfigFromValues({
    monthlyUsd: env.FORGE_MONTHLY_BUDGET_USD,
    resetDay: env.FORGE_BUDGET_RESET_DAY,
    maxDailyUsd: env.FORGE_MAX_DAILY_CEILING_USD,
    countFrom: env.FORGE_BUDGET_COUNT_FROM,
  }),
  maxAgents: env.FORGE_MAX_AGENTS,
  minFreeMemoryMb: env.FORGE_MIN_FREE_MEMORY_MB,
  timeZone: env.FORGE_TIMEZONE,
  usageSource: () => [...usageRecords.values()].flat(),
  // Each worker runs one job at a time and only a provider job starts an agent,
  // so the agent count is the number of provider jobs currently leased.
  activeProviderJobs: () =>
    [...workerJobs.values()].filter(
      (job) =>
        (job.state === 'leased' || job.state === 'cancel_requested') &&
        job.action.kind === 'provider',
    ).length,
  emit: (runId, type, payload) => void emit(runId, type, payload),
  warn: (message, fields) => logger.log({ level: 'warn', message, ...(fields ? { fields } : {}) }),
});
// Module-level bindings the guard paths read. They live up here, before the
// awaits further down, because a `const` or `let` after `await app.listen()` is
// still in its temporal dead zone while the first requests are already being
// served; function declarations hoist, these do not.
const GUARD_RESUME_HINT =
  'raise FORGE_DAILY_CEILING_USD, wait for the next local day, or route the run to local models';
// ADR-029: what unblocks a run paused because no worker ever came online.
const PROVIDER_RESUME_HINT =
  'start the worker (pnpm forge runtime start), confirm it appears in GET /api/workers, then resume the run';
// An ollama job that names no model runs on the tier-2 (coding) model, the
// tier policy B3 demotes the planner and critic to (ADR-018, F121). Resolved
// here so the lease can require `model:<name>` and land only where it exists.
const DEFAULT_LOCAL_MODEL = TIER_MODELS[2] ?? 'devstral-small-2:latest';
// Workers poll every second, so an unrate-limited warning would print once per
// worker per second for as long as the condition lasts.
let leaseRefusalLoggedAt = 0;
// One queued job per stage and several runs at once: without a limit one halt
// would be reported once per waiting job, on entry and again on exit.
const workerJobWaitHaltLoggedAt = { halted: 0, resumed: 0 };
const TERMINAL_RUN_STATES: ReadonlySet<Run['state']> = new Set([
  'completed',
  'partially_completed',
  'cancelled',
  'failed',
]);
class WorkerProviderAdapter implements ProviderAdapter {
  readonly capabilities: ProviderAdapter['capabilities'];
  constructor(readonly id: ProviderId) {
    // What the worker-side adapter can do, seen from here: a cloud CLI keeps
    // its session and tools; the local model has neither (ADR-021).
    this.capabilities =
      id === 'ollama'
        ? {
            streaming: false,
            resume: false,
            tools: false,
            structuredOutput: true,
            usage: true,
            local: true,
          }
        : { streaming: false, resume: true, tools: true, structuredOutput: true, usage: true };
  }
  async diagnose() {
    return providerAvailability(this.id, workers.values(), isWorkerOnline);
  }
  async *run(request: ProviderRequest, options: { cwd: string; signal?: AbortSignal }) {
    const result = await dispatchWorkerProvider(this.id, request, options.cwd, options.signal);
    if (!result.events?.length) {
      yield {
        type: 'error' as const,
        code: 'PROTOCOL_ERROR',
        message: result.stderr || `${this.id} worker returned no provider events`,
        retryable: false,
      };
      return;
    }
    if (request.role === 'builder' && result.patch !== undefined) {
      // The patch is the whole diff from HEAD, so this is idempotent across
      // repair rounds; applyGitPatch returns the tree to HEAD first.
      await applyGitPatch(result.patch, options.cwd, options.signal);
    }
    for (const event of result.events) yield event;
  }
}
const workerProviders: ProviderAdapter[] = [
  new WorkerProviderAdapter('claude'),
  new WorkerProviderAdapter('codex'),
  new WorkerProviderAdapter('ollama'),
];
function createEvent(runId: string, type: string, payload: Record<string, unknown> = {}) {
  const eventId = randomUUID();
  return {
    id: eventId,
    runId,
    type,
    payload: redactPayload(payload),
    idempotencyKey: eventId,
    createdAt: new Date().toISOString(),
  };
}
function publishEvent(runId: string, event: Record<string, unknown>) {
  events.set(runId, [...(events.get(runId) ?? []), event]);
  for (const subscriber of eventSubscribers.get(runId) ?? []) subscriber(event);
  metrics.increment('events_total');
  // Policy B11: every event passes here, so this is where Dan's phone learns
  // about it. Fire-and-forget with its own logging; it cannot throw.
  escalations.onEvent(event);
}
function emit(runId: string, type: string, payload: Record<string, unknown> = {}, persist = true) {
  const event = createEvent(runId, type, payload);
  publishEvent(runId, event);
  if (durable && persist) {
    void durable.appendEvent(event).catch((error: unknown) =>
      logger.log({
        level: 'error',
        message: `Event persistence failed: ${String(error)}`,
        runId,
      }),
    );
  }
  return event;
}
async function emitDurably(runId: string, type: string, payload: Record<string, unknown> = {}) {
  const event = createEvent(runId, type, payload);
  await durable?.appendEvent(event);
  await persistStructuredEvidence(event);
  publishEvent(runId, event);
  return event;
}
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const knownSecrets = [
    env.FORGE_WORKER_TOKEN,
    env.FORGE_COORDINATOR_TOKEN,
    env.GITHUB_TOKEN,
    env.FORGE_HA_TOKEN,
    env.FORGE_SMTP_PASSWORD,
  ].filter((value): value is string => Boolean(value));
  return JSON.parse(redactSecrets(JSON.stringify(payload), knownSecrets)) as Record<
    string,
    unknown
  >;
}
function hasWorkerSession(token: string | undefined, workerId: string) {
  const session = token ? workerSessions.get(token) : undefined;
  return Boolean(session && session.workerId === workerId && session.expiresAt > Date.now());
}
function isWorkerOnline(worker: Worker): boolean {
  return worker.status === 'online' && Date.now() - Date.parse(worker.lastHeartbeatAt) < 35_000;
}
/** True while no worker is online at all - the only state the wait exists for. */
function isFleetEmpty(): boolean {
  return ![...workers.values()].some(isWorkerOnline);
}
/**
 * How long this execution may wait for a worker to advertise a provider
 * (ADR-029).
 *
 * Three cases, and only the middle one waits:
 *
 * - a worker is online: 0. Its diagnostics are the truth about what it
 *   advertises, so a provider it does not carry (Codex not logged in) fails the
 *   run now, exactly as before.
 * - no worker is online, and either this run is being resumed or a worker row
 *   exists in the store: the full budget. This is the cold coordinator start
 *   the bug was measured on - the fleet is empty only because the process has
 *   just come up, and the worker re-registers seconds later.
 * - no worker is online, none was ever registered, and this is a run's first
 *   start: 0. Nothing is coming back, so the operator hears about the
 *   misconfiguration immediately instead of 90 seconds later.
 */
function providerWaitBudgetMs(resuming: boolean): number {
  if (!env.FORGE_PROVIDER_WAIT_MS || !isFleetEmpty()) return 0;
  return resuming || workers.size > 0 ? env.FORGE_PROVIDER_WAIT_MS : 0;
}
if (durable) {
  for (const project of await durable.listProjects()) projects.set(project.id, project);
  for (const run of await durable.listRuns()) {
    runs.set(run.id, run);
    tasks.set(run.id, await durable.listTasks(run.id));
    const restoredEvents = await durable.listEvents(run.id);
    events.set(run.id, restoredEvents);
    for (const event of restoredEvents) await persistStructuredEvidence(event);
  }
  for (const worker of await durable.listWorkers()) workers.set(worker.id, worker);
  for (const persistedJob of await durable.listWorkerJobs()) {
    let job = persistedJob;
    if (
      (job.state === 'leased' || job.state === 'cancel_requested') &&
      (job.leaseExpiresAt ?? 0) <= Date.now()
    ) {
      job = {
        ...job,
        state: job.state === 'cancel_requested' ? 'cancelled' : 'queued',
        workerId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      };
      await durable.upsertWorkerJob(job);
      await emitDurably(job.runId, 'worker_job.lease_reconciled', {
        jobId: job.id,
        state: job.state,
      });
    }
    workerJobs.set(job.id, job);
  }
  for (const approval of await durable.listApprovals()) {
    approvals.set(approval.id, approval);
    if (approval.status === 'pending' || approval.status === 'approved') {
      try {
        const actionRaw: unknown = JSON.parse(approval.normalizedAction);
        const scopeRaw: unknown = JSON.parse(approval.scope);
        const action = z.object({ cwd: z.string(), args: z.array(z.string()) }).parse(actionRaw);
        const scope = z
          .object({ repositoryUrl: z.string(), baseRef: z.string(), commit: z.string().length(40) })
          .parse(scopeRaw);
        const branch = action.args.at(-1);
        if (typeof branch === 'string' && scope.repositoryUrl && scope.baseRef) {
          pendingIntegrations.set(approval.id, {
            runId: approval.runId,
            workspace: action.cwd,
            branch,
            baseRef: scope.baseRef,
            repositoryUrl: scope.repositoryUrl,
            commit: scope.commit,
          });
        }
      } catch {
        logger.log({ level: 'warn', message: `Could not restore approval ${approval.id}` });
      }
    }
  }
  for (const lease of await durable.reconcileExpiredLeases()) {
    emit(lease.runId, 'attempt.lease_expired', {
      attemptId: lease.attemptId,
      taskId: lease.taskId,
      recoveredTo: 'ready',
    });
  }
}
app.addHook('onClose', async () => {
  // Before the database goes: a held escalation summary may still be recorded.
  await escalations.close();
  await jobQueue.close();
  await sql?.end();
});

app.get('/health', async (_request, reply) => {
  const checks: Record<string, string> = { process: 'ok' };
  try {
    checks.postgres = sql
      ? (await sql`select 1 as healthy`).length
        ? 'ok'
        : 'failed'
      : 'unconfigured';
    checks.redis = await checkRedis();
  } catch (error) {
    checks.dependencies = error instanceof Error ? error.message : String(error);
    return reply.code(503).send({
      status: 'degraded',
      service: 'coordinator',
      time: new Date().toISOString(),
      checks,
    });
  }
  return { status: 'ok', service: 'coordinator', time: new Date().toISOString(), checks };
});
/**
 * Kill switch, API half. POST to halt, DELETE to resume, GET to inspect.
 *
 * Halting does not kill in-flight work. Workers stop being handed new jobs and
 * idle cleanly, so nothing is interrupted mid-write and every worktree is left
 * intact for inspection - which is the state you actually want when you have
 * just stopped a system because something looked wrong.
 */
const haltStatus = async () => {
  const file = await readHaltFile(haltFilePath);
  return {
    ...checkHalt({ fileExists: file.exists }),
    haltFile: haltFilePath,
    ...(file.request ? { request: file.request } : {}),
  };
};
app.get('/api/halt', async () => haltStatus());

app.post('/api/halt', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(token, env.FORGE_COORDINATOR_TOKEN)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = z
    .object({ reason: z.string().max(500).optional() })
    .optional()
    .parse(request.body);
  const reason = body?.reason?.trim();
  await writeHaltFile(haltFilePath, {
    requestedAt: new Date().toISOString(),
    requestedBy: 'api',
    ...(reason ? { reason } : {}),
  });
  logger.log({
    level: 'warn',
    message: 'halt requested through the API; no further work will be leased',
    fields: { haltFile: haltFilePath, ...(reason ? { reason } : {}) },
  });
  return reply.send(await haltStatus());
});

app.delete('/api/halt', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(token, env.FORGE_COORDINATOR_TOKEN)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (await removeHaltFile(haltFilePath)) {
    logger.log({
      level: 'info',
      message: 'halt cleared through the API; work will be leased again',
      fields: { haltFile: haltFilePath },
    });
  }
  return reply.send(await haltStatus());
});

app.get('/metrics', async (_req, reply) => reply.type('text/plain').send(metrics.prometheus()));
app.post('/api/operations/retention/preview', async (request, reply) => {
  if (!durable) return reply.code(409).send({ error: 'database_required' });
  const { before } = z.object({ before: z.string().datetime() }).parse(request.body);
  const cutoff = new Date(before);
  const preview = await durable.cleanupRetention(cutoff);
  const confirmationDigest = createHash('sha256')
    .update(JSON.stringify({ operation: 'retention.cleanup', before, ...preview }))
    .digest('hex');
  return { before, ...preview, confirmationDigest };
});
app.post('/api/operations/retention/execute', async (request, reply) => {
  const coordinatorToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(coordinatorToken, env.FORGE_COORDINATOR_TOKEN)) {
    return reply.code(401).send({ error: 'coordinator_token_invalid' });
  }
  if (!durable) return reply.code(409).send({ error: 'database_required' });
  const { before, confirmationDigest } = z
    .object({ before: z.string().datetime(), confirmationDigest: z.string().length(64) })
    .parse(request.body);
  const cutoff = new Date(before);
  const preview = await durable.cleanupRetention(cutoff);
  const expected = createHash('sha256')
    .update(JSON.stringify({ operation: 'retention.cleanup', before, ...preview }))
    .digest('hex');
  if (confirmationDigest !== expected) {
    return reply.code(409).send({ error: 'retention_preview_changed' });
  }
  const result = await durable.cleanupRetention(cutoff, { execute: true });
  logger.log({
    level: 'info',
    message: 'Retention cleanup executed',
    fields: { before, events: result.events, artifacts: result.artifacts },
  });
  return { before, ...result };
});
app.get('/api/providers', async () =>
  Promise.all(
    workerProviders.map(async (provider) => ({
      id: provider.id,
      capabilities: provider.capabilities,
      diagnostic: await provider.diagnose(),
    })),
  ),
);
app.get('/api/projects', async () => [...projects.values()]);
app.post('/api/projects', async (request, reply) => {
  const project = z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      repositoryUrl: z.string().min(1),
      baseRef: z.string().default('main'),
      checks: z
        .array(z.object({ executable: z.string().min(1), args: z.array(z.string()) }))
        .default([{ executable: 'pnpm', args: ['check'] }]),
      // Empty by default: network access is opted into per project, never
      // inherited.
      install: z
        .array(z.object({ executable: z.string().min(1), args: z.array(z.string()) }))
        .default([]),
    })
    .parse(request.body);
  projects.set(project.id, project);
  await durable?.ensureProject({
    id: project.id,
    name: project.name,
    repositoryUrl: project.repositoryUrl,
    defaultBranch: project.baseRef,
    checks: project.checks,
    install: project.install,
  });
  return reply.code(201).send(project);
});
app.get('/api/workers', async () =>
  [...workers.values()].map((worker): Worker => ({
    ...worker,
    status: isWorkerOnline(worker) ? 'online' : 'offline',
  })),
);
app.post('/api/workers/register', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(token, env.FORGE_WORKER_TOKEN))
    return reply.code(401).send({ error: 'invalid_worker_token' });
  const input = z
    .object({
      id: z.string(),
      name: z.string(),
      platform: z.enum(['linux', 'darwin', 'win32']),
      capabilities: z.array(z.string()),
      // Bounded: this text reaches events, the diagnostic and the digest.
      providerFaults: z.record(z.string().max(64), z.string().max(500)).optional(),
      policyProfile: z.string(),
    })
    .parse(request.body);
  const worker: Worker = { ...input, status: 'online', lastHeartbeatAt: new Date().toISOString() };
  const sessionToken = `${randomUUID()}${randomUUID()}`;
  const expiresAt = Date.now() + 15 * 60_000;
  workerSessions.set(sessionToken, { workerId: worker.id, expiresAt });
  workers.set(worker.id, worker);
  await durable?.upsertWorker(worker, createHash('sha256').update(sessionToken).digest('hex'));
  return reply
    .code(201)
    .send({ worker, sessionToken, expiresAt: new Date(expiresAt).toISOString() });
});
app.post('/api/workers/:id/heartbeat', async (request, reply) => {
  const workerId = (request.params as { id: string }).id;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!hasWorkerSession(token, workerId)) {
    return reply.code(401).send({ error: 'worker_session_invalid' });
  }
  const current = workers.get(workerId);
  if (!current) return reply.code(404).send({ error: 'not_found' });
  const worker = {
    ...current,
    status: 'online' as const,
    lastHeartbeatAt: new Date().toISOString(),
  };
  workers.set(worker.id, worker);
  await durable?.upsertWorker(
    worker,
    createHash('sha256').update(env.FORGE_WORKER_TOKEN).digest('hex'),
  );
  return worker;
});
app.post('/api/runs/:runId/jobs', async (request, reply) => {
  const coordinatorToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!secretEquals(coordinatorToken, env.FORGE_COORDINATOR_TOKEN)) {
    return reply.code(401).send({ error: 'coordinator_token_invalid' });
  }
  const runId = (request.params as { runId: string }).runId;
  if (!runs.has(runId)) return reply.code(404).send({ error: 'run_not_found' });
  const input = z
    .object({
      action: z.union([
        z.object({
          kind: z.literal('provider'),
          providerId: z.enum(providerIds),
          request: ProviderRequestSchema,
          cwd: z.string().min(1),
        }),
        z.object({
          kind: z.literal('command').optional(),
          executable: z.string().min(1),
          args: z.array(z.string()),
          cwd: z.string().min(1),
        }),
      ]),
      requiredCapabilities: z.array(z.string()).default([]),
      priority: z.number().int().min(0).max(2_147_483_647).default(0),
    })
    .parse(request.body);
  if (input.action.kind !== 'provider') {
    const classification = classifyAction(input.action, resolve(env.FORGE_WORKSPACE_ROOT));
    if (classification.class !== 'green') {
      return reply.code(409).send({ error: 'approval_required', classification });
    }
  }
  if (input.action.kind === 'provider' && input.action.request.runId !== runId) {
    return reply.code(400).send({ error: 'provider_run_mismatch' });
  }
  const action = await createTransportedWorkerAction(runId, input.action);
  const job: WorkerJob = {
    id: randomUUID(),
    runId,
    action,
    requiredCapabilities: input.requiredCapabilities,
    priority: input.priority,
    state: 'queued',
  };
  workerJobs.set(job.id, job);
  await durable?.upsertWorkerJob(job);
  await pushJobHint(job);
  emit(job.runId, 'worker_job.queued', { jobId: job.id });
  return reply.code(201).send(job);
});
app.get('/api/runs/:runId/jobs', async (request, reply) => {
  const runId = (request.params as { runId: string }).runId;
  if (!runs.has(runId)) return reply.code(404).send({ error: 'run_not_found' });
  return durable
    ? durable.listWorkerJobs(runId)
    : [...workerJobs.values()].filter((job) => job.runId === runId);
});
app.get('/api/workers/:id/jobs/next', async (request, reply) => {
  const workerId = (request.params as { id: string }).id;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!hasWorkerSession(token, workerId)) {
    return reply.code(401).send({ error: 'worker_session_invalid' });
  }
  const worker = workers.get(workerId);
  if (!worker) return reply.code(409).send({ error: 'worker_not_registered' });

  // The kill switch is checked here, at the point work is handed out, rather
  // than at startup. Halting must stop a running system, not merely prevent one
  // from starting. Returning 204 means workers simply receive no work and idle
  // cleanly; anything in flight finishes rather than being killed mid-write.
  const halt = checkHalt({ fileExists: existsSync(haltFilePath) });
  if (halt.halted) {
    return reply.code(204).header('x-forge-halted', halt.source).send();
  }
  // Policy B8, the same way: no work is handed out past the agent cap or below
  // the free-memory floor. 204 rather than an error, so a worker keeps polling
  // and picks the job up the moment a slot or the memory frees.
  const lease = guards.beforeLease();
  if (!lease.allowed) {
    logLeaseRefusal(lease.reason);
    return reply.code(204).header('x-forge-lease-refused', lease.header).send();
  }

  await jobQueue.pop(0).catch(() => undefined);
  let leased: WorkerJob | undefined;
  // Collected during the lease transaction and emitted after it, so a reclaim
  // during a run is on the record. Before 04/10/2026 this path was silent:
  // `worker_job.lease_reconciled` was emitted on boot only, so the one reclaim
  // that actually mattered - a builder losing its lease mid-work - left nothing
  // behind but a second `worker_job.leased` that looked like a first.
  const reclaimed: ReclaimedWorkerJobLease[] = [];
  if (durable) {
    leased = await durable.leaseNextWorkerJob(workerId, worker.capabilities, {
      leaseToken: randomUUID(),
      leaseMs: env.FORGE_JOB_LEASE_MS,
      onReclaim: (entry) => void reclaimed.push(entry),
    });
  } else {
    const now = Date.now();
    for (const [id, job] of workerJobs) {
      if (job.state === 'leased' && (job.leaseExpiresAt ?? 0) <= now) {
        workerJobs.set(id, {
          ...job,
          state: 'queued',
          workerId: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        });
      }
    }
    const job = [...workerJobs.values()].find(
      (candidate) =>
        candidate.state === 'queued' &&
        candidate.requiredCapabilities.every((capability) =>
          worker.capabilities.includes(capability),
        ),
    );
    if (job) {
      leased = {
        ...job,
        state: 'leased',
        workerId,
        leaseToken: randomUUID(),
        leaseExpiresAt: now + env.FORGE_JOB_LEASE_MS,
      };
    }
  }
  for (const entry of reclaimed) {
    emit(entry.runId, 'worker_job.lease_reconciled', {
      jobId: entry.jobId,
      state: 'queued',
      at: 'runtime',
      ...(entry.previousWorkerId ? { previousWorkerId: entry.previousWorkerId } : {}),
      ...(entry.leaseExpiredAt ? { leaseExpiredAt: entry.leaseExpiredAt } : {}),
      ...(entry.overdueMs === undefined ? {} : { overdueMs: entry.overdueMs }),
    });
  }
  if (!leased) return reply.code(204).send();
  workerJobs.set(leased.id, leased);
  // `reclaimedLease` tells a first lease from a job handed back after one,
  // which two identical `worker_job.leased` rows could not.
  emit(leased.runId, 'worker_job.leased', {
    jobId: leased.id,
    workerId,
    ...(reclaimed.some((entry) => entry.jobId === leased.id) ? { reclaimedLease: true } : {}),
  });
  return leased;
});
app.post('/api/workers/:id/jobs/:jobId/heartbeat', async (request, reply) => {
  const { id: workerId, jobId } = request.params as { id: string; jobId: string };
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!hasWorkerSession(token, workerId)) {
    return reply.code(401).send({ error: 'worker_session_invalid' });
  }
  const { leaseToken } = z.object({ leaseToken: z.string().min(1) }).parse(request.body);
  const job = workerJobs.get(jobId);
  const renewed = durable
    ? await durable.renewWorkerJobLease(jobId, workerId, leaseToken, {
        leaseMs: env.FORGE_JOB_LEASE_MS,
      })
    : job &&
        ['leased', 'cancel_requested'].includes(job.state) &&
        job.workerId === workerId &&
        job.leaseToken === leaseToken &&
        (job.leaseExpiresAt ?? 0) > Date.now()
      ? { ...job, leaseExpiresAt: Date.now() + env.FORGE_JOB_LEASE_MS }
      : undefined;
  if (!renewed) return reply.code(409).send({ error: 'job_lease_invalid' });
  workerJobs.set(jobId, renewed);
  return {
    leaseExpiresAt: new Date(renewed.leaseExpiresAt!).toISOString(),
    cancelRequested: renewed.state === 'cancel_requested',
  };
});
// The completion body carries the builder patch and the provider events, so
// this route gets its own body limit; every other route keeps the app default.
app.post(
  '/api/workers/:id/jobs/:jobId/complete',
  { bodyLimit: MAX_COMPLETION_BODY_BYTES },
  completeWorkerJobRoute,
);
async function completeWorkerJobRoute(request: FastifyRequest, reply: FastifyReply) {
  const { id: workerId, jobId } = request.params as { id: string; jobId: string };
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!hasWorkerSession(token, workerId)) {
    return reply.code(401).send({ error: 'worker_session_invalid' });
  }
  const job = workerJobs.get(jobId);
  const result = z
    .object({
      leaseToken: z.string().min(1),
      code: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      // A stepped job's per-step outcomes. Named here because Zod strips what it
      // does not know, which is the third allowlist on this one field's journey
      // and the one that cost attempt twelve: `npm ci`, lint, typecheck and the
      // tests all ran and all passed, and the result arrived with the evidence
      // removed. Bounded rather than open-ended: a verification is an install
      // plus a handful of checks, so more than this is a bug to be told about,
      // not a list to be quietly shortened. Each step's output is already capped
      // by the sandbox capture, and the whole body by MAX_COMPLETION_BODY_BYTES.
      steps: z
        .array(
          z.object({
            command: z.string().max(4_096),
            code: z.number().int(),
            stdout: z.string(),
            stderr: z.string(),
          }),
        )
        .max(32, 'steps exceeds the 32 commands a verification may run')
        .optional(),
      events: z.array(ProviderEventSchema).optional(),
      patch: z
        .string()
        .max(MAX_PATCH_BYTES, `patch exceeds MAX_PATCH_BYTES (${MAX_PATCH_BYTES} bytes)`)
        .optional(),
      retainedWorkspace: z.string().max(1024).optional(),
      // Redacted raw provider output (docs/OPERATIONS.md "Raw provider output").
      rawStdoutTail: z
        .string()
        .max(
          MAX_RAW_TAIL_BYTES,
          `rawStdoutTail exceeds MAX_RAW_TAIL_BYTES (${MAX_RAW_TAIL_BYTES} bytes)`,
        )
        .optional(),
      rawStderrTail: z
        .string()
        .max(
          MAX_RAW_TAIL_BYTES,
          `rawStderrTail exceeds MAX_RAW_TAIL_BYTES (${MAX_RAW_TAIL_BYTES} bytes)`,
        )
        .optional(),
    })
    .parse(request.body);
  const completed = durable
    ? await durable.completeWorkerJob(jobId, workerId, result.leaseToken, {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.steps ? { steps: result.steps } : {}),
        ...(result.events ? { events: result.events } : {}),
        ...(result.patch !== undefined ? { patch: result.patch } : {}),
        ...(result.retainedWorkspace ? { retainedWorkspace: result.retainedWorkspace } : {}),
        ...(result.rawStdoutTail !== undefined ? { rawStdoutTail: result.rawStdoutTail } : {}),
        ...(result.rawStderrTail !== undefined ? { rawStderrTail: result.rawStderrTail } : {}),
      })
    : job &&
        job.workerId === workerId &&
        ['leased', 'cancel_requested'].includes(job.state) &&
        job.leaseToken === result.leaseToken &&
        (job.leaseExpiresAt ?? 0) > Date.now()
      ? {
          ...job,
          state: (job.state === 'cancel_requested'
            ? 'cancelled'
            : result.code === 0
              ? 'completed'
              : 'failed') as WorkerJob['state'],
          result: {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.steps ? { steps: result.steps } : {}),
            ...(result.events ? { events: result.events } : {}),
            ...(result.patch !== undefined ? { patch: result.patch } : {}),
            ...(result.retainedWorkspace ? { retainedWorkspace: result.retainedWorkspace } : {}),
            ...(result.rawStdoutTail !== undefined ? { rawStdoutTail: result.rawStdoutTail } : {}),
            ...(result.rawStderrTail !== undefined ? { rawStderrTail: result.rawStderrTail } : {}),
          },
        }
      : undefined;
  if (!completed) return reply.code(409).send({ error: 'job_lease_invalid' });
  workerJobs.set(jobId, completed);
  const providerSession = result.events?.find(
    (event) =>
      event.type === 'session' ||
      (event.type === 'completed' && typeof event.sessionId === 'string'),
  );
  if (
    completed.attemptId &&
    providerSession &&
    'sessionId' in providerSession &&
    providerSession.sessionId
  ) {
    await durable?.setAttemptProviderSession(completed.attemptId, providerSession.sessionId);
  }
  await emitDurably(completed.runId, 'worker_job.completed', {
    jobId,
    workerId,
    code: result.code,
  });
  // A worker that aborted a provider for tripping a per-task limit reports it
  // as a TASK_LIMIT error event. Surface that on the run as its own event so
  // the reason is visible without opening the job, and so notification can
  // key on it.
  const taskLimit = result.events?.find(
    (event) => event.type === 'error' && event.code === 'TASK_LIMIT',
  );
  if (taskLimit?.type === 'error' && completed.action.kind === 'provider') {
    await emitDurably(completed.runId, 'guard.task_limit', {
      jobId,
      workerId,
      role: completed.action.request.role,
      providerId: completed.action.providerId,
      reason: taskLimit.message,
      usage: taskUsageFromEvents(completed.runId, jobId, result.events ?? []),
    });
  }
  return completed;
}
app.post('/api/jobs/:jobId/cancel', async (request, reply) => {
  const { jobId } = request.params as { jobId: string };
  const job = workerJobs.get(jobId);
  if (!job) return reply.code(404).send({ error: 'not_found' });
  if (!['queued', 'leased'].includes(job.state)) {
    return reply.code(409).send({ error: 'job_not_cancellable' });
  }
  const cancelled = durable
    ? await durable.cancelWorkerJob(jobId)
    : ({
        ...job,
        state: job.state === 'queued' ? 'cancelled' : 'cancel_requested',
      } satisfies WorkerJob);
  if (!cancelled) return reply.code(409).send({ error: 'job_not_cancellable' });
  workerJobs.set(jobId, cancelled);
  await emitDurably(job.runId, 'worker_job.cancel_requested', { jobId });
  return cancelled;
});

app.get('/api/runs', async () =>
  [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
app.get('/api/runs/:id', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = runs.get(id);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  const structured = durable
    ? await Promise.all([
        durable.listMessages(id),
        durable.listFindings(id),
        durable.listDecisions(id),
        durable.listBlockers(id),
        durable.listArtifacts(id),
        durable.listUsageRecords(id),
        durable.listAttempts(id),
      ])
    : [
        messages.get(id) ?? [],
        findings.get(id) ?? [],
        decisions.get(id) ?? [],
        blockers.get(id) ?? [],
        artifacts.get(id) ?? [],
        usageRecords.get(id) ?? [],
        [],
      ];
  return {
    run,
    tasks: tasks.get(id) ?? [],
    events: events.get(id) ?? [],
    approvals: [...approvals.values()].filter((item) => item.runId === id),
    messages: structured[0],
    findings: structured[1],
    decisions: structured[2],
    blockers: structured[3],
    artifacts: structured[4],
    usage: structured[5],
    attempts: structured[6],
  };
});
app.get('/api/runs/:id/report', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = runs.get(id);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  const [runMessages, runFindings, runDecisions, runBlockers, runArtifacts, runUsage, attempts] =
    durable
      ? await Promise.all([
          durable.listMessages(id),
          durable.listFindings(id),
          durable.listDecisions(id),
          durable.listBlockers(id),
          durable.listArtifacts(id),
          durable.listUsageRecords(id),
          durable.listAttempts(id),
        ])
      : [
          messages.get(id) ?? [],
          findings.get(id) ?? [],
          decisions.get(id) ?? [],
          blockers.get(id) ?? [],
          artifacts.get(id) ?? [],
          usageRecords.get(id) ?? [],
          [],
        ];
  return {
    generatedAt: new Date().toISOString(),
    run,
    tasks: tasks.get(id) ?? [],
    messages: runMessages,
    findings: runFindings,
    decisions: runDecisions,
    blockers: runBlockers,
    artifacts: runArtifacts,
    usage: runUsage,
    attempts,
  };
});
app.post('/api/runs', async (request, reply) => {
  const input = z
    .object({
      projectId: z.string().min(1),
      objective: z.string().min(3),
      constraints: z.array(z.string()).default([]),
      // Per-run budget default (ADR-024); a caller may pass more explicitly.
      maxUsd: z.number().nonnegative().default(5),
      maxTokens: z.number().int().nonnegative().default(100000),
      configuration: RunConfigurationSchema.partial().default({}),
    })
    .parse(request.body);
  const now = new Date().toISOString(),
    id = randomUUID();
  if (!projects.has(input.projectId)) {
    return reply.code(409).send({ error: 'project_not_configured' });
  }
  const project = projects.get(input.projectId)!;
  const run = RunSchema.parse({
    id,
    projectId: input.projectId,
    objective: input.objective,
    constraints: input.constraints,
    state: 'created',
    budget: { maxUsd: input.maxUsd, maxTokens: input.maxTokens },
    spent: { usd: 0, tokens: 0 },
    configuration: RunConfigurationSchema.parse({
      ...input.configuration,
      targetBranch: input.configuration.targetBranch ?? project.baseRef,
    }),
    createdAt: now,
    updatedAt: now,
  });
  const initialTasks = [
    'Context and plan',
    'Implement objective',
    'Review and verify',
    'Integrate and report',
  ].map((title, index) =>
    TaskSchema.parse({
      id: randomUUID(),
      runId: id,
      title,
      description: title,
      state: index === 0 ? 'ready' : 'queued',
      priority: 4 - index,
      dependencies: [],
      acceptanceCriteria: ['Evidence recorded'],
      requiredCapabilities: [],
      fileOwnership: [],
      attempts: 0,
      maxAttempts: [3, 4, 12, 3][index]!,
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (let i = 1; i < initialTasks.length; i++)
    initialTasks[i]!.dependencies = [initialTasks[i - 1]!.id];
  runs.set(id, run);
  tasks.set(id, initialTasks);
  await durable?.putRun(run);
  for (const task of initialTasks) await durable?.putTask(task);
  await emitDurably(id, 'run.created', { objective: run.objective });
  metrics.increment('runs_created_total');
  return reply.code(201).send({ run, tasks: initialTasks });
});
app.post('/api/runs/:id/start', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = runs.get(id);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  if (run.state === 'completed' || run.state === 'cancelled') {
    return reply.code(409).send({ error: 'run_not_startable' });
  }
  const project = projects.get(run.projectId);
  if (project) {
    if (activeExecutions.has(id)) return reply.code(409).send({ error: 'run_already_active' });
    // Policies B2/B3: a run does not start, or resume, on a day already over the
    // ceiling. It is paused with the same event and blocker a mid-run refusal
    // produces, so the operator sees one shape of "stopped by the ceiling".
    const gate = guards.beforeRunStart(id);
    if (!gate.allowed) {
      await pauseRunByGuard(id, undefined, gate.verdict);
      return reply.code(409).send({ error: 'spend_ceiling', message: gate.verdict.reason });
    }
    const started: Run = { ...run, state: 'executing', updatedAt: new Date().toISOString() };
    runs.set(id, started);
    await durable?.putRun(started);
    const pipeline = new AutonomousPipeline();
    const controller = new AbortController();
    const timeLimitMs = (started.configuration?.timeLimitMinutes ?? 120) * 60_000;
    const timeLimitTimer = setTimeout(
      () => controller.abort(new Error(`Run time limit exceeded after ${timeLimitMs}ms`)),
      timeLimitMs,
    );
    timeLimitTimer.unref();
    const checkpoint = restorePipelineCheckpoint(events.get(id) ?? []);
    // A run's first start comes from `created`; every other state here is a
    // resume, a retry, or the row a killed coordinator left saying `executing`
    // - which is exactly the restart case ADR-029 is about. A checkpoint means
    // stages have already run, so it says the same thing.
    const resuming = run.state !== 'created' || checkpoint !== undefined;
    const providerWaitMs = providerWaitBudgetMs(resuming);
    activeExecutions.set(id, controller);
    void pipeline
      .execute({
        run: started,
        repositoryUrl: project.repositoryUrl,
        projectId: project.id,
        baseRef: started.configuration?.targetBranch ?? project.baseRef,
        localSkills: env.FORGE_LOCAL_SKILLS === 'on',
        branch: `forge/${id.slice(0, 8)}`,
        checks: project.checks,
        install: project.install,
        // Must be absolute. GitWorkspaceRuntime passes this root to runGit as the
        // spawn cwd *and* derives cache/worktree paths from it that git then
        // resolves against that same cwd, so a relative value is applied twice and
        // lands in <root>/<root>/cache. Every other use site already calls
        // resolve(); this one did not. The resulting non-existent cwd surfaces on
        // Windows as "spawn git ENOENT", which points at the wrong cause entirely.
        workspaceRoot: resolve(env.FORGE_WORKSPACE_ROOT),
        stageTimeoutMs: env.FORGE_STAGE_TIMEOUT_MS,
        // Halted time does not count against a stage either, which is what
        // makes the kill switch's promise true rather than half true.
        stageTimeoutSignal: (timeoutMs) =>
          haltAwareTimeoutSignal(timeoutMs, () => existsSync(haltFilePath)),
        providers: workerProviders,
        // ADR-029: a cold coordinator has no online worker for the first
        // moments of its life. `fleetEmpty` is read afresh at every poll, so
        // the wait ends the instant a worker registers - and never starts when
        // one is already online, which keeps the genuine "this worker does not
        // advertise codex" case failing fast.
        providerWait: {
          totalMs: providerWaitMs,
          intervalMs: Math.min(PROVIDER_WAIT_POLL_MS, Math.max(1, providerWaitMs)),
          fleetEmpty: isFleetEmpty,
        },
        // Routing (ADR-022): the pipeline decides per stage whether a role goes
        // to the cloud or, under the ceiling, to the local model. It needs the
        // same usage, ceiling and zone the dispatch guards use, so both agree.
        usageSource: () => toGuardUsage([...usageRecords.values()].flat()),
        ceiling: guards.ceiling,
        timeZone: guards.timeZone,
        ...(started.configuration?.providerRoles
          ? { providerRoles: started.configuration.providerRoles }
          : {}),
        signal: controller.signal,
        checkRunner: (action, signal) => dispatchWorkerCheck(id, action, signal),
        ...(checkpoint ? { checkpoint } : {}),
        onEvent: async (type, payload) => {
          if (type === 'usage.recorded') {
            const current = runs.get(id);
            const usd = typeof payload.totalUsd === 'number' ? payload.totalUsd : undefined;
            const tokens =
              typeof payload.totalTokens === 'number' ? payload.totalTokens : undefined;
            if (current && usd !== undefined && tokens !== undefined) {
              const withUsage: Run = { ...current, spent: { usd, tokens } };
              runs.set(id, withUsage);
              await durable?.putRun(withUsage);
            }
          }
          await emitDurably(id, type, payload);
        },
      })
      .then(async (result) => {
        const current = runs.get(id);
        if (current?.state === 'paused' || current?.state === 'cancelled') {
          await emitDurably(id, 'run.execution_stopped', { state: current.state });
          return;
        }
        const state = result.status === 'completed' ? 'completed' : 'partially_completed';
        const latest = runs.get(id) ?? started;
        const finished: Run = { ...latest, state, updatedAt: new Date().toISOString() };
        const finishedTasks: Task[] = (tasks.get(id) ?? []).map((task): Task => ({
          ...task,
          state:
            result.status === 'completed' ? 'done' : task.state === 'done' ? 'done' : 'blocked',
          updatedAt: new Date().toISOString(),
        }));
        runs.set(id, finished);
        tasks.set(id, finishedTasks);
        await durable?.putRun(finished);
        for (const task of finishedTasks) await durable?.putTask(task);
        // One approval covers both questions when the scan matched, because they
        // arrive together: "are these lines really secrets" and "may this be
        // pushed". Two sequential approvals for one run would be two
        // interruptions for one decision point.
        if ((result.commit || result.secretScan) && result.status === 'partially_completed') {
          const action = {
            executable: 'git',
            args: ['push', '--set-upstream', 'origin', `forge/${id.slice(0, 8)}`],
            cwd: result.workspace,
          };
          const approvalId = randomUUID();
          const approval: Approval = {
            id: approvalId,
            runId: id,
            actionClass: 'amber',
            actionDigest: actionDigest(action),
            normalizedAction: normalizeAction(action),
            scope: JSON.stringify({
              repositoryUrl: project.repositoryUrl,
              baseRef: started.configuration?.targetBranch ?? project.baseRef,
              ...(result.commit ? { commit: result.commit } : {}),
              // Recorded in the approval itself so the decision is auditable
              // from the approval alone: what matched, and which exact staged
              // content the answer applies to.
              ...(result.secretScan ? { secretScan: result.secretScan } : {}),
            }),
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          };
          approvals.set(approvalId, approval);
          await durable?.putApproval(approval);
          pendingIntegrations.set(approvalId, {
            runId: id,
            workspace: result.workspace,
            branch: `forge/${id.slice(0, 8)}`,
            baseRef: started.configuration?.targetBranch ?? project.baseRef,
            repositoryUrl: project.repositoryUrl,
            ...(result.commit ? { commit: result.commit } : {}),
            ...(result.secretScan ? { secretDigest: result.secretScan.digest } : {}),
          });
          await emitDurably(id, 'approval.requested', {
            approvalId,
            actionClass: 'amber',
            ...(result.secretScan ? { secretScan: result.secretScan } : {}),
          });
        }
        await emitDurably(id, 'run.finished', { state, ...result });
      })
      .catch(async (error: unknown) => {
        const current = runs.get(id);
        if (
          controller.signal.aborted &&
          (current?.state === 'paused' || current?.state === 'cancelled')
        ) {
          await emitDurably(id, 'run.execution_stopped', { state: current.state });
          return;
        }
        // ADR-029: the bounded wait for a worker ran out with the fleet still
        // empty. Nothing was spent and nothing is wrong with the run, so it is
        // paused and keeps its place rather than failed.
        if (error instanceof ProviderWaitExpired) {
          await pauseRunForProviderWait(id, error);
          return;
        }
        const latest = runs.get(id) ?? started;
        const failed: Run = { ...latest, state: 'failed', updatedAt: new Date().toISOString() };
        runs.set(id, failed);
        await durable?.putRun(failed);
        await emitDurably(id, 'run.failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timeLimitTimer);
        if (activeExecutions.get(id) === controller) activeExecutions.delete(id);
      });
    return reply.code(202).send({ accepted: true, mode: 'autonomous' });
  }
  return reply.code(409).send({ error: 'project_not_configured' });
});
app.post('/api/runs/:id/control', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = runs.get(id);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  const { action } = z
    .object({ action: z.enum(['pause', 'resume', 'cancel', 'retry']) })
    .parse(request.body);
  if (action === 'resume' || action === 'retry') {
    const allowed =
      action === 'resume'
        ? run.state === 'paused'
        : run.state === 'failed' || run.state === 'partially_completed';
    if (!allowed) return reply.code(409).send({ error: 'invalid_run_control' });
    emit(id, `run.${action}_requested`, { from: run.state });
    void restartRunWhenIdle(id);
    return reply.code(202).send({ accepted: true, action });
  }
  if (isTerminalRunState(run.state)) return reply.code(409).send({ error: 'invalid_run_control' });
  return controlRun(run, action);
});
function isTerminalRunState(state: Run['state']): boolean {
  return TERMINAL_RUN_STATES.has(state);
}
/**
 * The pause and cancel transitions. One implementation, because the guards
 * pause a run too (pauseRunByGuard) and a second copy of this state logic would
 * be a second place for it to go wrong.
 */
async function controlRun(run: Run, action: 'pause' | 'cancel'): Promise<Run> {
  const id = run.id;
  const state = action === 'pause' ? 'paused' : 'cancelled';
  const updated: Run = {
    ...run,
    state,
    updatedAt: new Date().toISOString(),
  };
  if (action === 'pause') updated.resumeState = run.state;
  else delete updated.resumeState;
  activeExecutions.get(id)?.abort();
  if (action === 'cancel') {
    for (const [jobId, job] of workerJobs) {
      if (job.runId !== id || !['queued', 'leased'].includes(job.state)) continue;
      const cancelled = durable
        ? await durable.cancelWorkerJob(jobId)
        : ({
            ...job,
            state: job.state === 'queued' ? 'cancelled' : 'cancel_requested',
          } as WorkerJob);
      if (cancelled) workerJobs.set(jobId, cancelled);
    }
  }
  runs.set(id, updated);
  await durable?.putRun(updated);
  await emitDurably(id, `run.${action}`);
  return updated;
}
app.get('/api/runs/:id/events', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events.get(id) ?? []) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const subscriber = (event: Record<string, unknown>) =>
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const subscribers = eventSubscribers.get(id) ?? new Set();
  subscribers.add(subscriber);
  eventSubscribers.set(id, subscribers);
  const timer = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
  request.raw.on('close', () => {
    clearInterval(timer);
    subscribers.delete(subscriber);
    if (!subscribers.size) eventSubscribers.delete(id);
  });
});
app.get('/api/approvals', async () =>
  [...approvals.values()].filter((item) => item.status === 'pending'),
);
app.post('/api/approvals/:id', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const current = approvals.get(id);
  if (!current) return reply.code(404).send({ error: 'not_found' });
  const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(request.body);
  if (new Date(current.expiresAt) <= new Date()) {
    const expired: Approval = { ...current, status: 'expired' };
    approvals.set(id, expired);
    await durable?.putApproval(expired);
    return reply.code(409).send({ error: 'approval_expired' });
  }
  if (current.status === 'rejected' || current.status === 'expired') {
    return reply.code(409).send({ error: 'approval_already_decided' });
  }
  if (decision === 'rejected' && current.status !== 'pending') {
    return reply.code(409).send({ error: 'approval_already_decided' });
  }
  const next: Approval = {
    ...current,
    status: decision,
    decidedAt: current.decidedAt ?? new Date().toISOString(),
  };
  approvals.set(id, next);
  await durable?.putApproval(next);
  await emitDurably(current.runId, 'approval.decided', { approvalId: id, decision });
  let integration = pendingIntegrations.get(id);
  if (decision === 'approved' && integration) {
    if (integrationExecutions.has(id)) {
      return reply.code(409).send({ approval: next, error: 'integration_in_progress' });
    }
    integrationExecutions.add(id);
    try {
      if (!env.GITHUB_TOKEN) {
        await emitDurably(current.runId, 'integration.blocked', {
          classification: 'missing_access',
          smallestUnblockAction: 'Set GITHUB_TOKEN and retry the exact integration approval.',
        });
        return reply.code(409).send({ approval: next, error: 'github_token_missing' });
      }
      const match = integration.repositoryUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!match?.[1] || !match[2]) {
        return reply.code(409).send({ approval: next, error: 'unsupported_repository_url' });
      }
      try {
        // The commit has not been made when the secret scan raised this
        // approval, so make it now, passing the digest the approval was pinned
        // to. `commit` compares that against what is staged at this moment and
        // refuses if it has moved, which is the same protection the committed
        // path gets from pinning HEAD below.
        if (integration.secretDigest && !integration.commit) {
          try {
            const committed = await new GitWorkspaceRuntime(
              resolve(env.FORGE_WORKSPACE_ROOT),
            ).commit(
              integration.workspace,
              `forge: ${runs.get(integration.runId)?.objective.slice(0, 64) ?? 'approved change'}`,
              integration.secretDigest,
            );
            integration = { ...integration, commit: committed };
            pendingIntegrations.set(id, integration);
            await emitDurably(current.runId, 'integration.committed', { commit: committed });
          } catch (error) {
            if (!(error instanceof SecretScanRefusal)) throw error;
            await emitDurably(current.runId, 'integration.blocked', {
              classification: 'safety_constraint',
              smallestUnblockAction:
                'The staged changes moved since the approval; review and approve the new content explicitly.',
            });
            return reply.code(409).send({ approval: next, error: 'approval_scope_changed' });
          }
        }
        const head = (await runGit(['rev-parse', 'HEAD'], integration.workspace)).stdout.trim();
        if (head !== integration.commit) {
          await emitDurably(current.runId, 'integration.blocked', {
            classification: 'safety_constraint',
            smallestUnblockAction: 'Review and approve the changed commit explicitly.',
          });
          return reply.code(409).send({ approval: next, error: 'approval_scope_changed' });
        }
        await pushBranchWithGitHubToken(
          integration.workspace,
          integration.branch,
          env.GITHUB_TOKEN,
        );
        const github = new GitHubIntegration(env.GITHUB_TOKEN);
        const pullRequest = await github.createDraftPullRequest(
          match[1],
          match[2],
          integration.branch,
          integration.baseRef,
          runs.get(integration.runId)?.objective.slice(0, 120) ?? 'TheForge change',
          'Created by TheForge after an exact-action approval. Review evidence in the run dashboard.',
        );
        const run = runs.get(integration.runId);
        if (run) {
          const completed: Run = {
            ...run,
            state: 'completed',
            updatedAt: new Date().toISOString(),
          };
          runs.set(run.id, completed);
          const completedTasks: Task[] = (tasks.get(run.id) ?? []).map((task): Task => ({
            ...task,
            state: 'done',
            updatedAt: new Date().toISOString(),
          }));
          tasks.set(run.id, completedTasks);
          await durable?.putRun(completed);
          for (const task of completedTasks) await durable?.putTask(task);
        }
        pendingIntegrations.delete(id);
        await emitDurably(current.runId, 'integration.pull_request_created', {
          url: pullRequest.url,
        });
        return { approval: next, pullRequest };
      } catch (error) {
        await emitDurably(current.runId, 'integration.failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        return reply.code(409).send({
          approval: next,
          error: 'integration_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      integrationExecutions.delete(id);
    }
  }
  return next;
});

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.log({ level: 'error', message });
  // Fastify's body-limit rejection has to stay a 413: the worker replaces a
  // refused completion with a failure only on 400 and 413, and a 500 would
  // leave the job to re-lease.
  const tooLarge =
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    error.statusCode === 413;
  const status = error instanceof z.ZodError ? 400 : tooLarge ? 413 : 500;
  void reply.code(status).send({
    error:
      status === 400 ? 'invalid_request' : status === 413 ? 'payload_too_large' : 'internal_error',
    message,
  });
});
if (durable) {
  for (const run of runs.values()) {
    if (run.state !== 'executing') continue;
    queueMicrotask(() => {
      void app.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/start`,
        headers: { authorization: `Bearer ${env.FORGE_COORDINATOR_TOKEN}` },
      });
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await app.listen({ port: env.PORT, host: env.HOST });
  logger.log({ level: 'info', message: `Coordinator listening on ${env.HOST}:${env.PORT}` });
  // Say where the kill switch is while someone is still looking at the console,
  // and shout if it is already set: a coordinator that starts halted is doing
  // exactly what it was told, but that is easy to mistake for a stall.
  const halt = await haltStatus();
  logger.log({
    level: halt.halted ? 'warn' : 'info',
    message: halt.halted
      ? `Halt file present at ${haltFilePath}; no work will be leased until it is removed`
      : `Kill switch file: ${haltFilePath}`,
    fields: {
      haltFile: haltFilePath,
      halted: halt.halted,
      ...(halt.request ? { request: halt.request } : {}),
    },
  });
  // The guard settings, in the same breath, so a run paused by the ceiling can
  // be read back against what the ceiling actually was.
  const ceiling = guards.ceilingStatus();
  const budget = guards.budgetStatus();
  logger.log({
    level: ceiling.state === 'exceeded' ? 'warn' : 'info',
    message: `Guardrails: ${ceiling.message}`,
    fields: {
      dailyCeilingUsd: guards.ceiling.dailyUsd,
      baseDailyCeilingUsd: env.FORGE_DAILY_CEILING_USD,
      ...(budget
        ? {
            monthlyBudgetUsd: env.FORGE_MONTHLY_BUDGET_USD,
            budgetPeriod: `${budget.period.start} to ${budget.period.next}`,
            budgetSpentUsd: budget.spentInPeriodUsd,
            budgetRemainingUsd: budget.remainingUsd,
            budgetDaysLeft: budget.period.daysLeft,
            dailyCapLimitedBy: budget.limitedBy,
          }
        : {}),
      warnAtFraction: env.FORGE_CEILING_WARN_FRACTION,
      timeZone: env.FORGE_TIMEZONE,
      day: ceiling.day,
      maxAgents: env.FORGE_MAX_AGENTS,
      minFreeMemoryMb: env.FORGE_MIN_FREE_MEMORY_MB,
    },
  });
}
export { app };

function restorePipelineCheckpoint(items: Array<Record<string, unknown>>) {
  const checkpoint: {
    plan?: string;
    critique?: string;
    revisedPlan?: string;
    built?: boolean;
  } = {};
  for (const item of items) {
    const type = typeof item.type === 'string' ? item.type : '';
    const payload =
      item.payload && typeof item.payload === 'object'
        ? (item.payload as Record<string, unknown>)
        : {};
    if (type === 'plan.completed' && typeof payload.plan === 'string')
      checkpoint.plan = payload.plan;
    if (type === 'critique.completed' && typeof payload.critique === 'string')
      checkpoint.critique = payload.critique;
    if (type === 'plan.revised' && typeof payload.revised === 'string')
      checkpoint.revisedPlan = payload.revised;
    if (type === 'build.completed') checkpoint.built = true;
  }
  return Object.keys(checkpoint).length ? checkpoint : undefined;
}

async function persistStructuredEvidence(event: ForgeEvent): Promise<void> {
  const taskId =
    evidenceTaskId(event.runId, event.type) ??
    (event.type === 'provider.session' || event.type === 'run.paused_by_guard'
      ? taskIdForProviderRole(event.runId, stringField(event.payload.role))
      : undefined);
  const provider =
    stringField(event.payload.provider) ?? configuredProvider(event.runId, event.type);
  const message = messageFromEvent(event, taskId, provider);
  if (message) {
    upsertMemory(messages, event.runId, message);
    await durable?.appendMessage(message);
  }

  if (event.type === 'review.completed' && taskId && Array.isArray(event.payload.findings)) {
    for (const [index, raw] of event.payload.findings.entries()) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const claim = stringField(item.claim);
      const requestedAction = stringField(item.action);
      const severity = String(item.severity);
      if (
        !claim ||
        !requestedAction ||
        !['info', 'low', 'medium', 'high', 'critical'].includes(severity)
      )
        continue;
      const finding: Finding = {
        id: `${event.id}:finding:${index}`,
        runId: event.runId,
        taskId,
        claim,
        severity: severity as Finding['severity'],
        evidence: [event.id],
        affectedCriterion: 'Independent review approval',
        requestedAction,
        status: event.payload.approved === true ? 'resolved' : 'open',
      };
      upsertMemory(findings, event.runId, finding);
      await durable?.upsertFinding(finding);
    }
  }

  if (event.type === 'usage.recorded') {
    const inputTokens = nonnegativeInteger(event.payload.inputTokens);
    const outputTokens = nonnegativeInteger(event.payload.outputTokens);
    const costUsd = nonnegativeNumber(event.payload.usd);
    // The model that actually ran, when the pipeline reports it (a local
    // model's tag, a cloud alias); absent for older events.
    const model = stringField(event.payload.model);
    // The pipeline has emitted `role` on every `usage.recorded` event since it
    // was written (workflows, `accountUsage`); until migration 008 there was no
    // column to hold it, so this handler read the payload and dropped it. That
    // is why the cost review could not attribute a cent of spend to a role.
    // Validated against the enum rather than trusted: an event payload is data,
    // and an unrecognised value is better recorded as no role than as a role
    // that does not exist.
    const roleField = stringField(event.payload.role);
    const role = (roles as readonly string[]).includes(roleField ?? '')
      ? (roleField as NonNullable<UsageRecord['role']>)
      : undefined;
    // A subset of `inputTokens`, so clamped rather than taken on faith; a
    // malformed pair would otherwise make the fresh-token count negative.
    const cachedInputTokens = Math.min(
      nonnegativeInteger(event.payload.cachedInputTokens) ?? 0,
      inputTokens ?? 0,
    );
    if (
      provider &&
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      costUsd !== undefined
    ) {
      const usage: UsageRecord = {
        id: `${event.id}:usage`,
        runId: event.runId,
        ...(taskId ? { taskId } : {}),
        provider,
        ...(model ? { model } : {}),
        ...(role ? { role } : {}),
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costUsd,
        elapsedMs: nonnegativeInteger(event.payload.elapsedMs) ?? 0,
        tools: [],
        createdAt: event.createdAt,
      };
      upsertMemory(usageRecords, event.runId, usage);
      await durable?.upsertUsageRecord(usage);
      // The one place a usage record is materialised, on the live path and on
      // boot replay alike, so it is the one place the day total is fed.
      guards.onUsageRecorded(usage);
    }
  }

  const artifact = artifactFromEvent(event, taskId);
  if (artifact) {
    upsertMemory(artifacts, event.runId, artifact);
    await durable?.upsertArtifact(artifact);
  }
  const decision = decisionFromEvent(event);
  if (decision) {
    upsertMemory(decisions, event.runId, decision);
    await durable?.upsertDecision(decision);
  }
  const blocker = blockerFromEvent(event, taskId);
  if (blocker) {
    upsertMemory(blockers, event.runId, blocker);
    await durable?.upsertBlocker(blocker);
  }
  if (event.type === 'integration.pull_request_created') {
    const currentBlockers = durable
      ? await durable.listBlockers(event.runId)
      : (blockers.get(event.runId) ?? []);
    for (const current of currentBlockers.filter((item) => item.status === 'active')) {
      const resolved: Blocker = { ...current, status: 'resolved' };
      upsertMemory(blockers, event.runId, resolved);
      await durable?.upsertBlocker(resolved);
    }
  }
}

function messageFromEvent(
  event: ForgeEvent,
  taskId: string | undefined,
  provider: string | undefined,
): AgentMessage | undefined {
  if (event.type === 'provider.session') {
    const role = stringField(event.payload.role);
    if (!role || !['planner', 'critic', 'builder', 'reviewer'].includes(role)) return undefined;
    return {
      id: `${event.id}:message`,
      runId: event.runId,
      ...(taskId ? { taskId } : {}),
      type: 'provider_session',
      sender: {
        role: role as AgentMessage['sender']['role'],
        provider: provider ?? 'unknown',
      },
      claim: 'A resumable provider session checkpoint was recorded.',
      evidence: [event.id],
      criteria: [],
      confidence: 1,
      timestamp: event.createdAt,
      idempotencyKey: `${event.id}:message`,
    };
  }
  const mapping: Partial<
    Record<
      string,
      { role: AgentMessage['sender']['role']; field?: string; fallback: string; type: string }
    >
  > = {
    'plan.completed': {
      role: 'planner',
      field: 'plan',
      fallback: 'Planner completed the implementation plan.',
      type: 'plan',
    },
    'critique.completed': {
      role: 'critic',
      field: 'critique',
      fallback: 'Critic completed independent plan review.',
      type: 'critique',
    },
    'plan.revised': {
      role: 'planner',
      field: 'revised',
      fallback: 'Planner revised the plan from critique evidence.',
      type: 'revised_plan',
    },
    'build.completed': {
      role: 'builder',
      fallback: 'Builder completed changes in the isolated workspace.',
      type: 'implementation',
    },
    'review.completed': {
      role: 'reviewer',
      fallback: `Reviewer completed round ${
        typeof event.payload.round === 'number' || typeof event.payload.round === 'string'
          ? event.payload.round
          : '?'
      }.`,
      type: 'review',
    },
  };
  const selected = mapping[event.type];
  if (!selected) return undefined;
  const claim =
    (selected.field ? stringField(event.payload[selected.field]) : undefined) ?? selected.fallback;
  return {
    id: `${event.id}:message`,
    runId: event.runId,
    ...(taskId ? { taskId } : {}),
    type: selected.type,
    sender: { role: selected.role, provider: provider ?? 'unknown' },
    claim,
    evidence: [event.id],
    criteria: [],
    confidence: 1,
    timestamp: event.createdAt,
    idempotencyKey: `${event.id}:message`,
  };
}

function artifactFromEvent(event: ForgeEvent, taskId?: string): Artifact | undefined {
  let kind: Artifact['kind'] | undefined;
  let label = event.type;
  let uri = `forge:event/${event.id}`;
  if (event.type === 'verification.completed') {
    kind = 'test';
    label = event.payload.passed === true ? 'Verification passed' : 'Verification failed';
  } else if (event.type === 'integration.committed' && stringField(event.payload.commit)) {
    kind = 'commit';
    label = 'Accepted integration commit';
    uri = `git:${stringField(event.payload.commit)!}`;
  } else if (event.type === 'integration.pull_request_created' && stringField(event.payload.url)) {
    kind = 'pull_request';
    label = 'Draft pull request';
    uri = stringField(event.payload.url)!;
  } else if (event.type === 'run.finished') {
    kind = 'report';
    label = 'Final run report';
    uri = `forge:run/${event.runId}/report`;
  }
  if (!kind) return undefined;
  return {
    id: `${event.id}:artifact`,
    runId: event.runId,
    ...(taskId ? { taskId } : {}),
    kind,
    label,
    uri,
    metadata: event.payload,
    createdAt: event.createdAt,
  };
}

function decisionFromEvent(event: ForgeEvent): Decision | undefined {
  if (
    event.type !== 'plan.revised' &&
    event.type !== 'run.finished' &&
    event.type !== 'approval.decided'
  )
    return undefined;
  const approvalDecision = stringField(event.payload.decision);
  return {
    id: `${event.id}:decision`,
    runId: event.runId,
    title:
      event.type === 'plan.revised'
        ? 'Revised plan accepted'
        : event.type === 'approval.decided'
          ? 'Exact-action approval decision'
          : 'Run terminal state',
    rationale:
      event.type === 'plan.revised'
        ? 'The planner incorporated the independent critique before implementation.'
        : event.type === 'approval.decided'
          ? `The operator recorded an exact-action ${approvalDecision ?? 'decision'}.`
          : `The orchestration result was ${stringField(event.payload.state) ?? 'recorded'}.`,
    status:
      event.type === 'plan.revised'
        ? 'accepted'
        : event.type === 'approval.decided'
          ? (approvalDecision ?? 'recorded')
          : (stringField(event.payload.state) ?? 'recorded'),
    evidence: [event.id],
    createdAt: event.createdAt,
  };
}

function blockerFromEvent(event: ForgeEvent, taskId?: string): Blocker | undefined {
  const summary =
    event.type === 'run.failed'
      ? stringField(event.payload.message)
      : event.type === 'run.finished'
        ? stringField(event.payload.blocker)
        : event.type === 'integration.blocked'
          ? stringField(event.payload.smallestUnblockAction)
          : event.type === 'integration.failed'
            ? stringField(event.payload.message)
            : event.type === 'run.paused_by_guard'
              ? stringField(event.payload.reason)
              : undefined;
  const fallbackTask = tasks.get(event.runId)?.at(-1)?.id;
  if (!summary || !(taskId ?? fallbackTask)) return undefined;
  // A guard pause carries its own unblock action (raise the ceiling, wait for
  // the next local day, route locally); every other blocker's summary is one.
  const smallestUnblockAction =
    (event.type === 'run.paused_by_guard' ? stringField(event.payload.resumeHint) : undefined) ??
    summary;
  return {
    id: `${event.id}:blocker`,
    runId: event.runId,
    taskId: (taskId ?? fallbackTask)!,
    classification: blockerClassification(event.payload.classification),
    summary,
    evidence: [event.id],
    impact:
      'The run cannot advance to a fully verified integration until this condition is resolved.',
    attempts: ['The bounded workflow and configured deterministic checks were executed.'],
    smallestUnblockAction,
    status: 'active',
  };
}

function blockerClassification(value: unknown): Blocker['classification'] {
  return [
    'transient',
    'missing_access',
    'external_dependency',
    'product_decision',
    'technical_unknown',
    'safety_constraint',
  ].includes(String(value))
    ? (value as Blocker['classification'])
    : 'technical_unknown';
}

function evidenceTaskId(runId: string, type: string): string | undefined {
  const title =
    type.startsWith('plan.') || type.startsWith('critique.')
      ? 'Context and plan'
      : type.startsWith('build.')
        ? 'Implement objective'
        : type.startsWith('review.') || type.startsWith('verification.')
          ? 'Review and verify'
          : type.startsWith('integration.') || type === 'run.finished' || type === 'run.failed'
            ? 'Integrate and report'
            : undefined;
  return title ? findRunTaskId(runId, title) : undefined;
}

function taskIdForProviderRole(runId: string, role: string | undefined): string | undefined {
  const title =
    role === 'planner' || role === 'critic'
      ? 'Context and plan'
      : role === 'builder'
        ? 'Implement objective'
        : role === 'reviewer'
          ? 'Review and verify'
          : undefined;
  return title ? findRunTaskId(runId, title) : undefined;
}

function configuredProvider(runId: string, type: string): string | undefined {
  const role =
    type === 'plan.revised' ? 'planner' : type === 'build.completed' ? 'builder' : undefined;
  return role ? runs.get(runId)?.configuration?.providerRoles[role] : undefined;
}

function upsertMemory<T extends { id: string }>(
  collection: Map<string, T[]>,
  runId: string,
  value: T,
): void {
  const current = collection.get(runId) ?? [];
  const index = current.findIndex((item) => item.id === value.id);
  collection.set(
    runId,
    index === -1
      ? [...current, value]
      : current.map((item, itemIndex) => (itemIndex === index ? value : item)),
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  const parsed = nonnegativeNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

async function restartRunWhenIdle(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && activeExecutions.has(runId); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (activeExecutions.has(runId)) {
    emit(runId, 'run.restart_failed', { message: 'Previous execution did not stop in time' });
    return;
  }
  const response = await app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/start`,
    headers: { authorization: `Bearer ${env.FORGE_COORDINATOR_TOKEN}` },
  });
  if (response.statusCode >= 300) {
    emit(runId, 'run.restart_failed', {
      statusCode: response.statusCode,
      response: response.json(),
    });
  }
}

async function dispatchWorkerCheck(
  runId: string,
  action: {
    executable: string;
    args: string[];
    cwd: string;
    network?: 'install';
    steps?: Array<{
      executable: string;
      args: string[];
      network?: 'install';
      stopOnFailure?: boolean;
    }>;
  },
  signal?: AbortSignal,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  steps?: Array<{ command: string; code: number; stdout: string; stderr: string }>;
}> {
  const base = await createTransportedWorkerAction(runId, action);
  // Both carried only when the pipeline sets them, and both part of the
  // idempotency key below, so an install and a check of the same command are
  // different jobs, and so are a stepped verification and a bare one.
  const transported = {
    ...base,
    ...(action.network ? { network: action.network } : {}),
    ...(action.steps && action.steps.length > 0 ? { steps: action.steps } : {}),
  };
  const job: WorkerJob = {
    id: randomUUID(),
    runId,
    taskId: findRunTaskId(runId, 'Review and verify'),
    attemptId: randomUUID(),
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify({ type: 'check', action: transported }))
      .digest('hex'),
    action: transported,
    requiredCapabilities: ['node', 'sandbox:docker', 'execution-os:linux'],
    state: 'queued',
  };
  return waitForWorkerJob(job, signal, 'verification');
}

async function dispatchWorkerProvider(
  providerId: ProviderId,
  request: ProviderRequest,
  cwd: string,
  signal?: AbortSignal,
): Promise<NonNullable<WorkerJob['result']>> {
  // Policies B2/B3, at the one point every cloud call passes through. A
  // refusal never enqueues a job: the run is paused first, then the pipeline is
  // handed a non-retryable error event through WorkerProviderAdapter.run, which
  // collectProvider turns into a throw. The pipeline's catch sees an aborted
  // controller on a paused run and records run.execution_stopped rather than
  // run.failed. Nothing waits on a worker, so this takes milliseconds, not the
  // 900 s that waitForWorkerJob would spend looking for one.
  const decision = guards.beforeCloudCall(request.runId, request.role, providerId);
  if (!decision.allowed) {
    await pauseRunByGuard(request.runId, request.role, decision.verdict);
    return {
      code: 1,
      stdout: '',
      stderr: decision.verdict.reason,
      events: [
        {
          type: 'error',
          code: 'SPEND_CEILING',
          message: `${decision.verdict.reason}. ${GUARD_RESUME_HINT}`,
          retryable: false,
        },
      ],
    };
  }
  // A local model runs in the worker process, not in the sandbox, so the job
  // needs no Docker and no Linux; it needs a worker that has the model, which
  // is what the `model:<name>` capability the worker advertises is for. An
  // ollama request that names no model gets the tier-2 default here, so the
  // requirement is always concrete.
  const local = providerId === 'ollama';
  const dispatched: ProviderRequest = local
    ? { ...request, model: request.model ?? DEFAULT_LOCAL_MODEL }
    : request;
  const action = await createTransportedWorkerAction(request.runId, {
    kind: 'provider',
    providerId,
    request: dispatched,
    cwd,
  });
  const job: WorkerJob = {
    id: randomUUID(),
    runId: request.runId,
    taskId: findRunTaskId(
      request.runId,
      request.role === 'builder'
        ? 'Implement objective'
        : request.role === 'reviewer' || request.role === 'verifier'
          ? 'Review and verify'
          : 'Context and plan',
    ),
    attemptId: randomUUID(),
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify({ type: 'provider', action }))
      .digest('hex'),
    action,
    requiredCapabilities: local
      ? [`provider:${providerId}`, ...(dispatched.model ? [`model:${dispatched.model}`] : [])]
      : [`provider:${providerId}`, 'sandbox:docker', 'execution-os:linux'],
    state: 'queued',
  };
  return waitForWorkerJob(job, signal, `provider.${providerId}`);
}

/**
 * Pause a run because a guard refused it, through the same transition the
 * control route uses, then record why. The `run.paused_by_guard` event carries
 * the reason and the unblock action; persistStructuredEvidence turns it into an
 * active `safety_constraint` blocker on the role's task. A run that is already
 * paused (a resume attempt refused at /start) keeps its state and only gains
 * the event, so a second refusal never stacks a second transition.
 */
async function pauseRunByGuard(
  runId: string,
  role: string | undefined,
  verdict: SpendRefusal,
): Promise<void> {
  const run = runs.get(runId);
  if (run && run.state !== 'paused' && !isTerminalRunState(run.state)) {
    await controlRun(run, 'pause');
  }
  logger.log({
    level: 'warn',
    message: `run paused by spend guard: ${verdict.reason}`,
    runId,
    fields: { ...(role ? { role } : {}), day: verdict.day, dayUsd: verdict.dayUsd },
  });
  await emitDurably(runId, 'run.paused_by_guard', {
    guard: 'spend',
    ...(role ? { role } : {}),
    reason: verdict.reason,
    dayUsd: verdict.dayUsd,
    ceilingUsd: verdict.ceilingUsd,
    day: verdict.day,
    timeZone: verdict.timeZone,
    routing: verdict.routing,
    classification: 'safety_constraint',
    resumeHint: GUARD_RESUME_HINT,
  });
}

/**
 * Pause a run whose bounded wait for a worker expired (ADR-029).
 *
 * Deliberately the same transition and the same event as a guard pause: the
 * operator, the dashboard, the digest and the escalation policy already know
 * `run.paused_by_guard`, and `guard: 'provider'` is all that tells the two
 * apart. persistStructuredEvidence turns it into an active safety_constraint
 * blocker on the last task, so the run is resumable the moment a worker is back.
 */
async function pauseRunForProviderWait(runId: string, error: ProviderWaitExpired): Promise<void> {
  const run = runs.get(runId);
  if (run && run.state !== 'paused' && !isTerminalRunState(run.state)) {
    await controlRun(run, 'pause');
  }
  logger.log({
    level: 'warn',
    message: `run paused waiting for a worker: ${error.message}`,
    runId,
    fields: { waitedMs: error.waitedMs },
  });
  await emitDurably(runId, 'run.paused_by_guard', {
    guard: 'provider',
    reason: error.message,
    waitedMs: error.waitedMs,
    diagnostics: error.diagnostics,
    classification: 'safety_constraint',
    resumeHint: PROVIDER_RESUME_HINT,
  });
}

function logLeaseRefusal(reason: string): void {
  const now = Date.now();
  if (now - leaseRefusalLoggedAt < 60_000) return;
  leaseRefusalLoggedAt = now;
  logger.log({ level: 'warn', message: `lease refused by guard: ${reason}` });
}

function logWorkerJobWaitHalt(
  job: WorkerJob,
  halted: boolean,
  activeMs: number,
  budgetMs: number,
): void {
  const transition = halted ? 'halted' : 'resumed';
  const now = Date.now();
  if (now - workerJobWaitHaltLoggedAt[transition] < 60_000) return;
  workerJobWaitHaltLoggedAt[transition] = now;
  logger.log({
    level: halted ? 'warn' : 'info',
    message: halted
      ? 'worker job wait paused: halt file present; queued jobs are not timing out'
      : 'worker job wait resumed: halt file removed',
    fields: { jobId: job.id, runId: job.runId, haltFile: haltFilePath, activeMs, budgetMs },
  });
}

/**
 * What a limit-tripped provider job consumed, as the coordinator can see it.
 * Tool calls and tokens come from the job's own events; wall clock is measured
 * from the job's lease event because the completion carries no timestamp and
 * the provider event schema has no room for one.
 */
function taskUsageFromEvents(
  runId: string,
  jobId: string,
  providerEvents: ReadonlyArray<{ type: string; inputTokens?: number; outputTokens?: number }>,
): { toolCalls: number; tokens: number; elapsedMinutes?: number } {
  const toolCalls = providerEvents.filter((event) => event.type === 'tool_request').length;
  const tokens = providerEvents.reduce(
    (total, event) =>
      event.type === 'usage' ? total + (event.inputTokens ?? 0) + (event.outputTokens ?? 0) : total,
    0,
  );
  const leased = (events.get(runId) ?? []).find(
    (event) =>
      event.type === 'worker_job.leased' &&
      (event.payload as { jobId?: unknown } | undefined)?.jobId === jobId,
  );
  const leasedAt = typeof leased?.createdAt === 'string' ? Date.parse(leased.createdAt) : NaN;
  return {
    toolCalls,
    tokens,
    ...(Number.isFinite(leasedAt)
      ? { elapsedMinutes: Math.round(((Date.now() - leasedAt) / 60_000) * 100) / 100 }
      : {}),
  };
}

async function waitForWorkerJob(job: WorkerJob, signal: AbortSignal | undefined, event: string) {
  workerJobs.set(job.id, job);
  if (durable && job.taskId && job.attemptId) {
    const submittedId = job.id;
    job = await durable.createAttemptWorkerJob(job.taskId, job.attemptId, job);
    if (job.id === submittedId) {
      const runTasks = tasks.get(job.runId) ?? [];
      tasks.set(
        job.runId,
        runTasks.map((task): Task =>
          task.id === job.taskId
            ? {
                ...task,
                state: 'in_progress',
                attempts: task.attempts + 1,
                updatedAt: new Date().toISOString(),
              }
            : task,
        ),
      );
    }
  } else {
    await durable?.upsertWorkerJob(job);
  }
  await pushJobHint(job);
  emit(job.runId, `${event}.worker_job_queued`, { jobId: job.id, action: job.action });
  // Only un-halted time counts against the budget. While the halt file exists
  // the lease route answers 204, so a queued job cannot be taken, and a halt
  // longer than the budget must not become a timeout that cancels the job and
  // fails the run (docs/OPERATIONS.md "Worktrees and retries"). The job is
  // still polled meanwhile: one leased before the halt may finish under it.
  // `activeMs` accrues on every tick regardless of the job's state, so this
  // budget bounds the TOTAL un-halted time from submission to completion - not
  // the time spent queued, which is what the variable's name and `.env.example`
  // both suggested until 04/10/2026. It is therefore a cap on how long any
  // single stage may take, and at its 15-minute default it contradicts
  // `DEFAULT_TASK_LIMITS.maxWallClockMinutes`, which allows 30.
  //
  // That is not academic: a real builder stage on PulseApp took 13 minutes on
  // one attempt and 16 on the next, so it straddles the line and the outcome
  // was effectively a coin toss.
  // Two budgets, because the two phases want opposite values: give up early on
  // waiting for a worker, and give a worker that HAS the job longer than one
  // stage's wall clock. One number for both is what ended attempt eighteen with
  // a cancelled job whose result carried `code: 0`.
  const queueBudgetMs = env.FORGE_WORKER_JOB_WAIT_MS;
  const executionBudgetMs = env.FORGE_WORKER_JOB_EXECUTION_MS;
  let queuedMs = 0;
  let executingMs = 0;
  let tickedAt = Date.now();
  let halted = false;
  // The phase the job was in for the interval about to be counted, as observed
  // at the end of the previous tick. A reclaimed lease puts it back to queued
  // and queue time accrues again, which is right: it is waiting for a worker.
  let leased = false;
  // Kept for the message only. `leased` decides which budget is spent; this
  // records that a worker once had it, which tells a reader whether the run
  // lost queued time or lost work.
  let everLeased = false;
  while (true) {
    const now = Date.now();
    ({ queuedMs, executingMs } = accrueJobWaitBudget({
      leased,
      halted,
      elapsedMs: now - tickedAt,
      queuedMs,
      executingMs,
    }));
    tickedAt = now;
    const haltedNow = existsSync(haltFilePath);
    if (haltedNow !== halted) {
      halted = haltedNow;
      logWorkerJobWaitHalt(
        job,
        halted,
        leased ? executingMs : queuedMs,
        leased ? executionBudgetMs : queueBudgetMs,
      );
    }
    if (queuedMs >= queueBudgetMs || executingMs >= executionBudgetMs) break;
    if (signal?.aborted) {
      const cancelled = durable ? await durable.cancelWorkerJob(job.id) : workerJobs.get(job.id);
      if (cancelled) workerJobs.set(job.id, cancelled);
      throw signal.reason instanceof Error ? signal.reason : new Error('Verification cancelled');
    }
    const current = durable
      ? (await durable.listWorkerJobs(job.runId)).find((candidate) => candidate.id === job.id)
      : workerJobs.get(job.id);
    if (current) workerJobs.set(current.id, current);
    if (current) {
      leased = current.state !== 'queued';
      if (leased) everLeased = true;
    }
    if (current?.state === 'completed' || current?.state === 'failed') {
      if (!current.result) throw new Error(`Worker job ${job.id} completed without a result`);
      emit(job.runId, `${event}.worker_job_finished`, {
        jobId: job.id,
        workerId: current.workerId,
        code: current.result.code,
      });
      return current.result;
    }
    if (current?.state === 'cancelled') throw new Error(`Worker job ${job.id} was cancelled`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  // One last look before giving up, because a budget expiring is not evidence
  // that the work failed. On attempt eighteen of the first real objective the
  // builder's job carried `code: 0` in the database and was cancelled anyway,
  // so the run failed with a usable result sitting in it. The completion can
  // land in the 250 ms between the last poll and the budget running out, and
  // the lease outlives the budget by FORGE_JOB_LEASE_MS, so the window is real
  // rather than theoretical.
  const settled = durable
    ? (await durable.listWorkerJobs(job.runId)).find((candidate) => candidate.id === job.id)
    : workerJobs.get(job.id);
  if (settled) workerJobs.set(settled.id, settled);
  const late = acceptLateCompletion(settled);
  if (late) {
    emit(job.runId, `${event}.worker_job_finished`, {
      jobId: job.id,
      workerId: settled?.workerId,
      code: late.code,
      // Named so the record says the budget was exceeded and the work survived
      // anyway, rather than silently looking like an ordinary completion.
      afterBudget: true,
    });
    return late;
  }
  const cancelled = durable ? await durable.cancelWorkerJob(job.id) : undefined;
  if (cancelled) workerJobs.set(job.id, cancelled);
  // Each budget names itself, and the execution message names the stage timeout
  // too: the two bound the same work and the reader's next question is which of
  // them to change. The old single message described only the queue case and
  // was printed for both, which sent one investigation after lease expiry when
  // a worker had the job and was still working.
  throw new Error(
    executingMs >= executionBudgetMs
      ? `Worker job ${job.id} was leased but did not finish within ${Math.round(executionBudgetMs / 60_000)} minutes of un-halted execution (FORGE_WORKER_JOB_EXECUTION_MS); FORGE_STAGE_TIMEOUT_MS bounds the stage inside it and should be the smaller of the two`
      : `Worker job ${job.id} spent ${Math.round(queueBudgetMs / 60_000)} minutes of un-halted time queued without a compatible worker leasing it (FORGE_WORKER_JOB_WAIT_MS)${everLeased ? '; a worker had leased it earlier and the lease was reclaimed' : ''}`,
  );
}

/**
 * A timeout signal that does not advance while the system is halted.
 *
 * `AbortSignal.timeout` counts wall clock, so a halt longer than the stage
 * timeout failed the run even though the job's own queue budget had correctly
 * paused and the job had never started. The kill switch is meant to stop work
 * without losing it; this is the other half of that.
 *
 * Polls rather than subscribing because the halt is a file, which is the same
 * mechanism `waitForWorkerJob` uses and for the same reason: there is nothing
 * to subscribe to.
 *
 * Exported for its test. Two things it is deliberately NOT: the provider's own
 * `timeoutMs` and the worker's container deadline are still wall clock, so a
 * halt does not extend those. They bound a job a worker already has, and a
 * halted job is one no worker has taken.
 */
export function haltAwareTimeoutSignal(
  timeoutMs: number,
  isHalted: () => boolean,
  pollMs = 250,
): AbortSignal {
  const controller = new AbortController();
  let activeMs = 0;
  let tickedAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (!isHalted()) activeMs += now - tickedAt;
    tickedAt = now;
    if (activeMs >= timeoutMs) {
      clearInterval(timer);
      controller.abort(new Error(`Stage exceeded ${timeoutMs} ms of un-halted time`));
    }
  }, pollMs);
  // Never hold the process open on account of a stage that already finished.
  timer.unref?.();
  controller.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return controller.signal;
}

/**
 * Charge an interval to the phase the job was in for it, and to nothing while
 * the halt file is present.
 *
 * Extracted and exported because this is the rule the whole split rests on, and
 * until it was a function nothing tested it: restoring the attempt-eighteen bug
 * - charging executing time to the queue budget - passed all 667 tests. The
 * integration path cannot reach it cheaply, since a real execution timeout
 * needs a worker holding a job for minutes.
 *
 * Halted time counts against neither budget. A halt is the operator stopping
 * the system, and it should not spend a run's allowance either way.
 */
export function accrueJobWaitBudget(input: {
  /** The phase the job was in for this interval, from its last observed state. */
  leased: boolean;
  halted: boolean;
  elapsedMs: number;
  queuedMs: number;
  executingMs: number;
}): { queuedMs: number; executingMs: number } {
  const { leased, halted, elapsedMs, queuedMs, executingMs } = input;
  if (halted) return { queuedMs, executingMs };
  return leased
    ? { queuedMs, executingMs: executingMs + elapsedMs }
    : { queuedMs: queuedMs + elapsedMs, executingMs };
}

/**
 * A result worth keeping from the job as it stood after its budget ran out, or
 * undefined to cancel and fail as before.
 *
 * Only a job that reached `completed` or `failed` on its own counts. A
 * `cancelled` job is refused even when it carries a result, because that state
 * means somebody asked for the work to stop - honouring a result produced after
 * a cancellation would make the cancel advisory. A `leased` job is refused too:
 * it has not finished, and its budget is spent.
 *
 * Pure, and exported, so the decision is tested without having to make a real
 * completion land inside a 250 ms window.
 */
export function acceptLateCompletion(
  settled: WorkerJob | undefined,
): NonNullable<WorkerJob['result']> | undefined {
  if (!settled?.result) return undefined;
  return settled.state === 'completed' || settled.state === 'failed' ? settled.result : undefined;
}

function findRunTaskId(runId: string, title: string): string | undefined {
  return tasks.get(runId)?.find((task) => task.title === title)?.id;
}

async function pushJobHint(job: WorkerJob): Promise<void> {
  try {
    await Promise.race([
      jobQueue.push(job.id),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Redis queue hint timed out')), 500),
      ),
    ]);
  } catch (error) {
    logger.log({
      level: 'warn',
      message: `Worker job ${job.id} persisted without Redis hint: ${String(error)}`,
      runId: job.runId,
    });
  }
}

type SourceWorkerAction =
  | { kind?: 'command' | undefined; executable: string; args: string[]; cwd: string }
  | {
      kind: 'provider';
      providerId: ProviderId;
      request: ProviderRequest;
      cwd: string;
    };

async function createTransportedWorkerAction(
  runId: string,
  action: SourceWorkerAction,
): Promise<WorkerJobAction> {
  const { snapshot, workingDirectory } = await captureWorkspaceSnapshot(runId, action.cwd);
  return action.kind === 'provider'
    ? {
        kind: 'provider',
        providerId: action.providerId,
        request: action.request,
        workspace: snapshot,
        workingDirectory,
      }
    : {
        executable: action.executable,
        args: action.args,
        workspace: snapshot,
        workingDirectory,
      };
}

/**
 * A text file's bytes as git would store them: CRLF collapsed to LF.
 *
 * Tracked files reach the worker through a clone that already pins
 * `core.autocrlf=false`, so they arrive matching their blobs. UNTRACKED files do
 * not go through git at all - the worker writes them verbatim from this snapshot
 * - and their bytes are read off the coordinator's worktree, which on Windows is
 * CRLF because `git apply` honours `core.autocrlf` when it writes the builder's
 * patch. So a file the agent wrote as LF came back to it as CRLF, alone in a
 * tree of LF files.
 *
 * That was recorded as a known gap when the tracked-file fix landed, and
 * deliberately left until something failed over it. Something did: on shopfront's
 * first run `npm run format:check` failed on `src/lib/flags.test.ts` and nothing
 * else, because prettier saw CRLF in a repository that is LF throughout. Lint,
 * typecheck and the tests themselves all passed.
 *
 * Binary files are left exactly alone, using git's own heuristic - a NUL byte in
 * the first 8000 - rather than a guess of my own, so an untracked PNG or
 * sqlite file still arrives byte for byte.
 */
export function normalizeSnapshotText(content: Buffer): Buffer {
  if (content.subarray(0, 8000).includes(0)) return content;
  if (!content.includes('\r\n')) return content;
  return Buffer.from(content.toString('binary').split('\r\n').join('\n'), 'binary');
}

async function captureWorkspaceSnapshot(
  runId: string,
  cwd: string,
): Promise<{ snapshot: WorkerWorkspaceSnapshot; workingDirectory: string }> {
  const run = runs.get(runId);
  const project = run ? projects.get(run.projectId) : undefined;
  if (!project) throw new Error(`Project for run ${runId} was not found`);
  const root = resolve((await runGit(['rev-parse', '--show-toplevel'], cwd)).stdout.trim());
  const resolvedCwd = resolve(cwd);
  const directoryDifference = relative(root, resolvedCwd);
  if (
    directoryDifference === '..' ||
    directoryDifference.startsWith(`..${sep}`) ||
    isAbsolute(directoryDifference)
  )
    throw new Error('Worker action cwd escapes its Git workspace');
  const workingDirectory = directoryDifference ? directoryDifference.split(sep).join('/') : '.';
  const [revisionResult, patchResult, untrackedResult] = await Promise.all([
    runGit(['rev-parse', 'HEAD'], root),
    runGit(['diff', '--binary', 'HEAD', '--'], root),
    runGit(['ls-files', '--others', '--exclude-standard', '-z'], root),
  ]);
  const revision = revisionResult.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Git returned an invalid revision');
  if (Buffer.byteLength(patchResult.stdout) > 8_000_000)
    throw new Error('Tracked workspace patch exceeds the 8 MB transport limit');
  const paths = untrackedResult.stdout.split('\0').filter(Boolean).sort();
  if (paths.length > 128) throw new Error('Workspace has more than 128 untracked files');
  let untrackedBytes = 0;
  const untrackedFiles: WorkerWorkspaceSnapshot['untrackedFiles'] = [];
  for (const path of paths) {
    validateSnapshotPath(path);
    const source = resolve(root, ...path.split('/'));
    const metadata = await lstat(source);
    if (!metadata.isFile())
      throw new Error(`Untracked workspace path is not a regular file: ${path}`);
    if (metadata.size > 1_000_000)
      throw new Error(`Untracked workspace file exceeds the 1 MB limit: ${path}`);
    untrackedBytes += metadata.size;
    if (untrackedBytes > 4_000_000)
      throw new Error('Untracked workspace files exceed the 4 MB transport limit');
    untrackedFiles.push({
      path,
      contentBase64: normalizeSnapshotText(await readFile(source)).toString('base64'),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
  return {
    snapshot: {
      repositoryUrl: project.repositoryUrl,
      revision,
      patch: patchResult.stdout,
      untrackedFiles,
    },
    workingDirectory,
  };
}

function validateSnapshotPath(path: string): void {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid untracked workspace path: ${path}`);
}
