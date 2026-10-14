import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '@theforge/git-runtime';
import {
  children,
  createAcceptedPatch,
  createFixtureRepository,
  getJson,
  logRecords,
  notesSource,
  notesTestSource,
  post,
  processLogs,
  requireString,
  runFixtureTests,
  startCoordinator,
  startFixtureWorker,
  terminate,
  waitForRunState,
  waitForState,
  waitUntil,
  type RunDetail,
} from './fixtures/harness.js';

/**
 * The kill switch, end to end (F116, policy B13, checklist S4.5).
 *
 * apps/coordinator/src/server.test.ts proves the halt API against an injected
 * app. This proves the operator's procedure against real processes: a spawned
 * coordinator and fixture worker in this file's own schema, the halt file
 * written by the real CLI, the coordinator SIGKILLed and restarted with the
 * file still there, the file removed by the CLI, a second halt made by hand
 * and cleared through the API - and, at the end, the run finishing with
 * exactly the counts release-acceptance expects of an unhalted run.
 */
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

type HaltStatus = {
  halted: boolean;
  source: string;
  haltFile: string;
  request?: { requestedAt: string; requestedBy: string; reason?: string };
};
type Job = { id: string; state: string; workerId?: string; result?: { stdout: string } };

/** Long enough for several polls at the fixture's 100 ms interval, even under load. */
const OBSERVATION_MS = 3_000;
/** The fixture polls every 100 ms; anything near the lease or wait timeouts is a defect. */
const LEASE_RESUME_MS = 5_000;
/** The second test's FORGE_WORKER_JOB_WAIT_MS: far below the 900 s default, so a halt can outlast it. */
const WAIT_BUDGET_MS = 4_000;
/** How long the halt is held after the job is queued; longer than the budget by a clear margin. */
const HALT_MS = 6_000;

afterEach(async () => {
  for (const child of children.splice(0)) await terminate(child);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  processLogs.length = 0;
});

suite('kill switch end to end', () => {
  it('refuses new leases mid-run, lets in-flight work finish, survives a coordinator restart, and resumes when the file goes', async () => {
    // Already this file's own schema: tests/setup/isolated-schema.ts rewrote
    // DATABASE_URL before this module was evaluated.
    const isolatedDatabaseUrl = requireString(databaseUrl, 'DATABASE_URL');
    const suffix = randomUUID().slice(0, 8);
    const temp = await mkdtemp(join(tmpdir(), `forge-halt-${suffix}-`));
    const source = join(temp, 'fixture');
    const patchPath = join(temp, 'accepted.patch');
    const workspaceRoot = join(temp, 'managed');
    // FORGE_HALT_FILE wins over the workspace-root default; an absolute path
    // inside the temporary directory means the CLI, spawned from the checkout
    // root, and both coordinators name the same file.
    const haltFile = resolve(temp, 'control', 'FORGE_HALT');
    const workerAState = join(temp, 'worker-a.json');
    const workerARelease = join(temp, 'worker-a.release');
    const workerBState = join(temp, 'worker-b.json');
    const workerBRelease = join(temp, 'worker-b.release');
    cleanups.push(() => rm(temp, { recursive: true, force: true }));
    // Separate ports for the two coordinators, as release-acceptance does, and
    // a range of its own so the suites can run in parallel.
    const portA = 47_000 + Math.floor(Math.random() * 500);
    const portB = portA + 500;
    let api = `http://127.0.0.1:${portA}`;
    const coordinatorToken = `coordinator-${randomUUID()}-${randomUUID()}`;
    const workerToken = `worker-${randomUUID()}-${randomUUID()}`;
    const projectId = `halt-project-${suffix}`;
    const headers = {
      authorization: `Bearer ${coordinatorToken}`,
      'content-type': 'application/json',
    };
    const logs = () => processLogs.join('\n');
    await createFixtureRepository(source);
    await createAcceptedPatch(source, patchPath, temp);
    await mkdir(workspaceRoot, { recursive: true });

    const common = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: isolatedDatabaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      FORGE_COORDINATOR_TOKEN: coordinatorToken,
      FORGE_WORKER_TOKEN: workerToken,
      FORGE_WORKSPACE_ROOT: workspaceRoot,
      FORGE_HALT_FILE: haltFile,
      FORGE_JOB_LEASE_MS: '6000',
      HOST: '127.0.0.1',
    };
    const workerCommon = {
      FORGE_FAKE_PROVIDER_PATCH: patchPath,
      FORGE_FAKE_HOLD_FIRST: '1',
      FORGE_FAKE_POLL_LOG: '1',
    };
    const haltStatus = () => getJson<HaltStatus>(`${api}/api/halt`, headers);
    const jobsOf = (runId: string) => getJson<Job[]>(`${api}/api/runs/${runId}/jobs`, headers);
    const runOf = (runId: string) => getJson<RunDetail>(`${api}/api/runs/${runId}`, headers);

    // --- A running system, with the planner job leased and in flight -------
    let coordinator = startCoordinator('coordinator-a', common, portA);
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);
    // The startup line names the resolved path, so an operator reading the
    // console knows which file to create.
    await waitUntil(
      async () =>
        logRecords('coordinator-a').some(
          (record) => record.message === `Kill switch file: ${haltFile}`,
        ),
      10_000,
    );
    expect(
      logRecords('coordinator-a').find(
        (record) => record.message === `Kill switch file: ${haltFile}`,
      ),
      logs(),
    ).toMatchObject({ level: 'info', fields: { haltFile, halted: false } });
    expect(await haltStatus()).toMatchObject({ halted: false, source: 'none', haltFile });

    await post(`${api}/api/projects`, headers, {
      id: projectId,
      name: 'Kill switch fixture',
      repositoryUrl: source,
      baseRef: 'main',
      checks: [{ executable: process.execPath, args: ['--test'] }],
    });
    const created = await post<{ run: { id: string } }>(`${api}/api/runs`, headers, {
      projectId,
      objective: 'Add persisted notes with validation and deterministic tests',
      constraints: ['Do not push or fabricate pull-request evidence'],
      maxUsd: 1,
      maxTokens: 10_000,
      configuration: {
        providerRoles: {
          planner: 'codex',
          critic: 'claude',
          builder: 'codex',
          reviewer: 'claude',
        },
      },
    });
    const runId = created.run.id;
    startFixtureWorker('worker-a', common, portA, {
      ...workerCommon,
      FORGE_WORKER_ID: `halt-worker-a-${suffix}`,
      FORGE_FAKE_WORKER_STATE: workerAState,
      FORGE_FAKE_WORKER_RELEASE: workerARelease,
    });
    await waitForState(workerAState, (state) => state.registered === true, 60_000);
    const startResponse = await fetch(`${api}/api/runs/${runId}/start`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(startResponse.status, await startResponse.text()).toBe(202);
    const inFlight = await waitForState(
      workerAState,
      (state) => typeof state.jobId === 'string' && state.role === 'planner',
      60_000,
    );
    const plannerJobId = requireString(inFlight.jobId, 'planner job ID');
    expect((await jobsOf(runId)).find((job) => job.id === plannerJobId)).toMatchObject({
      state: 'leased',
      workerId: `halt-worker-a-${suffix}`,
    });

    // --- (a) halt through the real CLI while that job is in flight ----------
    const halt = await forgeCli(['halt', '--reason=e2e'], common);
    expect(halt.code, halt.stderr).toBe(0);
    expect(halt.stdout).toContain(`halted; halt file written: ${haltFile}`);
    expect(halt.stdout).toContain('reason: e2e');
    expect(existsSync(haltFile)).toBe(true);
    expect(await haltStatus()).toMatchObject({
      halted: true,
      source: 'file',
      haltFile,
      request: { requestedBy: 'cli', reason: 'e2e' },
    });

    // The in-flight job is not killed and its completion is accepted: the
    // fixture only records completedJobId once POST .../complete returns 2xx.
    await writeFile(workerARelease, 'release', 'utf8');
    await waitForState(workerAState, (state) => state.completedJobId === plannerJobId, 60_000);
    await waitUntil(
      async () => (await runOf(runId)).events.some((event) => event.type === 'plan.completed'),
      30_000,
    );
    expect((await jobsOf(runId)).find((job) => job.id === plannerJobId)).toMatchObject({
      state: 'completed',
    });
    // The pipeline moved on and queued the critic. That job must now sit there.
    await waitUntil(
      async () => (await jobsOf(runId)).some((job) => job.state === 'queued'),
      60_000,
    );
    const queuedJobs = (await jobsOf(runId)).filter((job) => job.state === 'queued');
    expect(queuedJobs, logs()).toHaveLength(1);
    const criticJobId = queuedJobs[0]!.id;

    const refusedA = await observeRefusal(workerAState, runId, jobsOf, runOf, criticJobId, logs);
    expect(refusedA.state.jobId, 'worker A must not have been handed a second job').toBe(
      plannerJobId,
    );
    const workspace = workspaceOf(await runOf(runId));
    expect(existsSync(join(workspace, 'README.md')), 'worktree left intact').toBe(true);

    // --- (b) SIGKILL the coordinator; restart it with the file still there ---
    await terminate(coordinator);
    for (const child of children.splice(0)) await terminate(child);
    coordinator = startCoordinator('coordinator-b', common, portB);
    api = `http://127.0.0.1:${portB}`;
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);
    await waitUntil(
      async () =>
        logRecords('coordinator-b').some(
          (record) =>
            record.message ===
            `Halt file present at ${haltFile}; no work will be leased until it is removed`,
        ),
      10_000,
    );
    expect(
      logRecords('coordinator-b').find((record) => record.level === 'warn'),
      logs(),
    ).toMatchObject({ fields: { haltFile, halted: true, request: { requestedBy: 'cli' } } });
    expect(await haltStatus()).toMatchObject({
      halted: true,
      source: 'file',
      haltFile,
      request: { requestedBy: 'cli', reason: 'e2e' },
    });
    startFixtureWorker('worker-b', common, portB, {
      ...workerCommon,
      FORGE_WORKER_ID: `halt-worker-b-${suffix}`,
      FORGE_FAKE_WORKER_STATE: workerBState,
      FORGE_FAKE_WORKER_RELEASE: workerBRelease,
    });
    await waitForState(workerBState, (state) => state.registered === true, 60_000);
    const refusedB = await observeRefusal(workerBState, runId, jobsOf, runOf, criticJobId, logs);
    expect(refusedB.state.jobId, 'a fresh worker must get nothing either').toBeUndefined();
    // The restarted coordinator resumed the run from its checkpoint and asked
    // for the critic again; the idempotency key handed back the queued job
    // rather than a duplicate.
    expect((await jobsOf(runId)).map((job) => job.id).sort()).toEqual(
      [plannerJobId, criticJobId].sort(),
    );

    // --- (c) resume through the real CLI: leasing restarts at the next poll --
    const resume = await forgeCli(['resume'], common);
    expect(resume.code, resume.stderr).toBe(0);
    expect(resume.stdout).toContain(`resumed; halt file removed: ${haltFile}`);
    const resumedAt = Date.now();
    expect(existsSync(haltFile)).toBe(false);
    const leased = await waitForState(
      workerBState,
      (state) => state.jobId === criticJobId,
      LEASE_RESUME_MS,
    );
    const leaseLatencyMs = Date.now() - resumedAt;
    console.info(`[halt] lease resumed ${leaseLatencyMs} ms after \`forge resume\``);
    expect(leased.role).toBe('critic');
    expect(await haltStatus()).toMatchObject({ halted: false, source: 'none' });

    // --- (d) a file made by hand, with the critic in flight, cleared by DELETE
    await mkdir(resolve(haltFile, '..'), { recursive: true });
    await writeFile(haltFile, '', 'utf8');
    const byHand = await haltStatus();
    expect(byHand).toMatchObject({ halted: true, source: 'file', haltFile });
    expect(byHand.request, 'an empty file carries no request; it halts anyway').toBeUndefined();
    const status = await forgeCli(['status'], {
      ...common,
      FORGE_API_URL: api,
    });
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('halted: yes');
    expect(status.stdout).toContain('made by hand');
    expect(status.stdout).toContain('coordinator halted: yes (source: file)');
    expect(status.stdout).toContain(`coordinator halt file: ${haltFile}`);
    expect(status.stderr, 'CLI and coordinator resolve the same file').toBe('');

    await writeFile(workerBRelease, 'release', 'utf8');
    await waitForState(workerBState, (state) => state.completedJobId === criticJobId, 60_000);
    await waitUntil(
      async () => (await runOf(runId)).events.some((event) => event.type === 'critique.completed'),
      30_000,
    );
    await waitUntil(
      async () => (await jobsOf(runId)).some((job) => job.state === 'queued'),
      60_000,
    );
    const revisedJobId = (await jobsOf(runId)).find((job) => job.state === 'queued')!.id;
    expect(revisedJobId).not.toBe(criticJobId);
    const refusedByHand = await observeRefusal(
      workerBState,
      runId,
      jobsOf,
      runOf,
      revisedJobId,
      logs,
    );
    expect(refusedByHand.state.jobId).toBe(criticJobId);

    // No content-type: a DELETE carries no body, and Fastify refuses an empty
    // JSON body - exactly what the documented curl sends.
    const cleared = await fetch(`${api}/api/halt`, {
      method: 'DELETE',
      headers: { authorization: headers.authorization },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({ halted: false, source: 'none', haltFile });
    expect(existsSync(haltFile)).toBe(false);

    // --- The run finishes exactly as release-acceptance expects of an unhalted run
    let detail = await waitForRunState(api, headers, runId, 'partially_completed', 180_000);
    await waitUntil(async () => {
      detail = await runOf(runId);
      return (
        detail.events.some((event) => event.type === 'approval.requested') &&
        detail.events.some((event) => event.type === 'run.finished')
      );
    }, 30_000);
    const eventTypes = detail.events.map((event) => event.type);
    expect(eventTypes).not.toContain('run.failed');
    expect(eventTypes).not.toContain('run.execution_stopped');
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'plan.completed',
        'critique.completed',
        'plan.revised',
        'build.completed',
        'verification.completed',
        'review.completed',
        'integration.committed',
        'approval.requested',
      ]),
    );
    expect(eventTypes).not.toContain('integration.pull_request_created');
    // Both coordinators reported the same worktree: the restart reused it.
    expect(
      new Set(
        detail.events
          .filter((event) => event.type === 'workspace.ready')
          .map((event) => event.payload.workspace),
      ),
    ).toEqual(new Set([workspace]));
    expect(detail.run.spent, logs()).toEqual({ usd: 0, tokens: 25 });
    expect(detail.tasks.every((task) => task.state === 'blocked')).toBe(true);
    expect(detail.messages.length, logs()).toBeGreaterThanOrEqual(9);
    expect(detail.usage, logs()).toHaveLength(5);
    expect(detail.attempts, logs()).toHaveLength(6);
    const jobs = await jobsOf(runId);
    expect(jobs, logs()).toHaveLength(6);
    expect(
      jobs.every((job) => job.state === 'completed'),
      logs(),
    ).toBe(true);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
    expect(jobs.find((job) => job.id === plannerJobId)).toMatchObject({
      workerId: `halt-worker-a-${suffix}`,
    });
    expect(jobs.find((job) => job.id === criticJobId)).toMatchObject({
      workerId: `halt-worker-b-${suffix}`,
    });
    expect(
      await getJson<Array<{ runId: string; status: string }>>(`${api}/api/approvals`, headers),
    ).toContainEqual(expect.objectContaining({ runId, status: 'pending' }));
    expect(await readFile(join(workspace, 'notes.js'), 'utf8')).toBe(notesSource);
    expect(await readFile(join(workspace, 'notes.test.js'), 'utf8')).toBe(notesTestSource);
    expect((await runGit(['status', '--short'], workspace)).stdout).toBe('');
    expect(
      (await runGit(['diff', '--name-only', 'HEAD^', 'HEAD'], workspace)).stdout
        .trim()
        .split(/\r?\n/),
    ).toEqual(['notes.js', 'notes.test.js']);
    await expect(runFixtureTests(workspace)).resolves.toBeUndefined();
  }, 300_000);

  it('does not count halted time against FORGE_WORKER_JOB_WAIT_MS: a queued job outlives a halt longer than its wait', async () => {
    // Before this, waitForWorkerJob counted wall-clock time: a halt longer than
    // its 900 s bound cancelled every queued job and failed its run
    // ("Read from the code, not yet proven" in docs/OPERATIONS.md). Here the
    // budget is WAIT_BUDGET_MS, the halt is held for HALT_MS after the planner
    // job is queued, and the job must still be there to lease afterwards.
    const isolatedDatabaseUrl = requireString(databaseUrl, 'DATABASE_URL');
    const suffix = randomUUID().slice(0, 8);
    const temp = await mkdtemp(join(tmpdir(), `forge-halt-wait-${suffix}-`));
    const source = join(temp, 'fixture');
    const patchPath = join(temp, 'accepted.patch');
    const workspaceRoot = join(temp, 'managed');
    const haltFile = resolve(temp, 'control', 'FORGE_HALT');
    const workerState = join(temp, 'worker.json');
    cleanups.push(() => rm(temp, { recursive: true, force: true }));
    // A range of its own, clear of the first test's two coordinators and of
    // the suites that run in parallel with this file.
    const port = 48_000 + Math.floor(Math.random() * 500);
    const api = `http://127.0.0.1:${port}`;
    const coordinatorToken = `coordinator-${randomUUID()}-${randomUUID()}`;
    const workerToken = `worker-${randomUUID()}-${randomUUID()}`;
    const projectId = `halt-wait-project-${suffix}`;
    const headers = {
      authorization: `Bearer ${coordinatorToken}`,
      'content-type': 'application/json',
    };
    const logs = () => processLogs.join('\n');
    await createFixtureRepository(source);
    await createAcceptedPatch(source, patchPath, temp);
    await mkdir(workspaceRoot, { recursive: true });
    const common = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: isolatedDatabaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      FORGE_COORDINATOR_TOKEN: coordinatorToken,
      FORGE_WORKER_TOKEN: workerToken,
      FORGE_WORKSPACE_ROOT: workspaceRoot,
      FORGE_HALT_FILE: haltFile,
      FORGE_JOB_LEASE_MS: '6000',
      FORGE_WORKER_JOB_WAIT_MS: String(WAIT_BUDGET_MS),
      HOST: '127.0.0.1',
    };
    const jobsOf = (runId: string) => getJson<Job[]>(`${api}/api/runs/${runId}/jobs`, headers);
    const runOf = (runId: string) => getJson<RunDetail>(`${api}/api/runs/${runId}`, headers);
    const pausedRecord = () =>
      logRecords('coordinator-wait').find(
        (record) =>
          record.message ===
          'worker job wait paused: halt file present; queued jobs are not timing out',
      );
    const resumedRecord = () =>
      logRecords('coordinator-wait').find(
        (record) => record.message === 'worker job wait resumed: halt file removed',
      );

    startCoordinator('coordinator-wait', common, port);
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);
    await post(`${api}/api/projects`, headers, {
      id: projectId,
      name: 'Halt-aware wait fixture',
      repositoryUrl: source,
      baseRef: 'main',
      checks: [{ executable: process.execPath, args: ['--test'] }],
    });
    const created = await post<{ run: { id: string } }>(`${api}/api/runs`, headers, {
      projectId,
      objective: 'Add persisted notes with validation and deterministic tests',
      constraints: ['Do not push or fabricate pull-request evidence'],
      maxUsd: 1,
      maxTokens: 10_000,
      configuration: {
        providerRoles: {
          planner: 'codex',
          critic: 'claude',
          builder: 'codex',
          reviewer: 'claude',
        },
      },
    });
    const runId = created.run.id;

    // Halt first, so the planner job is queued into a system that is already
    // stopped: every millisecond of its wait so far is halted time.
    expect(
      await post<HaltStatus>(`${api}/api/halt`, headers, { reason: 'wait-budget' }),
    ).toMatchObject({ halted: true, source: 'file', haltFile });
    startFixtureWorker('worker-wait', common, port, {
      FORGE_FAKE_PROVIDER_PATCH: patchPath,
      FORGE_FAKE_POLL_LOG: '1',
      FORGE_WORKER_ID: `halt-wait-worker-${suffix}`,
      FORGE_FAKE_WORKER_STATE: workerState,
    });
    await waitForState(workerState, (state) => state.registered === true, 60_000);
    const startResponse = await fetch(`${api}/api/runs/${runId}/start`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(startResponse.status, await startResponse.text()).toBe(202);
    await waitUntil(
      async () => (await jobsOf(runId)).some((job) => job.state === 'queued'),
      60_000,
    );
    const queuedAt = Date.now();
    const plannerJobId = (await jobsOf(runId)).find((job) => job.state === 'queued')!.id;

    // Refused for a window as the first test measures it, then held until the
    // halt has outlasted the budget: still queued, not cancelled, the run not
    // failed, and the coordinator said why.
    await observeRefusal(workerState, runId, jobsOf, runOf, plannerJobId, logs);
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.max(0, HALT_MS - (Date.now() - queuedAt))),
    );
    const haltedForMs = Date.now() - queuedAt;
    expect(haltedForMs).toBeGreaterThanOrEqual(WAIT_BUDGET_MS + 1_000);
    expect(
      (await jobsOf(runId)).find((job) => job.id === plannerJobId),
      logs(),
    ).toMatchObject({ state: 'queued' });
    let detail = await runOf(runId);
    expect(detail.run.state, logs()).toBe('executing');
    expect(detail.events.map((event) => event.type)).not.toContain('run.failed');
    expect(pausedRecord(), logs()).toMatchObject({
      level: 'warn',
      fields: { jobId: plannerJobId, runId, haltFile, budgetMs: WAIT_BUDGET_MS },
    });
    expect(resumedRecord(), 'no resume has been logged yet').toBeUndefined();

    // Resume through the API: the same wait leases the job and carries on.
    const cleared = await fetch(`${api}/api/halt`, {
      method: 'DELETE',
      headers: { authorization: headers.authorization },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const resumedAt = Date.now();
    const leased = await waitForState(
      workerState,
      (state) => state.jobId === plannerJobId,
      LEASE_RESUME_MS,
    );
    console.info(
      `[halt] queued job leased ${Date.now() - resumedAt} ms after DELETE /api/halt, ${haltedForMs} ms after it was queued under a ${WAIT_BUDGET_MS} ms wait budget`,
    );
    expect(leased.role).toBe('planner');
    await waitUntil(async () => resumedRecord() !== undefined, 10_000);
    expect(resumedRecord(), logs()).toMatchObject({
      level: 'info',
      fields: { jobId: plannerJobId, runId, haltFile, budgetMs: WAIT_BUDGET_MS },
    });
    await waitUntil(
      async () => (await runOf(runId)).events.some((event) => event.type === 'plan.completed'),
      30_000,
    );

    // And the run ends where an unhalted run ends: at the push approval, with
    // every job completed and none cancelled by a timeout.
    detail = await waitForRunState(api, headers, runId, 'partially_completed', 180_000);
    await waitUntil(async () => {
      detail = await runOf(runId);
      return detail.events.some((event) => event.type === 'run.finished');
    }, 30_000);
    const eventTypes = detail.events.map((event) => event.type);
    expect(eventTypes).not.toContain('run.failed');
    expect(eventTypes).not.toContain('run.execution_stopped');
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'plan.completed',
        'critique.completed',
        'plan.revised',
        'build.completed',
        'verification.completed',
        'review.completed',
        'integration.committed',
        'approval.requested',
      ]),
    );
    const jobs = await jobsOf(runId);
    expect(jobs, logs()).toHaveLength(6);
    expect(
      jobs.every((job) => job.state === 'completed'),
      logs(),
    ).toBe(true);
    expect(jobs.find((job) => job.id === plannerJobId)).toMatchObject({
      workerId: `halt-wait-worker-${suffix}`,
    });
  }, 300_000);
});

/**
 * Watch a halted system for OBSERVATION_MS with work queued: the worker keeps
 * polling and every poll is answered 204 with `x-forge-halted: file`, the
 * queued job stays queued, nothing is leased, the run is still `executing`
 * (not failed, not paused) and its worktree is still on disk.
 */
async function observeRefusal(
  statePath: string,
  runId: string,
  jobsOf: (runId: string) => Promise<Job[]>,
  runOf: (runId: string) => Promise<RunDetail>,
  queuedJobId: string,
  logs: () => string,
) {
  const before = await waitForState(
    statePath,
    (state) => typeof state.haltedPolls === 'number' && state.haltedPolls > 0,
    30_000,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, OBSERVATION_MS));
  const state = await waitForState(statePath, () => true, 1_000);
  const haltedPolls = (state.haltedPolls as number) - (before.haltedPolls as number);
  expect(
    haltedPolls,
    `polls refused during ${OBSERVATION_MS} ms\n${logs()}`,
  ).toBeGreaterThanOrEqual(5);
  expect(state.lastPoll).toMatchObject({ status: 204, halted: 'file' });
  const jobs = await jobsOf(runId);
  expect(
    jobs.find((job) => job.id === queuedJobId),
    logs(),
  ).toMatchObject({ state: 'queued' });
  expect(
    jobs.filter((job) => job.state === 'leased'),
    logs(),
  ).toEqual([]);
  const detail = await runOf(runId);
  expect(detail.run.state, logs()).toBe('executing');
  expect(existsSync(workspaceOf(detail)), 'worktree still exists while halted').toBe(true);
  return { state, haltedPolls };
}

function workspaceOf(detail: RunDetail): string {
  const event = [...detail.events].reverse().find((item) => item.type === 'workspace.ready');
  return requireString(event?.payload.workspace, 'workspace.ready workspace');
}

/**
 * The real CLI, the way `pnpm forge <command>` runs it minus the `.env` load:
 * `node --import tsx packages/cli/src/main.ts`, from the checkout root, with
 * the environment given explicitly.
 */
async function forgeCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/main.ts', ...args],
      { cwd: process.cwd(), env, shell: false },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}
