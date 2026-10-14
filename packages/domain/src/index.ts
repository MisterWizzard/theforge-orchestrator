import { createHash, randomUUID } from 'node:crypto';
import {
  NewNotificationSchema,
  UNATTRIBUTED_ROLE,
  type AuditChainVerification,
  type ForgeEvent,
  type NewNotification,
  type Notification,
  type NotificationStatus,
  type Run,
  type RunState,
  type Task,
  type TaskState,
  type UsageRecord,
  type UsageSummary,
} from '@theforge/contracts';

const activeRunStates: RunState[] = [
  'created',
  'context_gathering',
  'planning',
  'critique',
  'plan_revision',
  'executing',
  'reviewing',
  'verifying',
  'repairing',
  'integrating',
];
const runHappyPath: Partial<Record<RunState, RunState[]>> = {
  created: ['context_gathering'],
  context_gathering: ['planning'],
  planning: ['critique'],
  critique: ['plan_revision'],
  plan_revision: ['executing'],
  executing: ['reviewing', 'partially_completed'],
  reviewing: ['verifying', 'repairing'],
  verifying: ['repairing', 'integrating', 'partially_completed'],
  repairing: ['reviewing', 'verifying', 'partially_completed'],
  integrating: ['completed', 'partially_completed'],
};

export function canTransitionRun(from: RunState, to: RunState, resumeState?: RunState): boolean {
  if (from === to) return false;
  if (activeRunStates.includes(from) && ['paused', 'blocked', 'cancelled', 'failed'].includes(to))
    return true;
  if ((from === 'paused' || from === 'blocked') && to === resumeState) return true;
  return runHappyPath[from]?.includes(to) ?? false;
}

const taskTransitions: Record<TaskState, TaskState[]> = {
  queued: ['ready', 'blocked', 'deferred', 'cancelled'],
  ready: ['in_progress', 'blocked', 'deferred', 'cancelled'],
  in_progress: ['ready', 'blocked', 'review', 'verification', 'done', 'cancelled'],
  blocked: ['ready', 'deferred', 'cancelled'],
  review: ['in_progress', 'verification', 'blocked', 'cancelled'],
  verification: ['in_progress', 'done', 'blocked', 'cancelled'],
  done: [],
  deferred: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return from !== to && taskTransitions[from].includes(to);
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export type CommandResult<T> = { value: T; event: ForgeEvent; duplicate: boolean };

export interface ForgeRepository {
  getRun(id: string): Promise<Run | undefined>;
  putRun(run: Run): Promise<void>;
  getTask(id: string): Promise<Task | undefined>;
  putTask(task: Task): Promise<void>;
  listTasks(runId: string): Promise<Task[]>;
  appendEvent(event: ForgeEvent): Promise<boolean>;
  findEvent(idempotencyKey: string): Promise<ForgeEvent | undefined>;
  putRunAndEvent?(run: Run, event: ForgeEvent): Promise<void>;
  putTaskAndEvent?(task: Task, event: ForgeEvent): Promise<void>;
  /**
   * Recompute a run's event hash chain (ADR-020). A store that keeps no chain
   * answers ok with nothing checked rather than pretending to verify.
   */
  verifyEventChain(runId: string): Promise<AuditChainVerification>;
  /** Insert unless the dedupe key was seen before; true when inserted. */
  recordNotification(notification: NewNotification): Promise<boolean>;
  /**
   * Record a delivery outcome. 'sent' and 'failed' count as an attempt;
   * 'sent' also stamps sentAt. Resolves to the updated row, or undefined
   * when the id is unknown.
   */
  markNotification(
    id: string,
    status: NotificationStatus,
    error?: Record<string, unknown>,
  ): Promise<Notification | undefined>;
  listNotificationsSince(from: Date): Promise<Notification[]>;
  /**
   * Events with createdAt in [from, to) across every run, oldest first, limited
   * to `types` when given (an empty list matches nothing). The digests read
   * guard and failure events this way.
   */
  listEventsSince(from: Date, to?: Date, types?: readonly string[]): Promise<ForgeEvent[]>;
  upsertUsageRecord(usage: UsageRecord): Promise<void>;
  /** Records with createdAt in [from, to); `to` defaults to open-ended. */
  listUsageRecordsSince(from: Date, to?: Date): Promise<UsageRecord[]>;
  sumUsageSince(from: Date, to?: Date): Promise<UsageSummary>;
  /**
   * Metered calls - `costUsd > 0` - grouped by the role that incurred them,
   * over all time. Roleless records are left out entirely rather than grouped,
   * because this answers "is there enough evidence to recalibrate the per-role
   * cloud estimates" and a call with no role is no evidence either way.
   *
   * Counted rather than listed, for the reason `sumUsageSince` exists: the
   * digest reads this on every run and must not pull the whole ledger to do it.
   */
  countMeteredCallsByRole(): Promise<Record<string, number>>;
}

/** Totals for the ledger rows in a window, grouped the way the spend ceiling needs them. */
export function summariseUsage(records: readonly UsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    usd: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    count: 0,
    byProvider: {},
    byRole: {},
  };
  for (const record of records) {
    summary.usd += record.costUsd;
    summary.inputTokens += record.inputTokens;
    summary.cachedInputTokens += record.cachedInputTokens;
    summary.outputTokens += record.outputTokens;
    summary.count += 1;
    const provider = (summary.byProvider[record.provider] ??= { usd: 0, count: 0 });
    provider.usd += record.costUsd;
    provider.count += 1;
    // A roleless record is grouped, not dropped, so the role totals reconcile
    // with `usd`. The SQL summary groups the same way; the audit test holds the
    // two to the same answer.
    const role = (summary.byRole[record.role ?? UNATTRIBUTED_ROLE] ??= { usd: 0, count: 0 });
    role.usd += record.costUsd;
    role.count += 1;
  }
  return summary;
}

export class InMemoryForgeRepository implements ForgeRepository {
  readonly runs = new Map<string, Run>();
  readonly tasks = new Map<string, Task>();
  readonly events: ForgeEvent[] = [];
  readonly notifications = new Map<string, Notification>();
  readonly usageRecords: UsageRecord[] = [];
  async verifyEventChain(): Promise<AuditChainVerification> {
    // Nothing here is hashed, so there is nothing to check and nothing to claim.
    return { ok: true, checked: 0, legacy: 0 };
  }
  async recordNotification(notification: NewNotification) {
    const value = NewNotificationSchema.parse(notification);
    for (const existing of this.notifications.values()) {
      if (existing.dedupeKey === value.dedupeKey) return false;
    }
    this.notifications.set(value.id, {
      id: value.id,
      ...(value.runId ? { runId: value.runId } : {}),
      kind: value.kind,
      dedupeKey: value.dedupeKey,
      channel: value.channel,
      status: value.status,
      attempts: 0,
      payload: structuredClone(value.payload),
      createdAt: value.createdAt ?? new Date().toISOString(),
    });
    return true;
  }
  async markNotification(id: string, status: NotificationStatus, error?: Record<string, unknown>) {
    const current = this.notifications.get(id);
    if (!current) return undefined;
    const next: Notification = {
      ...current,
      status,
      attempts: current.attempts + (status === 'sent' || status === 'failed' ? 1 : 0),
      ...(status === 'sent' ? { sentAt: new Date().toISOString() } : {}),
    };
    if (error) next.lastError = structuredClone(error);
    else delete next.lastError;
    this.notifications.set(id, next);
    return structuredClone(next);
  }
  async listNotificationsSince(from: Date) {
    return [...this.notifications.values()]
      .filter((notification) => Date.parse(notification.createdAt) >= from.getTime())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((notification) => structuredClone(notification));
  }
  async listEventsSince(from: Date, to?: Date, types?: readonly string[]) {
    return (
      this.events
        .filter((event) => {
          const at = Date.parse(event.createdAt);
          return (
            at >= from.getTime() &&
            (to === undefined || at < to.getTime()) &&
            (types === undefined || types.includes(event.type))
          );
        })
        // Stable, so two events with one timestamp keep their append order, as
        // the sequence column orders them in PostgreSQL.
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((event) => structuredClone(event))
    );
  }
  async upsertUsageRecord(usage: UsageRecord) {
    const index = this.usageRecords.findIndex((record) => record.id === usage.id);
    if (index === -1) this.usageRecords.push(structuredClone(usage));
    else this.usageRecords[index] = structuredClone(usage);
  }
  async listUsageRecordsSince(from: Date, to?: Date) {
    return this.usageRecords
      .filter((record) => {
        const at = Date.parse(record.createdAt);
        return at >= from.getTime() && (to === undefined || at < to.getTime());
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
  async sumUsageSince(from: Date, to?: Date) {
    return summariseUsage(await this.listUsageRecordsSince(from, to));
  }
  async countMeteredCallsByRole(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const record of this.usageRecords) {
      if (record.costUsd <= 0 || !record.role) continue;
      counts[record.role] = (counts[record.role] ?? 0) + 1;
    }
    return counts;
  }
  async getRun(id: string) {
    return this.runs.get(id);
  }
  async putRun(run: Run) {
    this.runs.set(run.id, structuredClone(run));
  }
  async getTask(id: string) {
    return this.tasks.get(id);
  }
  async putTask(task: Task) {
    this.tasks.set(task.id, structuredClone(task));
  }
  async listTasks(runId: string) {
    return [...this.tasks.values()].filter((task) => task.runId === runId);
  }
  async appendEvent(event: ForgeEvent) {
    if (this.events.some((item) => item.idempotencyKey === event.idempotencyKey)) return false;
    this.events.push(structuredClone(event));
    return true;
  }
  async findEvent(key: string) {
    return this.events.find((event) => event.idempotencyKey === key);
  }
  async putRunAndEvent(run: Run, event: ForgeEvent) {
    if (!(await this.appendEvent(event))) return;
    await this.putRun(run);
  }
  async putTaskAndEvent(task: Task, event: ForgeEvent) {
    if (!(await this.appendEvent(event))) return;
    await this.putTask(task);
  }
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ForgeEngine {
  constructor(
    private readonly repository: ForgeRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async transitionRun(
    runId: string,
    to: RunState,
    idempotencyKey: string,
  ): Promise<CommandResult<Run>> {
    const duplicate = await this.repository.findEvent(idempotencyKey);
    const current = await this.repository.getRun(runId);
    if (!current) throw new DomainError('RUN_NOT_FOUND', `Run ${runId} was not found`);
    if (duplicate) return { value: current, event: duplicate, duplicate: true };
    if (!canTransitionRun(current.state, to, current.resumeState)) {
      throw new DomainError(
        'INVALID_RUN_TRANSITION',
        `${current.state} cannot transition to ${to}`,
      );
    }
    const now = this.clock.now().toISOString();
    const resumable =
      activeRunStates.includes(current.state) && (to === 'paused' || to === 'blocked');
    const next: Run = { ...current, state: to, updatedAt: now };
    if (resumable) next.resumeState = current.state;
    else if (to !== 'paused' && to !== 'blocked') delete next.resumeState;
    const event = makeEvent(
      runId,
      undefined,
      'run.transitioned',
      { from: current.state, to },
      idempotencyKey,
      now,
    );
    if (this.repository.putRunAndEvent) await this.repository.putRunAndEvent(next, event);
    else {
      await this.repository.putRun(next);
      await this.repository.appendEvent(event);
    }
    return { value: next, event, duplicate: false };
  }

  async transitionTask(
    taskId: string,
    to: TaskState,
    idempotencyKey: string,
  ): Promise<CommandResult<Task>> {
    const duplicate = await this.repository.findEvent(idempotencyKey);
    const current = await this.repository.getTask(taskId);
    if (!current) throw new DomainError('TASK_NOT_FOUND', `Task ${taskId} was not found`);
    if (duplicate) return { value: current, event: duplicate, duplicate: true };
    if (!canTransitionTask(current.state, to)) {
      throw new DomainError(
        'INVALID_TASK_TRANSITION',
        `${current.state} cannot transition to ${to}`,
      );
    }
    if (to === 'ready') {
      const tasks = await this.repository.listTasks(current.runId);
      const unresolved = current.dependencies.filter(
        (dependency) => tasks.find((task) => task.id === dependency)?.state !== 'done',
      );
      if (unresolved.length > 0)
        throw new DomainError('DEPENDENCIES_UNRESOLVED', unresolved.join(', '));
    }
    const now = this.clock.now().toISOString();
    const next: Task = { ...current, state: to, updatedAt: now };
    const event = makeEvent(
      current.runId,
      current.id,
      'task.transitioned',
      { from: current.state, to },
      idempotencyKey,
      now,
    );
    if (this.repository.putTaskAndEvent) await this.repository.putTaskAndEvent(next, event);
    else {
      await this.repository.putTask(next);
      await this.repository.appendEvent(event);
    }
    return { value: next, event, duplicate: false };
  }

  async refreshReadiness(runId: string): Promise<Task[]> {
    const tasks = await this.repository.listTasks(runId);
    const done = new Set(tasks.filter((task) => task.state === 'done').map((task) => task.id));
    for (const task of tasks.filter(
      (item) => item.state === 'queued' && item.dependencies.every((id) => done.has(id)),
    )) {
      await this.transitionTask(
        task.id,
        'ready',
        `readiness:${task.id}:${hash([...done].sort().join(','))}`,
      );
    }
    return this.repository.listTasks(runId);
  }
}

function makeEvent(
  runId: string,
  taskId: string | undefined,
  type: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  createdAt: string,
): ForgeEvent {
  return {
    id: randomUUID(),
    runId,
    ...(taskId ? { taskId } : {}),
    type,
    payload,
    idempotencyKey,
    createdAt,
  };
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
