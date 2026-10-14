import { spawn } from 'node:child_process';
import { access, constants, open, readdir, readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { checkHalt, readHaltFile, writeHaltFile, type HaltFile } from '@theforge/guardrails';
import { parseArgs, type Command, type CommandContext } from '../command.js';
import { haltFilePath } from '../halt-file.js';
import { fetchJson, field } from './status.js';

/**
 * `forge runtime`: the coordinator, the worker and the web control centre as
 * Windows scheduled tasks.
 *
 * Task Scheduler is only reachable through PowerShell, so every question and
 * order goes through a small script run by an injectable `PwshRunner`; the
 * scripts print one JSON document each and this file parses it. The test
 * suite replaces the runner with a fake and never touches Task Scheduler, and
 * one test runs the real runner against a task name that does not exist to
 * prove the parsing path end to end. Registration itself is
 * scripts/runtime/register-runtime.ps1, deliberately not a subcommand.
 */

export type ProcessResult = { code: number | null; stdout: string; stderr: string };
/** Runs the text of a PowerShell script and returns what it printed. */
export type PwshRunner = (script: string) => Promise<ProcessResult>;
/** Runs an executable; `shell` is for `.cmd` shims such as corepack on Windows. */
export type ExecRunner = (
  file: string,
  args: string[],
  options?: { shell?: boolean },
) => Promise<ProcessResult>;
/** Whether something is listening on host:port. */
export type PortProbe = (host: string, port: number) => Promise<'open' | 'closed'>;

export type App = 'coordinator' | 'worker' | 'web';
/**
 * Every task, in start order; stopping walks it backwards, so the web control
 * centre (the front door) goes down first and comes back up last. Adding an app
 * here is all `status`, `start`, `stop` and the doctor's build check need.
 */
export const APPS: readonly App[] = ['coordinator', 'worker', 'web'];
export const DEFAULT_TASK_NAMES: Readonly<Record<App, string>> = {
  coordinator: 'TheForge Coordinator',
  worker: 'TheForge Worker',
  web: 'TheForge Web',
};
/**
 * Every TheForge task worth watching for silent failure, which is a longer list than
 * `DEFAULT_TASK_NAMES`: that one is the three supervised services this command
 * starts and stops, while these also include the periodic jobs. The periodic ones are
 * the ones that failed unnoticed (BLK-025), because nothing restarts them and nothing
 * was reading their result.
 *
 * The names match the registration scripts: `scripts/runtime/register-runtime.ps1`,
 * `scripts/register-node-watch.ps1`, `scripts/register-ci-watch.ps1` and
 * `scripts/register-digests.ps1`. The last three register under `-TaskPath '\TheForge\'`
 * while `taskStatusScript` passes no path; `Get-ScheduledTask -TaskName` searches all
 * folders, so this works, and a test pins that assumption.
 *
 * Deliberately only TheForge's own tasks. Other projects' tasks on this machine matter
 * too - the hourly backup most of all - but naming them here would hardcode another
 * project into this repository, so `FORGE_WATCH_TASKS` adds them from `.env` instead.
 */
export const DEFAULT_WATCHED_TASKS: readonly string[] = [
  'TheForge Coordinator',
  'TheForge Worker',
  'TheForge Web',
  'TheForge Node Watch',
  'TheForge CI Watch',
  'TheForge Digest Morning',
  'TheForge Digest Evening',
];

/**
 * The tasks to watch. `FORGE_WATCH_TASKS` is a comma-separated list; a leading `+`
 * adds to the defaults instead of replacing them, which is the common case - an
 * operator wants the defaults plus their own backup tasks, not a list they must keep
 * in step with this file by hand.
 */
export function watchedTaskNames(env: Record<string, string | undefined>): readonly string[] {
  const raw = env.FORGE_WATCH_TASKS?.trim();
  if (!raw) return DEFAULT_WATCHED_TASKS;
  const additive = raw.startsWith('+');
  const given = (additive ? raw.slice(1) : raw)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (given.length === 0) return DEFAULT_WATCHED_TASKS;
  const all = additive ? [...DEFAULT_WATCHED_TASKS, ...given] : given;
  return [...new Set(all)];
}

/**
 * Reads the health of the named tasks. **Never throws** - every failure comes back as
 * the `error` field, because the caller is the digest and a broken task monitor must
 * not break the report that would have told anyone about it.
 */
export async function readTaskHealth(
  pwsh: PwshRunner,
  names: readonly string[],
): Promise<TaskHealth> {
  if (names.length === 0) return { names, rows: [] };
  let result: ProcessResult;
  try {
    result = await pwsh(taskStatusScript(names));
  } catch (error) {
    return { names, rows: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? '';
    return {
      names,
      rows: [],
      error: `PowerShell exited ${result.code ?? 'without a code'}${detail ? `: ${detail}` : ''}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return {
      names,
      rows: [],
      error: `PowerShell printed no JSON: ${result.stdout.trim().slice(0, 200) || '(nothing)'}`,
    };
  }
  return parseTaskHealth(parsed, names);
}

export const DEFAULT_LOG_DIR = 'C:\\forge\\logs';
/** The loopback address and port run-web.ps1 also defaults to. */
export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 3000;
/**
 * What `corepack pnpm build` must have left behind before a task can start. The
 * web app's is a directory - `next build` writes apps/web/.next - and the other
 * two are one bundled file each, which is why the kind travels with the path.
 */
const BUILD: Readonly<Record<App, { path: string; kind: 'file' | 'directory' }>> = {
  coordinator: { path: join('apps', 'coordinator', 'dist', 'server.js'), kind: 'file' },
  worker: { path: join('apps', 'worker', 'dist', 'index.js'), kind: 'file' },
  web: { path: join('apps', 'web', '.next'), kind: 'directory' },
};

export type TaskStatus =
  | { app: App; name: string; registered: false }
  | {
      app: App;
      name: string;
      registered: true;
      state: string;
      enabled: boolean;
      lastRunTime: string | null;
      nextRunTime: string | null;
      lastTaskResult: number;
      missedRuns: number;
    };

export type TaskOrder = { app: App; name: string; ok: boolean; state?: string; error?: string };

export type DoctorCheck = { name: string; run(): Promise<{ ok: boolean; detail: string }> };

export type RuntimeOptions = {
  pwsh?: PwshRunner;
  exec?: ExecRunner;
  probePort?: PortProbe;
  taskNames?: Readonly<Record<App, string>>;
  /** Replaces the default doctor checks entirely (tests). */
  doctorChecks?: (ctx: CommandContext) => readonly DoctorCheck[];
};

// --- process runners --------------------------------------------------------

function runProcess(
  file: string,
  args: string[],
  options: { shell?: boolean; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

// With a shell, node only concatenates the arguments (DEP0190), so the
// command is handed over already joined; callers pass plain words only.
export const defaultExec: ExecRunner = (file, args, options) =>
  options?.shell
    ? runProcess([file, ...args].join(' '), [], { shell: true })
    : runProcess(file, args);

/**
 * `-EncodedCommand` carries the script as base64 UTF-16LE, so no quoting rule
 * of cmd.exe or pwsh can touch it. FORGE_PWSH names the executable when
 * `pwsh` is not on PATH.
 */
export const createPwshRunner =
  (env: Record<string, string | undefined>): PwshRunner =>
  (script) =>
    runProcess(env.FORGE_PWSH || 'pwsh', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);

export const defaultProbePort: PortProbe = (host, port) =>
  new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const finish = (verdict: 'open' | 'closed') => {
      socket.destroy();
      resolvePromise(verdict);
    };
    socket.setTimeout(1_500, () => finish('closed'));
    socket.once('connect', () => finish('open'));
    socket.once('error', () => finish('closed'));
  });

// --- PowerShell scripts -----------------------------------------------------

const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** One row per task; a task that is not registered is a row too, never an error. */
export function taskStatusScript(names: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = foreach ($name in @(${names.map(psString).join(', ')})) {`,
    '  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '  if (-not $task) { [pscustomobject]@{ name = $name; registered = $false }; continue }',
    // The task object is PIPED into Get-ScheduledTaskInfo rather than looked up by name
    // again, because `Get-ScheduledTaskInfo -TaskName` resolves only tasks in the root
    // folder: for one registered under -TaskPath '\TheForge\' it fails with "The system
    // cannot find the file specified", and with $ErrorActionPreference = 'Stop' that
    // killed the whole script. Get-ScheduledTask -TaskName does find a task in any
    // folder, so piping the object - which carries its TaskPath - works for both.
    // Measured 04/10/2026: the watch and digest tasks live in \TheForge\, so before this
    // they could not be read at all.
    '  $info = $task | Get-ScheduledTaskInfo',
    // Task Scheduler reports "never" as a date in 1999.
    "  $stamp = { param($value) if ($value -is [datetime] -and $value.Year -ge 2000) { $value.ToString('o') } else { $null } }",
    '  [pscustomobject]@{',
    '    name = $name; registered = $true; state = [string]$task.State; enabled = [bool]$task.Settings.Enabled',
    '    lastRunTime = & $stamp $info.LastRunTime; nextRunTime = & $stamp $info.NextRunTime',
    '    lastTaskResult = [int64]$info.LastTaskResult; missedRuns = [int]$info.NumberOfMissedRuns',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($rows) -Compress -Depth 3',
  ].join('\n');
}

export function taskOrderScript(verb: 'Start' | 'Stop', name: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$name = ${psString(name)}`,
    '$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    "if (-not $task) { ConvertTo-Json -Compress -InputObject @{ name = $name; ok = $false; error = 'not registered' }; exit 0 }",
    'try {',
    `  ${verb}-ScheduledTask -TaskName $name`,
    '  Start-Sleep -Milliseconds 500',
    '  ConvertTo-Json -Compress -InputObject @{ name = $name; ok = $true; state = [string](Get-ScheduledTask -TaskName $name).State }',
    '} catch {',
    '  ConvertTo-Json -Compress -InputObject @{ name = $name; ok = $false; error = $_.Exception.Message }',
    '}',
  ].join('\n');
}

// --- parsing what PowerShell printed ---------------------------------------

class PwshOutputError extends Error {}

function parseJsonOutput(result: ProcessResult, what: string): unknown {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? '';
    throw new PwshOutputError(
      `PowerShell exited ${result.code ?? 'without a code'} while ${what}${detail ? `: ${detail}` : ''}`,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new PwshOutputError(
      `PowerShell printed no JSON while ${what}: ${result.stdout.trim().slice(0, 200) || '(nothing)'}`,
    );
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function parseTaskStatus(
  output: unknown,
  names: Readonly<Record<App, string>>,
): TaskStatus[] {
  if (!Array.isArray(output)) throw new PwshOutputError('task status is not a JSON array');
  const rows = output.map(record);
  return APPS.map((app) => {
    const name = names[app];
    const row = rows.find((candidate) => candidate?.name === name);
    if (!row) throw new PwshOutputError(`task status has no row for ${name}`);
    if (row.registered !== true) return { app, name, registered: false };
    const text = (key: string): string | null => {
      const value = row[key];
      return typeof value === 'string' ? value : null;
    };
    return {
      app,
      name,
      registered: true,
      state: text('state') ?? 'Unknown',
      enabled: row.enabled !== false,
      lastRunTime: text('lastRunTime'),
      nextRunTime: text('nextRunTime'),
      lastTaskResult: typeof row.lastTaskResult === 'number' ? row.lastTaskResult : -1,
      missedRuns: typeof row.missedRuns === 'number' ? row.missedRuns : 0,
    };
  });
}

/**
 * A scheduled task identified by name alone. `TaskStatus` carries an `app` from the
 * three-app union, so it cannot describe `TheForge Node Watch`, `TheForge CI Watch`
 * or the digest tasks - which are precisely the ones that failed unnoticed in
 * BLK-025. `TaskStatus` is structurally assignable to this, so the predicates above
 * accept either.
 */
export type TaskHealthRow =
  | { name: string; registered: false }
  | {
      name: string;
      registered: true;
      state: string;
      enabled: boolean;
      lastRunTime: string | null;
      nextRunTime: string | null;
      lastTaskResult: number;
      missedRuns: number;
    };

export type TaskHealth = {
  /** The names asked about, in the order given. */
  names: readonly string[];
  rows: TaskHealthRow[];
  /** Set when the query or the parse failed; the digest reports it and carries on. */
  error?: string;
};

/**
 * Parses `taskStatusScript`'s JSON leniently, for a reader that must never throw.
 *
 * `parseTaskStatus` above cannot be reused here: it iterates the three `APPS` and
 * throws when a row is missing, which is right for `runtime status` (an operator ran
 * it and wants to know) and wrong for the digest, where one unreadable field must
 * not cost the whole report. A missing row becomes `registered: false`, exactly as
 * the PowerShell already does for a task Task Scheduler does not have.
 */
export function parseTaskHealth(output: unknown, names: readonly string[]): TaskHealth {
  if (!Array.isArray(output)) {
    return { names, rows: [], error: 'task status was not a JSON array' };
  }
  const rows = output.map(record);
  return {
    names,
    rows: names.map((name): TaskHealthRow => {
      const row = rows.find((candidate) => candidate?.name === name);
      if (!row || row.registered !== true) return { name, registered: false };
      const text = (key: string): string | null => {
        const value = row[key];
        return typeof value === 'string' ? value : null;
      };
      return {
        name,
        registered: true,
        state: text('state') ?? 'Unknown',
        enabled: row.enabled !== false,
        lastRunTime: text('lastRunTime'),
        nextRunTime: text('nextRunTime'),
        // -1 is not a real Task Scheduler code, so an unreadable field shows as a
        // failure rather than silently passing as success.
        lastTaskResult: typeof row.lastTaskResult === 'number' ? row.lastTaskResult : -1,
        missedRuns: typeof row.missedRuns === 'number' ? row.missedRuns : 0,
      };
    }),
  };
}

function parseTaskOrder(output: unknown, app: App, name: string): TaskOrder {
  const row = record(output);
  if (!row) throw new PwshOutputError(`no result for ${name}`);
  return {
    app,
    name,
    ok: row.ok === true,
    ...(typeof row.state === 'string' ? { state: row.state } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  };
}

/** Task Scheduler's "Last Run Result", the few codes an operator meets. */
export function describeTaskResult(code: number): string {
  const known: Record<number, string> = {
    0: 'success',
    3: 'runner pre-flight failed: no .env, no build or no node; see the log',
    4: 'runner gave up waiting for Docker',
    0x41300: 'ready',
    0x41301: 'running',
    0x41302: 'disabled',
    0x41303: 'has not run yet',
    0x41304: 'no more runs scheduled',
    0x41306: 'terminated by the user',
    // Both of these are the normal, healthy signal once the watchdog trigger of
    // BLK-017 is registered: it re-fires every minute, and MultipleInstances
    // IgnoreNew refuses the repeat while the process is alive. An operator who
    // reads them as failures would chase nothing, so they say so plainly.
    0x8004131f: 'watchdog repeat ignored, the task is already running (healthy)',
    0x800710e0: 'watchdog repeat refused, the task is already running (healthy)',
  };
  const shown =
    code < 0 ? '?' : code >= 0x10000 ? `0x${code.toString(16).toUpperCase()}` : `${code}`;
  const meaning = known[code] ?? (code > 0 && code < 0x10000 ? `exit ${code}` : 'unknown');
  return `${shown} (${meaning})`;
}

/**
 * The "Last Run Result" codes that are NOT a failure. Named as a set rather than
 * inferred from `describeTaskResult`'s wording, because a decision must not depend
 * on prose someone may reword.
 *
 * The two watchdog codes are the point of this set. Once the BLK-017 trigger is
 * registered it re-fires every minute and `MultipleInstances IgnoreNew` refuses the
 * repeat, so a HEALTHY coordinator, worker or web task reports 0x800710E0 or
 * 0x8004131F permanently. Anything that treated those as failures would raise an
 * alarm on every digest forever, which is worse than raising none: it teaches the
 * operator to ignore the channel.
 *
 * `disabled` and `terminated by the user` are here deliberately too. Neither is a
 * failure - both are something an operator chose, and `pnpm forge runtime stop`
 * produces the second. A task being disabled is still worth surfacing, but that is
 * the `enabled` field's job, not this one.
 */
export const HEALTHY_TASK_RESULTS: ReadonlySet<number> = new Set([
  0, // success
  0x41300, // ready
  0x41301, // running
  0x41302, // disabled - deliberate, see `enabled`
  0x41303, // has not run yet, e.g. freshly registered
  0x41304, // no more runs scheduled
  0x41306, // terminated by the user, e.g. `runtime stop`
  0x8004131f, // watchdog repeat ignored (healthy)
  0x800710e0, // watchdog repeat refused (healthy)
]);

/** Whether a task's last result means it failed. Unknown codes count as failures. */
export function isTaskResultHealthy(code: number): boolean {
  return HEALTHY_TASK_RESULTS.has(code);
}

/**
 * Whether a task wants an operator's attention, which is a broader question than
 * whether its last result was a failure: a task that is absent or switched off is
 * not failing, but it is also not doing its job. BLK-025 is the case this exists
 * for - `TheForge Node Watch` sat at 0x1 for days and nothing said so.
 */
export function taskNeedsAttention(task: TaskHealthRow): boolean {
  if (!task.registered) return true;
  if (!task.enabled) return true;
  return !isTaskResultHealthy(task.lastTaskResult);
}

/** One line of plain English for why a task wants attention, or null if it does not. */
export function taskAttentionReason(task: TaskHealthRow): string | null {
  if (!task.registered) return 'not registered';
  if (!task.enabled) return 'disabled';
  if (!isTaskResultHealthy(task.lastTaskResult))
    return `last result ${describeTaskResult(task.lastTaskResult)}`;
  return null;
}

// --- halt file, coordinator, logs ------------------------------------------

type HaltStatus = { halted: boolean; path: string; exists: boolean; request?: HaltFile['request'] };

async function haltStatus(env: Record<string, string | undefined>): Promise<HaltStatus> {
  const path = haltFilePath(env);
  const file = await readHaltFile(path);
  return {
    halted: checkHalt({ fileExists: file.exists }).halted,
    path,
    exists: file.exists,
    ...(file.request ? { request: file.request } : {}),
  };
}

function haltLines(halt: HaltStatus): string[] {
  const lines = [
    `halted: ${halt.halted ? 'yes' : 'no'}`,
    `halt file: ${halt.path}${halt.exists ? '' : ' (absent)'}`,
  ];
  if (halt.request) {
    lines.push(`requested: ${halt.request.requestedAt} by ${halt.request.requestedBy}`);
    if (halt.request.reason) lines.push(`reason: ${halt.request.reason}`);
  }
  return lines;
}

type CoordinatorStatus =
  | { queried: false }
  | { queried: true; reachable: false; url: string; error: string }
  | {
      queried: true;
      reachable: true;
      url: string;
      health: string;
      halted?: boolean;
      source?: string;
      haltFile?: string;
      haltError?: string;
    };

/** The same two requests `forge status` makes, as data rather than lines. */
async function coordinatorStatus(ctx: CommandContext): Promise<CoordinatorStatus> {
  const apiUrl = ctx.env.FORGE_API_URL;
  const token = ctx.env.FORGE_COORDINATOR_TOKEN;
  if (!apiUrl || !token) return { queried: false };
  const url = apiUrl.replace(/\/+$/, '');
  const health = await fetchJson(ctx, `${url}/health`);
  if (!health.ok) return { queried: true, reachable: false, url, error: health.error };
  const status = field(health.body, 'status');
  const result: CoordinatorStatus = {
    queried: true,
    reachable: true,
    url,
    health: typeof status === 'string' ? status : `HTTP ${health.status}`,
  };
  const halt = await fetchJson(ctx, `${url}/api/halt`, { authorization: `Bearer ${token}` });
  if (!halt.ok) return { ...result, haltError: halt.error };
  if (halt.status !== 200) return { ...result, haltError: `HTTP ${halt.status}` };
  const source = field(halt.body, 'source');
  const remote = field(halt.body, 'haltFile');
  return {
    ...result,
    halted: field(halt.body, 'halted') === true,
    ...(typeof source === 'string' ? { source } : {}),
    ...(typeof remote === 'string' ? { haltFile: remote } : {}),
  };
}

function coordinatorLines(status: CoordinatorStatus): string[] {
  if (!status.queried) {
    return [
      'coordinator: not queried (set FORGE_API_URL and FORGE_COORDINATOR_TOKEN to include it)',
    ];
  }
  if (!status.reachable) return [`coordinator: unreachable at ${status.url} (${status.error})`];
  const lines = [`coordinator health: ${status.health}`];
  if (status.haltError) lines.push(`coordinator halt: unreachable (${status.haltError})`);
  else if (status.halted !== undefined) {
    lines.push(
      `coordinator halted: ${status.halted ? 'yes' : 'no'}${status.halted && status.source ? ` (source: ${status.source})` : ''}`,
    );
  }
  if (status.haltFile) lines.push(`coordinator halt file: ${status.haltFile}`);
  return lines;
}

export const logDirectory = (env: Record<string, string | undefined>): string =>
  env.FORGE_LOG_DIR || DEFAULT_LOG_DIR;

const logFilePattern = (app: App) => new RegExp(`^${app}-\\d{8}\\.log$`);

/** The last non-empty line of the newest `<app>-<yyyyMMdd>.log`, if any. */
export async function newestLogLine(
  logDir: string,
  app: App,
): Promise<{ file: string; line: string } | null> {
  let names: string[];
  try {
    names = await readdir(logDir);
  } catch {
    return null;
  }
  const newest = names
    .filter((name) => logFilePattern(app).test(name))
    .sort()
    .at(-1);
  if (!newest) return null;
  const file = join(logDir, newest);
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const line =
      buffer
        .toString('utf8')
        .split(/\r?\n/)
        .filter((candidate) => candidate.trim() !== '')
        .at(-1) ?? '';
    return { file, line };
  } finally {
    await handle.close();
  }
}

// --- doctor -----------------------------------------------------------------

const exists = async (path: string, kind: 'file' | 'directory'): Promise<boolean> => {
  try {
    const info = await stat(path);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
};

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? '';

const failed = (result: ProcessResult, fallback: string): string =>
  firstLine(result.stderr) || firstLine(result.stdout) || fallback;

export function repoRoot(env: Record<string, string | undefined>): string {
  return resolve(env.FORGE_REPO_ROOT || process.cwd());
}

/**
 * The pre-flight before registration: one line each, FAIL on anything that
 * would make a scheduled task start and die. Everything here is read-only.
 */
export function defaultDoctorChecks(
  ctx: CommandContext,
  options: { exec?: ExecRunner; probePort?: PortProbe; root?: string } = {},
): DoctorCheck[] {
  const exec = options.exec ?? defaultExec;
  const probePort = options.probePort ?? defaultProbePort;
  const root = options.root ?? repoRoot(ctx.env);
  const env = ctx.env;
  const image = env.FORGE_SANDBOX_IMAGE || 'theforge-worker-sandbox:local';
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 4400);
  const webHost = env.FORGE_WEB_HOST || DEFAULT_WEB_HOST;
  const webPort = Number(env.FORGE_WEB_PORT || DEFAULT_WEB_PORT);
  const logDir = logDirectory(env);
  return [
    {
      name: 'repository root',
      async run() {
        try {
          const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
            name?: string;
          };
          if (manifest.name === 'theforge') return { ok: true, detail: root };
          return {
            ok: false,
            detail: `${root} is not TheForge (package.json name ${manifest.name})`,
          };
        } catch {
          return { ok: false, detail: `${root} has no package.json; run from the repository root` };
        }
      },
    },
    {
      name: 'node',
      async run() {
        const major = Number(process.versions.node.split('.')[0]);
        return {
          ok: major >= 22,
          detail: `v${process.versions.node}${major >= 22 ? '' : ' (22 or newer required)'}`,
        };
      },
    },
    {
      name: 'pnpm',
      async run() {
        const result = await exec('corepack', ['pnpm', '--version'], { shell: true });
        return result.code === 0
          ? { ok: true, detail: firstLine(result.stdout) }
          : { ok: false, detail: failed(result, 'corepack pnpm --version failed') };
      },
    },
    {
      name: 'pwsh',
      async run() {
        const result = await exec(env.FORGE_PWSH || 'pwsh', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$PSVersionTable.PSVersion.ToString()',
        ]);
        return result.code === 0
          ? { ok: true, detail: firstLine(result.stdout) }
          : {
              ok: false,
              detail: `${failed(result, 'not found')}; runtime status/start/stop need PowerShell 7 (set FORGE_PWSH)`,
            };
      },
    },
    {
      name: 'docker',
      async run() {
        const result = await exec('docker', ['info', '--format', '{{.ServerVersion}}']);
        return result.code === 0
          ? { ok: true, detail: `engine ${firstLine(result.stdout)}` }
          : { ok: false, detail: failed(result, 'docker info failed; is Docker Desktop running?') };
      },
    },
    {
      name: 'sandbox image',
      async run() {
        const result = await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
        return result.code === 0
          ? { ok: true, detail: `${image} ${firstLine(result.stdout).slice(0, 19)}` }
          : { ok: false, detail: `${image} not found; run pnpm sandbox:build` };
      },
    },
    {
      name: '.env',
      async run() {
        const path = join(root, '.env');
        return (await exists(path, 'file'))
          ? { ok: true, detail: path }
          : { ok: false, detail: `${path} is missing; copy .env.example and fill it in` };
      },
    },
    ...APPS.map((app): DoctorCheck => ({
      name: `${app} build`,
      async run() {
        const path = join(root, BUILD[app].path);
        return (await exists(path, BUILD[app].kind))
          ? { ok: true, detail: path }
          : { ok: false, detail: `${path} is missing; run corepack pnpm build` };
      },
    })),
    {
      name: 'coordinator port',
      async run() {
        if ((await probePort(host, port)) === 'closed') {
          return { ok: true, detail: `${host}:${port} free` };
        }
        const health = await fetchJson(ctx, `http://${host}:${port}/health`);
        const status = health.ok ? field(health.body, 'status') : undefined;
        return typeof status === 'string'
          ? { ok: true, detail: `${host}:${port} in use by the coordinator (health ${status})` }
          : {
              ok: false,
              detail: `${host}:${port} in use and /health did not answer; something else holds the port`,
            };
      },
    },
    {
      // The same question as the coordinator's port, asked of /login because
      // that is the one page the web app serves whatever else is wrong: no
      // session, no coordinator, not even an operator password configured. It
      // answers 200 in all of those, and its body names TheForge (and, when
      // login is not configured, the variable to set), which is what tells a
      // control centre apart from any other server that holds the port.
      name: 'web port',
      async run() {
        if ((await probePort(webHost, webPort)) === 'closed') {
          return { ok: true, detail: `${webHost}:${webPort} free` };
        }
        const probe = await fetchJson(ctx, `http://${webHost}:${webPort}/login`);
        if (!probe.ok) {
          return {
            ok: false,
            detail: `${webHost}:${webPort} in use but /login did not answer (${probe.error}); something else holds the port`,
          };
        }
        const body = typeof probe.body === 'string' ? probe.body : '';
        const mine = body.includes('TheForge') || body.includes('FORGE_WEB_OPERATOR_PASSWORD');
        return mine
          ? {
              ok: true,
              detail: `${webHost}:${webPort} in use by the web control centre (HTTP ${probe.status})`,
            }
          : {
              ok: false,
              detail: `${webHost}:${webPort} in use and /login did not answer as the control centre; something else holds the port`,
            };
      },
    },
    {
      name: 'log directory',
      async run() {
        if (await exists(logDir, 'directory')) {
          try {
            await access(logDir, constants.W_OK);
            return { ok: true, detail: logDir };
          } catch {
            return { ok: false, detail: `${logDir} is not writable` };
          }
        }
        return (await exists(dirname(logDir), 'directory'))
          ? { ok: true, detail: `${logDir} absent; the runners create it at first start` }
          : { ok: false, detail: `${logDir} and its parent are missing` };
      },
    },
    {
      name: 'halt file',
      async run() {
        const configured = env.FORGE_HALT_FILE;
        if (configured && !isAbsolute(configured)) {
          return {
            ok: false,
            detail: `FORGE_HALT_FILE=${configured} is relative; a kill switch must not depend on the working directory`,
          };
        }
        const halt = await haltStatus(env);
        return {
          ok: true,
          detail: halt.exists
            ? `${halt.path} present - halted${halt.request ? ` since ${halt.request.requestedAt} by ${halt.request.requestedBy}` : ''}`
            : `${halt.path} absent`,
        };
      },
    },
    {
      // Advisory: the web control centre is not one of the registered tasks,
      // so a gap here is a WARNING in the detail and never a FAIL that would
      // block registration. The value itself is never printed (ADR-027).
      name: 'web operator password',
      async run() {
        const password = env.FORGE_WEB_OPERATOR_PASSWORD;
        const gap = !password
          ? 'is not set'
          : password.length < 16
            ? `is only ${password.length} characters`
            : '';
        return {
          ok: true,
          detail: gap
            ? `WARNING FORGE_WEB_OPERATOR_PASSWORD ${gap}; the web control centre answers 503 to everything but /login until it is 16+ characters (docs/OPERATIONS.md "Operator login")`
            : 'set (16+ characters)',
        };
      },
    },
    {
      // Advisory, like the password above: a wrong FORGE_WEB_ORIGIN does not
      // stop the app starting, it makes every mutation from a browser fail the
      // proxy's same-origin check with a 403, which reads like a bug. OK with a
      // WARNING detail is the only level the doctor has, and enough here.
      name: 'web origin',
      async run() {
        const configured = env.FORGE_WEB_ORIGIN;
        const advice =
          'set FORGE_WEB_ORIGIN to the URL the browser actually uses (docs/OPERATIONS.md "Reaching the control centre from elsewhere")';
        if (!configured) {
          return {
            ok: true,
            detail: `WARNING FORGE_WEB_ORIGIN is not set; the proxy then compares a mutation's Origin against the URL next start reports, which is localhost whatever the client typed, so a tailnet or LAN client gets 403 - ${advice}`,
          };
        }
        // `new URL` accepts things a browser would never send as an Origin
        // ("nodee:3000" parses as a scheme with no host), so the protocol
        // and the host are checked rather than just the parse.
        let origin: URL | undefined;
        try {
          origin = new URL(configured);
        } catch {
          origin = undefined;
        }
        if (!origin || !['http:', 'https:'].includes(origin.protocol) || !origin.hostname) {
          return {
            ok: true,
            detail: `WARNING FORGE_WEB_ORIGIN=${configured} is not an http(s) URL, so the same-origin check on mutations can never match - ${advice}`,
          };
        }
        const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
          origin.hostname.toLowerCase(),
        );
        return {
          ok: true,
          detail: loopback
            ? `WARNING FORGE_WEB_ORIGIN=${origin.origin} is a loopback URL; a tailnet or LAN client fails the same-origin check on every mutation (403 same_origin_json_required) - ${advice}`
            : `${origin.origin}; a browser must reach the app at exactly this URL or mutations are refused 403`,
        };
      },
    },
  ];
}

// --- the command --------------------------------------------------------------

const SUBCOMMANDS = ['status', 'start', 'stop', 'doctor'] as const;

export function createRuntimeCommand(options: RuntimeOptions = {}): Command {
  const names = options.taskNames ?? DEFAULT_TASK_NAMES;
  return {
    name: 'runtime',
    describe:
      'The coordinator, worker and web control centre as scheduled tasks: status, start, stop (halts first), doctor',
    usage: '<status|start|stop|doctor> [--json] [--no-halt]',
    async run(argv, ctx) {
      const { flags, positionals } = parseArgs(argv);
      const subcommand = positionals[0];
      const json = flags.has('json');
      if (!subcommand || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
        ctx.stderr(
          `forge runtime: expected one of ${SUBCOMMANDS.join(', ')}${subcommand ? `, not '${subcommand}'` : ''}`,
        );
        return 2;
      }
      const pwsh = options.pwsh ?? createPwshRunner(ctx.env);
      try {
        switch (subcommand) {
          case 'status':
            return await status(ctx, pwsh, names, json);
          case 'start':
            return await order(ctx, pwsh, names, 'Start', json, false);
          case 'stop':
            return await order(ctx, pwsh, names, 'Stop', json, !flags.has('no-halt'));
          case 'doctor':
            return await doctor(ctx, options, json);
        }
      } catch (error) {
        if (!(error instanceof PwshOutputError)) throw error;
        ctx.stderr(`forge runtime ${subcommand}: ${error.message}`);
        return 1;
      }
      return 2;
    },
  };
}

function taskLine(task: TaskStatus): string {
  if (!task.registered) {
    return `task ${task.name}: not registered (scripts/runtime/register-runtime.ps1 creates it)`;
  }
  const parts = [
    task.state,
    task.enabled ? 'enabled' : 'DISABLED',
    `last run ${task.lastRunTime ?? 'never'}`,
    `last result ${describeTaskResult(task.lastTaskResult)}`,
  ];
  if (task.missedRuns > 0) parts.push(`${task.missedRuns} missed run(s)`);
  return `task ${task.name}: ${parts.join(', ')}`;
}

async function status(
  ctx: CommandContext,
  pwsh: PwshRunner,
  names: Readonly<Record<App, string>>,
  json: boolean,
): Promise<number> {
  const tasks = parseTaskStatus(
    parseJsonOutput(
      await pwsh(taskStatusScript(APPS.map((app) => names[app]))),
      'reading the scheduled tasks',
    ),
    names,
  );
  const halt = await haltStatus(ctx.env);
  const coordinator = await coordinatorStatus(ctx);
  const logDir = logDirectory(ctx.env);
  const logs = Object.fromEntries(
    await Promise.all(APPS.map(async (app) => [app, await newestLogLine(logDir, app)] as const)),
  ) as Record<App, Awaited<ReturnType<typeof newestLogLine>>>;
  if (json) {
    ctx.stdout(JSON.stringify({ tasks, halt, coordinator, logDir, logs }));
    return 0;
  }
  for (const task of tasks) ctx.stdout(taskLine(task));
  for (const line of haltLines(halt)) ctx.stdout(line);
  for (const line of coordinatorLines(coordinator)) ctx.stdout(line);
  for (const app of APPS) {
    const log = logs[app];
    ctx.stdout(
      log ? `log ${app}: ${log.file} | ${log.line || '(empty)'}` : `log ${app}: none in ${logDir}`,
    );
  }
  return 0;
}

/**
 * Start: APPS order - coordinator, worker, web (the worker retries its
 * registration anyway, and the web app degrades gracefully until the
 * coordinator answers).
 * Stop: write the halt file first unless --no-halt, so a coordinator that
 * outlives the worker by a moment leases nothing new and the restart comes up
 * halted; then APPS backwards, so the web app stops taking orders before the
 * system under it goes away.
 */
async function order(
  ctx: CommandContext,
  pwsh: PwshRunner,
  names: Readonly<Record<App, string>>,
  verb: 'Start' | 'Stop',
  json: boolean,
  haltFirst: boolean,
): Promise<number> {
  const lines: string[] = [];
  let halt: HaltStatus | undefined;
  if (haltFirst) {
    const path = haltFilePath(ctx.env);
    const previous = await readHaltFile(path);
    await writeHaltFile(path, {
      requestedAt: new Date().toISOString(),
      requestedBy: 'cli',
      reason: 'runtime stop',
    });
    halt = await haltStatus(ctx.env);
    lines.push(
      previous.exists
        ? `already halted; halt file rewritten: ${path}`
        : `halted; halt file written: ${path}`,
    );
  } else if (verb === 'Start') {
    halt = await haltStatus(ctx.env);
    if (halt.exists) {
      lines.push(
        `note: the halt file is present (${halt.path}); the coordinator starts halted and leases nothing until pnpm forge resume`,
      );
    }
  }
  const sequence: App[] = verb === 'Start' ? [...APPS] : [...APPS].reverse();
  const results: TaskOrder[] = [];
  for (const app of sequence) {
    const name = names[app];
    const result = parseTaskOrder(
      parseJsonOutput(await pwsh(taskOrderScript(verb, name)), `${verb.toLowerCase()}ing ${name}`),
      app,
      name,
    );
    results.push(result);
    lines.push(
      result.ok
        ? `task ${name}: ${verb.toLowerCase()} requested${result.state ? ` (now ${result.state})` : ''}`
        : `task ${name}: ${verb.toLowerCase()} FAILED: ${result.error ?? 'unknown'}`,
    );
  }
  const ok = results.every((result) => result.ok);
  if (json) {
    ctx.stdout(
      JSON.stringify({ ok, verb: verb.toLowerCase(), ...(halt ? { halt } : {}), tasks: results }),
    );
  } else {
    for (const line of lines) ctx.stdout(line);
    if (verb === 'Stop' && ok) {
      ctx.stdout('the halt file stays until pnpm forge resume; the tasks stay registered');
    }
  }
  return ok ? 0 : 1;
}

async function doctor(
  ctx: CommandContext,
  options: RuntimeOptions,
  json: boolean,
): Promise<number> {
  const checks = options.doctorChecks
    ? options.doctorChecks(ctx)
    : defaultDoctorChecks(ctx, {
        ...(options.exec ? { exec: options.exec } : {}),
        ...(options.probePort ? { probePort: options.probePort } : {}),
      });
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, ...(await check.run()) });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failures = results.filter((result) => !result.ok);
  if (json) {
    ctx.stdout(JSON.stringify({ ok: failures.length === 0, checks: results }));
  } else {
    const width = Math.max(...results.map((result) => result.name.length));
    for (const result of results) {
      ctx.stdout(`${result.ok ? 'OK  ' : 'FAIL'} ${result.name.padEnd(width)}  ${result.detail}`);
    }
    ctx.stdout(
      failures.length === 0
        ? `${results.length} check(s) passed; ready to register (scripts/runtime/register-runtime.ps1)`
        : `${failures.length} of ${results.length} check(s) FAILED; fix them before registering`,
    );
  }
  return failures.length === 0 ? 0 : 1;
}

export const runtimeCommand: Command = createRuntimeCommand();
