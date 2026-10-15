/**
 * The monthly budget and the adaptive daily ceiling (ADR-037).
 *
 * A prepaid credit allowance (for example monthly API credits) is worth something only while it lasts: what is unspent when the
 * period rolls over is gone. A flat daily ceiling cannot use that allowance
 * well - set low it wastes the tail of the month, set high it can spend the lot
 * in a week. This module turns the allowance into a daily cap that moves:
 *
 *   cap(day) = min( max(base, remaining / daysLeft), maxDaily, remaining )
 *
 * where `remaining` is the allowance minus everything spent in the period
 * *before* `day`, and `daysLeft` counts `day` itself. So an unspent day raises
 * every later day's cap a little, a heavy day lowers them, and the final days
 * of a period converge on spending whatever is left, bounded by `maxDaily`.
 *
 * Three properties are deliberate:
 *
 *   - **Stable within a day.** `remaining` excludes the day being capped, so
 *     spending today never moves today's cap. A cap that fell as it was spent
 *     against would shrink toward zero and the day could never use it.
 *   - **Never above the allowance.** `remaining` is a hard bound on the cap, so
 *     the period total cannot pass the allowance by more than one call's
 *     estimate error - the same slack the flat ceiling has always had.
 *   - **A runaway is still caught the same day.** `maxDaily` is the old
 *     ceiling's job (policy B2): a loop at 3am cannot take the whole month's
 *     remainder in one night just because the cap has been rising.
 *
 * Pure functions over calendar-day strings (`YYYY-MM-DD`, already in the
 * operator's zone via `localDay`), so nothing here touches a clock or a zone.
 */

export type BudgetConfig = {
  /** The credit allowance for one period, in USD. */
  monthlyUsd: number;
  /** Day of the month (1-28) on which a new period, and a fresh allowance, begins. */
  resetDay: number;
  /** The most any single day may be capped at, however much is left. */
  maxDailyUsd: number;
  /**
   * Usage records created before this ISO timestamp are not counted against the
   * allowance. Spend that was never billed to the allowance is not counted,
   * and counting it would understate what is left.
   */
  countFrom?: string;
};

export const DEFAULT_BUDGET_RESET_DAY = 1;
/** The most any single day may be capped at, by default. */
export const DEFAULT_MAX_DAILY_USD = 50;

export type BudgetPeriod = {
  /** First day of the period, `YYYY-MM-DD`. */
  start: string;
  /** First day of the next period; the allowance is gone from this day. */
  next: string;
  /** Days left including the day asked about. */
  daysLeft: number;
  /** Days in the whole period. */
  length: number;
};

const DAY_MS = 86_400_000;

function parseDay(day: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError(`day must be YYYY-MM-DD, got "${day}"`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The budget period containing `day`. A period runs from `resetDay` of one
 * month to `resetDay` of the next, so `resetDay` 1 is the calendar month and
 * `resetDay` 15 runs 15th to 14th. `resetDay` stops at 28 so every month has it.
 */
export function budgetPeriod(
  day: string,
  resetDay: number = DEFAULT_BUDGET_RESET_DAY,
): BudgetPeriod {
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28)
    throw new RangeError(`resetDay must be a whole number from 1 to 28, got ${resetDay}`);
  const at = parseDay(day);
  const monthOffset = at.getUTCDate() >= resetDay ? 0 : -1;
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + monthOffset, resetDay));
  const next = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + monthOffset + 1, resetDay),
  );
  return {
    start: formatDay(start),
    next: formatDay(next),
    daysLeft: Math.round((next.getTime() - at.getTime()) / DAY_MS),
    length: Math.round((next.getTime() - start.getTime()) / DAY_MS),
  };
}

export type AdaptiveCeiling = {
  /** The cap for the day, in USD, rounded down to the cent. */
  dailyUsd: number;
  /** The configured flat figure the cap never falls below while allowance remains. */
  baseUsd: number;
  /** An even share of what is left: `remaining / daysLeft`. */
  paceUsd: number;
  /** Allowance left at the start of the day. */
  remainingUsd: number;
  /** Spent in the period before the day. */
  spentInPeriodUsd: number;
  period: BudgetPeriod;
  /** Which term set the cap, for a log line and the digest. */
  limitedBy: 'base' | 'pace' | 'max' | 'remaining';
};

/**
 * The daily cap for `day`: `baseUsd` raised toward an even share of what is
 * left, bounded by `maxDailyUsd` and by what is left.
 *
 * `spentBeforeDayUsd` is the period's spend up to but excluding `day`. The
 * result is floored to the cent so a cap never rounds up past the allowance.
 */
export function adaptiveDailyUsd(
  baseUsd: number,
  budget: BudgetConfig,
  day: string,
  spentBeforeDayUsd: number,
): AdaptiveCeiling {
  const period = budgetPeriod(day, budget.resetDay);
  const spent = Number.isFinite(spentBeforeDayUsd) ? Math.max(0, spentBeforeDayUsd) : 0;
  const remaining = Math.max(0, budget.monthlyUsd - spent);
  const pace = remaining / period.daysLeft;
  const wanted = Math.max(baseUsd, pace);
  const capped = Math.min(wanted, budget.maxDailyUsd, remaining);
  const dailyUsd = Math.floor(capped * 100 + 1e-9) / 100;

  let limitedBy: AdaptiveCeiling['limitedBy'];
  if (remaining <= Math.min(wanted, budget.maxDailyUsd)) limitedBy = 'remaining';
  else if (budget.maxDailyUsd < wanted) limitedBy = 'max';
  else limitedBy = pace > baseUsd ? 'pace' : 'base';

  return {
    dailyUsd,
    baseUsd,
    paceUsd: pace,
    remainingUsd: remaining,
    spentInPeriodUsd: spent,
    period,
    limitedBy,
  };
}

/**
 * Build a budget from raw environment values; the same contract as
 * `ceilingConfigFromValues`. No `monthlyUsd` means no budget and the flat
 * ceiling stands unchanged, so this feature is off until it is configured.
 * A value that is present but unusable throws rather than quietly turning the
 * budget off, because the budget is a safety limit.
 */
export function budgetConfigFromValues(values: {
  monthlyUsd?: string | number | undefined;
  resetDay?: string | number | undefined;
  maxDailyUsd?: string | number | undefined;
  countFrom?: string | undefined;
}): BudgetConfig | undefined {
  const monthlyUsd = optionalNumber(values.monthlyUsd, 'monthlyUsd');
  if (monthlyUsd === undefined) return undefined;
  if (monthlyUsd <= 0) throw new RangeError(`monthlyUsd must be more than zero, got ${monthlyUsd}`);
  const resetDay = optionalNumber(values.resetDay, 'resetDay') ?? DEFAULT_BUDGET_RESET_DAY;
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 28)
    throw new RangeError(`resetDay must be a whole number from 1 to 28, got ${resetDay}`);
  const maxDailyUsd = optionalNumber(values.maxDailyUsd, 'maxDailyUsd') ?? DEFAULT_MAX_DAILY_USD;
  if (maxDailyUsd <= 0)
    throw new RangeError(`maxDailyUsd must be more than zero, got ${maxDailyUsd}`);
  const countFrom = values.countFrom?.trim();
  if (countFrom && Number.isNaN(new Date(countFrom).getTime()))
    throw new RangeError(`countFrom must be an ISO date or timestamp, got "${countFrom}"`);
  return { monthlyUsd, resetDay, maxDailyUsd, ...(countFrom ? { countFrom } : {}) };
}

function optionalNumber(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be a number, got "${value}"`);
  return parsed;
}
