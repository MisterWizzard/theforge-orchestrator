/**
 * Noticing that a scheduled task has stopped working.
 *
 * BLK-025 is why this exists. `TheForge Node Watch` recorded `LastTaskResult 0x1` on
 * every run for days, and nothing said so: the tailnet monitor was dead at exactly the
 * moment three nodes joined. `TheForge Digest Morning` failed through the Docker outage
 * and was equally silent. Everything this system watches - runs, spend, CI, tailnet
 * nodes - is watched by something. Nothing watched the watchers.
 *
 * The digest reports the current state (see `tasksNeedingAttention` in digest.ts). This
 * module is the second half: deciding when a failing task is worth a push to the phone.
 *
 * **Only a repeated failure escalates.** A task is escalated when it wants attention now
 * AND wanted attention at the previous observation. The digests run at 05:00 and 17:30,
 * so that is roughly a twelve-hour confirmation - slower than it could be, and
 * deliberately so: `0x41301` (running) and a one-off non-zero exit are both ordinary, and
 * an alarm that fires on either would be ignored within a week. The state file is what
 * makes "repeated" knowable, and it is the same shape node-watch uses for the same reason.
 *
 * A first run seeds silently, so installing this cannot produce a burst about history.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Escalation } from '@theforge/notify';
import {
  taskAttentionReason,
  taskNeedsAttention,
  type TaskHealth,
  type TaskHealthRow,
} from './runtime.js';

/** What was true of one task at the previous observation. */
export type TaskMarker = {
  /** Whether it wanted attention then. Only a run where this was true can escalate. */
  attention: boolean;
  /** The reason, kept so a changed reason reads sensibly in the message. */
  reason: string | null;
  observedAt: string;
};

export type TaskHealthState = {
  version: 1;
  observedAt: string;
  tasks: Record<string, TaskMarker>;
  /** Local days on which each task was last escalated, so it says so once a day. */
  escalatedOn?: Record<string, string>;
};

export const taskHealthStatePath = (outboxDir: string): string =>
  join(outboxDir, 'task-health', 'state.json');

/**
 * Reads the state file. **Never throws**: a missing file is the normal first run, and a
 * corrupt one is treated the same way rather than stopping the digest. Returning
 * `undefined` means "no previous observation", which seeds silently.
 */
export async function readTaskHealthState(path: string): Promise<TaskHealthState | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as TaskHealthState;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return undefined;
    if (!parsed.tasks || typeof parsed.tasks !== 'object') return undefined;
    return parsed;
  } catch {
    // A malformed file seeds again rather than failing. One quiet digest is a far
    // smaller cost than a digest that cannot be sent.
    return undefined;
  }
}

export async function writeTaskHealthState(path: string, state: TaskHealthState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** The observation to store for this run. */
export function taskHealthSnapshot(tasks: TaskHealth, observedAt: string): TaskHealthState {
  const entries: Record<string, TaskMarker> = {};
  for (const row of tasks.rows) {
    entries[row.name] = {
      attention: taskNeedsAttention(row),
      reason: taskAttentionReason(row),
      observedAt,
    };
  }
  return { version: 1, observedAt, tasks: entries };
}

/** A task that wants attention now and wanted it at the previous observation. */
export type RepeatedFailure = { task: TaskHealthRow; reason: string; since: string };

/**
 * The tasks whose failure has now been seen twice running. Pure, so the decision is
 * testable without a filesystem or a clock.
 */
export function repeatedFailures(
  tasks: TaskHealth,
  previous: TaskHealthState | undefined,
): RepeatedFailure[] {
  if (!previous) return []; // First run: seed, say nothing.
  const out: RepeatedFailure[] = [];
  for (const row of tasks.rows) {
    if (!taskNeedsAttention(row)) continue;
    const before = previous.tasks[row.name];
    if (!before?.attention) continue; // New this run; wait for confirmation.
    out.push({
      task: row,
      reason: taskAttentionReason(row) ?? 'unknown',
      since: before.observedAt,
    });
  }
  return out;
}

/**
 * Which repeated failures to actually send, given the day each was last sent on. Once
 * per local day while a task stays broken: still broken tomorrow is worth repeating,
 * every twelve hours forever is not.
 */
export function dueForEscalation(
  failures: readonly RepeatedFailure[],
  previous: TaskHealthState | undefined,
  localDay: string,
): RepeatedFailure[] {
  const sent = previous?.escalatedOn ?? {};
  return failures.filter((failure) => sent[failure.task.name] !== localDay);
}

export const taskFailingDedupeKey = (name: string, localDay: string): string =>
  `task-health:${name}:${localDay}`;

/** The escalation for one task that has failed twice running. Warn, so it reaches the phone. */
export function taskFailingEscalation(
  failure: RepeatedFailure,
  localDay: string,
  occurredAt: string,
): Escalation {
  const { task, reason, since } = failure;
  const name = task.name;
  const detail = task.registered
    ? `Its state is ${task.state}, it last ran ${task.lastRunTime ?? 'never'}${
        task.missedRuns ? `, and Task Scheduler has recorded ${task.missedRuns} missed run(s)` : ''
      }.`
    : 'Task Scheduler does not have it at all, so it is not going to run.';
  return {
    kind: 'task.failing',
    severity: 'warn',
    title: `Scheduled task ${name} is still failing (${reason})`,
    what:
      `${name} wanted attention at the previous check (${since}) and still does: ${reason}. ${detail} ` +
      `A scheduled task that keeps failing is doing none of the work it was registered for, and nothing else will notice - ` +
      `this is the failure mode of BLK-025, where the tailnet watch sat dead for days. ` +
      `This is sent once per day while the task stays broken, not on every digest.`,
    project: 'runtime',
    task: name,
    options: [
      {
        label: `Read the log: C:\\forge\\logs - then run the job by hand to see the real error`,
        consequence: 'Read-only, and usually enough: the runner writes the reason it exited.',
      },
      {
        label: 'Re-register it: the matching register-*.ps1 under scripts/',
        consequence:
          'Replaces the task definition. Safe, and the fix when the task is absent or its action is wrong.',
      },
      {
        label: 'Leave it, if you switched it off on purpose',
        consequence:
          'Nothing changes and it keeps being reported. A deliberately disabled task is better unregistered, so this stops asking.',
      },
    ],
    recommendation:
      'Read the log first. A task that fails every run almost always fails for one reason, and the runner has written it down.',
    // Nothing is held up waiting for an answer: the rest of the system carries on
    // without this task, which is precisely why its failure went unnoticed.
    paused: false,
    evidence: [
      `last result: ${reason}`,
      `failing since at least: ${since}`,
      `local day: ${localDay}`,
      'pnpm forge runtime status shows every task and its last result',
    ],
    dedupeKey: taskFailingDedupeKey(name, localDay),
    occurredAt,
  };
}
