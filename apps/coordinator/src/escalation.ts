/**
 * Which events reach Dan, and what they say when they do (policy B11).
 *
 * `classify` is a pure function from an event to an Escalation or null; it is
 * the whole of the policy and is tested by feeding it synthetic events. The
 * hook returned by `createEscalationHook` sits beside `publishEvent` in
 * server.ts, and it is written so that nothing in it can throw into the event
 * path: a notifier fault is logged and recorded, never propagated.
 *
 * The option and recommendation texts are what Dan reads on his phone. They
 * name the exact command or endpoint, say what happens if he does nothing,
 * and never assume he remembers the run.
 */
import { randomUUID } from 'node:crypto';
import type { Escalation, EscalationOption, Notifier, NotifierReport } from '@theforge/notify';

export type EventLike = {
  id: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** Project and task names for the message header, looked up by the coordinator. */
export type RunContext = { project?: string; task?: string };

const HALT: EscalationOption = {
  label: 'Halt everything: pnpm forge halt --reason="..."',
  consequence:
    'No new work is leased anywhere; jobs already running finish. Nothing is lost. Resume with pnpm forge resume.',
};

const cancelRun = (runId: string): EscalationOption => ({
  label: `Cancel this run: POST /api/runs/${runId}/control {"action":"cancel"}`,
  consequence:
    'The run stops where it is and its worktree is kept for inspection. Other runs are unaffected.',
});

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const short = (runId: string): string => runId.slice(0, 8);
const money = (value: number | undefined): string =>
  value === undefined ? '?' : `$${value.toFixed(2)}`;

type Base = Pick<Escalation, 'runId' | 'occurredAt' | 'evidence'> & RunContext;

function base(event: EventLike, context: RunContext): Base {
  return {
    runId: event.runId,
    occurredAt: event.createdAt,
    evidence: [`event ${event.id} (${event.type})`],
    ...(context.project !== undefined ? { project: context.project } : {}),
    ...(context.task !== undefined ? { task: context.task } : {}),
  };
}

function securityFindings(event: EventLike, context: RunContext): Escalation | null {
  if (!Array.isArray(event.payload.findings)) return null;
  const serious = event.payload.findings
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => item.severity === 'high' || item.severity === 'critical');
  if (serious.length === 0) return null;
  const critical = serious.some((item) => item.severity === 'critical');
  const round = num(event.payload.round) ?? str(event.payload.round) ?? '?';
  const claims = serious
    .slice(0, 3)
    .map((item) => `- [${String(item.severity)}] ${str(item.claim) ?? 'unnamed finding'}`)
    .join('\n');
  return {
    ...base(event, context),
    kind: 'security.finding',
    severity: critical ? 'critical' : 'warn',
    title: `Reviewer found ${serious.length} ${critical ? 'critical' : 'high'}-severity issue${serious.length === 1 ? '' : 's'} in run ${short(event.runId)}`,
    what: `The independent reviewer's round ${String(round)} verdict on run ${short(event.runId)} carries ${serious.length} high or critical finding${serious.length === 1 ? '' : 's'}:\n${claims}${serious.length > 3 ? `\n- and ${serious.length - 3} more` : ''}\nThe run is not paused: the builder gets up to three repair rounds, and nothing is pushed or merged until the reviewer approves and you approve the exact push.`,
    options: [
      {
        label: 'Let the repair loop run',
        consequence:
          'The builder attempts a fix and the reviewer re-reads the diff. If the finding survives three rounds the run ends partially_completed with the worktree kept and no push.',
      },
      cancelRun(event.runId),
      HALT,
    ],
    recommendation: critical
      ? 'Read the finding now. If it describes a real vulnerability in code that was already on the target branch, cancel the run and fix it by hand; the repair loop only edits the worktree.'
      : 'Let the repair loop run, then read the finding in the run dashboard before approving any push it later asks for.',
    paused: false,
    dedupeKey: `security.finding:${event.runId}:round-${String(round)}`,
  };
}

function integrationBlocked(event: EventLike, context: RunContext): Escalation | null {
  const classification = str(event.payload.classification);
  const unblock = str(event.payload.smallestUnblockAction);
  if (classification === 'safety_constraint') {
    return {
      ...base(event, context),
      kind: 'security.integration_blocked',
      severity: 'critical',
      title: `Push refused: the approved commit changed in run ${short(event.runId)}`,
      what: `You approved pushing one exact commit, but the worktree's HEAD no longer matches it, so the coordinator refused to push. Something rewrote the worktree after the approval was recorded. Nothing has been pushed.${unblock ? `\nSuggested unblock: ${unblock}` : ''}`,
      options: [
        {
          label: 'Inspect the worktree and diff HEAD against the approved commit',
          consequence:
            'Nothing changes until you decide. The worktree is preserved and the approval stays approved.',
        },
        {
          label: 'Reject the approval: POST /api/approvals/<id> {"decision":"rejected"}',
          consequence: 'The run closes without integration; the worktree is kept.',
        },
        {
          label: 'Re-approve the new commit explicitly from the dashboard',
          consequence: 'The push runs against the commit shown there and a draft PR is opened.',
        },
      ],
      recommendation:
        'Treat this as a security signal until proven otherwise: find what changed HEAD before approving anything.',
      paused: true,
      dedupeKey: `security.integration_blocked:${event.runId}`,
    };
  }
  if (classification === 'missing_access') {
    return {
      ...base(event, context),
      kind: 'decision.missing_access',
      severity: 'warn',
      title: `Approved push cannot run: GITHUB_TOKEN is not set (run ${short(event.runId)})`,
      what: `The push you approved for run ${short(event.runId)} needs a GitHub token and the coordinator has none. The approval is recorded and nothing else happens until the token exists.${unblock ? `\nSmallest unblock: ${unblock}` : ''}`,
      options: [
        {
          label: 'Set GITHUB_TOKEN in .env, restart the coordinator, approve the same action again',
          consequence: 'The branch is pushed and a draft PR opened; the run completes.',
        },
        {
          label: 'Reject the approval',
          consequence: 'The worktree is kept; nothing reaches GitHub.',
        },
      ],
      recommendation:
        'Use a fine-grained token limited to the target repository (Contents and Pull requests read/write), then re-approve.',
      paused: true,
      dedupeKey: `decision.missing_access:${event.runId}`,
    };
  }
  return null;
}

function verificationFailed(event: EventLike, context: RunContext): Escalation | null {
  if (event.payload.passed !== false) return null;
  const checks = Array.isArray(event.payload.checks) ? event.payload.checks : [];
  const failed = checks
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => num(item.code) !== 0)
    .map((item) => `${str(item.command) ?? 'check'} (exit ${num(item.code) ?? '?'})`);
  return {
    ...base(event, context),
    kind: 'ci.failed',
    severity: 'warn',
    title: `Checks failed after the build in run ${short(event.runId)}`,
    what: `The deterministic checks failed on the builder's changes: ${failed.join(', ') || 'see the run evidence'}. The run ends partially_completed with the worktree preserved; nothing is pushed.`,
    options: [
      {
        label: 'Open the run and read the check output',
        consequence: 'Nothing changes. The worktree stays where it is for repair by hand.',
      },
      {
        label: 'Retry the run: POST /api/runs/<id>/control {"action":"retry"}',
        consequence: 'The pipeline restarts from its checkpoint and spends more budget.',
      },
      HALT,
    ],
    recommendation:
      'Read the failing check first. A failure in code the builder did not touch usually means the base branch is already red, and a retry will not fix that.',
    paused: true,
    dedupeKey: `ci.failed:${event.runId}:${failed.map((item) => item.split(' ')[0]).join('+') || 'checks'}`,
  };
}

function runFailed(event: EventLike, context: RunContext): Escalation {
  const message = str(event.payload.message) ?? 'no message recorded';
  return {
    ...base(event, context),
    kind: 'run.failed',
    severity: 'critical',
    title: `Run ${short(event.runId)} failed: ${message.slice(0, 80)}`,
    what: `The run stopped with an error rather than a decision: ${message}. Its state is failed; nothing else in the system is affected.`,
    options: [
      {
        label: 'Retry the run: POST /api/runs/<id>/control {"action":"retry"}',
        consequence: 'It resumes from the last checkpoint and spends more budget.',
      },
      {
        label: 'Leave it failed',
        consequence: 'Nothing further happens. The evidence stays in the dashboard.',
      },
      HALT,
    ],
    recommendation:
      'Check whether a worker or provider is down before retrying; the same fault will fail the same way.',
    paused: true,
    dedupeKey: `run.failed:${event.runId}`,
  };
}

function integrationFailed(event: EventLike, context: RunContext): Escalation {
  const message = str(event.payload.message) ?? 'no message recorded';
  return {
    ...base(event, context),
    kind: 'ci.integration_failed',
    severity: 'warn',
    title: `Push or pull request failed for run ${short(event.runId)}`,
    what: `The approved integration ran and failed: ${message}. The branch may or may not have reached GitHub; no pull request was recorded.`,
    options: [
      {
        label: 'Check GitHub for the branch, then approve the same action again',
        consequence: 'The push and pull request are attempted once more.',
      },
      {
        label: 'Reject the approval',
        consequence: 'The worktree is kept; nothing further reaches GitHub.',
      },
    ],
    recommendation:
      'A 401 or 403 means the token; a non-fast-forward means the branch already exists remotely. Read the message before retrying.',
    paused: true,
    dedupeKey: `ci.integration_failed:${event.runId}`,
  };
}

function workerJobFailed(event: EventLike, context: RunContext): Escalation | null {
  const code = num(event.payload.code);
  if (code === undefined || code === 0) return null;
  const jobId = str(event.payload.jobId) ?? 'unknown';
  const phase = event.type.replace(/\.worker_job_finished$/, '');
  return {
    ...base(event, context),
    kind: 'ci.worker_job_failed',
    severity: 'warn',
    title: `${phase} job exited ${code} in run ${short(event.runId)}`,
    what: `Worker job ${jobId} for phase ${phase} finished with exit code ${code}${str(event.payload.workerId) ? ` on worker ${str(event.payload.workerId)}` : ''}. The pipeline decides what to do next; if it cannot continue you will get a separate failure notice.`,
    options: [
      {
        label: 'Nothing yet',
        consequence: 'The pipeline retries or fails on its own rules; watch for the follow-up.',
      },
      HALT,
    ],
    recommendation:
      'Only act if this repeats: a run of non-zero jobs across phases points at the worker or the sandbox image, not at the change.',
    paused: false,
    dedupeKey: `ci.worker_job_failed:${jobId}`,
  };
}

function approvalRequested(event: EventLike, context: RunContext): Escalation {
  const approvalId = str(event.payload.approvalId) ?? 'unknown';
  return {
    ...base(event, context),
    kind: 'decision.approval',
    severity: 'warn',
    title: `Run ${short(event.runId)} is ready to push and needs your approval`,
    what: `The run finished its work and verification passed. It wants to push branch forge/${short(event.runId)} and open a draft pull request. That is an amber action, so nothing happens until you decide. The approval expires after 24 hours.`,
    options: [
      {
        label: `Approve: POST /api/approvals/${approvalId} {"decision":"approved"}`,
        consequence:
          'Exactly the commit shown is pushed and a draft PR is opened under GITHUB_TOKEN. The run completes.',
      },
      {
        label: `Reject: POST /api/approvals/${approvalId} {"decision":"rejected"}`,
        consequence: 'The worktree is kept locally; nothing reaches GitHub.',
      },
      {
        label: 'Do nothing',
        consequence: 'After 24 hours the approval expires, which is the same as rejecting it.',
      },
    ],
    recommendation:
      'Read the diff and the reviewer verdict in the dashboard first; approve only the commit shown there.',
    paused: true,
    dedupeKey: `decision.approval:${approvalId}`,
  };
}

function spendWarn(event: EventLike, context: RunContext): Escalation {
  const day = str(event.payload.day) ?? 'today';
  const dayUsd = num(event.payload.dayUsd);
  const ceilingUsd = num(event.payload.ceilingUsd);
  const fraction = num(event.payload.fraction);
  return {
    ...base(event, context),
    kind: 'spend.warn',
    severity: 'warn',
    title: `Cloud spend at ${fraction !== undefined ? `${Math.round(fraction * 100)}%` : 'the warning level'} of the daily ceiling`,
    what: `${money(dayUsd)} of the ${money(ceilingUsd)} ceiling has been spent on cloud models on ${day} (${str(event.payload.timezone) ?? 'local'} day). At the ceiling, cloud routing stops and work continues on local models only (policy B3).`,
    options: [
      {
        label: 'Let it run',
        consequence:
          'Spending continues to the ceiling, then local-only routing takes over automatically. Nothing is bought.',
      },
      HALT,
    ],
    recommendation:
      'No action unless the spend is out of proportion to the work in flight, in which case halt and look at the usage records.',
    paused: false,
    dedupeKey: `spend.warn:${day}`,
  };
}

function spendCeiling(event: EventLike, context: RunContext): Escalation {
  const day = str(event.payload.day) ?? 'today';
  return {
    ...base(event, context),
    kind: 'spend.ceiling',
    severity: 'critical',
    title: `Daily cloud ceiling reached (${money(num(event.payload.dayUsd))} of ${money(num(event.payload.ceilingUsd))})`,
    what: `Cloud model spend for ${day} has reached the ceiling. Routing is now ${str(event.payload.routing) ?? 'local-only'}: planner and critic continue on local models; a builder or reviewer stage stops its run as a policy stop, reported separately. The ceiling resets at the start of the next local day.`,
    options: [
      {
        label: 'Accept local-only for the rest of the day',
        consequence: 'Work continues at reduced capability; nothing further is spent.',
      },
      HALT,
    ],
    recommendation:
      'Accept it. Raising the ceiling is a policy change, not something to do from a notification.',
    paused: false,
    dedupeKey: `spend.ceiling:${day}`,
  };
}

function guardTaskLimit(event: EventLike, context: RunContext): Escalation {
  const jobId = str(event.payload.jobId) ?? 'unknown';
  return {
    ...base(event, context),
    kind: 'guard.task_limit',
    severity: 'warn',
    title: `A ${str(event.payload.role) ?? 'worker'} job hit its task limit in run ${short(event.runId)}`,
    what: `Job ${jobId} was stopped by the task guard: ${str(event.payload.reason) ?? 'limit exceeded'}. Usage at the time: ${JSON.stringify(event.payload.usage ?? {})}.`,
    options: [
      {
        label: 'Nothing yet',
        consequence: 'The pipeline handles the stopped job on its own rules.',
      },
      HALT,
    ],
    recommendation:
      'A single hit is the guard working. Repeated hits on one run mean the task is too large for one job; split the objective.',
    paused: false,
    dedupeKey: `guard.task_limit:${jobId}`,
  };
}

function pausedByGuard(event: EventLike, context: RunContext): Escalation {
  const guard = str(event.payload.guard) ?? 'guard';
  const resumeHint = str(event.payload.resumeHint);
  return {
    ...base(event, context),
    kind: 'run.paused',
    severity: 'warn',
    title: `Run ${short(event.runId)} paused by the ${guard} guard`,
    what: `${str(event.payload.reason) ?? 'A guard paused the run.'} The run holds its place and spends nothing until resumed.`,
    options: [
      {
        label: resumeHint ?? `Resume: POST /api/runs/${event.runId}/control {"action":"resume"}`,
        consequence: 'The run continues from where it paused.',
      },
      cancelRun(event.runId),
      { label: 'Leave it paused', consequence: 'Nothing further happens on this run.' },
    ],
    recommendation:
      guard === 'spend'
        ? 'Leave it paused until the next local day unless the work is urgent enough to justify the spend.'
        : 'Read the reason, then resume if it was a one-off.',
    paused: true,
    dedupeKey: `run.paused:${event.runId}:${guard}`,
  };
}

function policyStop(event: EventLike, context: RunContext): Escalation | null {
  if (event.payload.classification !== 'safety_constraint') return null;
  const summary = str(event.payload.blocker) ?? 'A stage was refused by policy.';
  return {
    ...base(event, context),
    kind: 'run.policy_stop',
    severity: 'warn',
    title: `Run ${short(event.runId)} stopped by policy`,
    what: `${summary} The run ended partially completed; nothing was spent on the refused stage.`,
    options: [
      {
        label: 'Wait for the next local day, then retry the run',
        consequence: 'The stage runs on the cloud once the ceiling resets.',
      },
      {
        label: 'Raise FORGE_DAILY_CEILING_USD in .env and restart the coordinator, then retry',
        consequence: 'Spends more today; the ceiling is the only thing holding this back.',
      },
      cancelRun(event.runId),
    ],
    recommendation:
      'Leave it until the next local day unless the work is urgent enough to justify the spend.',
    paused: false,
    dedupeKey: `run.policy_stop:${event.runId}`,
  };
}

/** The B11 policy: returns the escalation an event warrants, or null for the rest. */
export function classify(event: EventLike, context: RunContext = {}): Escalation | null {
  switch (event.type) {
    case 'run.finished':
      return policyStop(event, context);
    case 'review.completed':
      return securityFindings(event, context);
    case 'integration.blocked':
      return integrationBlocked(event, context);
    case 'verification.completed':
      return verificationFailed(event, context);
    case 'run.failed':
      return runFailed(event, context);
    case 'integration.failed':
      return integrationFailed(event, context);
    case 'approval.requested':
      return approvalRequested(event, context);
    case 'spend.warn':
      return spendWarn(event, context);
    case 'spend.ceiling':
      return spendCeiling(event, context);
    case 'guard.task_limit':
      return guardTaskLimit(event, context);
    case 'run.paused_by_guard':
      return pausedByGuard(event, context);
    default:
      return event.type.endsWith('.worker_job_finished') ? workerJobFailed(event, context) : null;
  }
}

/** What slice B1 adds to the repository; coded against by shape so this compiles without it. */
export type NotificationRecord = {
  id: string;
  runId: string;
  kind: string;
  dedupeKey: string;
  channel: string;
  /** `skipped` is severity routing (ADR-023) leaving a channel out; it is not a failure. */
  status: 'sent' | 'failed' | 'skipped' | 'duplicate' | 'coalesced';
  attempts: number;
  payload: Record<string, unknown>;
  lastError?: string;
};

export type NotificationRecorder = {
  recordNotification(record: NotificationRecord): Promise<unknown>;
};

export function notificationRecorder(candidate: unknown): NotificationRecorder | undefined {
  if (!candidate || typeof candidate !== 'object') return undefined;
  const method = (candidate as { recordNotification?: unknown }).recordNotification;
  return typeof method === 'function' ? (candidate as NotificationRecorder) : undefined;
}

export type EscalationHookOptions = {
  notifier: Notifier;
  /** Usually the durable repository; ignored unless it has recordNotification. */
  recorder?: unknown;
  log: (level: 'info' | 'warn' | 'error', message: string, runId?: string) => void;
  context?: (runId: string) => RunContext;
  /** Injectable for tests; the hook otherwise generates record ids itself. */
  recordId?: () => string;
};

export type EscalationHook = {
  /** Fire-and-forget. Never throws, whatever the event looks like. */
  onEvent(event: Record<string, unknown>): void;
  /** Waits for in-flight notifications, then flushes what the notifier holds. */
  close(): Promise<void>;
};

function eventLike(raw: Record<string, unknown>): EventLike | undefined {
  if (typeof raw.type !== 'string' || typeof raw.runId !== 'string') return undefined;
  const payload =
    raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  return {
    id: typeof raw.id === 'string' ? raw.id : 'unknown',
    runId: raw.runId,
    type: raw.type,
    payload,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

export function recordsFromReport(
  report: NotifierReport,
  escalation: Escalation,
  runId: string,
  recordId: () => string,
): NotificationRecord[] {
  const payload = escalation as unknown as Record<string, unknown>;
  const common = { runId, kind: escalation.kind, dedupeKey: escalation.dedupeKey, payload };
  if (report.outcome === 'duplicate' || report.outcome === 'coalesced') {
    return [
      {
        id: recordId(),
        ...common,
        channel: 'notifier',
        status: report.outcome,
        attempts: 0,
        ...(report.detail ? { lastError: report.detail } : {}),
      },
    ];
  }
  return report.channels.map((result) => ({
    id: recordId(),
    ...common,
    channel: result.channel,
    status: result.status,
    attempts: result.attempts,
    ...(result.error ? { lastError: result.error } : {}),
  }));
}

export function createEscalationHook(options: EscalationHookOptions): EscalationHook {
  const recorder = notificationRecorder(options.recorder);
  const recordId = options.recordId ?? randomUUID;
  const inFlight = new Set<Promise<void>>();

  const dispatch = async (event: EventLike, escalation: Escalation): Promise<void> => {
    const report = await options.notifier.notify(escalation);
    const failed = report.channels.filter((result) => result.status === 'failed');
    if (report.outcome === 'failed' || failed.length > 0) {
      options.log(
        'error',
        `Escalation ${escalation.kind} not delivered on ${failed.map((r) => r.channel).join(', ') || 'any channel'}: ${report.detail ?? failed.map((r) => r.error).join('; ')}`,
        event.runId,
      );
    } else {
      const delivered = report.channels.filter((r) => r.status === 'sent').map((r) => r.channel);
      const skipped = report.channels.filter((r) => r.status === 'skipped').map((r) => r.channel);
      options.log(
        'info',
        `Escalation ${escalation.kind} ${report.outcome}${delivered.length ? ` via ${delivered.join(', ')}` : ''}${skipped.length ? ` (${skipped.join(', ')} skipped: severity routing)` : ''}`,
        event.runId,
      );
    }
    if (!recorder) return;
    for (const record of recordsFromReport(report, escalation, event.runId, recordId)) {
      try {
        await recorder.recordNotification(record);
      } catch (error) {
        options.log(
          'warn',
          `Notification record not persisted: ${error instanceof Error ? error.message : String(error)}`,
          event.runId,
        );
      }
    }
  };

  return {
    onEvent(raw) {
      try {
        const event = eventLike(raw);
        if (!event) return;
        const escalation = classify(event, options.context?.(event.runId) ?? {});
        if (!escalation) return;
        const work = dispatch(event, escalation)
          .catch((error: unknown) => {
            options.log(
              'error',
              `Escalation hook failed for ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
              event.runId,
            );
          })
          .finally(() => inFlight.delete(work));
        inFlight.add(work);
      } catch (error) {
        options.log(
          'error',
          `Escalation hook failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async close() {
      await Promise.allSettled([...inFlight]);
      await options.notifier.close();
    },
  };
}
