import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '@theforge/git-runtime';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const children: ChildProcess[] = [];
const processLogs: string[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
  processLogs.length = 0;
});

suite('worker-loss recovery', () => {
  it('reclaims the fenced job after a worker dies and its replacement cleans the orphan', async () => {
    const suffix = randomUUID().slice(0, 8);
    const port = 45_000 + Math.floor(Math.random() * 1_000);
    const api = `http://127.0.0.1:${port}`;
    const coordinatorToken = `coordinator-${randomUUID()}-${randomUUID()}`;
    const workerToken = `worker-${randomUUID()}-${randomUUID()}`;
    const workerId = `loss-worker-${suffix}`;
    const fixtureRoot = await mkdtemp(join(tmpdir(), `forge-worker-loss-${suffix}-`));
    temporaryDirectories.push(fixtureRoot);
    const workspace = join(fixtureRoot, 'repository');
    await mkdir(workspace);
    await runGit(['init', '-b', 'main'], workspace);
    await runGit(['config', 'user.email', 'forge@test.invalid'], workspace);
    await runGit(['config', 'user.name', 'Forge Worker Loss'], workspace);
    await writeFile(
      join(workspace, 'slow.js'),
      "setTimeout(() => console.log('RECOVERED_ONCE'), 2000)\n",
      'utf8',
    );
    await runGit(['add', '.'], workspace);
    await runGit(['commit', '-m', 'worker loss fixture'], workspace);
    const common = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      FORGE_COORDINATOR_TOKEN: coordinatorToken,
      FORGE_WORKER_TOKEN: workerToken,
      FORGE_WORKSPACE_ROOT: fixtureRoot,
      FORGE_JOB_LEASE_MS: '5000',
    };
    children.push(
      spawnTracked('coordinator', ['apps/coordinator/dist/server.js'], {
        cwd: process.cwd(),
        env: { ...common, PORT: String(port), HOST: '127.0.0.1' },
        stdio: 'pipe',
      }),
    );
    await waitUntil(async () => (await fetch(`${api}/health`)).ok, 60_000);
    const headers = {
      authorization: `Bearer ${coordinatorToken}`,
      'content-type': 'application/json',
    };
    await request(`${api}/api/projects`, headers, {
      id: `loss-project-${suffix}`,
      name: 'Worker loss fixture',
      repositoryUrl: workspace,
    });
    const created = await request<{ run: { id: string } }>(`${api}/api/runs`, headers, {
      projectId: `loss-project-${suffix}`,
      objective: 'Recover one sandboxed verification job after worker loss',
    });
    const workerEnvironment = {
      ...common,
      FORGE_API_URL: api,
      FORGE_WORKER_ID: workerId,
      FORGE_WORKER_EXECUTOR: 'docker',
      FORGE_SANDBOX_IMAGE: 'theforge-worker-sandbox:local',
      FORGE_JOB_HEARTBEAT_MS: '1000',
    };
    let workerProcess = spawnTracked('worker-a', ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: workerEnvironment,
      stdio: 'pipe',
    });
    children.push(workerProcess);
    await waitUntil(async () => {
      const workers = await getJson<Array<{ id: string }>>(`${api}/api/workers`, headers);
      return workers.some((worker) => worker.id === workerId);
    }, 60_000);
    const queued = await request<{ id: string }>(
      `${api}/api/runs/${created.run.id}/jobs`,
      headers,
      {
        action: { executable: 'node', args: ['slow.js'], cwd: workspace },
        requiredCapabilities: ['node', 'sandbox:docker', 'execution-os:linux'],
        priority: Math.floor(Date.now() / 1000),
      },
    );
    await waitForJobState(api, headers, created.run.id, queued.id, 'leased', 60_000);
    workerProcess.kill('SIGKILL');
    workerProcess = spawnTracked('worker-b', ['apps/worker/dist/index.js'], {
      cwd: process.cwd(),
      env: workerEnvironment,
      stdio: 'pipe',
    });
    children.push(workerProcess);
    const completed = await waitForJobState(
      api,
      headers,
      created.run.id,
      queued.id,
      'completed',
      60_000,
    );
    expect(completed.result).toMatchObject({ code: 0, stdout: 'RECOVERED_ONCE\n' });
    const containers = await dockerContainers(workerId);
    expect(containers).toEqual([]);
  }, 240_000);
});

async function request<T = unknown>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function waitForJobState(
  api: string,
  headers: Record<string, string>,
  runId: string,
  jobId: string,
  state: string,
  timeoutMs: number,
) {
  let found: { id: string; state: string; result?: { code: number; stdout: string } } | undefined;
  await waitUntil(async () => {
    const jobs = await getJson<Array<typeof found>>(`${api}/api/runs/${runId}/jobs`, headers);
    found = jobs.find((job) => job?.id === jobId);
    return found?.state === state;
  }, timeoutMs);
  return found!;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const errorDetail =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === 'string'
        ? lastError
        : lastError
          ? 'unknown polling error'
          : '';
  throw new Error(
    `Timed out after ${timeoutMs}ms${errorDetail ? `: ${errorDetail}` : ''}\n${processLogs.join('\n')}`,
  );
}

function spawnTracked(
  label: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  const child = spawn(process.execPath, args, options);
  child.stdout?.on('data', (chunk: Buffer) => processLogs.push(`${label}: ${chunk.toString()}`));
  child.stderr?.on('data', (chunk: Buffer) => {
    const message = `${label}: ${chunk.toString()}`;
    processLogs.push(message);
  });
  child.on('exit', (code) => processLogs.push(`${label}: exited ${code ?? 'signal'}`));
  return child;
}

async function dockerContainers(workerId: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', [
      'ps',
      '--quiet',
      '--filter',
      `label=theforge.worker=${workerId}`,
    ]);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolvePromise(stdout.split(/\r?\n/).filter(Boolean))
        : reject(new Error(`docker ps exited ${code ?? -1}`)),
    );
  });
}
