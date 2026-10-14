/**
 * Concurrency and kill switch.
 *
 * Both exist because an autonomous system needs a way to be stopped and a
 * ceiling on how much of the machine it may consume. Neither is interesting
 * until the moment it matters, at which point nothing else will do.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Policy B8: at most four concurrent Claude Code agents. */
export const MAX_CONCURRENT_AGENTS = 4;

/**
 * Refuse to lease new work below this much free system memory.
 *
 * Dan chose 4 concurrent agents over the recommended 3. Each is a Claude Code
 * process plus a Docker container capped at 2 GB, running alongside the
 * coordinator, worker, web app, PostgreSQL and Redis, on a 32 GB machine where
 * WSL2 already claims 16 GB. At 4 the headroom is genuinely thin once builds
 * and test runs are also in flight, so the cap alone is not sufficient - this
 * floor is what makes 4 safe rather than optimistic.
 */
export const MIN_FREE_MEMORY_MB = 3072;

export type ConcurrencyState = {
  activeAgents: number;
  freeMemoryMb: number;
};

export type LeaseVerdict = { allowed: true } | { allowed: false; reason: string };

export function canLeaseWork(
  state: ConcurrencyState,
  maxAgents: number = MAX_CONCURRENT_AGENTS,
  minFreeMemoryMb: number = MIN_FREE_MEMORY_MB,
): LeaseVerdict {
  if (state.activeAgents >= maxAgents) {
    return {
      allowed: false,
      reason: `${state.activeAgents} agents already running; the limit is ${maxAgents}`,
    };
  }
  if (state.freeMemoryMb < minFreeMemoryMb) {
    return {
      allowed: false,
      reason: `only ${state.freeMemoryMb} MB free memory; ${minFreeMemoryMb} MB required before leasing more work`,
    };
  }
  return { allowed: true };
}

/**
 * Policy B13: the kill switch is both a file and a command.
 *
 * Two ways in, one source of truth. The command (`pnpm forge halt`, or
 * POST /api/halt) exists because it is quick and can carry a reason; the file
 * exists because it can be created from anywhere - a file manager, another
 * machine over a share, a phone with filesystem access - when no shell or API
 * is answering. Both end in the same place: the halt file. Nothing else holds
 * halt state, so a halt survives a coordinator restart and every observer
 * (coordinator, CLI, a human with `ls`) agrees on whether the system is halted.
 */
export const KILL_SWITCH_FILENAME = 'FORGE_HALT';

/**
 * Mirrors the coordinator's FORGE_WORKSPACE_ROOT default. The halt file sits
 * one directory above the workspace root so it is beside, not inside, the
 * worktrees that get created and deleted.
 */
const DEFAULT_WORKSPACE_ROOT = '.forge/workspaces';

/**
 * Where the halt file lives. FORGE_HALT_FILE wins when set; otherwise it is
 * `<FORGE_WORKSPACE_ROOT>/../FORGE_HALT` with the workspace root made absolute
 * first, so the answer is stable however the caller was launched. The
 * coordinator and the CLI both resolve through here, and an operator who sets
 * FORGE_HALT_FILE to an absolute path removes the working directory from the
 * equation entirely - which matters because `pnpm dev` starts the coordinator
 * from apps/coordinator while `pnpm forge` runs from the repository root.
 */
export function resolveHaltFilePath(
  options: { workspaceRoot?: string | undefined; haltFile?: string | undefined } = {},
): string {
  if (options.haltFile) return resolve(options.haltFile);
  const workspaceRoot = resolve(options.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  return resolve(workspaceRoot, '..', KILL_SWITCH_FILENAME);
}

/** What `pnpm forge halt` and POST /api/halt write into the halt file. */
export type HaltRequest = {
  requestedAt: string;
  requestedBy: string;
  reason?: string;
};

export type HaltFile = {
  path: string;
  exists: boolean;
  /** Absent when the file is missing or was not written by us (a bare `touch` still halts). */
  request?: HaltRequest;
};

export function parseHaltRequest(text: string): HaltRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const { requestedAt, requestedBy, reason } = parsed as Record<string, unknown>;
  if (typeof requestedAt !== 'string' || typeof requestedBy !== 'string') return undefined;
  if (reason !== undefined && typeof reason !== 'string') return undefined;
  return { requestedAt, requestedBy, ...(reason ? { reason } : {}) };
}

/**
 * Write-to-temp then rename, so a reader never sees a half-written file. The
 * coordinator's lease path only asks whether the file exists, so even the
 * temporary name must differ from the real one or the halt would fire early.
 */
export async function writeHaltFile(path: string, request: HaltRequest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function readHaltFile(path: string): Promise<HaltFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false };
    throw error;
  }
  const request = parseHaltRequest(text);
  return { path, exists: true, ...(request ? { request } : {}) };
}

/** Resolves true when a file was removed, false when there was nothing to remove. */
export async function removeHaltFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export type HaltState = {
  /** True when the halt file exists. */
  fileExists: boolean;
  /**
   * @deprecated The coordinator no longer holds halt state in memory; an API
   * halt writes the file instead. Kept so existing callers still compile.
   */
  apiRequested?: boolean;
};

export type HaltVerdict = {
  halted: boolean;
  source: 'file' | 'api' | 'none';
  message: string;
};

export function checkHalt(state: HaltState): HaltVerdict {
  if (state.fileExists) {
    return {
      halted: true,
      source: 'file',
      message: `halt requested: ${KILL_SWITCH_FILENAME} is present. Delete it to resume.`,
    };
  }
  if (state.apiRequested) {
    return { halted: true, source: 'api', message: 'halt requested through the coordinator API' };
  }
  return { halted: false, source: 'none', message: 'running' };
}

/**
 * Per-task bounds. A task that cannot finish is worse than one that fails,
 * because it holds a lease and consumes budget while producing nothing.
 */
export type TaskLimits = {
  maxToolCalls: number;
  maxWallClockMinutes: number;
  maxTokens: number;
};

export const DEFAULT_TASK_LIMITS: TaskLimits = {
  maxToolCalls: 200,
  maxWallClockMinutes: 30,
  maxTokens: 150_000,
};

export type TaskUsage = {
  toolCalls: number;
  elapsedMinutes: number;
  tokens: number;
};

/**
 * The tokens a call did fresh work on: total input less the cached portion,
 * plus output. Structural rather than typed against `@theforge/contracts`, for
 * the same reason `UsageLike` is - this package stays free of that dependency.
 *
 * Every *limit* counts these rather than raw totals, deliberately. Migration
 * 008 corrected the Claude adapter, whose reported input had been excluding the
 * prompt cache entirely, so a figure that used to read 4 now reads tens of
 * thousands. Counting the corrected total against the thresholds would have
 * made the run budget (`maxTokens`, 100,000 by default) and this per-task limit
 * (150,000) trip partway through runs that had always completed, because both
 * were calibrated against the understated numbers. Correcting the ledger must
 * not quietly shrink what a run is allowed to do. A cache read is also a tenth
 * the price of a fresh token, so charging it at par overstates it regardless.
 *
 * The ledger still records the truth; only the thresholds read the fresh
 * figure. That is why `runs.spent.tokens` is smaller than the sum of
 * `usage_records.input_tokens + output_tokens` over the same run, and the
 * difference is exactly `cached_input_tokens`.
 */
export function freshTokens(usage: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
}): number {
  // Clamped: a provider reporting more cached than total input is malformed,
  // and a negative contribution would make a limit easier to pass.
  return Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0)) + usage.outputTokens;
}

export function checkTaskLimits(
  usage: TaskUsage,
  limits: TaskLimits = DEFAULT_TASK_LIMITS,
): LeaseVerdict {
  if (usage.toolCalls > limits.maxToolCalls)
    return {
      allowed: false,
      reason: `tool call limit exceeded (${usage.toolCalls} > ${limits.maxToolCalls})`,
    };
  if (usage.elapsedMinutes > limits.maxWallClockMinutes)
    return {
      allowed: false,
      reason: `time limit exceeded (${usage.elapsedMinutes.toFixed(1)} > ${limits.maxWallClockMinutes} minutes)`,
    };
  if (usage.tokens > limits.maxTokens)
    return {
      allowed: false,
      reason: `token limit exceeded (${usage.tokens} > ${limits.maxTokens})`,
    };
  return { allowed: true };
}
