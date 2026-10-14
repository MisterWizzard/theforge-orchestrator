import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '@theforge/git-runtime';
import {
  children,
  createAcceptedPatch,
  createFixtureRepository,
  getJson,
  notesSource,
  notesTestSource,
  post,
  processLogs,
  registerWorker,
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

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) await terminate(child);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  processLogs.length = 0;
});

suite('deterministic black-box release acceptance', () => {
  it('survives coordinator and worker loss, fences the stale lease, and commits the exact accepted result', async () => {
    // Already this file's own schema: tests/setup/isolated-schema.ts rewrote
    // DATABASE_URL before this module was evaluated.
    const isolatedDatabaseUrl = requireString(databaseUrl, 'DATABASE_URL');
    const suffix = randomUUID().slice(0, 8);
    const temp = await mkdtemp(join(tmpdir(), `forge-release-${suffix}-`));
    const source = join(temp, 'fixture');
    const patchPath = join(temp, 'accepted.patch');
    const workspaceRoot = join(temp, 'managed');
    const workerAState = join(temp, 'worker-a.json');
    const workerBState = join(temp, 'worker-b.json');
    const workerBRelease = join(temp, 'worker-b.release');
    cleanups.push(() => rm(temp, { recursive: true, force: true }));
    // Coordinator B binds a different port from A. A SIGKILLed listener can
    // hold its port for a moment, and a bind failure there surfaces as a 60 s
    // health timeout that looks exactly like machine load.
    const portA = 46_000 + Math.floor(Math.random() * 500);
    const portB = portA + 500;
    let api = `http://127.0.0.1:${portA}`;
    const coordinatorToken = `coordinator-${randomUUID()}-${randomUUID()}`;
    const workerToken = `worker-${randomUUID()}-${randomUUID()}`;
    const projectId = `release-project-${suffix}`;
    const headers = {
      authorization: `Bearer ${coordinatorToken}`,
      'content-type': 'application/json',
    };
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
      // The fixture worker renews its lease every 250 ms. At 1500 ms a live
      // lease survived only six missed beats under load; 6000 leaves headroom
      // while the handover after worker A is killed still takes seconds.
      FORGE_JOB_LEASE_MS: '6000',
      HOST: '127.0.0.1',
    };

    let coordinator = startCoordinator('coordinator-a', common, portA);
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);
    await post(`${api}/api/projects`, headers, {
      id: projectId,
      name: 'Deterministic release fixture',
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

    const workerA = startFixtureWorker('worker-a', common, portA, {
      FORGE_WORKER_ID: `release-worker-a-${suffix}`,
      FORGE_FAKE_WORKER_STATE: workerAState,
      FORGE_FAKE_PROVIDER_PATCH: patchPath,
      FORGE_FAKE_HOLD_FIRST: '1',
    });
    await waitForState(workerAState, (state) => state.registered === true, 60_000);
    const startResponse = await fetch(`${api}/api/runs/${created.run.id}/start`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const startBody = await startResponse.text();
    expect(startResponse.status, startBody).toBe(202);
    const stale = await waitForState(
      workerAState,
      (state) => typeof state.jobId === 'string' && state.role === 'planner',
      60_000,
    );
    const staleJobId = requireString(stale.jobId, 'stalled worker job ID');
    const staleLeaseToken = requireString(stale.leaseToken, 'stalled worker lease token');

    await terminate(coordinator);
    await terminate(workerA);
    coordinator = startCoordinator('coordinator-b', common, portB);
    api = `http://127.0.0.1:${portB}`;
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);

    startFixtureWorker('worker-b', common, portB, {
      FORGE_WORKER_ID: `release-worker-b-${suffix}`,
      FORGE_FAKE_WORKER_STATE: workerBState,
      FORGE_FAKE_WORKER_RELEASE: workerBRelease,
      FORGE_FAKE_PROVIDER_PATCH: patchPath,
      FORGE_FAKE_HOLD_FIRST: '1',
    });
    const reassigned = await waitForState(
      workerBState,
      (state) => state.jobId === staleJobId && typeof state.leaseToken === 'string',
      60_000,
    );
    expect(reassigned.leaseToken).not.toBe(staleLeaseToken);

    const replacementSession = await registerWorker(api, workerToken, `release-worker-a-${suffix}`);
    const staleCompletion = await fetch(
      `${api}/api/workers/release-worker-a-${suffix}/jobs/${staleJobId}/complete`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${replacementSession}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          leaseToken: staleLeaseToken,
          code: 0,
          stdout: 'STALE_RESULT_MUST_NOT_COMMIT',
          stderr: '',
        }),
      },
    );
    expect(staleCompletion.status).toBe(409);
    expect(await staleCompletion.json()).toMatchObject({ error: 'job_lease_invalid' });
    await writeFile(workerBRelease, 'release', 'utf8');

    let detail = await waitForRunState(
      api,
      headers,
      created.run.id,
      'partially_completed',
      180_000,
    );
    await waitUntil(async () => {
      detail = await getJson<RunDetail>(`${api}/api/runs/${created.run.id}`, headers);
      return (
        detail.events.some((event) => event.type === 'approval.requested') &&
        detail.events.some((event) => event.type === 'run.finished')
      );
    }, 30_000);
    // Exact counts fail without saying why; the spawned processes' output does.
    const logs = () => processLogs.join('\n');
    expect(detail.run.spent, logs()).toEqual({ usd: 0, tokens: 25 });
    expect(detail.tasks.every((task) => task.state === 'blocked')).toBe(true);
    expect(detail.events.map((event) => event.type)).toEqual(
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
    expect(detail.events.some((event) => event.type === 'integration.pull_request_created')).toBe(
      false,
    );
    expect(detail.messages.length, logs()).toBeGreaterThanOrEqual(9);
    expect(detail.decisions.map((decision) => decision.title)).toEqual(
      expect.arrayContaining(['Revised plan accepted', 'Run terminal state']),
    );
    expect(detail.blockers).toContainEqual(
      expect.objectContaining({ status: 'active', classification: 'technical_unknown' }),
    );
    expect(detail.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(['test', 'commit', 'report']),
    );
    expect(detail.usage, logs()).toHaveLength(5);
    expect(detail.attempts, logs()).toHaveLength(6);
    expect(
      detail.attempts.filter((attempt) => typeof attempt.providerSessionId === 'string'),
      logs(),
    ).toHaveLength(5);

    const jobs = await getJson<
      Array<{ id: string; state: string; workerId?: string; result?: { stdout: string } }>
    >(`${api}/api/runs/${created.run.id}/jobs`, headers);
    expect(jobs, logs()).toHaveLength(6);
    expect(
      jobs.every((job) => job.state === 'completed'),
      logs(),
    ).toBe(true);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
    expect(jobs.find((job) => job.id === staleJobId)).toMatchObject({
      workerId: `release-worker-b-${suffix}`,
    });
    expect(jobs.some((job) => job.result?.stdout.includes('STALE_RESULT_MUST_NOT_COMMIT'))).toBe(
      false,
    );

    const approval = await getJson<Array<{ runId: string; status: string }>>(
      `${api}/api/approvals`,
      headers,
    );
    expect(approval).toContainEqual(
      expect.objectContaining({ runId: created.run.id, status: 'pending' }),
    );

    const workspaceEvent = [...detail.events]
      .reverse()
      .find((event) => event.type === 'workspace.ready');
    const workspaceValue = workspaceEvent?.payload.workspace;
    const workspace = typeof workspaceValue === 'string' ? workspaceValue : '';
    expect(workspace).toBeTruthy();
    expect(await readFile(join(workspace, 'notes.js'), 'utf8')).toBe(notesSource);
    expect(await readFile(join(workspace, 'notes.test.js'), 'utf8')).toBe(notesTestSource);
    expect((await runGit(['status', '--short'], workspace)).stdout).toBe('');
    expect(
      (await runGit(['diff', '--name-only', 'HEAD^', 'HEAD'], workspace)).stdout
        .trim()
        .split(/\r?\n/),
    ).toEqual(['notes.js', 'notes.test.js']);
    await expect(runFixtureTests(workspace)).resolves.toBeUndefined();

    const report = await getJson<RunDetail & { generatedAt: string }>(
      `${api}/api/runs/${created.run.id}/report`,
      headers,
    );
    expect(Date.parse(report.generatedAt)).not.toBeNaN();
    expect(report.artifacts).toHaveLength(detail.artifacts.length);
    expect(report.usage).toHaveLength(detail.usage.length);
  }, 300_000);
});
