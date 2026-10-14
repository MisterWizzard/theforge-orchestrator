import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_PATCH_BYTES,
  MAX_RAW_TAIL_BYTES,
} from '@theforge/contracts';
import {
  acceptLateCompletion,
  accrueJobWaitBudget,
  app,
  haltAwareTimeoutSignal,
  normalizeSnapshotText,
} from './server.js';
import type { WorkerJob } from '@theforge/db';

const temporaryWorkspaces: string[] = [];

/**
 * A throwaway repository with a `main` branch for tests that start a real
 * pipeline run. The checkout itself is not usable: on a CI pull-request
 * checkout HEAD is detached and no local `main` exists, so the pipeline's bare
 * cache has no such ref to clone from.
 */
async function createFixtureRepository(): Promise<string> {
  const root = join(process.cwd(), '.forge', 'workspaces');
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(join(root, 'coordinator-fixture-repo-'));
  temporaryWorkspaces.push(repository);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'forge@test.invalid']);
  git(['config', 'user.name', 'Forge Test']);
  await writeFile(join(repository, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  return repository;
}

async function createCoordinatorWorkspace(): Promise<string> {
  const root = join(process.cwd(), '.forge', 'workspaces');
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, 'coordinator-transport-'));
  const clone = spawnSync('git', ['clone', '--local', '--no-hardlinks', process.cwd(), workspace], {
    encoding: 'utf8',
  });
  if (clone.status !== 0) throw new Error(clone.stderr || 'Could not create coordinator fixture');
  temporaryWorkspaces.push(workspace);
  return workspace;
}

afterAll(async () => {
  await app.close();
  for (const workspace of temporaryWorkspaces)
    await rm(workspace, { recursive: true, force: true });
});

describe('coordinator API', () => {
  const coordinatorHeaders = {
    authorization: 'Bearer test-coordinator-token-that-is-long-enough',
  };
  it('reports health and persists a new run view', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'coordinator' });
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: 'fixture',
        name: 'Fixture',
        repositoryUrl: process.cwd(),
        baseRef: 'main',
        checks: [{ executable: 'pnpm', args: ['test'] }],
      },
    });
    expect(project.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'fixture',
        objective: 'Build a validated notes feature',
        constraints: [],
        maxUsd: 5,
        maxTokens: 10_000,
        configuration: {
          autonomyProfile: 'cautious',
          timeLimitMinutes: 30,
          targetBranch: 'release-fixture',
          providerRoles: {
            planner: 'codex',
            critic: 'claude',
            builder: 'codex',
            reviewer: 'claude',
          },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ run: { id: string }; tasks: unknown[] }>();
    expect(body.tasks).toHaveLength(4);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/runs/${body.run.id}`,
      headers: coordinatorHeaders,
    });
    expect(detail.json()).toMatchObject({
      run: {
        state: 'created',
        configuration: {
          autonomyProfile: 'cautious',
          timeLimitMinutes: 30,
          targetBranch: 'release-fixture',
        },
      },
    });
  });

  it('defaults a new run to a $5 budget and pins no role (ADR-024)', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: 'fixture-defaults',
        name: 'Fixture defaults',
        repositoryUrl: process.cwd(),
        baseRef: 'main',
        checks: [],
      },
    });
    expect(project.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'fixture-defaults', objective: 'Use the defaults' },
    });
    expect(created.statusCode).toBe(201);
    const { run } = created.json<{
      run: { budget: unknown; configuration: { providerRoles: unknown } };
    }>();
    expect(run.budget).toEqual({ maxUsd: 5, maxTokens: 100000 });
    // Nothing is pinned: the pipeline puts every role on claude, and Codex
    // appears only when a run names it.
    expect(run.configuration.providerRoles).toEqual({});

    const pinned = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'fixture-defaults',
        objective: 'Pin one role and raise the cap',
        maxUsd: 12.5,
        configuration: { providerRoles: { builder: 'codex' } },
      },
    });
    expect(pinned.statusCode).toBe(201);
    expect(pinned.json()).toMatchObject({
      run: { budget: { maxUsd: 12.5 }, configuration: { providerRoles: { builder: 'codex' } } },
    });
  });

  it('rejects unauthenticated worker registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      payload: {
        id: 'w',
        name: 'fixture',
        platform: 'linux',
        capabilities: ['git'],
        policyProfile: 'default',
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stores the faults a worker reports for a provider it withheld (ADR-038)', async () => {
    const fault = 'the API key was rejected (HTTP 400): This API key is not scoped to a workspace';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: 'fault-reporting-worker',
        name: 'fault fixture',
        platform: 'linux',
        capabilities: ['git'],
        providerFaults: { claude: fault },
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode).toBe(201);
    expect(
      registration.json<{ worker: { providerFaults: Record<string, string> } }>().worker,
    ).toMatchObject({
      providerFaults: { claude: fault },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: coordinatorHeaders,
    });
    const stored = listed
      .json<Array<{ id: string; providerFaults?: Record<string, string> }>>()
      .find((candidate) => candidate.id === 'fault-reporting-worker');
    expect(stored?.providerFaults).toEqual({ claude: fault });
  });

  it('refuses a worker fault longer than the bound, since that text reaches events and digests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: 'fault-too-long-worker',
        name: 'fault fixture',
        platform: 'linux',
        capabilities: ['git'],
        providerFaults: { claude: 'x'.repeat(501) },
        policyProfile: 'default',
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('requires coordinator authorization before retention cleanup can execute', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/operations/retention/execute',
      payload: {
        before: '2026-01-01T00:00:00.000Z',
        confirmationDigest: '0'.repeat(64),
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'coordinator_token_invalid' });
  });

  it('issues and enforces a short-lived worker session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: 'worker-fixture-project',
        name: 'Worker fixture',
        repositoryUrl: process.cwd(),
      },
    });
    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'worker-fixture-project',
        objective: 'Execute a durable worker fixture',
      },
    });
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: 'worker-session-fixture',
        name: 'fixture',
        platform: 'linux',
        capabilities: ['git'],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode).toBe(201);
    const body = registration.json<{ sessionToken: string }>();
    expect(body.sessionToken.length).toBeGreaterThan(60);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/workers/worker-session-fixture/heartbeat',
      headers: { authorization: 'Bearer wrong-session' },
    });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/workers/worker-session-fixture/heartbeat',
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(accepted.statusCode).toBe(200);
    const workspace = await createCoordinatorWorkspace();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: {
          executable: process.execPath,
          args: ['--version'],
          cwd: workspace,
        },
        requiredCapabilities: ['git'],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: '/api/workers/worker-session-fixture/jobs/next',
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(leased.statusCode).toBe(200);
    const job = leased.json<{
      id: string;
      leaseToken: string;
      action: {
        workspace: { repositoryUrl: string; revision: string; patch: string };
        workingDirectory: string;
        cwd?: string;
      };
    }>();
    expect(job.action).not.toHaveProperty('cwd');
    expect(job.action.workspace.repositoryUrl).toBe(process.cwd());
    expect(job.action.workspace.revision).toMatch(/^[a-f0-9]{40,64}$/);
    expect(job.action.workingDirectory).toBe('.');
    const renewed = await app.inject({
      method: 'POST',
      url: `/api/workers/worker-session-fixture/jobs/${job.id}/heartbeat`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
      payload: { leaseToken: job.leaseToken },
    });
    expect(renewed.statusCode).toBe(200);
    const completed = await app.inject({
      method: 'POST',
      url: `/api/workers/worker-session-fixture/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${body.sessionToken}` },
      payload: { leaseToken: job.leaseToken, code: 0, stdout: 'ok', stderr: '' },
    });
    expect(completed.json()).toMatchObject({ state: 'completed' });
  });

  /**
   * A leased command job, with its worker session: the shortest route to the
   * completion route with a real lease to present to it.
   */
  async function leaseFixtureJob(name: string) {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: `${name}-project`, name, repositoryUrl: process.cwd() },
    });
    const run = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: `${name}-project`, objective: `Execute ${name}` },
    });
    const runId = run.json<{ run: { id: string } }>().run.id;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: name,
        name,
        platform: 'linux',
        capabilities: ['git'],
        policyProfile: 'default',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const sessionToken = registered.json<{ sessionToken: string }>().sessionToken;
    const workspace = await createCoordinatorWorkspace();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: { executable: process.execPath, args: ['--version'], cwd: workspace },
        requiredCapabilities: ['git'],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${name}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<{ id: string; leaseToken: string }>();
    return { runId, sessionToken, job };
  }

  it("carries a stepped verification's per-step results back from the worker", async () => {
    // The twelfth obstacle of the first real objective, and the one that cost a
    // run which had actually succeeded: `npm ci`, lint, typecheck and the tests
    // all ran in one workspace and all passed, and the result reached the
    // pipeline with the evidence removed, so the pipeline's own guard refused
    // it.
    //
    // `steps` crosses four allowlists between the pipeline and the record - the
    // action parser, the result parser, this route's Zod schema, and
    // `completeWorkerJob`'s parameter type - and I had named it in two. Zod
    // strips what it does not know, exactly as `parseWorkerJobAction` does and
    // for the same good reason. This test sits at the HTTP boundary on purpose:
    // it is the layer at which no per-layer test can pass while the whole path
    // drops the field.
    const { runId, sessionToken, job } = await leaseFixtureJob('worker-stepped-fixture');
    const steps = [
      { command: 'npm ci', code: 0, stdout: 'added 400 packages', stderr: '' },
      { command: 'npm run lint', code: 0, stdout: '', stderr: '' },
      { command: 'npm run test', code: 1, stdout: '1 failed', stderr: '2 tests failed' },
    ];
    const completed = await app.inject({
      method: 'POST',
      url: `/api/workers/worker-stepped-fixture/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { leaseToken: job.leaseToken, code: 1, stdout: '1 failed', stderr: 'boom', steps },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<{ result: { steps: unknown } }>().result.steps).toEqual(steps);

    // And a reader coming back to it later sees the same thing, so the evidence
    // survives the record as well as the response.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
    });
    const stored = listed
      .json<Array<{ id: string; result?: { steps?: unknown } }>>()
      .find((candidate) => candidate.id === job.id);
    expect(stored?.result?.steps).toEqual(steps);
  });

  it('refuses a completion with more steps than a verification may run', async () => {
    // Bounded, and loudly. A list this long is a bug to be told about, not a
    // list to be quietly shortened - the failure above was a field quietly
    // dropped, and a silent truncation here would be the same mistake.
    const { sessionToken, job } = await leaseFixtureJob('worker-stepped-cap-fixture');
    const refused = await app.inject({
      method: 'POST',
      url: `/api/workers/worker-stepped-cap-fixture/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: {
        leaseToken: job.leaseToken,
        code: 0,
        stdout: '',
        stderr: '',
        steps: Array.from({ length: 33 }, (_unused, index) => ({
          command: `npm run check-${index}`,
          code: 0,
          stdout: '',
          stderr: '',
        })),
      },
    });
    expect(refused.statusCode).not.toBe(200);
    expect(refused.body).toContain('32 commands');
  });

  it('does not spend a stage timeout while the system is halted', async () => {
    // The other half of the kill switch's promise. `docs/OPERATIONS.md` says a
    // halt of any length no longer cancels queued jobs or fails their runs, and
    // the queue budget does pause - but the stage's own clock was
    // `AbortSignal.timeout`, which counts wall clock. So a halt longer than the
    // stage timeout failed the run anyway, on a job that had never started.
    //
    // Short budget and fast poll so this costs a second, not thirty minutes.
    let halted = true;
    const signal = haltAwareTimeoutSignal(200, () => halted, 20);
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Five times the budget in wall clock, all of it halted.
    await settle(1_000);
    expect(signal.aborted, 'a halted stage must not time out').toBe(false);

    // Released, and it fires on its own un-halted time rather than catching up
    // on everything it skipped.
    halted = false;
    await settle(80);
    expect(signal.aborted, 'the budget is not yet spent').toBe(false);
    await settle(300);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error).message)).toContain('un-halted');
  });

  it('times out an unhalted stage exactly as AbortSignal.timeout would', async () => {
    // The guard on the change: a system that is never halted must behave as it
    // always did, or the fix has bought the kill switch at the cost of the
    // limit.
    const signal = haltAwareTimeoutSignal(150, () => false, 20);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(signal.aborted).toBe(true);
  });

  it('sends untracked text to the worker as LF, and leaves binary alone', () => {
    // shopfront's first run: `npm run format:check` failed on `src/lib/flags.test.ts`
    // and on nothing else, because prettier saw CRLF in a repository that is LF
    // throughout. Lint, typecheck and the agent's own tests all passed.
    //
    // Tracked files reach the worker through a clone pinning
    // `core.autocrlf=false`, so they match their blobs. Untracked files do not
    // go through git at all - the worker writes them verbatim - and their bytes
    // come off the coordinator's worktree, which on Windows is CRLF because
    // `git apply` honours core.autocrlf when it writes the builder's patch. So
    // the agent got its own file back with its line endings changed.
    const crlf = Buffer.from('const a = 1\r\nconst b = 2\r\n', 'utf8');
    expect(normalizeSnapshotText(crlf).toString('utf8')).toBe('const a = 1\nconst b = 2\n');

    // Already LF, and a file with no line endings at all: returned untouched.
    const lf = Buffer.from('const a = 1\nconst b = 2\n', 'utf8');
    expect(normalizeSnapshotText(lf).equals(lf)).toBe(true);
    const none = Buffer.from('no newline here', 'utf8');
    expect(normalizeSnapshotText(none).equals(none)).toBe(true);

    // Binary is left exactly alone, which matters more than the fix itself:
    // silently rewriting bytes inside a PNG would be a worse bug than the one
    // above. The test uses git's own heuristic, a NUL in the first 8000 bytes.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      Buffer.from('IHDR\r\nchunk\r\n', 'binary'),
    ]);
    expect(normalizeSnapshotText(png).equals(png)).toBe(true);

    // A NUL beyond the first 8000 bytes is text by that same rule, so this one
    // IS normalised. Asserted so the boundary stays git's decision rather than
    // drifting into one of my own.
    const late = Buffer.concat([Buffer.from('x\r\n'.repeat(4000), 'binary'), Buffer.from([0x00])]);
    expect(normalizeSnapshotText(late).includes(Buffer.from('\r\n'))).toBe(false);

    // The bytes of a high-latin1 text file survive the round trip, which is why
    // the conversion goes through 'binary' rather than 'utf8'.
    const latin = Buffer.from([0xe9, 0x0d, 0x0a, 0xff]);
    expect([...normalizeSnapshotText(latin)]).toEqual([0xe9, 0x0a, 0xff]);
  });

  it('charges a job wait to the phase it was in, and to neither while halted', async () => {
    // The rule the whole split rests on, and the one nothing tested: restoring
    // the attempt-eighteen bug - charging executing time to the queue budget -
    // passed all 667 tests before this existed. The integration path cannot
    // reach it cheaply, because a real execution timeout needs a worker holding
    // a job for minutes.
    const zero = { queuedMs: 0, executingMs: 0 };

    // Queued: the queue budget is spent and the execution budget is not.
    expect(accrueJobWaitBudget({ ...zero, leased: false, halted: false, elapsedMs: 250 })).toEqual({
      queuedMs: 250,
      executingMs: 0,
    });
    // Leased: the other way round. This is attempt eighteen - a stage was
    // running and the queue budget was being spent on it.
    expect(accrueJobWaitBudget({ ...zero, leased: true, halted: false, elapsedMs: 250 })).toEqual({
      queuedMs: 0,
      executingMs: 250,
    });
    // Halted: neither. A halt is the operator stopping the system and should
    // not spend a run's allowance either way.
    for (const leased of [true, false]) {
      expect(
        accrueJobWaitBudget({
          queuedMs: 7,
          executingMs: 9,
          leased,
          halted: true,
          elapsedMs: 5_000,
        }),
      ).toEqual({ queuedMs: 7, executingMs: 9 });
    }
    // A reclaimed lease puts the job back to queued, and queue time accrues
    // again from where it stopped - it is waiting for a worker once more.
    expect(
      accrueJobWaitBudget({
        queuedMs: 400,
        executingMs: 900,
        leased: false,
        halted: false,
        elapsedMs: 100,
      }),
    ).toEqual({ queuedMs: 500, executingMs: 900 });
  });

  it('keeps a result that landed after the budget, and only a real one', async () => {
    // Attempt eighteen of the first real objective failed with the work done:
    // the builder's job carried `code: 0` in the database and the coordinator
    // cancelled it anyway. A completion can land in the 250 ms between the last
    // poll and the budget running out, and the lease outlives the budget, so
    // the wait now looks once more before giving up.
    //
    // The decision is tested rather than the window, because making a real
    // completion arrive inside 250 ms would test the clock instead of the rule.
    const result = { code: 0, stdout: 'ok', stderr: '' };
    const job = (state: WorkerJob['state'], withResult = true): WorkerJob => ({
      id: 'late-fixture',
      runId: 'late-run',
      action: {
        executable: 'node',
        args: ['--version'],
        workspace: { repositoryUrl: 'x', revision: 'a'.repeat(40), patch: '', untrackedFiles: [] },
        workingDirectory: '.',
      },
      requiredCapabilities: [],
      state,
      ...(withResult ? { result } : {}),
    });

    // Finished on its own: worth keeping, whatever the exit code says.
    expect(acceptLateCompletion(job('completed'))).toEqual(result);
    expect(acceptLateCompletion(job('failed'))).toEqual(result);

    // Cancelled is refused even carrying a result. That state means somebody
    // asked for the work to stop, and honouring its output would make a cancel
    // advisory rather than a decision.
    expect(acceptLateCompletion(job('cancelled'))).toBeUndefined();
    // Still leased is refused: it has not finished and its budget is spent.
    expect(acceptLateCompletion(job('leased'))).toBeUndefined();
    expect(acceptLateCompletion(job('queued'))).toBeUndefined();
    // Nothing to keep, and nothing to read.
    expect(acceptLateCompletion(job('completed', false))).toBeUndefined();
    expect(acceptLateCompletion(undefined)).toBeUndefined();
  });

  it('protects sensitive reads and control-plane mutations', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/api/runs' },
      { method: 'GET' as const, url: '/api/providers' },
      { method: 'POST' as const, url: '/api/runs', payload: {} },
      { method: 'POST' as const, url: '/api/approvals/unknown', payload: { decision: 'approved' } },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
  });

  it('persists and fences normalized provider jobs', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'provider-job-project', name: 'Provider job', repositoryUrl: process.cwd() },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'provider-job-project', objective: 'Run a provider on a worker' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workerId = 'provider-worker-fixture';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: 'provider fixture',
        platform: 'linux',
        capabilities: ['provider:codex'],
        policyProfile: 'default',
      },
    });
    const sessionToken = registration.json<{ sessionToken: string }>().sessionToken;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: {
          kind: 'provider',
          providerId: 'codex',
          request: {
            runId,
            taskId: `${runId}-planner`,
            role: 'planner',
            prompt: 'Return a plan',
            context: [],
            timeoutMs: 10_000,
          },
          cwd: process.cwd(),
        },
        requiredCapabilities: ['provider:codex'],
      },
    });
    expect(queued.statusCode).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const job = leased.json<{ id: string; leaseToken: string }>();
    const completed = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: {
        leaseToken: job.leaseToken,
        code: 0,
        stdout: '',
        stderr: '',
        events: [
          { type: 'text_delta', text: 'plan' },
          { type: 'usage', inputTokens: 1, outputTokens: 2, usd: 0 },
          { type: 'completed', sessionId: 'session-1', output: 'plan' },
        ],
      },
    });
    expect(completed.statusCode).toBe(200);
    const result = completed.json<{
      state: string;
      result: { events: Array<{ type: string; sessionId?: string }> };
    }>();
    expect(result.state).toBe('completed');
    expect(result.result.events).toHaveLength(3);
    expect(result.result.events[2]).toMatchObject({
      type: 'completed',
      sessionId: 'session-1',
    });
  });

  it('rejects runs without a registered repository', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'missing-project',
        objective: 'Do not report simulated work as completed',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'project_not_configured' });
  });

  it('rejects invalid persisted run configuration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'fixture',
        objective: 'Reject an invalid model role',
        configuration: { providerRoles: { planner: 'unknown-model' } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  // Both halt tests need a worker holding a session and a queued job it can
  // lease. The capability is unique to this file and is the worker's only one:
  // every test file shares one database, so a worker advertising `git` would
  // lease whatever `git` job another file (or another agent's run) left queued
  // and its own would sit there forever.
  const prepareHaltFixture = async (id: string) => {
    const capability = `halt-fixture-${id}`;
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: `halt-fixture-project-${id}`,
        name: 'Halt fixture',
        repositoryUrl: process.cwd(),
      },
    });
    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: `halt-fixture-project-${id}`,
        objective: 'Prove the kill switch halts work',
      },
    });
    const runId = runResponse.json<{ run: { id: string } }>().run.id;
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: `worker-halt-fixture-${id}`,
        name: 'halt fixture',
        platform: 'linux',
        capabilities: [capability],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const session = registration.json<{ sessionToken: string }>();

    const workspace = await createCoordinatorWorkspace();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: { executable: process.execPath, args: ['--version'], cwd: workspace },
        requiredCapabilities: [capability],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    return () =>
      app.inject({
        method: 'GET',
        url: `/api/workers/worker-halt-fixture-${id}/jobs/next`,
        headers: { authorization: `Bearer ${session.sessionToken}` },
      });
  };
  const haltStatus = () =>
    app.inject({ method: 'GET', url: '/api/halt', headers: coordinatorHeaders });

  it('halts through the API by writing the halt file, and resumes once it is removed', async () => {
    // The kill switch has to stop a *running* system, not merely prevent one
    // from starting, so it is checked where work is handed out. A halted
    // coordinator returns 204: workers receive nothing and idle cleanly rather
    // than erroring, and anything already in flight finishes untouched.
    const lease = await prepareHaltFixture('api');
    const before = await haltStatus();
    expect(before.statusCode, before.body).toBe(200);
    const { haltFile } = before.json<{ halted: boolean; haltFile: string }>();
    expect(before.json<{ halted: boolean }>().halted).toBe(false);
    expect(existsSync(haltFile)).toBe(false);

    const halted = await app.inject({
      method: 'POST',
      url: '/api/halt',
      headers: coordinatorHeaders,
      payload: { reason: 'proving the kill switch' },
    });
    expect(halted.statusCode, halted.body).toBe(200);
    expect(halted.json()).toMatchObject({
      halted: true,
      source: 'file',
      haltFile,
      request: { requestedBy: 'api', reason: 'proving the kill switch' },
    });
    // The API keeps nothing in memory: the file *is* the halt, so a restart
    // comes back halted and a directory listing agrees with the API.
    expect(JSON.parse(await readFile(haltFile, 'utf8'))).toMatchObject({
      requestedBy: 'api',
      reason: 'proving the kill switch',
    });

    const refused = await lease();
    expect(refused.statusCode, 'a halted coordinator must lease nothing').toBe(204);
    expect(refused.headers['x-forge-halted']).toBe('file');

    const resumed = await app.inject({
      method: 'DELETE',
      url: '/api/halt',
      headers: coordinatorHeaders,
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ halted: boolean }>().halted).toBe(false);
    expect(existsSync(haltFile)).toBe(false);

    const leased = await lease();
    expect(leased.statusCode, 'work resumes once the halt is cleared').toBe(200);
  });

  it('halts on a halt file created by hand, without any API call', async () => {
    // The file half of policy B13: an operator who can reach the filesystem
    // but not the API or a shell can still stop the system, and an empty file
    // counts - `touch FORGE_HALT` is the whole procedure.
    const lease = await prepareHaltFixture('file');
    const { haltFile } = (await haltStatus()).json<{ haltFile: string }>();
    await writeFile(haltFile, '', 'utf8');
    try {
      const status = await haltStatus();
      expect(status.json()).toMatchObject({ halted: true, source: 'file', haltFile });
      expect(status.json<{ request?: unknown }>().request).toBeUndefined();

      const refused = await lease();
      expect(refused.statusCode, 'a hand-made halt file must stop leasing').toBe(204);
      expect(refused.headers['x-forge-halted']).toBe('file');
    } finally {
      // Never leave a halt file behind for the next test, whatever happened.
      await app.inject({ method: 'DELETE', url: '/api/halt', headers: coordinatorHeaders });
    }
    expect(existsSync(haltFile)).toBe(false);
    const leased = await lease();
    expect(leased.statusCode, 'removing the file resumes leasing').toBe(200);
  });

  it('refuses to halt without the coordinator token', async () => {
    // A kill switch anyone can toggle is a denial-of-service control. Halting
    // and resuming both sit behind the same token as the rest of the API.
    const unauthorized = await app.inject({ method: 'POST', url: '/api/halt' });
    expect(unauthorized.statusCode).toBe(401);
    const cannotResume = await app.inject({ method: 'DELETE', url: '/api/halt' });
    expect(cannotResume.statusCode).toBe(401);
    const stillRunning = await app.inject({
      method: 'GET',
      url: '/api/halt',
      headers: coordinatorHeaders,
    });
    expect(stillRunning.statusCode, stillRunning.body).toBe(200);
    expect(stillRunning.json<{ halted: boolean }>().halted).toBe(false);
  });

  it('enforces the shared patch cap on job completion without consuming the lease', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'patch-cap-project', name: 'Patch cap', repositoryUrl: process.cwd() },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'patch-cap-project', objective: 'Transport a large builder patch' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workerId = 'patch-cap-worker-fixture';
    // A capability nothing else advertises, so a concurrent suite sharing the
    // database cannot lease this job out from under the test.
    const capability = 'patch-cap-fixture';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: 'patch cap fixture',
        platform: 'linux',
        capabilities: [capability],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const sessionToken = registration.json<{ sessionToken: string }>().sessionToken;
    const workspace = await createCoordinatorWorkspace();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: { executable: process.execPath, args: ['--version'], cwd: workspace },
        requiredCapabilities: [capability],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<{ id: string; leaseToken: string }>();
    const complete = (patch: string) =>
      app.inject({
        method: 'POST',
        url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { leaseToken: job.leaseToken, code: 0, stdout: '', stderr: '', patch },
      });

    const rejected = await complete('a'.repeat(MAX_PATCH_BYTES + 1));
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json<{ error: string; message: string }>()).toMatchObject({
      error: 'invalid_request',
    });
    expect(rejected.json<{ message: string }>().message).toContain(
      `patch exceeds MAX_PATCH_BYTES (${MAX_PATCH_BYTES} bytes)`,
    );

    // The worker answers a rejection by re-posting a failure under the same
    // lease token, which only works if the rejection left the lease intact.
    const accepted = await complete('a'.repeat(MAX_PATCH_BYTES));
    expect(accepted.statusCode, accepted.body.slice(0, 500)).toBe(200);
    expect(accepted.json()).toMatchObject({ state: 'completed' });
  });

  it('answers a completion body over the transport cap with 413, not 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workers/nobody/jobs/nothing/complete',
      headers: { 'content-type': 'application/json' },
      payload: `{"patch":"${'a'.repeat(MAX_COMPLETION_BODY_BYTES)}"}`,
    });
    expect(response.statusCode, response.body).toBe(413);
    expect(response.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('stores raw output tails on a completion, caps them, and keeps them out of the run events', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'raw-tail-project', name: 'Raw tails', repositoryUrl: process.cwd() },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'raw-tail-project', objective: 'Carry raw provider output' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workerId = 'raw-tail-worker-fixture';
    const capability = 'raw-tail-fixture';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: 'raw tail fixture',
        platform: 'linux',
        capabilities: [capability],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const sessionToken = registration.json<{ sessionToken: string }>().sessionToken;
    const workspace = await createCoordinatorWorkspace();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: { executable: process.execPath, args: ['--version'], cwd: workspace },
        requiredCapabilities: [capability],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<{ id: string; leaseToken: string }>();
    const complete = (fields: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: { leaseToken: job.leaseToken, code: 1, stdout: '', stderr: '', ...fields },
      });

    const rejected = await complete({ rawStdoutTail: 'a'.repeat(MAX_RAW_TAIL_BYTES + 1) });
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json<{ error: string; message: string }>()).toMatchObject({
      error: 'invalid_request',
    });
    expect(rejected.json<{ message: string }>().message).toContain(
      `rawStdoutTail exceeds MAX_RAW_TAIL_BYTES (${MAX_RAW_TAIL_BYTES} bytes)`,
    );

    const rawStdoutTail = '{"type":"system","subtype":"init"}\nnot json: key [REDACTED]\n';
    const rawStderrTail = 'fatal: credential [REDACTED] rejected\n';
    const accepted = await complete({
      stderr: 'Provider exited 1',
      events: [
        { type: 'error', code: 'PROCESS_EXIT', message: 'Provider exited 1', retryable: false },
      ],
      rawStdoutTail,
      rawStderrTail,
    });
    expect(accepted.statusCode, accepted.body.slice(0, 500)).toBe(200);
    expect(accepted.json()).toMatchObject({
      state: 'failed',
      result: { code: 1, rawStdoutTail, rawStderrTail },
    });

    // Read back through the job listing, which the coordinator token guards.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
    });
    expect(listed.statusCode, listed.body.slice(0, 500)).toBe(200);
    const stored = listed
      .json<Array<{ id: string; result?: { rawStdoutTail?: string; rawStderrTail?: string } }>>()
      .find((candidate) => candidate.id === job.id);
    expect(stored?.result).toMatchObject({ rawStdoutTail, rawStderrTail });
    const anonymous = await app.inject({ method: 'GET', url: `/api/runs/${runId}/jobs` });
    expect(anonymous.statusCode).toBe(401);

    // The run's events, which also feed the SSE stream, carry the job's id
    // and exit code and nothing of its output.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
      headers: coordinatorHeaders,
    });
    expect(detail.statusCode, detail.body.slice(0, 500)).toBe(200);
    const completedEvent = detail
      .json<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>()
      .events.find((event) => event.type === 'worker_job.completed');
    expect(completedEvent?.payload).toEqual({ jobId: job.id, workerId, code: 1 });
    expect(detail.body).not.toContain('not json');
    expect(detail.body).not.toContain('rawStdoutTail');
  });

  it('surfaces a worker TASK_LIMIT completion as a guard.task_limit event on the run', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'task-limit-project', name: 'Task limit', repositoryUrl: process.cwd() },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'task-limit-project', objective: 'Trip a per-task limit' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workerId = 'task-limit-worker-fixture';
    const capability = 'task-limit-fixture';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: 'task limit fixture',
        platform: 'linux',
        capabilities: [capability],
        policyProfile: 'default',
      },
    });
    const sessionToken = registration.json<{ sessionToken: string }>().sessionToken;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: {
          kind: 'provider',
          providerId: 'codex',
          request: {
            runId,
            taskId: `${runId}-builder`,
            role: 'builder',
            prompt: 'Loop forever',
            context: [],
            timeoutMs: 10_000,
          },
          cwd: process.cwd(),
        },
        requiredCapabilities: [capability],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<{ id: string; leaseToken: string }>();
    const completed = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: {
        leaseToken: job.leaseToken,
        code: 1,
        stdout: '',
        stderr: 'tool call limit exceeded (201 > 200)',
        events: [
          { type: 'tool_request', name: 'read_file', input: {} },
          { type: 'tool_request', name: 'read_file', input: {} },
          { type: 'usage', inputTokens: 40, outputTokens: 2, usd: 0 },
          {
            type: 'error',
            code: 'TASK_LIMIT',
            message: 'tool call limit exceeded (201 > 200)',
            retryable: false,
          },
        ],
      },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ state: 'failed' });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
      headers: coordinatorHeaders,
    });
    const events = detail.json<{
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    }>().events;
    const limit = events.find((event) => event.type === 'guard.task_limit');
    expect(limit, events.map((event) => event.type).join(',')).toBeDefined();
    expect(limit?.payload).toMatchObject({
      jobId: job.id,
      workerId,
      role: 'builder',
      providerId: 'codex',
      reason: 'tool call limit exceeded (201 > 200)',
      usage: { toolCalls: 2, tokens: 42 },
    });
    expect(typeof limit?.payload.usage).toBe('object');
    const usage = limit?.payload.usage as { elapsedMinutes?: number };
    expect(usage.elapsedMinutes).toBeGreaterThanOrEqual(0);
  });

  it('accepts an ollama provider job and leases it to a worker that has the model', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'ollama-job-project', name: 'Ollama job', repositoryUrl: process.cwd() },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: { projectId: 'ollama-job-project', objective: 'Run a local model on a worker' },
    });
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workerId = 'ollama-worker-fixture';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: 'ollama fixture',
        platform: 'win32',
        // A local-model worker: no sandbox, no Linux, just the model.
        capabilities: ['provider:ollama', 'model:qwen3:8b'],
        policyProfile: 'default',
      },
    });
    const sessionToken = registration.json<{ sessionToken: string }>().sessionToken;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/jobs`,
      headers: coordinatorHeaders,
      payload: {
        action: {
          kind: 'provider',
          providerId: 'ollama',
          request: {
            runId,
            taskId: `${runId}-planner`,
            role: 'planner',
            prompt: 'Summarise the repository',
            context: [],
            timeoutMs: 10_000,
            model: 'qwen3:8b',
          },
          cwd: process.cwd(),
        },
        requiredCapabilities: ['provider:ollama', 'model:qwen3:8b'],
      },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const leased = await app.inject({
      method: 'GET',
      url: `/api/workers/${workerId}/jobs/next`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(leased.statusCode, leased.body).toBe(200);
    const job = leased.json<{
      id: string;
      leaseToken: string;
      action: { kind?: string; providerId?: string; request?: { model?: string } };
    }>();
    // The model survives the transport and the database round trip.
    expect(job.action).toMatchObject({
      kind: 'provider',
      providerId: 'ollama',
      request: { model: 'qwen3:8b' },
    });
    const completed = await app.inject({
      method: 'POST',
      url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: {
        leaseToken: job.leaseToken,
        code: 0,
        stdout: '',
        stderr: '',
        events: [
          { type: 'text_delta', text: 'summary' },
          { type: 'usage', inputTokens: 5, outputTokens: 7, usd: 0 },
          { type: 'completed', output: 'summary' },
        ],
      },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ state: 'completed' });
  });

  it('refuses a run configuration that pins a role to ollama', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: { id: 'local-planner-project', name: 'Local planner', repositoryUrl: process.cwd() },
    });
    // Local execution is granted per stage by the ceiling policy (ADR-022);
    // a configuration can only name cloud providers.
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId: 'local-planner-project',
        objective: 'Plan on a local model, then hand over to the cloud',
        maxUsd: 100,
        maxTokens: 100_000,
        configuration: {
          providerRoles: {
            planner: 'ollama',
            critic: 'claude',
            builder: 'claude',
            reviewer: 'claude',
          },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(400);
  });

  // The two ceiling tests are last in the file on purpose, and in this order:
  // the day total they record is process-wide (the guards live in the server
  // module), so the first leaves the day at $19.70 for the second, and the
  // second leaves it over the ceiling, where any later test that started a
  // run would be refused. The local-planner test above runs first and records
  // $0. Both drive a real pipeline through one fixture worker that has the
  // cloud provider and the local model, so the pipeline can demote a stage
  // (ADR-022, ADR-028) and the test can serve it. The figures are the per-role
  // estimates the router projects with and the guard checks against: planner
  // $0.70, critic $0.25, builder $1.25, on the default $20 ceiling.
  type LeasedJob = {
    id: string;
    leaseToken: string;
    action: { kind?: string; providerId?: string; request?: { role: string; model?: string } };
  };
  type Detail = {
    run: { state: string; resumeState?: string; spent: { usd: number } };
    events: Array<{ type: string; payload: Record<string, unknown> }>;
    blockers: Array<{
      classification: string;
      status: string;
      summary: string;
      smallestUnblockAction: string;
    }>;
  };
  const eventTypes = (detail: Detail) => detail.events.map((event) => event.type).join(', ');

  /**
   * A project, a run with every role pinned to claude (the cloud provider the
   * fixture worker advertises) and a generous per-run budget so the run's own
   * "Run budget exceeded" cannot fire first and mask the day ceiling, a worker
   * with both providers, and the run started. Returns what a test needs to
   * drive it job by job.
   */
  async function startSpendRun(suffix: string) {
    // A fresh project id per process, because the pipeline caches the fixture
    // repository as a bare clone under the workspace root keyed by project id.
    // The fixture is removed after the file, so a cache left from an earlier
    // run could neither fetch from it nor be cloned over, and the run would
    // fail before offering a job. The cache and the run's worktree are removed
    // with the fixture for the same reason.
    const projectId = `spend-guard-${suffix}-${randomUUID().slice(0, 8)}`;
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: projectId,
        name: `Spend guard ${suffix}`,
        repositoryUrl: await createFixtureRepository(),
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId,
        objective: `Spend against the daily cloud ceiling (${suffix})`,
        maxUsd: 100,
        maxTokens: 100_000,
        configuration: {
          providerRoles: {
            planner: 'claude',
            critic: 'claude',
            builder: 'claude',
            reviewer: 'claude',
          },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const runId = created.json<{ run: { id: string } }>().run.id;
    const workspaceRoot = join(process.cwd(), '.forge', 'workspaces');
    temporaryWorkspaces.push(
      join(workspaceRoot, 'cache', `${projectId}.git`),
      join(workspaceRoot, 'worktrees', `${runId}-implementation`),
    );
    const workerId = `spend-guard-worker-${suffix}`;
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: { authorization: 'Bearer test-worker-token-that-is-long-enough' },
      payload: {
        id: workerId,
        name: `spend guard fixture ${suffix}`,
        platform: 'linux',
        capabilities: [
          'provider:claude',
          'sandbox:docker',
          'execution-os:linux',
          'provider:ollama',
          'model:devstral-small-2:latest',
        ],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const workerHeaders = {
      authorization: `Bearer ${registration.json<{ sessionToken: string }>().sessionToken}`,
    };
    const started = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/start`,
      headers: coordinatorHeaders,
    });
    expect(started.statusCode, started.body).toBe(202);

    const fetchDetail = async () =>
      (
        await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: coordinatorHeaders })
      ).json<Detail>();
    const describeRun = async () => {
      const current = await fetchDetail();
      return `run ${current.run.state}: ${current.events
        .map((event) => {
          const message = event.payload.message;
          return `${event.type}${typeof message === 'string' ? ` (${message})` : ''}`;
        })
        .join(', ')}`;
    };
    // The pipeline clones and creates a worktree before it asks for a job, so
    // a lease can take a few seconds to appear.
    const leaseNext = async (role: string): Promise<LeasedJob> => {
      let job: LeasedJob | undefined;
      const deadline = Date.now() + 30_000;
      while (!job && Date.now() < deadline) {
        const lease = await app.inject({
          method: 'GET',
          url: `/api/workers/${workerId}/jobs/next`,
          headers: workerHeaders,
        });
        if (lease.statusCode === 200) job = lease.json<LeasedJob>();
        else {
          if ((await fetchDetail()).run.state !== 'executing') break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
      }
      expect(job, `the ${role} job was never offered; ${await describeRun()}`).toBeDefined();
      expect(job?.action.request?.role).toBe(role);
      return job!;
    };
    const complete = async (job: LeasedJob, usd: number, output: string) => {
      const completed = await app.inject({
        method: 'POST',
        url: `/api/workers/${workerId}/jobs/${job.id}/complete`,
        headers: workerHeaders,
        payload: {
          leaseToken: job.leaseToken,
          code: 0,
          stdout: '',
          stderr: '',
          events: [
            { type: 'usage', inputTokens: 10, outputTokens: 5, usd },
            { type: 'completed', sessionId: `${output}-session`, output },
          ],
        },
      });
      expect(completed.statusCode, completed.body).toBe(200);
    };
    // A stage the policy refuses ends the run within seconds - not the 900 s
    // wait of a job nobody can take, and not a run.failed.
    const waitForPolicyStop = async (): Promise<Detail> => {
      const since = Date.now();
      let detail = await fetchDetail();
      const stopped = (current: Detail) =>
        current.run.state === 'partially_completed' &&
        current.blockers.some((blocker) => blocker.classification === 'safety_constraint');
      while (!stopped(detail) && Date.now() - since < 10_000) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        detail = await fetchDetail();
      }
      return detail;
    };
    const jobCount = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/runs/${runId}/jobs`,
          headers: coordinatorHeaders,
        })
      ).json<Array<{ id: string }>>().length;
    return { runId, fetchDetail, leaseNext, complete, waitForPolicyStop, jobCount };
  }

  it('routes a projected crossing to the local model instead of pausing at the guard (ADR-028)', async () => {
    const run = await startSpendRun('projected');

    // Day at $0: the planner ($0.70 estimated) fits and is a cloud job. It
    // records $19.50 - under the ceiling, past the warning fraction.
    const planner = await run.leaseNext('planner');
    expect(planner.action).toMatchObject({ kind: 'provider', providerId: 'claude' });
    await run.complete(planner, 19.5, 'plan');

    // Per role: the critic ($0.25, to $19.75) still fits and is a cloud job too.
    const critic = await run.leaseNext('critic');
    expect(critic.action).toMatchObject({
      kind: 'provider',
      providerId: 'claude',
      request: { role: 'critic' },
    });
    await run.complete(critic, 0.2, 'critique');

    // At $19.70 the planner's revision would take the day to $20.40, so it is
    // routed to the local model by projection: the day never reached the
    // ceiling, and the dispatch guard never saw a call to refuse.
    const revision = await run.leaseNext('planner');
    expect(revision.action).toMatchObject({
      kind: 'provider',
      providerId: 'ollama',
      request: { role: 'planner', model: 'devstral-small-2:latest' },
    });
    await run.complete(revision, 0, 'revised plan');

    // The builder ($1.25, to $20.95) may not run locally: a policy stop.
    const detail = await run.waitForPolicyStop();
    expect(detail.run.state, eventTypes(detail)).toBe('partially_completed');
    expect(detail.run.spent.usd).toBeCloseTo(19.7, 10);
    const finished = detail.events.find((event) => event.type === 'run.finished');
    expect(finished?.payload).toMatchObject({
      state: 'partially_completed',
      classification: 'safety_constraint',
    });
    expect(String(finished?.payload.blocker)).toContain(
      'builder must not run locally; stopping the run at the ceiling',
    );
    expect(String(finished?.payload.blocker)).toContain('projected $20.95 ($19.70 spent on');
    expect(detail.blockers).toContainEqual(
      expect.objectContaining({ classification: 'safety_constraint', status: 'active' }),
    );
    const routing = detail.events.filter((event) => event.type === 'routing.decided');
    expect(routing.map((event) => event.payload.role)).toEqual([
      'planner',
      'critic',
      'planner',
      'builder',
    ]);
    expect(routing[0]?.payload).toMatchObject({
      tier: 3,
      providerId: 'claude',
      allowed: true,
      ceilingApplied: false,
      estimatedUsd: 0.7,
    });
    expect(routing[1]?.payload).toMatchObject({
      tier: 3,
      providerId: 'claude',
      allowed: true,
      ceilingApplied: false,
      estimatedUsd: 0.25,
    });
    expect(routing[2]?.payload).toMatchObject({
      tier: 2,
      providerId: 'ollama',
      model: 'devstral-small-2:latest',
      allowed: true,
      ceilingApplied: true,
      estimatedUsd: 0.7,
    });
    expect(String(routing[2]?.payload.reason)).toContain('projected $20.40 ($19.70 spent on');
    expect(routing[3]?.payload).toMatchObject({
      allowed: false,
      providerId: null,
      ceilingApplied: true,
      estimatedUsd: 1.25,
    });
    expect(detail.events.some((event) => event.type === 'spend.warn')).toBe(true);
    // Nothing crossed and nothing was refused at dispatch: no ceiling
    // announcement, no guard pause, no run.failed - the events the live run
    // 00a3c994 produced at the planner before ADR-028.
    for (const type of ['spend.ceiling', 'run.paused_by_guard', 'run.pause', 'run.failed']) {
      expect(
        detail.events.some((event) => event.type === type),
        `${type}: ${eventTypes(detail)}`,
      ).toBe(false);
    }
    // Exactly the planner's, the critic's and the revision's jobs exist: the
    // refused builder was never enqueued.
    expect(await run.jobCount()).toBe(3);
  }, 60_000);

  it('starts below the ceiling, routes the planner local by projection, and refuses a restart once the day has crossed', async () => {
    // The day is at $19.70 from the test above: under the ceiling, so the
    // start gate admits the run, but past what the planner may add to it.
    const run = await startSpendRun('crossing');

    // The planner is a local job from its first decision.
    const planner = await run.leaseNext('planner');
    expect(planner.action).toMatchObject({
      kind: 'provider',
      providerId: 'ollama',
      request: { role: 'planner', model: 'devstral-small-2:latest' },
    });
    await run.complete(planner, 0, 'plan');

    // The critic still fits ($19.95) and goes to the cloud. Its estimate turns
    // out low: $5.30 takes the day to $25, and the crossing is announced once.
    const critic = await run.leaseNext('critic');
    expect(critic.action).toMatchObject({
      kind: 'provider',
      providerId: 'claude',
      request: { role: 'critic' },
    });
    await run.complete(critic, 5.3, 'critique');

    // The revision sees a reached ceiling now, not a projection.
    const revision = await run.leaseNext('planner');
    expect(revision.action).toMatchObject({
      kind: 'provider',
      providerId: 'ollama',
      request: { role: 'planner', model: 'devstral-small-2:latest' },
    });
    await run.complete(revision, 0, 'revised plan');

    let detail = await run.waitForPolicyStop();
    expect(detail.run.state, eventTypes(detail)).toBe('partially_completed');
    expect(detail.run.spent.usd).toBeCloseTo(5.3, 10);
    const finished = detail.events.find((event) => event.type === 'run.finished');
    expect(finished?.payload).toMatchObject({
      state: 'partially_completed',
      classification: 'safety_constraint',
    });
    expect(String(finished?.payload.blocker)).toContain(
      'builder must not run locally; stopping the run at the ceiling',
    );
    expect(String(finished?.payload.blocker)).toContain(
      'daily cloud ceiling of $20.00 reached ($25.00 spent on',
    );
    const routing = detail.events.filter((event) => event.type === 'routing.decided');
    expect(routing.map((event) => event.payload.role)).toEqual([
      'planner',
      'critic',
      'planner',
      'builder',
    ]);
    expect(routing[0]?.payload).toMatchObject({
      tier: 2,
      providerId: 'ollama',
      allowed: true,
      ceilingApplied: true,
    });
    expect(String(routing[0]?.payload.reason)).toContain('projected $20.40 ($19.70 spent on');
    expect(routing[1]?.payload).toMatchObject({
      tier: 3,
      providerId: 'claude',
      allowed: true,
      ceilingApplied: false,
    });
    expect(routing[2]?.payload).toMatchObject({
      tier: 2,
      providerId: 'ollama',
      allowed: true,
      ceilingApplied: true,
    });
    expect(String(routing[2]?.payload.reason)).toContain(
      'daily cloud ceiling of $20.00 reached ($25.00 spent on',
    );
    expect(routing[3]?.payload).toMatchObject({ allowed: false, providerId: null });
    const ceiling = detail.events.filter((event) => event.type === 'spend.ceiling');
    expect(ceiling).toHaveLength(1);
    expect(ceiling[0]?.payload).toMatchObject({ ceilingUsd: 20, routing: 'local-only' });
    expect(ceiling[0]?.payload.dayUsd).toBeCloseTo(25, 8);
    for (const type of ['run.paused_by_guard', 'run.failed']) {
      expect(
        detail.events.some((event) => event.type === type),
        `${type}: ${eventTypes(detail)}`,
      ).toBe(false);
    }
    expect(await run.jobCount()).toBe(3);

    // Restarting on the same day is refused outright by the start guard.
    const restart = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.runId}/start`,
      headers: coordinatorHeaders,
    });
    expect(restart.statusCode, restart.body).toBe(409);
    expect(restart.json()).toMatchObject({ error: 'spend_ceiling' });
    detail = await run.fetchDetail();
    expect(detail.run.state).toBe('partially_completed');
    // Announced once per day, however many refusals follow.
    expect(detail.events.filter((event) => event.type === 'spend.ceiling')).toHaveLength(1);
  }, 60_000);
});
