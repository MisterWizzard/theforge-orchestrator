import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from './command.js';
import {
  createRuntimeCommand,
  defaultDoctorChecks,
  describeTaskResult,
  newestLogLine,
  type App,
  type DoctorCheck,
  type ExecRunner,
  type ProcessResult,
  type PwshRunner,
  type RuntimeOptions,
} from './commands/runtime.js';
import { createRegistry } from './registry.js';

/**
 * Everything here runs against a fake PowerShell, so no scheduled task is
 * read, started or stopped and no coordinator is spawned. The one exception
 * is the last block, which runs the real `pwsh` against task names that do
 * not exist to prove the JSON round trip - a missing task is answered before
 * Start-ScheduledTask or Stop-ScheduledTask could be reached.
 */

const NAMES: Record<App, string> = {
  coordinator: 'TheForge Coordinator',
  worker: 'TheForge Worker',
  web: 'TheForge Web',
};

type Row = Record<string, unknown>;

/**
 * Answers the three scripts the command sends by looking at what they
 * contain, and records each one so a test can assert the order.
 */
function fakePwsh(
  rows: Row[],
  orders: Record<string, Row> = {},
  override?: (script: string) => ProcessResult | undefined,
) {
  const scripts: string[] = [];
  const pwsh: PwshRunner = async (script) => {
    scripts.push(script);
    const overridden = override?.(script);
    if (overridden) return overridden;
    const ok = (body: unknown): ProcessResult => ({
      code: 0,
      stdout: `${JSON.stringify(body)}\r\n`,
      stderr: '',
    });
    if (script.includes('Get-ScheduledTaskInfo')) return ok(rows);
    const name = /\$name = '((?:[^']|'')+)'/.exec(script)?.[1]?.replace(/''/g, "'");
    const order = name ? orders[name] : undefined;
    return ok(order ?? { name, ok: false, error: 'not registered' });
  };
  const ordered = (verb: 'Start' | 'Stop') =>
    scripts
      .filter((script) => script.includes(`${verb}-ScheduledTask`))
      .map((script) => /\$name = '((?:[^']|'')+)'/.exec(script)?.[1]);
  return { pwsh, scripts, ordered };
}

function harness(
  env: Record<string, string | undefined>,
  options: RuntimeOptions,
  fetch?: typeof globalThis.fetch,
) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch:
      fetch ??
      (() => {
        throw new Error('this command must not reach for the network');
      }),
  };
  const registry = createRegistry([createRuntimeCommand(options)]);
  return { out, err, run: (argv: string[]) => registry.run(['runtime', ...argv], ctx) };
}

const registered = (name: string, overrides: Row = {}): Row => ({
  name,
  registered: true,
  state: 'Ready',
  enabled: true,
  lastRunTime: '2026-09-26T09:00:00.0000000+10:00',
  nextRunTime: null,
  lastTaskResult: 0,
  missedRuns: 0,
  ...overrides,
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-runtime-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('runtime status', () => {
  it('reports each task, the halt file, the coordinator and the newest log line', async () => {
    const logDir = join(directory, 'logs');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'coordinator-20260925.log'), 'old day\n');
    await writeFile(
      join(logDir, 'coordinator-20260926.log'),
      '{"level":"info","message":"first"}\n{"level":"info","message":"latest"}\n\n',
    );
    await writeFile(join(logDir, 'coordinator-notes.txt'), 'not a daily log\n');
    await writeFile(join(logDir, 'web-20260926.log'), 'run-web.ps1: starting node\n');
    const fake = fakePwsh([
      registered(NAMES.coordinator, { state: 'Running', lastTaskResult: 0x41301 }),
      { name: NAMES.worker, registered: false },
      registered(NAMES.web, { state: 'Running', lastTaskResult: 0x800710e0 }),
    ]);
    const { run, out, err } = harness(
      { FORGE_HALT_FILE: join(directory, 'FORGE_HALT'), FORGE_LOG_DIR: logDir },
      { pwsh: fake.pwsh },
    );
    expect(await run(['status'])).toBe(0);
    expect(out).toEqual([
      'task TheForge Coordinator: Running, enabled, last run 2026-09-26T09:00:00.0000000+10:00, last result 0x41301 (running)',
      'task TheForge Worker: not registered (scripts/runtime/register-runtime.ps1 creates it)',
      'task TheForge Web: Running, enabled, last run 2026-09-26T09:00:00.0000000+10:00, last result 0x800710E0 (watchdog repeat refused, the task is already running (healthy))',
      'halted: no',
      `halt file: ${join(directory, 'FORGE_HALT')} (absent)`,
      'coordinator: not queried (set FORGE_API_URL and FORGE_COORDINATOR_TOKEN to include it)',
      `log coordinator: ${join(logDir, 'coordinator-20260926.log')} | {"level":"info","message":"latest"}`,
      `log worker: none in ${logDir}`,
      `log web: ${join(logDir, 'web-20260926.log')} | run-web.ps1: starting node`,
    ]);
    expect(err).toEqual([]);
    // One PowerShell round trip, asking for all three names by their exact text.
    expect(fake.scripts).toHaveLength(1);
    expect(fake.scripts[0]).toContain(
      "@('TheForge Coordinator', 'TheForge Worker', 'TheForge Web')",
    );
  });

  it('shows a never-run task, a disabled one, missed runs and the runner exit codes', async () => {
    const fake = fakePwsh([
      registered(NAMES.coordinator, {
        state: 'Disabled',
        enabled: false,
        lastRunTime: null,
        lastTaskResult: 0x41303,
      }),
      registered(NAMES.worker, { lastTaskResult: 3, missedRuns: 2 }),
      registered(NAMES.web, { state: 'Running', lastTaskResult: 0x41301 }),
    ]);
    const { run, out } = harness(
      { FORGE_HALT_FILE: join(directory, 'FORGE_HALT') },
      { pwsh: fake.pwsh },
    );
    expect(await run(['status'])).toBe(0);
    expect(out[0]).toBe(
      'task TheForge Coordinator: Disabled, DISABLED, last run never, last result 0x41303 (has not run yet)',
    );
    expect(out[1]).toBe(
      'task TheForge Worker: Ready, enabled, last run 2026-09-26T09:00:00.0000000+10:00, last result 3 (runner pre-flight failed: no .env, no build or no node; see the log), 2 missed run(s)',
    );
    expect(out[2]).toBe(
      'task TheForge Web: Running, enabled, last run 2026-09-26T09:00:00.0000000+10:00, last result 0x41301 (running)',
    );
    expect(describeTaskResult(4)).toBe('4 (runner gave up waiting for Docker)');
    // The watchdog trigger (BLK-017) re-fires every minute and IgnoreNew refuses
    // the repeat while the process is alive, so these two are healthy, not faults.
    expect(describeTaskResult(0x800710e0)).toBe(
      '0x800710E0 (watchdog repeat refused, the task is already running (healthy))',
    );
    expect(describeTaskResult(0x8004131f)).toBe(
      '0x8004131F (watchdog repeat ignored, the task is already running (healthy))',
    );
    expect(describeTaskResult(17)).toBe('17 (exit 17)');
    expect(describeTaskResult(0x41399)).toBe('0x41399 (unknown)');
    // A killed process still reports as a failure; the watchdog must not hide that.
    expect(describeTaskResult(0xffffffff)).toBe('0xFFFFFFFF (unknown)');
  });

  it('includes /health and /api/halt through the injected fetch, as --json too', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const body = url.endsWith('/health')
        ? { status: 'ok' }
        : { halted: true, source: 'file', haltFile };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const fake = fakePwsh([
      registered(NAMES.coordinator),
      registered(NAMES.worker),
      registered(NAMES.web),
    ]);
    const env = {
      FORGE_HALT_FILE: haltFile,
      FORGE_API_URL: 'http://127.0.0.1:4400/',
      FORGE_COORDINATOR_TOKEN: 'test-coordinator-token-that-is-long-enough',
      FORGE_LOG_DIR: join(directory, 'no-such-logs'),
    };
    await writeFile(
      haltFile,
      JSON.stringify({ requestedAt: 't', requestedBy: 'cli', reason: 'why' }),
    );
    const text = harness(env, { pwsh: fake.pwsh }, fetch);
    expect(await text.run(['status'])).toBe(0);
    expect(text.out).toContain('halted: yes');
    expect(text.out).toContain('requested: t by cli');
    expect(text.out).toContain('reason: why');
    expect(text.out).toContain('coordinator health: ok');
    expect(text.out).toContain('coordinator halted: yes (source: file)');
    expect(text.out).toContain(`coordinator halt file: ${haltFile}`);
    expect(calls).toEqual(['http://127.0.0.1:4400/health', 'http://127.0.0.1:4400/api/halt']);

    const json = harness(env, { pwsh: fake.pwsh }, fetch);
    expect(await json.run(['status', '--json'])).toBe(0);
    expect(json.out).toHaveLength(1);
    expect(JSON.parse(json.out[0]!)).toMatchObject({
      tasks: [
        { app: 'coordinator', registered: true, state: 'Ready' },
        { app: 'worker', registered: true },
        { app: 'web', registered: true, state: 'Ready' },
      ],
      halt: { halted: true, exists: true, request: { requestedBy: 'cli', reason: 'why' } },
      coordinator: { queried: true, reachable: true, health: 'ok', halted: true, source: 'file' },
      logs: { coordinator: null, worker: null, web: null },
    });
  });

  it('reports an unreachable coordinator without failing', async () => {
    const fake = fakePwsh([
      registered(NAMES.coordinator),
      registered(NAMES.worker),
      registered(NAMES.web),
    ]);
    const { run, out } = harness(
      {
        FORGE_HALT_FILE: join(directory, 'FORGE_HALT'),
        FORGE_API_URL: 'http://127.0.0.1:4400',
        FORGE_COORDINATOR_TOKEN: 'test-coordinator-token-that-is-long-enough',
      },
      { pwsh: fake.pwsh },
      async () => {
        throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
      },
    );
    expect(await run(['status'])).toBe(0);
    expect(out).toContain(
      'coordinator: unreachable at http://127.0.0.1:4400 (fetch failed: ECONNREFUSED)',
    );
  });

  it('exits 1 with the PowerShell error when the query fails or prints no JSON', async () => {
    const env = { FORGE_HALT_FILE: join(directory, 'FORGE_HALT') };
    const crashed = harness(env, {
      pwsh: async () => ({ code: 1, stdout: '', stderr: 'Get-ScheduledTask: access denied\r\n' }),
    });
    expect(await crashed.run(['status'])).toBe(1);
    expect(crashed.err).toEqual([
      'forge runtime status: PowerShell exited 1 while reading the scheduled tasks: Get-ScheduledTask: access denied',
    ]);

    const garbled = harness(env, { pwsh: async () => ({ code: 0, stdout: 'oops', stderr: '' }) });
    expect(await garbled.run(['status'])).toBe(1);
    expect(garbled.err[0]).toContain('printed no JSON while reading the scheduled tasks: oops');

    const missingRow = harness(env, {
      pwsh: async () => ({
        code: 0,
        stdout: JSON.stringify([registered(NAMES.worker)]),
        stderr: '',
      }),
    });
    expect(await missingRow.run(['status'])).toBe(1);
    expect(missingRow.err[0]).toContain('no row for TheForge Coordinator');
  });

  it('rejects a missing or unknown subcommand with exit 2', async () => {
    const { run, err } = harness({}, { pwsh: fakePwsh([]).pwsh });
    expect(await run([])).toBe(2);
    expect(err[0]).toBe('forge runtime: expected one of status, start, stop, doctor');
    expect(await run(['restart'])).toBe(2);
    expect(err[1]).toContain("not 'restart'");
  });
});

describe('runtime start and stop', () => {
  it('starts the coordinator before the worker and warns when the halt file is present', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    await writeFile(haltFile, '');
    const fake = fakePwsh([], {
      [NAMES.coordinator]: { name: NAMES.coordinator, ok: true, state: 'Running' },
      [NAMES.worker]: { name: NAMES.worker, ok: true, state: 'Running' },
      [NAMES.web]: { name: NAMES.web, ok: true, state: 'Running' },
    });
    const { run, out } = harness({ FORGE_HALT_FILE: haltFile }, { pwsh: fake.pwsh });
    expect(await run(['start'])).toBe(0);
    expect(fake.ordered('Start')).toEqual([NAMES.coordinator, NAMES.worker, NAMES.web]);
    expect(out).toEqual([
      `note: the halt file is present (${haltFile}); the coordinator starts halted and leases nothing until pnpm forge resume`,
      'task TheForge Coordinator: start requested (now Running)',
      'task TheForge Worker: start requested (now Running)',
      'task TheForge Web: start requested (now Running)',
    ]);
    // Starting never touches the halt file: a halt survives a restart.
    expect(existsSync(haltFile)).toBe(true);
  });

  it('exits 1 when a task is not registered, still trying the other', async () => {
    const fake = fakePwsh([], {
      [NAMES.coordinator]: { name: NAMES.coordinator, ok: true, state: 'Running' },
    });
    const { run, out } = harness(
      { FORGE_HALT_FILE: join(directory, 'FORGE_HALT') },
      { pwsh: fake.pwsh },
    );
    expect(await run(['start'])).toBe(1);
    expect(out).toEqual([
      'task TheForge Coordinator: start requested (now Running)',
      'task TheForge Worker: start FAILED: not registered',
      'task TheForge Web: start FAILED: not registered',
    ]);
    expect(fake.ordered('Start')).toEqual([NAMES.coordinator, NAMES.worker, NAMES.web]);
  });

  it('stop writes the halt file first, then stops the worker, then the coordinator', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    let haltExistedAtFirstStop: boolean | undefined;
    const fake = fakePwsh(
      [],
      {
        [NAMES.coordinator]: { name: NAMES.coordinator, ok: true, state: 'Ready' },
        [NAMES.worker]: { name: NAMES.worker, ok: true, state: 'Ready' },
        [NAMES.web]: { name: NAMES.web, ok: true, state: 'Ready' },
      },
      (script) => {
        if (script.includes('Stop-ScheduledTask') && haltExistedAtFirstStop === undefined) {
          haltExistedAtFirstStop = existsSync(haltFile);
        }
        return undefined;
      },
    );
    const { run, out } = harness({ FORGE_HALT_FILE: haltFile }, { pwsh: fake.pwsh });
    expect(await run(['stop'])).toBe(0);
    expect(haltExistedAtFirstStop).toBe(true);
    expect(fake.ordered('Stop')).toEqual([NAMES.web, NAMES.worker, NAMES.coordinator]);
    expect(JSON.parse(await readFile(haltFile, 'utf8'))).toMatchObject({
      requestedBy: 'cli',
      reason: 'runtime stop',
    });
    expect(out).toEqual([
      `halted; halt file written: ${haltFile}`,
      'task TheForge Web: stop requested (now Ready)',
      'task TheForge Worker: stop requested (now Ready)',
      'task TheForge Coordinator: stop requested (now Ready)',
      'the halt file stays until pnpm forge resume; the tasks stay registered',
    ]);

    // A second stop finds the file already there and says so.
    out.length = 0;
    expect(await run(['stop', '--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      ok: true,
      verb: 'stop',
      halt: { halted: true, exists: true },
      tasks: [
        { app: 'web', ok: true },
        { app: 'worker', ok: true },
        { app: 'coordinator', ok: true },
      ],
    });
  });

  it('stop --no-halt leaves the halt file alone', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const fake = fakePwsh([], {
      [NAMES.coordinator]: { name: NAMES.coordinator, ok: true },
      [NAMES.worker]: { name: NAMES.worker, ok: true },
      [NAMES.web]: { name: NAMES.web, ok: true },
    });
    const { run, out } = harness({ FORGE_HALT_FILE: haltFile }, { pwsh: fake.pwsh });
    expect(await run(['stop', '--no-halt'])).toBe(0);
    expect(existsSync(haltFile)).toBe(false);
    expect(out[0]).toBe('task TheForge Web: stop requested');
    expect(fake.ordered('Stop')).toEqual([NAMES.web, NAMES.worker, NAMES.coordinator]);
  });

  it('reports a PowerShell refusal per task', async () => {
    const fake = fakePwsh([], {
      [NAMES.coordinator]: { name: NAMES.coordinator, ok: false, error: 'Access is denied' },
      [NAMES.worker]: { name: NAMES.worker, ok: true, state: 'Ready' },
      [NAMES.web]: { name: NAMES.web, ok: true, state: 'Ready' },
    });
    const { run, out } = harness(
      { FORGE_HALT_FILE: join(directory, 'FORGE_HALT') },
      { pwsh: fake.pwsh },
    );
    expect(await run(['stop', '--no-halt'])).toBe(1);
    expect(out).toEqual([
      'task TheForge Web: stop requested (now Ready)',
      'task TheForge Worker: stop requested (now Ready)',
      'task TheForge Coordinator: stop FAILED: Access is denied',
    ]);
  });
});

describe('runtime doctor', () => {
  const check = (name: string, ok: boolean, detail = name): DoctorCheck => ({
    name,
    run: async () => ({ ok, detail }),
  });

  it('prints one OK/FAIL line per check and exits 1 on any FAIL', async () => {
    const healthy = harness(
      {},
      { doctorChecks: () => [check('node', true, 'v24'), check('docker', true)] },
    );
    expect(await healthy.run(['doctor'])).toBe(0);
    expect(healthy.out).toEqual([
      'OK   node    v24',
      'OK   docker  docker',
      '2 check(s) passed; ready to register (scripts/runtime/register-runtime.ps1)',
    ]);

    const sick = harness(
      {},
      {
        doctorChecks: () => [
          check('node', true, 'v24'),
          check('.env', false, 'missing'),
          { name: 'sandbox image', run: async () => Promise.reject(new Error('docker exploded')) },
        ],
      },
    );
    expect(await sick.run(['doctor'])).toBe(1);
    expect(sick.out).toEqual([
      'OK   node           v24',
      'FAIL .env           missing',
      'FAIL sandbox image  docker exploded',
      '2 of 3 check(s) FAILED; fix them before registering',
    ]);

    const json = harness({}, { doctorChecks: () => [check('.env', false, 'missing')] });
    expect(await json.run(['doctor', '--json'])).toBe(1);
    expect(JSON.parse(json.out[0]!)).toEqual({
      ok: false,
      checks: [{ name: '.env', ok: false, detail: 'missing' }],
    });
  });

  it('checks the real files, ports and tools through the injected runners', async () => {
    const root = join(directory, 'repo');
    await mkdir(join(root, 'apps', 'coordinator', 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'theforge' }));
    await writeFile(join(root, 'apps', 'coordinator', 'dist', 'server.js'), '');
    const commands: string[] = [];
    const exec: ExecRunner = async (file, args) => {
      commands.push([file, ...args].join(' '));
      if (file === 'docker' && args[0] === 'image')
        return { code: 1, stdout: '', stderr: 'No such image' };
      if (file === 'docker') return { code: 0, stdout: '29.8.0\n', stderr: '' };
      if (file === 'corepack') return { code: 0, stdout: '11.7.0\n', stderr: '' };
      return { code: 0, stdout: '7.6.6\n', stderr: '' };
    };
    const ctx: CommandContext = {
      env: {
        FORGE_HALT_FILE: 'relative/FORGE_HALT',
        FORGE_LOG_DIR: join(directory, 'logs'),
        PORT: '4411',
      },
      stdout: () => undefined,
      stderr: () => undefined,
      fetch: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    };
    const results = await Promise.all(
      defaultDoctorChecks(ctx, { exec, probePort: async () => 'open', root }).map(async (item) => ({
        name: item.name,
        ...(await item.run()),
      })),
    );
    const byName = Object.fromEntries(results.map((result) => [result.name, result]));
    expect(byName['repository root']).toEqual({ name: 'repository root', ok: true, detail: root });
    expect(byName.node?.ok).toBe(true);
    expect(byName.pnpm).toEqual({ name: 'pnpm', ok: true, detail: '11.7.0' });
    expect(byName.pwsh).toEqual({ name: 'pwsh', ok: true, detail: '7.6.6' });
    expect(byName.docker).toEqual({ name: 'docker', ok: true, detail: 'engine 29.8.0' });
    expect(byName['sandbox image']).toEqual({
      name: 'sandbox image',
      ok: false,
      detail: 'theforge-worker-sandbox:local not found; run pnpm sandbox:build',
    });
    expect(byName['.env']?.ok).toBe(false);
    expect(byName['.env']?.detail).toContain('copy .env.example');
    expect(byName['coordinator build']?.ok).toBe(true);
    expect(byName['worker build']?.ok).toBe(false);
    // apps/web/.next is a directory, and it has not been built here.
    expect(byName['web build']).toEqual({
      name: 'web build',
      ok: false,
      detail: `${join(root, 'apps', 'web', '.next')} is missing; run corepack pnpm build`,
    });
    expect(byName['coordinator port']).toEqual({
      name: 'coordinator port',
      ok: true,
      detail: '127.0.0.1:4411 in use by the coordinator (health ok)',
    });
    // Port 3000 answered, but with the coordinator's health JSON rather than the
    // control centre's sign-in page, so something else holds it.
    expect(byName['web port']).toEqual({
      name: 'web port',
      ok: false,
      detail:
        '127.0.0.1:3000 in use and /login did not answer as the control centre; something else holds the port',
    });
    expect(byName['web origin']?.ok).toBe(true);
    expect(byName['web origin']?.detail).toContain('WARNING FORGE_WEB_ORIGIN is not set');
    expect(byName['log directory']).toEqual({
      name: 'log directory',
      ok: true,
      detail: `${join(directory, 'logs')} absent; the runners create it at first start`,
    });
    expect(byName['halt file']?.ok).toBe(false);
    expect(byName['halt file']?.detail).toContain('is relative');
    expect(commands).toEqual([
      'corepack pnpm --version',
      'pwsh -NoProfile -NonInteractive -Command $PSVersionTable.PSVersion.ToString()',
      'docker info --format {{.ServerVersion}}',
      'docker image inspect theforge-worker-sandbox:local --format {{.Id}}',
    ]);

    // The happy path for the file checks, a port held by a stranger, and a
    // present halt file.
    await writeFile(join(root, '.env'), 'NODE_ENV=development\n');
    await mkdir(join(root, 'apps', 'worker', 'dist'), { recursive: true });
    await writeFile(join(root, 'apps', 'worker', 'dist', 'index.js'), '');
    await mkdir(join(root, 'apps', 'web', '.next'), { recursive: true });
    const haltFile = join(directory, 'FORGE_HALT');
    await writeFile(haltFile, JSON.stringify({ requestedAt: 't', requestedBy: 'api' }));
    const stranger: CommandContext = {
      ...ctx,
      env: { FORGE_HALT_FILE: haltFile, FORGE_LOG_DIR: join(directory, 'logs') },
      fetch: async () => {
        throw new Error('fetch failed');
      },
    };
    const again = Object.fromEntries(
      (
        await Promise.all(
          defaultDoctorChecks(stranger, { exec, probePort: async () => 'open', root }).map(
            async (item) => ({ name: item.name, ...(await item.run()) }),
          ),
        )
      ).map((result) => [result.name, result]),
    );
    expect(again['.env']?.ok).toBe(true);
    expect(again['worker build']?.ok).toBe(true);
    expect(again['web build']?.ok).toBe(true);
    expect(again['coordinator port']?.ok).toBe(false);
    expect(again['coordinator port']?.detail).toContain('something else holds the port');
    expect(again['halt file']).toEqual({
      name: 'halt file',
      ok: true,
      detail: `${haltFile} present - halted since t by api`,
    });
  });

  it('checks port 3000 for the control centre, free or held by it', async () => {
    const root = join(directory, 'web-port');
    await mkdir(root, { recursive: true });
    const webPort = async (
      env: Record<string, string | undefined>,
      verdict: 'open' | 'closed',
      answer: () => Response | Promise<Response>,
    ) => {
      const ctx: CommandContext = {
        env,
        stdout: () => undefined,
        stderr: () => undefined,
        fetch: async () => answer(),
      };
      const item = defaultDoctorChecks(ctx, {
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        probePort: async () => verdict,
        root,
      }).find((candidate) => candidate.name === 'web port');
      return item?.run();
    };
    const login = () =>
      new Response('<title>Sign in — TheForge</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    expect(await webPort({}, 'closed', login)).toEqual({ ok: true, detail: '127.0.0.1:3000 free' });
    expect(await webPort({}, 'open', login)).toEqual({
      ok: true,
      detail: '127.0.0.1:3000 in use by the web control centre (HTTP 200)',
    });
    // The app is up but has no operator password configured: /login still
    // answers, saying which variable to set, and that is still the control
    // centre holding the port.
    expect(
      await webPort(
        {},
        'open',
        () =>
          new Response('<p>Set <code>FORGE_WEB_OPERATOR_PASSWORD</code></p>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    ).toEqual({
      ok: true,
      detail: '127.0.0.1:3000 in use by the web control centre (HTTP 200)',
    });
    // A stranger on the port, and a port that refuses the request outright.
    const stranger = await webPort({}, 'open', () => new Response('hello', { status: 200 }));
    expect(stranger?.ok).toBe(false);
    expect(stranger?.detail).toContain('something else holds the port');
    const refused = await webPort({}, 'open', () => {
      throw new Error('fetch failed');
    });
    expect(refused?.ok).toBe(false);
    // FORGE_WEB_HOST and FORGE_WEB_PORT follow a registration that moved it.
    expect(
      await webPort({ FORGE_WEB_HOST: '127.0.0.2', FORGE_WEB_PORT: '3100' }, 'closed', login),
    ).toEqual({ ok: true, detail: '127.0.0.2:3100 free' });
  });

  it('warns when FORGE_WEB_ORIGIN cannot match the URL a browser uses', async () => {
    const check = async (env: Record<string, string | undefined>) => {
      const ctx: CommandContext = {
        env,
        stdout: () => undefined,
        stderr: () => undefined,
        fetch: async () => new Response('{}', { status: 200 }),
      };
      const item = defaultDoctorChecks(ctx, {
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        probePort: async () => 'closed',
        root: directory,
      }).find((candidate) => candidate.name === 'web origin');
      return item?.run();
    };
    // Advisory throughout: never a FAIL, because none of this stops a start.
    const unset = await check({});
    expect(unset?.ok).toBe(true);
    expect(unset?.detail).toContain('WARNING FORGE_WEB_ORIGIN is not set');

    for (const loopback of [
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
    ]) {
      const result = await check({ FORGE_WEB_ORIGIN: loopback });
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain('is a loopback URL');
      expect(result?.detail).toContain('same-origin check on every mutation');
    }

    // Neither of these is an origin a browser could send, and `new URL`
    // accepts the second one, so the check looks at the scheme and the host.
    for (const nonsense of ['not a url', 'nodee:3000']) {
      const result = await check({ FORGE_WEB_ORIGIN: nonsense });
      expect(result?.ok).toBe(true);
      expect(result?.detail).toContain('is not an http(s) URL');
    }

    const tailnet = await check({ FORGE_WEB_ORIGIN: 'https://nodee.example.ts.net' });
    expect(tailnet).toEqual({
      ok: true,
      detail:
        'https://nodee.example.ts.net; a browser must reach the app at exactly this URL or mutations are refused 403',
    });
  });

  it('warns about the web operator password without failing the pre-flight', async () => {
    const check = async (env: Record<string, string | undefined>) => {
      const ctx: CommandContext = {
        env,
        stdout: () => undefined,
        stderr: () => undefined,
        fetch: async () => new Response('{}', { status: 200 }),
      };
      const item = defaultDoctorChecks(ctx, {
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        probePort: async () => 'closed',
        root: directory,
      }).find((candidate) => candidate.name === 'web operator password');
      return item?.run();
    };
    const unset = await check({});
    expect(unset?.ok).toBe(true);
    expect(unset?.detail).toContain('WARNING FORGE_WEB_OPERATOR_PASSWORD is not set');
    const short = await check({ FORGE_WEB_OPERATOR_PASSWORD: 'short' });
    expect(short?.ok).toBe(true);
    expect(short?.detail).toContain('WARNING FORGE_WEB_OPERATOR_PASSWORD is only 5 characters');
    expect(short?.detail).not.toContain('short;');
    const set = await check({ FORGE_WEB_OPERATOR_PASSWORD: 'a-long-enough-dummy-value' });
    expect(set).toEqual({ ok: true, detail: 'set (16+ characters)' });
  });
});

describe('newestLogLine', () => {
  it('reads only the tail of a large file and skips blank trailing lines', async () => {
    const logDir = join(directory, 'logs');
    await mkdir(logDir);
    const big = `${'x'.repeat(200_000)}\n${'y'.repeat(10)}\nlast\n\n\n`;
    await writeFile(join(logDir, 'worker-20260926.log'), big);
    expect(await newestLogLine(logDir, 'worker')).toEqual({
      file: join(logDir, 'worker-20260926.log'),
      line: 'last',
    });
    expect(await newestLogLine(logDir, 'coordinator')).toBeNull();
    expect(await newestLogLine(join(directory, 'absent'), 'worker')).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('runtime against the real PowerShell', () => {
  // Names no registration script ever creates, so the real Get-ScheduledTask
  // finds nothing and the scripts answer "not registered" before any
  // Start-ScheduledTask or Stop-ScheduledTask could run.
  const unique = `${process.pid}-${Date.now()}`;
  const taskNames: Record<App, string> = {
    coordinator: `TheForge Test Coordinator ${unique}`,
    worker: `TheForge Test Worker ${unique}`,
    web: `TheForge Test Web ${unique}`,
  };

  it('status parses Get-ScheduledTask output for tasks that do not exist', async () => {
    const { run, out, err } = harness(
      { FORGE_HALT_FILE: join(directory, 'FORGE_HALT'), FORGE_LOG_DIR: join(directory, 'logs') },
      { taskNames },
    );
    expect(await run(['status'])).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(
      `task ${taskNames.coordinator}: not registered (scripts/runtime/register-runtime.ps1 creates it)`,
    );
    expect(out[1]).toBe(
      `task ${taskNames.worker}: not registered (scripts/runtime/register-runtime.ps1 creates it)`,
    );
    expect(out[2]).toBe(
      `task ${taskNames.web}: not registered (scripts/runtime/register-runtime.ps1 creates it)`,
    );
  }, 60_000);

  it('start and stop --no-halt report the missing tasks and exit 1', async () => {
    const env = { FORGE_HALT_FILE: join(directory, 'FORGE_HALT') };
    const start = harness(env, { taskNames });
    expect(await start.run(['start'])).toBe(1);
    expect(start.out).toEqual([
      `task ${taskNames.coordinator}: start FAILED: not registered`,
      `task ${taskNames.worker}: start FAILED: not registered`,
      `task ${taskNames.web}: start FAILED: not registered`,
    ]);
    const stop = harness(env, { taskNames });
    expect(await stop.run(['stop', '--no-halt'])).toBe(1);
    expect(stop.out).toEqual([
      `task ${taskNames.web}: stop FAILED: not registered`,
      `task ${taskNames.worker}: stop FAILED: not registered`,
      `task ${taskNames.coordinator}: stop FAILED: not registered`,
    ]);
    expect(existsSync(join(directory, 'FORGE_HALT'))).toBe(false);
  }, 60_000);
});
