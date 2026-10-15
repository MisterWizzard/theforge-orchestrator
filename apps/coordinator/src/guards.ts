import { freemem as osFreemem } from 'node:os';
import type { UsageRecord } from '@theforge/contracts';
import {
  adaptiveDailyUsd,
  budgetPeriod,
  canLeaseWork,
  DEFAULT_ROLE_ESTIMATE_USD,
  evaluateCeiling,
  evaluateCloudCall,
  localDay,
  ROLE_ESTIMATES_USD,
  roleEstimateUsd,
  type AdaptiveCeiling,
  type BudgetConfig,
  type CeilingConfig,
  type CeilingVerdict,
} from '@theforge/guardrails';

/**
 * Guardrails wired into the dispatch path.
 *
 * `@theforge/guardrails` holds pure decision functions; this class is the
 * stateful adapter that keeps the numbers those functions need close at hand
 * (a running day total, a per-day "already warned" latch) so that every check
 * in the lease and dispatch paths is O(1) and needs no database round trip.
 * Everything time- or machine-dependent is injectable, so the decisions can be
 * tested with a scripted clock and a scripted free-memory reading.
 *
 * What is guarded, and by which policy:
 *   - beforeLease      B8: at most FORGE_MAX_AGENTS provider jobs in flight,
 *                          and never below FORGE_MIN_FREE_MEMORY_MB free.
 *   - beforeCloudCall  B2/B3: the daily ceiling, checked *before* a cloud call
 *                          with a per-role estimate, so a single expensive
 *                          builder call cannot carry the day past the limit.
 *                          The last line: routing projects the same estimate
 *                          first (ADR-028) and sends a stage that would cross
 *                          to the local model or stops the run, so this fires
 *                          only for a call routing did not see or a day that
 *                          moved between the decision and the dispatch.
 *   - beforeRunStart   B2/B3: a run may not start (or resume) while the day is
 *                          already over the ceiling.
 */

/**
 * The per-role estimates (planner $0.70, critic $0.25, builder $1.25, reviewer
 * $0.40, from the F031 run) live in `@theforge/guardrails` since ADR-028 so
 * that `routeRole` projects a stage with the very figure this guard checks it
 * against. Re-exported for the coordinator's tests and anything else that
 * read them from here.
 */
export { DEFAULT_ROLE_ESTIMATE_USD, ROLE_ESTIMATES_USD };

/**
 * Providers whose adapter reports no marginal cost. Codex runs on a
 * subscription and `packages/provider-codex/src/index.ts` records `usd: 0`
 * for every call (carried as F111), so the ceiling cannot see it. Such calls
 * are still refused once the day is over the ceiling - policy B3 routes to
 * *local* models then, and Codex is not local - but they never move the total.
 */
export const UNMETERED_PROVIDERS: ReadonlySet<string> = new Set(['codex']);

/**
 * Providers that run on the worker host against a local model server (ADR-021).
 * A local call is what the ceiling routes *to* when the day is over it, so it
 * is never refused on the ceiling, never estimated, never warned about, and
 * never moves the total: its usage records carry `costUsd: 0`.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

export type GuardsOptions = {
  /**
   * The flat daily ceiling. With `budget` set it is the floor of the adaptive
   * cap rather than the cap itself (ADR-037).
   */
  ceiling: CeilingConfig;
  /** A monthly allowance that makes the daily cap adaptive; absent means the flat ceiling stands. */
  budget?: BudgetConfig | undefined;
  maxAgents: number;
  minFreeMemoryMb: number;
  /** IANA zone whose calendar days the ceiling counts in. */
  timeZone: string;
  now?: () => Date;
  /** Free system memory in bytes; defaults to os.freemem(). */
  freemem?: () => number;
  /** Every usage record the coordinator knows about; read once, lazily, to seed the day total. */
  usageSource: () => Iterable<UsageRecord>;
  /** Leased provider jobs right now: each is one running agent. */
  activeProviderJobs: () => number;
  emit: (runId: string, type: string, payload: Record<string, unknown>) => void;
  /** Operator-facing warning line; the coordinator routes it to its logger. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
};

export type LeaseDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      /** Short ASCII form for the `x-forge-lease-refused` response header. */
      header: string;
    };

export type SpendRefusal = {
  reason: string;
  dayUsd: number;
  ceilingUsd: number;
  day: string;
  timeZone: string;
  routing: 'local-only';
};

export type CloudCallDecision =
  | {
      allowed: true;
      estimatedUsd: number;
      /** False for a subscription provider whose cost the ceiling cannot see. */
      metered: boolean;
    }
  | { allowed: false; verdict: SpendRefusal };

export type RunStartDecision = { allowed: true } | { allowed: false; verdict: SpendRefusal };

type DayBucket = { usd: number; ids: Set<string> };

export class Guards {
  private readonly now: () => Date;
  private readonly freemem: () => number;
  private seeded = false;
  private seeding = false;
  /** Day (YYYY-MM-DD in `timeZone`) -> what has been spent on it and by which records. */
  private readonly days = new Map<string, DayBucket>();
  private warnedDay: string | undefined;
  private ceilingDay: string | undefined;
  private unmeteredDay: string | undefined;

  constructor(private readonly options: GuardsOptions) {
    this.now = options.now ?? (() => new Date());
    this.freemem = options.freemem ?? osFreemem;
  }

  /** The ceiling in force today: the flat one, or the adaptive cap when a budget is set. */
  get ceiling(): CeilingConfig {
    return this.ceilingFor(this.day(this.now()));
  }

  /** How today's cap was reached, or undefined when no monthly budget is configured. */
  budgetStatus(): AdaptiveCeiling | undefined {
    const budget = this.options.budget;
    if (!budget) return undefined;
    const day = this.day(this.now());
    return adaptiveDailyUsd(
      this.options.ceiling.dailyUsd,
      budget,
      day,
      this.periodSpentBefore(day),
    );
  }

  get timeZone(): string {
    return this.options.timeZone;
  }

  /**
   * Policy B8. The agent count is the number of leased provider jobs, because
   * each worker runs one job at a time and only provider jobs start an agent.
   * Free memory is read on the coordinator host: the coordinator and the
   * worker share this machine (packages/guardrails/src/limits.ts describes the
   * budget), so its reading is the reading that matters. A remote worker would
   * need to report its own figure; none exists yet.
   */
  beforeLease(): LeaseDecision {
    const activeAgents = this.options.activeProviderJobs();
    const freeMemoryMb = Math.floor(this.freemem() / 1_048_576);
    const verdict = canLeaseWork(
      { activeAgents, freeMemoryMb },
      this.options.maxAgents,
      this.options.minFreeMemoryMb,
    );
    if (verdict.allowed) return { allowed: true };
    const header =
      activeAgents >= this.options.maxAgents
        ? `max-agents (${activeAgents}/${this.options.maxAgents})`
        : `min-free-memory (${freeMemoryMb} MB < ${this.options.minFreeMemoryMb} MB)`;
    return { allowed: false, reason: verdict.reason, header };
  }

  /**
   * Policies B2 and B3, checked before a cloud call is enqueued. Emits
   * `spend.warn` the first time a day is seen past the warning fraction and
   * `spend.ceiling` the first time a day refuses a call, so downstream
   * notification (policy B11) fires once, not once per attempt.
   */
  beforeCloudCall(runId: string, role: string, providerId: string): CloudCallDecision {
    // A local model is not a cloud call: nothing to estimate, nothing the
    // ceiling could refuse. The check is before the unmetered branch so the
    // once-a-day "$0 subscription" warning is not raised for it either.
    if (LOCAL_PROVIDERS.has(providerId)) return { allowed: true, estimatedUsd: 0, metered: false };
    const now = this.now();
    const day = this.day(now);
    const metered = !UNMETERED_PROVIDERS.has(providerId);
    const estimatedUsd = metered ? roleEstimateUsd(role) : 0;
    if (!metered && this.unmeteredDay !== day) {
      this.unmeteredDay = day;
      this.options.warn?.(
        `${providerId} usage is reported as $0 (subscription); the daily ceiling cannot see it`,
        { runId, role, providerId, day },
      );
    }
    const decision = evaluateCloudCall(
      this.spentOn(day),
      estimatedUsd,
      this.ceilingFor(day),
      day,
      this.options.timeZone,
    );
    this.maybeWarn(runId, decision.ceiling);
    if (decision.allowed) return { allowed: true, estimatedUsd, metered };
    const verdict = this.refusal(decision.reason, decision.ceiling);
    this.maybeAnnounceCeiling(runId, verdict);
    return { allowed: false, verdict };
  }

  /** A run may not begin, or resume, on a day that is already over the ceiling. */
  beforeRunStart(runId: string): RunStartDecision {
    const status = this.ceilingStatus();
    this.maybeWarn(runId, status);
    if (status.state !== 'exceeded') return { allowed: true };
    const verdict = this.refusal(status.message, status);
    this.maybeAnnounceCeiling(runId, verdict);
    return { allowed: false, verdict };
  }

  /**
   * Fold one usage record into the day total. Idempotent by record id, so the
   * boot replay and the live path may both deliver the same record. Records for
   * days already behind us are dropped rather than tracked: they can never
   * change a decision again, and forgetting them is what keeps memory bounded.
   * With a monthly budget the days of the current period are kept too, because
   * the adaptive cap is computed from what the period has spent so far.
   */
  onUsageRecorded(record: UsageRecord): void {
    const at = new Date(record.createdAt);
    if (Number.isNaN(at.getTime()) || !Number.isFinite(record.costUsd)) return;
    const countFrom = this.options.budget?.countFrom;
    if (countFrom && at < new Date(countFrom)) return;
    const today = this.day(this.now());
    const day = this.day(at);
    if (day < this.retainFrom(today)) return;
    const bucket = this.bucket(day);
    if (bucket.ids.has(record.id)) return;
    bucket.ids.add(record.id);
    bucket.usd += Math.max(0, record.costUsd);
    // While seeding with a budget, the period total is still being assembled in no particular
    // order, so the cap is not yet meaningful; the callers re-evaluate once the seed is in.
    if (day === today && !(this.seeding && this.options.budget)) {
      const verdict = evaluateCeiling(bucket.usd, this.ceilingFor(day), day, this.options.timeZone);
      this.maybeWarn(record.runId, verdict);
      // Routing (ADR-022) may keep every later stage off the cloud, so no call
      // is ever refused here; the crossing itself is what Dan must hear about.
      if (verdict.routing === 'local-only')
        this.maybeAnnounceCeiling(record.runId, this.refusal(verdict.message, verdict));
    }
  }

  /** The ceiling as it stands right now, for logs and diagnostics. */
  ceilingStatus(): CeilingVerdict {
    const day = this.day(this.now());
    return evaluateCeiling(this.spentOn(day), this.ceilingFor(day), day, this.options.timeZone);
  }

  /**
   * The ceiling for `day`. Without a budget that is the configured flat figure;
   * with one it is the adaptive cap, which depends only on spend in the period
   * *before* `day`, so spending today never moves today's cap (ADR-037).
   */
  private ceilingFor(day: string): CeilingConfig {
    const budget = this.options.budget;
    if (!budget) return this.options.ceiling;
    const adaptive = adaptiveDailyUsd(
      this.options.ceiling.dailyUsd,
      budget,
      day,
      this.periodSpentBefore(day),
    );
    return { dailyUsd: adaptive.dailyUsd, warnAtFraction: this.options.ceiling.warnAtFraction };
  }

  private periodSpentBefore(day: string): number {
    const budget = this.options.budget;
    if (!budget) return 0;
    this.ensureSeeded();
    const { start } = budgetPeriod(day, budget.resetDay);
    let total = 0;
    for (const [key, bucket] of this.days) if (key >= start && key < day) total += bucket.usd;
    return total;
  }

  /** The earliest day a bucket is worth keeping: today, or the start of the budget period. */
  private retainFrom(today: string): string {
    const budget = this.options.budget;
    return budget ? budgetPeriod(today, budget.resetDay).start : today;
  }

  private day(at: Date): string {
    return localDay(at, this.options.timeZone);
  }

  private spentOn(day: string): number {
    this.ensureSeeded();
    this.forget(this.retainFrom(day));
    return this.days.get(day)?.usd ?? 0;
  }

  private bucket(day: string): DayBucket {
    let bucket = this.days.get(day);
    if (!bucket) {
      bucket = { usd: 0, ids: new Set() };
      this.days.set(day, bucket);
    }
    return bucket;
  }

  private ensureSeeded(): void {
    if (this.seeded) return;
    this.seeded = true;
    this.seeding = true;
    try {
      for (const record of this.options.usageSource()) this.onUsageRecorded(record);
    } finally {
      this.seeding = false;
    }
  }

  /** Drop buckets for days before `keepFrom`; the day keys sort lexically. */
  private forget(keepFrom: string): void {
    for (const day of this.days.keys()) if (day < keepFrom) this.days.delete(day);
  }

  private refusal(reason: string, ceiling: CeilingVerdict): SpendRefusal {
    return {
      reason,
      dayUsd: ceiling.spentTodayUsd,
      ceilingUsd: this.ceilingFor(ceiling.day).dailyUsd,
      day: ceiling.day,
      timeZone: ceiling.timeZone,
      routing: 'local-only',
    };
  }

  private maybeWarn(runId: string, ceiling: CeilingVerdict): void {
    if (ceiling.state === 'ok' || this.warnedDay === ceiling.day) return;
    this.warnedDay = ceiling.day;
    this.options.emit(runId, 'spend.warn', {
      dayUsd: ceiling.spentTodayUsd,
      ceilingUsd: this.ceilingFor(ceiling.day).dailyUsd,
      fraction: this.options.ceiling.warnAtFraction,
      day: ceiling.day,
      timeZone: ceiling.timeZone,
      message: ceiling.message,
    });
  }

  private maybeAnnounceCeiling(runId: string, verdict: SpendRefusal): void {
    if (this.ceilingDay === verdict.day) return;
    this.ceilingDay = verdict.day;
    this.options.emit(runId, 'spend.ceiling', {
      dayUsd: verdict.dayUsd,
      ceilingUsd: verdict.ceilingUsd,
      day: verdict.day,
      timeZone: verdict.timeZone,
      routing: verdict.routing,
      message: verdict.reason,
    });
  }
}
