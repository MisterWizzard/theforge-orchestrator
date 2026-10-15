import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_COMPLETION_BODY_BYTES,
  MAX_PATCH_BYTES,
  MAX_RAW_TAIL_BYTES,
  type ProviderEvent,
  type ProviderRequest,
} from '@theforge/contracts';
import {
  jsonLineProcess,
  type JsonLineProcessOptions,
  type ProviderAdapter,
} from '@theforge/providers';
import { startFakeOllama } from '@theforge/provider-ollama/testing';

// The sandbox path resolves a provider credential before it builds its
// runner, and the worker reads its environment once at import, so a fixture
// key is planted ahead of the imports. Nothing here runs docker: the raw
// output tests script the process in its place, and they assert this value
// never reaches a tail. Vitest isolates each file's process; the cleanup is
// insurance against that ever changing.
const plantedApiKey = vi.hoisted(() => {
  const key = 'sk-ant-api03-planted-worker-fixture-key-0123456789abcdef';
  process.env.ANTHROPIC_API_KEY = key;
  return key;
});
afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

import {
  captureAttemptPatch,
  collectProviderEvents,
  CoordinatorRequestError,
  createProviderDockerRunArgs,
  credentialSourceFor,
  dockerIsolationArgs,
  executeCommand,
  executeDockerCommand,
  executeProviderJob,
  executeTransportedJob,
  lastBytes,
  materializeWorkerWorkspace,
  ollamaContextFor,
  probeOllamaCapabilities,
  retainFailedWorkspace,
  RollingTail,
  submitJobCompletion,
  sweepFailedWorkspaces,
  type FailedWorkspaceRetention,
} from './index.js';

const dockerSandboxAvailable =
  spawnSync('docker', ['image', 'inspect', 'theforge-worker-sandbox:local'], {
    stdio: 'ignore',
  }).status === 0;
const expectedSandboxUid = (process.getuid?.() ?? 0) > 0 ? process.getuid!() : 1000;
const expectedSandboxGid = (process.getgid?.() ?? 0) > 0 ? process.getgid!() : expectedSandboxUid;

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

describe('worker workspace transport', () => {
  it('materializes an exact revision with a tracked binary patch and untracked files', async () => {
    const fixtureRoot = join(process.cwd(), '.forge', 'transport-fixtures');
    await mkdir(fixtureRoot, { recursive: true });
    const source = await mkdtemp(join(fixtureRoot, 'source-'));
    let materialized: string | undefined;
    try {
      git(['init'], source);
      git(['config', 'user.email', 'worker-test@example.invalid'], source);
      git(['config', 'user.name', 'Worker Test'], source);
      await writeFile(join(source, 'tracked.bin'), Buffer.from([0, 1, 2, 3]));
      git(['add', 'tracked.bin'], source);
      git(['commit', '-m', 'fixture'], source);
      const revision = git(['rev-parse', 'HEAD'], source).trim();
      await writeFile(join(source, 'tracked.bin'), Buffer.from([0, 9, 2, 255]));
      const patch = git(['diff', '--binary', 'HEAD'], source);

      materialized = await materializeWorkerWorkspace(
        {
          repositoryUrl: source,
          revision,
          patch,
          untrackedFiles: [
            {
              path: 'nested/untracked.bin',
              contentBase64: Buffer.from([255, 0, 127]).toString('base64'),
              executable: false,
            },
          ],
        },
        'transport-fixture',
        new AbortController().signal,
      );

      expect(git(['rev-parse', 'HEAD'], materialized).trim()).toBe(revision);
      expect(await readFile(join(materialized, 'tracked.bin'))).toEqual(
        Buffer.from([0, 9, 2, 255]),
      );
      expect(await readFile(join(materialized, 'nested', 'untracked.bin'))).toEqual(
        Buffer.from([255, 0, 127]),
      );
    } finally {
      if (materialized) await rm(materialized, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it('rejects traversal and oversized files before cloning', async () => {
    const base = {
      repositoryUrl: process.cwd(),
      revision: 'a'.repeat(40),
      patch: '',
    };
    await expect(
      materializeWorkerWorkspace(
        {
          ...base,
          untrackedFiles: [
            {
              path: '../escape',
              contentBase64: Buffer.from('x').toString('base64'),
              executable: false,
            },
          ],
        },
        'traversal-fixture',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid worker workspace path');
    await expect(
      materializeWorkerWorkspace(
        {
          ...base,
          untrackedFiles: [
            {
              path: 'large.bin',
              contentBase64: Buffer.alloc(1_000_001).toString('base64'),
              executable: false,
            },
          ],
        },
        'size-fixture',
        new AbortController().signal,
      ),
    ).rejects.toThrow('exceeds the 1 MB limit');
  });
});

describe('worker workspace line endings', () => {
  it('materialises a tree byte-identical to the blobs, whatever the host would convert', async () => {
    // The fourteenth obstacle of the first real objective, and the worst of
    // them, because it was invisible from the host.
    //
    // `gitWithInput` inherits the environment, so the host's `core.autocrlf`
    // decided how the workspace was checked out. On Windows it is true by
    // default: the tree landed CRLF while the blobs are LF. The host's own git
    // normalises that back and reports a clean tree. But the workspace is
    // bind-mounted into a Linux container, whose git has no such setting, and
    // in there an untouched checkout of PulseApp reported
    // `119 files changed, 28191 insertions(+), 28191 deletions(-)`.
    //
    // So every agent that inspected the workspace with git saw the entire
    // repository as rewritten. On attempt fourteen the reviewer correctly
    // reported `src/lib/auth.ts` as modified against a constraint forbidding
    // exactly that, and the repair builder could not undo something no agent
    // had done.
    //
    // `GIT_CONFIG_GLOBAL` is pointed at a config that asks for the conversion,
    // so this test reproduces the Windows default on any host and fails without
    // the `-c` flags on the clone rather than only on Windows CI.
    const fixtureRoot = join(process.cwd(), '.forge', 'transport-fixtures');
    await mkdir(fixtureRoot, { recursive: true });
    const source = await mkdtemp(join(fixtureRoot, 'eol-source-'));
    git(['init'], source);
    git(['config', 'user.email', 'worker-test@example.invalid'], source);
    git(['config', 'user.name', 'Worker Test'], source);
    const content = 'first\nsecond\nthird\n';
    await writeFile(join(source, 'tracked.ts'), content);
    git(['add', 'tracked.ts'], source);
    git(['commit', '-m', 'fixture'], source);
    const revision = git(['rev-parse', 'HEAD'], source).trim();

    const configHome = await mkdtemp(join(fixtureRoot, 'eol-config-'));
    const configPath = join(configHome, 'gitconfig');
    await writeFile(configPath, '[core]\n\tautocrlf = true\n\teol = crlf\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    let materialized: string | undefined;
    try {
      process.env.GIT_CONFIG_GLOBAL = configPath;
      materialized = await materializeWorkerWorkspace(
        { repositoryUrl: source, revision, patch: '', untrackedFiles: [] },
        'eol-fixture',
        new AbortController().signal,
      );
      const onDisk = await readFile(join(materialized, 'tracked.ts'), 'utf8');
      // The assertion that matters: the bytes, not a git opinion about them.
      expect(onDisk).toBe(content);
      expect(onDisk).not.toContain('\r');
      // And the repository agrees from inside, which is the view the container's
      // git has and the one that was wrong.
      const diff = spawnSync('git', ['diff', '--stat'], {
        cwd: materialized,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: configPath },
      });
      expect(diff.stdout.trim()).toBe('');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
      if (materialized) await rm(materialized, { recursive: true, force: true });
    }
  });
});

describe('worker failed workspaces', () => {
  const fixtureRoot = join(process.cwd(), '.forge', 'transport-fixtures');
  const workspaceRoot = () => realpath(resolve('.forge/workspaces'));
  const now = new Date('2026-09-26T03:15:00Z');
  const lines: string[] = [];
  const retention: FailedWorkspaceRetention = {
    keep: 5,
    maxAgeHours: 72,
    now: () => now,
    log: (level, line) => void lines.push(`${level}: ${line}`),
  };
  type Retained = {
    jobId: string;
    runId?: string;
    role?: string;
    code: number;
    reason: string;
    retainedAt: string;
    expiresAt: string;
  };
  const readRetained = async (directory: string) =>
    JSON.parse(await readFile(join(directory, 'RETAINED.json'), 'utf8')) as Retained;
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  /** A one-commit repository the job can be materialised from. */
  async function fixtureRepository(): Promise<{ source: string; revision: string }> {
    await mkdir(fixtureRoot, { recursive: true });
    const source = await mkdtemp(join(fixtureRoot, 'retention-'));
    git(['init'], source);
    git(['config', 'user.email', 'worker-test@example.invalid'], source);
    git(['config', 'user.name', 'Worker Test'], source);
    await writeFile(join(source, 'tracked.txt'), 'tracked\n');
    git(['add', 'tracked.txt'], source);
    git(['commit', '-m', 'fixture'], source);
    return { source, revision: git(['rev-parse', 'HEAD'], source).trim() };
  }

  /** A command job that runs `node job.js`, the script arriving as an untracked file. */
  function commandJob(fixture: { source: string; revision: string }, script: string) {
    return {
      executable: process.execPath,
      args: ['job.js'],
      workspace: {
        repositoryUrl: fixture.source,
        revision: fixture.revision,
        patch: '',
        untrackedFiles: [
          {
            path: 'job.js',
            contentBase64: Buffer.from(script).toString('base64'),
            executable: false,
          },
        ],
      },
      workingDirectory: '.',
    };
  }

  it('keeps a failing command job under .failed with RETAINED.json and reports the path', async () => {
    const fixture = await fixtureRepository();
    let retained: string | undefined;
    try {
      const result = await executeTransportedJob(
        commandJob(
          fixture,
          "process.stderr.write('boom: the build fell over\\n'); process.exitCode = 3;",
        ),
        new AbortController().signal,
        'retain-fail',
        undefined,
        [],
        retention,
      );
      retained = result.retainedWorkspace;
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('boom: the build fell over');
      expect(retained).toBeDefined();
      // <root>/.failed/<yyyyMMddTHHmmss>-<jobId>, under the real workspace root.
      expect(basename(retained!)).toBe('20260926T031500-retain-fail');
      expect(dirname(dirname(retained!))).toBe(await workspaceRoot());
      expect(basename(dirname(retained!))).toBe('.failed');
      // The checkout moved as the job left it (line endings are git's, per
      // host autocrlf), and the .job-<id> directory is gone.
      expect(await readFile(join(retained!, 'tracked.txt'), 'utf8')).toMatch(/^tracked\r?\n$/);
      expect(await exists(join(retained!, 'job.js'))).toBe(true);
      expect(await exists(join(await workspaceRoot(), '.job-retain-fail'))).toBe(false);
      expect(await readRetained(retained!)).toEqual({
        jobId: 'retain-fail',
        code: 3,
        reason: 'boom: the build fell over',
        retainedAt: '2026-09-26T03:15:00.000Z',
        expiresAt: '2026-09-29T03:15:00.000Z',
      });
      expect(lines).toContainEqual(
        `info: failed workspaces: kept ${retained} (job retain-fail, code 3; expires 2026-09-29T03:15:00.000Z)`,
      );
    } finally {
      if (retained) await rm(retained, { recursive: true, force: true });
      await rm(fixture.source, { recursive: true, force: true });
    }
  });

  it('keeps the workspace when the job throws before running, as a failed result', async () => {
    const fixture = await fixtureRepository();
    let retained: string | undefined;
    try {
      const result = await executeTransportedJob(
        { ...commandJob(fixture, ''), workingDirectory: 'missing' },
        new AbortController().signal,
        'retain-throw',
        undefined,
        [],
        retention,
      );
      retained = result.retainedWorkspace;
      expect(result.code).toBe(-1);
      expect(result.stderr).toMatch(/ENOENT/);
      expect(retained).toBeDefined();
      expect((await readRetained(retained!)).reason).toBe(result.stderr);
    } finally {
      if (retained) await rm(retained, { recursive: true, force: true });
      await rm(fixture.source, { recursive: true, force: true });
    }
  });

  it('keeps a cancelled job with the cancellation as its reason', async () => {
    const fixture = await fixtureRepository();
    const controller = new AbortController();
    let retained: string | undefined;
    try {
      // The job announces itself with a marker file so the abort lands on the
      // running job, not on the materialisation (whose duration depends on how
      // loaded the machine is).
      const marker = join(await workspaceRoot(), '.job-retain-cancel', 'started.txt');
      const execution = executeTransportedJob(
        commandJob(
          fixture,
          "require('node:fs').writeFileSync('started.txt', 'started'); setTimeout(() => {}, 20000);",
        ),
        controller.signal,
        'retain-cancel',
        undefined,
        [],
        retention,
      );
      const deadline = Date.now() + 15_000;
      while (!(await exists(marker)) && Date.now() < deadline)
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      controller.abort(new Error('Job cancellation requested by coordinator'));
      const result = await execution;
      retained = result.retainedWorkspace;
      expect(result.code).not.toBe(0);
      expect(retained).toBeDefined();
      expect(await readRetained(retained!)).toMatchObject({
        jobId: 'retain-cancel',
        code: -1,
        reason: 'Job cancellation requested by coordinator',
      });
    } finally {
      if (retained) await rm(retained, { recursive: true, force: true });
      await rm(fixture.source, { recursive: true, force: true });
    }
  });

  it('removes a succeeding job, and a failing one when KEEP is 0', async () => {
    const fixture = await fixtureRepository();
    try {
      const succeeded = await executeTransportedJob(
        commandJob(fixture, "console.log('fine');"),
        new AbortController().signal,
        'retain-ok',
        undefined,
        [],
        retention,
      );
      expect(succeeded.code).toBe(0);
      expect(succeeded).not.toHaveProperty('retainedWorkspace');
      const root = await workspaceRoot();
      expect(await exists(join(root, '.job-retain-ok'))).toBe(false);
      expect(await exists(join(root, '.failed', '20260926T031500-retain-ok'))).toBe(false);

      const failed = await executeTransportedJob(
        commandJob(fixture, 'process.exitCode = 1;'),
        new AbortController().signal,
        'retain-off',
        undefined,
        [],
        { ...retention, keep: 0 },
      );
      expect(failed.code).toBe(1);
      expect(failed).not.toHaveProperty('retainedWorkspace');
      expect(await exists(join(root, '.job-retain-off'))).toBe(false);
      expect(await exists(join(root, '.failed', '20260926T031500-retain-off'))).toBe(false);
    } finally {
      await rm(fixture.source, { recursive: true, force: true });
    }
  });

  it('sweeps beyond the newest KEEP and past MAX_AGE_HOURS, touching nothing else', async () => {
    await mkdir(fixtureRoot, { recursive: true });
    const root = await mkdtemp(join(fixtureRoot, 'sweep-'));
    try {
      // Nothing to sweep is nothing to do, not an error.
      expect(await sweepFailedWorkspaces(root, retention)).toEqual([]);
      const failedRoot = join(root, '.failed');
      const entries = [
        '20260926T030000-a', // 15 minutes old
        '20260926T020000-b',
        '20260926T010000-c',
        '20260923T030000-d', // 72 h 15 min old: aged, though within the newest four
        '20260901T000000-e', // beyond the newest four
        'notes', // an operator's directory: no worker stamp, never touched
        'keep-20260926T030000-f', // a renamed entry is the operator's now
      ];
      for (const name of entries) {
        await mkdir(join(failedRoot, name), { recursive: true });
        await writeFile(join(failedRoot, name, 'file.txt'), name);
      }
      await writeFile(join(failedRoot, 'README.txt'), 'a file, not an entry');
      const swept: string[] = [];
      const removed = await sweepFailedWorkspaces(root, {
        ...retention,
        keep: 4,
        log: (level, line) => void swept.push(`${level}: ${line}`),
      });
      expect(removed).toEqual([
        join(failedRoot, '20260923T030000-d'),
        join(failedRoot, '20260901T000000-e'),
      ]);
      expect((await readdir(failedRoot)).sort()).toEqual([
        '20260926T010000-c',
        '20260926T020000-b',
        '20260926T030000-a',
        'README.txt',
        'keep-20260926T030000-f',
        'notes',
      ]);
      expect(swept).toEqual([
        `info: failed workspaces: removed ${join(failedRoot, '20260923T030000-d')} (older than 72 h)`,
        `info: failed workspaces: removed ${join(failedRoot, '20260901T000000-e')} (beyond the newest 4)`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a busy rename and falls back to removal when it stays busy', async () => {
    await mkdir(fixtureRoot, { recursive: true });
    const root = await mkdtemp(join(fixtureRoot, 'busy-'));
    const busy = (code: 'EBUSY' | 'EPERM') =>
      Object.assign(new Error(`${code}: resource busy or locked`), { code });
    try {
      // Fails twice as a lingering container's bind mount would, then lets go.
      const workspace = join(root, '.job-busy');
      await mkdir(workspace);
      await writeFile(join(workspace, 'output.txt'), 'partial');
      let attempts = 0;
      const warnings: string[] = [];
      const retained = await retainFailedWorkspace(
        workspace,
        { jobId: 'busy', runId: 'run-1', role: 'builder', code: 1, reason: 'exit code 1' },
        {
          ...retention,
          retryDelayMs: 1,
          rename: async (from, to) => {
            attempts += 1;
            if (attempts <= 2) throw busy(attempts === 1 ? 'EBUSY' : 'EPERM');
            await rename(from, to);
          },
          log: (level, line) => void (level === 'warn' && warnings.push(line)),
        },
      );
      expect(attempts).toBe(3);
      expect(retained).toBe(join(root, '.failed', '20260926T031500-busy'));
      expect(await readFile(join(retained!, 'output.txt'), 'utf8')).toBe('partial');
      expect(await readRetained(retained!)).toMatchObject({
        jobId: 'busy',
        runId: 'run-1',
        role: 'builder',
        code: 1,
      });
      expect(await exists(workspace)).toBe(false);
      expect(warnings).toEqual([]);

      // Still busy after five attempts: removed as before retention, with a warning.
      const stuck = join(root, '.job-stuck');
      await mkdir(stuck);
      attempts = 0;
      const outcome = await retainFailedWorkspace(
        stuck,
        { jobId: 'stuck', code: 1, reason: 'exit code 1' },
        {
          ...retention,
          retryDelayMs: 1,
          rename: async () => {
            attempts += 1;
            throw busy('EBUSY');
          },
          log: (level, line) => void (level === 'warn' && warnings.push(line)),
        },
      );
      expect(outcome).toBeUndefined();
      expect(attempts).toBe(5);
      expect(await exists(stuck)).toBe(false);
      expect(await exists(join(root, '.failed', '20260926T031500-stuck'))).toBe(false);
      expect(warnings).toEqual([
        `failed workspaces: could not move ${stuck} to ${join(root, '.failed', '20260926T031500-stuck')} after 5 attempt(s) (EBUSY: resource busy or locked); removing it instead`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('worker executor', () => {
  it('executes allowlisted commands and redacts output', async () => {
    const root = join(process.cwd(), '.forge', 'workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'worker-'));
    const script = join(workspace, 'redact-test.js');
    await writeFile(script, "console.log('token=supersecretvalue')\n");
    const result = await executeCommand(
      {
        executable: process.execPath,
        args: [script],
        cwd: workspace,
      },
      { knownSecrets: ['supersecretvalue'] },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[REDACTED]');
  });

  it('denies interpreter, package runner, network Git, and traversal escapes', async () => {
    const root = join(process.cwd(), '.forge', 'workspaces');
    const workspace = join(root, 'policy-fixture');
    await mkdir(workspace, { recursive: true });
    const actions = [
      { executable: 'node', args: ['-e', 'process.exit(0)'], cwd: workspace },
      { executable: 'pnpm', args: ['dlx', 'untrusted-package'], cwd: workspace },
      { executable: 'git', args: ['push', 'origin', 'main'], cwd: workspace },
      { executable: 'node', args: ['--version'], cwd: join(root, '..', '..', 'outside') },
    ];
    for (const action of actions) await expect(executeCommand(action)).rejects.toThrow('approval');
  });

  it('does not pass coordinator or worker secrets to child processes', async () => {
    const root = join(process.cwd(), '.forge', 'workspaces');
    const workspace = await mkdtemp(join(root, 'environment-'));
    const script = join(workspace, 'environment-test.js');
    await writeFile(
      script,
      "console.log(process.env.FORGE_WORKER_TOKEN ?? 'missing', process.env.GITHUB_TOKEN ?? 'missing')\n",
    );
    const result = await executeCommand({
      executable: process.execPath,
      args: [script],
      cwd: workspace,
    });
    expect(result.stdout.trim()).toBe('missing missing');
  });

  it('denies an unapproved destructive command before spawn', async () => {
    const workspace = join(process.cwd(), '.forge', 'workspaces', 'denied');
    await mkdir(workspace, { recursive: true });
    await expect(
      executeCommand({ executable: 'rm', args: ['-rf', 'target'], cwd: workspace }),
    ).rejects.toThrow('requires an exact active approval');
  });

  it('rejects a workspace symlink that resolves outside the managed root', async () => {
    const root = join(process.cwd(), '.forge', 'workspaces');
    await mkdir(root, { recursive: true });
    const outside = await mkdtemp(join(process.cwd(), '.forge', 'outside-'));
    const link = join(await mkdtemp(join(root, 'symlink-')), 'escape');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      executeCommand({ executable: 'git', args: ['status'], cwd: link }),
    ).rejects.toThrow('workspace symlink escape');
  });
});

/**
 * Ids of running containers carrying the sandbox label. Shared by the Docker
 * suite so a test can compare what it left behind against what it inherited.
 */
function aliveSandboxIds(): string[] {
  return execFileSync('docker', ['ps', '-q', '--filter', 'label=theforge.worker=test-worker'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('Docker worker sandbox', () => {
  it('gives provider jobs only workspace access and bridge API egress', async () => {
    const root = resolve('.forge/workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'provider-sandbox-'));
    const args = createProviderDockerRunArgs('codex', workspace, 'provider-boundary-test', [
      '--version',
    ]);
    expect(args).toContain('--read-only');
    expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual([
      '--cap-drop',
      'ALL',
    ]);
    expect(args.slice(args.indexOf('--security-opt'), args.indexOf('--security-opt') + 2)).toEqual([
      '--security-opt',
      'no-new-privileges=true',
    ]);
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual([
      '--network',
      'bridge',
    ]);
    expect(args).not.toContain('host');
    expect(args.filter((value) => value === '--mount')).toHaveLength(1);
    expect(args[args.indexOf('--mount') + 1]).toBe(`type=bind,src=${workspace},dst=/workspace`);
    expect(args).toContain(`${expectedSandboxUid}:${expectedSandboxGid}`);
    expect(args).not.toContain('test-provider-secret');
  });

  /**
   * ADR-030. The container is the sandbox, so the CLI inside it is told not to
   * nest one of its own. The marker is set here, where the container is
   * launched, and nowhere else - a provider process on the host never sees it.
   */
  it('marks every provider container as externally sandboxed', async () => {
    const root = resolve('.forge/workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'provider-marker-'));
    for (const providerId of ['codex', 'claude'] as const) {
      const args = createProviderDockerRunArgs(
        providerId,
        workspace,
        'provider-marker-test',
        ['--version'],
        null,
      );
      expect(args).toContain('FORGE_EXTERNALLY_SANDBOXED=1');
      expect(args).toContain('HOME=/home/node');
      expect(args.filter((value) => value === '--env')).toHaveLength(2);
    }
    expect(process.env.FORGE_EXTERNALLY_SANDBOXED).toBeUndefined();
  });

  it('gives Claude only an API key, and Codex a key first and then its auth file', () => {
    const everything = {
      ANTHROPIC_API_KEY: 'sk-ant-api-key',
      OPENAI_API_KEY: 'sk-openai-key',
      FORGE_CODEX_AUTH_FILE: 'C:/vault/codex.json',
    };
    expect(credentialSourceFor('claude', everything)).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api-key',
    });
    // Claude never borrows another provider's file.
    expect(
      credentialSourceFor('claude', { FORGE_CODEX_AUTH_FILE: 'C:/vault/codex.json' }),
    ).toMatchObject({ kind: 'none' });
    expect(credentialSourceFor('codex', everything)).toEqual({
      kind: 'api-key',
      value: 'sk-openai-key',
    });
    expect(credentialSourceFor('codex', { ...everything, OPENAI_API_KEY: undefined })).toEqual({
      kind: 'auth-file',
      path: 'C:/vault/codex.json',
    });
  });

  /**
   * ADR-039. A key that is not scoped to a workspace is refused by the API unless every request
   * names one; the Claude CLI adds `ANTHROPIC_CUSTOM_HEADERS` to each request it makes. The id is
   * not a secret, so it is a plain `--env`, and only the Claude container gets it.
   */
  it('passes the Anthropic workspace id to the Claude container only', async () => {
    const root = resolve('.forge/workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'provider-workspace-id-'));
    const id = 'wrkspc_01ExampleWorkspaceId';
    const claude = createProviderDockerRunArgs('claude', workspace, 'ws-claude', ['--version'], id);
    expect(claude).toContain(`ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: ${id}`);
    expect(claude.filter((value) => value === '--env')).toHaveLength(3);
    const codex = createProviderDockerRunArgs('codex', workspace, 'ws-codex', ['--version'], id);
    expect(codex.join(' ')).not.toContain('ANTHROPIC_CUSTOM_HEADERS');
    expect(codex.join(' ')).not.toContain(id);
    // Unset means no header, exactly as before ADR-039.
    const none = createProviderDockerRunArgs('claude', workspace, 'ws-none', ['--version'], null);
    expect(none.join(' ')).not.toContain('ANTHROPIC_CUSTOM_HEADERS');
  });

  it.runIf(dockerSandboxAvailable)(
    'starts the provider CLI through the credential-stdin entrypoint',
    async () => {
      const root = resolve('.forge/workspaces');
      await mkdir(root, { recursive: true });
      const workspace = await mkdtemp(join(root, 'provider-entrypoint-'));
      const args = createProviderDockerRunArgs('codex', workspace, 'provider-entrypoint-test', [
        '--version',
      ]);
      const credential = {
        kind: 'api-key',
        contentBase64: Buffer.from('test-provider-secret').toString('base64'),
      };
      const result = spawnSync('docker', args, {
        input: `${JSON.stringify(credential)}\n`,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/codex-cli|codex/i);
    },
    45_000,
  );

  it.runIf(dockerSandboxAvailable)(
    'runs non-root with a read-only host and no network while preserving workspace writes',
    async () => {
      const root = resolve('.forge/workspaces');
      await mkdir(root, { recursive: true });
      const workspace = await mkdtemp(join(root, 'docker-sandbox-'));
      const result = await executeDockerCommand(
        {
          executable: 'node',
          args: [
            '-e',
            [
              "const fs=require('fs')",
              "fs.writeFileSync('proof.txt','ok')",
              "let root='writable'",
              "try{fs.writeFileSync('/escape','no')}catch{root='readonly'}",
              "fetch('https://example.com').then(()=>process.exit(9)).catch(()=>console.log(JSON.stringify({uid:process.getuid(),root,network:'blocked',arg:process.argv[1]})))",
            ].join(';'),
            '$(touch should-not-exist)',
          ],
          cwd: workspace,
        },
        {},
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        uid: expectedSandboxUid,
        root: 'readonly',
        network: 'blocked',
        arg: '$(touch should-not-exist)',
      });
      expect(await readFile(join(workspace, 'proof.txt'), 'utf8')).toBe('ok');
      await expect(access(join(workspace, 'should-not-exist'))).rejects.toThrow();
    },
    30_000,
  );

  it.runIf(dockerSandboxAvailable)(
    'stops the container when execution is cancelled',
    async () => {
      const root = resolve('.forge/workspaces');
      await mkdir(root, { recursive: true });
      const workspace = await mkdtemp(join(root, 'docker-cancel-'));
      // Taken before anything starts, so the assertion below is about what this
      // execution leaves behind rather than about the machine's whole state.
      const before = aliveSandboxIds();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);
      const result = await executeDockerCommand(
        { executable: 'node', args: ['-e', 'setInterval(()=>{},1000)'], cwd: workspace },
        { signal: controller.signal },
      );
      expect(result.code).not.toBe(0);
      // The name of this test claims the container stops. It once asserted only
      // the exit code, which the *local* process ending is enough to produce -
      // so a cancellation that killed the host process and left the container
      // running would have passed. The fixture's command never exits on its
      // own, so a container of this execution's still alive here is a leak.
      //
      // Filtered by label rather than by name, because the name is generated
      // inside `executeDockerCommand` and not returned. What changed on
      // 06/10/2026 is the comparison: this used to assert that NO labelled
      // container was running anywhere, which is a claim about the machine
      // rather than about this execution. Any container left by an earlier run
      // - including one the setup sweep failed to remove - therefore failed
      // this test, three times in one day, on changes that could not have
      // caused it. Worse, the symptom was identical to a real leak, so the next
      // genuine regression here would have read as "the flaky one".
      //
      // Comparing against the set alive beforehand keeps the real assertion
      // exactly as strong - a leak adds an id - while making it about what this
      // test did.
      const stillAlive = new Set(aliveSandboxIds());
      for (const id of before) stillAlive.delete(id);
      expect([...stillAlive], 'this execution left a container running').toEqual([]);
    },
    30_000,
  );
});

describe('sandbox isolation by boundary', () => {
  const argsFor = (network: 'none' | 'install' | 'provider-api') =>
    dockerIsolationArgs('C:/forge/workspaces/w', 'theforge-test', network).join(' ');

  it('gives an install step room to download a real application, and nothing else does', () => {
    // `npm ci` for PulseApp hit ENOSPC on attempt ten of the first real
    // objective: npm caches in /home/node/.npm and that tmpfs was 64 MB, which
    // does not hold Next.js, Prisma and Playwright.
    expect(argsFor('install')).toContain('/home/node:rw,nosuid,nodev,size=2g');
    expect(argsFor('install')).toContain('/tmp:rw,nosuid,nodev,size=1g');

    // The boundary that matters: a container running checks, or anything the
    // agent wrote, keeps the small limits it has always had. Raising them for
    // the install step must not raise them for everything.
    for (const boundary of ['none', 'provider-api'] as const) {
      expect(argsFor(boundary), boundary).toContain('/home/node:rw,nosuid,nodev,size=64m');
      expect(argsFor(boundary), boundary).toContain('/tmp:rw,nosuid,nodev,size=256m');
    }
  });

  it('opens the network for install and provider work only', () => {
    // Pinned alongside the sizes because they are set by the same argument and
    // a mistake in either one is a sandbox with more than it should have.
    expect(argsFor('none')).toContain('--network none');
    expect(argsFor('install')).toContain('--network bridge');
    expect(argsFor('provider-api')).toContain('--network bridge');
  });

  it('keeps every other restriction identical whatever the boundary', () => {
    // A guard against a future size or network change quietly dropping one of
    // these: the only differences between boundaries should be the network and
    // the two tmpfs sizes.
    for (const boundary of ['none', 'install', 'provider-api'] as const) {
      const args = argsFor(boundary);
      for (const restriction of [
        '--read-only',
        '--cap-drop ALL',
        '--security-opt no-new-privileges=true',
        '--pids-limit 256',
        '--memory 2g',
        '--memory-swap 2g',
        '--cpus 2',
      ]) {
        expect(args, `${boundary} is missing ${restriction}`).toContain(restriction);
      }
    }
  });
});

describe('stepped verification jobs', () => {
  const fixtureRoot = join(process.cwd(), '.forge', 'transport-fixtures');
  // Retention off: these jobs are about sequencing, and a kept workspace per
  // failing case would leave .failed directories behind for no assertion.
  const retention: FailedWorkspaceRetention = { keep: 0, maxAgeHours: 0 };

  /**
   * A command job whose `steps` run the named scripts in order. Every script
   * arrives as an untracked file in the one workspace the job materialises,
   * which is the whole point: a step can see what the step before it wrote.
   */
  async function steppedJob(
    scripts: Record<string, string>,
    steps: Array<{ file: string; stopOnFailure?: boolean }>,
  ) {
    await mkdir(fixtureRoot, { recursive: true });
    const source = await mkdtemp(join(fixtureRoot, 'stepped-'));
    git(['init'], source);
    git(['config', 'user.email', 'worker-test@example.invalid'], source);
    git(['config', 'user.name', 'Worker Test'], source);
    await writeFile(join(source, 'tracked.txt'), 'tracked\n');
    git(['add', 'tracked.txt'], source);
    git(['commit', '-m', 'fixture'], source);
    return {
      executable: process.execPath,
      args: [steps[0]!.file],
      workspace: {
        repositoryUrl: source,
        revision: git(['rev-parse', 'HEAD'], source).trim(),
        patch: '',
        untrackedFiles: Object.entries(scripts).map(([path, script]) => ({
          path,
          contentBase64: Buffer.from(script).toString('base64'),
          executable: false,
        })),
      },
      workingDirectory: '.',
      steps: steps.map((step) => ({
        executable: process.execPath,
        args: [step.file],
        ...(step.stopOnFailure ? { stopOnFailure: true } : {}),
      })),
    };
  }

  it('runs every step in order in the one workspace the job materialised', async () => {
    // The reason this exists. The worker materialises `.job-<id>` and removes
    // it in a `finally`, so an install in a job of its own installs into a
    // directory that is then deleted - `npm ci` exited 0 on attempt eleven of
    // the first real objective and the three checks that needed its output
    // each reported 127 in their own fresh copies of the repository.
    const job = await steppedJob(
      {
        'install.js': "require('node:fs').writeFileSync('installed.marker', 'installed');",
        'lint.js':
          "process.stdout.write('lint saw ' + require('node:fs').readFileSync('installed.marker', 'utf8'));",
        'test.js':
          "process.stdout.write('test saw ' + require('node:fs').readFileSync('installed.marker', 'utf8'));",
      },
      [{ file: 'install.js', stopOnFailure: true }, { file: 'lint.js' }, { file: 'test.js' }],
    );
    const result = await executeTransportedJob(
      job,
      new AbortController().signal,
      'stepped-order',
      undefined,
      [],
      retention,
    );

    expect(result.code).toBe(0);
    expect(result.steps?.map((step) => step.code)).toEqual([0, 0, 0]);
    expect(result.steps?.[1]?.stdout).toContain('lint saw installed');
    expect(result.steps?.[2]?.stdout).toContain('test saw installed');
    // In order, and each named by the command it ran.
    expect(result.steps?.map((step) => basename(step.command.split(' ').pop()!))).toEqual([
      'install.js',
      'lint.js',
      'test.js',
    ]);
  });

  it('ends the sequence at a failing step marked stopOnFailure', async () => {
    const job = await steppedJob(
      {
        'install.js': "process.stderr.write('registry unreachable\\n'); process.exitCode = 7;",
        'test.js': "process.stdout.write('ran anyway');",
      },
      [{ file: 'install.js', stopOnFailure: true }, { file: 'test.js' }],
    );
    const result = await executeTransportedJob(
      job,
      new AbortController().signal,
      'stepped-halt',
      undefined,
      [],
      retention,
    );

    expect(result.code).toBe(7);
    // One outcome: the check never ran, so it cannot report a 127 on top of
    // the real reason.
    expect(result.steps).toHaveLength(1);
    expect(result.stderr).toContain('registry unreachable');
    // Named, because the output of one of several commands otherwise arrives
    // with nothing saying which it was.
    expect(result.stderr).toContain('install.js');
  });

  it('runs the remaining checks past a failure and still reports the job as failed', async () => {
    // Both halves matter. Checks run on, because the revision loop fixes what
    // it is shown and a lint failure hiding a test failure costs a whole extra
    // round. And the job still fails: reporting the LAST step's code would
    // have called this verification a pass.
    const job = await steppedJob(
      {
        'lint.js': "process.stdout.write('lint ok');",
        'unit.js': "process.stderr.write('2 tests failed\\n'); process.exitCode = 1;",
        'types.js': "process.stdout.write('types ok');",
      },
      [{ file: 'lint.js' }, { file: 'unit.js' }, { file: 'types.js' }],
    );
    const result = await executeTransportedJob(
      job,
      new AbortController().signal,
      'stepped-continue',
      undefined,
      [],
      retention,
    );

    expect(result.steps?.map((step) => step.code)).toEqual([0, 1, 0]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('2 tests failed');
    expect(result.stderr).toContain('unit.js');
  });

  it('records a step that could not be started rather than losing the ones that ran', async () => {
    // A step can throw instead of exiting - a refused classification, a
    // containment failure. Caught per step, so the evidence from the steps
    // that did run survives. `node -e` is classified red, which the sandbox
    // refuses without an exact active approval.
    const job = await steppedJob({ 'lint.js': "process.stdout.write('lint ok');" }, [
      { file: 'lint.js' },
    ]);
    const result = await executeTransportedJob(
      {
        ...job,
        steps: [...job.steps, { executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
      },
      new AbortController().signal,
      'stepped-throw',
      undefined,
      [],
      retention,
    );

    expect(result.steps?.map((step) => step.code)).toEqual([0, -1]);
    expect(result.code).toBe(-1);
  });
});

describe('worker completion transport', () => {
  type CompletionBody = {
    leaseToken: string;
    code: number;
    stderr: string;
    events?: Array<{ type: string; code?: string; message?: string; retryable?: boolean }>;
    patch?: string;
  };
  const parse = (body: string | undefined) => JSON.parse(body ?? 'null') as CompletionBody;

  it('refuses to capture a builder patch over MAX_PATCH_BYTES', async () => {
    const fixtureRoot = join(process.cwd(), '.forge', 'transport-fixtures');
    await mkdir(fixtureRoot, { recursive: true });
    const workspace = await mkdtemp(join(fixtureRoot, 'patch-cap-'));
    try {
      git(['init'], workspace);
      git(['config', 'user.email', 'worker-test@example.invalid'], workspace);
      git(['config', 'user.name', 'Worker Test'], workspace);
      await writeFile(join(workspace, 'tracked.txt'), 'before\n');
      git(['add', 'tracked.txt'], workspace);
      git(['commit', '-m', 'fixture'], workspace);
      const signal = new AbortController().signal;
      await writeFile(join(workspace, 'tracked.txt'), 'after\n');
      expect(await captureAttemptPatch(workspace, signal)).toContain('+after');
      await writeFile(join(workspace, 'huge.txt'), 'a'.repeat(MAX_PATCH_BYTES + 1));
      await expect(captureAttemptPatch(workspace, signal)).rejects.toThrow(
        new RegExp(
          `^builder patch too large \\(\\d+ bytes > ${MAX_PATCH_BYTES}\\); refusing to transport$`,
        ),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('re-posts a rejected completion once, without the patch and with a real error', async () => {
    const bodies: string[] = [];
    const post = async (body: string) => {
      bodies.push(body);
      if (bodies.length === 1)
        throw new CoordinatorRequestError(
          '/complete',
          400,
          '{"error":"invalid_request","message":"patch exceeds MAX_PATCH_BYTES"}',
        );
    };
    await submitJobCompletion(post, 'job-1', 'lease-1', {
      code: 0,
      stdout: '',
      stderr: '',
      events: [{ type: 'completed', output: 'done' }],
      patch: 'diff --git a/x b/x',
    });
    expect(bodies).toHaveLength(2);
    expect(parse(bodies[0]).patch).toBe('diff --git a/x b/x');
    const retry = parse(bodies[1]);
    expect(retry).not.toHaveProperty('patch');
    expect(retry.leaseToken).toBe('lease-1');
    expect(retry.code).toBe(1);
    expect(retry.stderr).toContain('coordinator rejected the completion (400)');
    expect(retry.stderr).toContain('patch exceeds MAX_PATCH_BYTES');
    expect(retry.events?.at(-1)).toMatchObject({
      type: 'error',
      code: 'COMPLETION_REJECTED',
      retryable: false,
    });
  });

  it('does not re-post when the lease itself was refused', async () => {
    const bodies: string[] = [];
    await submitJobCompletion(
      async (body) => {
        bodies.push(body);
        throw new CoordinatorRequestError('/complete', 409, '{"error":"job_lease_invalid"}');
      },
      'job-2',
      'lease-2',
      { code: 0, stdout: '', stderr: '', patch: 'diff' },
    );
    expect(bodies).toHaveLength(1);
  });

  it('fails a completion whose serialised body exceeds the transport cap before sending', async () => {
    const bodies: string[] = [];
    // Every byte of this patch escapes to six under JSON, which is how a patch
    // under MAX_PATCH_BYTES can still overflow the body cap.
    await submitJobCompletion(
      async (body) => {
        bodies.push(body);
      },
      'job-3',
      'lease-3',
      { code: 0, stdout: '', stderr: '', events: [], patch: '\u0001'.repeat(3_000_000) },
    );
    expect(bodies).toHaveLength(1);
    expect(Buffer.byteLength(bodies[0] ?? '')).toBeLessThan(MAX_COMPLETION_BODY_BYTES);
    const sent = parse(bodies[0]);
    expect(sent).not.toHaveProperty('patch');
    expect(sent.code).toBe(1);
    expect(sent.stderr).toMatch(
      /^worker completion too large \(\d+ bytes > \d+\); refusing to transport$/,
    );
    expect(sent.events).toEqual([
      { type: 'error', code: 'COMPLETION_TOO_LARGE', message: sent.stderr, retryable: false },
    ]);
  });
});

describe('worker local models', () => {
  const localRequest: ProviderRequest = {
    runId: 'run-local',
    taskId: 'run-local-planner',
    role: 'planner',
    prompt: 'Plan it.',
    context: [],
    timeoutMs: 10_000,
    model: 'qwen3:8b',
  };

  it('advertises provider:ollama and one model capability per listed model', async () => {
    const fake = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }, { name: 'devstral-small-2:latest' }],
    });
    try {
      expect(await probeOllamaCapabilities(fake.url)).toEqual({
        capabilities: ['provider:ollama', 'model:qwen3:8b', 'model:devstral-small-2:latest'],
        detail: `ollama: advertising 2 model(s) from ${fake.url}: qwen3:8b, devstral-small-2:latest`,
      });
    } finally {
      await fake.close();
    }
    // A server that is not there is one log line and no capability, never a
    // failed startup.
    const down = await probeOllamaCapabilities(fake.url, 1_000);
    expect(down.capabilities).toEqual([]);
    expect(down.detail).toContain(`ollama: not reachable at ${fake.url}`);
    expect(down.detail).toContain('provider:ollama not advertised');
  });

  it('picks the measured num_ctx for a tier model and the server default otherwise', () => {
    expect(ollamaContextFor('qwen3:8b')).toBe(8_192);
    expect(ollamaContextFor('devstral-small-2:latest')).toBe(16_384);
    expect(ollamaContextFor('nomic-embed-text:latest')).toBeUndefined();
  });

  it('runs an ollama job in this process with the requested model, under the limits and redaction', async () => {
    const fake = await startFakeOllama({
      chat: {
        kind: 'stream',
        chunks: ['the token ', 'test-worker-token-that-is-long-enough', ' leaked'],
        promptEvalCount: 9,
        evalCount: 4,
      },
    });
    const root = join(process.cwd(), '.forge', 'workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'ollama-job-'));
    try {
      const result = await executeProviderJob(
        { providerId: 'ollama', request: localRequest, cwd: workspace },
        new AbortController().signal,
        { ollamaUrl: fake.url },
      );
      expect(result.code, result.stderr).toBe(0);
      // A planner: no patch, as for any non-builder role.
      expect(result).not.toHaveProperty('patch');
      expect(result.events.map((event) => event.type)).toEqual([
        'text_delta',
        'text_delta',
        'text_delta',
        'usage',
        'completed',
      ]);
      expect(result.events[3]).toEqual({ type: 'usage', inputTokens: 9, outputTokens: 4, usd: 0 });
      // The request's model went to the server with the tier-1 context.
      expect(fake.chats[0]).toMatchObject({
        model: 'qwen3:8b',
        think: false,
        options: { temperature: 0, num_ctx: 8_192 },
      });
      // The worker token is redacted from what the model said, exactly as for
      // a sandboxed CLI provider.
      const serialised = JSON.stringify(result.events);
      expect(serialised).not.toContain('test-worker-token-that-is-long-enough');
      expect(serialised).toContain('[REDACTED]');
    } finally {
      await fake.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports a missing local model as a failed job carrying the server error', async () => {
    const fake = await startFakeOllama({ models: [{ name: 'qwen3:8b' }] });
    const root = join(process.cwd(), '.forge', 'workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'ollama-missing-'));
    try {
      const result = await executeProviderJob(
        {
          providerId: 'ollama',
          request: { ...localRequest, model: 'missing:latest' },
          cwd: workspace,
        },
        new AbortController().signal,
        { ollamaUrl: fake.url },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("model 'missing:latest' not found");
      expect(result.events).toEqual([
        expect.objectContaining({ type: 'error', code: 'PROCESS_EXIT', retryable: false }),
      ]);
    } finally {
      await fake.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('worker per-task limits', () => {
  // A scripted provider that never finishes on its own: it keeps issuing tool
  // requests until it is told to stop, which is exactly the shape of task the
  // limits exist for. It records whether it saw the abort.
  class RunawayProvider implements ProviderAdapter {
    readonly id = 'runaway';
    readonly capabilities = {
      streaming: true,
      resume: false,
      tools: true,
      structuredOutput: false,
      usage: true,
    };
    aborted = false;
    yielded = 0;
    constructor(private readonly script: ProviderEvent[] = []) {}
    async diagnose() {
      return { available: true, authenticated: true, detail: 'runaway' };
    }
    async *run(_request: ProviderRequest, options: { cwd: string; signal?: AbortSignal }) {
      options.signal?.addEventListener('abort', () => (this.aborted = true), { once: true });
      for (const event of this.script) {
        if (options.signal?.aborted) break;
        this.yielded += 1;
        yield event;
      }
      for (let index = 0; index < 10_000; index += 1) {
        if (options.signal?.aborted) {
          yield {
            type: 'error' as const,
            code: 'CANCELLED',
            message: 'cancelled',
            retryable: false,
          };
          return;
        }
        this.yielded += 1;
        yield { type: 'tool_request' as const, name: 'read_file', input: { index } };
      }
    }
  }
  const request: ProviderRequest = {
    runId: 'run-limits',
    taskId: 'run-limits-builder',
    role: 'builder',
    prompt: 'loop forever',
    context: [],
    timeoutMs: 60_000,
  };
  const generous = { maxToolCalls: 100_000, maxWallClockMinutes: 1_440, maxTokens: 100_000_000 };

  it('aborts a provider past the tool-call limit and reports TASK_LIMIT as the failure', async () => {
    const provider = new RunawayProvider();
    const collected = await collectProviderEvents(provider, request, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      redactionValues: [],
      limits: { ...generous, maxToolCalls: 3 },
    });
    expect(collected.limitBreach).toBe('tool call limit exceeded (4 > 3)');
    expect(collected.usage.toolCalls).toBe(4);
    expect(provider.aborted, 'the provider must be told to stop').toBe(true);
    // Four tool requests were let through (the fourth is the one that tripped
    // it), then the synthetic error; the provider's own CANCELLED never lands.
    expect(collected.events.map((event) => event.type)).toEqual([
      'tool_request',
      'tool_request',
      'tool_request',
      'tool_request',
      'error',
    ]);
    const failure = collected.events.find((event) => event.type === 'error');
    expect(failure).toEqual({
      type: 'error',
      code: 'TASK_LIMIT',
      message: 'tool call limit exceeded (4 > 3)',
      retryable: false,
    });
    // The provider yielded at most one event past the trip: the loop stops
    // consuming, it does not drain the remaining 9,996.
    expect(provider.yielded).toBeLessThanOrEqual(5);
  });

  it('trips the token limit from usage events', async () => {
    const provider = new RunawayProvider([
      { type: 'usage', inputTokens: 600, outputTokens: 500, usd: 0 },
      { type: 'usage', inputTokens: 600, outputTokens: 500, usd: 0 },
    ]);
    const collected = await collectProviderEvents(provider, request, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      redactionValues: [],
      limits: { ...generous, maxTokens: 2_000 },
    });
    expect(collected.limitBreach).toBe('token limit exceeded (2200 > 2000)');
    expect(collected.usage.tokens).toBe(2200);
    expect(collected.events.at(-1)).toMatchObject({ type: 'error', code: 'TASK_LIMIT' });
    expect(provider.aborted).toBe(true);
  });

  it('trips the wall-clock limit on the next event with an injected clock', async () => {
    let now = 1_000_000;
    const provider = new RunawayProvider();
    const collected = await collectProviderEvents(provider, request, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      redactionValues: [],
      limits: { ...generous, maxWallClockMinutes: 2 },
      clock: () => {
        // The first reading is the start; every later one is three minutes on.
        const reading = now;
        now = 1_000_000 + 3 * 60_000;
        return reading;
      },
    });
    expect(collected.limitBreach).toBe('time limit exceeded (3.0 > 2 minutes)');
    expect(collected.events.map((event) => event.type)).toEqual(['tool_request', 'error']);
    expect(provider.aborted).toBe(true);
  });

  it('leaves a provider inside its bounds untouched and records what it used', async () => {
    const provider = new RunawayProvider([
      { type: 'tool_request', name: 'read_file', input: {} },
      { type: 'usage', inputTokens: 10, outputTokens: 5, usd: 0 },
      { type: 'completed', output: 'done' },
    ]);
    // The script is followed by the runaway loop, so cap the loop via the
    // limit and check only the scripted prefix was consumed cleanly.
    const collected = await collectProviderEvents(provider, request, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      redactionValues: [],
      limits: { ...generous, maxToolCalls: 2 },
    });
    expect(collected.events.slice(0, 3)).toEqual([
      { type: 'tool_request', name: 'read_file', input: {} },
      { type: 'usage', inputTokens: 10, outputTokens: 5, usd: 0 },
      { type: 'completed', output: 'done' },
    ]);
    expect(collected.usage).toMatchObject({ toolCalls: 3, tokens: 15 });
    expect(collected.limitBreach).toBe('tool call limit exceeded (3 > 2)');
  });

  it('redacts secrets in provider events before they are kept', async () => {
    const provider = new RunawayProvider([
      { type: 'text_delta', text: 'the session value hunter2-hunter2 was printed' },
      { type: 'completed', output: 'done' },
    ]);
    const collected = await collectProviderEvents(provider, request, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      redactionValues: ['hunter2-hunter2'],
      limits: { ...generous, maxToolCalls: 1 },
    });
    const first = collected.events[0];
    expect(first?.type).toBe('text_delta');
    const text = first?.type === 'text_delta' ? first.text : '';
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[REDACTED]');
  });
});

describe('worker raw provider output', () => {
  const plannerRequest: ProviderRequest = {
    runId: 'run-raw',
    taskId: 'run-raw-planner',
    role: 'planner',
    prompt: 'Plan it.',
    context: [],
    timeoutMs: 10_000,
  };
  // What a leaking CLI could print: the worker's own token, the planted
  // credential (both known values), and three shapes only the generic
  // patterns catch - a bare sk- key, an OAuth refresh token in a JSON field
  // and a JWT behind Bearer.
  const workerToken = 'test-worker-token-that-is-long-enough';
  const bareKey = 'sk-abc0123456789abcdef0123456789';
  const refreshToken = '1//0eXAMPLEplantedRefreshTokenValue-abcdefghij';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
  const planted = [workerToken, plantedApiKey, bareKey, refreshToken, jwt];
  const line = (value: unknown) =>
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)})`;
  const failingScript = [
    line({ type: 'system', subtype: 'init', session_id: 'raw-session' }),
    `process.stdout.write(${JSON.stringify(`not json: worker ${workerToken} key ${plantedApiKey} bare ${bareKey}\n`)})`,
    line({
      type: 'tool_result',
      content: { refresh_token: refreshToken, authorization: `Bearer ${jwt}` },
    }),
    `process.stderr.write(${JSON.stringify(`fatal: ANTHROPIC_API_KEY=${plantedApiKey} rejected, refresh_token=${refreshToken}\n`)})`,
    'process.exitCode = 1',
  ].join(';');
  const successScript = [
    line({ type: 'system', subtype: 'init', session_id: 'raw-session' }),
    "process.stderr.write('note: nothing wrong\\n')",
    line({
      type: 'result',
      subtype: 'success',
      result: 'planned',
      session_id: 'raw-session',
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0,
    }),
  ].join(';');
  /**
   * Stands in for `docker run ... claude`: the same jsonLineProcess the
   * sandbox uses, with the sandbox's tees, over a node script in place of the
   * container. The docker arguments and the credential envelope are dropped.
   */
  const scripted =
    (script: string) =>
    (options: JsonLineProcessOptions): AsyncIterable<unknown> =>
      jsonLineProcess({
        command: process.execPath,
        args: ['-e', script],
        cwd: options.cwd,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onRawStdoutLine ? { onRawStdoutLine: options.onRawStdoutLine } : {}),
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      });
  async function runScripted(
    script: string,
    options: { rawOutputMode?: 'failure' | 'always' | 'never' } = {},
  ) {
    const root = join(process.cwd(), '.forge', 'workspaces');
    await mkdir(root, { recursive: true });
    const workspace = await mkdtemp(join(root, 'raw-output-'));
    try {
      return await executeProviderJob(
        { providerId: 'claude', request: plannerRequest, cwd: workspace },
        new AbortController().signal,
        { processRunner: scripted(script), ...options },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  it('carries redacted stdout and stderr tails on a failed provider job', async () => {
    const result = await runScripted(failingScript);
    expect(result.code).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(['session', 'error']);
    const { rawStdoutTail, rawStderrTail } = result;
    expect(rawStdoutTail).toBeDefined();
    expect(rawStderrTail).toBeDefined();
    const everything = `${rawStdoutTail}${rawStderrTail}${JSON.stringify(result.events)}${result.stderr}`;
    for (const secret of planted) expect(everything).not.toContain(secret);
    // What is left is what a debugger wants: the raw JSON line the adapter
    // mapped, the non-JSON line it dropped, the tool result it ignored and
    // the stderr the error message only summarised.
    expect(rawStdoutTail).toContain(
      '{"type":"system","subtype":"init","session_id":"raw-session"}\n',
    );
    expect(rawStdoutTail).toContain('not json: worker [REDACTED] key [REDACTED] bare [REDACTED]\n');
    expect(rawStdoutTail).toContain('"refresh_token":"[REDACTED]"');
    expect(rawStdoutTail).toContain('"authorization":"Bearer [REDACTED]"');
    // `refresh_token=` survives and only its value goes, as the JSON rule has
    // always done; it replaced the whole match until 05/10/2026, which left a
    // secret-scan approval request reading `[REDACTED]` with nothing a person
    // could judge.
    expect(rawStderrTail).toBe(
      'fatal: ANTHROPIC_API_KEY=[REDACTED] rejected, refresh_token=[REDACTED]\n',
    );
    // The guarantee that has to hold whatever the surrounding text becomes.
    expect(rawStderrTail).not.toContain(refreshToken);
    expect(rawStderrTail).not.toContain(plantedApiKey);
  });

  it('carries no tails on a successful job under failure mode, and both under always', async () => {
    const quiet = await runScripted(successScript, { rawOutputMode: 'failure' });
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.events.map((event) => event.type)).toEqual(['session', 'usage', 'completed']);
    expect(quiet).not.toHaveProperty('rawStdoutTail');
    expect(quiet).not.toHaveProperty('rawStderrTail');

    const verbose = await runScripted(successScript, { rawOutputMode: 'always' });
    expect(verbose.code, verbose.stderr).toBe(0);
    expect(verbose.rawStdoutTail).toContain('"subtype":"success"');
    expect(verbose.rawStderrTail).toBe('note: nothing wrong\n');
  });

  it('carries no tails under never, even on failure', async () => {
    const result = await runScripted(failingScript, { rawOutputMode: 'never' });
    expect(result.code).toBe(1);
    expect(result).not.toHaveProperty('rawStdoutTail');
    expect(result).not.toHaveProperty('rawStderrTail');
  });

  it('caps each tail at MAX_RAW_TAIL_BYTES and keeps the end', async () => {
    // 1300 lines of 1000 bytes: past the tail cap, well under the 10 MB
    // stdout bound, and every one a protocol warning the adapter drops.
    const script = [
      "process.stdout.write('FIRST-LINE-MARKER\\n')",
      "const filler = 'x'.repeat(999) + '\\n'",
      'for (let i = 0; i < 1300; i += 1) process.stdout.write(filler)',
      "process.stdout.write('LAST-LINE-MARKER\\n')",
      'process.exitCode = 1',
    ].join(';');
    const result = await runScripted(script);
    expect(result.code).toBe(1);
    const tail = result.rawStdoutTail ?? '';
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX_RAW_TAIL_BYTES);
    expect(Buffer.byteLength(tail)).toBeGreaterThan(MAX_RAW_TAIL_BYTES - 1_000);
    expect(tail.endsWith('LAST-LINE-MARKER\n')).toBe(true);
    expect(tail).not.toContain('FIRST-LINE-MARKER');
    expect(result).not.toHaveProperty('rawStderrTail');
  });

  it('bounds a rolling tail in bytes on character boundaries', () => {
    const tail = new RollingTail(5);
    tail.push('aé');
    tail.push('éb');
    expect(tail.text()).toBe('ééb');
    tail.push('12345678');
    expect(tail.text()).toBe('45678');
    // A cut that would land inside a two-byte character moves past it.
    expect(lastBytes('aéb', 2)).toBe('b');
    expect(lastBytes('aéb', 3)).toBe('éb');
    expect(lastBytes('abc', 10)).toBe('abc');
  });
});

/**
 * One real Codex CLI run inside the real sandbox container, run on purpose with
 * FORGE_CODEX_SMOKE=1 (docs/OPERATIONS.md "Provider smoke tests"). It is the only
 * test that proves the ADR-030 bypass actually restores Codex's shell: the prompt
 * can be answered solely by reading a file from the workspace, so an answer
 * carrying that file's content means the CLI could run a command and read the
 * mount. Codex is on a $0 subscription, so the run costs nothing - but it needs a
 * logged-in credential, so it skips cleanly when the auth file or the sandbox
 * image is missing, and CI never sets the flag.
 */
describe('Codex sandbox smoke test', () => {
  const codexAuthFile = process.env.FORGE_CODEX_AUTH_FILE;
  const codexSmokeReady =
    process.env.FORGE_CODEX_SMOKE === '1' &&
    dockerSandboxAvailable &&
    (process.env.OPENAI_API_KEY !== undefined ||
      (codexAuthFile !== undefined && existsSync(codexAuthFile)));

  it.runIf(codexSmokeReady)(
    'reads a workspace file through its shell inside the container',
    async () => {
      const root = resolve('.forge/workspaces');
      await mkdir(root, { recursive: true });
      const workspace = await mkdtemp(join(root, 'codex-smoke-'));
      // The CLI refuses to run outside a git repository, which every real
      // workspace is because the worker materializes one.
      git(['init'], workspace);
      const secret = `forge-shell-proof-${randomUUID().slice(0, 8)}`;
      await writeFile(join(workspace, 'PROOF.txt'), `${secret}\n`, 'utf8');
      try {
        const result = await executeProviderJob(
          {
            providerId: 'codex',
            request: {
              runId: 'run-codex-smoke',
              taskId: 'run-codex-smoke-reviewer',
              role: 'reviewer',
              prompt:
                'Read the file PROOF.txt in your working directory and reply with only its contents, nothing else. Do not guess: if you cannot run commands, say UNAVAILABLE.',
              context: [],
              timeoutMs: 300_000,
            } satisfies ProviderRequest,
            cwd: workspace,
          },
          AbortSignal.timeout(330_000),
          { rawOutputMode: 'always' },
        );
        const text = result.events
          .filter((event) => event.type === 'text_delta')
          .map((event) => (event as { text: string }).text)
          .join('');
        console.log(
          JSON.stringify(
            {
              code: result.code,
              stderr: result.stderr,
              text,
              rawStderrTail: result.rawStderrTail,
              types: result.events.map((event) => event.type),
            },
            null,
            2,
          ),
        );
        // The BLK-016 symptom, in the CLI's own words. Asserted separately so a
        // regression reads as "the shell is gone again" rather than a bare
        // content mismatch.
        expect(`${text} ${result.rawStderrTail ?? ''}`).not.toMatch(/namespace|UNAVAILABLE/i);
        expect(result.code, result.stderr).toBe(0);
        expect(text).toContain(secret);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
