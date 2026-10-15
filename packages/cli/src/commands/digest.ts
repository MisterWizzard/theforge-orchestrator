/**
 * `forge digest`: the twice-daily summary policy B12 asks for.
 *
 * Reads the database directly (so it works with the coordinator down), the
 * Tier 0 outcome files in the outbox, the halt file and, when credentials are
 * present, the coordinator's /health; renders one Markdown report with a
 * compact head (title plus six lines) above it; and delivers it as a single
 * `digest` escalation of severity info, which severity routing (ADR-023)
 * sends to email and the file outbox and never to the phone. `--channel=ha`
 * is therefore refused rather than honoured: a digest is routine by
 * definition, and the phone is reserved for warn and critical. Nothing here
 * writes to the database.
 *
 * The morning window is the previous local day 17:30 -> now and the evening
 * window today 05:00 -> now, so the two scheduled runs (05:00 and 17:30,
 * scripts/register-digests.ps1) cover the day between them without a gap.
 * "Local" is FORGE_TIMEZONE (Australia/Sydney), daylight saving included.
 *
 * Two operator-facing additions (ADR-025): a "Reminders" section read from a
 * plain text file, FORGE_REMINDERS_FILE (default `<outbox>/reminders.md`), and
 * on a Monday morning (or with `--weekly`) a "Week in review" covering the
 * previous seven local days.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { UNATTRIBUTED_ROLE } from '@theforge/contracts';
import { ROLE_ESTIMATE_REVIEW_CALLS } from '@theforge/guardrails';
import type {
  Approval,
  Attempt,
  Blocker,
  ForgeEvent,
  Notification,
  Run,
  Task,
  UsageRecord,
  UsageSummary,
} from '@theforge/contracts';
import { createDatabase, PostgresForgeRepository } from '@theforge/db';
import {
  adaptiveDailyUsd,
  budgetConfigFromValues,
  budgetPeriod,
  ceilingConfigFromValues,
  DEFAULT_TIME_ZONE,
  evaluateCeiling,
  isValidTimeZone,
  localDay,
  readHaltFile,
  type BudgetConfig,
  type CeilingConfig,
  type CeilingState,
} from '@theforge/guardrails';
import {
  channelsForSeverity,
  channelsFromConfig,
  formatOccurredAt,
  Notifier,
  notifyConfigFromEnv,
  type ChannelSelection,
  type Escalation,
  type NotifierReport,
} from '@theforge/notify';
import { outcomeReportTime, parseOutcomeRecords } from '@theforge/tier0';
import { parseArgs, type Command, type CommandContext } from '../command.js';
import { haltFilePath } from '../halt-file.js';
import {
  createPwshRunner,
  readTaskHealth,
  taskAttentionReason,
  taskNeedsAttention,
  watchedTaskNames,
  type PwshRunner,
  type TaskHealth,
  type TaskHealthRow,
} from './runtime.js';
import {
  dueForEscalation,
  readTaskHealthState,
  repeatedFailures,
  taskFailingEscalation,
  taskHealthSnapshot,
  taskHealthStatePath,
  writeTaskHealthState,
} from './task-health.js';
import { formatReport } from './tier0-ingest.js';

/** The slice of the repository a digest reads; PostgresForgeRepository satisfies it. */
export type DigestSource = {
  listRuns(): Promise<Run[]>;
  listTasks(runId: string): Promise<Task[]>;
  listAttempts(runId: string): Promise<Attempt[]>;
  listBlockers(runId: string): Promise<Blocker[]>;
  listApprovals(): Promise<Approval[]>;
  listEventsSince(from: Date, to?: Date, types?: readonly string[]): Promise<ForgeEvent[]>;
  listNotificationsSince(from: Date): Promise<Notification[]>;
  listUsageRecordsSince(from: Date, to?: Date): Promise<UsageRecord[]>;
  sumUsageSince(from: Date, to?: Date): Promise<UsageSummary>;
  countMeteredCallsByRole(): Promise<Record<string, number>>;
};

export type OpenDigestSource = (
  databaseUrl: string,
) => Promise<{ source: DigestSource; close: () => Promise<void> }>;

export type DigestWindowName = 'morning' | 'evening' | 'now' | 'since';

export type DigestWindow = {
  name: DigestWindowName;
  /** ISO 8601; the window is [from, to). */
  from: string;
  to: string;
  timeZone: string;
  /** The local day `to` falls on, YYYY-MM-DD: the day the digest is filed under. */
  localDate: string;
};

export type RunLine = {
  id: string;
  state: Run['state'];
  resumeState?: Run['state'];
  projectId: string;
  objective: string;
  spentUsd: number;
  createdAt: string;
  updatedAt: string;
};

export type BlockerLine = {
  id: string;
  runId: string;
  taskId: string;
  task: string;
  classification: Blocker['classification'];
  summary: string;
  smallestUnblockAction: string;
};

export type AttemptLine = {
  id: string;
  runId: string;
  taskId: string;
  task: string;
  state: string;
  provider?: string;
  finishedAt?: string;
  error?: string;
};

export type EventLine = {
  id: string;
  runId: string;
  type: string;
  createdAt: string;
  detail: string;
};

export type ApprovalLine = {
  id: string;
  runId: string;
  actionClass: Approval['actionClass'];
  action: string;
  expiresAt: string;
  expired: boolean;
};

export type NotificationLine = {
  id: string;
  kind: string;
  channel: string;
  status: string;
  createdAt: string;
  runId?: string;
  error?: string;
};

/** One line of the reminders file; `from` is the YYYY-MM-DD prefix, when there was one. */
export type ReminderLine = { text: string; from?: string };

export type Reminders = {
  file: string;
  /** Reminders due today: every undated line plus the dated ones whose date has arrived. */
  items: ReminderLine[];
  /** Dated lines whose date is still ahead; counted so the file is known to have been read. */
  upcoming: number;
  /** The file exists but could not be read; ENOENT is not an error, it is "no reminders". */
  error?: string;
};

/**
 * The previous seven local days, Monday morning (or `--weekly`): what the
 * cloud cost, what ran on subscription or local at $0, what finished, what
 * Tier 0 did and on which days the ceiling was reached.
 */
export type WeeklyReview = {
  /** ISO 8601; [from, to) covers the seven local days ending yesterday. */
  from: string;
  to: string;
  /** First and last local day covered, YYYY-MM-DD, both inclusive. */
  fromDate: string;
  toDate: string;
  /** True when `--weekly` asked for the section outside a Monday morning. */
  forced: boolean;
  cloud: {
    usd: number;
    calls: number;
    byProvider: Array<{ provider: string; usd: number; calls: number }>;
  };
  /** Calls recorded at $0: Codex on its subscription, local models. Never against the ceiling. */
  unmetered: Array<{ provider: string; calls: number }>;
  runs: { total: number; counts: Record<string, number> };
  tier0: {
    files: number;
    outcomes: number;
    merged: number;
    deferred: number;
    escalated: number;
    other: number;
    unreadable: number;
  };
  /** Local days (YYYY-MM-DD) on which a `spend.ceiling` event was recorded. */
  ceilingDays: string[];
};

export type DigestData = {
  generatedAt: string;
  window: DigestWindow;
  runs: {
    finished: { total: number; counts: Record<string, number>; items: RunLine[] };
    /** Runs in flight or paused; `notStarted` counts those still `created`. */
    active: { total: number; notStarted: number; counts: Record<string, number>; items: RunLine[] };
    blocked: { runs: RunLine[]; blockers: BlockerLine[] };
  };
  failures: {
    attempts: AttemptLine[];
    events: { counts: Record<string, number>; items: EventLine[] };
  };
  spend: {
    window: UsageSummary;
    day: {
      date: string;
      timeZone: string;
      spentUsd: number;
      ceilingUsd: number;
      remainingUsd: number;
      state: CeilingState;
      message: string;
    };
    /**
     * The monthly allowance behind an adaptive cap (ADR-037); absent when no
     * `FORGE_MONTHLY_BUDGET_USD` is set and the flat ceiling stands.
     */
    budget?: {
      monthlyUsd: number;
      periodStart: string;
      periodNext: string;
      daysLeft: number;
      spentBeforeTodayUsd: number;
      remainingUsd: number;
      paceUsd: number;
      limitedBy: 'base' | 'pace' | 'max' | 'remaining';
    };
    /**
     * Calls recorded at $0, by provider: Codex on its subscription, local
     * models. They cost nothing and are not counted against the ceiling.
     */
    unmetered: Array<{ provider: string; calls: number }>;
    /**
     * Progress toward recalibrating `ROLE_ESTIMATES_USD` (ADR-034). Dan's
     * decision of 04/10/2026 was to leave the estimates alone until 50 metered
     * calls are on record and correct them then, so this carries the count
     * rather than leaving the decision to be remembered.
     */
    roleEstimates: {
      meteredCalls: number;
      threshold: number;
      due: boolean;
      byRole: Record<string, number>;
    };
  };
  escalations: {
    total: number;
    sent: number;
    failed: number;
    pending: number;
    byKind: Array<{ kind: string; channels: Record<string, Record<string, number>> }>;
    outstanding: NotificationLine[];
  };
  guards: { total: number; counts: Record<string, number>; items: EventLine[] };
  /** Stages that failed over from one provider to another in the window, grouped by direction. */
  failover: {
    total: number;
    items: Array<{ from: string; to: string; count: number; lastAt: string; lastReason: string }>;
  };
  waiting: { approvals: ApprovalLine[]; blockers: BlockerLine[] };
  tier0: {
    directory: string;
    files: number;
    outcomes: number;
    merged: string[];
    deferred: string[];
    escalated: string[];
    other: number;
    unreadable: string[];
  };
  routing: { wired: false; note: string; cloudCalls: number; unmeteredCalls: number };
  reminders: Reminders;
  /** Present on a Monday morning digest, or whenever `--weekly` was given. */
  weekly?: WeeklyReview;
  health: { coordinator: string; haltFile: string; halted: boolean };
  /**
   * The scheduled tasks, so a job that has quietly stopped working is reported by
   * something. BLK-025: `TheForge Node Watch` sat at 0x1 for days and the only thing
   * that noticed was a human asking for a status check.
   */
  tasks: TaskHealth;
};

export type RenderedDigest = { title: string; compact: string; markdown: string };

export const FAILURE_EVENT_TYPES = [
  'attempt.lease_expired',
  'worker_job.lease_reconciled',
  'run.restart_failed',
] as const;
/**
 * A stage that ran on another provider because the first choice failed (ADR-024, ADR-038). Silent
 * by design at run time - the work still completes - which is exactly why the digest must say it.
 */
export const FAILOVER_EVENT_TYPES = ['provider.fallback'] as const;
export const GUARD_EVENT_TYPES = [
  'spend.warn',
  'spend.ceiling',
  'run.paused_by_guard',
  'guard.task_limit',
] as const;
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
]);
/** Blocker classes that need a human, not a retry. */
const DECISION_BLOCKER_CLASSES: ReadonlySet<string> = new Set([
  'product_decision',
  'missing_access',
  'safety_constraint',
]);
/** How many lines a section shows before "and N more". */
const MAX_LINES = 5;
const NOW_WINDOW_MS = 12 * 60 * 60 * 1_000;

// --- Window maths ----------------------------------------------------------

/**
 * Milliseconds to add to an instant to get its wall-clock reading in the zone
 * as if it were UTC; the zone's UTC offset at that instant.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(at.getTime() / 1_000) * 1_000;
}

/** The instant at which `date` (YYYY-MM-DD) reads hour:minute on a clock in `timeZone`. */
export function zonedTime(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // First guess treats the wall time as UTC; the second pass re-reads the
  // offset at the corrected instant so a daylight-saving change between the
  // two readings is applied, not skipped.
  let instant = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = wall - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/** Calendar arithmetic on YYYY-MM-DD, independent of any zone. */
function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * morning: previous local day 17:30 -> now. evening: today 05:00 -> now, or
 * yesterday 05:00 when run before 05:00. now: the last twelve hours.
 */
export function digestWindow(
  name: 'morning' | 'evening' | 'now',
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): DigestWindow {
  const today = localDay(now, timeZone);
  let from: Date;
  if (name === 'morning') {
    from = zonedTime(shiftDay(today, -1), 17, 30, timeZone);
  } else if (name === 'evening') {
    from = zonedTime(today, 5, 0, timeZone);
    if (from.getTime() > now.getTime()) from = zonedTime(shiftDay(today, -1), 5, 0, timeZone);
  } else {
    from = new Date(now.getTime() - NOW_WINDOW_MS);
  }
  return { name, from: from.toISOString(), to: now.toISOString(), timeZone, localDate: today };
}

export function sinceWindow(since: Date, now: Date, timeZone: string): DigestWindow {
  return {
    name: 'since',
    from: since.toISOString(),
    to: now.toISOString(),
    timeZone,
    localDate: localDay(now, timeZone),
  };
}

/** Before noon the morning digest is the one that is due; after it, the evening one. */
export function defaultWindowName(now: Date, timeZone: string): 'morning' | 'evening' {
  return zonedTime(localDay(now, timeZone), 12, 0, timeZone).getTime() > now.getTime()
    ? 'morning'
    : 'evening';
}

/** Whether a local day (YYYY-MM-DD) is a Monday; pure calendar, no zone involved. */
export function isMonday(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1;
}

/**
 * The seven local days before `localDate`: midnight seven days back up to
 * (not including) midnight on `localDate`. On a Monday that is the previous
 * Monday 00:00 through Sunday 23:59:59, which is what "last week" means.
 */
export function weekRange(
  localDate: string,
  timeZone: string,
): Pick<WeeklyReview, 'from' | 'to' | 'fromDate' | 'toDate'> {
  const fromDate = shiftDay(localDate, -7);
  return {
    from: zonedTime(fromDate, 0, 0, timeZone).toISOString(),
    to: zonedTime(localDate, 0, 0, timeZone).toISOString(),
    fromDate,
    toDate: shiftDay(localDate, -1),
  };
}

/** Whether the digest for this window carries the week in review. */
export function weeklyDue(window: DigestWindow, forced: boolean): boolean {
  return forced || (window.name === 'morning' && isMonday(window.localDate));
}

// --- Reminders ---------------------------------------------------------------

const REMINDER_DATE = /^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/;

/**
 * One reminder per non-empty line; `#` starts a comment. A line may begin with
 * `YYYY-MM-DD ` meaning "show from that day on": an undated line always shows,
 * a dated one only once `localDate` has reached its date. A line that is only
 * a date is dropped, there being nothing to remind about.
 */
export function parseReminders(
  text: string,
  localDate: string,
): { items: ReminderLine[]; upcoming: number } {
  const items: ReminderLine[] = [];
  let upcoming = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = REMINDER_DATE.exec(line);
    if (!match) {
      items.push({ text: line });
      continue;
    }
    const from = match[1] as string;
    const body = (match[2] ?? '').trim();
    if (!body) continue;
    // ISO dates compare as strings, which is the point of the format.
    if (from > localDate) upcoming += 1;
    else items.push({ text: body, from });
  }
  return { items, upcoming };
}

/** Where the reminders live: FORGE_REMINDERS_FILE, else `<outbox>/reminders.md`. */
export function remindersFilePath(
  env: Record<string, string | undefined>,
  outboxDir: string,
): string {
  const explicit = env.FORGE_REMINDERS_FILE?.trim();
  return explicit ? resolve(explicit) : join(outboxDir, 'reminders.md');
}

async function collectReminders(file: string, localDate: string): Promise<Reminders> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No file is the normal case: nothing to remind about, nothing to say.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { file, items: [], upcoming: 0 };
    return {
      file,
      items: [],
      upcoming: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { file, ...parseReminders(text, localDate) };
}

// --- Collection --------------------------------------------------------------

export type CollectOptions = {
  window: DigestWindow;
  now: Date;
  ceiling: CeilingConfig;
  /** A monthly allowance that makes the day's cap adaptive (ADR-037); absent keeps the flat ceiling. */
  budget?: BudgetConfig | undefined;
  /** The notify outbox; Tier 0 outcomes live in its `tier0` folder. */
  outboxDir: string;
  /** The reminders file; absent is fine (see `collectReminders`). */
  remindersFile: string;
  /** Force the week in review outside a Monday morning (`--weekly`). */
  weekly?: boolean;
  health: DigestData['health'];
  /**
   * Pre-computed, like `health`, because reading Task Scheduler needs a PowerShell
   * runner and these options carry no way to inject one. Both side-effecting checks
   * are therefore done in the command body and passed in as plain data, which also
   * keeps `collectDigest` a pure function of the database and the filesystem.
   */
  tasks: TaskHealth;
};

const runLine = (run: Run): RunLine => ({
  id: run.id,
  state: run.state,
  ...(run.resumeState ? { resumeState: run.resumeState } : {}),
  projectId: run.projectId,
  objective: run.objective,
  spentUsd: run.spent.usd,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

const byUpdatedDesc = (
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string },
) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

function count<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function errorText(error: Record<string, unknown> | undefined): string | undefined {
  if (!error) return undefined;
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message = typeof error.message === 'string' ? error.message.trim() : undefined;
  const text = [code, message].filter(Boolean).join(': ');
  return text || JSON.stringify(error);
}

function eventDetail(event: ForgeEvent): string {
  const payload = event.payload;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  const words = pick('reason', 'message', 'summary');
  if (words) return words;
  if (event.type === 'run.restart_failed') {
    const response = payload.response;
    const nested =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>).message
        : undefined;
    const status = typeof payload.statusCode === 'number' ? String(payload.statusCode) : '?';
    return `HTTP ${status}${typeof nested === 'string' ? `: ${nested}` : ''}`;
  }
  const parts = Object.entries(payload)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.join(', ');
}

/** Group `provider.fallback` events by direction, newest reason kept; the largest group first. */
function summariseFailover(events: readonly ForgeEvent[]): DigestData['failover'] {
  const text = (value: unknown, fallback: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const groups = new Map<
    string,
    { from: string; to: string; count: number; lastAt: string; lastReason: string }
  >();
  for (const event of events) {
    const from = text(event.payload.from, 'unknown');
    const to = text(event.payload.to, 'unknown');
    const key = `${from}\u0000${to}`;
    const group = groups.get(key) ?? { from, to, count: 0, lastAt: '', lastReason: '' };
    group.count += 1;
    if (event.createdAt >= group.lastAt) {
      group.lastAt = event.createdAt;
      group.lastReason = [event.payload.code, event.payload.message]
        .map((part) => text(part, ''))
        .filter(Boolean)
        .join(': ');
    }
    groups.set(key, group);
  }
  return {
    total: events.length,
    items: [...groups.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
  };
}

const eventLine = (event: ForgeEvent): EventLine => ({
  id: event.id,
  runId: event.runId,
  type: event.type,
  createdAt: event.createdAt,
  detail: eventDetail(event),
});

function approvalAction(approval: Approval): string {
  try {
    const parsed: unknown = JSON.parse(approval.normalizedAction);
    if (parsed && typeof parsed === 'object') {
      const args = (parsed as { args?: unknown }).args;
      if (Array.isArray(args) && args.every((item) => typeof item === 'string'))
        return args.join(' ');
    }
  } catch {
    // Not JSON; the raw text is the best description there is.
  }
  return approval.normalizedAction;
}

/** When a Tier 0 outcomes file was written: from its name, else from its mtime. */
async function tier0FileTime(directory: string, name: string): Promise<number> {
  return outcomeReportTime(name) ?? (await stat(join(directory, name))).mtimeMs;
}

async function collectTier0(
  outboxDir: string,
  fromMs: number,
  toMs: number,
): Promise<DigestData['tier0']> {
  const directory = join(outboxDir, 'tier0');
  const result: DigestData['tier0'] = {
    directory,
    files: 0,
    outcomes: 0,
    merged: [],
    deferred: [],
    escalated: [],
    other: 0,
    unreadable: [],
  };
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    // No folder yet (Tier 0 has not run) or the outbox path is not a directory
    // at all: either way there are no outcomes to report, and the outbox
    // channel will say so in its own words if it matters.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    throw error;
  }
  for (const name of names) {
    const writtenAt = await tier0FileTime(directory, name);
    if (writtenAt < fromMs || writtenAt >= toMs) continue;
    result.files += 1;
    let records;
    try {
      records = parseOutcomeRecords(await readFile(join(directory, name), 'utf8'));
    } catch (error) {
      result.unreadable.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const record of records) {
      result.outcomes += 1;
      const ref = `${record.repository}#${record.number}`;
      if (record.action === 'merge' && record.merged) result.merged.push(ref);
      else if (record.action === 'deferred') result.deferred.push(ref);
      else if (record.action === 'escalate') result.escalated.push(ref);
      else result.other += 1;
    }
  }
  return result;
}

async function collectWeekly(
  source: DigestSource,
  runs: readonly Run[],
  options: CollectOptions,
): Promise<WeeklyReview> {
  const { window } = options;
  const range = weekRange(window.localDate, window.timeZone);
  const from = new Date(range.from);
  const to = new Date(range.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inRange = (iso: string): boolean => {
    const at = Date.parse(iso);
    return at >= fromMs && at < toMs;
  };

  const usage = await source.sumUsageSince(from, to);
  const records = await source.listUsageRecordsSince(from, to);
  const unmetered = count(
    records.filter((record) => record.costUsd === 0),
    (record) => record.provider,
  );
  const cloudRecords = records.filter((record) => record.costUsd > 0);
  const cloudByProvider = Object.entries(usage.byProvider)
    .filter(([, item]) => item.usd > 0)
    .map(([provider, item]) => ({
      provider,
      usd: item.usd,
      calls: cloudRecords.filter((record) => record.provider === provider).length,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  const finished = runs.filter(
    (run) => TERMINAL_RUN_STATES.has(run.state) && inRange(run.updatedAt),
  );
  const tier0 = await collectTier0(options.outboxDir, fromMs, toMs);
  // Every ceiling event names the local day it was counted in; the event's
  // own timestamp is the fallback for one that somehow does not.
  const ceilingEvents = await source.listEventsSince(from, to, ['spend.ceiling']);
  const ceilingDays = [
    ...new Set(
      ceilingEvents.map((event) =>
        typeof event.payload.day === 'string'
          ? event.payload.day
          : localDay(new Date(event.createdAt), window.timeZone),
      ),
    ),
  ].sort();

  return {
    ...range,
    forced: !(window.name === 'morning' && isMonday(window.localDate)),
    cloud: { usd: usage.usd, calls: cloudRecords.length, byProvider: cloudByProvider },
    unmetered: Object.entries(unmetered)
      .map(([provider, calls]) => ({ provider, calls }))
      .sort((a, b) => a.provider.localeCompare(b.provider)),
    runs: { total: finished.length, counts: count(finished, (run) => run.state) },
    tier0: {
      files: tier0.files,
      outcomes: tier0.outcomes,
      merged: tier0.merged.length,
      deferred: tier0.deferred.length,
      escalated: tier0.escalated.length,
      other: tier0.other,
      unreadable: tier0.unreadable.length,
    },
    ceilingDays,
  };
}

export async function collectDigest(
  source: DigestSource,
  options: CollectOptions,
): Promise<DigestData> {
  const { window, now } = options;
  const from = new Date(window.from);
  const to = new Date(window.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inWindow = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return at >= fromMs && at < toMs;
  };

  const runs = await source.listRuns();
  const terminal = (run: Run) => TERMINAL_RUN_STATES.has(run.state);
  const finished = runs.filter((run) => terminal(run) && inWindow(run.updatedAt));
  // A run still `created` has never been started, so it has no attempts, no
  // blockers and no age worth reporting; it is counted, not listed.
  const notStarted = runs.filter((run) => run.state === 'created');
  const active = runs.filter(
    (run) => !terminal(run) && run.state !== 'blocked' && run.state !== 'created',
  );
  const blockedRuns = runs.filter((run) => run.state === 'blocked');
  // Attempts and blockers are read per run: every run still moving, plus any
  // that reached its end inside the window.
  const candidates = runs.filter(
    (run) => (!terminal(run) && run.state !== 'created') || inWindow(run.updatedAt),
  );

  const failedAttempts: AttemptLine[] = [];
  const activeBlockers: BlockerLine[] = [];
  for (const run of candidates) {
    const attempts = (await source.listAttempts(run.id)).filter(
      (attempt) =>
        (attempt.state === 'failed' || attempt.state === 'expired') && inWindow(attempt.finishedAt),
    );
    const blockers = terminal(run)
      ? []
      : (await source.listBlockers(run.id)).filter((blocker) => blocker.status === 'active');
    if (attempts.length === 0 && blockers.length === 0) continue;
    const titles = new Map((await source.listTasks(run.id)).map((task) => [task.id, task.title]));
    for (const attempt of attempts) {
      const error = errorText(attempt.error);
      failedAttempts.push({
        id: attempt.id,
        runId: run.id,
        taskId: attempt.taskId,
        task: titles.get(attempt.taskId) ?? attempt.taskId,
        state: attempt.state,
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
        ...(error ? { error } : {}),
      });
    }
    for (const blocker of blockers) {
      activeBlockers.push({
        id: blocker.id,
        runId: run.id,
        taskId: blocker.taskId,
        task: titles.get(blocker.taskId) ?? blocker.taskId,
        classification: blocker.classification,
        summary: blocker.summary,
        smallestUnblockAction: blocker.smallestUnblockAction,
      });
    }
  }
  failedAttempts.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));

  const failureEvents = await source.listEventsSince(from, to, FAILURE_EVENT_TYPES);
  const guardEvents = await source.listEventsSince(from, to, GUARD_EVENT_TYPES);
  const failoverEvents = await source.listEventsSince(from, to, FAILOVER_EVENT_TYPES);

  const windowUsage = await source.sumUsageSince(from, to);
  // All-time, not windowed: the question is how much evidence exists in total,
  // and a 12-hour window would never reach the threshold.
  const meteredByRole = await source.countMeteredCallsByRole();
  const dayStart = zonedTime(window.localDate, 0, 0, window.timeZone);
  // With a budget the day's cap is the adaptive one the coordinator enforces, worked out here from
  // the same inputs: the period's spend before today. Usage before `countFrom` was never billed to
  // the allowance, so it is left out of both the day and the period.
  const countFrom = options.budget?.countFrom ? new Date(options.budget.countFrom) : undefined;
  const dayFrom = countFrom && countFrom > dayStart ? countFrom : dayStart;
  const dayUsage = await source.sumUsageSince(dayFrom, now);
  let dayCeiling = options.ceiling;
  let budgetSummary: DigestData['spend']['budget'];
  if (options.budget) {
    const period = budgetPeriod(window.localDate, options.budget.resetDay);
    const periodStart = zonedTime(period.start, 0, 0, window.timeZone);
    const periodFrom = countFrom && countFrom > periodStart ? countFrom : periodStart;
    const before =
      periodFrom < dayStart ? await source.sumUsageSince(periodFrom, dayStart) : { usd: 0 };
    const adaptive = adaptiveDailyUsd(
      options.ceiling.dailyUsd,
      options.budget,
      window.localDate,
      before.usd,
    );
    dayCeiling = { dailyUsd: adaptive.dailyUsd, warnAtFraction: options.ceiling.warnAtFraction };
    budgetSummary = {
      monthlyUsd: options.budget.monthlyUsd,
      periodStart: period.start,
      periodNext: period.next,
      daysLeft: period.daysLeft,
      spentBeforeTodayUsd: adaptive.spentInPeriodUsd,
      remainingUsd: adaptive.remainingUsd,
      paceUsd: adaptive.paceUsd,
      limitedBy: adaptive.limitedBy,
    };
  }
  const ceiling = evaluateCeiling(dayUsage.usd, dayCeiling, window.localDate, window.timeZone);
  const usageRecords = await source.listUsageRecordsSince(from, to);
  const unmeteredCounts = count(
    usageRecords.filter((record) => record.costUsd === 0),
    (record) => record.provider,
  );

  const notifications = (await source.listNotificationsSince(from)).filter((notification) =>
    inWindow(notification.createdAt),
  );
  const byKind = new Map<string, Record<string, Record<string, number>>>();
  for (const notification of notifications) {
    const channels = byKind.get(notification.kind) ?? {};
    const statuses = (channels[notification.channel] ??= {});
    statuses[notification.status] = (statuses[notification.status] ?? 0) + 1;
    byKind.set(notification.kind, channels);
  }
  const outstanding = notifications
    .filter((notification) => notification.status === 'pending' || notification.status === 'failed')
    .map((notification): NotificationLine => ({
      id: notification.id,
      kind: notification.kind,
      channel: notification.channel,
      status: notification.status,
      createdAt: notification.createdAt,
      ...(notification.runId ? { runId: notification.runId } : {}),
      ...(notification.lastError ? { error: errorText(notification.lastError) ?? '' } : {}),
    }));

  const approvals = (await source.listApprovals())
    .filter((approval) => approval.status === 'pending')
    .map((approval): ApprovalLine => ({
      id: approval.id,
      runId: approval.runId,
      actionClass: approval.actionClass,
      action: approvalAction(approval),
      expiresAt: approval.expiresAt,
      expired: Date.parse(approval.expiresAt) <= now.getTime(),
    }));

  return {
    generatedAt: now.toISOString(),
    window,
    runs: {
      finished: {
        total: finished.length,
        counts: count(finished, (run) => run.state),
        items: finished.map(runLine).sort(byUpdatedDesc),
      },
      active: {
        total: active.length,
        notStarted: notStarted.length,
        counts: count(active, (run) => run.state),
        items: active.map(runLine).sort(byUpdatedDesc),
      },
      blocked: { runs: blockedRuns.map(runLine).sort(byUpdatedDesc), blockers: activeBlockers },
    },
    failures: {
      attempts: failedAttempts,
      events: {
        counts: count(failureEvents, (event) => event.type),
        items: failureEvents.map(eventLine),
      },
    },
    spend: {
      window: windowUsage,
      day: {
        date: window.localDate,
        timeZone: window.timeZone,
        spentUsd: ceiling.spentTodayUsd,
        ceilingUsd: dayCeiling.dailyUsd,
        remainingUsd: ceiling.remainingUsd,
        state: ceiling.state,
        message: ceiling.message,
      },
      ...(budgetSummary ? { budget: budgetSummary } : {}),
      roleEstimates: {
        meteredCalls: Object.values(meteredByRole).reduce((total, calls) => total + calls, 0),
        threshold: ROLE_ESTIMATE_REVIEW_CALLS,
        due:
          Object.values(meteredByRole).reduce((total, calls) => total + calls, 0) >=
          ROLE_ESTIMATE_REVIEW_CALLS,
        byRole: meteredByRole,
      },
      unmetered: Object.entries(unmeteredCounts)
        .map(([provider, calls]) => ({ provider, calls }))
        .sort((a, b) => a.provider.localeCompare(b.provider)),
    },
    escalations: {
      total: notifications.length,
      sent: notifications.filter((item) => item.status === 'sent').length,
      failed: notifications.filter((item) => item.status === 'failed').length,
      pending: notifications.filter((item) => item.status === 'pending').length,
      byKind: [...byKind].map(([kind, channels]) => ({ kind, channels })),
      outstanding,
    },
    guards: {
      total: guardEvents.length,
      counts: count(guardEvents, (event) => event.type),
      items: guardEvents.map(eventLine),
    },
    failover: summariseFailover(failoverEvents),
    waiting: {
      approvals,
      blockers: activeBlockers.filter((blocker) =>
        DECISION_BLOCKER_CLASSES.has(blocker.classification),
      ),
    },
    tier0: await collectTier0(options.outboxDir, fromMs, toMs),
    routing: {
      wired: false,
      note: 'not yet wired: no RouteDecision is produced, so no saving is claimed',
      cloudCalls: usageRecords.filter((record) => record.costUsd > 0).length,
      unmeteredCalls: usageRecords.filter((record) => record.costUsd === 0).length,
    },
    reminders: await collectReminders(options.remindersFile, window.localDate),
    ...(weeklyDue(window, options.weekly === true)
      ? { weekly: await collectWeekly(source, runs, options) }
      : {}),
    health: options.health,
    tasks: options.tasks,
  };
}

// --- Rendering -------------------------------------------------------------

const money = (usd: number): string => `$${usd.toFixed(2)}`;

const LIMITED_BY_TEXT: Record<'base' | 'pace' | 'max' | 'remaining', string> = {
  base: 'the daily floor',
  pace: 'the even share of what is left',
  max: 'the daily maximum',
  remaining: 'what is left of the allowance',
};
const short = (id: string): string => id.slice(0, 8);
const plural = (n: number, word: string, words = `${word}s`): string =>
  `${n} ${n === 1 ? word : words}`;

export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** "2 completed, 1 failed"; run states read as words, event types stay as typed. */
function countsText(
  counts: Record<string, number>,
  options: { order?: readonly string[]; words?: boolean } = {},
): string {
  const keys = options.order ? [...options.order] : Object.keys(counts).sort();
  return keys
    .filter((key) => options.order || counts[key])
    .map((key) => `${counts[key] ?? 0} ${options.words ? key.replace(/_/g, ' ') : key}`)
    .join(', ');
}

function more(total: number, shown: number, noun: string): string[] {
  return total > shown ? [`- and ${total - shown} more ${noun}`] : [];
}

/**
 * An error rendered so a log reader learns something. `error.message` alone is not
 * enough: a failed PostgreSQL connection can carry an empty message, and the cause is
 * where the reason actually lives.
 */
export function describeError(error: unknown): string {
  if (error === undefined || error === null) return '(no detail)';
  if (!(error instanceof Error)) return safeText(error);
  // `error.name` is inherited, so a subclass that does not set it reports 'Error' - which
  // is most subclasses. The constructor name is the fact a log reader wants.
  const name = error.constructor?.name || error.name || 'Error';
  const cause = (error as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error
      ? `${cause.constructor?.name || cause.name}: ${cause.message}`
      : cause === undefined || cause === null
        ? ''
        : safeText(cause);
  const parts = [error.message.trim(), causeText.trim()].filter(Boolean);
  if (parts.length === 0) return `${name} with no message`;
  return `${name}: ${parts.join(' <- ')}`;
}

/**
 * A value rendered for a human, never as `[object Object]`.
 *
 * `String(someObject)` is `'[object Object]'`, which is the same uninformative output
 * this whole helper exists to stop - the lint rule `no-base-to-string` caught it, and it
 * was right to. An object is JSON instead, clipped, and a value that cannot be
 * serialised at all says so rather than throwing inside an error handler.
 */
function safeText(value: unknown): string {
  if (typeof value === 'string') return value.trim() || '(empty string)';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol' || typeof value === 'function')
    return value.toString() || '(no detail)';
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '(no detail)';
    return json.length > 300 ? `${json.slice(0, 300)}...` : json;
  } catch {
    return '(unserialisable value)';
  }
}

/** The date a digest is filed under, DD/MM/YYYY. */
function localDateText(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

export function digestTitle(window: DigestWindow): string {
  const day = localDateText(window.localDate);
  switch (window.name) {
    case 'morning':
      return `Morning digest ${day}`;
    case 'evening':
      return `Evening digest ${day}`;
    case 'now':
      return `Digest, last 12 h to ${formatOccurredAt(window.to, window.timeZone)}`;
    default:
      return `Digest since ${formatOccurredAt(window.from, window.timeZone)}`;
  }
}

/** Why a call cost nothing: Codex is on its subscription, ollama is local (ADR-021). */
function unmeteredKind(provider: string): string {
  if (provider === 'codex') return 'subscription';
  if (provider === 'ollama') return 'local';
  return '$0';
}

/** The one sentence every unmetered figure carries, so no reader takes $0 for a saving. */
const UNMETERED_NOTE = '$0, not counted against the ceiling';

function unmeteredText(items: readonly { provider: string; calls: number }[]): string {
  return items.length
    ? `${items.map((item) => `${item.provider} ${plural(item.calls, 'call')} (${unmeteredKind(item.provider)})`).join(', ')}: ${UNMETERED_NOTE}`
    : 'none';
}

/** "claude $2.25 / 2 calls; codex $0.00 / 1 call (subscription)". */
function providerText(byProvider: Record<string, { usd: number; count: number }>): string {
  return Object.entries(byProvider)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, usage]) => {
      const kind = usage.usd === 0 ? unmeteredKind(provider) : '$0';
      return `${provider} ${money(usage.usd)} / ${plural(usage.count, 'call')}${kind === '$0' ? '' : ` (${kind})`}`;
    })
    .join('; ');
}

/**
 * "builder $1.27 / 1 call; planner $0.48 / 1 call".
 *
 * Ordered by spend rather than by name, unlike `providerText`: the question
 * this line exists to answer is which role costs the most, so the answer
 * belongs first. Ties break on the name, so the order is still deterministic.
 */
function roleText(byRole: Record<string, { usd: number; count: number }>): string {
  return Object.entries(byRole)
    .sort(([aName, a], [bName, b]) => b.usd - a.usd || aName.localeCompare(bName))
    .map(([role, usage]) => `${role} ${money(usage.usd)} / ${plural(usage.count, 'call')}`)
    .join('; ');
}

function prList(refs: readonly string[]): string {
  // Repeat the repository only when it changes: "owner/repo#26, #27, other/repo#3".
  let previous = '';
  return refs
    .map((ref) => {
      const hash = ref.lastIndexOf('#');
      const repository = ref.slice(0, hash);
      const text = repository === previous ? ref.slice(hash) : ref;
      previous = repository;
      return text;
    })
    .join(', ');
}

export function renderMarkdown(data: DigestData): string {
  const { window } = data;
  const tz = window.timeZone;
  const nowMs = Date.parse(data.generatedAt);
  const lines: string[] = [
    `# ${digestTitle(window)}`,
    '',
    `Window ${formatOccurredAt(window.from, tz)} -> ${formatOccurredAt(window.to, tz)} (${tz}), generated ${formatOccurredAt(data.generatedAt, tz)}.`,
  ];

  // Reminders come first: they are the operator's own words to themselves,
  // and a missing file is simply no section.
  const reminders = data.reminders;
  if (reminders.items.length || reminders.error) {
    lines.push('', `## Reminders: ${reminders.items.length}`);
    for (const item of reminders.items) lines.push(`- ${item.text}`);
    if (reminders.upcoming)
      lines.push(`- (${plural(reminders.upcoming, 'more line')} dated for later)`);
    if (reminders.error) lines.push(`- could not read ${reminders.file}: ${reminders.error}`);
  }

  const finished = data.runs.finished;
  lines.push(
    '',
    `## Finished runs: ${finished.total} (${countsText(finished.counts, { order: ['completed', 'partially_completed', 'failed', 'cancelled'], words: true })})`,
  );
  for (const run of finished.items.slice(0, MAX_LINES)) {
    lines.push(
      `- ${run.state.replace(/_/g, ' ')} ${short(run.id)} [${run.projectId}] ${money(run.spentUsd)}, ${formatOccurredAt(run.updatedAt, tz)}: ${clip(run.objective, 90)}`,
    );
  }
  lines.push(...more(finished.total, MAX_LINES, 'finished'));

  const active = data.runs.active;
  lines.push(
    '',
    `## Active runs: ${active.total}${active.total ? ` (${countsText(active.counts, { words: true })})` : ''}${active.notStarted ? `; ${active.notStarted} created but never started` : ''}`,
  );
  for (const run of active.items.slice(0, MAX_LINES)) {
    const state = run.resumeState ? `${run.state} (was ${run.resumeState})` : run.state;
    lines.push(
      `- ${state} ${short(run.id)} [${run.projectId}] age ${formatAge(nowMs - Date.parse(run.createdAt))}, last change ${formatAge(nowMs - Date.parse(run.updatedAt))} ago, ${money(run.spentUsd)}: ${clip(run.objective, 90)}`,
    );
  }
  lines.push(...more(active.total, MAX_LINES, 'active'));

  const blocked = data.runs.blocked;
  lines.push(
    '',
    `## Blocked: ${plural(blocked.runs.length, 'run')}, ${plural(blocked.blockers.length, 'active blocker')}`,
  );
  for (const run of blocked.runs.slice(0, MAX_LINES)) {
    lines.push(
      `- run ${short(run.id)} [${run.projectId}] blocked for ${formatAge(nowMs - Date.parse(run.updatedAt))}: ${clip(run.objective, 90)}`,
    );
  }
  lines.push(...more(blocked.runs.length, MAX_LINES, 'blocked runs'));
  for (const blocker of blocked.blockers.slice(0, MAX_LINES)) {
    lines.push(
      `- [${blocker.classification}] ${short(blocker.runId)} / ${clip(blocker.task, 40)}: ${clip(blocker.summary, 120)} -> ${clip(blocker.smallestUnblockAction, 120)}`,
    );
  }
  lines.push(...more(blocked.blockers.length, MAX_LINES, 'blockers'));

  const failures = data.failures;
  const failureCounts = FAILURE_EVENT_TYPES.map(
    (type) => `${failures.events.counts[type] ?? 0} ${type}`,
  ).join(', ');
  lines.push(
    '',
    `## Failures and retries: ${plural(failures.attempts.length, 'attempt')} failed or expired; ${failureCounts}`,
  );
  for (const attempt of failures.attempts.slice(0, MAX_LINES)) {
    lines.push(
      `- ${attempt.state} attempt on "${clip(attempt.task, 50)}" (run ${short(attempt.runId)}${attempt.provider ? `, ${attempt.provider}` : ''}${attempt.finishedAt ? `, ${formatOccurredAt(attempt.finishedAt, tz)}` : ''})${attempt.error ? `: ${clip(attempt.error, 140)}` : ''}`,
    );
  }
  lines.push(...more(failures.attempts.length, MAX_LINES, 'attempts'));
  for (const event of failures.events.items.slice(0, MAX_LINES)) {
    lines.push(
      `- ${event.type} run ${short(event.runId)} ${formatOccurredAt(event.createdAt, tz)}${event.detail ? `: ${clip(event.detail, 140)}` : ''}`,
    );
  }
  lines.push(...more(failures.events.items.length, MAX_LINES, 'events'));

  const spend = data.spend;
  const providers = providerText(spend.window.byProvider);
  const roles = roleText(spend.window.byRole);
  // Named only when there is a cache to speak of, so a window of purely local
  // calls does not carry "(0 cached)" for no reason.
  const cached = spend.window.cachedInputTokens
    ? ` (${spend.window.cachedInputTokens} cached)`
    : '';
  lines.push(
    '',
    '## Spend',
    `- window: ${money(spend.window.usd)} across ${plural(spend.window.count, 'call')}${providers ? ` (${providers})` : ''}, ${spend.window.inputTokens} in${cached} / ${spend.window.outputTokens} out tokens`,
  );
  // Only when something is attributable. A window whose every record predates
  // migration 008 would otherwise render a single "unattributed" group, which
  // says nothing the call count has not already said.
  if (roles && Object.keys(spend.window.byRole).some((role) => role !== UNATTRIBUTED_ROLE))
    lines.push(`- by role: ${roles}`);
  lines.push(
    `- today ${localDateText(spend.day.date)} (${spend.day.timeZone}): ${money(spend.day.spentUsd)} of the ${money(spend.day.ceilingUsd)} ceiling, ${spend.day.state}, ${money(spend.day.remainingUsd)} remaining`,
    `- unmetered: ${unmeteredText(spend.unmetered)}`,
  );
  if (spend.budget) {
    const b = spend.budget;
    lines.push(
      `- monthly budget: ${money(b.monthlyUsd - b.remainingUsd)} of ${money(b.monthlyUsd)} spent before today, ${money(b.remainingUsd)} left over ${plural(b.daysLeft, 'day')} to ${localDateText(b.periodNext)}; an even share is ${money(b.paceUsd)} a day, so today's cap is ${money(spend.day.ceilingUsd)} (set by ${LIMITED_BY_TEXT[b.limitedBy]})`,
    );
  }
  // Said only once the threshold is reached. A running "12 of 50" on every
  // digest for weeks would be noise, and the point of the number is that
  // nothing need be done until it is met.
  if (spend.roleEstimates.due) {
    const perRole = Object.entries(spend.roleEstimates.byRole)
      .sort(([aName, a], [bName, b]) => b - a || aName.localeCompare(bName))
      .map(([role, calls]) => `${role} ${plural(calls, 'call')}`)
      .join(', ');
    lines.push(
      `- ROLE_ESTIMATES_USD is due a correction (ADR-034): ${spend.roleEstimates.meteredCalls} metered calls on record, threshold ${spend.roleEstimates.threshold}${perRole ? ` (${perRole})` : ''}`,
    );
  }

  const escalations = data.escalations;
  lines.push(
    '',
    `## Escalations: ${escalations.total} recorded (${escalations.sent} sent, ${escalations.failed} failed, ${escalations.pending} pending)`,
  );
  for (const entry of escalations.byKind) {
    const channels = Object.entries(entry.channels)
      .map(
        ([channel, statuses]) =>
          `${channel} ${Object.entries(statuses)
            .map(([status, n]) => `${status} ${n}`)
            .join('/')}`,
      )
      .join(', ');
    lines.push(`- ${entry.kind}: ${channels}`);
  }
  for (const item of escalations.outstanding.slice(0, MAX_LINES)) {
    lines.push(
      `- outstanding: ${item.kind} on ${item.channel} ${item.status} at ${formatOccurredAt(item.createdAt, tz)}${item.runId ? ` (run ${short(item.runId)})` : ''}${item.error ? `: ${clip(item.error, 120)}` : ''}`,
    );
  }
  lines.push(...more(escalations.outstanding.length, MAX_LINES, 'outstanding'));

  const guards = data.guards;
  lines.push(
    '',
    `## Guard events: ${guards.total}${guards.total ? ` (${countsText(guards.counts)})` : ''}`,
  );
  for (const event of guards.items.slice(0, MAX_LINES)) {
    lines.push(
      `- ${event.type} run ${short(event.runId)} ${formatOccurredAt(event.createdAt, tz)}${event.detail ? `: ${clip(event.detail, 140)}` : ''}`,
    );
  }
  lines.push(...more(guards.items.length, MAX_LINES, 'guard events'));

  // Only when something failed over: a healthy machine's digest is unchanged. The work still
  // completed on the other provider, which is why a failing primary can look like a cheap system.
  const failover = data.failover;
  if (failover.total) {
    lines.push(
      '',
      `## Provider failover: ${plural(failover.total, 'stage')} ran on another provider`,
    );
    for (const item of failover.items.slice(0, MAX_LINES)) {
      lines.push(
        `- ${item.from} failed over to ${item.to} ${plural(item.count, 'time')}, last ${formatOccurredAt(item.lastAt, tz)}${item.lastReason ? `: ${clip(item.lastReason, 200)}` : ''}`,
      );
    }
    lines.push(...more(failover.items.length, MAX_LINES, 'failover directions'));
  }

  const waiting = data.waiting;
  lines.push(
    '',
    `## Waiting on you: ${plural(waiting.approvals.length, 'approval')}, ${plural(waiting.blockers.length, 'blocker')}`,
  );
  for (const approval of waiting.approvals.slice(0, MAX_LINES)) {
    const expiry = approval.expired
      ? `expired ${formatAge(nowMs - Date.parse(approval.expiresAt))} ago`
      : `expires in ${formatAge(Date.parse(approval.expiresAt) - nowMs)}`;
    lines.push(
      `- approval ${approval.actionClass} on run ${short(approval.runId)}, ${expiry}: ${clip(approval.action, 120)}`,
    );
  }
  lines.push(...more(waiting.approvals.length, MAX_LINES, 'approvals'));
  for (const blocker of waiting.blockers.slice(0, MAX_LINES)) {
    lines.push(
      `- blocker ${blocker.classification} on run ${short(blocker.runId)} / ${clip(blocker.task, 40)}: ${clip(blocker.smallestUnblockAction, 140)}`,
    );
  }
  lines.push(...more(waiting.blockers.length, MAX_LINES, 'blockers'));

  const tier0 = data.tier0;
  lines.push(
    '',
    `## Tier 0: ${plural(tier0.outcomes, 'outcome')} in ${plural(tier0.files, 'file')} (${tier0.merged.length} merged, ${tier0.deferred.length} deferred, ${tier0.escalated.length} escalated, ${tier0.other} other)`,
  );
  if (tier0.merged.length) lines.push(`- merged: ${prList(tier0.merged)}`);
  if (tier0.deferred.length) lines.push(`- deferred: ${prList(tier0.deferred)}`);
  if (tier0.escalated.length) lines.push(`- escalated: ${prList(tier0.escalated)}`);
  for (const item of tier0.unreadable) lines.push(`- unreadable: ${item}`);

  lines.push(
    '',
    '## Routing',
    `- routing: ${data.routing.note}; ${plural(data.routing.cloudCalls, 'cloud call')} / ${data.routing.unmeteredCalls} unmetered (subscription or local, ${UNMETERED_NOTE}) in the window`,
  );

  const weekly = data.weekly;
  if (weekly) {
    const cloud = weekly.cloud.byProvider
      .map((item) => `${item.provider} ${money(item.usd)} / ${plural(item.calls, 'call')}`)
      .join('; ');
    lines.push(
      '',
      `## Week in review: ${localDateText(weekly.fromDate)} -> ${localDateText(weekly.toDate)}${weekly.forced ? ' (asked for with --weekly)' : ''}`,
      `- cloud spend: ${money(weekly.cloud.usd)} across ${plural(weekly.cloud.calls, 'call')}${cloud ? ` (${cloud})` : ''}`,
      `- unmetered: ${unmeteredText(weekly.unmetered)}`,
      `- runs finished: ${weekly.runs.total} (${countsText(weekly.runs.counts, { order: ['completed', 'partially_completed', 'failed', 'cancelled'], words: true })})`,
      `- tier 0: ${weekly.tier0.merged} merged, ${weekly.tier0.deferred} deferred, ${weekly.tier0.escalated} escalated (${plural(weekly.tier0.outcomes, 'outcome')} in ${plural(weekly.tier0.files, 'file')}, ${weekly.tier0.other} other${weekly.tier0.unreadable ? `, ${weekly.tier0.unreadable} unreadable` : ''})`,
      weekly.ceilingDays.length
        ? `- ceiling reached on ${plural(weekly.ceilingDays.length, 'day')}: ${weekly.ceilingDays.map(localDateText).join(', ')}`
        : '- ceiling reached on no day',
    );
  }

  // Scheduled tasks, immediately before the footer, and ONLY when something is wrong.
  // A healthy machine's digest is unchanged by this section, which is the whole point:
  // the three supervised services sit at 0x800710E0 permanently by design, so a section
  // that spoke up every day would be noise and would soon be ignored - see
  // HEALTHY_TASK_RESULTS in runtime.ts for why those codes are not failures.
  const needsAttention = tasksNeedingAttention(data.tasks);
  if (needsAttention.length || data.tasks.error) {
    lines.push('', `## Scheduled tasks wanting attention: ${needsAttention.length}`);
    for (const task of needsAttention) {
      const reason = taskAttentionReason(task) ?? 'unknown';
      const detail = task.registered
        ? `${task.state}, last run ${task.lastRunTime ?? 'never'}${task.missedRuns ? `, ${plural(task.missedRuns, 'missed run')}` : ''}`
        : 'a register-*.ps1 under scripts/ creates it';
      lines.push(`- ${task.name}: ${reason} (${detail})`);
    }
    if (data.tasks.error) lines.push(`- could not read the scheduled tasks: ${data.tasks.error}`);
  }

  lines.push(
    '',
    '---',
    `Health: coordinator ${data.health.coordinator}; halt file ${data.health.halted ? 'PRESENT' : 'absent'} (${data.health.haltFile})`,
  );
  return lines.join('\n');
}

/**
 * The tasks wanting attention, in the order asked about. One function, so the markdown
 * section, the compact line and the escalation can never disagree about what counts as
 * wrong - disagreement between a report and its own alarm is how a monitor starts lying.
 */
export function tasksNeedingAttention(tasks: TaskHealth): TaskHealthRow[] {
  return tasks.rows.filter((row) => taskNeedsAttention(row));
}

/** How many reminders the compact head shows before "+N more". */
const COMPACT_REMINDERS = 3;

/**
 * Title plus six lines: the whole digest at a glance, at the top of the email
 * and the outbox file so the first screen answers "anything for me?" before
 * the sections. It is not sent to the phone: a digest is info (ADR-023). A
 * seventh line carries the reminders when there are any, and an eighth the
 * week in review when the digest has one.
 */
export function renderCompact(data: DigestData): string {
  const f = data.runs.finished.counts;
  const spend = data.spend;
  const tier0 = data.tier0;
  const failures =
    data.failures.attempts.length +
    Object.values(data.failures.events.counts).reduce((sum, n) => sum + n, 0);
  const lines = [
    digestTitle(data.window),
    `runs: ${data.runs.finished.total} finished (${f.completed ?? 0} completed, ${f.partially_completed ?? 0} partial, ${f.failed ?? 0} failed, ${f.cancelled ?? 0} cancelled), ${data.runs.active.total} active, ${data.runs.blocked.runs.length} blocked`,
    `spend: ${money(spend.window.usd)} in window; today ${money(spend.day.spentUsd)} of ${money(spend.day.ceilingUsd)} (${spend.day.state})`,
    `waiting on you: ${plural(data.waiting.approvals.length, 'approval')}, ${plural(data.waiting.blockers.length, 'blocker')}`,
    `escalations: ${data.escalations.sent} sent, ${data.escalations.failed} failed, ${data.escalations.pending} pending; guards: ${data.guards.total}${data.failover.total ? `; provider failover: ${data.failover.total}` : ''}`,
    `tier0: ${tier0.merged.length} merged, ${tier0.deferred.length} deferred, ${tier0.escalated.length} escalated; failures: ${failures}`,
    `health: coordinator ${data.health.coordinator}; halt file ${data.health.halted ? 'PRESENT' : 'absent'}`,
  ];
  const reminders = data.reminders.items;
  if (reminders.length) {
    const shown = reminders.slice(0, COMPACT_REMINDERS).map((item) => clip(item.text, 60));
    const rest = reminders.length - shown.length;
    lines.push(`reminders: ${shown.join('; ')}${rest ? `; +${rest} more` : ''}`);
  }
  const attention = tasksNeedingAttention(data.tasks);
  if (attention.length || data.tasks.error) {
    const shown = attention
      .slice(0, COMPACT_REMINDERS)
      .map((task) => `${task.name} (${taskAttentionReason(task) ?? 'unknown'})`);
    const rest = attention.length - shown.length;
    lines.push(
      `tasks wanting attention: ${shown.join('; ') || 'none'}${rest ? `; +${rest} more` : ''}${
        data.tasks.error ? `; read failed: ${clip(data.tasks.error, 60)}` : ''
      }`,
    );
  }
  const weekly = data.weekly;
  if (weekly) {
    const unmetered = weekly.unmetered.reduce((sum, item) => sum + item.calls, 0);
    lines.push(
      `week to ${localDateText(weekly.toDate)}: cloud ${money(weekly.cloud.usd)} in ${plural(weekly.cloud.calls, 'call')}, ${unmetered} unmetered at $0, ${plural(weekly.runs.total, 'run')} finished, tier0 ${weekly.tier0.merged} merged/${weekly.tier0.deferred} deferred/${weekly.tier0.escalated} escalated, ceiling reached on ${plural(weekly.ceilingDays.length, 'day')}`,
    );
  }
  return lines.join('\n');
}

export function renderDigest(data: DigestData): RenderedDigest {
  return {
    title: digestTitle(data.window),
    compact: renderCompact(data),
    markdown: renderMarkdown(data),
  };
}

/** The dedupe key: one morning and one evening per local day; ad hoc windows carry the time. */
export function digestDedupeKey(window: DigestWindow): string {
  if (window.name === 'morning' || window.name === 'evening')
    return `digest:${window.name}:${window.localDate}`;
  const at = formatOccurredAt(window.to, window.timeZone).slice(11, 16).replace(':', '');
  return `digest:${window.name}:${window.localDate}T${at}`;
}

export function digestEscalation(data: DigestData, rendered: RenderedDigest): Escalation {
  const waiting = data.waiting.approvals.length + data.waiting.blockers.length;
  const compactBody = rendered.compact.split('\n').slice(1).join('\n');
  const recommendation =
    waiting > 0
      ? `${plural(waiting, 'item is', 'items are')} waiting on you; see "Waiting on you".`
      : data.spend.day.state === 'exceeded'
        ? 'Nothing is waiting on you. The day is over the cloud ceiling, so runs route to local models until the next local day.'
        : 'Nothing is waiting on you.';
  return {
    kind: 'digest',
    title: rendered.title,
    what: `${compactBody}\n\n${rendered.markdown}`,
    options:
      waiting > 0
        ? [
            {
              label: 'Decide the pending approvals and blockers',
              consequence: 'The runs waiting on them continue; nothing else changes.',
            },
          ]
        : [],
    evidence: [
      `window ${data.window.from} -> ${data.window.to} (${data.window.timeZone})`,
      `${data.runs.finished.total} finished, ${data.runs.active.total} active, ${data.runs.blocked.runs.length} blocked; ${data.escalations.total} notifications; ${data.guards.total} guard events`,
      `tier0 outcomes read from ${data.tier0.directory}`,
      `pnpm forge digest --window=${data.window.name}${data.weekly?.forced ? ' --weekly' : ''} on ${hostname()}`,
    ],
    recommendation,
    paused: false,
    severity: 'info',
    dedupeKey: digestDedupeKey(data.window),
    occurredAt: data.generatedAt,
  };
}

// --- The command -----------------------------------------------------------

/** No `ha`: a digest is info and info never reaches the phone (ADR-023). */
const SELECTIONS = ['email', 'file', 'all'] as const;
type Selection = (typeof SELECTIONS)[number];

const openPostgres: OpenDigestSource = async (databaseUrl) => {
  const sql = createDatabase(databaseUrl);
  return { source: new PostgresForgeRepository(sql), close: () => sql.end() };
};

async function probeCoordinator(ctx: CommandContext): Promise<string> {
  const apiUrl = ctx.env.FORGE_API_URL;
  if (!apiUrl || !ctx.env.FORGE_COORDINATOR_TOKEN)
    return 'not checked (FORGE_API_URL and FORGE_COORDINATOR_TOKEN unset)';
  const base = apiUrl.replace(/\/+$/, '');
  try {
    const response = await ctx.fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    let status: unknown;
    try {
      status = (JSON.parse(text) as { status?: unknown }).status;
    } catch {
      // Not JSON; the HTTP status is the answer.
    }
    return response.ok
      ? `reachable at ${base} (${typeof status === 'string' ? status : `HTTP ${response.status}`})`
      : `answered HTTP ${response.status} at ${base}`;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    const message = error instanceof Error ? error.message : String(error);
    return `unreachable at ${base} (${cause ? `${message}: ${cause}` : message})`;
  }
}

export type DigestCommandOptions = {
  open?: OpenDigestSource;
  /** Injectable clock, so a test can place "now" on either side of a window edge. */
  now?: () => Date;
  /**
   * PowerShell runner for the scheduled-task health read, so the digest can be
   * exercised without Task Scheduler. Mirrors `RuntimeOptions.pwsh`.
   */
  pwsh?: PwshRunner;
};

export function createDigestCommand(options: DigestCommandOptions = {}): Command {
  const open = options.open ?? openPostgres;
  const clock = options.now ?? (() => new Date());
  return {
    name: 'digest',
    describe:
      'Send the morning (previous day 17:30 -> now) or evening (05:00 -> now) digest of runs, spend, escalations and decisions',
    usage:
      '[--window=morning|evening|now] [--since=<iso>] [--weekly] [--dry-run] [--json] [--channel=email|file|all]',
    async run(argv, ctx) {
      const { flags } = parseArgs(argv);
      const fail = (message: string): number => {
        ctx.stderr(`forge digest: ${message}`);
        return 2;
      };
      const rawWindow = flags.get('window');
      const since = flags.get('since');
      const weekly = flags.get('weekly');
      if (weekly !== undefined && weekly !== true)
        return fail('--weekly takes no value; it forces the week in review for any window');
      if (rawWindow === true) return fail('--window needs a value: morning, evening or now');
      if (since === true)
        return fail('--since needs an ISO 8601 timestamp, e.g. --since=2026-09-25T07:30:00Z');
      if (flags.has('now') && (rawWindow || since))
        return fail('--now excludes --window and --since');
      if (rawWindow && since) return fail('--window and --since exclude each other');
      if (rawWindow && !['morning', 'evening', 'now'].includes(rawWindow))
        return fail(`--window must be morning, evening or now, not '${rawWindow}'`);
      const rawChannel = flags.get('channel') ?? 'all';
      if (rawChannel === 'ha')
        return fail(
          'a digest is info and never reaches the phone (severity routing, ADR-023); --channel must be email, file or all',
        );
      if (rawChannel === true || !(SELECTIONS as readonly string[]).includes(rawChannel))
        return fail('--channel must be one of email, file or all');
      const selection = rawChannel as Selection;
      const dryRun = flags.has('dry-run');
      const json = flags.has('json');

      const timeZone = ctx.env.FORGE_TIMEZONE || DEFAULT_TIME_ZONE;
      if (!isValidTimeZone(timeZone))
        return fail(`FORGE_TIMEZONE '${timeZone}' is not an IANA zone`);
      let ceiling: CeilingConfig;
      let budget: BudgetConfig | undefined;
      try {
        ceiling = ceilingConfigFromValues({
          dailyUsd: ctx.env.FORGE_DAILY_CEILING_USD,
          warnAtFraction: ctx.env.FORGE_CEILING_WARN_FRACTION,
        });
        budget = budgetConfigFromValues({
          monthlyUsd: ctx.env.FORGE_MONTHLY_BUDGET_USD,
          resetDay: ctx.env.FORGE_BUDGET_RESET_DAY,
          maxDailyUsd: ctx.env.FORGE_MAX_DAILY_CEILING_USD,
          countFrom: ctx.env.FORGE_BUDGET_COUNT_FROM,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const databaseUrl = ctx.env.DATABASE_URL;
      if (!databaseUrl)
        return fail('DATABASE_URL is not set (pnpm forge loads .env from the repository root)');

      const now = clock();
      let window: DigestWindow;
      if (since) {
        const parsed = new Date(since);
        if (Number.isNaN(parsed.getTime())) return fail(`--since '${since}' is not a timestamp`);
        if (parsed.getTime() >= now.getTime()) return fail(`--since '${since}' is not in the past`);
        window = sinceWindow(parsed, now, timeZone);
      } else {
        const name = flags.has('now')
          ? 'now'
          : ((rawWindow as 'morning' | 'evening' | 'now' | undefined) ??
            defaultWindowName(now, timeZone));
        window = digestWindow(name, now, timeZone);
      }

      const config = notifyConfigFromEnv(ctx.env);
      // Like notify-test: a named channel that cannot be built is a refusal.
      // Home Assistant is not mentioned either way: a digest never goes there.
      const missing: string[] = [];
      if (!config.smtp.configured && (selection === 'email' || selection === 'all'))
        missing.push(`email: missing ${config.smtp.missing.join(', ')}`);
      if (missing.length && selection !== 'all')
        return fail(`refusing to send; ${missing.join('; ')} (add them to .env)`);
      // The phone channel is still built when configured, so the report shows
      // it as skipped by severity routing rather than leaving it unexplained.
      const only: ChannelSelection[] | undefined = selection === 'all' ? undefined : [selection];

      const halt = await readHaltFile(haltFilePath(ctx.env));
      const health: DigestData['health'] = {
        coordinator: await probeCoordinator(ctx),
        haltFile: halt.path,
        halted: halt.exists,
      };
      // Side-effecting, like the coordinator probe above, so it happens here rather
      // than inside `collectDigest`. `readTaskHealth` never throws - a failure comes
      // back as its `error` field - because a broken task monitor must not break the
      // report that is supposed to tell someone about it.
      const pwsh = options.pwsh ?? createPwshRunner(ctx.env);
      const tasks = await readTaskHealth(pwsh, watchedTaskNames(ctx.env));

      let data: DigestData;
      const { source, close } = await open(databaseUrl);
      try {
        data = await collectDigest(source, {
          window,
          now,
          ceiling,
          budget,
          outboxDir: config.outboxDir,
          remindersFile: remindersFilePath(ctx.env, config.outboxDir),
          ...(weekly === true ? { weekly: true } : {}),
          health,
          tasks,
        });
      } catch (error) {
        // Say something useful even when the error has no message. On 04/10/2026 this
        // printed exactly "could not read the database: " - an empty reason - because a
        // connection error surfaced with an empty `message`, so the log named the
        // failure and not one fact about it. Name, message and cause, whichever exist.
        ctx.stderr(`forge digest: could not read the database: ${describeError(error)}`);
        return 1;
      } finally {
        await close();
      }
      const rendered = renderDigest(data);
      const escalation = digestEscalation(data, rendered);

      if (dryRun) {
        // The channels the send would reach, after severity routing, so the
        // dry run answers the same question the real run would.
        const routes = channelsForSeverity(
          escalation.severity,
          channelsFromConfig(config, only ? { only } : {}),
        );
        const channels = routes.routed.map((channel) => channel.name);
        const skipped = routes.skipped.map((channel) => channel.name);
        if (json) {
          ctx.stdout(JSON.stringify({ ...data, rendered, dryRun: true, channels, skipped }));
        } else {
          for (const line of rendered.markdown.split('\n')) ctx.stdout(line);
          ctx.stdout('');
          for (const line of rendered.compact.split('\n')) ctx.stdout(line);
          ctx.stdout('');
          if (skipped.length)
            ctx.stdout(
              `dry run: ${skipped.join(', ')} would be skipped (severity routing: a digest is info and never reaches the phone)`,
            );
          ctx.stdout(
            `dry run: nothing sent; subject would be "Forge: ${rendered.title}" on ${channels.join(', ') || 'no channel'} (key ${escalation.dedupeKey})`,
          );
          const previewState = await readTaskHealthState(taskHealthStatePath(config.outboxDir));
          const previewDue = dueForEscalation(
            repeatedFailures(tasks, previewState),
            previewState,
            window.localDate,
          );
          ctx.stdout(
            previewState
              ? `dry run: ${previewDue.length} task escalation(s) would be sent at warn${previewDue.length ? `: ${previewDue.map((f) => f.task.name).join(', ')}` : ''}`
              : 'dry run: no previous task observation, so this run would seed silently',
          );
        }
        return 0;
      }

      for (const line of missing) ctx.stderr(`digest: skipping ${line}`);
      const nowMs = () => now.getTime();
      const notifier = new Notifier({
        channels: channelsFromConfig(config, {
          fetch: ctx.fetch,
          ...(only ? { only } : {}),
          now: nowMs,
          timeZone,
        }),
        outboxDir: config.outboxDir,
        secrets: config.secrets,
        timeZone,
        log: (line) => ctx.stderr(line),
        now: nowMs,
      });
      let report: NotifierReport;
      const taskNotes: string[] = [];
      try {
        report = await notifier.notify(escalation);

        // The digest itself is info and never reaches the phone (ADR-023), so a failing
        // task is escalated separately at warn. Sent AFTER the digest so a failure here
        // can never cost the digest, and inside the same try so the notifier is closed
        // once in the finally below.
        const statePath = taskHealthStatePath(config.outboxDir);
        const previousState = await readTaskHealthState(statePath);
        const localDay = window.localDate;
        const due = dueForEscalation(
          repeatedFailures(tasks, previousState),
          previousState,
          localDay,
        );
        const escalatedOn: Record<string, string> = { ...(previousState?.escalatedOn ?? {}) };
        for (const failure of due) {
          try {
            const sent = await notifier.notify(
              taskFailingEscalation(failure, localDay, now.toISOString()),
            );
            escalatedOn[failure.task.name] = localDay;
            taskNotes.push(`task ${failure.task.name}: ${formatReport(sent)}`);
          } catch (error) {
            // One task's alarm failing must not stop the next one, nor the state write.
            taskNotes.push(
              `task ${failure.task.name}: could not send (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
        const snapshot = taskHealthSnapshot(tasks, now.toISOString());
        try {
          await writeTaskHealthState(statePath, { ...snapshot, escalatedOn });
          if (!previousState)
            taskNotes.push(
              `tasks: first observation of ${tasks.rows.length} task(s), nothing escalated`,
            );
        } catch (error) {
          // Without state the next run cannot tell a repeat from a first failure, so it
          // will stay quiet rather than shout. Say so rather than failing the digest.
          taskNotes.push(
            `tasks: could not write ${statePath} (${error instanceof Error ? error.message : String(error)}); the next run will seed again`,
          );
        }
      } finally {
        await notifier.close();
      }
      const failed =
        report.outcome === 'failed' || report.channels.some((c) => c.status === 'failed');
      if (json) {
        ctx.stdout(JSON.stringify({ ...data, rendered, dryRun: false, delivery: report }));
      } else {
        for (const line of rendered.compact.split('\n')) ctx.stdout(line);
        ctx.stdout(`outbox: ${config.outboxDir}`);
        ctx.stdout(`channels: ${notifier.channelNames.join(', ') || 'none'}`);
        ctx.stdout(`subject: ${report.rendered?.subject ?? '(not rendered)'}`);
        ctx.stdout(`result: ${formatReport(report)}`);
        for (const note of taskNotes) ctx.stdout(note);
      }
      return failed ? 1 : 0;
    },
  };
}

export const digestCommand: Command = createDigestCommand();
