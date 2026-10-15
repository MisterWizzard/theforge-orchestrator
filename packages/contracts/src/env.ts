import type { z } from 'zod';

/**
 * Configuration parsing shared by the coordinator and the worker.
 *
 * Node's `--env-file` turns a `KEY=` line into the empty string rather than an
 * absent variable, so a field declared `z.string().min(1).optional()` rejected
 * the shipped `.env.example` and the process died with a zod stack trace before
 * its own diagnostics ran. Both apps therefore parse through here: empty means
 * unset, and a failure is one actionable line per variable.
 */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type EnvironmentIssue = {
  variable: string;
  message: string;
  remedy: string;
};

export class EnvironmentError extends Error {
  readonly appName: string;
  readonly issues: readonly EnvironmentIssue[];

  constructor(appName: string, issues: readonly EnvironmentIssue[]) {
    super(issues.map(formatEnvironmentIssue).join('\n'));
    this.name = 'EnvironmentError';
    this.appName = appName;
    this.issues = issues;
  }
}

const TOKEN_REMEDY =
  "generate 32+ random characters, e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

/**
 * What to do about each variable the apps read. Anything not listed gets a
 * generic pointer at `.env.example`, so adding a variable without a remedy is
 * a documentation gap rather than a crash.
 */
export const ENVIRONMENT_REMEDIES: Readonly<Record<string, string>> = {
  PORT: 'a TCP port for the coordinator to listen on, e.g. 4400',
  HOST: 'an address for the coordinator to bind, e.g. 127.0.0.1 (a Tailscale address for private workers)',
  DATABASE_URL:
    'a PostgreSQL URL, e.g. postgres://forge:forge@localhost:5432/forge for the docker-compose service; FORGE_VOLATILE_MODE=true runs without one and loses all state on restart',
  REDIS_URL:
    'a Redis URL, e.g. redis://localhost:6379 for the docker-compose service, or leave the line out to use the in-memory queue',
  FORGE_API_URL:
    'the coordinator URL workers register with, e.g. http://127.0.0.1:4400; remote workers need https://',
  FORGE_WEB_ORIGIN: 'the control centre origin allowed by CORS, e.g. http://127.0.0.1:3000',
  FORGE_WORKSPACE_ROOT: 'a directory for managed workspaces, e.g. .forge/workspaces',
  FORGE_WORKER_ID:
    'a stable identifier for this machine, e.g. its hostname; keep it the same across restarts',
  FORGE_WORKER_EXECUTOR: 'docker (the default) or host; host is test-only',
  FORGE_SANDBOX_IMAGE: 'the image built by pnpm sandbox:build, e.g. theforge-worker-sandbox:local',
  FORGE_JOB_HEARTBEAT_MS: 'a whole number of milliseconds from 250 to 30000',
  FORGE_JOB_LEASE_MS: 'a whole number of milliseconds from 1000 to 300000',
  FORGE_VOLATILE_MODE: 'true or false',
  FORGE_WORKER_TOKEN: TOKEN_REMEDY,
  FORGE_COORDINATOR_TOKEN: `${TOKEN_REMEDY}, independent of FORGE_WORKER_TOKEN`,
  GITHUB_TOKEN:
    'a fine-grained token limited to the target repository (Metadata read, Contents and Pull requests read/write), or leave the line out',
  ANTHROPIC_API_KEY: 'an Anthropic API key, or leave the line out',
  OPENAI_API_KEY: 'an OpenAI API key, or leave the line out',
  FORGE_CODEX_AUTH_FILE: 'path to an isolated Codex auth.json file, or leave the line out',
  FORGE_HALT_FILE:
    'an absolute path for the kill-switch file, or leave the line empty for <workspace root>/../FORGE_HALT',
  FORGE_DAILY_CEILING_USD:
    'cloud spend allowed per local day in USD, 0 to 10000 (0 means no cloud calls)',
  FORGE_ANTHROPIC_WORKSPACE_ID:
    'an Anthropic workspace id such as wrkspc_01AbC..., needed only when ANTHROPIC_API_KEY is not scoped to a workspace (Console, Settings, Workspaces); not a secret',
  FORGE_MONTHLY_BUDGET_USD:
    'the monthly credit allowance in USD (above 0); with it set, FORGE_DAILY_CEILING_USD is the floor of an adaptive daily cap, or leave the line out for the flat ceiling',
  FORGE_BUDGET_RESET_DAY: 'a whole number from 1 to 28: the day of the month the allowance resets',
  FORGE_MAX_DAILY_CEILING_USD:
    'the most any one day may be capped at, in USD (above 0, up to 10000), e.g. 50',
  FORGE_BUDGET_COUNT_FROM:
    'an ISO date or timestamp, e.g. 2026-10-12T00:00:00+11:00; usage recorded before it is not counted against the allowance',
  FORGE_CEILING_WARN_FRACTION:
    'a fraction from 0 to 1 of the daily ceiling at which spend.warn fires',
  FORGE_MAX_AGENTS: 'a whole number from 1 to 64 of provider jobs leased at once',
  FORGE_MIN_FREE_MEMORY_MB:
    'a whole number of megabytes from 0 to 1048576 that must stay free before a lease is granted',
  FORGE_TIMEZONE: 'an IANA time zone such as Australia/Sydney',
  FORGE_HA_URL: 'the Home Assistant base URL, e.g. http://192.168.1.10/ha, or leave the line out',
  FORGE_HA_TOKEN:
    'a Home Assistant long-lived access token (profile, Long-lived access tokens), or leave the line out',
  FORGE_HA_NOTIFY_SERVICE:
    'the notify service name without the notify. prefix, e.g. mobile_app_phone',
  FORGE_SMTP_HOST: 'an SMTP host reachable over implicit TLS, e.g. smtp.gmail.com',
  FORGE_SMTP_PORT: 'the SMTP port for implicit TLS, e.g. 465',
  FORGE_SMTP_USER: 'the sending mailbox address, or leave the line out',
  FORGE_SMTP_PASSWORD:
    'an app password for the sending mailbox (never the account password), or leave the line out',
  FORGE_NOTIFY_EMAIL_TO: 'the mailbox that receives escalations',
  FORGE_OUTBOX_DIR:
    'an absolute directory for escalation files and Tier 0 outcomes, or leave the line out for <workspace root>/../outbox',
  FORGE_WORKER_JOB_WAIT_MS:
    'a whole number of active milliseconds, at least 1000, that a QUEUED worker job may wait for a worker to lease it; time under the halt file does not count, and executing time is bounded separately by FORGE_WORKER_JOB_EXECUTION_MS',
  FORGE_WORKER_JOB_EXECUTION_MS:
    'a whole number of active milliseconds, at least 1000, that a LEASED worker job gets to finish, counted from the lease; leave room above FORGE_STAGE_TIMEOUT_MS, which bounds the stage inside it, and the default is that plus five minutes',
  FORGE_STAGE_TIMEOUT_MS:
    'a whole number of milliseconds, at least 1000, of wall clock for one provider attempt; 1800000 by default to match FORGE_TASK_MAX_MINUTES and the per-task wall clock, since all three bound the same thing',
  FORGE_PROVIDER_WAIT_MS:
    'a whole number of milliseconds from 0 to 3600000 that a run waits for a worker to advertise a provider before it is paused; 0 fails the run at once, as before ADR-029',
  FORGE_TASK_MAX_TOOL_CALLS: 'a whole number from 1 to 100000 of tool requests per provider job',
  FORGE_TASK_MAX_MINUTES: 'a whole number from 1 to 1440 of wall-clock minutes per provider job',
  FORGE_TASK_MAX_TOKENS: 'a whole number from 1000 to 100000000 of tokens per provider job',
  FORGE_OLLAMA_URL: 'the local Ollama base URL, e.g. http://127.0.0.1:11434',
  FORGE_OLLAMA_NUM_CTX_TIER1: 'a whole number from 512 to 1048576 for the tier-1 model context',
  FORGE_OLLAMA_NUM_CTX_TIER2: 'a whole number from 512 to 1048576 for the tier-2 model context',
  FORGE_FAILED_WORKSPACE_KEEP:
    'a whole number from 0 to 1000 of failed workspaces to keep under .failed',
  FORGE_FAILED_WORKSPACE_MAX_AGE_HOURS:
    'a whole number from 1 to 8760 of hours a kept failed workspace survives',
  FORGE_RAW_OUTPUT: 'failure (the default), always or never',
};

export function environmentRemedy(variable: string): string {
  return (
    ENVIRONMENT_REMEDIES[variable] ?? `set ${variable} to a valid value in .env (see .env.example)`
  );
}

export function formatEnvironmentIssue(issue: EnvironmentIssue): string {
  return `${issue.variable}: ${issue.message} — ${issue.remedy}`;
}

/** A copy of `source` without empty values, so `KEY=` behaves as unset. */
export function normaliseEnvironment(source: EnvironmentSource): Record<string, string> {
  const normalised: Record<string, string> = {};
  for (const [variable, value] of Object.entries(source)) {
    if (value === undefined || value === '') continue;
    normalised[variable] = value;
  }
  return normalised;
}

export function parseEnvironment<Schema extends z.ZodTypeAny>(
  schema: Schema,
  source: EnvironmentSource,
  appName: string,
): z.output<Schema> {
  const result = schema.safeParse(normaliseEnvironment(source));
  if (result.success) return result.data as z.output<Schema>;
  throw new EnvironmentError(appName, issuesFromZod(result.error));
}

function issuesFromZod(error: z.ZodError): EnvironmentIssue[] {
  const messages = new Map<string, string[]>();
  for (const issue of error.issues) {
    const variable = issue.path.length > 0 ? issue.path.join('.') : '(environment)';
    messages.set(variable, [...(messages.get(variable) ?? []), issue.message]);
  }
  return [...messages].map(([variable, list]) => ({
    variable,
    message: list.join('; '),
    remedy: environmentRemedy(variable),
  }));
}

/**
 * The `--env-file` / `--env-file-if-exists` value Node was started with, if
 * any. Node does not expose which file it loaded, but the flag is still in
 * `process.execArgv`, and naming the file is what makes "fix .env" actionable
 * when several checkouts sit side by side.
 */
export function environmentFileArgument(execArgv: readonly string[]): string | undefined {
  for (let index = 0; index < execArgv.length; index += 1) {
    const match = /^--env-file(?:-if-exists)?(?:=(.*))?$/.exec(execArgv[index] ?? '');
    if (!match) continue;
    const value = match[1] ?? execArgv[index + 1];
    if (value) return value;
  }
  return undefined;
}

export function formatEnvironmentError(
  error: EnvironmentError,
  environmentFile: string | undefined,
): string {
  const source = environmentFile
    ? `environment read from ${environmentFile}`
    : 'environment read from the process, no --env-file flag';
  return [
    `[${error.appName}] Invalid configuration (${source}). Fix each variable below in .env, then restart:`,
    error.message,
  ].join('\n');
}
