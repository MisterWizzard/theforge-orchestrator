import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RunSchema,
  UNATTRIBUTED_ROLE,
  type Run,
  type Task,
  type UsageRecord,
} from '@theforge/contracts';
import { createDatabase, PostgresForgeRepository } from '@theforge/db';
import type { CommandContext } from './command.js';
import type { PwshRunner } from './commands/runtime.js';
import {
  createDigestCommand,
  defaultWindowName,
  describeError,
  digestDedupeKey,
  digestWindow,
  isMonday,
  parseReminders,
  remindersFilePath,
  renderMarkdown,
  unmeteredKind,
  weekRange,
  weeklyDue,
  zonedTime,
  type DigestData,
  type DigestSource,
  type OpenDigestSource,
} from './commands/digest.js';
import { createRegistry } from './registry.js';

/**
 * The digest against a real PostgreSQL (this file has its own schema): runs on
 * both sides of the morning window edge, blockers, approvals, usage incl. a
 * $0 Codex call, notifications, a guard event and a Tier 0 outcomes file.
 * The window maths need no database and run everywhere.
 */
const TZ = 'Australia/Sydney';
/** 05:00 on 26/09/2026 in Sydney (AEST, UTC+10): when the morning digest runs. */
const NOW = new Date('2026-09-25T19:00:00.000Z');
const MORNING_FROM = '2026-09-25T07:30:00.000Z';

type Harness = {
  out: string[];
  err: string[];
  run: (argv: string[]) => Promise<number>;
};

/**
 * A PowerShell that reports every task asked about as healthy. Without this the digest
 * would read the real Task Scheduler during tests - the machine's own tasks would decide
 * whether assertions passed, and a failing task on the developer's box would fail the
 * suite. It answers for exactly the names the script asked for, so a missing row never
 * shows up as "not registered".
 */
export function fakeHealthyPwsh(): PwshRunner {
  return async (script: string) => {
    const names = [...script.matchAll(/'((?:[^']|'')*)'/g)]
      .map((match) => match[1]?.replace(/''/g, "'") ?? '')
      .filter((name) => name.startsWith('TheForge') || name.startsWith('Operations'));
    const rows = names.map((name) => ({
      name,
      registered: true,
      state: 'Ready',
      enabled: true,
      lastRunTime: '2026-09-26T05:00:01.0000000+10:00',
      nextRunTime: '2026-09-26T17:30:00.0000000+10:00',
      lastTaskResult: 0,
      missedRuns: 0,
    }));
    return { code: 0, stdout: `${JSON.stringify(rows)}\r\n`, stderr: '' };
  };
}

function harness(
  env: Record<string, string | undefined>,
  options: { now?: Date; open?: OpenDigestSource; pwsh?: PwshRunner } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: () => {
      throw new Error('the digest must not reach for the network without coordinator credentials');
    },
  };
  const command = createDigestCommand({
    now: () => options.now ?? NOW,
    ...(options.open ? { open: options.open } : {}),
    pwsh: options.pwsh ?? fakeHealthyPwsh(),
  });
  return { out, err, run: (argv) => createRegistry([command]).run(['digest', ...argv], ctx) };
}

describe('why a call cost nothing (ADR-021, ADR-041)', () => {
  it('calls Codex and the Claude subscription lane subscriptions, and ollama local', () => {
    expect(unmeteredKind('codex')).toBe('subscription');
    expect(unmeteredKind('claude-sub')).toBe('subscription');
    expect(unmeteredKind('ollama')).toBe('local');
  });

  it('does not label the metered API lane, or an unknown provider, as anything', () => {
    // A $0 record on the API lane is not a subscription call; it stays a plain "$0".
    expect(unmeteredKind('claude')).toBe('$0');
    expect(unmeteredKind('something-else')).toBe('$0');
  });
});

describe('digest windows in Australia/Sydney', () => {
  it('places 17:30 and 05:00 local on the right instants, daylight saving included', () => {
    expect(zonedTime('2026-09-26', 17, 30, TZ).toISOString()).toBe('2026-09-26T07:30:00.000Z');
    // Daylight saving starts 04/10/2026 at 02:00 AEST; the same wall time is an hour earlier in UTC.
    expect(zonedTime('2026-10-03', 17, 30, TZ).toISOString()).toBe('2026-10-03T07:30:00.000Z');
    expect(zonedTime('2026-10-04', 17, 30, TZ).toISOString()).toBe('2026-10-04T06:30:00.000Z');
    expect(zonedTime('2026-10-04', 5, 0, TZ).toISOString()).toBe('2026-10-03T18:00:00.000Z');
  });

  it('morning is the previous local day 17:30 -> now, evening is today 05:00 -> now', () => {
    const morning = digestWindow('morning', NOW, TZ);
    expect(morning).toEqual({
      name: 'morning',
      from: MORNING_FROM,
      to: NOW.toISOString(),
      timeZone: TZ,
      localDate: '2026-09-26',
    });
    const evening = digestWindow('evening', new Date('2026-09-26T07:30:00.000Z'), TZ);
    expect(evening.from).toBe('2026-09-25T19:00:00.000Z');
    expect(evening.localDate).toBe('2026-09-26');
    // Run before 05:00 the evening window reaches back to yesterday's 05:00.
    expect(digestWindow('evening', new Date('2026-09-25T16:00:00.000Z'), TZ).from).toBe(
      '2026-09-24T19:00:00.000Z',
    );
    // Across the daylight-saving change: 05:00 AEDT on 05/10 back to 17:30 AEDT on 04/10.
    expect(digestWindow('morning', new Date('2026-10-04T18:00:00.000Z'), TZ).from).toBe(
      '2026-10-04T06:30:00.000Z',
    );
    // The morning of the change itself: 17:30 was still AEST.
    expect(digestWindow('morning', new Date('2026-10-03T18:00:00.000Z'), TZ).from).toBe(
      '2026-10-03T07:30:00.000Z',
    );
    const now = digestWindow('now', NOW, TZ);
    expect(now.from).toBe('2026-09-25T07:00:00.000Z');
  });

  it('defaults to the digest that is due and keys one morning and one evening per local day', () => {
    expect(defaultWindowName(NOW, TZ)).toBe('morning');
    expect(defaultWindowName(new Date('2026-09-26T07:30:00.000Z'), TZ)).toBe('evening');
    expect(digestDedupeKey(digestWindow('morning', NOW, TZ))).toBe('digest:morning:2026-09-26');
    expect(digestDedupeKey(digestWindow('now', NOW, TZ))).toBe('digest:now:2026-09-26T0500');
  });

  it('knows a Monday and covers the previous seven local days for the week in review', () => {
    expect(isMonday('2026-09-28')).toBe(true);
    expect(isMonday('2026-09-26')).toBe(false); // Saturday
    expect(isMonday('2026-09-27')).toBe(false); // Sunday
    // Monday 28/09 looks back at Monday 21/09 00:00 -> Monday 28/09 00:00, AEST both ends.
    expect(weekRange('2026-09-28', TZ)).toEqual({
      from: '2026-09-20T14:00:00.000Z',
      to: '2026-09-27T14:00:00.000Z',
      fromDate: '2026-09-21',
      toDate: '2026-09-27',
    });
    // Across the daylight-saving change the two midnights are in different offsets.
    expect(weekRange('2026-10-05', TZ)).toEqual({
      from: '2026-09-27T14:00:00.000Z',
      to: '2026-10-04T13:00:00.000Z',
      fromDate: '2026-09-28',
      toDate: '2026-10-04',
    });
    // Due on a Monday morning, on any window when forced, and otherwise not.
    const monday = new Date('2026-09-27T19:00:00.000Z'); // 28/09 05:00 AEST
    expect(weeklyDue(digestWindow('morning', monday, TZ), false)).toBe(true);
    expect(weeklyDue(digestWindow('evening', monday, TZ), false)).toBe(false);
    expect(weeklyDue(digestWindow('morning', NOW, TZ), false)).toBe(false);
    expect(weeklyDue(digestWindow('evening', NOW, TZ), true)).toBe(true);
    expect(weeklyDue(digestWindow('now', NOW, TZ), true)).toBe(true);
  });
});

describe('reminders file', () => {
  it('reads one reminder per line, skips comments and blanks, and gates dated lines on the local day', () => {
    const text = [
      '# Operator reminders: one per line; YYYY-MM-DD at the start = show from that day',
      '',
      'Rotate the staging token before the 30th',
      '2026-09-01 Check the Tier 0 dry-run log',
      '2026-09-26 Due today: rotate the HA token',
      '2026-09-27 Not yet: tomorrow',
      '2026-10-04\tDaylight saving starts; check the 05:00 digest still arrives at 05:00',
      '   Indented, with surrounding spaces   ',
      '2026-09-20',
      '   # an indented comment',
      '2026-09-26: a colon is not a date prefix',
    ].join('\r\n');
    expect(parseReminders(text, '2026-09-26')).toEqual({
      items: [
        { text: 'Rotate the staging token before the 30th' },
        { text: 'Check the Tier 0 dry-run log', from: '2026-09-01' },
        { text: 'Due today: rotate the HA token', from: '2026-09-26' },
        { text: 'Indented, with surrounding spaces' },
        { text: '2026-09-26: a colon is not a date prefix' },
      ],
      upcoming: 2,
    });
    // The next day the 27/09 line is due and only the October one is still ahead.
    const later = parseReminders(text, '2026-09-27');
    expect(later.items.map((item) => item.text)).toContain('Not yet: tomorrow');
    expect(later.upcoming).toBe(1);
    expect(parseReminders('', '2026-09-26')).toEqual({ items: [], upcoming: 0 });
    expect(parseReminders('# only comments\n\n', '2026-09-26')).toEqual({
      items: [],
      upcoming: 0,
    });
  });

  it('lives beside the outbox unless FORGE_REMINDERS_FILE says otherwise', () => {
    expect(remindersFilePath({}, join('C:', 'outbox'))).toBe(join('C:', 'outbox', 'reminders.md'));
    expect(remindersFilePath({ FORGE_REMINDERS_FILE: '  ' }, join('C:', 'outbox'))).toBe(
      join('C:', 'outbox', 'reminders.md'),
    );
    const explicit = join(tmpdir(), 'notes.txt');
    expect(remindersFilePath({ FORGE_REMINDERS_FILE: explicit }, 'unused')).toBe(explicit);
  });
});

describe('digest arguments', () => {
  const noOpen: OpenDigestSource = async () => {
    throw new Error('the database must not be opened');
  };
  const env = { DATABASE_URL: 'postgres://fake', FORGE_OUTBOX_DIR: 'unused' };

  it('rejects a bad window, a bad --since, and clashing selectors before opening the database', async () => {
    for (const [argv, message] of [
      [['--window=weekly'], '--window must be morning, evening or now'],
      [['--window'], '--window needs a value'],
      [['--since=yesterday'], "--since 'yesterday' is not a timestamp"],
      [['--since=2099-01-01T00:00:00Z'], 'is not in the past'],
      [['--window=morning', '--since=2026-09-01T00:00:00Z'], 'exclude each other'],
      [['--now', '--window=morning'], '--now excludes'],
      [['--channel=pigeon'], '--channel must be one of email, file or all'],
      [
        ['--channel=ha'],
        'a digest is info and never reaches the phone (severity routing, ADR-023); --channel must be email, file or all',
      ],
      [['--weekly=yes'], '--weekly takes no value'],
    ] as Array<[string[], string]>) {
      const { run, err } = harness(env, { open: noOpen });
      expect(await run(argv), argv.join(' ')).toBe(2);
      expect(err[0], argv.join(' ')).toContain(message);
    }
  });

  it('refuses without DATABASE_URL, with a bad zone, and for a named channel that is not configured', async () => {
    const missing = harness({ FORGE_OUTBOX_DIR: 'unused' }, { open: noOpen });
    expect(await missing.run([])).toBe(2);
    expect(missing.err[0]).toContain('DATABASE_URL is not set');

    const zone = harness({ ...env, FORGE_TIMEZONE: 'Mars/Olympus' }, { open: noOpen });
    expect(await zone.run([])).toBe(2);
    expect(zone.err[0]).toContain("FORGE_TIMEZONE 'Mars/Olympus' is not an IANA zone");

    const email = harness(env, { open: noOpen });
    expect(await email.run(['--channel=email'])).toBe(2);
    expect(email.err[0]).toBe(
      'forge digest: refusing to send; email: missing FORGE_SMTP_USER, FORGE_SMTP_PASSWORD (add them to .env)',
    );
    // The phone is refused even when it is configured: a digest never goes there.
    const ha = harness(
      { ...env, FORGE_HA_URL: 'http://192.168.1.10/ha', FORGE_HA_TOKEN: 'test-token' },
      { open: noOpen },
    );
    expect(await ha.run(['--channel=ha'])).toBe(2);
    expect(ha.err[0]).toContain('never reaches the phone');
  });
});

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? createDatabase(databaseUrl) : undefined;
const repository = sql ? new PostgresForgeRepository(sql) : undefined;

const PROJECT = 'digest-project';

function run(id: string, state: Run['state'], updatedAt: string, extra: Partial<Run> = {}): Run {
  return RunSchema.parse({
    id,
    projectId: PROJECT,
    objective: `Objective of ${id}`,
    state,
    budget: { maxUsd: 10, maxTokens: 100_000 },
    spent: { usd: 0, tokens: 0 },
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  });
}

function task(id: string, runId: string, title: string): Task {
  return {
    id,
    runId,
    title,
    description: title,
    state: 'in_progress',
    priority: 1,
    dependencies: [],
    acceptanceCriteria: ['Tests pass'],
    requiredCapabilities: [],
    fileOwnership: [],
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T09:00:00.000Z',
  };
}

const tier0Record = (overrides: Record<string, unknown>) => ({
  repository: 'MisterWizzard/shopfront',
  number: 26,
  title: 'chore(deps): bump nanoid',
  author: 'dependabot[bot]',
  headSha: 'abcdef1234567890abcdef1234567890abcdef12',
  mode: 'execute',
  action: 'merge',
  reason: 'all checks passed',
  checks: [{ name: 'test', command: 'pnpm test', exitCode: 0 }],
  attempts: 1,
  merged: true,
  mergedAt: '2026-09-25T12:00:00.000Z',
  durationMs: 1000,
  tier0Commit: 'e8f7f47',
  ...overrides,
});

let directory: string;
let outbox: string;

beforeAll(async () => {
  const repo = repository;
  if (!repo) return;
  await repo.ensureProject({
    id: PROJECT,
    name: 'Digest fixture',
    repositoryUrl: 'https://example.invalid/digest',
  });
  // Ids are eight characters so the digest's short form is the whole id.
  await repo.putRun(
    run('donein01', 'completed', '2026-09-25T10:00:00.000Z', { spent: { usd: 1.25, tokens: 900 } }),
  );
  await repo.putRun(run('done1729', 'completed', '2026-09-25T07:29:00.000Z')); // 17:29 local: before the window
  await repo.putRun(run('done1731', 'completed', '2026-09-25T07:31:00.000Z')); // 17:31 local: inside it
  await repo.putRun(run('partial1', 'partially_completed', '2026-09-25T12:00:00.000Z'));
  await repo.putRun(run('failed01', 'failed', '2026-09-25T15:00:00.000Z'));
  await repo.putRun(run('cancold1', 'cancelled', '2026-09-24T12:00:00.000Z'));
  await repo.putRun(
    run('exec0001', 'executing', '2026-09-25T18:30:00.000Z', {
      createdAt: '2026-09-25T16:00:00.000Z',
    }),
  );
  await repo.putRun(
    run('paused01', 'paused', '2026-09-25T14:00:00.000Z', { resumeState: 'executing' }),
  );
  await repo.putRun(run('blocked1', 'blocked', '2026-09-25T13:00:00.000Z'));
  await repo.putRun(run('created1', 'created', '2026-09-25T18:00:00.000Z'));

  await repo.putTask(task('task-exec', 'exec0001', 'Write the migration'));
  await repo.putTask(task('task-blocked', 'blocked1', 'Choose the database'));
  await repo.upsertAttempt({
    id: 'attempt-failed',
    taskId: 'task-exec',
    provider: 'claude',
    state: 'failed',
    startedAt: '2026-09-25T17:00:00.000Z',
    finishedAt: '2026-09-25T17:20:00.000Z',
    error: { code: 'WORKER_JOB_FAILED', message: 'tests failed' },
  });
  await repo.upsertAttempt({
    id: 'attempt-old',
    taskId: 'task-exec',
    state: 'expired',
    startedAt: '2026-09-25T06:00:00.000Z',
    finishedAt: '2026-09-25T07:00:00.000Z',
  });
  await repo.upsertBlocker({
    id: 'blocker-decision',
    runId: 'blocked1',
    taskId: 'task-blocked',
    classification: 'product_decision',
    summary: 'Two storage options fit the acceptance criteria',
    evidence: [],
    impact: 'The task cannot start',
    attempts: [],
    smallestUnblockAction: 'Pick Postgres or SQLite',
    status: 'active',
  });
  await repo.putApproval({
    id: 'approval-pending',
    runId: 'exec0001',
    actionClass: 'amber',
    actionDigest: 'a'.repeat(64),
    normalizedAction: JSON.stringify({
      cwd: 'C:/repo',
      args: ['git', 'push', 'origin', 'forge/x'],
    }),
    scope: JSON.stringify({ repositoryUrl: 'https://example.invalid/digest', baseRef: 'main' }),
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1_000).toISOString(),
  });
  await repo.putApproval({
    id: 'approval-decided',
    runId: 'exec0001',
    actionClass: 'amber',
    actionDigest: 'b'.repeat(64),
    normalizedAction: '{"args":["git","push"]}',
    scope: '{}',
    status: 'approved',
    expiresAt: NOW.toISOString(),
    decidedAt: NOW.toISOString(),
  });

  const usage: Array<{
    id: string;
    provider: string;
    role?: UsageRecord['role'];
    at: string;
    usd: number;
  }> = [
    {
      id: 'usage-1',
      provider: 'claude',
      role: 'builder',
      at: '2026-09-25T10:00:00.000Z',
      usd: 1.5,
    },
    {
      id: 'usage-2',
      provider: 'claude',
      role: 'planner',
      at: '2026-09-25T18:00:00.000Z',
      usd: 0.75,
    },
    // Deliberately roleless, so the unattributed group is exercised alongside
    // the real ones rather than only in isolation.
    { id: 'usage-3', provider: 'codex', at: '2026-09-25T18:30:00.000Z', usd: 0 }, // unmetered
    { id: 'usage-4', provider: 'claude', role: 'reviewer', at: '2026-09-25T07:00:00.000Z', usd: 9 },
  ];
  for (const item of usage) {
    await repo.upsertUsageRecord({
      id: item.id,
      runId: 'exec0001',
      provider: item.provider,
      ...(item.role ? { role: item.role } : {}),
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      costUsd: item.usd,
      elapsedMs: 0,
      tools: [],
      createdAt: item.at,
    });
  }

  await repo.recordNotification({
    id: 'notification-1',
    runId: 'paused01',
    kind: 'spend.warn',
    dedupeKey: 'spend.warn:2026-09-25',
    channel: 'file',
    status: 'sent',
    payload: {},
    createdAt: '2026-09-25T14:00:00.000Z',
  });
  await repo.recordNotification({
    id: 'notification-2',
    runId: 'paused01',
    kind: 'spend.warn',
    dedupeKey: 'spend.warn:2026-09-25',
    channel: 'ha',
    status: 'failed',
    payload: {},
    lastError: { message: 'Home Assistant answered HTTP 401' },
    createdAt: '2026-09-25T14:00:00.000Z',
  });
  await repo.recordNotification({
    id: 'notification-3',
    kind: 'tier0.merge',
    dedupeKey: 'tier0:merge:old',
    channel: 'file',
    status: 'sent',
    payload: {},
    createdAt: '2026-09-25T07:00:00.000Z',
  });

  const events = [
    {
      id: 'event-guard',
      runId: 'paused01',
      type: 'run.paused_by_guard',
      payload: { guard: 'spend', reason: 'daily cloud ceiling of $20.00 reached' },
      createdAt: '2026-09-25T14:00:00.000Z',
    },
    {
      id: 'event-warn-old',
      runId: 'paused01',
      type: 'spend.warn',
      payload: { dayUsd: 15 },
      createdAt: '2026-09-25T07:00:00.000Z',
    },
    {
      id: 'event-lease',
      runId: 'exec0001',
      type: 'attempt.lease_expired',
      payload: { attemptId: 'attempt-failed', recoveredTo: 'ready' },
      createdAt: '2026-09-25T17:00:00.000Z',
    },
    // Claude failed and Codex ran the stage (ADR-024): the work completes, which is why the
    // digest has to say it. Two in the morning window, one days earlier.
    {
      id: 'event-failover-1',
      runId: 'exec0001',
      type: 'provider.fallback',
      payload: {
        role: 'planner',
        from: 'claude',
        to: 'codex',
        code: 'PROCESS_EXIT',
        message: 'API Error: 400 This API key is not scoped to a workspace',
        attempt: 1,
      },
      createdAt: '2026-09-25T12:00:00.000Z',
    },
    {
      id: 'event-failover-2',
      runId: 'exec0001',
      type: 'provider.fallback',
      payload: {
        role: 'critic',
        from: 'claude',
        to: 'codex',
        code: 'PROCESS_EXIT',
        message: 'API Error: 400 This API key is not scoped to a workspace',
        attempt: 1,
      },
      createdAt: '2026-09-25T12:30:00.000Z',
    },
    {
      id: 'event-failover-old',
      runId: 'exec0001',
      type: 'provider.fallback',
      payload: { role: 'planner', from: 'codex', to: 'claude', code: 'TIMEOUT', message: 'slow' },
      createdAt: '2026-09-20T02:00:00.000Z',
    },
    // Earlier in the week and outside every daily window: only the week in review sees it.
    {
      id: 'event-ceiling',
      runId: 'paused01',
      type: 'spend.ceiling',
      payload: { dayUsd: 20.5, ceilingUsd: 20, day: '2026-09-23', timeZone: TZ },
      createdAt: '2026-09-23T02:00:00.000Z',
    },
  ];
  for (const event of events) {
    await repo.appendEvent({ ...event, idempotencyKey: event.id });
  }
});
afterAll(async () => {
  await sql?.end();
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-digest-'));
  outbox = join(directory, 'outbox');
  await mkdir(join(outbox, 'tier0'), { recursive: true });
  await writeFile(
    join(outbox, 'tier0', '20260925T120000Z.json'),
    JSON.stringify([
      tier0Record({}),
      tier0Record({ number: 27, action: 'escalate', merged: false, reason: 'test failed' }),
      tier0Record({ number: 28, action: 'deferred', merged: false, reason: 'BEHIND' }),
    ]),
  );
  await writeFile(
    join(outbox, 'tier0', '20260925T070000Z.json'),
    JSON.stringify([tier0Record({ number: 20 })]),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

suite('digest against the database', () => {
  const env = () => ({
    DATABASE_URL: databaseUrl,
    FORGE_OUTBOX_DIR: outbox,
    FORGE_HALT_FILE: join(directory, 'FORGE_HALT'),
    FORGE_DAILY_CEILING_USD: '1',
  });

  it('renders every section from the morning window and sends nothing on --dry-run', async () => {
    const { run, out, err } = harness(env());
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');

    expect(text).toContain('# Morning digest 26/09/2026');
    expect(text).toContain(
      'Window 25/09/2026 17:30 AEST -> 26/09/2026 05:00 AEST (Australia/Sydney)',
    );
    expect(text).toContain(
      '## Finished runs: 4 (2 completed, 1 partially completed, 1 failed, 0 cancelled)',
    );
    expect(text).toContain('- completed done1731 [digest-project] $0.00, 25/09/2026 17:31 AEST');
    expect(text).not.toContain('done1729');
    expect(text).not.toContain('cancold1');
    expect(text).toContain('- completed donein01 [digest-project] $1.25');

    expect(text).toContain(
      '## Active runs: 2 (1 executing, 1 paused); 1 created but never started',
    );
    expect(text).toContain('- executing exec0001 [digest-project] age 3h 0m, last change 30m ago');
    expect(text).toContain('- paused (was executing) paused01');
    expect(text).not.toContain('created1');

    expect(text).toContain('## Blocked: 1 run, 1 active blocker');
    expect(text).toContain('- run blocked1 [digest-project] blocked for 6h 0m');
    expect(text).toContain(
      '- [product_decision] blocked1 / Choose the database: Two storage options fit the acceptance criteria -> Pick Postgres or SQLite',
    );

    expect(text).toContain(
      '## Failures and retries: 1 attempt failed or expired; 1 attempt.lease_expired, 0 worker_job.lease_reconciled, 0 run.restart_failed',
    );
    expect(text).toContain(
      '- failed attempt on "Write the migration" (run exec0001, claude, 26/09/2026 03:20 AEST): WORKER_JOB_FAILED: tests failed',
    );
    expect(text).toContain('- attempt.lease_expired run exec0001 26/09/2026 03:00 AEST');

    expect(text).toContain(
      '- window: $2.25 across 3 calls (claude $2.25 / 2 calls; codex $0.00 / 1 call (subscription)), 300 in (120 cached) / 30 out tokens',
    );
    // Ordered by spend, not by name, because "which role costs the most" is the
    // question the line answers. The roleless record is shown rather than
    // dropped, so the groups still add up to the $2.25 above.
    expect(text).toContain(
      '- by role: builder $1.50 / 1 call; planner $0.75 / 1 call; unattributed $0.00 / 1 call',
    );
    expect(text).toContain(
      '- today 26/09/2026 (Australia/Sydney): $0.75 of the $1.00 ceiling, warn, $0.25 remaining',
    );
    expect(text).toContain(
      '- unmetered: codex 1 call (subscription): $0, not counted against the ceiling',
    );

    expect(text).toContain('## Escalations: 2 recorded (1 sent, 1 failed, 0 pending)');
    expect(text).toContain('- spend.warn: file sent 1, ha failed 1');
    expect(text).toContain(
      '- outstanding: spend.warn on ha failed at 26/09/2026 00:00 AEST (run paused01): Home Assistant answered HTTP 401',
    );
    expect(text).not.toContain('tier0.merge:');

    expect(text).toContain('## Guard events: 1 (1 run.paused_by_guard)');
    expect(text).toContain(
      '- run.paused_by_guard run paused01 26/09/2026 00:00 AEST: daily cloud ceiling of $20.00 reached',
    );

    expect(text).toContain('## Waiting on you: 1 approval, 1 blocker');
    expect(text).toContain(
      '- approval amber on run exec0001, expires in 2h 0m: git push origin forge/x',
    );
    expect(text).toContain(
      '- blocker product_decision on run blocked1 / Choose the database: Pick Postgres or SQLite',
    );

    expect(text).toContain(
      '## Tier 0: 3 outcomes in 1 file (1 merged, 1 deferred, 1 escalated, 0 other)',
    );
    expect(text).toContain('- merged: MisterWizzard/shopfront#26');
    expect(text).toContain('- deferred: MisterWizzard/shopfront#28');
    expect(text).toContain('- escalated: MisterWizzard/shopfront#27');
    expect(text).not.toContain('#20');

    expect(text).toContain(
      '- routing: not yet wired: no RouteDecision is produced, so no saving is claimed; 2 cloud calls / 1 unmetered (subscription or local, $0, not counted against the ceiling) in the window',
    );
    expect(text).toContain(
      `Health: coordinator not checked (FORGE_API_URL and FORGE_COORDINATOR_TOKEN unset); halt file absent (${join(directory, 'FORGE_HALT')})`,
    );
    // No reminders file and a Saturday: neither optional section, and no extra compact line.
    expect(text).not.toContain('## Reminders');
    expect(text).not.toContain('## Week in review');
    expect(text).not.toContain('\nreminders:');
    expect(text).not.toContain('\nweek to');

    // The compact form: title plus six lines, after the blank line that follows the markdown.
    const compactStart = out.indexOf('Morning digest 26/09/2026');
    expect(out.slice(compactStart, compactStart + 7)).toEqual([
      'Morning digest 26/09/2026',
      'runs: 4 finished (2 completed, 1 partial, 1 failed, 0 cancelled), 2 active, 1 blocked',
      'spend: $2.25 in window; today $0.75 of $1.00 (warn)',
      'waiting on you: 1 approval, 1 blocker',
      'escalations: 1 sent, 1 failed, 0 pending; guards: 1; provider failover: 2',
      'tier0: 1 merged, 1 deferred, 1 escalated; failures: 2',
      'health: coordinator not checked (FORGE_API_URL and FORGE_COORDINATOR_TOKEN unset); halt file absent',
    ]);
    expect(out).toContain(
      'dry run: nothing sent; subject would be "Forge: Morning digest 26/09/2026" on file (key digest:morning:2026-09-26)',
    );
    // Every task healthy, so the section and its compact line are both absent. A good
    // day's digest must look exactly as it did before this section existed.
    expect(out.join('\n')).not.toContain('## Scheduled tasks wanting attention');
    expect(out.join('\n')).not.toContain('tasks wanting attention:');
    // Nothing was written: no day folder, no dedupe index.
    expect(await readdir(outbox), 'a dry run writes nothing at all').toEqual(['tier0']);
  }, 30_000);

  it('reports the adaptive cap and the monthly budget when a budget is set (ADR-037)', async () => {
    const { run, out, err } = harness({
      ...env(),
      FORGE_MONTHLY_BUDGET_USD: '100',
      FORGE_MAX_DAILY_CEILING_USD: '50',
    });
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    // The flat $1 ceiling is only the floor now: $10.50 was spent earlier in the month, so
    // $89.50 over the five days left (26/09 to 30/09) is an even share of $17.90 a day.
    expect(text).toContain(
      '- today 26/09/2026 (Australia/Sydney): $0.75 of the $17.90 ceiling, ok, $17.15 remaining',
    );
    expect(text).toContain(
      "- monthly budget: $10.50 of $100.00 spent before today, $89.50 left over 5 days to 01/10/2026; an even share is $17.90 a day, so today's cap is $17.90 (set by the even share of what is left)",
    );
  });

  it('says plainly when a stage failed over to another provider, and only then (ADR-038)', async () => {
    const { run, out } = harness(env());
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('## Provider failover: 2 stages ran on another provider');
    expect(text).toContain(
      '- claude failed over to codex 2 times, last 25/09/2026 22:30 AEST: PROCESS_EXIT: API Error: 400 This API key is not scoped to a workspace',
    );
    // The older event in the other direction is outside the window.
    expect(text).not.toContain('codex failed over to claude');
    expect(text).toContain('provider failover: 2');

    const quiet = harness(env());
    expect(await quiet.run(['--since=2026-09-25T18:00:00Z', '--dry-run'])).toBe(0);
    const quietText = quiet.out.join('\n');
    expect(quietText).not.toContain('Provider failover');
    expect(quietText).not.toContain('provider failover');
  });

  it('keeps the flat ceiling and prints no budget line when no budget is set', async () => {
    const { run, out } = harness(env());
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('$0.75 of the $1.00 ceiling, warn');
    expect(text).not.toContain('monthly budget');
  });

  it('emits the data model with --json', async () => {
    const { run, out } = harness(env());
    expect(await run(['--window=morning', '--dry-run', '--json'])).toBe(0);
    expect(out).toHaveLength(1);
    const data = JSON.parse(out[0]!) as DigestData & {
      rendered: { title: string; compact: string; markdown: string };
      dryRun: boolean;
      channels: string[];
    };
    expect(data.window).toEqual({
      name: 'morning',
      from: MORNING_FROM,
      to: NOW.toISOString(),
      timeZone: TZ,
      localDate: '2026-09-26',
    });
    expect(data.runs.finished.counts).toEqual({ completed: 2, partially_completed: 1, failed: 1 });
    expect(data.runs.finished.items.map((item) => item.id)).toEqual([
      'failed01',
      'partial1',
      'donein01',
      'done1731',
    ]);
    expect(data.runs.active).toMatchObject({ total: 2, notStarted: 1 });
    expect(data.runs.blocked.blockers[0]).toMatchObject({
      id: 'blocker-decision',
      task: 'Choose the database',
    });
    expect(data.failures.attempts.map((item) => item.id)).toEqual(['attempt-failed']);
    expect(data.spend.window).toMatchObject({ usd: 2.25, count: 3, cachedInputTokens: 120 });
    expect(data.spend.window.byRole).toEqual({
      builder: { usd: 1.5, count: 1 },
      planner: { usd: 0.75, count: 1 },
      [UNATTRIBUTED_ROLE]: { usd: 0, count: 1 },
    });
    // Rendered only when something is attributable. With every record in the
    // window roleless - a window entirely from before migration 008, or from
    // something other than the pipeline - a line reading "unattributed $2.25 /
    // 3 calls" would say nothing the call count has not already said, so it is
    // left out while the rest of the section is untouched.
    expect(renderMarkdown(data)).toContain('- by role: builder');
    const rolelessWindow = renderMarkdown({
      ...data,
      spend: {
        ...data.spend,
        window: {
          ...data.spend.window,
          byRole: { [UNATTRIBUTED_ROLE]: { usd: 2.25, count: 3 } },
        },
      },
    });
    expect(rolelessWindow).toContain('## Spend');
    expect(rolelessWindow).not.toContain('- by role:');
    // Four metered calls is nowhere near the threshold, so the data carries the
    // count and the markdown says nothing. Dan's decision of 04/10/2026 was to
    // leave the estimates alone until 50 metered calls exist; a digest nagging
    // about it every twelve hours until then would be noise.
    expect(data.spend.roleEstimates).toMatchObject({ threshold: 50, due: false });
    expect(data.spend.roleEstimates.meteredCalls).toBeLessThan(50);
    expect(renderMarkdown(data)).not.toContain('ROLE_ESTIMATES_USD');

    // And once it is met it says so, once, with the per-role split ordered by
    // weight of evidence so the thinnest role is visible last.
    const due = renderMarkdown({
      ...data,
      spend: {
        ...data.spend,
        roleEstimates: {
          meteredCalls: 52,
          threshold: 50,
          due: true,
          byRole: { planner: 18, builder: 14, reviewer: 13, critic: 7 },
        },
      },
    });
    expect(due).toContain(
      '- ROLE_ESTIMATES_USD is due a correction (ADR-034): 52 metered calls on record, threshold 50 (planner 18 calls, builder 14 calls, reviewer 13 calls, critic 7 calls)',
    );
    expect(data.spend.day).toMatchObject({ spentUsd: 0.75, ceilingUsd: 1, state: 'warn' });
    expect(data.spend.unmetered).toEqual([{ provider: 'codex', calls: 1 }]);
    expect(data.escalations).toMatchObject({ total: 2, sent: 1, failed: 1, pending: 0 });
    expect(data.guards.counts).toEqual({ 'run.paused_by_guard': 1 });
    expect(data.waiting.approvals.map((item) => item.id)).toEqual(['approval-pending']);
    expect(data.tier0).toMatchObject({
      files: 1,
      outcomes: 3,
      merged: ['MisterWizzard/shopfront#26'],
      deferred: ['MisterWizzard/shopfront#28'],
      escalated: ['MisterWizzard/shopfront#27'],
    });
    expect(data.routing).toMatchObject({ wired: false, cloudCalls: 2, unmeteredCalls: 1 });
    expect(data.reminders).toEqual({
      file: join(outbox, 'reminders.md'),
      items: [],
      upcoming: 0,
    });
    expect(data.weekly).toBeUndefined();
    expect(data.rendered.title).toBe('Morning digest 26/09/2026');
    expect(data.dryRun).toBe(true);
    expect(data.channels).toEqual(['file']);
  }, 30_000);

  it('adds the operator reminders from <outbox>/reminders.md to the email and the compact head', async () => {
    await writeFile(
      join(outbox, 'reminders.md'),
      [
        '# one per line; a YYYY-MM-DD prefix shows the line from that day',
        'Rotate the staging token before the 30th',
        '2026-09-01 Check the Tier 0 dry-run log',
        '2026-09-26 Due today: rotate the HA token',
        'Fourth: book the dentist',
        'Fifth: the compact head shows three and counts the rest',
        '2026-09-27 Not yet: tomorrow',
        '',
      ].join('\n'),
    );
    const { run, out, err } = harness(env());
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    // The section sits right under the window line, before the runs.
    const header = text.indexOf('## Reminders: 5');
    expect(header).toBeGreaterThan(0);
    expect(header).toBeLessThan(text.indexOf('## Finished runs'));
    expect(text).toContain(
      [
        '## Reminders: 5',
        '- Rotate the staging token before the 30th',
        '- Check the Tier 0 dry-run log',
        '- Due today: rotate the HA token',
        '- Fourth: book the dentist',
        '- Fifth: the compact head shows three and counts the rest',
        '- (1 more line dated for later)',
      ].join('\n'),
    );
    expect(text).not.toContain('Not yet: tomorrow');
    // The compact head: the usual seven lines, then one reminders line.
    const compactStart = out.indexOf('Morning digest 26/09/2026');
    expect(out[compactStart + 7]).toBe(
      'reminders: Rotate the staging token before the 30th; Check the Tier 0 dry-run log; Due today: rotate the HA token; +2 more',
    );
    expect(out[compactStart + 8]).toBe('');
  }, 30_000);

  it('reads FORGE_REMINDERS_FILE instead, and reports a file it cannot read without failing', async () => {
    const notes = join(directory, 'notes.txt');
    await writeFile(notes, 'Only this one\n');
    const named = harness({ ...env(), FORGE_REMINDERS_FILE: notes });
    expect(await named.run(['--window=morning', '--dry-run', '--json'])).toBe(0);
    const data = JSON.parse(named.out[0]!) as DigestData & { rendered: { compact: string } };
    expect(data.reminders).toEqual({
      file: notes,
      items: [{ text: 'Only this one' }],
      upcoming: 0,
    });
    expect(data.rendered.compact.split('\n').at(-1)).toBe('reminders: Only this one');

    // A directory where the file should be: the section says so, the digest still goes out.
    const unreadable = harness({ ...env(), FORGE_REMINDERS_FILE: directory });
    expect(await unreadable.run(['--window=morning', '--dry-run'])).toBe(0);
    expect(unreadable.err).toEqual([]);
    const text = unreadable.out.join('\n');
    expect(text).toContain('## Reminders: 0');
    expect(text).toContain(`- could not read ${directory}: `);
    expect(text).not.toContain('\nreminders:');
  }, 30_000);

  it('adds the week in review to a Monday morning digest, and to nothing else unless --weekly asks', async () => {
    // Monday 28/09/2026 05:00 AEST: the week is Monday 21/09 00:00 -> Sunday 27/09 24:00.
    const monday = new Date('2026-09-27T19:00:00.000Z');
    const { run, out, err } = harness(env(), { now: monday });
    expect(await run(['--window=morning', '--dry-run'])).toBe(0);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain(
      [
        '## Week in review: 21/09/2026 -> 27/09/2026',
        '- cloud spend: $11.25 across 3 calls (claude $11.25 / 3 calls)',
        '- unmetered: codex 1 call (subscription): $0, not counted against the ceiling',
        '- runs finished: 6 (3 completed, 1 partially completed, 1 failed, 1 cancelled)',
        '- tier 0: 2 merged, 1 deferred, 1 escalated (4 outcomes in 2 files, 0 other)',
        '- ceiling reached on 1 day: 23/09/2026',
      ].join('\n'),
    );
    // Retrospective, so it sits after the routing line and before the health footer.
    expect(text.indexOf('## Week in review')).toBeGreaterThan(text.indexOf('## Routing'));
    expect(text.indexOf('## Week in review')).toBeLessThan(text.indexOf('Health: coordinator'));
    const compactStart = out.indexOf('Morning digest 28/09/2026');
    expect(out[compactStart + 7]).toBe(
      'week to 27/09/2026: cloud $11.25 in 3 calls, 1 unmetered at $0, 6 runs finished, tier0 2 merged/1 deferred/1 escalated, ceiling reached on 1 day',
    );

    // The same Monday's evening digest, and any other day's morning, carry no review.
    for (const [now, argv] of [
      [monday, ['--window=evening']],
      [NOW, ['--window=morning']],
      [NOW, ['--now']],
    ] as Array<[Date, string[]]>) {
      const plain = harness(env(), { now });
      expect(await plain.run([...argv, '--dry-run', '--json']), argv.join(' ')).toBe(0);
      const data = JSON.parse(plain.out[0]!) as DigestData;
      expect(data.weekly, argv.join(' ')).toBeUndefined();
    }
  }, 30_000);

  it('forces the week in review with --weekly for any window and says so', async () => {
    // Saturday 26/09: the seven days before it are 19/09 -> 25/09, which ends
    // before failed01, usage-2 and the Codex call, so the numbers differ from
    // the Monday review above.
    const { run, out } = harness(env());
    expect(await run(['--window=evening', '--weekly', '--dry-run', '--json'])).toBe(0);
    const data = JSON.parse(out[0]!) as DigestData & { rendered: { markdown: string } };
    expect(data.weekly).toEqual({
      from: '2026-09-18T14:00:00.000Z',
      to: '2026-09-25T14:00:00.000Z',
      fromDate: '2026-09-19',
      toDate: '2026-09-25',
      forced: true,
      cloud: { usd: 10.5, calls: 2, byProvider: [{ provider: 'claude', usd: 10.5, calls: 2 }] },
      unmetered: [],
      runs: { total: 5, counts: { completed: 3, partially_completed: 1, cancelled: 1 } },
      tier0: {
        files: 2,
        outcomes: 4,
        merged: 2,
        deferred: 1,
        escalated: 1,
        other: 0,
        unreadable: 0,
      },
      ceilingDays: ['2026-09-23'],
    });
    expect(data.rendered.markdown).toContain(
      '## Week in review: 19/09/2026 -> 25/09/2026 (asked for with --weekly)',
    );
    expect(data.rendered.markdown).toContain('- unmetered: none');
    // Bare --weekly on the default window is accepted too.
    const bare = harness(env());
    expect(await bare.run(['--weekly', '--dry-run', '--json'])).toBe(0);
    expect((JSON.parse(bare.out[0]!) as DigestData).weekly?.forced).toBe(true);
  }, 30_000);

  it('honours the window edge: a run finished at 17:29 local is in the evening digest, not the morning one', async () => {
    // The evening digest of 25/09 at 17:30 covers 05:00 -> 17:30 that day.
    const evening = harness(env(), { now: new Date('2026-09-25T07:30:00.000Z') });
    expect(await evening.run(['--window=evening', '--dry-run', '--json'])).toBe(0);
    const data = JSON.parse(evening.out[0]!) as DigestData;
    expect(data.window.from).toBe('2026-09-24T19:00:00.000Z');
    expect(data.runs.finished.items.map((item) => item.id)).toEqual(['done1729']);
    expect(data.spend.window).toMatchObject({ usd: 9, count: 1 });
    expect(data.tier0.merged).toEqual(['MisterWizzard/shopfront#20']);
    // The 17:00 spend.warn is a guard event of that day; the 00:00 pause is the next morning's.
    expect(data.guards.counts).toEqual({ 'spend.warn': 1 });
  }, 30_000);

  it('delivers through the file channel, writes the digest to the outbox, and dedupes a repeat', async () => {
    const { run, out, err } = harness(env());
    expect(await run(['--window=morning'])).toBe(0);
    // Home Assistant is not listed as skipped for want of variables: a digest never goes there.
    expect(err).toEqual(['digest: skipping email: missing FORGE_SMTP_USER, FORGE_SMTP_PASSWORD']);
    expect(out[0]).toBe('Morning digest 26/09/2026');
    expect(out.slice(7)).toEqual([
      `outbox: ${outbox}`,
      'channels: file',
      'subject: Forge: Morning digest 26/09/2026',
      'result: file sent (attempt 1)',
      // The first run has no previous observation, so it records one and escalates
      // nothing - installing the task watch cannot shout about history.
      'tasks: first observation of 7 task(s), nothing escalated',
    ]);
    const day = join(outbox, '20260926');
    const files = await readdir(day);
    const markdown = files.find(
      (name) => name.includes('-digest-digest-morning-2026-09-26') && name.endsWith('.md'),
    );
    expect(markdown).toBeDefined();
    const written = await readFile(join(day, markdown!), 'utf8');
    expect(written).toContain('# Forge: Morning digest 26/09/2026');
    expect(written).toContain('runs: 4 finished (2 completed, 1 partial, 1 failed, 0 cancelled)');
    expect(written).toContain('## Finished runs: 4');
    expect(written).toContain('2 items are waiting on you; see "Waiting on you".');
    expect(written).toContain('kind digest · key digest:morning:2026-09-26');
    const json = JSON.parse(
      await readFile(join(day, markdown!.replace(/\.md$/, '.json')), 'utf8'),
    ) as { escalation: { kind: string; severity: string; paused: boolean; options: unknown[] } };
    expect(json.escalation).toMatchObject({
      kind: 'digest',
      severity: 'info',
      paused: false,
    });
    expect(json.escalation.options).toHaveLength(1);
    expect(existsSync(join(outbox, 'dedupe-index.json'))).toBe(true);

    // The same digest again inside the dedupe window is not re-sent.
    const again = harness(env());
    expect(await again.run(['--window=morning'])).toBe(0);
    expect(again.out.at(-1)).toMatch(/^result: duplicate: already sent at /);
    expect((await readdir(day)).filter((name) => name.endsWith('.md'))).toHaveLength(1);
  }, 30_000);

  it('never sends a digest to the phone, even with Home Assistant configured (ADR-023)', async () => {
    // The harness fetch throws, so any attempt to reach Home Assistant would
    // surface as `ha FAILED`, not as `ha skipped`.
    const withPhone = () => ({
      ...env(),
      FORGE_HA_URL: 'http://192.168.1.10/ha',
      FORGE_HA_TOKEN: 'test-ha-long-lived-token',
    });
    const dry = harness(withPhone());
    expect(await dry.run(['--window=morning', '--dry-run'])).toBe(0);
    expect(dry.err).toEqual([]);
    // Membership rather than an exact tail: the dry run also reports what the task
    // watch would do, and a test that pins the last N lines breaks on every addition.
    expect(dry.out).toContain(
      'dry run: ha would be skipped (severity routing: a digest is info and never reaches the phone)',
    );
    expect(dry.out).toContain(
      'dry run: nothing sent; subject would be "Forge: Morning digest 26/09/2026" on file (key digest:morning:2026-09-26)',
    );

    const json = harness(withPhone());
    expect(await json.run(['--window=morning', '--dry-run', '--json'])).toBe(0);
    const data = JSON.parse(json.out[0]!) as { channels: string[]; skipped: string[] };
    expect(data.channels).toEqual(['file']);
    expect(data.skipped).toEqual(['ha']);

    const sent = harness(withPhone());
    expect(await sent.run(['--window=morning'])).toBe(0);
    expect(sent.err).toEqual([
      'digest: skipping email: missing FORGE_SMTP_USER, FORGE_SMTP_PASSWORD',
    ]);
    expect(sent.out).toContain('channels: file, ha');
    expect(sent.out).toContain('result: file sent (attempt 1) · ha skipped (severity routing)');
    const files = await readdir(join(outbox, '20260926'));
    expect(files.filter((name) => name.endsWith('.md'))).toHaveLength(1);
  }, 30_000);

  it('reports a channel failure with exit 1 and a database failure with exit 1', async () => {
    const broken: OpenDigestSource = async () => ({
      source: {
        listRuns: async () => {
          throw new Error('connection refused');
        },
      } as unknown as DigestSource,
      close: async () => {},
    });
    const database = harness(env(), { open: broken });
    expect(await database.run(['--window=morning', '--dry-run'])).toBe(1);
    // The type now prefixes the reason, so a log line names what failed as well as why.
    expect(database.err[0]).toContain('could not read the database:');
    expect(database.err[0]).toContain('connection refused');

    // An outbox that cannot be written is a failed channel, not a crash.
    await writeFile(join(directory, 'not-a-directory'), 'x');
    const channel = harness({ ...env(), FORGE_OUTBOX_DIR: join(directory, 'not-a-directory') });
    expect(await channel.run(['--window=morning'])).toBe(1);
    expect(
      channel.out.some((line) => /^result: file FAILED after 3 attempt\(s\)/.test(line)),
      'the delivery failure is still reported',
    ).toBe(true);
    // And the task watch degrades in the same breath rather than throwing: it cannot
    // write its state under an outbox that is a file, and says so.
    expect(channel.out.some((line) => line.startsWith('tasks: could not write'))).toBe(true);
  }, 30_000);
});

describe('describeError', () => {
  // The case this exists for: on 04/10/2026 the morning digest logged exactly
  // "could not read the database: " - an empty reason - because the connection error
  // carried an empty message. The log named the failure and not one fact about it.
  it('names the error type when the message is empty', () => {
    expect(describeError(new Error(''))).toBe('Error with no message');
    // A subclass that does not set `name` still reports its real class, because
    // describeError reads the constructor rather than the inherited name field.
    class ConnectionError extends Error {}
    expect(describeError(new ConnectionError(''))).toBe('ConnectionError with no message');
  });

  it('includes the cause, which is usually where the reason lives', () => {
    const error = new Error('could not connect', {
      cause: new Error('ECONNREFUSED 127.0.0.1:5432'),
    });
    const text = describeError(error);
    expect(text).toContain('could not connect');
    expect(text).toContain('ECONNREFUSED 127.0.0.1:5432');
  });

  it('reports a cause even when the outer message is empty', () => {
    const error = new Error('', { cause: new Error('getaddrinfo ENOTFOUND db') });
    expect(describeError(error)).toContain('ENOTFOUND');
  });

  it('handles a non-Error and a non-Error cause', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(undefined)).toBe('(no detail)');
    expect(describeError(new Error('outer', { cause: 'a string cause' }))).toContain(
      'a string cause',
    );
  });
});
