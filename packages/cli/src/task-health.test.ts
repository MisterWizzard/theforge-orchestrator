/**
 * The decision logic behind "notice that a scheduled task has stopped working" (BLK-025).
 *
 * All pure: no database, no filesystem, no Task Scheduler, so it runs everywhere. The
 * first describe block is the one that matters most - it is the false-alarm guard. The
 * three supervised services report 0x800710E0 permanently by design, so anything that
 * called those a failure would raise an alarm on every digest forever, and an alarm that
 * always fires is an alarm nobody reads.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCHED_TASKS,
  HEALTHY_TASK_RESULTS,
  isTaskResultHealthy,
  parseTaskHealth,
  taskAttentionReason,
  taskNeedsAttention,
  watchedTaskNames,
  type TaskHealth,
  type TaskHealthRow,
} from './commands/runtime.js';
import {
  dueForEscalation,
  repeatedFailures,
  taskFailingDedupeKey,
  taskFailingEscalation,
  taskHealthSnapshot,
  type TaskHealthState,
} from './commands/task-health.js';

/** A registered, healthy task; `overrides` makes it whatever the test needs. */
const healthy = (
  name: string,
  overrides: Partial<Extract<TaskHealthRow, { registered: true }>> = {},
): TaskHealthRow => ({
  name,
  registered: true,
  state: 'Ready',
  enabled: true,
  lastRunTime: '2026-10-04T05:00:01.000Z',
  nextRunTime: '2026-10-04T17:30:00.000Z',
  lastTaskResult: 0,
  missedRuns: 0,
  ...overrides,
});

const health = (rows: TaskHealthRow[], error?: string): TaskHealth => ({
  names: rows.map((row) => row.name),
  rows,
  ...(error ? { error } : {}),
});

describe('which task results are failures', () => {
  it('treats the watchdog repeat codes as healthy, which is the whole point', () => {
    // BLK-017's watchdog trigger re-fires every minute and MultipleInstances IgnoreNew
    // refuses the repeat, so a HEALTHY coordinator, worker or web task sits on one of
    // these permanently. Reading them as failures would cry wolf in every digest.
    expect(isTaskResultHealthy(0x800710e0), '0x800710E0 is the healthy watchdog code').toBe(true);
    expect(isTaskResultHealthy(0x8004131f), '0x8004131F is the healthy watchdog code').toBe(true);
  });

  it('treats a real non-zero exit as a failure', () => {
    // 0x1 is what TheForge Node Watch recorded for days while nobody noticed.
    expect(isTaskResultHealthy(1)).toBe(false);
    expect(isTaskResultHealthy(0x80070002), 'file not found, the broken-task-path case').toBe(
      false,
    );
    expect(isTaskResultHealthy(3), 'runner pre-flight failed').toBe(false);
    expect(isTaskResultHealthy(4), 'gave up waiting for Docker').toBe(false);
  });

  it('treats success, ready, running and not-yet-run as healthy', () => {
    for (const code of [0, 0x41300, 0x41301, 0x41303, 0x41304]) {
      expect(isTaskResultHealthy(code), `0x${code.toString(16)} must be healthy`).toBe(true);
    }
  });

  it('treats an unknown code as a failure rather than assuming the best', () => {
    expect(isTaskResultHealthy(0x12345678)).toBe(false);
    expect(isTaskResultHealthy(-1), 'the sentinel for an unreadable field').toBe(false);
  });

  it('keeps the healthy set small and explicit', () => {
    expect(HEALTHY_TASK_RESULTS.size).toBe(9);
  });
});

describe('which tasks want attention', () => {
  it('says nothing about a healthy task', () => {
    const task = healthy('TheForge CI Watch');
    expect(taskNeedsAttention(task)).toBe(false);
    expect(taskAttentionReason(task)).toBeNull();
  });

  it('says nothing about a service sitting on the watchdog code', () => {
    const task = healthy('TheForge Coordinator', { lastTaskResult: 0x800710e0, state: 'Running' });
    expect(taskNeedsAttention(task)).toBe(false);
  });

  it('flags a failing result, and names it', () => {
    const task = healthy('TheForge Node Watch', { lastTaskResult: 1 });
    expect(taskNeedsAttention(task)).toBe(true);
    expect(taskAttentionReason(task)).toContain('exit 1');
  });

  it('flags a task that is absent, because it will never run', () => {
    const task: TaskHealthRow = { name: 'TheForge Node Watch', registered: false };
    expect(taskNeedsAttention(task)).toBe(true);
    expect(taskAttentionReason(task)).toBe('not registered');
  });

  it('flags a disabled task even though being disabled is not a failure', () => {
    // The result code is 0x41302, which IS in the healthy set - a disabled task has not
    // failed. It is still not doing its job, which is a different question.
    const task = healthy('TheForge Digest Morning', { enabled: false, lastTaskResult: 0x41302 });
    expect(isTaskResultHealthy(0x41302)).toBe(true);
    expect(taskNeedsAttention(task)).toBe(true);
    expect(taskAttentionReason(task)).toBe('disabled');
  });
});

describe('parsing what PowerShell printed', () => {
  it('returns a row per name asked about, in that order', () => {
    const parsed = parseTaskHealth(
      [
        { name: 'b', registered: true, state: 'Ready', enabled: true, lastTaskResult: 0 },
        { name: 'a', registered: true, state: 'Running', enabled: true, lastTaskResult: 1 },
      ],
      ['a', 'b'],
    );
    expect(parsed.rows.map((row) => row.name)).toEqual(['a', 'b']);
    expect(parsed.error).toBeUndefined();
  });

  it('treats a name with no row as not registered rather than an error', () => {
    const parsed = parseTaskHealth([], ['TheForge Node Watch']);
    expect(parsed.rows[0]).toEqual({ name: 'TheForge Node Watch', registered: false });
    expect(parsed.error).toBeUndefined();
  });

  it('carries a non-array as an error instead of throwing', () => {
    const parsed = parseTaskHealth({ not: 'an array' }, ['a']);
    expect(parsed.error).toMatch(/not a JSON array/);
    expect(parsed.rows).toEqual([]);
  });

  it('shows an unreadable result field as a failure, not as success', () => {
    const parsed = parseTaskHealth(
      [{ name: 'a', registered: true, state: 'Ready', enabled: true, lastTaskResult: 'oops' }],
      ['a'],
    );
    const row = parsed.rows[0];
    expect(row?.registered && row.lastTaskResult).toBe(-1);
    expect(taskNeedsAttention(row as TaskHealthRow)).toBe(true);
  });
});

describe('which tasks are watched', () => {
  it('defaults to the periodic jobs as well as the three services', () => {
    // The services are restarted by the watchdog; the periodic jobs are not, which is
    // why their silent failure is the dangerous one.
    expect(DEFAULT_WATCHED_TASKS).toContain('TheForge Node Watch');
    expect(DEFAULT_WATCHED_TASKS).toContain('TheForge CI Watch');
    expect(DEFAULT_WATCHED_TASKS).toContain('TheForge Digest Morning');
    expect(watchedTaskNames({})).toEqual(DEFAULT_WATCHED_TASKS);
  });

  it('adds to the defaults with a leading +, which is the common case', () => {
    const names = watchedTaskNames({ FORGE_WATCH_TASKS: '+Backup task, Offsite task' });
    expect(names).toContain('TheForge Coordinator');
    expect(names).toContain('Backup task');
    expect(names).toContain('Offsite task');
  });

  it('replaces the defaults without the +', () => {
    expect(watchedTaskNames({ FORGE_WATCH_TASKS: 'Only This' })).toEqual(['Only This']);
  });

  it('ignores an empty or blank value rather than watching nothing', () => {
    expect(watchedTaskNames({ FORGE_WATCH_TASKS: '   ' })).toEqual(DEFAULT_WATCHED_TASKS);
    expect(watchedTaskNames({ FORGE_WATCH_TASKS: '+ , ,' })).toEqual(DEFAULT_WATCHED_TASKS);
  });

  it('does not watch the same task twice', () => {
    const names = watchedTaskNames({ FORGE_WATCH_TASKS: '+TheForge Worker' });
    expect(names.filter((name) => name === 'TheForge Worker')).toHaveLength(1);
  });
});

describe('escalating only a repeated failure', () => {
  const failing = health([healthy('TheForge Node Watch', { lastTaskResult: 1 })]);
  const at = '2026-10-04T05:00:00.000Z';

  it('says nothing on the first observation, so installing it cannot shout about history', () => {
    expect(repeatedFailures(failing, undefined)).toEqual([]);
  });

  it('says nothing when the task was healthy at the previous observation', () => {
    const previous: TaskHealthState = {
      version: 1,
      observedAt: at,
      tasks: { 'TheForge Node Watch': { attention: false, reason: null, observedAt: at } },
    };
    expect(repeatedFailures(failing, previous)).toEqual([]);
  });

  it('escalates once the same task has wanted attention twice running', () => {
    const previous: TaskHealthState = {
      version: 1,
      observedAt: at,
      tasks: {
        'TheForge Node Watch': {
          attention: true,
          reason: 'last result 1 (exit 1)',
          observedAt: at,
        },
      },
    };
    const repeats = repeatedFailures(failing, previous);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]?.task.name).toBe('TheForge Node Watch');
    expect(repeats[0]?.since).toBe(at);
  });

  it('sends once per local day while the task stays broken', () => {
    const previous: TaskHealthState = {
      version: 1,
      observedAt: at,
      tasks: {
        'TheForge Node Watch': {
          attention: true,
          reason: 'last result 1 (exit 1)',
          observedAt: at,
        },
      },
      escalatedOn: { 'TheForge Node Watch': '2026-10-04' },
    };
    const repeats = repeatedFailures(failing, previous);
    expect(dueForEscalation(repeats, previous, '2026-10-04'), 'already said today').toEqual([]);
    expect(dueForEscalation(repeats, previous, '2026-10-05'), 'still broken tomorrow').toHaveLength(
      1,
    );
  });

  it('records every task in the snapshot, healthy or not, so the next run can compare', () => {
    const snapshot = taskHealthSnapshot(
      health([healthy('ok'), healthy('bad', { lastTaskResult: 1 })]),
      at,
    );
    expect(snapshot.tasks['ok']?.attention).toBe(false);
    expect(snapshot.tasks['bad']?.attention).toBe(true);
    expect(snapshot.version).toBe(1);
  });
});

describe('the escalation itself', () => {
  const failure = {
    task: healthy('TheForge Node Watch', { lastTaskResult: 1 }),
    reason: 'last result 1 (exit 1)',
    since: '2026-10-03T17:30:00.000Z',
  };

  it('is a warn, so it reaches the phone, unlike the digest that carries it', () => {
    const escalation = taskFailingEscalation(failure, '2026-10-04', '2026-10-04T05:00:00.000Z');
    expect(escalation.severity).toBe('warn');
    expect(escalation.kind).toBe('task.failing');
    expect(escalation.paused, 'nothing waits on this; that is why it went unnoticed').toBe(false);
  });

  it('names the task in the title and says how long it has been failing', () => {
    const escalation = taskFailingEscalation(failure, '2026-10-04', '2026-10-04T05:00:00.000Z');
    expect(escalation.title).toContain('TheForge Node Watch');
    expect(escalation.what).toContain('2026-10-03T17:30:00.000Z');
    expect(escalation.options.length).toBeGreaterThanOrEqual(3);
    expect(escalation.recommendation).toBeTruthy();
  });

  it('keys dedupe on the task and the day, so one broken task is one message a day', () => {
    expect(taskFailingDedupeKey('TheForge Node Watch', '2026-10-04')).toBe(
      'task-health:TheForge Node Watch:2026-10-04',
    );
    const a = taskFailingEscalation(failure, '2026-10-04', '2026-10-04T05:00:00.000Z');
    const b = taskFailingEscalation(failure, '2026-10-04', '2026-10-04T17:30:00.000Z');
    expect(a.dedupeKey, 'same task, same day, one message').toBe(b.dedupeKey);
  });

  it('explains an absent task differently from a failing one', () => {
    const absent = {
      task: { name: 'TheForge CI Watch', registered: false } as TaskHealthRow,
      reason: 'not registered',
      since: '2026-10-03T17:30:00.000Z',
    };
    const escalation = taskFailingEscalation(absent, '2026-10-04', '2026-10-04T05:00:00.000Z');
    expect(escalation.what).toContain('does not have it at all');
  });
});
