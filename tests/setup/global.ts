import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { TestProject } from 'vitest/node';
import {
  acquireAdvisoryLock,
  countRows,
  dropSchemasMatching,
  type AdvisoryLock,
} from '@theforge/db/testing';
import { checkoutPath, leftoverSchemaPattern, testRunLockKey } from './schema-name.js';

/**
 * One run at a time per checkout, and a clean slate before it starts.
 *
 * Two vitest processes on the same checkout - a pre-commit hook fired while
 * `vitest run` was still going, BLK-011 form 2 - each rebuild dist under the
 * other's spawned coordinators and each lease the other's jobs. A session-level
 * advisory lock keyed on the checkout path, held on a dedicated connection for
 * the whole run, turns the second run into an immediate, explained failure
 * instead of an intermittent one.
 *
 * This runs in the main vitest process, where DATABASE_URL may exist only in
 * the config's `env` allowlist rather than in process.env.
 */
const PUBLIC_TABLES = ['public.projects', 'public.runs', 'public.workers'];

/**
 * The filesystem half of the same idea (BLK-021). Suites clone and worktree
 * under `.forge/workspaces`, and what they leave behind outlives the run: by
 * 27/09/2026 it held 460 directories and 28 MB, including shared bare caches
 * (`cache/<projectId>.git`) that a later run then fails to re-clone into. The
 * symptom is the worst kind - a different test fails on each run - and it had
 * already been worked around twice in individual suites before it was swept
 * here. Removed before the run, not after, so a failed run's workspaces are
 * still there to inspect.
 */
const TEST_WORKSPACE_ROOT = join(checkoutPath(), '.forge', 'workspaces');

async function sweepWorkspaceRoot(): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(TEST_WORKSPACE_ROOT);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      await rm(join(TEST_WORKSPACE_ROOT, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory held open by something else is not worth failing the run for;
      // the count reported below will simply be lower than the entry count.
    }
  }
  return removed;
}

/**
 * The third instance of the same idea, and the one that holds memory rather than
 * disk.
 *
 * The Docker sandbox suites start containers labelled
 * `theforge.worker=test-worker`, every one with `--rm`, so a container removes
 * itself the moment it exits. What `--rm` cannot survive is the *vitest process*
 * being killed: a suite interrupted mid-flight leaves its sandbox running, and
 * the fixture's command is `setInterval(()=>{},1000)`, so it runs until
 * something stops it. Three were found alive on 04/10/2026 - the oldest for over
 * three hours - each holding a 2 GB memory limit and a bind mount into a
 * workspace `sweepWorkspaceRoot` had already deleted underneath it.
 *
 * This is **not** a defect in the cancellation path. `executeDockerCommand` does
 * stop its container on abort; running that test alone leaves nothing behind,
 * which was checked before writing this. It is purely the killed-process case,
 * which is also why no suite can clean up after it and the sweep belongs here.
 *
 * Failure is never fatal and never noisy. The portable CI jobs have no Docker
 * daemon at all, so a missing `docker` must leave the run completely alone
 * rather than break suites that never wanted it.
 */
const SANDBOX_CONTAINER_LABEL = 'theforge.worker=test-worker';
const execFileAsync = promisify(execFile);

async function sweepSandboxContainers(): Promise<number> {
  let ids: string[];
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-aq', '--filter', `label=${SANDBOX_CONTAINER_LABEL}`],
      { timeout: 15_000 },
    );
    ids = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // No daemon or no `docker` on PATH. Not worth failing a test run over, and
    // the Docker suites skip themselves in the same situation.
    return 0;
  }
  if (ids.length === 0) return 0;
  try {
    await execFileAsync('docker', ['rm', '-f', ...ids], { timeout: 60_000 });
    return ids.length;
  } catch (error) {
    // Deliberately NOT swallowed, unlike the probe above. This branch means
    // containers were found and could not be removed, and the next thing that
    // happens is a Docker suite failing on a container it did not start - which
    // is how BLK-030 presented three times on 06/10/2026, each time as a
    // confusing assertion rather than as this, the actual fault.
    throw new Error(
      `Could not remove ${ids.length} leftover sandbox container(s) (${ids.join(', ')}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Remove them by hand with \`docker rm -f\` and re-run.`,
    );
  }
}

let baseUrl: string | undefined;
let lock: AdvisoryLock | undefined;
let swept: string[] = [];
let sweptWorkspaces = 0;
let sweptContainers = 0;
let before: Record<string, number> = {};

export async function setup(project: TestProject): Promise<void> {
  baseUrl = process.env.DATABASE_URL ?? project.config.env?.DATABASE_URL;
  if (!baseUrl) return;
  lock = await acquireAdvisoryLock(baseUrl, testRunLockKey());
  if (lock.acquired) {
    swept = await dropSchemasMatching(baseUrl, leftoverSchemaPattern());
    // Only with the lock held: a concurrent run's workspaces and containers are
    // in use, and removing them would break the run that owns them.
    sweptWorkspaces = await sweepWorkspaceRoot();
    sweptContainers = await sweepSandboxContainers();
  } else if (process.env.FORGE_TEST_ALLOW_CONCURRENT === '1') {
    console.warn(
      '[vitest] FORGE_TEST_ALLOW_CONCURRENT=1: running alongside another vitest run on this checkout; leftover schemas are not swept.',
    );
  } else {
    throw new Error(
      `Another vitest run on ${checkoutPath()} already holds the database lock - most likely a ` +
        'pre-commit hook or a second shell. Wait for it to finish, or set ' +
        'FORGE_TEST_ALLOW_CONCURRENT=1 to run anyway (the leftover-schema sweep is then skipped).',
    );
  }
  before = await countRows(baseUrl, PUBLIC_TABLES);
}

export async function teardown(): Promise<void> {
  if (!baseUrl) return;
  let after: Record<string, number> = {};
  try {
    after = await countRows(baseUrl, PUBLIC_TABLES);
  } finally {
    await lock?.release();
  }
  const deltas = Object.entries(before).map(
    ([table, count]) => `${table.replace('public.', '')} ${count}->${after[table] ?? '?'}`,
  );
  const leaked = Object.entries(before).some(([table, count]) => after[table] !== count);
  console.info(
    `[vitest] schema isolation: lock ${lock?.acquired ? 'held' : 'bypassed'}, swept ${swept.length} leftover schema(s), ${sweptWorkspaces} leftover workspace(s) and ${sweptContainers} leftover container(s), public rows ${deltas.join(', ')}${leaked ? ' - CHANGED: a suite wrote to the shared schema' : ' (unchanged)'}`,
  );
}
