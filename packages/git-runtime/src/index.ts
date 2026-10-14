import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Octokit } from '@octokit/rest';
import { containsLikelySecret, redactSecrets } from '@theforge/policy';

export type ExecResult = { stdout: string; stderr: string; code: number };
type GitChildProcess = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): GitChildProcess;
  on(event: 'close', listener: (code: number | null) => void): GitChildProcess;
};
type GitSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    shell: false;
    env: NodeJS.ProcessEnv;
  },
) => GitChildProcess;
type RunGitOptions = {
  environment?: NodeJS.ProcessEnv;
  redact?: readonly string[];
  spawn?: GitSpawn;
};
export async function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  options: RunGitOptions = {},
): Promise<ExecResult> {
  if (args.some((arg) => arg.includes('\0'))) throw new Error('Invalid Git argument');
  return new Promise((resolvePromise, reject) => {
    const spawnGit: GitSpawn = options.spawn ?? spawn;
    const child = spawnGit('git', args, {
      cwd,
      shell: false,
      env: options.environment ?? defaultGitProcessEnvironment(),
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      const result = {
        stdout: redactExactSecrets(stdout, options.redact),
        stderr: redactExactSecrets(stderr, options.redact),
        code: code ?? -1,
      };
      if (result.code === 0) resolvePromise(result);
      else
        reject(new Error(`git ${args[0] ?? ''} failed (${result.code}): ${result.stderr.trim()}`));
    });
  });
}

export async function pushBranchWithGitHubToken(
  workspace: string,
  branch: string,
  token: string,
  signal?: AbortSignal,
  spawnGit?: GitSpawn,
): Promise<ExecResult> {
  assertSafeRef(branch);
  if (!token || /[\0\r\n]/.test(token)) throw new Error('Invalid GitHub token');

  const askpassDirectory = await mkdtemp(join(tmpdir(), 'theforge-git-askpass-'));
  const askpassScript = join(askpassDirectory, 'askpass.mjs');
  const askpassLauncher = join(
    askpassDirectory,
    process.platform === 'win32' ? 'askpass.cmd' : 'askpass',
  );
  const globalConfig = join(askpassDirectory, 'global.gitconfig');
  try {
    await writeFile(
      askpassScript,
      [
        "const prompt = process.argv[2] ?? '';",
        "const response = /username/i.test(prompt) ? 'x-access-token' : (process.env.FORGE_GIT_ASKPASS_TOKEN ?? '');",
        'process.stdout.write(response);',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o700 },
    );
    await writeFile(
      askpassLauncher,
      process.platform === 'win32'
        ? '@echo off\r\n"%FORGE_GIT_ASKPASS_NODE%" "%FORGE_GIT_ASKPASS_SCRIPT%" "%~1"\r\n'
        : '#!/bin/sh\nexec "$FORGE_GIT_ASKPASS_NODE" "$FORGE_GIT_ASKPASS_SCRIPT" "$1"\n',
      { encoding: 'utf8', mode: 0o700 },
    );
    await writeFile(globalConfig, '', { encoding: 'utf8', mode: 0o600 });

    return await runGit(
      [
        '-c',
        'credential.helper=',
        '-c',
        'credential.username=x-access-token',
        'push',
        '--set-upstream',
        'origin',
        branch,
      ],
      workspace,
      signal,
      {
        environment: {
          ...gitProcessEnvironment(),
          GIT_ASKPASS: askpassLauncher,
          GIT_ASKPASS_REQUIRE: 'force',
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_TERMINAL_PROMPT: '0',
          FORGE_GIT_ASKPASS_NODE: process.execPath,
          FORGE_GIT_ASKPASS_SCRIPT: askpassScript,
          FORGE_GIT_ASKPASS_TOKEN: token,
        },
        redact: [token],
        ...(spawnGit ? { spawn: spawnGit } : {}),
      },
    );
  } finally {
    await rm(askpassDirectory, { recursive: true, force: true });
  }
}

/**
 * Return a worktree to exactly HEAD: tracked files restored, untracked files
 * removed, ignored files left alone.
 *
 * This exists for one caller, `applyGitPatch`, and one reason. A worker's
 * attempt patch is `git add --intent-to-add --all` followed by
 * `git diff --binary HEAD`, so it is the COMPLETE diff from HEAD and not an
 * increment on whatever the receiving tree already holds. Applying it to a tree
 * that already carries an earlier attempt therefore double-applies: a modified
 * file fails with "patch does not apply" and a new file with "already exists in
 * working directory".
 *
 * That made every repair round fail, for any objective, and it went unseen
 * until 05/10/2026 because no run had ever got past verification to a second
 * builder call. The first attempt always lands on a clean tree.
 *
 * `git clean -fd` without `-x` keeps ignored files, which is what is wanted: a
 * `node_modules` or a `.next` is not the builder's work and the patch will not
 * recreate it, while the builder's new files are in the patch and so are safe
 * to remove.
 */
export async function resetWorktreeToHead(cwd: string, signal?: AbortSignal): Promise<void> {
  // runGit rejects on a non-zero exit with the command and stderr in the
  // message, so neither call needs its own check.
  await runGit(['reset', '--hard', 'HEAD'], cwd, signal);
  await runGit(['clean', '-fd'], cwd, signal);
}

/**
 * Apply a patch that is the complete diff from HEAD.
 *
 * The tree is returned to HEAD first, which makes the operation idempotent:
 * afterwards the tree is HEAD plus the patch, whatever it held before. See
 * `resetWorktreeToHead` for why that matters and what it cost.
 */
/**
 * The commit-time secret scan matched, and no approval covered this exact
 * content.
 *
 * Thrown rather than returned so the default stays safe: a caller that does
 * nothing about it does not commit. It carries the digest of the staged diff it
 * refused, which is what an approval is pinned to, and the matching lines with
 * their values already redacted - the evidence has to be shown to a person
 * without putting a candidate secret in an approval record.
 */
export class SecretScanRefusal extends Error {
  constructor(
    readonly digest: string,
    readonly evidence: string[],
  ) {
    super(
      `Potential secret detected in staged changes (${evidence.length} line${
        evidence.length === 1 ? '' : 's'
      }); approval required`,
    );
    this.name = 'SecretScanRefusal';
  }
}

/** sha256 of a staged diff: what a secret-scan approval is pinned to. */
export function stagedDiffDigest(staged: string): string {
  return createHash('sha256').update(staged).digest('hex');
}

/**
 * The lines the scan matched, with the matched values replaced. Only the lines,
 * not the whole diff, so an approval record stays small and readable.
 */
function secretScanEvidence(staged: string): string[] {
  return staged
    .split(/\r?\n/)
    .filter((line) => containsLikelySecret(line))
    .map((line) => redactSecrets(line).trim())
    .slice(0, 40);
}

export async function applyGitPatch(
  patch: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  // An empty patch still means "the tree is HEAD": a builder that reverted its
  // own earlier work sends one, and leaving the earlier work in place would
  // commit changes no attempt produced.
  await resetWorktreeToHead(cwd, signal);
  if (!patch.trim()) return;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolvePromise();
      else reject(new Error(`git apply failed (${code ?? -1}): ${stderr.trim()}`));
    });
    child.stdin.end(patch);
  });
}

/**
 * `git worktree add` refusals that `prune` followed by `add -f` recovers from:
 * the branch is held by another worktree (git 2.42+ says "already used by
 * worktree", older releases "already checked out"), or the path is a
 * registered worktree whose directory is gone.
 */
/** What the cache fetches: remote branches into remote-tracking refs (see `register`, BLK-032). */
const CACHE_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const WORKTREE_ADD_FORCEABLE =
  /already (checked out|used by worktree)|missing but already registered|is already registered/i;

export class GitWorkspaceRuntime {
  constructor(readonly root: string) {
    // The root is used two ways at once: as the spawn cwd for runGit, and as the
    // base for cache/worktree paths that git then resolves against that same cwd.
    // A relative root is therefore applied twice and lands in <root>/<root>/cache,
    // and the resulting non-existent cwd is reported by Windows as
    // "spawn git ENOENT" — an error that names the wrong thing entirely.
    // Fail loudly here rather than let a caller discover it at runtime.
    if (!isAbsolute(root)) {
      throw new Error(`GitWorkspaceRuntime root must be an absolute path, received: ${root}`);
    }
  }
  private cache(projectId: string) {
    return join(this.root, 'cache', `${projectId}.git`);
  }
  private workspace(taskId: string) {
    return join(this.root, 'worktrees', taskId);
  }
  /**
   * Clone the repository into the cache on first sight, and bring the cache up
   * to date on every later call.
   *
   * BLK-032. A bare clone is created with no `remote.origin.fetch` refspec, so
   * the old `git fetch --prune origin` downloaded objects and moved no branch:
   * the cache's `main` stayed at the commit of the first clone, and every
   * worktree branched from it. The refspec is therefore set explicitly (and
   * re-set on each call, which also repairs a cache cloned before this fix),
   * and it writes remote-tracking refs, not `refs/heads/*`: git refuses to
   * update a branch that a worktree has checked out, and the `forge/*` task
   * branches are exactly that.
   */
  async register(projectId: string, url: string) {
    assertSafeIdentifier(projectId, 'project');
    await mkdir(join(this.root, 'cache'), { recursive: true });
    const target = this.cache(projectId);
    if (!(await pathExists(target)))
      await runGit(['clone', '--bare', '--filter=blob:none', url, target], this.root);
    await runGit(
      ['--git-dir', target, 'config', '--replace-all', 'remote.origin.fetch', CACHE_FETCH_REFSPEC],
      this.root,
    );
    await runGit(['--git-dir', target, 'fetch', '--prune', 'origin'], this.root);
    return target;
  }
  /**
   * Where a new worktree starts. A branch name resolves to the remote's tip
   * (`refs/remotes/origin/<name>`, which `register` keeps current), not to the
   * cache's own branch of that name, which is frozen at the first clone
   * (BLK-032). A tag, a commit, or a name that only exists locally is used as
   * given.
   */
  private async startPoint(cache: string, baseRef: string): Promise<string> {
    const remote = `refs/remotes/origin/${baseRef}`;
    try {
      await runGit(
        ['--git-dir', cache, 'rev-parse', '--verify', '--quiet', `${remote}^{commit}`],
        this.root,
      );
      return remote;
    } catch {
      return baseRef;
    }
  }
  /**
   * The worktree for a task, created or re-entered. Partial state left by an
   * earlier run is recovered rather than tripped over (docs/OPERATIONS.md
   * "Worktrees and retries"): a registration whose directory was deleted is
   * pruned; a directory that is not a worktree of this cache (a partial clone,
   * an interrupted add, junk) is removed and recreated; a branch another
   * worktree holds, or a missing-but-registered path, is added with `-f`. A
   * registered worktree on the expected branch is returned as it is, and one
   * on another branch is still an error, since it may hold someone's work.
   */
  async createWorktree(projectId: string, taskId: string, baseRef: string, branch: string) {
    assertSafeIdentifier(projectId, 'project');
    assertSafeIdentifier(taskId, 'task');
    assertSafeRef(branch);
    const cache = this.cache(projectId),
      workspace = this.workspace(taskId);
    await mkdir(dirname(workspace), { recursive: true });
    await this.pruneWorktrees(cache);
    if (await pathExists(workspace)) {
      if (!(await isPathWithin(workspace, join(this.root, 'worktrees'))))
        throw new Error('Existing workspace is outside managed root');
      const currentBranch = await this.worktreeBranch(cache, workspace);
      if (currentBranch !== undefined) {
        if (currentBranch !== branch) throw new Error('Existing workspace branch does not match');
        return workspace;
      }
      await rm(workspace, { recursive: true, force: true });
      await this.pruneWorktrees(cache);
    }
    try {
      await runGit(
        [
          '--git-dir',
          cache,
          'worktree',
          'add',
          '-b',
          branch,
          workspace,
          await this.startPoint(cache, baseRef),
        ],
        this.root,
      );
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
      try {
        await runGit(['--git-dir', cache, 'worktree', 'add', workspace, branch], this.root);
      } catch (retryError) {
        if (!WORKTREE_ADD_FORCEABLE.test(String(retryError))) throw retryError;
        await this.pruneWorktrees(cache);
        await runGit(['--git-dir', cache, 'worktree', 'add', '-f', workspace, branch], this.root);
      }
    }
    return workspace;
  }
  private async pruneWorktrees(cache: string) {
    await runGit(['--git-dir', cache, 'worktree', 'prune'], this.root);
  }
  /**
   * The branch checked out in `workspace`, or undefined when the directory is
   * not a working worktree of this cache. Registration alone is not enough (a
   * registered worktree whose `.git` file is gone is a partial), and neither
   * is `git branch --show-current` alone: the managed root may sit inside
   * another repository, as the default `.forge/workspaces` does, and from a
   * junk directory git walks up and reports that repository's branch.
   */
  private async worktreeBranch(cache: string, workspace: string): Promise<string | undefined> {
    let registered = false;
    for (const path of await listWorktrees(cache, this.root))
      if (await samePath(path, workspace)) registered = true;
    if (!registered) return undefined;
    try {
      const toplevel = (await runGit(['rev-parse', '--show-toplevel'], workspace)).stdout.trim();
      if (!(await samePath(toplevel, workspace))) return undefined;
      return (await runGit(['branch', '--show-current'], workspace)).stdout.trim();
    } catch {
      return undefined;
    }
  }
  async status(workspace: string) {
    return (await runGit(['status', '--porcelain=v1'], workspace)).stdout;
  }
  async diff(workspace: string, staged = false) {
    return (await runGit(['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff'], workspace))
      .stdout;
  }
  /**
   * The working tree against HEAD **including files that are new**, as both a
   * patch and a `--stat` summary, which `diff` shows nothing of.
   *
   * This exists because the reviewer was being handed nothing. `git diff`
   * excludes untracked files, and a builder asked to add tests produces exactly
   * one untracked file and no tracked change - so on attempt sixteen of the
   * first real objective the reviewer's prompt contained `DIFF:` followed by a
   * blank line, with no hunk anywhere in its 5,707 characters, and it approved
   * the change. It then cited a file mode it could only have read off its own
   * container's bind mount, which is the very thing "cite the file and the
   * hunk" exists to prevent. A review gate that sees nothing is not a gate.
   *
   * `--intent-to-add` records the paths in the index without staging content,
   * which is what makes them appear in `git diff`; it is the same mechanism the
   * worker uses to capture an attempt patch. Both commands run inside the one
   * window so the patch and the summary cannot disagree. The index is put back
   * with `git reset` afterwards, and the method refuses to run at all when
   * something is already staged, so it can never discard staged work.
   */
  async diffWithUntracked(workspace: string): Promise<{ diff: string; stat: string }> {
    if ((await this.diff(workspace, true)).trim())
      throw new Error('Cannot diff with untracked files while changes are staged');
    await runGit(['add', '--intent-to-add', '--all'], workspace);
    try {
      return {
        diff: (await runGit(['diff', '--no-ext-diff'], workspace)).stdout,
        // An explicit width: off a terminal git formats --stat for 80 columns
        // and elides long paths.
        stat: (await runGit(['diff', '--stat=200', '--no-ext-diff'], workspace)).stdout,
      };
    } finally {
      await runGit(['reset'], workspace);
    }
  }
  /**
   * `approvedSecretDigest` is the digest of a staged diff a person has already
   * looked at and accepted. It is compared to the digest of what is staged NOW,
   * so an approval can never carry over to different content - the same
   * guarantee the push path gets from pinning the commit SHA.
   *
   * Dan's decision of four options on 05/10/2026, after the scan refused a test
   * file three runs in a row. A test for password verification has to contain a
   * password literal somewhere, so the alternatives were all forms of letting
   * literals through; this keeps the detector at full strength and sends the one
   * judgement call to a person.
   */
  async commit(workspace: string, message: string, approvedSecretDigest?: string) {
    if (!(await isPathWithin(workspace, join(this.root, 'worktrees'))))
      throw new Error('Workspace is outside managed root');
    const staged = await this.diff(workspace, true);
    if (!staged.trim()) throw new Error('Nothing staged');
    if (containsLikelySecret(staged)) {
      const digest = stagedDiffDigest(staged);
      if (approvedSecretDigest !== digest)
        throw new SecretScanRefusal(digest, secretScanEvidence(staged));
    }
    const authorName = process.env.FORGE_GIT_AUTHOR_NAME ?? 'TheForge';
    const authorEmail = process.env.FORGE_GIT_AUTHOR_EMAIL ?? 'theforge@users.noreply.github.com';
    await runGit(
      [
        '-c',
        `user.name=${authorName}`,
        '-c',
        `user.email=${authorEmail}`,
        'commit',
        '-m',
        message,
        '--no-verify',
      ],
      workspace,
    );
    return (await runGit(['rev-parse', 'HEAD'], workspace)).stdout.trim();
  }
  async cleanup(projectId: string, taskId: string) {
    assertSafeIdentifier(projectId, 'project');
    assertSafeIdentifier(taskId, 'task');
    const workspace = this.workspace(taskId);
    await runGit(
      ['--git-dir', this.cache(projectId), 'worktree', 'remove', '--force', workspace],
      this.root,
    );
    await rm(workspace, { recursive: true, force: true });
  }
}

export class GitHubIntegration {
  private readonly client: Octokit;
  constructor(token: string) {
    if (!token) throw new Error('GitHub token is required');
    this.client = new Octokit({ auth: token });
  }
  async diagnose() {
    const response = await this.client.rest.users.getAuthenticated();
    return { ok: true, login: response.data.login };
  }
  async createDraftPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ) {
    if (head === base) throw new Error('Head branch must differ from base');
    const repository = await this.client.rest.repos.get({ owner, repo });
    if (base === repository.data.default_branch && head === repository.data.default_branch)
      throw new Error('Default branch cannot be used as head');
    const existing = await this.client.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${head}`,
      base,
      state: 'open',
      per_page: 100,
    });
    const open = existing.data[0];
    if (open) {
      return { number: open.number, url: open.html_url, head: open.head.sha };
    }
    const response = await this.client.rest.pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body,
      draft: true,
    });
    return {
      number: response.data.number,
      url: response.data.html_url,
      head: response.data.head.sha,
    };
  }
}

function assertSafeRef(ref: string) {
  if (
    !/^(?![.-])(?!.*\.\.)[-/A-Za-z0-9_.]+$/.test(ref) ||
    ['~', '^', ':', '?', '*', '[', '\\'].some((character) => ref.includes(character)) ||
    /\s/.test(ref) ||
    ref.endsWith('.') ||
    ref.endsWith('/')
  )
    throw new Error('Unsafe Git ref');
}
function assertSafeIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) || value.includes('..'))
    throw new Error(`Unsafe ${label} identifier`);
}
async function isPathWithin(candidate: string, root: string) {
  const [c, r] = await Promise.all([realpath(resolve(candidate)), realpath(resolve(root))]);
  const difference = relative(r, c);
  return (
    difference === '' ||
    (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  );
}
async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
/** Paths of the worktrees `cache` knows, the bare repository itself included; it never matches a workspace. */
async function listWorktrees(cache: string, cwd: string): Promise<string[]> {
  const { stdout } = await runGit(['--git-dir', cache, 'worktree', 'list', '--porcelain'], cwd);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}
/**
 * Whether two paths name the same directory, tolerant of how git reports one:
 * forward slashes and, on Windows, either case. A path that exists is resolved
 * through the filesystem first; a missing one compares by name.
 */
async function samePath(a: string, b: string) {
  return (await canonicalPath(a)) === (await canonicalPath(b));
}
async function canonicalPath(path: string) {
  let canonical = resolve(path);
  try {
    canonical = await realpath(canonical);
  } catch {
    // Missing: compare the name as resolved.
  }
  const normalized = canonical.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function gitProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function defaultGitProcessEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_QUARANTINE_PATH',
    'GIT_WORK_TREE',
  ]) {
    delete environment[key];
  }
  return environment;
}

function redactExactSecrets(value: string, secrets: readonly string[] = []): string {
  return secrets
    .filter(Boolean)
    .reduce((redacted, secret) => redacted.split(secret).join('[REDACTED]'), value);
}
