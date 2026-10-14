import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  approvalAllows,
  classifyAction,
  redactSecrets,
  type CommandAction,
} from '@theforge/policy';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_EVENTS_BYTES,
  MAX_PATCH_BYTES,
  MAX_RAW_TAIL_BYTES,
  EnvironmentError,
  formatEnvironmentError,
  ProviderEventSchema,
  ProviderRequestSchema,
  type Approval,
  type ProviderEvent,
  type ProviderId,
  type ProviderRequest,
} from '@theforge/contracts';
import {
  checkTaskLimits,
  freshTokens,
  TIER_MODELS,
  type TaskLimits,
  type TaskUsage,
} from '@theforge/guardrails';
import { ClaudeAdapter } from '@theforge/provider-claude';
import { CodexAdapter, EXTERNAL_SANDBOX_MARKER } from '@theforge/provider-codex';
import { listModels, OllamaAdapter } from '@theforge/provider-ollama';
import {
  capture,
  jsonLineProcess,
  type JsonLineProcessOptions,
  type ProviderAdapter,
} from '@theforge/providers';
import { environmentFileDescription, loadEnvironment, type WorkerEnvironment } from './env.js';
import { keyProbeVerdict, probeAnthropicKey } from './key-probe.js';
/**
 * Configuration is the one failure an operator has to fix by hand, so it is
 * reported as one line per variable with a remedy, not as a zod stack trace.
 */
function loadWorkerEnvironment(): WorkerEnvironment {
  try {
    return loadEnvironment();
  } catch (error) {
    if (!(error instanceof EnvironmentError)) throw error;
    console.error(formatEnvironmentError(error, environmentFileDescription()));
    process.exit(1);
  }
}
const env = loadWorkerEnvironment();
/** Per-task bounds every provider job runs under; see collectProviderEvents. */
const taskLimits: TaskLimits = {
  maxToolCalls: env.FORGE_TASK_MAX_TOOL_CALLS,
  maxWallClockMinutes: env.FORGE_TASK_MAX_MINUTES,
  maxTokens: env.FORGE_TASK_MAX_TOKENS,
};
/** What happens to a failed job's workspace; see retainFailedWorkspace. */
const failedWorkspaceRetention: FailedWorkspaceRetention = {
  keep: env.FORGE_FAILED_WORKSPACE_KEEP,
  maxAgeHours: env.FORGE_FAILED_WORKSPACE_MAX_AGE_HOURS,
};
const coordinatorUrl = new URL(env.FORGE_API_URL);
const loopbackCoordinator = ['127.0.0.1', '::1', 'localhost'].includes(coordinatorUrl.hostname);
if (coordinatorUrl.protocol !== 'https:' && !loopbackCoordinator) {
  throw new Error('Remote workers require an HTTPS coordinator URL');
}
const worker = {
  id: env.FORGE_WORKER_ID,
  name: hostname(),
  platform: platform() as 'linux' | 'darwin' | 'win32',
  capabilities: ['git', 'node', 'typescript', platform()],
  policyProfile: 'default',
  /**
   * Providers this worker is configured for but withholds because they do not
   * work, with the reason (ADR-038). Absent from `capabilities` and present
   * here, so the coordinator's diagnostic can say why instead of "not found".
   */
  providerFaults: {} as Record<string, string>,
};
/**
 * The cloud providers that run in the Docker sandbox with a credential; ollama runs in this process.
 * `claude` and `claude-sub` are the same CLI with different credentials (ADR-041).
 */
const dockerProviderIds = ['claude', 'claude-sub', 'codex'] as const;
type DockerProviderId = (typeof dockerProviderIds)[number];
/** The CLI a provider id runs inside the sandbox; the container entrypoint knows only these two. */
function cliFor(providerId: DockerProviderId): 'claude' | 'codex' {
  return providerId === 'codex' ? 'codex' : 'claude';
}
type WorkerWorkspaceFile = { path: string; contentBase64: string; executable: boolean };
type WorkerWorkspaceSnapshot = {
  repositoryUrl: string;
  revision: string;
  patch: string;
  untrackedFiles: WorkerWorkspaceFile[];
};
type TransportedJobStep = {
  executable: string;
  args: string[];
  network?: DockerNetworkBoundary;
  /** End the sequence when this step fails; set for an install, not a check. */
  stopOnFailure?: boolean;
};
type TransportedCommandAction = {
  kind?: 'command';
  executable: string;
  args: string[];
  workspace: WorkerWorkspaceSnapshot;
  workingDirectory: string;
  /**
   * `install` grants this one command network access to fetch dependencies.
   * Absent or `none` for everything else, which is almost everything.
   */
  network?: DockerNetworkBoundary;
  /**
   * Commands to run in order in this job's one workspace, each in its own
   * container with its own boundary. Absent for a single-command job, which is
   * every job but a verification with an install step.
   */
  steps?: TransportedJobStep[];
};
type TransportedProviderAction = {
  kind: 'provider';
  providerId: ProviderId;
  request: unknown;
  workspace: WorkerWorkspaceSnapshot;
  workingDirectory: string;
};
type TransportedWorkerAction = TransportedCommandAction | TransportedProviderAction;
export class CoordinatorRequestError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Coordinator ${path} returned ${status}${body ? `: ${body}` : ''}`);
  }
}
async function request(path: string, init: RequestInit = {}, token = env.FORGE_WORKER_TOKEN) {
  const response = await fetch(`${env.FORGE_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CoordinatorRequestError(path, response.status, body.slice(0, 2_000));
  }
  if (response.status === 204) return undefined;
  return (await response.json()) as unknown;
}
export function evaluateCommand(action: CommandAction) {
  return classifyAction(action, resolve(env.FORGE_WORKSPACE_ROOT));
}
export async function executeCommand(
  action: CommandAction,
  options: {
    approval?: Approval;
    signal?: AbortSignal;
    knownSecrets?: string[];
    network?: DockerNetworkBoundary;
  } = {},
) {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Command cancelled');
  const { workspaceRoot, actionRoot } = await assertRealWorkspaceContainment(action.cwd);
  const classification = classifyAction({ ...action, cwd: actionRoot }, workspaceRoot);
  if (
    classification.class !== 'green' &&
    (!options.approval || !approvalAllows(options.approval, action))
  ) {
    throw new Error(`${classification.class} action requires an exact active approval`);
  }
  if (env.FORGE_WORKER_EXECUTOR === 'docker') {
    return executeDockerCommand(action, options);
  }
  // Below here is the test-only host executor, which has no sandbox and so no
  // network boundary to honour.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Host command execution is test-only; configure the Docker sandbox');
  }
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(action.executable, action.args, {
      cwd: action.cwd,
      shell: false,
      env: childEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-1_000_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({
        code: code ?? -1,
        stdout: redactSecrets(stdout, options.knownSecrets ?? []),
        stderr: redactSecrets(stderr, options.knownSecrets ?? []),
      });
    });
  });
}

export async function executeDockerCommand(
  action: CommandAction,
  options: {
    signal?: AbortSignal;
    knownSecrets?: string[];
    /** Defaults to `none`; only a declared install step passes anything else. */
    network?: DockerNetworkBoundary;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Command cancelled');
  const workspace = await realpath(resolve(action.cwd));
  if (workspace.includes(','))
    throw new Error('Docker sandbox workspace paths cannot contain commas');
  const executable = sandboxExecutable(action.executable);
  const containerName = `theforge-${worker.id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const args = [
    ...dockerIsolationArgs(workspace, containerName, options.network ?? 'none'),
    '--entrypoint',
    executable,
    env.FORGE_SANDBOX_IMAGE,
    ...action.args,
  ];
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { shell: false, env: childEnvironment() });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-250_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const stopper = spawn('docker', ['stop', '--time', '3', containerName], {
        shell: false,
        stdio: 'ignore',
        env: childEnvironment(),
      });
      stopper.once('close', () => child.kill('SIGTERM'));
      stopper.once('error', () => child.kill('SIGTERM'));
    };
    // Derived rather than hardcoded. This is the hard kill on the sandbox
    // container, and at a fixed 900,000 ms it was a fourth independent
    // fifteen-minute ceiling - so raising the stage timeout alone would simply
    // have moved the wall here and failed the next attempt at the same minute.
    //
    // `FORGE_TASK_MAX_MINUTES` is the one place that already answers "how long
    // may a task run" on this side (it defaults to
    // DEFAULT_TASK_LIMITS.maxWallClockMinutes), so this follows it. The extra
    // minute is deliberate: `checkTaskLimits` should be the thing that reports
    // a task running too long, with a reason, before the container is killed
    // out from under it with none.
    const deadline = setTimeout(stop, (env.FORGE_TASK_MAX_MINUTES + 1) * 60_000);
    deadline.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', stop);
      resolveResult({
        code: code ?? -1,
        stdout: redactSecrets(stdout, options.knownSecrets ?? []),
        stderr: redactSecrets(stderr, options.knownSecrets ?? []),
      });
    });
  });
}

/**
 * What a sandbox container may reach.
 *
 * `none` is the default and the point: a container running the agent's work or
 * the project's own commands has no network at all, which is what the threat
 * model relies on to stop an agent buying anything.
 *
 * `install` exists because that sealed box cannot run `npm ci` - DNS fails with
 * EAI_AGAIN - and a project whose checks need its dependencies installed could
 * therefore never be verified at all. Dan's decision of 05/10/2026 was to split
 * the two rather than open the checking box: a short-lived container fetches
 * dependencies with network access and runs nothing else, then the checks run
 * sealed as before, finding the dependencies already in the shared workspace
 * mount. The container that touches the network never runs lint, tests, or
 * anything the agent wrote.
 *
 * Named separately from `provider-api` rather than reusing it, so that grepping
 * for why a container has egress gives the actual reason.
 */
type DockerNetworkBoundary = 'none' | 'provider-api' | 'install';

export function dockerIsolationArgs(
  workspace: string,
  containerName: string,
  network: DockerNetworkBoundary,
): string[] {
  const { uid, gid } = sandboxUserIdentity();
  return [
    'run',
    '--rm',
    '--init',
    '--name',
    containerName,
    '--label',
    `theforge.worker=${worker.id}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--pids-limit',
    '256',
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    '--cpus',
    '2',
    '--network',
    // Provider containers get ordinary Docker bridge egress solely for provider HTTPS APIs.
    // Host networking is never used, and /workspace is the only host filesystem mount.
    network === 'none' ? 'none' : 'bridge',
    '--user',
    `${uid}:${gid}`,
    '--mount',
    `type=bind,src=${workspace},dst=/workspace`,
    '--workdir',
    '/workspace',
    '--tmpfs',
    // An install step downloads a real application's dependencies, and the
    // sizes below were chosen for a container running one short command.
    // PulseApp's `npm ci` hit `ENOSPC` on attempt ten of the first real
    // objective: npm caches in `/home/node/.npm`, and 64 MB does not hold
    // Next.js, Prisma and Playwright.
    //
    // Raised for the install boundary only, so a container running checks or
    // anything the agent wrote keeps the small limits it has always had.
    //
    // Checked rather than assumed, because tmpfs is RAM-backed and the
    // container is capped at `--memory 2g`: writing 1.5 GB into a 2 GB tmpfs
    // inside a 2 GB-memory container on this host does not trip the cgroup, so
    // the size can be raised without also raising the memory allowance.
    network === 'install' ? '/tmp:rw,nosuid,nodev,size=1g' : '/tmp:rw,nosuid,nodev,size=256m',
    '--tmpfs',
    `/home/node:rw,nosuid,nodev,size=${network === 'install' ? '2g' : '64m'},uid=${uid},gid=${gid},mode=0700`,
  ];
}

function sandboxUserIdentity(): { uid: number; gid: number } {
  const hostUid = process.getuid?.();
  const uid = hostUid !== undefined && hostUid > 0 ? hostUid : 1000;
  const hostGid = process.getgid?.();
  return { uid, gid: hostGid !== undefined && hostGid > 0 ? hostGid : uid };
}

function sandboxExecutable(executable: string): string {
  const normalized = basename(executable)
    .toLowerCase()
    .replace(/\.(cmd|exe)$/i, '');
  if (!['git', 'node', 'npm', 'npx', 'pnpm'].includes(normalized)) {
    throw new Error(`Executable ${executable} is not installed in the worker sandbox`);
  }
  return normalized;
}

async function assertRealWorkspaceContainment(
  cwd: string,
): Promise<{ workspaceRoot: string; actionRoot: string }> {
  const workspaceRoot = await realpath(resolve(env.FORGE_WORKSPACE_ROOT));
  const actionRoot = await realpath(resolve(cwd)).catch(() => {
    throw new Error('red action requires an exact active approval: workspace path unavailable');
  });
  const difference = relative(workspaceRoot, actionRoot);
  if (
    difference === '..' ||
    difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(difference)
  ) {
    throw new Error('red action requires an exact active approval: workspace symlink escape');
  }
  return { workspaceRoot, actionRoot };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'CI',
    'NODE_ENV',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
}
export type WorkerDaemon = {
  worker: typeof worker;
  stop: (reason?: Error) => void;
  stopped: Promise<void>;
};

export async function startWorker(signal?: AbortSignal): Promise<WorkerDaemon> {
  const lifecycleController = new AbortController();
  const lifecycleSignal = signal
    ? AbortSignal.any([signal, lifecycleController.signal])
    : lifecycleController.signal;
  if (env.FORGE_WORKER_EXECUTOR === 'host' && process.env.NODE_ENV !== 'test') {
    throw new Error('Host command execution is test-only; production workers require Docker');
  }
  if (env.FORGE_WORKER_EXECUTOR === 'host') {
    worker.capabilities.push('executor:test-host');
  }
  if (env.FORGE_WORKER_EXECUTOR === 'docker') {
    const [engine, image] = await Promise.all([
      capture('docker', ['info', '--format', '{{.OSType}}']),
      capture('docker', ['image', 'inspect', env.FORGE_SANDBOX_IMAGE, '--format', '{{.Id}}']),
    ]);
    if (engine.code !== 0 || engine.stdout.trim() !== 'linux')
      throw new Error('Worker requires a running Linux Docker engine');
    if (image.code !== 0 || !image.stdout.trim().startsWith('sha256:'))
      throw new Error(`Build the worker sandbox first: pnpm sandbox:build`);
    worker.capabilities.push(
      'sandbox:docker',
      'execution-os:linux',
      `sandbox-image:${image.stdout.trim()}`,
    );
    await cleanupDockerOrphans();
  }
  await sweepFailedWorkspaces(resolve(env.FORGE_WORKSPACE_ROOT), failedWorkspaceRetention);
  for (const providerId of dockerProviderIds) {
    const diagnosis = await diagnoseDockerProvider(providerId).catch((): ProviderDiagnosis => ({
      ok: false,
    }));
    if (diagnosis.note) process.stdout.write(`${diagnosis.note}\n`);
    if (diagnosis.ok) worker.capabilities.push(`provider:${providerId}`);
    else if (diagnosis.fault) worker.providerFaults[providerId] = diagnosis.fault;
  }
  // Local models never fail startup: an absent server means the capability is
  // simply not advertised, and the one log line says which it was.
  const ollama = await probeOllamaCapabilities(env.FORGE_OLLAMA_URL);
  worker.capabilities.push(...ollama.capabilities);
  process.stdout.write(`${ollama.detail}\n`);
  const register = async () =>
    (await request('/api/workers/register', {
      method: 'POST',
      body: JSON.stringify(worker),
    })) as { sessionToken: string };
  /**
   * Registering is the one call a worker cannot skip, and it happens at the
   * moment the coordinator is least likely to be ready.
   *
   * `pnpm start` launches coordinator, web and worker in parallel, so a worker
   * that registers before the coordinator binds its port gets ECONNREFUSED and,
   * without this, exits permanently. Whether the stack comes up at all then
   * depends on which process wins a race. Observed on 2026-09-25: the same
   * command worked earlier in the day and failed later, with nothing changed.
   *
   * Retry with bounded exponential backoff. A coordinator that is genuinely
   * absent still fails, just after roughly a minute of trying rather than
   * instantly.
   */
  let registration = await (async () => {
    const maxAttempts = 8;
    let delayMs = 500;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await register();
      } catch (error) {
        const last = attempt === maxAttempts;
        const reason = error instanceof Error ? error.message : String(error);
        if (last || lifecycleSignal.aborted) {
          throw new Error(
            `worker could not register with ${env.FORGE_API_URL} after ${attempt} attempts: ${reason}`,
          );
        }
        process.stdout.write(
          `worker registration attempt ${attempt} failed (${reason}); retrying in ${delayMs}ms\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 10_000);
      }
    }
    throw new Error('unreachable');
  })();
  const heartbeat = async () => {
    if (!lifecycleSignal.aborted) {
      try {
        await request(
          `/api/workers/${worker.id}/heartbeat`,
          { method: 'POST' },
          registration.sessionToken,
        );
      } catch {
        if (lifecycleSignal.aborted) return;
        registration = await register();
        await request(
          `/api/workers/${worker.id}/heartbeat`,
          { method: 'POST' },
          registration.sessionToken,
        );
      }
    }
  };
  await heartbeat();
  const heartbeatTimer = setInterval(
    () => void heartbeat().catch((error: unknown) => console.error(error)),
    10000,
  );
  let working = false;
  let activeJobController: AbortController | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const settleStopped = () => {
    if (lifecycleSignal.aborted && !working) resolveStopped?.();
  };
  const poll = async () => {
    if (working || lifecycleSignal.aborted) return;
    working = true;
    try {
      const job = (await request(
        `/api/workers/${worker.id}/jobs/next`,
        { method: 'GET' },
        registration.sessionToken,
      )) as
        | {
            id: string;
            action: TransportedWorkerAction;
            leaseToken: string;
            approval?: Approval;
          }
        | undefined;
      if (!job) return;
      const jobController = new AbortController();
      activeJobController = jobController;
      let leaseLost = false;
      const sendLeaseHeartbeat = () =>
        request(
          `/api/workers/${worker.id}/jobs/${job.id}/heartbeat`,
          { method: 'POST', body: JSON.stringify({ leaseToken: job.leaseToken }) },
          registration.sessionToken,
        );
      const heartbeatLease = async () => {
        try {
          let value: unknown;
          try {
            value = await sendLeaseHeartbeat();
          } catch (error) {
            // A 401 and a 409 mean opposite things here and need opposite
            // responses, which is the bug this handles.
            //
            // 409 `job_lease_invalid` is the lease genuinely gone - someone else
            // holds it, or it expired and was reclaimed. Abandoning the job is
            // right.
            //
            // 401 `worker_session_invalid` is only the WORKER SESSION expiring,
            // and the session lives 15 minutes while a task is allowed 30
            // (`DEFAULT_TASK_LIMITS.maxWallClockMinutes`), so any stage running
            // longer than fifteen minutes was guaranteed to hit it. The lease
            // itself is still valid - lease tokens are per job and independent
            // of the session - so the right response is to register again and
            // retry, not to throw away work that is still running.
            //
            // This is not hypothetical. On 04/10/2026 the first objective ever
            // pointed at a real repository got through planning and critique and
            // then lost its builder twelve and a half minutes in, to exactly this
            // 401, while the Codex container was still working. Toy objectives
            // had always finished inside the window, which is why it had never
            // been seen.
            //
            // There is room to recover: the session dies at T and the lease has
            // up to FORGE_JOB_LEASE_MS left, so re-registering inside the same
            // heartbeat tick renews in time.
            if (!(error instanceof CoordinatorRequestError) || error.status !== 401) throw error;
            console.error(
              `Worker session expired during job ${job.id}; registering again and retrying the lease heartbeat`,
            );
            registration = await register();
            value = await sendLeaseHeartbeat();
          }
          if ((value as { cancelRequested?: boolean } | undefined)?.cancelRequested)
            jobController.abort(new Error('Job cancellation requested by coordinator'));
        } catch (error) {
          leaseLost = true;
          jobController.abort(new Error('Worker lease lost'));
          console.error(`Worker lease lost for ${job.id}:`, error);
        }
      };
      await heartbeatLease();
      const leaseHeartbeat = setInterval(() => void heartbeatLease(), env.FORGE_JOB_HEARTBEAT_MS);
      let result: WorkerJobResult;
      try {
        const executionSignal = AbortSignal.any([lifecycleSignal, jobController.signal]);
        result = await executeTransportedJob(job.action, executionSignal, job.id, job.approval, [
          env.FORGE_WORKER_TOKEN,
          registration.sessionToken,
        ]);
      } catch (error) {
        result = {
          code: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearInterval(leaseHeartbeat);
      }
      if (jobController.signal.aborted && !leaseLost) {
        const cancellationEvidence =
          jobController.signal.reason instanceof Error
            ? jobController.signal.reason.message
            : 'Job cancelled';
        result = {
          ...result,
          code: -1,
          stderr: [result.stderr, cancellationEvidence].filter(Boolean).join('\n'),
        };
      }
      if (!leaseLost) {
        await submitJobCompletion(
          (body) =>
            request(
              `/api/workers/${worker.id}/jobs/${job.id}/complete`,
              { method: 'POST', body },
              registration.sessionToken,
            ),
          job.id,
          job.leaseToken,
          result,
        );
      }
    } finally {
      activeJobController = undefined;
      working = false;
      settleStopped();
    }
  };
  const pollTimer = setInterval(
    () => void poll().catch((error: unknown) => console.error(error)),
    1000,
  );
  void poll().catch((error: unknown) => console.error(error));
  const stopLifecycle = () => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    activeJobController?.abort(new Error('Worker shutdown requested'));
    settleStopped();
  };
  lifecycleSignal.addEventListener('abort', stopLifecycle, { once: true });
  if (lifecycleSignal.aborted) stopLifecycle();
  return {
    worker,
    stop: (reason = new Error('Worker shutdown requested')) => lifecycleController.abort(reason),
    stopped,
  };
}

async function cleanupDockerOrphans(): Promise<void> {
  const listed = await capture('docker', [
    'ps',
    '--quiet',
    '--filter',
    `label=theforge.worker=${worker.id}`,
  ]);
  if (listed.code !== 0)
    throw new Error(`Could not inspect worker sandbox containers: ${listed.stderr}`);
  for (const containerId of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const stopped = await capture('docker', ['stop', '--time', '3', containerId]);
    if (stopped.code !== 0)
      throw new Error(`Could not stop orphaned worker container ${containerId}: ${stopped.stderr}`);
  }
}

function isProviderAction(action: TransportedWorkerAction): action is TransportedProviderAction {
  return 'kind' in action && action.kind === 'provider';
}

/**
 * Materialise the job's workspace, run it, and dispose of the workspace: a
 * success is removed, a failure or a cancellation is kept under
 * <root>/.failed for inspection (docs/OPERATIONS.md "Failed workspaces") and
 * named in the result as `retainedWorkspace`. A thrown error is reported as
 * a failed result here rather than propagated, so the workspace it left
 * behind is kept like any other failure. Exported, with the retention policy
 * injectable, for the retention tests.
 */
export async function executeTransportedJob(
  action: TransportedWorkerAction,
  signal: AbortSignal,
  jobId: string,
  approval: Approval | undefined,
  knownSecrets: string[],
  retention: FailedWorkspaceRetention = failedWorkspaceRetention,
): Promise<WorkerJobResult> {
  const workspace = await materializeWorkerWorkspace(action.workspace, jobId, signal);
  let result: WorkerJobResult;
  try {
    const cwd = await resolveMaterializedWorkingDirectory(workspace, action.workingDirectory);
    result = isProviderAction(action)
      ? await executeProviderJob(
          { providerId: action.providerId, request: action.request, cwd },
          signal,
        )
      : action.steps && action.steps.length > 0
        ? await executeCommandSteps(action.steps, cwd, { approval, signal, knownSecrets })
        : await executeCommand(
            { executable: action.executable, args: action.args, cwd },
            {
              ...(approval ? { approval } : {}),
              signal,
              knownSecrets,
              // Only a declared install step carries this; everything else stays
              // on the default `none`.
              ...(action.network ? { network: action.network } : {}),
            },
          );
  } catch (error) {
    result = {
      code: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.code === 0 && !signal.aborted) {
    await rm(workspace, { recursive: true, force: true });
    return result;
  }
  const cancelled = signal.aborted;
  const reason = cancelled
    ? signal.reason instanceof Error
      ? signal.reason.message
      : 'Job cancelled'
    : result.stderr.trim().slice(-2_000) || `exit code ${result.code}`;
  const request =
    isProviderAction(action) && action.request && typeof action.request === 'object'
      ? (action.request as { runId?: unknown; role?: unknown })
      : {};
  const retainedWorkspace = await retainFailedWorkspace(
    workspace,
    {
      jobId,
      ...(typeof request.runId === 'string' ? { runId: request.runId } : {}),
      ...(typeof request.role === 'string' ? { role: request.role } : {}),
      code: cancelled ? -1 : result.code,
      reason,
    },
    retention,
  );
  return retainedWorkspace ? { ...result, retainedWorkspace } : result;
}

/**
 * Run a job's steps in order in the one workspace `executeTransportedJob`
 * materialised, each in its own container with its own network boundary, and
 * stop at the first failure.
 *
 * Sharing the workspace is the whole point: it does not outlive a job, so an
 * install in a job of its own installs into a directory that is then deleted.
 *
 * The result's `code`, `stdout` and `stderr` are the decisive step's - the
 * first that failed, or the last when all passed - so every existing reader of
 * a command result still sees what happened, with a line naming which command
 * it was, because otherwise the output of one of four commands arrives
 * unlabelled. `steps` carries all of them for a reader that wants the detail.
 *
 * Only a step marked `stopOnFailure` ends the sequence, so an install failure
 * skips the checks that would each report 127 while a failing check still lets
 * the others run and be fixed in one revision.
 *
 * A step that throws rather than exits - a refused classification, a
 * containment failure - is recorded as a step with code -1, and ends the
 * sequence only under the same rule, so the evidence from the steps that did
 * run is not lost to the caller's catch.
 *
 * Output is bounded by the sandbox capture (250 KB per stream per step), so a
 * four-step job carries at most ~2 MB against a 16 MB completion limit.
 */
async function executeCommandSteps(
  steps: TransportedJobStep[],
  cwd: string,
  options: { approval?: Approval | undefined; signal: AbortSignal; knownSecrets: string[] },
): Promise<WorkerJobResult> {
  const outcomes: NonNullable<WorkerJobResult['steps']> = [];
  for (const step of steps) {
    const command = [step.executable, ...step.args].join(' ');
    let outcome: { code: number; stdout: string; stderr: string };
    try {
      outcome = await executeCommand(
        { executable: step.executable, args: step.args, cwd },
        {
          ...(options.approval ? { approval: options.approval } : {}),
          signal: options.signal,
          knownSecrets: options.knownSecrets,
          ...(step.network ? { network: step.network } : {}),
        },
      );
    } catch (error) {
      outcome = {
        code: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes.push({ command, ...outcome });
    if (outcome.code !== 0 && step.stopOnFailure) break;
  }
  // The first failure, or the last step when every one passed. Not simply the
  // last: a checks sequence deliberately runs on after a failure, so the last
  // step's code would report a passing verification whose lint check failed.
  const decisive = outcomes.find((outcome) => outcome.code !== 0) ?? outcomes[outcomes.length - 1];
  if (!decisive) throw new Error('A stepped job needs at least one step');
  return {
    code: decisive.code,
    stdout: decisive.stdout,
    stderr: [`$ ${decisive.command}`, decisive.stderr].filter(Boolean).join('\n'),
    steps: outcomes,
  };
}

/** How failed workspaces are kept; the worker's comes from env, tests inject their own. */
export type FailedWorkspaceRetention = {
  /** Newest entries kept under <root>/.failed; 0 retains nothing. */
  keep: number;
  maxAgeHours: number;
  now?: () => Date;
  rename?: (from: string, to: string) => Promise<void>;
  /** The wait between the five rename attempts on a busy directory. */
  retryDelayMs?: number;
  log?: (level: 'info' | 'warn', line: string) => void;
};

type RetainedWorkspaceDetails = {
  jobId: string;
  runId?: string;
  role?: string;
  code: number;
  reason: string;
};

function defaultRetentionLog(level: 'info' | 'warn', line: string): void {
  if (level === 'warn') console.warn(line);
  else process.stdout.write(`${line}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a finished job's workspace to <root>/.failed/<yyyyMMddTHHmmss>-<jobId>
 * with a RETAINED.json beside its files, then apply the retention policy to
 * the whole directory. Returns the retained path, or undefined when nothing
 * was kept: retention is off (keep 0), or the directory could not be moved.
 *
 * On Windows a stopped-but-not-yet-removed sandbox container can still hold
 * the bind mount, and the rename fails with EBUSY or EPERM until it lets go;
 * five attempts half a second apart cover that. A directory that still
 * cannot be moved is removed as it would have been without retention, with a
 * warning. Never throws: disposal must not turn a reported failure into a
 * crash. The retained files are for a human with disk access only - check
 * and provider output can hold secrets - and nothing serves them.
 */
export async function retainFailedWorkspace(
  workspace: string,
  details: RetainedWorkspaceDetails,
  retention: FailedWorkspaceRetention,
): Promise<string | undefined> {
  const log = retention.log ?? defaultRetentionLog;
  if (retention.keep <= 0) {
    await rm(workspace, { recursive: true, force: true });
    return undefined;
  }
  const now = (retention.now ?? (() => new Date()))();
  const root = dirname(workspace);
  const failedRoot = resolve(root, '.failed');
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const safeJobId = details.jobId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || 'job';
  const base = resolve(failedRoot, `${stamp}-${safeJobId}`);
  assertContainedPath(failedRoot, base, 'retained workspace');
  await mkdir(failedRoot, { recursive: true });
  let target = base;
  for (let suffix = 2; await pathExists(target); suffix += 1) target = `${base}-${suffix}`;
  const move = retention.rename ?? rename;
  const delayMs = retention.retryDelayMs ?? 500;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await move(workspace, target);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === 'EBUSY' || code === 'EPERM';
      if (busy && attempt < 5) {
        await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(
        'warn',
        `failed workspaces: could not move ${workspace} to ${target} after ${attempt} attempt(s) (${detail}); removing it instead`,
      );
      await rm(workspace, { recursive: true, force: true }).catch((removeError: unknown) => {
        const why = removeError instanceof Error ? removeError.message : String(removeError);
        log('warn', `failed workspaces: could not remove ${workspace} either (${why})`);
      });
      return undefined;
    }
  }
  const retainedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + retention.maxAgeHours * 3_600_000).toISOString();
  await writeFile(
    resolve(target, 'RETAINED.json'),
    `${JSON.stringify({ ...details, retainedAt, expiresAt }, null, 2)}\n`,
  );
  log(
    'info',
    `failed workspaces: kept ${target} (job ${details.jobId}, code ${details.code}; expires ${expiresAt})`,
  );
  await sweepFailedWorkspaces(root, retention);
  return target;
}

/**
 * Apply the retention policy to <root>/.failed: keep the newest `keep`
 * entries and drop any older than `maxAgeHours`, logging each removal. Age is
 * read from the entry's name, the timestamp the worker gave it, so a
 * directory an operator has renamed is no longer the worker's to remove.
 * Runs at startup and after every retention; a missing directory is nothing
 * to do. Returns what was removed.
 */
export async function sweepFailedWorkspaces(
  root: string,
  retention: FailedWorkspaceRetention,
): Promise<string[]> {
  const log = retention.log ?? defaultRetentionLog;
  const failedRoot = resolve(root, '.failed');
  const entries = await readdir(failedRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const now = (retention.now ?? (() => new Date()))().getTime();
  const oldest = now - retention.maxAgeHours * 3_600_000;
  const retained = entries
    .flatMap((entry) => {
      const stamp = entry.isDirectory() ? /^(\d{8}T\d{6})-/.exec(entry.name)?.[1] : undefined;
      if (!stamp) return [];
      const at = Date.parse(
        `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
      );
      return Number.isNaN(at) ? [] : [{ name: entry.name, at }];
    })
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const removed: string[] = [];
  for (const [index, entry] of retained.entries()) {
    const why =
      index >= retention.keep
        ? `beyond the newest ${retention.keep}`
        : entry.at < oldest
          ? `older than ${retention.maxAgeHours} h`
          : undefined;
    if (!why) continue;
    const path = resolve(failedRoot, entry.name);
    try {
      await rm(path, { recursive: true, force: true });
      log('info', `failed workspaces: removed ${path} (${why})`);
      removed.push(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log('warn', `failed workspaces: could not remove ${path} (${detail})`);
    }
  }
  return removed;
}

export type RawOutputMode = WorkerEnvironment['FORGE_RAW_OUTPUT'];
/** Drives a sandboxed CLI: `jsonLineProcess` over `docker run`, or a scripted stand-in under test. */
type ProcessRunner = (options: JsonLineProcessOptions) => AsyncIterable<unknown>;
type RawOutputTee = Required<Pick<JsonLineProcessOptions, 'onRawStdoutLine' | 'onStderr'>>;
type ProviderJobOptions = {
  ollamaUrl?: string;
  /** Overrides FORGE_RAW_OUTPUT for this job. */
  rawOutputMode?: RawOutputMode;
  processRunner?: ProcessRunner;
};

/**
 * Run one provider request and report it as a job result. A cloud provider
 * (claude, codex) runs its CLI in the Docker sandbox with an isolated
 * credential; ollama runs in this process against the local model server,
 * with no sandbox and no credential (ADR-021). Both paths share the per-task
 * limits and the redaction in collectProviderEvents. A sandboxed CLI's raw
 * stdout and stderr are also teed into two bounded tails which, under
 * FORGE_RAW_OUTPUT, join the result redacted (docs/OPERATIONS.md "Raw
 * provider output"); ollama speaks HTTP and has no process output to tee.
 * Exported so the ollama path can be exercised against a fake server and the
 * sandbox path with a scripted process in place of `docker`.
 */
export async function executeProviderJob(
  action: {
    providerId: ProviderId;
    request: unknown;
    cwd: string;
  },
  signal: AbortSignal,
  options: ProviderJobOptions = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  events: ProviderEvent[];
  patch?: string;
  rawStdoutTail?: string;
  rawStderrTail?: string;
}> {
  await assertRealWorkspaceContainment(action.cwd);
  const request = ProviderRequestSchema.parse(action.request);
  const rawStdout = new RollingTail(MAX_RAW_TAIL_BYTES);
  const rawStderr = new RollingTail(MAX_RAW_TAIL_BYTES);
  const { provider, redactionValues } = await createProviderForJob(action.providerId, request, {
    ...options,
    tee: {
      onRawStdoutLine: (line) => rawStdout.push(`${line}\n`),
      onStderr: (chunk) => rawStderr.push(chunk),
    },
  });
  const builder = request.role === 'builder';
  const knownSecrets = [env.FORGE_WORKER_TOKEN, ...redactionValues];
  const { events } = await collectProviderEvents(provider, request, {
    cwd: action.cwd,
    signal,
    redactionValues: knownSecrets,
  });
  const failure = events.find((event) => event.type === 'error');
  const rawOutputMode = options.rawOutputMode ?? env.FORGE_RAW_OUTPUT;
  const tails =
    rawOutputMode === 'always' || (rawOutputMode === 'failure' && failure)
      ? redactedRawTails(rawStdout, rawStderr, knownSecrets)
      : {};
  const result = {
    code: failure ? 1 : 0,
    stdout: '',
    stderr: failure?.message ?? '',
    events,
    ...tails,
  };
  if (!builder || failure) return result;
  try {
    return { ...result, patch: await captureAttemptPatch(action.cwd, signal) };
  } catch (error) {
    if (error instanceof PatchTooLargeError)
      return failedJobResult(result, 'PATCH_TOO_LARGE', error.message);
    throw error;
  }
}

/**
 * The end of a text stream, bounded in UTF-8 bytes. Chunks are kept whole and
 * the oldest dropped as newer ones arrive, so pushing a line costs the line
 * rather than the whole tail; `text()` cuts whatever still overhangs.
 */
export class RollingTail {
  private readonly chunks: Array<{ text: string; bytes: number }> = [];
  private bytes = 0;
  constructor(readonly maxBytes: number) {}
  push(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    this.chunks.push({ text, bytes });
    this.bytes += bytes;
    while (this.chunks.length > 1) {
      const oldest = this.chunks[0];
      if (!oldest || this.bytes - oldest.bytes < this.maxBytes) break;
      this.chunks.shift();
      this.bytes -= oldest.bytes;
    }
  }
  text(): string {
    return lastBytes(this.chunks.map((chunk) => chunk.text).join(''), this.maxBytes);
  }
}

/** The last `maxBytes` of `text` in UTF-8, cut on a character boundary. */
export function lastBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const buffer = Buffer.from(text);
  let start = buffer.length - maxBytes;
  // Step past continuation bytes so the cut lands on the start of a character.
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString();
}

/**
 * The two raw tails as completion fields, redacted with the job's known
 * values and the generic patterns exactly as its events are, then cut back to
 * the cap because a `[REDACTED]` marker can be longer than what it replaced.
 * An empty tail is left off the result.
 */
function redactedRawTails(
  stdout: RollingTail,
  stderr: RollingTail,
  knownSecrets: string[],
): { rawStdoutTail?: string; rawStderrTail?: string } {
  const redact = (tail: RollingTail) =>
    lastBytes(redactSecrets(tail.text(), knownSecrets), tail.maxBytes);
  const rawStdoutTail = redact(stdout);
  const rawStderrTail = redact(stderr);
  return {
    ...(rawStdoutTail ? { rawStdoutTail } : {}),
    ...(rawStderrTail ? { rawStderrTail } : {}),
  };
}

export type CollectedProviderEvents = {
  events: ProviderEvent[];
  usage: TaskUsage;
  /** Set when a per-task limit was tripped; the reason is also the TASK_LIMIT event's message. */
  limitBreach?: string;
};

/**
 * Drain a provider run into a redacted, schema-checked event list while
 * holding it to the per-task limits (packages/guardrails/src/limits.ts).
 *
 * Usage is tallied on every event - a tool_request is one tool call, a usage
 * event adds its tokens, and wall clock is re-read each time - and checked
 * immediately. Tripping a limit pushes a synthetic non-retryable TASK_LIMIT
 * error *before* the provider is aborted, so it is the first error the
 * coordinator sees and the run fails for the limit rather than for the
 * provider's own "cancelled". A provider that has gone quiet emits nothing to
 * check against, so the wall-clock bound also has a timer. Exported with the
 * provider injectable so the abort path is testable with a scripted provider.
 */
export async function collectProviderEvents(
  provider: ProviderAdapter,
  request: ProviderRequest,
  options: {
    cwd: string;
    signal: AbortSignal;
    redactionValues: string[];
    limits?: TaskLimits;
    clock?: () => number;
  },
): Promise<CollectedProviderEvents> {
  const limits = options.limits ?? taskLimits;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const usage: TaskUsage = { toolCalls: 0, elapsedMinutes: 0, tokens: 0 };
  const events: ProviderEvent[] = [];
  const limiter = new AbortController();
  let breach: string | undefined;
  const trip = (reason: string) => {
    if (breach) return;
    breach = reason;
    events.push({ type: 'error', code: 'TASK_LIMIT', message: reason, retryable: false });
    limiter.abort(new Error(reason));
  };
  const check = () => {
    usage.elapsedMinutes = (clock() - started) / 60_000;
    const verdict = checkTaskLimits(usage, limits);
    if (!verdict.allowed) trip(verdict.reason);
  };
  // One millisecond past the bound, so the elapsed check is strictly over it.
  const wallClock = setTimeout(check, limits.maxWallClockMinutes * 60_000 + 1);
  wallClock.unref();
  try {
    const signal = AbortSignal.any([options.signal, limiter.signal]);
    for await (const event of provider.run(request, { cwd: options.cwd, signal })) {
      // Once tripped, whatever the provider yields on its way out (typically its
      // own cancellation error) is not recorded: the TASK_LIMIT event stands.
      if (breach) break;
      const serialized = redactSecrets(JSON.stringify(event), options.redactionValues);
      events.push(ProviderEventSchema.parse(JSON.parse(serialized)));
      if (Buffer.byteLength(JSON.stringify(events)) > MAX_EVENTS_BYTES) {
        throw new Error(
          `Provider result exceeded the ${MAX_EVENTS_BYTES} byte worker events limit`,
        );
      }
      if (event.type === 'tool_request') usage.toolCalls += 1;
      if (event.type === 'usage') usage.tokens += freshTokens(event);
      check();
      if (breach) break;
    }
  } finally {
    clearTimeout(wallClock);
  }
  return { events, usage, ...(breach ? { limitBreach: breach } : {}) };
}

type ProviderCredential = {
  kind: 'api-key' | 'auth-file';
  contentBase64: string;
  redactionValues: string[];
};

/** Where a provider's credential comes from; decided apart from reading it so it can be tested. */
export type CredentialSource =
  | { kind: 'api-key'; value: string }
  | { kind: 'auth-file'; path: string | undefined }
  | { kind: 'none'; reason: string };

/**
 * `claude` takes the API key and only the API key; `claude-sub` takes the subscription login file
 * and only that (ADR-041). One credential kind per id is what lets both lanes be advertised from the
 * same worker at once; before this, the key silently won over the file under the single id.
 * Codex keeps its earlier order: key, then auth file.
 */
export function credentialSourceFor(
  providerId: DockerProviderId,
  source: Pick<
    WorkerEnvironment,
    | 'ANTHROPIC_API_KEY'
    | 'OPENAI_API_KEY'
    | 'FORGE_CLAUDE_CREDENTIALS_FILE'
    | 'FORGE_CODEX_AUTH_FILE'
  >,
): CredentialSource {
  if (providerId === 'claude')
    return source.ANTHROPIC_API_KEY
      ? { kind: 'api-key', value: source.ANTHROPIC_API_KEY }
      : { kind: 'none', reason: 'No Claude API key is configured (ANTHROPIC_API_KEY)' };
  if (providerId === 'claude-sub')
    return { kind: 'auth-file', path: source.FORGE_CLAUDE_CREDENTIALS_FILE };
  return source.OPENAI_API_KEY
    ? { kind: 'api-key', value: source.OPENAI_API_KEY }
    : { kind: 'auth-file', path: source.FORGE_CODEX_AUTH_FILE };
}

async function resolveProviderCredential(
  providerId: DockerProviderId,
): Promise<ProviderCredential> {
  const source = credentialSourceFor(providerId, env);
  if (source.kind === 'none') throw new Error(source.reason);
  if (source.kind === 'api-key') return apiKeyCredential(source.value);
  return authFileCredential(providerId, source.path);
}

function apiKeyCredential(apiKey: string): ProviderCredential {
  return {
    kind: 'api-key',
    contentBase64: Buffer.from(apiKey).toString('base64'),
    redactionValues: [apiKey],
  };
}

async function authFileCredential(
  providerId: DockerProviderId,
  configuredPath: string | undefined,
): Promise<ProviderCredential> {
  if (!configuredPath) throw new Error(`No isolated ${providerId} credential is configured`);
  const path = resolve(configuredPath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 1_000_000)
    throw new Error(`${providerId} credential must be a regular file no larger than 1 MB`);
  const content = await readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new Error(`${providerId} credential file must contain a JSON object`);
  }
  return {
    kind: 'auth-file',
    contentBase64: content.toString('base64'),
    redactionValues: collectCredentialStrings(parsed),
  };
}

function collectCredentialStrings(value: unknown): string[] {
  const strings: string[] = [];
  const pending = [value];
  while (pending.length > 0 && strings.length < 256) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (item.length >= 8) strings.push(item);
    } else if (Array.isArray(item)) {
      for (const nested of item) pending.push(nested);
    } else if (item && typeof item === 'object') {
      for (const nested of Object.values(item)) pending.push(nested);
    }
  }
  return strings;
}

/** How the sandbox runner is driven: the raw output tee, and under test a process in place of `docker`. */
type SandboxRunnerOptions = { tee?: RawOutputTee; processRunner?: ProcessRunner };

function createDockerProviderAdapter(
  providerId: DockerProviderId,
  credential: ProviderCredential,
  sandbox: SandboxRunnerOptions = {},
): ProviderAdapter {
  const runner = createDockerProviderRunner(providerId, credential, sandbox);
  return providerId !== 'codex'
    ? // `claude-sub` runs the same CLI but is not billed, so its adapter records $0 (ADR-041).
      new ClaudeAdapter('claude', undefined, runner, {
        id: providerId,
        metered: providerId === 'claude',
      })
    : // The adapter assembles arguments for a CLI that will run in the container
      // this worker launches, not in this process, so it is handed that
      // container's environment - the one carrying the external-sandbox marker
      // (ADR-030). The Claude CLI needs no equivalent: it never nests a sandbox
      // of its own, and its permission mode is already set per role.
      new CodexAdapter('codex', undefined, runner, [], sandboxProviderEnvironment('codex', null));
}

/**
 * The environment every provider container gets. `FORGE_EXTERNALLY_SANDBOXED=1`
 * is the one marker that tells a CLI inside it that TheForge's Docker boundary -
 * non-root, read-only root filesystem, all capabilities dropped, workspace-only
 * mount - is already its sandbox, so it must not try to nest one of its own
 * (ADR-030). It is set here, by the code that launches the container, and
 * nowhere else; a process running on the host never sees it.
 */
function sandboxProviderEnvironment(
  providerId: DockerProviderId,
  anthropicWorkspaceId: string | null | undefined,
): Record<string, string> {
  return {
    HOME: '/home/node',
    [EXTERNAL_SANDBOX_MARKER]: '1',
    // The Claude CLI adds these headers to every API request. The workspace id is not a secret, so it
    // travels as a plain argument and the sandbox image's entrypoint needs no change (ADR-039).
    ...(providerId === 'claude' && anthropicWorkspaceId
      ? { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${anthropicWorkspaceId}` }
      : {}),
  };
}

function createDockerProviderRunner(
  providerId: DockerProviderId,
  credential: ProviderCredential,
  sandbox: SandboxRunnerOptions = {},
) {
  return async function* (options: JsonLineProcessOptions): AsyncGenerator<unknown> {
    if (options.signal?.aborted) {
      yield { type: 'cancelled' };
      return;
    }
    const workspace = await realpath(resolve(options.cwd));
    await assertRealWorkspaceContainment(workspace);
    if (workspace.includes(','))
      throw new Error('Docker sandbox workspace paths cannot contain commas');
    const containerName = providerContainerName(providerId);
    const providerArgs = [...options.args];
    const envelope: {
      kind: ProviderCredential['kind'];
      contentBase64: string;
      claudePromptBase64?: string;
      codexSchemaBase64?: string;
    } = {
      kind: credential.kind,
      contentBase64: credential.contentBase64,
    };
    if (cliFor(providerId) === 'claude') {
      const promptIndex = providerArgs.indexOf('-p');
      if (promptIndex >= 0) {
        const prompt = providerArgs[promptIndex + 1];
        if (prompt === undefined)
          throw new Error('Claude provider invocation is missing its prompt');
        envelope.claudePromptBase64 = Buffer.from(prompt).toString('base64');
        providerArgs.splice(promptIndex, 2);
      }
    } else {
      const cwdIndex = providerArgs.indexOf('--cd');
      if (cwdIndex >= 0) {
        if (providerArgs[cwdIndex + 1] === undefined)
          throw new Error('Codex provider invocation is missing its working directory');
        providerArgs[cwdIndex + 1] = '/workspace';
      }
      const schemaIndex = providerArgs.indexOf('--output-schema');
      if (schemaIndex >= 0) {
        const schemaPath = providerArgs[schemaIndex + 1];
        if (schemaPath === undefined)
          throw new Error('Codex provider invocation is missing its output schema');
        const schema = await readFile(schemaPath);
        if (schema.length > 1_000_000) throw new Error('Codex output schema exceeds 1 MB');
        envelope.codexSchemaBase64 = schema.toString('base64');
        providerArgs[schemaIndex + 1] = '/tmp/theforge-output-schema.json';
      }
    }
    const args = createProviderDockerRunArgs(providerId, workspace, containerName, providerArgs);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const stopper = spawn('docker', ['stop', '--time', '3', containerName], {
        shell: false,
        stdio: 'ignore',
        env: childEnvironment(),
      });
      stopper.once('error', () => undefined);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      yield* (sandbox.processRunner ?? jsonLineProcess)({
        command: 'docker',
        args,
        cwd: workspace,
        stdin: `${JSON.stringify(envelope)}\n${options.stdin ?? ''}`,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        env: childEnvironment(),
        ...sandbox.tee,
      });
    } finally {
      options.signal?.removeEventListener('abort', stop);
    }
  };
}

export function createProviderDockerRunArgs(
  providerId: DockerProviderId,
  workspace: string,
  containerName: string,
  providerArgs: string[],
  /** `null` means none; left out it is the worker's configured FORGE_ANTHROPIC_WORKSPACE_ID. */
  anthropicWorkspaceId: string | null | undefined = env.FORGE_ANTHROPIC_WORKSPACE_ID,
): string[] {
  return [
    ...dockerIsolationArgs(workspace, containerName, 'provider-api'),
    '--interactive',
    ...Object.entries(sandboxProviderEnvironment(providerId, anthropicWorkspaceId)).flatMap(
      ([name, value]) => ['--env', `${name}=${value}`],
    ),
    '--entrypoint',
    'theforge-provider-entrypoint',
    env.FORGE_SANDBOX_IMAGE,
    cliFor(providerId),
    ...providerArgs,
  ];
}

function providerContainerName(providerId: DockerProviderId): string {
  const safeWorkerId = worker.id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 20);
  return `theforge-${safeWorkerId}-${providerId}-${randomUUID().slice(0, 8)}`;
}

type ProviderDiagnosis = { ok: boolean; fault?: string; note?: string };

async function diagnoseDockerProvider(providerId: DockerProviderId): Promise<ProviderDiagnosis> {
  const credential = await resolveProviderCredential(providerId);
  const root = resolve(env.FORGE_WORKSPACE_ROOT);
  await mkdir(root, { recursive: true });
  const runner = createDockerProviderRunner(providerId, credential);
  const signal = AbortSignal.timeout(30_000);
  const commands =
    credential.kind === 'api-key'
      ? [['--version']]
      : cliFor(providerId) === 'claude'
        ? [['--version'], ['auth', 'status']]
        : [['--version'], ['login', 'status']];
  for (const args of commands) {
    for await (const event of runner({ command: providerId, args, cwd: root, signal })) {
      // A zero exit status is the diagnostic; human-readable output is intentionally ignored.
      void event;
    }
    if (signal.aborted) return { ok: false };
  }
  // A key that is merely present proves nothing (ADR-038): ask the API once. Claude only; the
  // OpenAI key reaches Codex, whose own login check above is the existing proof.
  if (providerId === 'claude' && credential.kind === 'api-key' && env.ANTHROPIC_API_KEY) {
    const verdict = keyProbeVerdict(
      await probeAnthropicKey(env.ANTHROPIC_API_KEY, {
        ...(env.FORGE_ANTHROPIC_WORKSPACE_ID
          ? { workspaceId: env.FORGE_ANTHROPIC_WORKSPACE_ID }
          : {}),
      }),
    );
    return {
      ok: verdict.advertise,
      note: verdict.log,
      ...(verdict.fault ? { fault: verdict.fault } : {}),
    };
  }
  return { ok: true };
}

async function createProviderForJob(
  providerId: ProviderId,
  request: ProviderRequest,
  options: ProviderJobOptions & { tee?: RawOutputTee },
): Promise<{ provider: ProviderAdapter; redactionValues: string[] }> {
  if (providerId === 'ollama') {
    const numCtx = request.model === undefined ? undefined : ollamaContextFor(request.model);
    return {
      provider: new OllamaAdapter({
        baseUrl: options.ollamaUrl ?? env.FORGE_OLLAMA_URL,
        ...(numCtx === undefined ? {} : { numCtx }),
      }),
      redactionValues: [],
    };
  }
  const credential = await resolveProviderCredential(providerId);
  return {
    provider: createDockerProviderAdapter(providerId, credential, options),
    redactionValues: credential.redactionValues,
  };
}

/**
 * The measured `num_ctx` for a tier's model (env.ts, ADR-018 as amended);
 * any other model takes the server default.
 */
export function ollamaContextFor(model: string): number | undefined {
  if (model === TIER_MODELS[1]) return env.FORGE_OLLAMA_NUM_CTX_TIER1;
  if (model === TIER_MODELS[2]) return env.FORGE_OLLAMA_NUM_CTX_TIER2;
  return undefined;
}

/**
 * What this worker advertises for local models: `provider:ollama` and one
 * `model:<name>` per model the server lists, so an ollama job that names a
 * model is only leased where that model exists. Never throws; an absent
 * server is one log line and no capability.
 */
export async function probeOllamaCapabilities(
  baseUrl: string,
  timeoutMs = 5_000,
): Promise<{ capabilities: string[]; detail: string }> {
  try {
    const names = (await listModels(baseUrl, fetch, timeoutMs)).map((model) => model.name);
    return {
      capabilities: ['provider:ollama', ...names.map((name) => `model:${name}`)],
      detail: `ollama: advertising ${names.length} model(s) from ${baseUrl}: ${names.join(', ') || 'none'}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      capabilities: [],
      detail: `ollama: not reachable at ${baseUrl} (${reason}); provider:ollama not advertised`,
    };
  }
}

export async function materializeWorkerWorkspace(
  snapshot: WorkerWorkspaceSnapshot,
  jobId: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw signal.reason ?? new Error('Workspace materialization cancelled');
  const files = validateWorkerWorkspaceSnapshot(snapshot);
  const root = resolve(env.FORGE_WORKSPACE_ROOT);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  if (!safeJobId) throw new Error('Worker job id cannot name a workspace');
  const target = resolve(realRoot, `.job-${safeJobId}`);
  assertContainedPath(realRoot, target, 'worker job workspace');
  await rm(target, { recursive: true, force: true });
  try {
    // `-c` on the clone writes these into the new repository's own config, so
    // the checkout below, the patch apply, the host's later attempt-patch
    // capture, and anything the container's git does all agree.
    //
    // Without them the host's `core.autocrlf` decides, and on Windows it is
    // true by default: the tree is checked out CRLF while the blobs are LF. The
    // host's git normalises that back and reports a clean tree, so it is
    // invisible from outside - but the workspace is bind-mounted into a Linux
    // container, and the git in there has no such setting. On 05/10/2026 it
    // reported `119 files changed, 28191 insertions(+), 28191 deletions(-)` on
    // an untouched checkout of PulseApp: every tracked text file, entirely,
    // with identical content.
    //
    // That is not cosmetic. Every agent that looks at the workspace with git
    // sees the whole repository as rewritten. On attempt fourteen the reviewer
    // correctly reported `src/lib/auth.ts` as modified against an explicit
    // constraint not to touch it, the repair builder could not fix something no
    // agent had done, and the run spent three rounds on it and blocked.
    //
    // LF unconditionally, because the consumers are Linux containers and git
    // blobs, and both are LF. On a Linux host this changes nothing.
    await gitWithInput(
      [
        'clone',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.eol=lf',
        '--no-checkout',
        '--',
        snapshot.repositoryUrl,
        target,
      ],
      realRoot,
      '',
      signal,
    );
    await gitWithInput(['checkout', '--detach', snapshot.revision], target, '', signal);
    const checkedOut = await capture('git', ['rev-parse', 'HEAD'], target);
    if (checkedOut.code !== 0 || checkedOut.stdout.trim().toLowerCase() !== snapshot.revision)
      throw new Error('Worker repository did not resolve to the requested exact revision');
    if (snapshot.patch.trim())
      await gitWithInput(
        ['apply', '--binary', '--whitespace=nowarn', '-'],
        target,
        snapshot.patch,
        signal,
      );
    for (const file of files) {
      const destination = resolve(target, ...file.path.split('/'));
      assertContainedPath(target, destination, 'untracked workspace file');
      const existing = await lstat(destination).catch(() => undefined);
      if (existing) throw new Error(`Untracked workspace file already exists: ${file.path}`);
      await mkdir(dirname(destination), { recursive: true });
      const parent = await realpath(dirname(destination));
      assertContainedPath(target, parent, 'untracked workspace parent');
      await writeFile(destination, file.content);
      if (file.executable) await chmod(destination, 0o755);
    }
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

function validateWorkerWorkspaceSnapshot(
  snapshot: WorkerWorkspaceSnapshot,
): Array<{ path: string; content: Buffer; executable: boolean }> {
  if (
    !snapshot ||
    typeof snapshot.repositoryUrl !== 'string' ||
    !isAllowedRepositoryUrl(snapshot.repositoryUrl) ||
    !/^[a-f0-9]{40,64}$/i.test(snapshot.revision) ||
    typeof snapshot.patch !== 'string' ||
    Buffer.byteLength(snapshot.patch) > 8_000_000 ||
    !Array.isArray(snapshot.untrackedFiles) ||
    snapshot.untrackedFiles.length > 128
  )
    throw new Error('Invalid worker workspace snapshot');
  let totalBytes = 0;
  const seen = new Set<string>();
  return snapshot.untrackedFiles.map((file) => {
    validateWorkerWorkspacePath(file.path, false);
    if (seen.has(file.path)) throw new Error(`Duplicate untracked workspace file: ${file.path}`);
    seen.add(file.path);
    if (typeof file.contentBase64 !== 'string' || typeof file.executable !== 'boolean')
      throw new Error('Invalid untracked workspace file');
    const content = decodeBase64(file.contentBase64);
    if (content.length > 1_000_000)
      throw new Error(`Untracked workspace file exceeds the 1 MB limit: ${file.path}`);
    totalBytes += content.length;
    if (totalBytes > 4_000_000) throw new Error('Untracked workspace files exceed the 4 MB limit');
    return { path: file.path, content, executable: file.executable };
  });
}

async function resolveMaterializedWorkingDirectory(root: string, path: string): Promise<string> {
  validateWorkerWorkspacePath(path, true);
  const resolved = path === '.' ? root : resolve(root, ...path.split('/'));
  const real = await realpath(resolved);
  assertContainedPath(root, real, 'worker action working directory');
  return real;
}

function validateWorkerWorkspacePath(path: string, allowRoot: boolean): void {
  if (allowRoot && path === '.') return;
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 512 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid worker workspace path: ${String(path)}`);
}

function assertContainedPath(root: string, candidate: string, label: string): void {
  const difference = relative(resolve(root), resolve(candidate));
  if (
    difference === '..' ||
    difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(difference)
  )
    throw new Error(`${label} escapes the managed worker root`);
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Invalid untracked workspace base64 content');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value)
    throw new Error('Invalid untracked workspace base64 content');
  return decoded;
}

function isAllowedRepositoryUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048 || value.includes('\0')) return false;
  if (loopbackCoordinator && isAbsolute(value)) return true;
  if (/^[^@\s]+@[^:\s]+:[^\s]+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'ssh:';
  } catch {
    return false;
  }
}

export class PatchTooLargeError extends Error {
  constructor(bytes: number) {
    super(`builder patch too large (${bytes} bytes > ${MAX_PATCH_BYTES}); refusing to transport`);
  }
}

export async function captureAttemptPatch(workspace: string, signal: AbortSignal): Promise<string> {
  const intent = await capture('git', ['add', '--intent-to-add', '--all'], workspace);
  if (intent.code !== 0) throw new Error(`Could not prepare attempt patch: ${intent.stderr}`);
  const patch = await capture('git', ['diff', '--binary', 'HEAD'], workspace);
  if (signal.aborted) throw signal.reason;
  if (patch.code !== 0) throw new Error(`Could not capture attempt patch: ${patch.stderr}`);
  const bytes = Buffer.byteLength(patch.stdout);
  if (bytes > MAX_PATCH_BYTES) throw new PatchTooLargeError(bytes);
  return patch.stdout;
}

type WorkerJobResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Per-step outcomes of a stepped job; see executeCommandSteps. */
  steps?: Array<{ command: string; code: number; stdout: string; stderr: string }>;
  events?: ProviderEvent[];
  patch?: string;
  /** Where a failed or cancelled job's workspace was kept; see retainFailedWorkspace. */
  retainedWorkspace?: string;
  rawStdoutTail?: string;
  rawStderrTail?: string;
};

/**
 * Turn a result the worker cannot deliver into one it can: drop the patch and
 * the raw output tails, fail the exit code, and explain in stderr. A provider
 * job is reported to its run through its events alone, so the explanation is
 * also appended as an `error` event; a non-zero code by itself would leave the
 * run believing the builder finished.
 */
export function failedJobResult(
  result: WorkerJobResult & { events: ProviderEvent[] },
  code: string,
  message: string,
): WorkerJobResult & { events: ProviderEvent[] };
export function failedJobResult(
  result: WorkerJobResult,
  code: string,
  message: string,
): WorkerJobResult;
export function failedJobResult(
  result: WorkerJobResult,
  code: string,
  message: string,
): WorkerJobResult {
  return {
    code: result.code || 1,
    stdout: result.stdout,
    stderr: [result.stderr, message].filter(Boolean).join('\n'),
    ...(result.events
      ? { events: [...result.events, { type: 'error' as const, code, message, retryable: false }] }
      : {}),
    ...(result.retainedWorkspace ? { retainedWorkspace: result.retainedWorkspace } : {}),
  };
}

/**
 * Deliver a job result, and if the coordinator refuses it, deliver a failure
 * in its place. A refused completion used to be logged and dropped, so the
 * lease expired and the same job was re-leased and re-run indefinitely with
 * no event ever reaching the run. The retry is accepted because validation
 * happens before the lease is consumed, and the lease outlives the last
 * heartbeat by FORGE_JOB_LEASE_MS.
 */
export async function submitJobCompletion(
  post: (body: string) => Promise<unknown>,
  jobId: string,
  leaseToken: string,
  result: WorkerJobResult,
): Promise<void> {
  let body = JSON.stringify({ leaseToken, ...result });
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_COMPLETION_BODY_BYTES) {
    result = failedJobResult(
      result,
      'COMPLETION_TOO_LARGE',
      `worker completion too large (${bytes} bytes > ${MAX_COMPLETION_BODY_BYTES}); refusing to transport`,
    );
    body = JSON.stringify({ leaseToken, ...result });
  }
  try {
    await post(body);
    return;
  } catch (error) {
    console.error(`Worker completion fence rejected for ${jobId}:`, error);
    if (!(error instanceof CoordinatorRequestError) || ![400, 413].includes(error.status)) return;
    const rejected = failedJobResult(
      result,
      'COMPLETION_REJECTED',
      `coordinator rejected the completion (${error.status}): ${error.body || 'no response body'}`,
    );
    await post(JSON.stringify({ leaseToken, ...rejected })).catch((retryError: unknown) => {
      console.error(`Worker completion retry rejected for ${jobId}:`, retryError);
    });
  }
}

async function gitWithInput(
  args: string[],
  cwd: string,
  input: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('Git operation cancelled');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const abort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args[0] ?? ''} failed (${code ?? -1}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}
async function runWorkerMain(): Promise<void> {
  const controller = new AbortController();
  const shutdown = (signalName: 'SIGINT' | 'SIGTERM') => {
    if (controller.signal.aborted) return;
    console.log(`TheForge worker ${worker.id} received ${signalName}; shutting down`);
    controller.abort(new Error(`Worker received ${signalName}`));
  };
  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const daemon = await startWorker(controller.signal);
    console.log(`TheForge worker ${worker.id} online`);
    await daemon.stopped;
    console.log(`TheForge worker ${worker.id} stopped`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void runWorkerMain().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
