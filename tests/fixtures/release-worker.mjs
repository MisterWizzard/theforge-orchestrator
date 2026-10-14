/* global AbortController, Buffer, fetch, process, setTimeout */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const required = [
  'FORGE_API_URL',
  'FORGE_WORKER_TOKEN',
  'FORGE_WORKER_ID',
  'FORGE_FAKE_WORKER_STATE',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const api = process.env.FORGE_API_URL;
const rootToken = process.env.FORGE_WORKER_TOKEN;
const workerId = process.env.FORGE_WORKER_ID;
const statePath = process.env.FORGE_FAKE_WORKER_STATE;
const releasePath = process.env.FORGE_FAKE_WORKER_RELEASE;
const patchPath = process.env.FORGE_FAKE_PROVIDER_PATCH;
const holdFirstJob = process.env.FORGE_FAKE_HOLD_FIRST === '1';
// FORGE_FAKE_POLL_LOG=1 records every empty poll in the state file, with the
// coordinator's x-forge-halted header, so a test can prove work was refused
// rather than merely absent. Off by default: it rewrites the file every poll.
const logPolls = process.env.FORGE_FAKE_POLL_LOG === '1';
let polls = 0;
let haltedPolls = 0;
let held = false;
let sessionToken;
let stopping = false;

process.once('SIGTERM', () => (stopping = true));
process.once('SIGINT', () => (stopping = true));

while (!stopping) {
  try {
    if (!sessionToken) sessionToken = await register();
    await post(`/api/workers/${workerId}/heartbeat`, undefined, sessionToken);
    const response = await fetch(`${api}/api/workers/${workerId}/jobs/next`, {
      headers: authorization(sessionToken),
    });
    if (response.status === 401) {
      sessionToken = undefined;
      continue;
    }
    if (response.status === 204) {
      if (logPolls) {
        const halted = response.headers.get('x-forge-halted');
        polls += 1;
        if (halted) haltedPolls += 1;
        await persistState({
          polls,
          haltedPolls,
          lastPoll: { status: 204, halted, at: new Date().toISOString() },
        });
      }
      await delay(100);
      continue;
    }
    if (!response.ok)
      throw new Error(`job poll returned ${response.status}: ${await response.text()}`);
    const job = await response.json();
    await persistState({
      workerId,
      sessionToken,
      jobId: job.id,
      leaseToken: job.leaseToken,
      role: job.action?.request?.role,
    });
    const leaseHeartbeat = new AbortController();
    let leaseHeartbeatError;
    const leaseHeartbeatPromise = heartbeatLease(
      job.id,
      job.leaseToken,
      sessionToken,
      leaseHeartbeat.signal,
    ).catch((error) => {
      leaseHeartbeatError = error;
    });
    let result;
    try {
      if (holdFirstJob && !held) {
        held = true;
        while (!stopping && !(await exists(releasePath))) await delay(100);
      }
      if (!stopping) result = await execute(job.action, job.id);
    } finally {
      leaseHeartbeat.abort();
      await leaseHeartbeatPromise;
    }
    if (stopping) break;
    if (leaseHeartbeatError) throw leaseHeartbeatError;
    await post(
      `/api/workers/${workerId}/jobs/${job.id}/complete`,
      { leaseToken: job.leaseToken, ...result },
      sessionToken,
    );
    await persistState({ workerId, sessionToken, completedJobId: job.id });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    sessionToken = undefined;
    await delay(150);
  }
}

async function heartbeatLease(jobId, leaseToken, token, signal) {
  while (!signal.aborted) {
    await delay(250);
    if (signal.aborted) return;
    await post(`/api/workers/${workerId}/jobs/${jobId}/heartbeat`, { leaseToken }, token);
  }
}

async function register() {
  const response = await fetch(`${api}/api/workers/register`, {
    method: 'POST',
    headers: { ...authorization(rootToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      id: workerId,
      name: workerId,
      platform: 'linux',
      capabilities: [
        'git',
        'node',
        'typescript',
        'sandbox:docker',
        'execution-os:linux',
        'provider:codex',
        'provider:claude',
      ],
      policyProfile: 'release-fixture',
    }),
  });
  if (!response.ok)
    throw new Error(`registration returned ${response.status}: ${await response.text()}`);
  const registration = await response.json();
  await persistState({ workerId, sessionToken: registration.sessionToken, registered: true });
  return registration.sessionToken;
}

async function execute(action, jobId) {
  if (action.kind === 'provider') return fakeProvider(action);
  return executeCommand(action, jobId);
}

async function fakeProvider(action) {
  const role = action.request.role;
  const text =
    role === 'planner'
      ? 'Implement persisted notes, validation, and exact deterministic tests.'
      : role === 'critic'
        ? 'The plan is scoped, testable, and contains no unsupported release claims.'
        : role === 'reviewer'
          ? '{"approved":true,"findings":[]}'
          : 'Implemented the accepted persisted-notes patch.';
  const events = [
    { type: 'text_delta', text },
    { type: 'usage', inputTokens: 3, outputTokens: 2, usd: 0 },
    { type: 'completed', sessionId: `fixture-${role}`, output: { fixture: true, role } },
  ];
  const patch = role === 'builder' && patchPath ? await readFile(patchPath, 'utf8') : undefined;
  return { code: 0, stdout: '', stderr: '', events, ...(patch !== undefined ? { patch } : {}) };
}

async function executeCommand(action, jobId) {
  const workspace = await materialize(action.workspace, jobId);
  try {
    const cwd = resolve(workspace, action.workingDirectory === '.' ? '' : action.workingDirectory);
    if (
      !cwd.startsWith(`${workspace}\\`) &&
      cwd !== workspace &&
      !cwd.startsWith(`${workspace}/`)
    ) {
      throw new Error('transported working directory escaped fixture workspace');
    }
    return await capture(action.executable, action.args, cwd);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function materialize(snapshot, jobId) {
  const workspace = await mkdtemp(join(tmpdir(), `forge-release-worker-${jobId}-`));
  const cloned = await capture(
    'git',
    ['clone', '--no-checkout', snapshot.repositoryUrl, workspace],
    process.cwd(),
  );
  if (cloned.code !== 0) throw new Error(`fixture clone failed: ${cloned.stderr}`);
  const checkedOut = await capture('git', ['checkout', '--detach', snapshot.revision], workspace);
  if (checkedOut.code !== 0) throw new Error(`fixture checkout failed: ${checkedOut.stderr}`);
  if (snapshot.patch) {
    const applied = await capture(
      'git',
      ['apply', '--binary', '--whitespace=nowarn', '-'],
      workspace,
      snapshot.patch,
    );
    if (applied.code !== 0) throw new Error(`fixture patch apply failed: ${applied.stderr}`);
  }
  for (const file of snapshot.untrackedFiles ?? []) {
    const target = resolve(workspace, file.path);
    if (!target.startsWith(`${workspace}\\`) && !target.startsWith(`${workspace}/`)) {
      throw new Error(`untracked path escaped fixture workspace: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'));
  }
  return workspace;
}

async function capture(command, args, cwd, stdin) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function post(path, body, token) {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { ...authorization(token), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  if (response.status === 204) return undefined;
  return response.json();
}

async function persistState(value) {
  await mkdir(dirname(statePath), { recursive: true });
  const current = await readFile(statePath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  await writeFile(statePath, JSON.stringify({ ...current, ...value }), 'utf8');
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

async function exists(path) {
  if (!path) return false;
  return access(path)
    .then(() => true)
    .catch(() => false);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
