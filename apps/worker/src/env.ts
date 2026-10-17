import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  environmentFileArgument,
  parseEnvironment,
  type EnvironmentSource,
} from '@theforge/contracts';
import { DEFAULT_TASK_LIMITS } from '@theforge/guardrails';

export const WorkerEnvironmentSchema = z.object({
  FORGE_API_URL: z.string().url().default('http://127.0.0.1:4400'),
  FORGE_WORKER_TOKEN: z.string().min(32),
  FORGE_WORKSPACE_ROOT: z.string().min(1).default('.forge/workspaces'),
  FORGE_WORKER_ID: z.string().min(1),
  FORGE_WORKER_EXECUTOR: z.enum(['docker', 'host']).default('docker'),
  FORGE_SANDBOX_IMAGE: z.string().min(1).default('theforge-worker-sandbox:local'),
  FORGE_CODEX_AUTH_FILE: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * The workspace an API key must be sent with when the key itself is not scoped to one (ADR-039).
   * Anthropic otherwise answers HTTP 400 "not scoped to a workspace". Not a secret.
   */
  FORGE_ANTHROPIC_WORKSPACE_ID: z
    .string()
    .regex(/^wrkspc_[A-Za-z0-9]+$/, { message: 'must look like wrkspc_01AbC...' })
    .optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  FORGE_JOB_HEARTBEAT_MS: z.coerce.number().int().min(250).max(30_000).default(10_000),
  // Per-task bounds (guardrails; docs/OPERATIONS.md "Guardrails in dispatch").
  // A provider job that trips one is aborted and completed as failed with a
  // TASK_LIMIT error, so the run sees the limit as the reason.
  FORGE_TASK_MAX_TOOL_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(DEFAULT_TASK_LIMITS.maxToolCalls),
  FORGE_TASK_MAX_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_440)
    .default(DEFAULT_TASK_LIMITS.maxWallClockMinutes),
  FORGE_TASK_MAX_TOKENS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(100_000_000)
    .default(DEFAULT_TASK_LIMITS.maxTokens),
  // Local models (ADR-021; docs/OPERATIONS.md "Local models"). The worker
  // probes this server at startup and advertises `provider:ollama` plus one
  // `model:<name>` per listed model; an ollama job runs in this process.
  FORGE_OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  /** Role playbooks in the local model's system message (ADR-045). */
  FORGE_LOCAL_SKILLS: z.enum(['on', 'off']).default('off'),
  // `num_ctx` per tier, the measured sweet spots from
  // docs/evidence-local-model-benchmark-2-2026-09-26.txt: tier 1 (qwen3:8b)
  // 5.9 GB resident at 8192, tier 2 (devstral-small-2) 15.8 GB at 16384.
  // Any other model gets the server default.
  FORGE_OLLAMA_NUM_CTX_TIER1: z.coerce.number().int().min(512).max(1_048_576).default(8_192),
  FORGE_OLLAMA_NUM_CTX_TIER2: z.coerce.number().int().min(512).max(1_048_576).default(16_384),
  // Failed workspaces (docs/OPERATIONS.md "Failed workspaces"). A job that
  // fails or is cancelled keeps its workspace under <root>/.failed for a human
  // with disk access; the newest KEEP are held for at most MAX_AGE_HOURS, and
  // KEEP=0 retains nothing.
  FORGE_FAILED_WORKSPACE_KEEP: z.coerce.number().int().min(0).max(1_000).default(5),
  FORGE_FAILED_WORKSPACE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(8_760).default(72),
  // Raw provider output (docs/OPERATIONS.md "Raw provider output"): when the
  // redacted tails of a sandboxed CLI's stdout and stderr travel with the job
  // result. 'failure' is failed provider jobs only, 'always' every provider
  // job, 'never' none.
  FORGE_RAW_OUTPUT: z.enum(['failure', 'always', 'never']).default('failure'),
});
export type WorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema>;

/**
 * Tests import the worker in-process with no `.env`, so a few values are
 * defaulted under NODE_ENV=test only. Nothing is defaulted for production.
 */
export function loadEnvironment(source: EnvironmentSource = process.env): WorkerEnvironment {
  const test = source.NODE_ENV === 'test';
  const environment = {
    ...source,
    ...(test && !source.FORGE_WORKER_TOKEN
      ? { FORGE_WORKER_TOKEN: 'test-worker-token-that-is-long-enough' }
      : {}),
    ...(test && !source.FORGE_WORKER_EXECUTOR ? { FORGE_WORKER_EXECUTOR: 'host' } : {}),
    ...(test && !source.FORGE_WORKER_ID ? { FORGE_WORKER_ID: 'test-worker' } : {}),
  };
  return parseEnvironment(WorkerEnvironmentSchema, environment, 'worker');
}

/** The `.env` this process was pointed at, for the configuration failure header. */
export function environmentFileDescription(): string | undefined {
  const argument = environmentFileArgument(process.execArgv);
  if (!argument) return undefined;
  const path = resolve(argument);
  return existsSync(path) ? path : `${path}, which does not exist`;
}
