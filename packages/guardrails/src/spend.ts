/**
 * Spend guardrails.
 *
 * Two separate rules live here and they are not the same thing:
 *
 *   1. The purchasing ban (policy B1) is absolute. No agent may ever buy
 *      anything - API credits, cloud resources, subscriptions, domains, assets,
 *      compute. There is no approval path, no trust level and no configuration
 *      that turns it on. An agent that believes something should be bought
 *      writes a proposal for a human.
 *
 *   2. The usage ceiling (policy B2) is a brake, not a ban. Cloud model usage
 *      is metered and a runaway loop is the most likely way this system costs
 *      money by accident. On reaching the ceiling the system falls back to
 *      local models rather than stopping outright (policy B3).
 *
 * Everything here is a pure function over plain data. The rules are enforced by
 * mechanism rather than by instructions in a prompt, because a rule that exists
 * only as text a model is asked to follow is not a rule.
 */

/** Actions that constitute a financial commitment. Never permitted. */
import { freshTokens } from './limits.js';

export const FORBIDDEN_SPEND_ACTIONS = [
  'purchase',
  'buy_credits',
  'upgrade_subscription',
  'provision_paid_resource',
  'register_domain',
  'buy_asset',
  'marketplace_purchase',
  'transfer_funds',
] as const;

export type ForbiddenSpendAction = (typeof FORBIDDEN_SPEND_ACTIONS)[number];

/**
 * Hosts an agent may never reach, regardless of task. An allowlist governs what
 * agents *can* talk to; this is a second, independent check so that a mistake in
 * the allowlist cannot by itself open a payment path.
 */
export const BLOCKED_HOSTS = [
  'api.stripe.com',
  'checkout.stripe.com',
  'api.paypal.com',
  'billing.stripe.com',
  'payments.google.com',
  'buy.stripe.com',
] as const;

/**
 * Domains blocked including every subdomain. Six literal hostnames were never enough:
 * `pay.stripe.com` is not in the list above and is as much a payment endpoint as
 * `buy.stripe.com`. Matching on the registrable domain means a new subdomain cannot
 * quietly become reachable.
 */
export const BLOCKED_DOMAIN_SUFFIXES = ['stripe.com', 'paypal.com', 'checkout.paypal.com'] as const;

export type SpendAttempt = {
  /** What the agent is trying to do. */
  action: string;
  /** Host it would contact, if any. */
  host?: string;
  /** Capabilities granted to the agent making the attempt. */
  capabilities: readonly string[];
};

export type SpendVerdict =
  { allowed: true } | { allowed: false; reason: string; proposalRequired: boolean };

/**
 * Decide whether an action constitutes spending, and refuse it if so.
 *
 * Deliberately checks several independent signals. Any one of them is enough to
 * refuse, so no single mistake - a mislabelled action, a stray capability, an
 * allowlist error - opens a purchasing path on its own.
 */
export function checkSpend(attempt: SpendAttempt): SpendVerdict {
  if (matchesForbiddenAction(attempt.action)) {
    return {
      allowed: false,
      reason: `"${attempt.action}" is a financial commitment. No agent may make one, under any configuration or trust level.`,
      proposalRequired: true,
    };
  }

  if (attempt.host && isBlockedHost(attempt.host)) {
    return {
      allowed: false,
      reason: `${attempt.host} is a payment endpoint and is unreachable from agent tools.`,
      proposalRequired: true,
    };
  }

  // No agent card is granted this capability. Its presence means something has
  // gone wrong upstream, so refuse rather than honour it.
  if (attempt.capabilities.some(isSpendCapability)) {
    return {
      allowed: false,
      reason:
        'the "spend" capability is granted to no agent; its presence indicates a configuration fault, not permission',
      proposalRequired: false,
    };
  }

  return { allowed: true };
}

/**
 * Normalises an action name so that spelling cannot defeat the ban. Lowercases, and folds
 * every plausible separator - spaces, hyphens, dots, colons, slashes - to a single
 * underscore, so `Buy Credits`, `buy-credits` and `buy.credits` all become `buy_credits`.
 */
export function normaliseAction(action: string): string {
  return action
    .trim()
    .toLowerCase()
    .replace(/[\s\-.:/\\]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Whether an action is a forbidden financial commitment.
 *
 * Matches a forbidden term as a run of whole tokens **anywhere** in the action, so
 * `purchase_gpu`, `please_transfer_funds` and `marketplace_purchase_v2` are all refused -
 * the original exact-equality check caught none of them.
 *
 * **This deliberately over-matches.** An action innocently named `purchase_order_report`
 * would be refused. That is the correct direction to fail for a ban on spending money: a
 * false refusal costs one proposal and a renamed action, while a false allowance costs
 * real money and cannot be undone. Token boundaries keep it from being absurd - `buyer`
 * and `disbursement` do not match `buy` or anything else here.
 */
export function matchesForbiddenAction(action: string): boolean {
  const tokens = normaliseAction(action).split('_').filter(Boolean);
  if (tokens.length === 0) return false;
  return (FORBIDDEN_SPEND_ACTIONS as readonly string[]).some((forbidden) => {
    const needle = forbidden.split('_').filter(Boolean);
    for (let i = 0; i + needle.length <= tokens.length; i += 1) {
      if (needle.every((part, offset) => tokens[i + offset] === part)) return true;
    }
    return false;
  });
}

/**
 * Reduces whatever was handed over - a bare host, a host:port, a full URL - to a hostname.
 * Returns an empty string when there is nothing host-like in it.
 */
export function normaliseHost(host: string): string {
  const raw = host.trim().toLowerCase();
  if (!raw) return '';
  let candidate = raw;
  if (raw.includes('://')) {
    try {
      candidate = new URL(raw).hostname;
    } catch {
      // Not a URL after all; fall through and treat it as a host with noise on the end.
      candidate = raw.slice(raw.indexOf('://') + 3);
    }
  }
  // Strip credentials, then path/query/fragment, then the port, then a trailing root dot.
  candidate = candidate.split('@').pop() ?? candidate;
  candidate = candidate.split(/[/?#]/)[0] ?? candidate;
  candidate = candidate.replace(/\[|\]/g, '');
  candidate = candidate.replace(/:\d+$/, '');
  candidate = candidate.replace(/\.$/, '');
  return candidate;
}

/**
 * Whether a host is a payment endpoint. Exact against `BLOCKED_HOSTS` and by domain
 * against `BLOCKED_DOMAIN_SUFFIXES`, after normalisation, so `api.stripe.com:443`,
 * `https://api.stripe.com/v1`, `www.api.stripe.com` and `api.stripe.com.` are all refused.
 * The original check compared the raw string to six literals and caught none of those.
 */
export function isBlockedHost(host: string): boolean {
  const name = normaliseHost(host);
  if (!name) return false;
  if ((BLOCKED_HOSTS as readonly string[]).includes(name)) return true;
  return (BLOCKED_DOMAIN_SUFFIXES as readonly string[]).some(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  );
}

/** The `spend` capability, in any case, and any `spend:*` namespace under it. */
export function isSpendCapability(capability: string): boolean {
  const name = capability.trim().toLowerCase();
  return name === 'spend' || name.startsWith('spend:');
}

export type UsageRecord = {
  /** ISO timestamp. */
  at: string;
  usd: number;
  tokens: number;
  runId?: string;
  role?: string;
  /** Adapter that produced the record; lets an unmetered provider be told apart. */
  provider?: string;
};

/**
 * The shape the coordinator and the database use for a usage record. Only the
 * fields the ceiling needs are named, so any object carrying them qualifies and
 * `@theforge/contracts` does not become a dependency of this package.
 */
export type UsageLike = {
  createdAt: string;
  costUsd: number;
  inputTokens: number;
  /** The cached subset of `inputTokens`; absent on a record from before migration 008. */
  cachedInputTokens?: number | undefined;
  outputTokens: number;
  runId?: string | undefined;
  provider?: string | undefined;
};

/** Adapt coordinator/database usage records to the shape the ceiling reads. */
export function toGuardUsage(records: Iterable<UsageLike>): UsageRecord[] {
  return Array.from(records, (record) => ({
    at: record.createdAt,
    usd: record.costUsd,
    tokens: freshTokens(record),
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
  }));
}

export type CeilingConfig = {
  /** Hard stop for cloud model spend, per day, in USD. Policy B2. */
  dailyUsd: number;
  /** Warn at this fraction of the ceiling. */
  warnAtFraction: number;
};

/**
 * Interim ceiling of $20/day, set while no local model tier existed to fall
 * back to. Roughly eight full-pipeline tasks at observed rates: enough to work,
 * small enough that a runaway is caught the same day rather than at invoice.
 */
export const DEFAULT_CEILING: CeilingConfig = { dailyUsd: 20, warnAtFraction: 0.75 };

/**
 * Build a ceiling from raw environment values. Accepts strings so the CLI and
 * anything else reading `process.env` directly can use it; the coordinator
 * passes numbers its schema already validated. An empty or missing value takes
 * the default, anything unparsable or out of range throws rather than silently
 * becoming zero (which `Number('')` would do, and zero means "no cloud at all").
 */
export function ceilingConfigFromValues(values: {
  dailyUsd?: string | number | undefined;
  warnAtFraction?: string | number | undefined;
}): CeilingConfig {
  const dailyUsd = numberOrDefault(values.dailyUsd, DEFAULT_CEILING.dailyUsd, 'dailyUsd');
  const warnAtFraction = numberOrDefault(
    values.warnAtFraction,
    DEFAULT_CEILING.warnAtFraction,
    'warnAtFraction',
  );
  if (dailyUsd < 0) throw new RangeError(`dailyUsd must be zero or more, got ${dailyUsd}`);
  if (warnAtFraction < 0 || warnAtFraction > 1)
    throw new RangeError(`warnAtFraction must be between 0 and 1, got ${warnAtFraction}`);
  return { dailyUsd, warnAtFraction };
}

function numberOrDefault(value: string | number | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be a number, got "${value}"`);
  return parsed;
}

/**
 * The calendar the ceiling counts in. A "day" is a local day for the operator,
 * not a UTC day: Sydney is UTC+10/+11, so a UTC day boundary falls at 10:00 or
 * 11:00 local time and would split a working morning across two budgets.
 */
export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Intl.DateTimeFormat construction is comparatively slow and every usage record
// goes through it, so one formatter per zone is kept for the process lifetime.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`. Built from parts
 * rather than `format()` so the result does not depend on locale punctuation.
 * Throws RangeError for an unknown zone, which is the right failure for a
 * misconfigured FORGE_TIMEZONE: it must never silently fall back to UTC.
 */
export function localDay(at: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = dayFormatter(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type CeilingState = 'ok' | 'warn' | 'exceeded';

export type CeilingVerdict = {
  state: CeilingState;
  spentTodayUsd: number;
  remainingUsd: number;
  /** What the router should do next. */
  routing: 'cloud-allowed' | 'local-only';
  message: string;
  /** The local day the total was summed over, and the zone that defined it. */
  day: string;
  timeZone: string;
};

export function spentOn(
  records: readonly UsageRecord[],
  day: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const target = localDay(day, timeZone);
  return records
    .filter((record) => {
      const at = new Date(record.at);
      return !Number.isNaN(at.getTime()) && localDay(at, timeZone) === target;
    })
    .reduce((total, record) => total + (Number.isFinite(record.usd) ? record.usd : 0), 0);
}

/**
 * The ceiling decision given an already-summed day total. The coordinator keeps
 * that total incrementally (one addition per usage record) so every dispatch
 * check is O(1) rather than a pass over every record ever stored.
 */
export function evaluateCeiling(
  spentTodayUsd: number,
  config: CeilingConfig = DEFAULT_CEILING,
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): CeilingVerdict {
  const spent = Number.isFinite(spentTodayUsd) ? Math.max(0, spentTodayUsd) : 0;
  const remaining = Math.max(0, config.dailyUsd - spent);

  if (spent >= config.dailyUsd) {
    return {
      state: 'exceeded',
      spentTodayUsd: spent,
      remainingUsd: 0,
      routing: 'local-only',
      message: `daily cloud ceiling of $${config.dailyUsd.toFixed(2)} reached ($${spent.toFixed(2)} spent on ${day} ${timeZone}); routing to local models only`,
      day,
      timeZone,
    };
  }

  if (spent >= config.dailyUsd * config.warnAtFraction) {
    return {
      state: 'warn',
      spentTodayUsd: spent,
      remainingUsd: remaining,
      routing: 'cloud-allowed',
      message: `$${spent.toFixed(2)} of $${config.dailyUsd.toFixed(2)} spent today; $${remaining.toFixed(2)} remaining`,
      day,
      timeZone,
    };
  }

  return {
    state: 'ok',
    spentTodayUsd: spent,
    remainingUsd: remaining,
    routing: 'cloud-allowed',
    message: `$${spent.toFixed(2)} of $${config.dailyUsd.toFixed(2)} spent today`,
    day,
    timeZone,
  };
}

/**
 * Evaluate the daily ceiling.
 *
 * Reaching it switches routing to local models rather than halting (policy B3),
 * so work continues at zero marginal cost instead of stopping dead. In-flight
 * work is never killed; only new cloud calls are refused.
 */
export function checkCeiling(
  records: readonly UsageRecord[],
  now: Date = new Date(),
  config: CeilingConfig = DEFAULT_CEILING,
  timeZone: string = DEFAULT_TIME_ZONE,
): CeilingVerdict {
  return evaluateCeiling(
    spentOn(records, now, timeZone),
    config,
    localDay(now, timeZone),
    timeZone,
  );
}

/**
 * Per-role cost estimates in USD for a single cloud call, from the real run in
 * F031 (tasks/TASKS.md: planner $0.47 + $0.22, critic $0.22, builder $1.25,
 * reviewer $0.39), rounded up. One table, read in the two places that must
 * agree on a call: `routeRole` projects a stage's cost before placing it
 * (ADR-028), and the coordinator's dispatch guard checks the same figure
 * before a cloud call is enqueued. An estimate that turns out low is corrected
 * by the next check because the recorded usage, not the estimate, is what
 * goes into the day total. A role the table does not name takes the most
 * expensive known figure.
 */
/**
 * What a stage is expected to cost on the cloud, per role. The dispatch guard
 * checks a projected total against the daily ceiling with these, so an
 * over-estimate routes work to the local model sooner and spends less.
 *
 * **These are known to be wrong, and are deliberately left alone until there is
 * enough data to correct them properly.** Migration 008 made them falsifiable
 * for the first time by recording the role on every usage record (ADR-034), and
 * the first measurement - 04/10/2026, `provider='claude'` only - put three of
 * the four out:
 *
 * | role     | here   | measured | worst  | calls |
 * | -------- | ------ | -------- | ------ | ----- |
 * | planner  | $0.70  | $0.328   | $0.480 | 8     |
 * | critic   | $0.25  | $0.207   | $0.220 | 3     |
 * | builder  | $1.25  | $0.821   | $1.270 | 6     |
 * | reviewer | $0.40  | $0.419   | $0.481 | 7     |
 *
 * `reviewer` is accurate and `critic` close. `planner` is roughly double what a
 * planner costs. `builder`'s mean is well under its figure but its worst
 * observed call is $1.270 against $1.25, so that number behaves as a ceiling
 * rather than an average - which, for a guard asking whether a stage would
 * breach the daily limit, is the useful reading.
 *
 * Every error is in the conservative direction, so correcting them downward
 * would send MORE work to the cloud. That is a spend decision under policy
 * B2/B5, not a tidy-up, and three to eight calls per role is far too thin to
 * recalibrate against.
 *
 * **Dan's decision, 04/10/2026: revisit at 50 metered calls and correct them
 * then.** `ROLE_ESTIMATE_REVIEW_CALLS` is that threshold, and the digest says
 * when it is reached so this does not rest on anyone remembering.
 */
export const ROLE_ESTIMATES_USD: Readonly<Record<string, number>> = {
  planner: 0.7,
  critic: 0.25,
  builder: 1.25,
  reviewer: 0.4,
};

/**
 * How many metered calls must be on record before `ROLE_ESTIMATES_USD` is
 * recalibrated. Dan's figure, 04/10/2026.
 *
 * Counted across all roles rather than per role: 50 per role would mean 200
 * metered calls and, at the measured mean, roughly $90 of spend, which is a
 * long way from the $11.11 recorded so far. 50 in total gives a dozen or so per
 * role, which is where a mean starts to mean something for this purpose.
 *
 * Only metered calls count. A $0 local or subscription call says nothing about
 * what a stage costs on the cloud, which is the only thing this table claims.
 */
export const ROLE_ESTIMATE_REVIEW_CALLS = 50;
export const DEFAULT_ROLE_ESTIMATE_USD = 1.25;

/** The estimated cloud cost of one call for `role`; the default for a role the table omits. */
export function roleEstimateUsd(role: string): number {
  return ROLE_ESTIMATES_USD[role] ?? DEFAULT_ROLE_ESTIMATE_USD;
}

export type CloudCallVerdict = {
  allowed: boolean;
  reason: string;
  /** The ceiling state the decision was made against. */
  ceiling: CeilingVerdict;
};

/** The cloud-call decision given an already-summed day total; see evaluateCeiling. */
export function evaluateCloudCall(
  spentTodayUsd: number,
  estimatedUsd: number,
  config: CeilingConfig = DEFAULT_CEILING,
  day: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): CloudCallVerdict {
  const ceiling = evaluateCeiling(spentTodayUsd, config, day, timeZone);
  if (ceiling.routing === 'local-only') {
    return { allowed: false, reason: ceiling.message, ceiling };
  }
  const projected = ceiling.spentTodayUsd + Math.max(0, estimatedUsd);
  if (projected > config.dailyUsd) {
    return {
      allowed: false,
      reason: `estimated $${estimatedUsd.toFixed(2)} would take today's total to $${projected.toFixed(2)}, past the $${config.dailyUsd.toFixed(2)} ceiling`,
      ceiling,
    };
  }
  return { allowed: true, reason: ceiling.message, ceiling };
}

/**
 * Whether a specific cloud call may start.
 *
 * Checked against the ceiling *before* the call, using its estimated cost, so a
 * single expensive task cannot carry the total far past the limit. An estimate
 * that turns out low is corrected by the next call's check.
 */
export function canStartCloudCall(
  records: readonly UsageRecord[],
  estimatedUsd: number,
  now: Date = new Date(),
  config: CeilingConfig = DEFAULT_CEILING,
  timeZone: string = DEFAULT_TIME_ZONE,
): CloudCallVerdict {
  return evaluateCloudCall(
    spentOn(records, now, timeZone),
    estimatedUsd,
    config,
    localDay(now, timeZone),
    timeZone,
  );
}
