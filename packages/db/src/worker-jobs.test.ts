import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Run, Task, Worker } from '@theforge/contracts';
import {
  allowEventDeletion,
  createDatabase,
  PostgresForgeRepository,
  type WorkerJob,
  type ReclaimedWorkerJobLease,
} from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? createDatabase(databaseUrl) : undefined;
const repository = sql ? new PostgresForgeRepository(sql) : undefined;
const prefix = `worker-job-${randomUUID()}`;
const projectId = `${prefix}-project`;
const runId = `${prefix}-run`;

suite('durable worker job fencing', () => {
  beforeAll(async () => {
    await repository!.ensureProject({
      id: projectId,
      name: 'Worker job test',
      repositoryUrl: 'https://example.invalid/worker-job-test',
    });
    const now = new Date().toISOString();
    const run: Run = {
      id: runId,
      projectId,
      objective: 'Prove atomic worker leases',
      constraints: [],
      state: 'executing',
      budget: { maxUsd: 1, maxTokens: 1 },
      spent: { usd: 0, tokens: 0 },
      createdAt: now,
      updatedAt: now,
    };
    await repository!.putRun(run);
    const task: Task = {
      id: `${prefix}-task`,
      runId,
      title: 'Durable phase',
      description: 'Durable phase',
      state: 'ready',
      priority: 1,
      dependencies: [],
      acceptanceCriteria: ['One attempt'],
      requiredCapabilities: ['node'],
      fileOwnership: [],
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    await repository!.putTask(task);
    for (const id of [`${prefix}-a`, `${prefix}-b`]) {
      const worker: Worker = {
        id,
        name: id,
        platform: 'linux',
        capabilities: ['node'],
        policyProfile: 'default',
        status: 'online',
        lastHeartbeatAt: now,
      };
      await repository!.upsertWorker(worker);
    }
  });

  afterAll(async () => {
    if (!sql) return;
    // Deleting a run cascades through the append-only events guard (006).
    await sql.begin(async (tx) => {
      await allowEventDeletion(tx);
      await tx`delete from runs where id=${runId}`;
    });
    await sql`delete from projects where id=${projectId}`;
    await sql`delete from workers where id like ${`${prefix}%`}`;
    await sql.end();
  });

  it('allows only one concurrent claimant', async () => {
    const job = makeJob(`${prefix}-race`);
    await repository!.upsertWorkerJob(job);
    const [first, second] = await Promise.all([
      repository!.leaseNextWorkerJob(`${prefix}-a`, ['node'], { leaseToken: randomUUID() }),
      repository!.leaseNextWorkerJob(`${prefix}-b`, ['node'], { leaseToken: randomUUID() }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  /**
   * A command action built explicitly rather than spread from `makeJob`, whose
   * `action` is a union and so does not narrow to the command variant.
   */
  const commandAction = (
    executable: string,
    args: string[],
    network?: string,
    steps?: Array<Record<string, unknown>>,
  ): WorkerJob['action'] =>
    ({
      executable,
      args,
      workspace: {
        repositoryUrl: 'https://example.invalid/worker-job-test',
        revision: 'a'.repeat(40),
        patch: '',
        untrackedFiles: [],
      },
      workingDirectory: '.',
      ...(network ? { network } : {}),
      ...(steps ? { steps } : {}),
      // Cast once, here. Several of these fixtures deliberately carry values
      // the type forbids - a `bridge` boundary, a non-boolean flag - because
      // stored jsonb is not typed and the parser is what has to refuse them.
    }) as unknown as WorkerJob['action'];

  it("carries an install step's network flag through the database", async () => {
    // The test that was missing, and the reason the flag silently did nothing
    // on 05/10/2026. The pipeline tests injected a `checkRunner` directly, so
    // they proved the pipeline SETS the flag and never that it SURVIVES the
    // trip to the worker - and the trip is where it was lost.
    //
    // `parseWorkerJobAction` allowlists fields rather than handing the stored
    // jsonb to the worker, which is the right design; it just means a new field
    // is dropped unless it is named there. The action was written correctly,
    // read back without `network`, and the container ran sealed. Every path to
    // the worker - list and lease alike - goes through that one mapper, so
    // asserting it here covers them all.
    //
    // Left `cancelled` rather than `queued` on purpose: these fixtures share
    // one run, and a spare queued job gets leased by the fencing tests below.
    const job = makeJob(`${prefix}-install-network`);
    await repository!.upsertWorkerJob({
      ...job,
      state: 'cancelled',
      action: commandAction('npm', ['ci'], 'install'),
    });
    const [stored] = (await repository!.listWorkerJobs(job.runId)).filter(
      (candidate) => candidate.id === job.id,
    );
    expect(stored!.action).toMatchObject({ executable: 'npm', network: 'install' });
  });

  it('does not invent a network flag for an ordinary command', async () => {
    // The half that matters for the boundary: a check comes back with no
    // network at all, so a sandbox cannot gain egress from a stray or
    // malformed stored value.
    const plainJob = makeJob(`${prefix}-no-network`);
    await repository!.upsertWorkerJob({
      ...plainJob,
      state: 'cancelled',
      action: commandAction('npm', ['run', 'test']),
    });
    const [plain] = (await repository!.listWorkerJobs(plainJob.runId)).filter(
      (candidate) => candidate.id === plainJob.id,
    );
    expect(plain!.action).not.toHaveProperty('network');

    // `bridge` is not a value the type allows, but stored jsonb is not typed,
    // so the parser is what has to refuse it.
    const bogusJob = makeJob(`${prefix}-bogus-network`);
    await repository!.upsertWorkerJob({
      ...bogusJob,
      state: 'cancelled',
      action: commandAction('npm', ['run', 'test'], 'bridge'),
    });
    const [refused] = (await repository!.listWorkerJobs(bogusJob.runId)).filter(
      (candidate) => candidate.id === bogusJob.id,
    );
    expect(refused!.action).not.toHaveProperty('network');
  });

  it("carries a stepped job's commands, boundaries and halt flags through the database", async () => {
    // The #52 lesson applied before it costs another run. `parseWorkerJobAction`
    // allowlists fields rather than handing the stored jsonb to the worker,
    // which is the right design; it just means a new field does nothing at all
    // unless it is named there. `network` shipped that way and the sandbox ran
    // sealed anyway. `steps` would fail the same way and look like a
    // verification that ran one command and passed.
    const job = makeJob(`${prefix}-stepped`);
    await repository!.upsertWorkerJob({
      ...job,
      state: 'cancelled',
      action: commandAction('npm', ['ci'], 'install', [
        { executable: 'npm', args: ['ci'], network: 'install', stopOnFailure: true },
        { executable: 'npm', args: ['run', 'test'] },
      ]),
    });
    const [stored] = (await repository!.listWorkerJobs(job.runId)).filter(
      (candidate) => candidate.id === job.id,
    );
    expect(stored!.action).toMatchObject({
      steps: [
        { executable: 'npm', args: ['ci'], network: 'install', stopOnFailure: true },
        { executable: 'npm', args: ['run', 'test'] },
      ],
    });
    // The check step carries neither: a boundary it never asked for would be a
    // sandbox with egress, and a halt flag it never asked for would stop the
    // checks after it.
    const steps = (stored!.action as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps[1]).not.toHaveProperty('network');
    expect(steps[1]).not.toHaveProperty('stopOnFailure');
  });

  it('refuses a step that asks for a boundary or a flag the type does not allow', async () => {
    // Stored jsonb is not typed, so the parser is what has to refuse it.
    const job = makeJob(`${prefix}-stepped-bogus`);
    await repository!.upsertWorkerJob({
      ...job,
      state: 'cancelled',
      action: commandAction('npm', ['ci'], undefined, [
        { executable: 'npm', args: ['ci'], network: 'bridge', stopOnFailure: 'yes' },
      ]),
    });
    const [stored] = (await repository!.listWorkerJobs(job.runId)).filter(
      (candidate) => candidate.id === job.id,
    );
    const steps = (stored!.action as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps[0]).toMatchObject({ executable: 'npm', args: ['ci'] });
    expect(steps[0]).not.toHaveProperty('network');
    expect(steps[0]).not.toHaveProperty('stopOnFailure');
  });

  it("carries a stepped job's per-step results back from the worker", async () => {
    // The other half of the trip. A result whose steps were dropped reaches the
    // pipeline as a verification that ran fewer commands than it was sent.
    const job = makeJob(`${prefix}-stepped-result`);
    await repository!.upsertWorkerJob({
      ...job,
      state: 'completed',
      result: {
        code: 1,
        stdout: '',
        stderr: 'boom',
        steps: [
          { command: 'npm ci', code: 0, stdout: 'added 400 packages', stderr: '' },
          { command: 'npm run test', code: 1, stdout: '', stderr: 'boom' },
        ],
      },
    });
    const [stored] = (await repository!.listWorkerJobs(job.runId)).filter(
      (candidate) => candidate.id === job.id,
    );
    expect(stored!.result?.steps).toEqual([
      { command: 'npm ci', code: 0, stdout: 'added 400 packages', stderr: '' },
      { command: 'npm run test', code: 1, stdout: '', stderr: 'boom' },
    ]);
  });

  it('refuses a malformed step result rather than dropping it quietly', async () => {
    // Refused, not filtered. A step silently dropped here would arrive at the
    // pipeline as the very thing its own guard exists to catch, and the two
    // would cancel each other out.
    const job = makeJob(`${prefix}-stepped-bad-result`);
    await repository!.upsertWorkerJob({
      ...job,
      state: 'completed',
      result: {
        code: 0,
        stdout: '',
        stderr: '',
        steps: [{ command: 'npm ci', stdout: '', stderr: '' }],
      } as never,
    });
    await expect(repository!.listWorkerJobs(job.runId)).rejects.toThrow(
      'Invalid worker job result step',
    );
    // Removed here rather than in afterAll: every later test in this file lists
    // the same run, and a row that throws would fail all of them.
    await sql!`delete from worker_jobs where id=${job.id}`;
  });

  it('rejects a stale fence after lease recovery', async () => {
    const job = makeJob(`${prefix}-recovery`);
    await repository!.upsertWorkerJob(job);
    const expiredAt = new Date(Date.now() + 1_000);
    const first = await repository!.leaseNextWorkerJob(`${prefix}-a`, ['node'], {
      leaseToken: `${prefix}-old-fence`,
      now: expiredAt,
      leaseMs: 1,
    });
    expect(first?.workerId).toBe(`${prefix}-a`);
    // Taking a lease back used to be completely silent - the only trace was a
    // second `worker_job.leased` event that looked exactly like a first, which
    // is how a builder losing its lease mid-work went undiagnosed on 04/10/2026.
    // `onReclaim` is what makes it reportable, so it is asserted here rather
    // than left to the caller to discover.
    const reclaimed: ReclaimedWorkerJobLease[] = [];
    const recovered = await repository!.leaseNextWorkerJob(`${prefix}-b`, ['node'], {
      leaseToken: `${prefix}-new-fence`,
      now: new Date(expiredAt.getTime() + 2),
      onReclaim: (entry) => void reclaimed.push(entry),
    });
    expect(recovered?.workerId).toBe(`${prefix}-b`);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      jobId: job.id,
      runId: job.runId,
      // Names the worker it was taken FROM, which is the part a second
      // `worker_job.leased` could never say.
      previousWorkerId: `${prefix}-a`,
    });
    // The lease was 1 ms and it was reclaimed 2 ms later, so it was 1 ms
    // overdue. Asserted as a number rather than an exact value only where the
    // clock is injected, as it is here.
    expect(reclaimed[0]!.overdueMs).toBe(1);
    expect(reclaimed[0]!.leaseExpiredAt).toBe(new Date(expiredAt.getTime() + 1).toISOString());
    expect(
      await repository!.completeWorkerJob(
        job.id,
        `${prefix}-a`,
        `${prefix}-old-fence`,
        { code: 0, stdout: 'stale', stderr: '', patch: 'stale-attempt-patch' },
        new Date(expiredAt.getTime() + 3),
      ),
    ).toBeUndefined();
    const completed = await repository!.completeWorkerJob(
      job.id,
      `${prefix}-b`,
      `${prefix}-new-fence`,
      {
        code: 0,
        stdout: 'accepted',
        stderr: '',
        patch: 'accepted-attempt-patch',
        rawStdoutTail: '{"raw":"stdout"}\n',
        rawStderrTail: 'raw stderr\n',
      },
      new Date(expiredAt.getTime() + 3),
    );
    expect(completed?.result?.stdout).toBe('accepted');
    expect(completed?.result?.patch).toBe('accepted-attempt-patch');
    // The raw tails round-trip through the jsonb column like the patch does.
    expect(completed?.result?.rawStdoutTail).toBe('{"raw":"stdout"}\n');
    expect(completed?.result?.rawStderrTail).toBe('raw stderr\n');
    const listed = await repository!.listWorkerJobs(job.runId);
    expect(listed.find((candidate) => candidate.id === job.id)?.result).toMatchObject({
      rawStdoutTail: '{"raw":"stdout"}\n',
      rawStderrTail: 'raw stderr\n',
    });
  });

  it('does not lease a job to an incompatible worker', async () => {
    await repository!.upsertWorkerJob({
      ...makeJob(`${prefix}-capability`),
      requiredCapabilities: ['provider:codex'],
    });
    expect(
      await repository!.leaseNextWorkerJob(`${prefix}-a`, ['node'], {
        leaseToken: randomUUID(),
      }),
    ).toBeUndefined();
  });

  it('reuses one durable attempt for a repeated phase idempotency key', async () => {
    const first = {
      ...makeJob(`${prefix}-idempotent-a`),
      taskId: `${prefix}-task`,
      attemptId: `${prefix}-attempt-a`,
      idempotencyKey: `${prefix}-phase-key`,
    };
    const created = await repository!.createAttemptWorkerJob(first.taskId, first.attemptId, first);
    const repeated = {
      ...makeJob(`${prefix}-idempotent-b`),
      taskId: `${prefix}-task`,
      attemptId: `${prefix}-attempt-b`,
      idempotencyKey: `${prefix}-phase-key`,
    };
    const restored = await repository!.createAttemptWorkerJob(
      repeated.taskId,
      repeated.attemptId,
      repeated,
    );
    expect(restored.id).toBe(created.id);
    expect((await repository!.getTask(`${prefix}-task`))?.attempts).toBe(1);
  });
});

function makeJob(id: string): WorkerJob {
  return {
    id,
    runId,
    action: {
      executable: process.execPath,
      args: ['--version'],
      workspace: {
        repositoryUrl: 'https://example.invalid/worker-job-test',
        revision: 'a'.repeat(40),
        patch: '',
        untrackedFiles: [],
      },
      workingDirectory: '.',
    },
    requiredCapabilities: ['node'],
    state: 'queued',
  };
}
