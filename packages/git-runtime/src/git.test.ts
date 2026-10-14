import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGitPatch,
  GitWorkspaceRuntime,
  pushBranchWithGitHubToken,
  runGit,
  SecretScanRefusal,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Git workspace isolation', () => {
  it('creates independent worktrees and focused commits', async () => {
    const temp = await makeManagedTemporaryDirectory('forge-git-');
    const source = join(temp, 'source');
    await mkdir(source);
    await runGit(['init', '-b', 'main'], source);
    await runGit(['config', 'user.email', 'forge@test.invalid'], source);
    await runGit(['config', 'user.name', 'Forge Test'], source);
    await writeFile(join(source, 'base.txt'), 'base\n');
    await runGit(['add', '.'], source);
    await runGit(['commit', '-m', 'base'], source);
    const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
    await mkdir(runtime.root, { recursive: true });
    await runtime.register('p', source);
    const a = await runtime.createWorktree('p', 'a', 'main', 'forge/a');
    const b = await runtime.createWorktree('p', 'b', 'main', 'forge/b');
    expect(await runtime.createWorktree('p', 'a', 'main', 'forge/a')).toBe(a);
    await writeFile(join(a, 'a.txt'), 'a\n');
    await runGit(['add', 'a.txt'], a);
    const sha = await runtime.commit(a, 'add a');
    expect(sha).toHaveLength(40);
    expect(await runtime.status(b)).toBe('');
    await expect(runGit(['show', 'forge/a:a.txt'], b)).resolves.toBeDefined();
  });

  it('rejects a relative workspace root', () => {
    // A relative root is applied twice: GitWorkspaceRuntime passes it to runGit as
    // the spawn cwd and also derives cache/worktree paths from it, which git then
    // resolves against that same cwd, producing <root>/<root>/cache. The resulting
    // non-existent cwd is reported by Windows as "spawn git ENOENT", naming the
    // executable rather than the real cause. Every production call site must
    // resolve() first. This suite only ever passed absolute roots, which is why the
    // defect reached a release candidate uncaught.
    expect(() => new GitWorkspaceRuntime('.forge/workspaces')).toThrow(/must be an absolute path/);
    expect(() => new GitWorkspaceRuntime('relative/path')).toThrow(/must be an absolute path/);
  });

  it('rejects identifiers that could escape managed directories', async () => {
    const temp = await makeManagedTemporaryDirectory('forge-git-policy-');
    const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
    await expect(runtime.register('../outside', temp)).rejects.toThrow('Unsafe project identifier');
    await expect(runtime.cleanup('safe', '../outside')).rejects.toThrow('Unsafe task identifier');
  });

  it('applies only the accepted attempt patch to the integration workspace', async () => {
    const temp = await makeManagedTemporaryDirectory('forge-git-patch-');
    const source = join(temp, 'source');
    const attempt = join(temp, 'attempt');
    const integration = join(temp, 'integration');
    await mkdir(source);
    await runGit(['init', '-b', 'main'], source);
    await runGit(['config', 'user.email', 'forge@test.invalid'], source);
    await runGit(['config', 'user.name', 'Forge Test'], source);
    await writeFile(join(source, 'feature.txt'), 'base\n');
    await runGit(['add', '.'], source);
    await runGit(['commit', '-m', 'base'], source);
    await runGit(['clone', source, attempt], temp);
    await runGit(['clone', source, integration], temp);
    await writeFile(join(attempt, 'feature.txt'), 'accepted\n');
    const patch = (await runGit(['diff', '--binary', 'HEAD'], attempt)).stdout;
    await applyGitPatch(patch, integration);
    expect((await runGit(['diff', '--binary', 'HEAD'], integration)).stdout).toContain('+accepted');
    expect((await runGit(['diff', '--binary', 'HEAD'], source)).stdout).toBe('');
  });
});

describe('applying a cumulative attempt patch', () => {
  /**
   * The worker's attempt patch is `git add --intent-to-add --all` then
   * `git diff --binary HEAD`, so it is the whole diff from HEAD. Reproduced
   * here rather than imported, because the invariant under test is the shape of
   * the patch, and a change to how the worker captures it should fail this.
   */
  async function captureCumulativePatch(cwd: string): Promise<string> {
    await runGit(['add', '--intent-to-add', '--all'], cwd);
    return (await runGit(['diff', '--binary', 'HEAD'], cwd)).stdout;
  }

  async function repositoryWithOneCommit(prefix: string) {
    const temp = await makeManagedTemporaryDirectory(prefix);
    const cwd = join(temp, 'repo');
    await mkdir(cwd);
    await runGit(['init', '-b', 'main'], cwd);
    await runGit(['config', 'user.email', 'forge@test.invalid'], cwd);
    await runGit(['config', 'user.name', 'Forge Test'], cwd);
    await writeFile(join(cwd, 'tracked.txt'), 'base\n');
    await runGit(['add', '.'], cwd);
    await runGit(['commit', '-m', 'base'], cwd);
    return cwd;
  }

  it('is idempotent, so a repair round can apply its patch over the first one', async () => {
    // The thirteenth obstacle of the first real objective, and the first bug in
    // the sequence that was not a toy-sized limit. The reviewer withheld
    // approval, the repair builder ran, and its patch - the whole diff from
    // HEAD, including the new test file the FIRST builder had written - was
    // applied to a tree that already had that file:
    //
    //   git apply failed (1): error: tests/unit/auth.test.ts: already exists in
    //   working directory
    //
    // Every repair round would have failed, for any objective. A new file fails
    // this way and a modified file fails with "patch does not apply"; it went
    // unseen only because no run had ever reached a second builder call.
    const cwd = await repositoryWithOneCommit('forge-cumulative-');
    await writeFile(join(cwd, 'tracked.txt'), 'edited by the builder\n');
    await writeFile(join(cwd, 'new-test.ts'), 'the builder wrote this\n');
    const first = await captureCumulativePatch(cwd);

    // A fresh tree, as the coordinator's is before the first builder.
    const target = await repositoryWithOneCommit('forge-cumulative-target-');
    await applyGitPatch(first, target);
    // Line endings are git's, per the host's core.autocrlf, so every assertion
    // on a checked-out file tolerates both.
    expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toMatch(
      /^edited by the builder\r?\n$/,
    );
    expect(await readFile(join(target, 'new-test.ts'), 'utf8')).toMatch(
      /^the builder wrote this\r?\n$/,
    );

    // The repair round: the same patch plus one more change, applied over the
    // tree the first one left behind. This is the call that used to fail.
    await writeFile(join(cwd, 'new-test.ts'), 'the builder wrote this, then fixed it\n');
    const second = await captureCumulativePatch(cwd);
    await applyGitPatch(second, target);
    expect(await readFile(join(target, 'new-test.ts'), 'utf8')).toMatch(
      /^the builder wrote this, then fixed it\r?\n$/,
    );
    expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toMatch(
      /^edited by the builder\r?\n$/,
    );

    // And applying the same patch again changes nothing, which is what
    // idempotent has to mean for a retry to be safe.
    await applyGitPatch(second, target);
    expect(await readFile(join(target, 'new-test.ts'), 'utf8')).toMatch(
      /^the builder wrote this, then fixed it\r?\n$/,
    );
  });

  it('removes work an earlier attempt left behind when the new patch is empty', async () => {
    // A builder that reverted its own earlier work sends an empty patch, which
    // still means "the tree is HEAD". Returning early on an empty patch would
    // leave the earlier attempt in place and commit changes no attempt
    // produced.
    const cwd = await repositoryWithOneCommit('forge-cumulative-empty-');
    await writeFile(join(cwd, 'tracked.txt'), 'edited by the builder\n');
    await writeFile(join(cwd, 'new-test.ts'), 'the builder wrote this\n');
    const target = await repositoryWithOneCommit('forge-cumulative-empty-target-');
    await applyGitPatch(await captureCumulativePatch(cwd), target);
    expect(existsSync(join(target, 'new-test.ts'))).toBe(true);

    await applyGitPatch('', target);
    expect(await readFile(join(target, 'tracked.txt'), 'utf8')).toMatch(/^base\r?\n$/);
    expect(existsSync(join(target, 'new-test.ts'))).toBe(false);
  });

  it('leaves ignored files alone, because the patch will not put them back', async () => {
    // `git clean -fd` without `-x`. A node_modules is not the builder's work
    // and reinstalling one per repair round would be an expensive way to lose.
    const cwd = await repositoryWithOneCommit('forge-cumulative-ignored-');
    await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
    await runGit(['add', '.gitignore'], cwd);
    await runGit(['commit', '-m', 'ignore'], cwd);
    await mkdir(join(cwd, 'node_modules'));
    await writeFile(join(cwd, 'node_modules', 'installed.txt'), 'expensive\n');
    await writeFile(join(cwd, 'tracked.txt'), 'edited\n');

    await applyGitPatch(await captureCumulativePatch(cwd), cwd);
    // Never checked out, so this one is byte-exact.
    expect(await readFile(join(cwd, 'node_modules', 'installed.txt'), 'utf8')).toBe('expensive\n');
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toMatch(/^edited\r?\n$/);
  });
});

describe('diffing a worktree that has new files', () => {
  async function worktreeWithANewFile(prefix: string) {
    const temp = await makeManagedTemporaryDirectory(prefix);
    const source = join(temp, 'source');
    await mkdir(source);
    await runGit(['init', '-b', 'main'], source);
    await runGit(['config', 'user.email', 'forge@test.invalid'], source);
    await runGit(['config', 'user.name', 'Forge Test'], source);
    await writeFile(join(source, 'base.txt'), 'base\n');
    await runGit(['add', '.'], source);
    await runGit(['commit', '-m', 'base'], source);
    const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
    await mkdir(runtime.root, { recursive: true });
    await runtime.register('p', source);
    const workspace = await runtime.createWorktree('p', prefix, 'main', `forge/${prefix}`);
    await writeFile(join(workspace, 'added.txt'), 'the builder wrote this\n');
    return { runtime, workspace };
  }

  it('includes a new file, which plain diff omits entirely', async () => {
    const { runtime, workspace } = await worktreeWithANewFile('new-file');
    // The behaviour that sent an empty diff to the reviewer.
    expect(await runtime.diff(workspace)).toBe('');
    const { diff, stat } = await runtime.diffWithUntracked(workspace);
    expect(diff).toContain('+++ b/added.txt');
    expect(diff).toContain('+the builder wrote this');
    expect(stat).toContain('added.txt');
  });

  it('leaves the index as it found it', async () => {
    // `--intent-to-add` writes to the index, so this has to put it back or the
    // reviewer read-only check would see the index move and refuse the run.
    const { runtime, workspace } = await worktreeWithANewFile('index-restored');
    const before = await runtime.status(workspace);
    await runtime.diffWithUntracked(workspace);
    expect(await runtime.status(workspace)).toBe(before);
    expect(await runtime.diff(workspace, true)).toBe('');
  });

  it('refuses rather than touch an index that already has staged work', async () => {
    const { runtime, workspace } = await worktreeWithANewFile('already-staged');
    await runGit(['add', 'added.txt'], workspace);
    await expect(runtime.diffWithUntracked(workspace)).rejects.toThrow(
      'Cannot diff with untracked files while changes are staged',
    );
    // And the staged work is still staged, which is the point of refusing.
    expect(await runtime.diff(workspace, true)).toContain('+++ b/added.txt');
  });
});

describe('the commit-time secret scan', () => {
  async function stagedWorktree(prefix: string, line: string) {
    const temp = await makeManagedTemporaryDirectory(prefix);
    const source = join(temp, 'source');
    await mkdir(source);
    await runGit(['init', '-b', 'main'], source);
    await runGit(['config', 'user.email', 'forge@test.invalid'], source);
    await runGit(['config', 'user.name', 'Forge Test'], source);
    await writeFile(join(source, 'base.txt'), 'base\n');
    await runGit(['add', '.'], source);
    await runGit(['commit', '-m', 'base'], source);
    const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
    await mkdir(runtime.root, { recursive: true });
    await runtime.register('p', source);
    const workspace = await runtime.createWorktree('p', prefix, 'main', `forge/${prefix}`);
    await writeFile(join(workspace, 'fixture.test.ts'), `${line}\n`);
    await runGit(['add', '--all'], workspace);
    return { runtime, workspace };
  }

  it('refuses a match, and names the lines with their values redacted', async () => {
    // Attempts fifteen and seventeen of the first real objective. A test for
    // password verification has to contain a password literal somewhere, so the
    // scan will keep matching; Dan's decision was to make it a question rather
    // than either a failure or a hole in the detector.
    const { runtime, workspace } = await stagedWorktree(
      'scan-refused',
      "const config = { password: 'test-session-secret-at-least-32-chars' }",
    );
    const refusal = await runtime.commit(workspace, 'msg').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SecretScanRefusal);
    const scan = refusal as SecretScanRefusal;
    expect(scan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(scan.evidence).toHaveLength(1);
    // The evidence goes into an approval record, so the candidate value must
    // not travel with it.
    expect(scan.evidence[0]).toContain('[REDACTED]');
    expect(scan.evidence[0]).not.toContain('test-session-secret-at-least-32-chars');
    // The field name has to survive, or the evidence is unreadable. Attempt
    // nineteen's approval request said `+      [REDACTED]` and nothing else,
    // which asks a person to judge a line they cannot see.
    expect(scan.evidence[0]).toContain('password:');
    // And nothing was committed.
    expect(await runtime.diff(workspace, true)).toContain('fixture.test.ts');
  });

  it('commits when the approval pins the staged content it was given', async () => {
    const { runtime, workspace } = await stagedWorktree(
      'scan-approved',
      "const config = { password: 'test-session-secret-at-least-32-chars' }",
    );
    const scan = (await runtime
      .commit(workspace, 'msg')
      .catch((e: unknown) => e)) as SecretScanRefusal;
    const sha = await runtime.commit(workspace, 'msg', scan.digest);
    expect(sha).toHaveLength(40);
  });

  it('refuses an approval for content that has since moved', async () => {
    // The assertion that makes the approval meaningful. Without the digest
    // comparison, a decision about one diff would let through whatever happened
    // to be staged when it was acted on - the same hazard the push path avoids
    // by pinning HEAD.
    const { runtime, workspace } = await stagedWorktree(
      'scan-moved',
      "const config = { password: 'test-session-secret-at-least-32-chars' }",
    );
    const scan = (await runtime
      .commit(workspace, 'msg')
      .catch((e: unknown) => e)) as SecretScanRefusal;
    // Something else arrives after the approval was raised.
    await writeFile(
      join(workspace, 'sneaked.ts'),
      "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123'\n",
    );
    await runGit(['add', '--all'], workspace);
    await expect(runtime.commit(workspace, 'msg', scan.digest)).rejects.toThrow(SecretScanRefusal);
  });

  it('still commits clean content without any approval', async () => {
    const { runtime, workspace } = await stagedWorktree('scan-clean', 'export const answer = 42');
    expect(await runtime.commit(workspace, 'msg')).toHaveLength(40);
  });
});

describe('authenticated Git push', () => {
  it('passes the token only through an ephemeral askpass environment', async () => {
    const token = 'github_pat_secret-fixture-value';
    let captured:
      | {
          executable: string;
          args: string[];
          options: {
            cwd: string;
            shell: false;
            env: NodeJS.ProcessEnv;
          };
          launcher: string;
          script: string;
          globalConfig: string;
        }
      | undefined;
    const spawnGit = ((
      executable: string,
      args: string[],
      options: {
        cwd: string;
        shell: false;
        env: NodeJS.ProcessEnv;
      },
    ) => {
      const child = new FakeGitChild();
      captured = {
        executable,
        args,
        options,
        launcher: readFileSync(options.env.GIT_ASKPASS!, 'utf8'),
        script: readFileSync(options.env.FORGE_GIT_ASKPASS_SCRIPT!, 'utf8'),
        globalConfig: readFileSync(options.env.GIT_CONFIG_GLOBAL!, 'utf8'),
      };
      process.nextTick(() => {
        child.stdout.end(`pushed without displaying ${token}`);
        child.stderr.end(`remote response accidentally included ${token}`);
        child.emit('close', 0);
      });
      return child;
    }) as NonNullable<Parameters<typeof pushBranchWithGitHubToken>[4]>;

    const result = await pushBranchWithGitHubToken(
      process.cwd(),
      'forge/safe-fixture',
      token,
      undefined,
      spawnGit,
    );

    expect(captured).toBeDefined();
    expect(captured!.executable).toBe('git');
    expect(captured!.options).toMatchObject({ cwd: process.cwd(), shell: false });
    expect(captured!.args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.username=x-access-token',
      'push',
      '--set-upstream',
      'origin',
      'forge/safe-fixture',
    ]);
    expect(JSON.stringify(captured!.args)).not.toContain(token);
    expect(captured!.options.env).toMatchObject({
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
      FORGE_GIT_ASKPASS_NODE: process.execPath,
      FORGE_GIT_ASKPASS_TOKEN: token,
    });
    expect(captured!.options.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(captured!.options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(captured!.launcher).not.toContain(token);
    expect(captured!.script).not.toContain(token);
    expect(captured!.globalConfig).toBe('');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    await expect(
      import('node:fs/promises').then(({ stat }) =>
        stat(dirname(captured!.options.env.GIT_ASKPASS!)),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts remote errors and removes askpass files when push fails', async () => {
    const token = 'github_pat_failed-push-secret';
    let askpassDirectory = '';
    const spawnGit = ((
      _executable: string,
      _args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      askpassDirectory = dirname(options.env.GIT_ASKPASS!);
      const child = new FakeGitChild();
      process.nextTick(() => {
        child.stderr.end(`fatal: remote reflected ${token}`);
        child.emit('close', 128);
      });
      return child;
    }) as NonNullable<Parameters<typeof pushBranchWithGitHubToken>[4]>;

    await expect(
      pushBranchWithGitHubToken(process.cwd(), 'forge/failed-fixture', token, undefined, spawnGit),
    ).rejects.toThrow('fatal: remote reflected [REDACTED]');
    await expect(
      import('node:fs/promises').then(({ stat }) => stat(askpassDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/**
 * createWorktree against the partial state an earlier run can leave behind.
 * Every managed root here sits under this checkout's `.forge/test-tmp`, so
 * these also cover the default `.forge/workspaces` layout, where a bare
 * `git branch --show-current` in a directory that is not a worktree walks up
 * and answers with the checkout's own branch.
 */
describe('Worktree recovery', () => {
  it('replaces a pre-existing empty directory at the workspace path', async () => {
    const { runtime, worktrees } = await createRegisteredRuntime('forge-git-empty-');
    await mkdir(join(worktrees, 'empty'), { recursive: true });
    const workspace = await runtime.createWorktree('p', 'empty', 'main', 'forge/empty');
    expect(workspace).toBe(join(worktrees, 'empty'));
    expect(await currentBranch(workspace)).toBe('forge/empty');
    expect(existsSync(join(workspace, 'base.txt'))).toBe(true);
  });

  it('replaces a directory of junk that is not a worktree', async () => {
    const { runtime, worktrees } = await createRegisteredRuntime('forge-git-junk-');
    const path = join(worktrees, 'junk');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'leftover.txt'), 'interrupted clone\n');
    const workspace = await runtime.createWorktree('p', 'junk', 'main', 'forge/junk');
    expect(workspace).toBe(path);
    expect(existsSync(join(workspace, 'leftover.txt'))).toBe(false);
    expect(await currentBranch(workspace)).toBe('forge/junk');
    expect(existsSync(join(workspace, 'base.txt'))).toBe(true);
  });

  it('recreates a registered worktree whose directory was deleted', async () => {
    const { runtime, cache } = await createRegisteredRuntime('forge-git-missing-');
    const first = await runtime.createWorktree('p', 'gone', 'main', 'forge/gone');
    await rm(first, { recursive: true, force: true });
    expect(await worktreeList(runtime, cache)).toContain('prunable');
    const workspace = await runtime.createWorktree('p', 'gone', 'main', 'forge/gone');
    expect(workspace).toBe(first);
    expect(await currentBranch(workspace)).toBe('forge/gone');
    expect(existsSync(join(workspace, 'base.txt'))).toBe(true);
    const listed = await worktreeList(runtime, cache);
    // The bare cache and this one worktree; the stale registration is gone.
    expect(listed.match(/^worktree /gm)).toHaveLength(2);
    expect(listed).not.toContain('prunable');
  });

  it('adds the worktree with -f when its branch is checked out elsewhere', async () => {
    const { runtime, cache, worktrees } = await createRegisteredRuntime('forge-git-elsewhere-');
    const other = join(worktrees, 'other');
    await mkdir(worktrees, { recursive: true });
    await runGit(
      ['--git-dir', cache, 'worktree', 'add', '-b', 'forge/shared', other, 'main'],
      runtime.root,
    );
    const workspace = await runtime.createWorktree('p', 'shared', 'main', 'forge/shared');
    expect(workspace).toBe(join(worktrees, 'shared'));
    expect(await currentBranch(workspace)).toBe('forge/shared');
    expect(await currentBranch(other)).toBe('forge/shared');
    expect(existsSync(join(workspace, 'base.txt'))).toBe(true);
  });

  it('re-enters a worktree on the expected branch without recreating it', async () => {
    const { runtime } = await createRegisteredRuntime('forge-git-reentry-');
    const first = await runtime.createWorktree('p', 'again', 'main', 'forge/again');
    await writeFile(join(first, 'in-progress.txt'), 'kept\n');
    expect(await runtime.createWorktree('p', 'again', 'main', 'forge/again')).toBe(first);
    expect(await readFile(join(first, 'in-progress.txt'), 'utf8')).toBe('kept\n');
  });

  it('still refuses a registered worktree that is on another branch', async () => {
    const { runtime } = await createRegisteredRuntime('forge-git-mismatch-');
    const workspace = await runtime.createWorktree('p', 'held', 'main', 'forge/held');
    await writeFile(join(workspace, 'work.txt'), 'unique\n');
    await expect(runtime.createWorktree('p', 'held', 'main', 'forge/other')).rejects.toThrow(
      'Existing workspace branch does not match',
    );
    expect(await readFile(join(workspace, 'work.txt'), 'utf8')).toBe('unique\n');
  });

  it('cleanup removes the worktree and its registration, and the task can start over', async () => {
    const { runtime, cache } = await createRegisteredRuntime('forge-git-cleanup-');
    const workspace = await runtime.createWorktree('p', 'done', 'main', 'forge/done');
    await runtime.cleanup('p', 'done');
    expect(existsSync(workspace)).toBe(false);
    expect((await worktreeList(runtime, cache)).match(/^worktree /gm)).toHaveLength(1);
    // The branch survives cleanup, so the retry takes the add-without--b path.
    expect(await runtime.createWorktree('p', 'done', 'main', 'forge/done')).toBe(workspace);
    expect(await currentBranch(workspace)).toBe('forge/done');
  });
});

async function createRegisteredRuntime(prefix: string) {
  const temp = await makeManagedTemporaryDirectory(prefix);
  const source = join(temp, 'source');
  await mkdir(source);
  await runGit(['init', '-b', 'main'], source);
  await runGit(['config', 'user.email', 'forge@test.invalid'], source);
  await runGit(['config', 'user.name', 'Forge Test'], source);
  await writeFile(join(source, 'base.txt'), 'base\n');
  await runGit(['add', '.'], source);
  await runGit(['commit', '-m', 'base'], source);
  const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
  await mkdir(runtime.root, { recursive: true });
  const cache = await runtime.register('p', source);
  return { runtime, cache, worktrees: join(runtime.root, 'worktrees') };
}

async function currentBranch(workspace: string) {
  return (await runGit(['branch', '--show-current'], workspace)).stdout.trim();
}

async function worktreeList(runtime: GitWorkspaceRuntime, cache: string) {
  return (await runGit(['--git-dir', cache, 'worktree', 'list', '--porcelain'], runtime.root))
    .stdout;
}

class FakeGitChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    this.emit('close', null);
    return true;
  }
}

/**
 * BLK-032. The cache is a bare clone, which has no fetch refspec, so the old refresh
 * (`git fetch --prune origin`) moved no branch and every worktree started at the commit of
 * the first clone. These run against real repositories: a remote that moves between
 * registrations, and the cache layout the live system already has on disk.
 */
describe('the repository cache follows the remote (BLK-032)', () => {
  async function remote(prefix: string) {
    const temp = await makeManagedTemporaryDirectory(prefix);
    const source = join(temp, 'source');
    await mkdir(source);
    await runGit(['init', '-b', 'main'], source);
    await runGit(['config', 'user.email', 'forge@test.invalid'], source);
    await runGit(['config', 'user.name', 'Forge Test'], source);
    const commit = async (file: string) => {
      await writeFile(join(source, file), `${file}\n`);
      await runGit(['add', '.'], source);
      await runGit(['commit', '-m', file], source);
      return (await runGit(['rev-parse', 'HEAD'], source)).stdout.trim();
    };
    const runtime = new GitWorkspaceRuntime(join(temp, 'managed'));
    await mkdir(runtime.root, { recursive: true });
    return { temp, source, commit, runtime };
  }
  const head = async (workspace: string) =>
    (await runGit(['rev-parse', 'HEAD'], workspace)).stdout.trim();

  it('starts a new worktree at the current tip of the remote, not the first clone', async () => {
    const { source, commit, runtime } = await remote('forge-cache-advance-');
    const first = await commit('first.txt');
    await runtime.register('p', source);
    const second = await commit('second.txt');
    await runtime.register('p', source);
    const workspace = await runtime.createWorktree('p', 't', 'main', 'forge/t');
    expect(await head(workspace)).toBe(second);
    expect(await head(workspace)).not.toBe(first);
    expect(existsSync(join(workspace, 'second.txt'))).toBe(true);
  });

  it('repairs a cache cloned before the fix, which has no fetch refspec', async () => {
    const { temp, source, commit, runtime } = await remote('forge-cache-legacy-');
    await commit('first.txt');
    // The layout on disk today: a bare clone and nothing else configured.
    const cache = join(runtime.root, 'cache', 'p.git');
    await mkdir(dirname(cache), { recursive: true });
    await runGit(['clone', '--bare', source, cache], temp);
    const configured = (
      await runGit(['--git-dir', cache, 'config', '--get-all', 'remote.origin.fetch'], temp).catch(
        () => ({ stdout: '' }),
      )
    ).stdout.trim();
    expect(configured).toBe('');
    const second = await commit('second.txt');
    // Before the fix this fetched objects and left the cache's main at the first commit.
    await runtime.register('p', source);
    expect(
      (
        await runGit(['--git-dir', cache, 'config', '--get-all', 'remote.origin.fetch'], temp)
      ).stdout.trim(),
    ).toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await head(await runtime.createWorktree('p', 't', 'main', 'forge/t'))).toBe(second);
  });

  it('is idempotent: registering twice leaves exactly one refspec', async () => {
    const { temp, source, commit, runtime } = await remote('forge-cache-idempotent-');
    await commit('first.txt');
    await runtime.register('p', source);
    await runtime.register('p', source);
    const cache = join(runtime.root, 'cache', 'p.git');
    const refspecs = (
      await runGit(['--git-dir', cache, 'config', '--get-all', 'remote.origin.fetch'], temp)
    ).stdout
      .trim()
      .split(String.fromCharCode(10));
    expect(refspecs).toEqual(['+refs/heads/*:refs/remotes/origin/*']);
  });

  it('refreshes while a forge/* task branch is checked out in a worktree', async () => {
    // Fetching into refs/heads/* would be refused here: git will not update a branch that a
    // worktree has checked out. Remote-tracking refs have no such rule.
    const { source, commit, runtime } = await remote('forge-cache-checkedout-');
    await commit('first.txt');
    await runtime.register('p', source);
    const task = await runtime.createWorktree('p', 'task', 'main', 'forge/task');
    const taskHead = await head(task);
    // The same branch name now exists on the remote, at a newer commit.
    await runGit(['checkout', '-b', 'forge/task'], source);
    const newer = await commit('newer.txt');
    await runGit(['checkout', 'main'], source);
    await expect(runtime.register('p', source)).resolves.toBeDefined();
    expect(await head(task)).toBe(taskHead);
    expect(newer).not.toBe(taskHead);
  });

  it('still starts from a commit or a tag, which are not remote branches', async () => {
    const { source, commit, runtime } = await remote('forge-cache-refs-');
    const first = await commit('first.txt');
    await runGit(['tag', 'v1'], source);
    await commit('second.txt');
    await runtime.register('p', source);
    expect(await head(await runtime.createWorktree('p', 'by-sha', first, 'forge/by-sha'))).toBe(
      first,
    );
    expect(await head(await runtime.createWorktree('p', 'by-tag', 'v1', 'forge/by-tag'))).toBe(
      first,
    );
  });

  it('drops a remote branch that was deleted, so a stale ref is not offered as a base', async () => {
    const { temp, source, commit, runtime } = await remote('forge-cache-prune-');
    await commit('first.txt');
    await runGit(['branch', 'topic'], source);
    await runtime.register('p', source);
    const cache = join(runtime.root, 'cache', 'p.git');
    expect((await runGit(['--git-dir', cache, 'branch', '-r'], temp)).stdout).toContain(
      'origin/topic',
    );
    await runGit(['branch', '-D', 'topic'], source);
    await runtime.register('p', source);
    expect((await runGit(['--git-dir', cache, 'branch', '-r'], temp)).stdout).not.toContain(
      'origin/topic',
    );
  });
});

async function makeManagedTemporaryDirectory(prefix: string): Promise<string> {
  const root = join(process.cwd(), '.forge', 'test-tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, prefix));
  temporaryDirectories.push(directory);
  return directory;
}
