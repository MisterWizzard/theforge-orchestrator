import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  EnvironmentError,
  environmentFileArgument,
  environmentRemedy,
  parseEnvironment,
  type EnvironmentSource,
} from '@theforge/contracts';
import { DEFAULT_TIME_ZONE, isValidTimeZone } from '@theforge/guardrails';
import { NOTIFY_DEFAULTS } from '@theforge/notify';
import { DEFAULT_STAGE_TIMEOUT_MS } from '@theforge/workflows';

export const CoordinatorEnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4400),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  FORGE_WORKER_TOKEN: z.string().min(32),
  FORGE_COORDINATOR_TOKEN: z.string().min(32),
  FORGE_WORKSPACE_ROOT: z.string().min(1).default('.forge/workspaces'),
  /** Absolute path of the kill-switch file; unset means <workspace root>/../FORGE_HALT. */
  FORGE_HALT_FILE: z.string().optional(),
  FORGE_WEB_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
  FORGE_JOB_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  FORGE_VOLATILE_MODE: z.enum(['true', 'false']).default('false'),
  GITHUB_TOKEN: z.string().min(1).optional(),
  // Guardrails in dispatch (policies B2, B3, B8; docs/OPERATIONS.md "Guardrails
  // in dispatch"). Kept together; other slices append their own groups below.
  /** Daily cloud spend ceiling in USD. Zero is legitimate: no cloud calls at all. */
  FORGE_DAILY_CEILING_USD: z.coerce.number().min(0).max(10_000).default(20),
  /**
   * Monthly credit allowance in USD. When set, FORGE_DAILY_CEILING_USD becomes the floor of an
   * adaptive daily cap that spreads what is left over the days remaining (ADR-037). Unset keeps
   * the flat daily ceiling.
   */
  FORGE_MONTHLY_BUDGET_USD: z.coerce.number().positive().max(1_000_000).optional(),
  /** Day of the month (1-28) on which the monthly allowance resets. */
  FORGE_BUDGET_RESET_DAY: z.coerce.number().int().min(1).max(28).default(1),
  /** The most any one day may be capped at, however much of the allowance is left. */
  FORGE_MAX_DAILY_CEILING_USD: z.coerce.number().positive().max(10_000).default(50),
  /** Usage recorded before this ISO date or timestamp was not billed to the allowance. */
  FORGE_BUDGET_COUNT_FROM: z
    .string()
    .refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message: 'must be an ISO date or timestamp such as 2026-10-12T00:00:00+11:00',
    })
    .optional(),
  /** Fraction of the ceiling at which `spend.warn` is emitted. */
  FORGE_CEILING_WARN_FRACTION: z.coerce.number().min(0).max(1).default(0.75),
  /** Leased provider jobs allowed at once; each is one running agent. */
  FORGE_MAX_AGENTS: z.coerce.number().int().min(1).max(64).default(4),
  /** Refuse to lease any work below this much free memory on the coordinator host. */
  FORGE_MIN_FREE_MEMORY_MB: z.coerce.number().int().min(0).max(1_048_576).default(3072),
  /** IANA zone whose calendar days the ceiling counts in. */
  FORGE_TIMEZONE: z
    .string()
    .min(1)
    .refine(isValidTimeZone, { message: 'must be an IANA time zone such as Australia/Sydney' })
    .default(DEFAULT_TIME_ZONE),
  // Notifications (policy B9). The two secrets are optional so the coordinator
  // boots before Dan has created them; the notifier then uses the file outbox
  // alone. Defaults mirror NOTIFY_DEFAULTS in @theforge/notify.
  FORGE_HA_URL: z.string().url().optional(),
  FORGE_HA_TOKEN: z.string().min(1).optional(),
  FORGE_HA_NOTIFY_SERVICE: z.string().min(1).default(NOTIFY_DEFAULTS.haService),
  FORGE_SMTP_HOST: z.string().min(1).default(NOTIFY_DEFAULTS.smtpHost),
  FORGE_SMTP_PORT: z.coerce.number().int().positive().default(NOTIFY_DEFAULTS.smtpPort),
  FORGE_SMTP_USER: z.string().min(1).optional(),
  FORGE_SMTP_PASSWORD: z.string().min(1).optional(),
  FORGE_NOTIFY_EMAIL_TO: z.string().min(1).default(NOTIFY_DEFAULTS.emailTo),
  /** Where escalations are written; unset means <workspace root>/../outbox. */
  FORGE_OUTBOX_DIR: z.string().min(1).optional(),
  /**
   * Active time a **queued** worker job may wait for a compatible worker to
   * lease it, in ms, before it is cancelled and the run fails. Time under the
   * halt file does not count (docs/OPERATIONS.md "Worktrees and retries").
   *
   * Queued only, since 05/10/2026. It used to bound the total - queued plus
   * executing - and one number cannot be right for both: waiting for a worker
   * should give up early, while a worker that HAS the job needs longer than a
   * stage's own wall clock. At 30 minutes each, attempt eighteen of the first
   * real objective had the coordinator cancel a builder job whose result
   * carried `code: 0`. Executing time is now `FORGE_WORKER_JOB_EXECUTION_MS`.
   *
   * The name, the 900000 default and the halt-aware behaviour are unchanged,
   * because this is the meaning they always described - `docs/OPERATIONS.md`
   * said "how long an already-queued job waits for a worker to lease it" while
   * the code charged execution to it as well.
   */
  FORGE_WORKER_JOB_WAIT_MS: z.coerce.number().int().min(1_000).default(900_000),
  /**
   * Active time a **leased** worker job gets to finish, in ms, counted from the
   * lease rather than from submission. Halted time does not count, as with the
   * queue budget above.
   *
   * Defaults to the stage timeout plus five minutes, which is the relationship
   * that matters: this bounds a stage's own wall clock plus the lease, the
   * workspace materialisation and the transport of the result, so it has to
   * leave room above `FORGE_STAGE_TIMEOUT_MS` rather than match it. Five
   * minutes also clears the worker's container deadline of
   * `(FORGE_TASK_MAX_MINUTES + 1)` minutes, so the coordinator does not give up
   * before the worker's own hard kill has had a chance to report.
   *
   * Not enforced as an ordering at boot. That was tried on 05/10/2026 and was
   * wrong: a short queue budget with a long stage timeout is a legitimate
   * configuration - it is the shipped default, and what the halt integration
   * test exercises - so a refusal would have rejected the product's own setup.
   */
  FORGE_WORKER_JOB_EXECUTION_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(DEFAULT_STAGE_TIMEOUT_MS + 300_000),
  /**
   * Wall clock for one provider attempt. Thirty minutes by default, matching
   * both `FORGE_TASK_MAX_MINUTES` and the per-task wall clock, because all
   * three bound the same thing. It was hardcoded at 15 minutes until
   * 04/10/2026 and was the fifth limit a real builder stage hit.
   */
  FORGE_STAGE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(DEFAULT_STAGE_TIMEOUT_MS),
  /**
   * How long a run may wait for a worker to come online and advertise a
   * provider before the run is paused instead of failed (ADR-029). A
   * coordinator that has just started has no online worker for the first
   * moments of its life, so a run resumed across a restart used to fail
   * instantly on the cold-start reading. 0 restores that behaviour. The wait
   * never applies while a worker is already online, so a provider a live
   * worker genuinely does not advertise still fails fast
   * (docs/OPERATIONS.md "Waiting for a worker after a restart").
   */
  FORGE_PROVIDER_WAIT_MS: z.coerce.number().int().min(0).max(3_600_000).default(90_000),
  /** Repository conventions as context for stages routed to a local model (ADR-045). */
  FORGE_LOCAL_SKILLS: z.enum(['on', 'off']).default('off'),
});
export type CoordinatorEnvironment = z.infer<typeof CoordinatorEnvironmentSchema>;

/**
 * Tests import the coordinator in-process with no `.env`, so both tokens are
 * defaulted under NODE_ENV=test only. Nothing is defaulted for production, and
 * running without PostgreSQL has to be asked for by name.
 */
export function loadEnvironment(source: EnvironmentSource = process.env): CoordinatorEnvironment {
  const test = source.NODE_ENV === 'test';
  const environment = {
    ...source,
    ...(test && !source.FORGE_WORKER_TOKEN
      ? { FORGE_WORKER_TOKEN: 'test-worker-token-that-is-long-enough' }
      : {}),
    ...(test && !source.FORGE_COORDINATOR_TOKEN
      ? { FORGE_COORDINATOR_TOKEN: 'test-coordinator-token-that-is-long-enough' }
      : {}),
    // A per-run temporary halt file, so the suite can halt and resume freely
    // without ever touching the operator's real kill switch.
    ...(test && !source.FORGE_HALT_FILE
      ? { FORGE_HALT_FILE: resolve(tmpdir(), `FORGE_HALT.test-${randomUUID()}`) }
      : {}),
    // The free-memory floor is a production safety net, not a property of the
    // suite: hosted macOS runners have 7 GB in total and would refuse every
    // lease at the 3072 MB default, failing tests that have nothing to do with
    // memory. Under test the floor is off unless a test sets it on purpose
    // (guards.lease.test.ts does, to prove the refusal path).
    ...(test && !source.FORGE_MIN_FREE_MEMORY_MB ? { FORGE_MIN_FREE_MEMORY_MB: '0' } : {}),
  };
  const env = parseEnvironment(CoordinatorEnvironmentSchema, environment, 'coordinator');
  if (!env.DATABASE_URL && !test && env.FORGE_VOLATILE_MODE !== 'true') {
    throw new EnvironmentError('coordinator', [
      {
        variable: 'DATABASE_URL',
        message: 'DATABASE_URL is required; volatile coordinator state must be explicitly enabled',
        remedy: environmentRemedy('DATABASE_URL'),
      },
    ]);
  }
  return env;
}

/** The `.env` this process was pointed at, for the configuration failure header. */
export function environmentFileDescription(): string | undefined {
  const argument = environmentFileArgument(process.execArgv);
  if (!argument) return undefined;
  const path = resolve(argument);
  return existsSync(path) ? path : `${path}, which does not exist`;
}
