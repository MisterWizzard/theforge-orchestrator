import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ADR-029, S5.3 restart test, 27/09/2026.
 *
 * The coordinator was killed mid-run and restarted. Recovery worked - the lease
 * was reconciled, the attempt recovered to ready, the workspace re-established
 * - and then the resumed run read provider availability against a fleet that
 * was empty only because the process had just come up:
 *
 *   1109 worker_job.lease_reconciled {jobId 8dcbb856, state: "queued"}
 *   1111 attempt.lease_expired       {recoveredTo: "ready"}
 *   1113 workspace.ready             {branch forge/485111dd}
 *   1115 provider.diagnostic         {provider: claude, available: false,
 *                                     detail: "No online worker advertises provider:claude"}
 *   1121 run.failed                  {message: "No authenticated provider is available"}
 *   1123 worker_job.leased           {jobId 8dcbb856, workerId nodee-worker-1}
 *
 * The worker was back one event later. Every restart and every reboot therefore
 * killed every in-flight run. This file owns the coordinator half of the fix
 * and runs in its own vitest file on purpose: the worker registry is module
 * state, so "no worker is online" is only reachable in a process where no other
 * test has registered one.
 *
 * The wait is shortened here from the 90 s default. It has to be set before the
 * server module is evaluated, which is why the import below is dynamic.
 */
const PROVIDER_WAIT_MS = 6_000;
process.env.FORGE_PROVIDER_WAIT_MS = String(PROVIDER_WAIT_MS);
const { app } = await import('./server.js');

const temporaryWorkspaces: string[] = [];

async function createFixtureRepository(): Promise<string> {
  const root = join(process.cwd(), '.forge', 'workspaces');
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(join(root, 'resume-fixture-repo-'));
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

afterAll(async () => {
  await app.close();
  for (const workspace of temporaryWorkspaces)
    await rm(workspace, { recursive: true, force: true });
});

describe('a run resumed on a cold coordinator (ADR-029)', () => {
  const coordinatorHeaders = {
    authorization: 'Bearer test-coordinator-token-that-is-long-enough',
  };
  const workerAuth = { authorization: 'Bearer test-worker-token-that-is-long-enough' };

  type Detail = {
    run: { state: string; resumeState?: string };
    events: Array<{ type: string; payload: Record<string, unknown> }>;
    blockers: Array<{
      classification: string;
      status: string;
      summary: string;
      smallestUnblockAction: string;
    }>;
  };
  type LeasedJob = {
    id: string;
    leaseToken: string;
    action: { kind?: string; providerId?: string; request?: { role: string } };
  };

  /**
   * A run that was interrupted and is now being resumed, with no worker online
   * - the state a restarted coordinator wakes up in. The pause/resume pair is
   * the same transition `restartRunWhenIdle` drives after a kill: /start sees a
   * run that is not `created`, which is what marks it a resume.
   */
  async function interruptedRun(suffix: string) {
    const projectId = `resume-${suffix}`;
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: coordinatorHeaders,
      payload: {
        id: projectId,
        name: `Resume ${suffix}`,
        repositoryUrl: await createFixtureRepository(),
      },
    });
    expect(project.statusCode, project.body).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: coordinatorHeaders,
      payload: {
        projectId,
        objective: `Survive a coordinator restart (${suffix})`,
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
    const fetchDetail = async () =>
      (
        await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: coordinatorHeaders })
      ).json<Detail>();
    const control = async (action: 'pause' | 'resume') => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/control`,
        headers: coordinatorHeaders,
        payload: { action },
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
    };
    await control('pause');
    expect((await fetchDetail()).run.state).toBe('paused');
    // No worker has ever registered in this process: the fleet is as empty as a
    // freshly started coordinator's.
    const fleet = await app.inject({
      method: 'GET',
      url: '/api/workers',
      headers: coordinatorHeaders,
    });
    expect(fleet.json<unknown[]>()).toHaveLength(0);
    await control('resume');
    /** Poll the run until `settled` accepts it, or the deadline passes. */
    const until = async (settled: (detail: Detail) => boolean, budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      let detail = await fetchDetail();
      while (!settled(detail) && Date.now() < deadline) {
        await new Promise((wait) => setTimeout(wait, 50));
        detail = await fetchDetail();
      }
      return detail;
    };
    const hasEvent = (detail: Detail, type: string) =>
      detail.events.some((event) => event.type === type);
    return { runId, projectId, fetchDetail, until, hasEvent };
  }

  it(
    'pauses the run when the bounded wait expires instead of failing or hanging',
    async () => {
      const run = await interruptedRun('expires');
      const startedAt = Date.now();
      // Wait for the blocker as well as the event. GET /api/runs/:id awaits its
      // durable lists (blockers included) and only then reads the in-memory event
      // list, so a poll can pair a blockers snapshot taken just before the upsert
      // with an events list read just after the event was published: the event
      // is there and the blocker is not, for one poll. The coordinator persists
      // the blocker before it publishes the event; the response is merely not a
      // single snapshot. Under full-suite load that window was wide enough to hit.
      const detail = await run.until(
        (current) =>
          current.run.state === 'paused' &&
          run.hasEvent(current, 'run.paused_by_guard') &&
          current.blockers.some(
            (item) => item.classification === 'safety_constraint' && item.status === 'active',
          ),
        PROVIDER_WAIT_MS + 30_000,
      );
      const elapsed = Date.now() - startedAt;
      const types = detail.events.map((event) => event.type).join(', ');

      // Not failed, and not still running: paused, and therefore resumable.
      expect(detail.run.state, types).toBe('paused');
      expect(types).not.toContain('run.failed');
      expect(run.hasEvent(detail, 'provider.wait_started')).toBe(true);
      const paused = detail.events.find((event) => event.type === 'run.paused_by_guard');
      expect(paused?.payload).toMatchObject({
        guard: 'provider',
        classification: 'safety_constraint',
      });
      expect(String(paused?.payload.reason)).toContain('paused rather than failed');
      expect(Number(paused?.payload.waitedMs)).toBeGreaterThanOrEqual(PROVIDER_WAIT_MS - 250);
      // The wait is bounded: it did not hang, and it did not sit there for the
      // 15-minute worker-job wait either.
      expect(elapsed).toBeLessThan(PROVIDER_WAIT_MS + 30_000);
      // The operator gets an active safety_constraint blocker naming the fix.
      const blocker = detail.blockers.find(
        (item) => item.classification === 'safety_constraint' && item.status === 'active',
      );
      expect(blocker, JSON.stringify(detail.blockers)).toBeDefined();
      expect(blocker?.smallestUnblockAction).toContain('start the worker');
    },
    PROVIDER_WAIT_MS + 60_000,
  );

  it('does not fail the resumed run while no worker is online, and proceeds once one registers', async () => {
    const run = await interruptedRun('registers');

    // The window the bug lived in: availability has been read and found
    // empty, and the run is waiting rather than failing.
    const waiting = await run.until(
      (current) => run.hasEvent(current, 'provider.wait_started'),
      30_000,
    );
    expect(
      run.hasEvent(waiting, 'provider.wait_started'),
      waiting.events.map((event) => event.type).join(', '),
    ).toBe(true);
    expect(waiting.run.state).toBe('executing');
    expect(waiting.events.map((event) => event.type)).not.toContain('run.failed');
    const cold = waiting.events.filter((event) => event.type === 'provider.diagnostic');
    expect(cold.length).toBeGreaterThan(0);
    expect(cold[0]?.payload.detail).toContain('No online worker advertises');

    // The worker comes back, as it did one event after run.failed.
    const workerId = 'resume-race-worker';
    const registration = await app.inject({
      method: 'POST',
      url: '/api/workers/register',
      headers: workerAuth,
      payload: {
        id: workerId,
        name: 'resume race fixture',
        platform: 'linux',
        capabilities: ['provider:claude', 'sandbox:docker', 'execution-os:linux'],
        policyProfile: 'default',
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const workerHeaders = {
      authorization: `Bearer ${registration.json<{ sessionToken: string }>().sessionToken}`,
    };

    // The wait ends on the next poll and the planner stage is dispatched: the
    // run carried on from where the restart left it.
    let job: LeasedJob | undefined;
    const deadline = Date.now() + 30_000;
    while (!job && Date.now() < deadline) {
      const lease = await app.inject({
        method: 'GET',
        url: `/api/workers/${workerId}/jobs/next`,
        headers: workerHeaders,
      });
      if (lease.statusCode === 200) job = lease.json<LeasedJob>();
      else await new Promise((wait) => setTimeout(wait, 100));
    }
    const detail = await run.fetchDetail();
    const types = detail.events.map((event) => event.type).join(', ');
    expect(job, types).toBeDefined();
    expect(job?.action).toMatchObject({
      kind: 'provider',
      providerId: 'claude',
      request: { role: 'planner' },
    });
    expect(detail.run.state).toBe('executing');
    expect(types).not.toContain('run.failed');
    expect(run.hasEvent(detail, 'provider.wait_satisfied')).toBe(true);
    expect(run.hasEvent(detail, 'run.paused_by_guard')).toBe(false);

    // The run is deliberately left mid-stage, so stop it before the file's
    // hooks close the app and drop the schema: an execution still writing
    // events into a dropped schema surfaces as an unhandled CONNECTION_ENDED
    // rejection long after this test has passed.
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.runId}/control`,
      headers: coordinatorHeaders,
      payload: { action: 'cancel' },
    });
    expect(cancelled.statusCode, cancelled.body).toBeLessThan(300);
    const stopped = await run.until(
      (current) =>
        current.run.state === 'cancelled' && run.hasEvent(current, 'run.execution_stopped'),
      30_000,
    );
    expect(stopped.run.state).toBe('cancelled');
    expect(run.hasEvent(stopped, 'run.execution_stopped')).toBe(true);
  }, 90_000);
});
