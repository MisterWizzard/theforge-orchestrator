import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const workerToken = 'portable-worker-token-that-is-long-enough';
const sessionToken = 'portable-session-token-that-is-long-enough';
const workerId = 'portable-worker';
const jobId = 'portable-lifecycle-job';
const leaseToken = 'portable-lease-token';

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  request.setEncoding('utf8');
  await new Promise<void>((resolvePromise, reject) => {
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.once('end', resolvePromise);
    request.once('error', reject);
  });
  return body ? (JSON.parse(body) as unknown) : undefined;
}

function json(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe('built worker daemon portability lifecycle', () => {
  it('registers, heartbeats, cancels an active test-host job, completes evidence, and shuts down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'theforge-worker-portability-'));
    const repository = join(root, 'repository');
    const workspaceRoot = join(root, 'workspaces');
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeFile(
      join(repository, 'portable-job.mjs'),
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('started.marker', 'active');",
        'setInterval(() => undefined, 1000);',
      ].join('\n'),
    );
    git(['init'], repository);
    git(['config', 'user.email', 'portability@example.invalid'], repository);
    git(['config', 'user.name', 'Portability Fixture'], repository);
    git(['add', 'portable-job.mjs'], repository);
    git(['commit', '-m', 'Add portable lifecycle fixture'], repository);
    const revision = git(['rev-parse', 'HEAD'], repository).trim();

    let registerCount = 0;
    let workerHeartbeatCount = 0;
    let leaseHeartbeatCount = 0;
    let sessionRefusedOnce = false;
    // Sticky: "the job was observed active at some heartbeat", not "it was
    // active at the most recent one". The difference is the whole bug - see the
    // heartbeat handler below.
    let sawActiveJob = false;
    let completion:
      { leaseToken?: string; code?: number; stdout?: string; stderr?: string } | undefined;
    let resolveCompletion: (() => void) | undefined;
    const completionReceived = new Promise<void>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    let jobIssued = false;
    const marker = join(workspaceRoot, `.job-${jobId}`, 'started.marker');

    const server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (path === '/api/workers/register' && request.method === 'POST') {
          expect(request.headers.authorization).toBe(`Bearer ${workerToken}`);
          const registration = (await readJson(request)) as {
            id?: string;
            capabilities?: string[];
          };
          expect(registration.id).toBe(workerId);
          expect(registration.capabilities).toContain('executor:test-host');
          registerCount += 1;
          json(response, 200, { sessionToken });
          return;
        }
        expect(request.headers.authorization).toBe(`Bearer ${sessionToken}`);
        if (path === `/api/workers/${workerId}/heartbeat` && request.method === 'POST') {
          workerHeartbeatCount += 1;
          json(response, 204);
          return;
        }
        if (path === `/api/workers/${workerId}/jobs/next` && request.method === 'GET') {
          if (jobIssued) {
            json(response, 204);
            return;
          }
          jobIssued = true;
          json(response, 200, {
            id: jobId,
            leaseToken,
            action: {
              executable: process.execPath,
              args: ['portable-job.mjs'],
              workspace: {
                repositoryUrl: repository,
                revision,
                patch: '',
                untrackedFiles: [],
              },
              workingDirectory: '.',
            },
          });
          return;
        }
        if (
          path === `/api/workers/${workerId}/jobs/${jobId}/heartbeat` &&
          request.method === 'POST'
        ) {
          expect(await readJson(request)).toEqual({ leaseToken });
          leaseHeartbeatCount += 1;
          // The first lease heartbeat is refused with 401, which is what a
          // coordinator returns once the worker's session has expired - it
          // lives 15 minutes while a task may run 30, so any stage longer than
          // a quarter of an hour hits this. A 401 is the SESSION, not the
          // lease: the worker must register again and carry on, because the
          // work is still running and the lease is still valid. Treating it as
          // a lost lease is what killed the first objective ever pointed at a
          // real repository, twelve and a half minutes into its builder stage.
          if (!sessionRefusedOnce) {
            sessionRefusedOnce = true;
            json(response, 401, { error: 'worker_session_invalid' });
            return;
          }
          const activeNow = await access(marker)
            .then(() => true)
            .catch(() => false);
          // `sawActiveJob` latches. It used to be *assigned* this observation,
          // which made it a last-observation value while the assertion below
          // reads it as an ever-observed flag, and that is what made this test
          // flaky on the Windows runner.
          //
          // Measured locally, heartbeats land at roughly 131 ms, 393 ms and
          // 648 ms: the job has to be cloned, checked out and spawned before it
          // writes the marker, so the first two observe `false` and only the
          // third sees it and cancels. Completion then follows 12 ms later
          // here, so no further heartbeat arrives and the stale `false` is
          // never written back - locally. On a slow, contended runner the work
          // between cancelling and completing (killing the job, removing a git
          // workspace) comfortably exceeds the 250 ms interval, so one more
          // heartbeat lands in that window, re-checks a marker whose workspace
          // has just been deleted - the test asserts that deletion at the end -
          // and resets the flag to `false` while the completion itself is
          // perfectly correct. That is precisely the observed failure:
          // "expected false to be true" with everything else in order.
          //
          // `cancelRequested` still reflects the *current* observation, because
          // cancelling is only meaningful while the job is actually running.
          if (activeNow) sawActiveJob = true;
          json(response, 200, { cancelRequested: activeNow });
          return;
        }
        if (
          path === `/api/workers/${workerId}/jobs/${jobId}/complete` &&
          request.method === 'POST'
        ) {
          completion = (await readJson(request)) as typeof completion;
          json(response, 204);
          resolveCompletion?.();
          return;
        }
        json(response, 404, { error: 'not found' });
      } catch (error) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    let child: ReturnType<typeof spawn> | undefined;
    let stdout = '';
    let stderr = '';
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as AddressInfo).port;
      const childEnvironment = { ...process.env };
      delete childEnvironment.ANTHROPIC_API_KEY;
      delete childEnvironment.OPENAI_API_KEY;
      delete childEnvironment.FORGE_CLAUDE_CREDENTIALS_FILE;
      delete childEnvironment.FORGE_CODEX_AUTH_FILE;
      child = spawn(process.execPath, [resolve('apps/worker/dist/index.js')], {
        env: {
          ...childEnvironment,
          NODE_ENV: 'test',
          FORGE_API_URL: `http://127.0.0.1:${port}`,
          FORGE_WORKER_TOKEN: workerToken,
          FORGE_WORKER_ID: workerId,
          FORGE_WORKER_EXECUTOR: 'host',
          FORGE_WORKSPACE_ROOT: workspaceRoot,
          FORGE_JOB_HEARTBEAT_MS: '250',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      await withTimeout(completionReceived, 15_000, 'cancelled job completion');
      // Registered twice: once at startup, once more after the refused lease
      // heartbeat. Before the fix the worker aborted the job instead, so this
      // stayed at 1 and the completion below never arrived.
      expect(registerCount).toBe(2);
      expect(workerHeartbeatCount).toBeGreaterThanOrEqual(1);
      expect(leaseHeartbeatCount).toBeGreaterThanOrEqual(1);
      // The completion is asserted BEFORE `sawActiveJob`, deliberately. When
      // this test failed on CI it failed on `sawActiveJob` first, so the
      // completion - which carries the job's own exit code and stderr, and
      // would have said whether the job ran at all - was never checked, and the
      // failure was unexplainable from the log. The more informative assertion
      // goes first so the next failure names its own cause.
      expect(completion).toMatchObject({ leaseToken, code: -1 });
      expect(completion?.stderr).toContain('Job cancellation requested by coordinator');
      expect(
        sawActiveJob,
        `no lease heartbeat ever observed ${marker}; ${leaseHeartbeatCount} heartbeat(s) arrived and the completion was ${JSON.stringify(completion)}`,
      ).toBe(true);

      // The trailing heartbeat, driven rather than waited for. On a slow runner
      // one lands after the job is cancelled and its workspace removed, and
      // before this test latched the flag that reset `sawActiveJob` to false
      // while the completion stayed perfectly correct - an intermittent
      // "expected false to be true" that said nothing about its own cause.
      //
      // Sending it here makes that case deterministic on every host instead of
      // depending on the runner being slow enough to produce it. It goes
      // through the real handler, so it is the same path the worker takes.
      const heartbeatsBefore = leaseHeartbeatCount;
      const trailing = await fetch(
        `http://127.0.0.1:${port}/api/workers/${workerId}/jobs/${jobId}/heartbeat`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sessionToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ leaseToken }),
        },
      );
      expect(trailing.status).toBe(200);
      expect(leaseHeartbeatCount).toBe(heartbeatsBefore + 1);
      // It must observe nothing active - the workspace is gone by now, which
      // the assertion below confirms independently - and it must NOT undo what
      // an earlier heartbeat saw.
      expect(await trailing.json()).toEqual({ cancelRequested: false });
      expect(
        sawActiveJob,
        'a heartbeat arriving after the job finished reset the flag; it must latch, not track the latest observation',
      ).toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });

      expect(child.kill('SIGTERM')).toBe(true);
      const [exitCode, exitSignal] = (await withTimeout(
        once(child, 'exit'),
        10_000,
        'graceful worker shutdown',
      )) as [number | null, NodeJS.Signals | null];
      // Not empty any more, and that is the point: the worker says it
      // re-registered. Asserted as exactly that one line rather than ignored,
      // so a different error on stderr still fails the test - the previous
      // `toBe('')` was strict, but it also meant any new diagnostic had to be
      // silent in order to pass.
      expect(stderr).toContain(`Worker session expired during job ${jobId}`);
      expect(stderr).not.toContain('Worker lease lost');
      expect(
        stderr
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.includes('Worker session expired during job')),
      ).toEqual([]);
      if (process.platform === 'win32') {
        // Windows force-terminates Node for child.kill('SIGTERM'); the POSIX matrix member
        // verifies delivery to and graceful completion of the daemon's SIGTERM handler.
        expect({ exitCode, exitSignal }).toEqual({ exitCode: null, exitSignal: 'SIGTERM' });
      } else {
        expect({ exitCode, exitSignal }).toEqual({ exitCode: 0, exitSignal: null });
        expect(stdout).toContain(`TheForge worker ${workerId} received SIGTERM; shutting down`);
        expect(stdout).toContain(`TheForge worker ${workerId} stopped`);
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      server.close();
      await once(server, 'close').catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
