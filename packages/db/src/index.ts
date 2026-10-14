import postgres, { type JSONValue, type Sql, type TransactionSql } from 'postgres';
import {
  UNATTRIBUTED_ROLE,
  AgentMessageSchema,
  ArtifactSchema,
  AttemptSchema,
  BlockerSchema,
  DecisionSchema,
  EventSchema,
  ApprovalSchema,
  FindingSchema,
  RunSchema,
  TaskSchema,
  UsageRecordSchema,
  WorkerSchema,
  NewNotificationSchema,
  NotificationSchema,
  ProviderEventSchema,
  ProviderRequestSchema,
  providerIds,
  type AgentMessage,
  type Artifact,
  type Attempt,
  type AuditChainVerification,
  type Blocker,
  type Decision,
  type ForgeEvent,
  type Approval,
  type Finding,
  type NewNotification,
  type Notification,
  type NotificationStatus,
  type Run,
  type Task,
  type UsageRecord,
  type UsageSummary,
  type Worker,
  type ProviderEvent,
  type ProviderId,
  type ProviderRequest,
} from '@theforge/contracts';
import type { ForgeRepository } from '@theforge/domain';
import { GENESIS_HASH, eventRowHash } from './audit-chain.js';

export {
  GENESIS_HASH,
  canonicalEventString,
  canonicalJsonb,
  eventRowHash,
  type ChainedEventFields,
} from './audit-chain.js';

/**
 * Lift the append-only guard on the audit tables for the rest of the current
 * transaction (migration 006). Retention uses it to delete whole runs, and a
 * test uses it to tamper with rows on purpose; nothing else should.
 */
export async function allowEventDeletion(tx: Sql | TransactionSql): Promise<void> {
  await tx`select set_config('forge.allow_event_delete', 'on', true)`;
}

type EventRow = {
  sequence: string | number;
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  type: string;
  payload: unknown;
  idempotency_key: string;
  created_at: Date;
  prev_hash: string | null;
  row_hash: string | null;
};
type NotificationRow = {
  id: string;
  run_id: string | null;
  kind: string;
  dedupe_key: string;
  channel: string;
  status: string;
  attempts: number;
  payload: unknown;
  last_error: unknown;
  created_at: Date;
  sent_at: Date | null;
};

type RunRow = {
  id: string;
  project_id: string;
  objective: string;
  constraints: unknown;
  state: string;
  resume_state: string | null;
  budget: unknown;
  spent: unknown;
  configuration: unknown;
  created_at: Date;
  updated_at: Date;
};
type TaskRow = {
  id: string;
  run_id: string;
  title: string;
  description: string;
  state: string;
  priority: number;
  acceptance_criteria: unknown;
  required_capabilities: unknown;
  file_ownership: unknown;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  updated_at: Date;
};
type AttemptRow = {
  id: string;
  task_id: string;
  worker_id: string | null;
  provider: string | null;
  provider_session_id: string | null;
  workspace_path: string | null;
  state: string;
  started_at: Date | null;
  finished_at: Date | null;
  error: unknown;
};

export type WorkerWorkspaceFile = {
  path: string;
  contentBase64: string;
  executable: boolean;
};
export type WorkerWorkspaceSnapshot = {
  repositoryUrl: string;
  revision: string;
  patch: string;
  untrackedFiles: WorkerWorkspaceFile[];
};
type WorkerWorkspaceAction = {
  workspace: WorkerWorkspaceSnapshot;
  workingDirectory: string;
};
/** One command inside a stepped job; see `steps` below. */
export type WorkerJobStep = {
  executable: string;
  args: string[];
  network?: 'none' | 'install' | undefined;
  /**
   * End the sequence when this step fails, instead of running the rest.
   *
   * Set for an install step and not for a check. A failed install makes every
   * check after it meaningless - that is the 127-times-three of 04/10/2026 -
   * while a failed check must not stop the others, because the revision loop
   * fixes what it is shown and a lint failure hiding a test failure costs a
   * whole extra attempt.
   */
  stopOnFailure?: boolean | undefined;
};
export type WorkerCommandJobAction = WorkerWorkspaceAction & {
  kind?: 'command' | undefined;
  executable: string;
  args: string[];
  /**
   * Several commands run in sequence in **one** materialised workspace, each in
   * its own container with its own network boundary.
   *
   * This exists because the workspace does not outlive a job: the worker
   * materialises `.job-<jobId>` and removes it in a `finally`, which is also
   * the failed-workspace retention path. So no command can see what an earlier
   * job produced, and an install step in a job of its own is useless - on
   * attempt eleven of the first real objective `npm ci` exited 0 and the three
   * checks needing its output still reported 127, each in a fresh copy of the
   * repository.
   *
   * `executable`/`args` stay populated with the first step, so anything reading
   * an action's command - a log line, the idempotency key, a reader written
   * against the old shape - still sees something true.
   */
  steps?: WorkerJobStep[] | undefined;
  /**
   * `install` asks the worker to run this one command in a sandbox that has
   * network access, so a project's dependencies can be fetched. Absent for
   * everything else, which is almost everything, and the worker then uses
   * `--network none` as it always has.
   */
  network?: 'none' | 'install' | undefined;
};
export type WorkerProviderJobAction = WorkerWorkspaceAction & {
  kind: 'provider';
  providerId: ProviderId;
  request: ProviderRequest;
};
export type WorkerJobAction = WorkerCommandJobAction | WorkerProviderJobAction;
export type WorkerJobState =
  'queued' | 'leased' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed';
export type WorkerJob = {
  id: string;
  runId: string;
  taskId?: string | undefined;
  attemptId?: string | undefined;
  idempotencyKey?: string | undefined;
  priority?: number | undefined;
  availableAt?: number | undefined;
  action: WorkerJobAction;
  requiredCapabilities: string[];
  state: WorkerJobState;
  workerId?: string | undefined;
  leaseToken?: string | undefined;
  leaseExpiresAt?: number | undefined;
  approval?: Approval;
  result?: {
    code: number;
    stdout: string;
    stderr: string;
    /**
     * Per-step outcomes for a stepped job, in order, stopping at the first
     * failure. The top-level `code` is that failure's, or 0 when all passed.
     */
    steps?: Array<{ command: string; code: number; stdout: string; stderr: string }>;
    events?: ProviderEvent[];
    patch?: string;
    retainedWorkspace?: string;
    rawStdoutTail?: string;
    rawStderrTail?: string;
  };
};
type WorkerJobRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  idempotency_key: string | null;
  priority: number;
  available_at: Date;
  action: unknown;
  required_capabilities: unknown;
  state: string;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  approval: unknown;
  result: unknown;
};

export function createDatabase(url = process.env.DATABASE_URL): Sql {
  if (!url) throw new Error('DATABASE_URL is required');
  return postgres(url, { max: 10, idle_timeout: 20, connect_timeout: 10 });
}

/**
 * A lease taken back from a worker because it expired. Reported by
 * `leaseNextWorkerJob` so the coordinator can record it; see that method for
 * why it was invisible before 04/10/2026.
 */
export type ReclaimedWorkerJobLease = {
  jobId: string;
  runId: string;
  previousWorkerId?: string | undefined;
  leaseExpiredAt?: string | undefined;
  overdueMs?: number | undefined;
};

export class PostgresForgeRepository implements ForgeRepository {
  constructor(private readonly sql: Sql) {}

  async getRun(id: string): Promise<Run | undefined> {
    const [row] = await this.sql<RunRow[]>`select * from runs where id=${id}`;
    return row ? mapRun(row) : undefined;
  }
  async listRuns(): Promise<Run[]> {
    const rows = await this.sql<RunRow[]>`select * from runs order by created_at desc`;
    return rows.map(mapRun);
  }
  /**
   * Upsert a project, checks included.
   *
   * **`checks` is stored inside the `policy` jsonb column**, not in a column of
   * its own - which is easy to miss when reading `\d projects`, since nothing in
   * the table's shape mentions them. `listProjects` unwraps them again and the
   * coordinator repopulates its in-memory registry from it on boot, so a
   * project's checks do survive a restart. Said explicitly because the absence
   * of a `checks` column was read as the absence of persistence, and the
   * round-trip is now pinned by a test rather than left to be re-derived.
   */
  async ensureProject(project: {
    id: string;
    name: string;
    repositoryUrl: string;
    defaultBranch?: string;
    checks?: Array<{ executable: string; args: string[] }>;
    /** Dependency-fetching commands; see `install` on the coordinator's Project. */
    install?: Array<{ executable: string; args: string[] }>;
  }): Promise<void> {
    await this.sql`insert into projects (id,name,repository_url,default_branch,policy)
      values (${project.id},${project.name},${project.repositoryUrl},${project.defaultBranch ?? 'main'},${this.sql.json({ checks: project.checks ?? [], install: project.install ?? [] })})
      on conflict (id) do update set name=excluded.name,repository_url=excluded.repository_url,
      default_branch=excluded.default_branch,policy=excluded.policy,updated_at=now()`;
  }
  async listProjects(): Promise<
    Array<{
      id: string;
      name: string;
      repositoryUrl: string;
      baseRef: string;
      checks: Array<{ executable: string; args: string[] }>;
      install: Array<{ executable: string; args: string[] }>;
    }>
  > {
    const rows = await this.sql<
      Array<{
        id: string;
        name: string;
        repository_url: string;
        default_branch: string;
        policy: unknown;
      }>
    >`select id,name,repository_url,default_branch,policy from projects order by created_at`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      repositoryUrl: row.repository_url,
      baseRef: row.default_branch,
      checks: parseProjectChecks(row.policy),
      // Absent for every project registered before 05/10/2026, which reads
      // back as `[]` - no install step, no network, exactly as before.
      install: parseProjectChecks(row.policy, 'install'),
    }));
  }
  async putRun(run: Run): Promise<void> {
    await this
      .sql`insert into runs (id,project_id,objective,constraints,state,resume_state,budget,spent,configuration,created_at,updated_at)
      values (${run.id},${run.projectId},${run.objective},${this.sql.json(run.constraints)},${run.state},${run.resumeState ?? null},${this.sql.json(run.budget)},${this.sql.json(run.spent)},${this.sql.json(run.configuration ?? {})},${run.createdAt},${run.updatedAt})
      on conflict (id) do update set objective=excluded.objective,constraints=excluded.constraints,state=excluded.state,
      resume_state=excluded.resume_state,budget=excluded.budget,spent=excluded.spent,
      configuration=excluded.configuration,updated_at=excluded.updated_at`;
  }
  async putRunAndEvent(run: Run, event: ForgeEvent): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`update runs set state=${run.state},resume_state=${run.resumeState ?? null},budget=${tx.json(run.budget)},spent=${tx.json(run.spent)},updated_at=${run.updatedAt} where id=${run.id}`;
      await tx`insert into events (id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at)
        values (${event.id},${event.runId},${event.taskId ?? null},${event.attemptId ?? null},${event.type},${tx.json(event.payload as JSONValue)},${event.idempotencyKey},${event.createdAt})`;
    });
  }
  async getTask(id: string): Promise<Task | undefined> {
    const [row] = await this.sql<TaskRow[]>`select * from tasks where id=${id}`;
    if (!row) return undefined;
    const dependencies = await this.sql<
      { depends_on_id: string }[]
    >`select depends_on_id from task_dependencies where task_id=${id}`;
    return mapTask(
      row,
      dependencies.map((item) => item.depends_on_id),
    );
  }
  async putTask(task: Task): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`insert into tasks (id,run_id,title,description,state,priority,acceptance_criteria,required_capabilities,file_ownership,attempts,max_attempts,created_at,updated_at)
        values (${task.id},${task.runId},${task.title},${task.description},${task.state},${task.priority},${tx.json(task.acceptanceCriteria)},${tx.json(task.requiredCapabilities)},${tx.json(task.fileOwnership)},${task.attempts},${task.maxAttempts},${task.createdAt},${task.updatedAt})
        on conflict (id) do update set title=excluded.title,description=excluded.description,state=excluded.state,priority=excluded.priority,
        acceptance_criteria=excluded.acceptance_criteria,required_capabilities=excluded.required_capabilities,file_ownership=excluded.file_ownership,
        attempts=excluded.attempts,max_attempts=excluded.max_attempts,updated_at=excluded.updated_at`;
      await tx`delete from task_dependencies where task_id=${task.id}`;
      for (const dependency of task.dependencies)
        await tx`insert into task_dependencies (task_id,depends_on_id) values (${task.id},${dependency})`;
    });
  }
  async putTaskAndEvent(task: Task, event: ForgeEvent): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`update tasks set state=${task.state},attempts=${task.attempts},updated_at=${task.updatedAt} where id=${task.id}`;
      await tx`insert into events (id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at)
        values (${event.id},${event.runId},${event.taskId ?? null},${event.attemptId ?? null},${event.type},${tx.json(event.payload as JSONValue)},${event.idempotencyKey},${event.createdAt})`;
    });
  }
  async listTasks(runId: string): Promise<Task[]> {
    const rows = await this.sql<
      TaskRow[]
    >`select * from tasks where run_id=${runId} order by priority desc, created_at`;
    const edges = await this.sql<
      { task_id: string; depends_on_id: string }[]
    >`select task_id,depends_on_id from task_dependencies where task_id in (select id from tasks where run_id=${runId})`;
    return rows.map((row) =>
      mapTask(
        row,
        edges.filter((edge) => edge.task_id === row.id).map((edge) => edge.depends_on_id),
      ),
    );
  }
  async getAttempt(id: string): Promise<Attempt | undefined> {
    const [row] = await this.sql<AttemptRow[]>`select
        id,task_id,worker_id,provider,provider_session_id,workspace_path,state,
        started_at,finished_at,error
      from attempts where id=${id}`;
    return row ? mapAttempt(row) : undefined;
  }
  async upsertAttempt(attempt: Attempt): Promise<void> {
    const value = AttemptSchema.parse(attempt);
    await this.sql`insert into attempts
      (id,task_id,worker_id,provider,provider_session_id,workspace_path,state,started_at,finished_at,error)
      values (
        ${value.id},${value.taskId},${value.workerId ?? null},${value.provider ?? null},
        ${value.providerSessionId ?? null},${value.workspacePath ?? null},${value.state},
        ${value.startedAt ?? null},${value.finishedAt ?? null},
        ${value.error ? this.sql.json(value.error as JSONValue) : null}
      )
      on conflict (id) do update set
        task_id=excluded.task_id,worker_id=excluded.worker_id,provider=excluded.provider,
        provider_session_id=excluded.provider_session_id,workspace_path=excluded.workspace_path,
        state=excluded.state,started_at=excluded.started_at,finished_at=excluded.finished_at,
        error=excluded.error`;
  }
  async setAttemptProviderSession(
    attemptId: string,
    providerSessionId: string,
  ): Promise<Attempt | undefined> {
    const [row] = await this.sql<AttemptRow[]>`update attempts
      set provider_session_id=${providerSessionId}
      where id=${attemptId}
      returning id,task_id,worker_id,provider,provider_session_id,workspace_path,state,
        started_at,finished_at,error`;
    return row ? mapAttempt(row) : undefined;
  }
  async listAttempts(runId: string, taskId?: string): Promise<Attempt[]> {
    const rows = taskId
      ? await this.sql<AttemptRow[]>`select
          a.id,a.task_id,a.worker_id,a.provider,a.provider_session_id,a.workspace_path,a.state,
          a.started_at,a.finished_at,a.error
        from attempts a join tasks t on t.id=a.task_id
        where t.run_id=${runId} and a.task_id=${taskId}
        order by a.started_at nulls last,a.id`
      : await this.sql<AttemptRow[]>`select
          a.id,a.task_id,a.worker_id,a.provider,a.provider_session_id,a.workspace_path,a.state,
          a.started_at,a.finished_at,a.error
        from attempts a join tasks t on t.id=a.task_id
        where t.run_id=${runId}
        order by a.started_at nulls last,a.id`;
    return rows.map(mapAttempt);
  }
  async appendMessage(message: AgentMessage): Promise<boolean> {
    const value = AgentMessageSchema.parse(message);
    const rows = await this.sql`insert into messages
      (id,run_id,task_id,attempt_id,type,sender,claim,requested_action,evidence,criteria,
        confidence,uncertainty,idempotency_key,created_at)
      values (
        ${value.id},${value.runId},${value.taskId ?? null},${value.attemptId ?? null},
        ${value.type},${this.sql.json(value.sender)},${value.claim},${value.requestedAction ?? null},
        ${this.sql.json(value.evidence)},${this.sql.json(value.criteria)},${value.confidence},
        ${value.uncertainty ?? null},${value.idempotencyKey},${value.timestamp}
      ) on conflict do nothing returning id`;
    return rows.length === 1;
  }
  async listMessages(runId: string, taskId?: string): Promise<AgentMessage[]> {
    const rows = taskId
      ? await this.sql<Record<string, unknown>[]>`select * from messages
          where run_id=${runId} and task_id=${taskId} order by created_at,id`
      : await this.sql<Record<string, unknown>[]>`select * from messages
          where run_id=${runId} order by created_at,id`;
    return rows.map(mapMessage);
  }
  async upsertFinding(finding: Finding): Promise<void> {
    const value = FindingSchema.parse(finding);
    await this.sql`insert into findings
      (id,run_id,task_id,claim,severity,evidence,affected_criterion,requested_action,status)
      values (
        ${value.id},${value.runId},${value.taskId},${value.claim},${value.severity},
        ${this.sql.json(value.evidence)},${value.affectedCriterion},${value.requestedAction},
        ${value.status}
      ) on conflict (id) do update set
        claim=excluded.claim,severity=excluded.severity,evidence=excluded.evidence,
        affected_criterion=excluded.affected_criterion,requested_action=excluded.requested_action,
        status=excluded.status`;
  }
  async listFindings(runId: string, taskId?: string): Promise<Finding[]> {
    const rows = taskId
      ? await this.sql<Record<string, unknown>[]>`select * from findings
          where run_id=${runId} and task_id=${taskId} order by id`
      : await this.sql<Record<string, unknown>[]>`select * from findings
          where run_id=${runId} order by id`;
    return rows.map(mapFinding);
  }
  async upsertDecision(decision: Decision): Promise<void> {
    const value = DecisionSchema.parse(decision);
    await this.sql`insert into decisions (id,run_id,title,rationale,status,evidence,created_at)
      values (
        ${value.id},${value.runId},${value.title},${value.rationale},${value.status},
        ${this.sql.json(value.evidence)},${value.createdAt}
      ) on conflict (id) do update set
        title=excluded.title,rationale=excluded.rationale,status=excluded.status,
        evidence=excluded.evidence`;
  }
  async listDecisions(runId: string): Promise<Decision[]> {
    const rows = await this.sql<
      Record<string, unknown>[]
    >`select * from decisions where run_id=${runId} order by created_at,id`;
    return rows.map(mapDecision);
  }
  async upsertBlocker(blocker: Blocker): Promise<void> {
    const value = BlockerSchema.parse(blocker);
    await this.sql`insert into blockers
      (id,run_id,task_id,classification,summary,evidence,impact,attempts,workaround,
        smallest_unblock_action,status,created_at,updated_at)
      values (
        ${value.id},${value.runId},${value.taskId},${value.classification},${value.summary},
        ${this.sql.json(value.evidence)},${value.impact},${this.sql.json(value.attempts)},
        ${value.workaround ?? null},${value.smallestUnblockAction},${value.status},now(),now()
      ) on conflict (id) do update set
        classification=excluded.classification,summary=excluded.summary,evidence=excluded.evidence,
        impact=excluded.impact,attempts=excluded.attempts,workaround=excluded.workaround,
        smallest_unblock_action=excluded.smallest_unblock_action,status=excluded.status,
        updated_at=now()`;
  }
  async listBlockers(runId: string, taskId?: string): Promise<Blocker[]> {
    const rows = taskId
      ? await this.sql<Record<string, unknown>[]>`select * from blockers
          where run_id=${runId} and task_id=${taskId} order by created_at,id`
      : await this.sql<Record<string, unknown>[]>`select * from blockers
          where run_id=${runId} order by created_at,id`;
    return rows.map(mapBlocker);
  }
  async upsertArtifact(artifact: Artifact): Promise<void> {
    const value = ArtifactSchema.parse(artifact);
    await this.sql`insert into artifacts
      (id,run_id,task_id,attempt_id,kind,label,uri,sha256,metadata,created_at)
      values (
        ${value.id},${value.runId},${value.taskId ?? null},${value.attemptId ?? null},
        ${value.kind},${value.label},${value.uri},${value.sha256 ?? null},
        ${this.sql.json(value.metadata as JSONValue)},${value.createdAt}
      ) on conflict (id) do update set
        task_id=excluded.task_id,attempt_id=excluded.attempt_id,kind=excluded.kind,
        label=excluded.label,uri=excluded.uri,sha256=excluded.sha256,metadata=excluded.metadata`;
  }
  async listArtifacts(runId: string, taskId?: string): Promise<Artifact[]> {
    const rows = taskId
      ? await this.sql<Record<string, unknown>[]>`select * from artifacts
          where run_id=${runId} and task_id=${taskId} order by created_at,id`
      : await this.sql<Record<string, unknown>[]>`select * from artifacts
          where run_id=${runId} order by created_at,id`;
    return rows.map(mapArtifact);
  }
  async upsertUsageRecord(usage: UsageRecord): Promise<void> {
    const value = UsageRecordSchema.parse(usage);
    await this.sql`insert into usage_records
      (id,run_id,task_id,attempt_id,provider,model,role,input_tokens,cached_input_tokens,
        output_tokens,cost_usd,elapsed_ms,tools,created_at)
      values (
        ${value.id},${value.runId},${value.taskId ?? null},${value.attemptId ?? null},
        ${value.provider},${value.model ?? null},${value.role ?? null},${value.inputTokens},
        ${value.cachedInputTokens},${value.outputTokens},
        ${value.costUsd},${value.elapsedMs},${this.sql.json(value.tools)},${value.createdAt}
      ) on conflict (id) do update set
        task_id=excluded.task_id,attempt_id=excluded.attempt_id,provider=excluded.provider,
        model=excluded.model,role=excluded.role,input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,output_tokens=excluded.output_tokens,
        cost_usd=excluded.cost_usd,elapsed_ms=excluded.elapsed_ms,tools=excluded.tools`;
  }
  async listUsageRecords(runId: string, taskId?: string): Promise<UsageRecord[]> {
    const rows = taskId
      ? await this.sql<Record<string, unknown>[]>`select * from usage_records
          where run_id=${runId} and task_id=${taskId} order by created_at,id`
      : await this.sql<Record<string, unknown>[]>`select * from usage_records
          where run_id=${runId} order by created_at,id`;
    return rows.map(mapUsageRecord);
  }
  async appendEvent(event: ForgeEvent): Promise<boolean> {
    const rows = await this
      .sql`insert into events (id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at)
      values (${event.id},${event.runId},${event.taskId ?? null},${event.attemptId ?? null},${event.type},${this.sql.json(event.payload as JSONValue)},${event.idempotencyKey},${event.createdAt})
      on conflict (idempotency_key) do nothing returning id`;
    return rows.length === 1;
  }
  async findEvent(key: string): Promise<ForgeEvent | undefined> {
    const [row] = await this.sql<
      EventRow[]
    >`select sequence,id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at,prev_hash,row_hash from events where idempotency_key=${key}`;
    return row ? mapEvent(row) : undefined;
  }
  async listEvents(runId: string): Promise<ForgeEvent[]> {
    const rows = await this.sql<
      EventRow[]
    >`select sequence,id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at,prev_hash,row_hash from events where run_id=${runId} order by sequence`;
    return rows.map(mapEvent);
  }
  async listEventsSince(from: Date, to?: Date, types?: readonly string[]): Promise<ForgeEvent[]> {
    // An explicit empty type list asks for nothing; `in ()` is not SQL.
    if (types !== undefined && types.length === 0) return [];
    const rows = await this.sql<
      EventRow[]
    >`select sequence,id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at,prev_hash,row_hash
      from events
      where created_at >= ${from.toISOString()}
        ${to ? this.sql`and created_at < ${to.toISOString()}` : this.sql``}
        ${types ? this.sql`and type in ${this.sql([...types])}` : this.sql``}
      order by created_at,sequence`;
    return rows.map(mapEvent);
  }
  /**
   * Walk a run's events in sequence order and recompute the chain the insert
   * trigger built (see audit-chain.ts for the rule). Reports the first row that
   * does not fit: a row whose content no longer hashes to its row_hash, or a
   * row whose prev_hash is not the previous row's row_hash, which is what a
   * removed, reordered or re-hashed predecessor looks like. Removing the last
   * row of a run leaves nothing behind to disagree; retention's tombstone is
   * the record of where a chain legitimately ended.
   */
  async verifyEventChain(runId: string): Promise<AuditChainVerification> {
    const rows = await this.sql<
      EventRow[]
    >`select sequence,id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at,prev_hash,row_hash from events where run_id=${runId} order by sequence`;
    let expectedPrev = GENESIS_HASH;
    let checked = 0;
    let legacy = 0;
    for (const row of rows) {
      const sequence = Number(row.sequence);
      const bad = (reason: string): AuditChainVerification => ({
        ok: false,
        checked,
        legacy,
        firstBad: { sequence, reason },
      });
      if (row.row_hash === null || row.prev_hash === null) {
        // Rows from before migration 006 precede the chain and are unverifiable;
        // an unhashed row after the chain has started is not legacy, it is damage.
        if (checked > 0) return bad('row has no hash although the chain had already started');
        legacy += 1;
        continue;
      }
      if (row.prev_hash !== expectedPrev) {
        return bad(
          `prev_hash ${row.prev_hash} does not link to the previous row (expected ${expectedPrev})`,
        );
      }
      const recomputed = eventRowHash({
        sequence,
        id: row.id,
        runId: row.run_id,
        taskId: row.task_id,
        attemptId: row.attempt_id,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at,
        prevHash: row.prev_hash,
      });
      if (recomputed !== row.row_hash) {
        return bad(
          `row_hash ${row.row_hash} does not match the row content (recomputed ${recomputed})`,
        );
      }
      expectedPrev = row.row_hash;
      checked += 1;
    }
    return { ok: true, checked, legacy };
  }
  async recordNotification(notification: NewNotification): Promise<boolean> {
    const value = NewNotificationSchema.parse(notification);
    const rows = await this.sql`insert into notifications
      (id,run_id,kind,dedupe_key,channel,status,attempts,payload,last_error,created_at)
      values (
        ${value.id},${value.runId ?? null},${value.kind},${value.dedupeKey},${value.channel},
        ${value.status},${value.attempts},${this.sql.json(value.payload as JSONValue)},
        ${value.lastError ? this.sql.json(value.lastError as JSONValue) : null},
        ${value.createdAt ?? new Date().toISOString()}
      ) on conflict (dedupe_key, channel) do nothing returning id`;
    return rows.length === 1;
  }
  async markNotification(
    id: string,
    status: NotificationStatus,
    error?: Record<string, unknown>,
  ): Promise<Notification | undefined> {
    const attempted = status === 'sent' || status === 'failed';
    const [row] = await this.sql<NotificationRow[]>`update notifications set
        status=${status},
        attempts=attempts + ${attempted ? 1 : 0},
        last_error=${error ? this.sql.json(error as JSONValue) : null},
        sent_at=case when ${status}::text = 'sent' then now() else sent_at end
      where id=${id}
      returning id,run_id,kind,dedupe_key,channel,status,attempts,payload,last_error,created_at,sent_at`;
    return row ? mapNotification(row) : undefined;
  }
  async listNotificationsSince(from: Date): Promise<Notification[]> {
    const rows = await this.sql<NotificationRow[]>`select
        id,run_id,kind,dedupe_key,channel,status,attempts,payload,last_error,created_at,sent_at
      from notifications where created_at >= ${from.toISOString()} order by created_at,id`;
    return rows.map(mapNotification);
  }
  async listUsageRecordsSince(from: Date, to?: Date): Promise<UsageRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`select * from usage_records
      where created_at >= ${from.toISOString()}
        ${to ? this.sql`and created_at < ${to.toISOString()}` : this.sql``}
      order by created_at,id`;
    return rows.map(mapUsageRecord);
  }
  async sumUsageSince(from: Date, to?: Date): Promise<UsageSummary> {
    // Summed in SQL so the daily ceiling check does not pull every row; the
    // in-memory repository sums the same rows with summariseUsage and the audit
    // test holds the two to the same answer.
    // Grouped by provider AND role so one query feeds both breakdowns. A
    // provider therefore spans several rows, so `byProvider` accumulates rather
    // than assigns - it used to assign, which was correct only while the group
    // key was the provider alone.
    const rows = await this.sql<
      Array<{
        provider: string;
        role: string | null;
        count: string;
        usd: string;
        input_tokens: string;
        cached_input_tokens: string;
        output_tokens: string;
      }>
    >`select provider,role,count(*)::text as count,coalesce(sum(cost_usd),0)::text as usd,
        coalesce(sum(input_tokens),0)::text as input_tokens,
        coalesce(sum(cached_input_tokens),0)::text as cached_input_tokens,
        coalesce(sum(output_tokens),0)::text as output_tokens
      from usage_records
      where created_at >= ${from.toISOString()}
        ${to ? this.sql`and created_at < ${to.toISOString()}` : this.sql``}
      group by provider,role order by provider,role`;
    const summary: UsageSummary = {
      usd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      count: 0,
      byProvider: {},
      byRole: {},
    };
    for (const row of rows) {
      const usd = Number(row.usd);
      const count = Number(row.count);
      summary.usd += usd;
      summary.inputTokens += Number(row.input_tokens);
      summary.cachedInputTokens += Number(row.cached_input_tokens);
      summary.outputTokens += Number(row.output_tokens);
      summary.count += count;
      const provider = (summary.byProvider[row.provider] ??= { usd: 0, count: 0 });
      provider.usd += usd;
      provider.count += count;
      const role = (summary.byRole[row.role ?? UNATTRIBUTED_ROLE] ??= { usd: 0, count: 0 });
      role.usd += usd;
      role.count += count;
    }
    return summary;
  }
  async countMeteredCallsByRole(): Promise<Record<string, number>> {
    const rows = await this.sql<Array<{ role: string; count: string }>>`
      select role,count(*)::text as count from usage_records
      where role is not null and cost_usd > 0
      group by role order by role`;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.role] = Number(row.count);
    return counts;
  }
  async upsertWorker(worker: Worker, credentialDigest = '0'.repeat(64)): Promise<void> {
    await this
      .sql`insert into workers (id,name,platform,capabilities,policy_profile,credential_digest,status,lease_expires_at,last_heartbeat_at)
      values (${worker.id},${worker.name},${worker.platform},${this.sql.json(worker.capabilities)},${worker.policyProfile},${credentialDigest},${worker.status},${new Date(Date.now() + 60_000).toISOString()},${worker.lastHeartbeatAt})
      on conflict (id) do update set name=excluded.name,platform=excluded.platform,capabilities=excluded.capabilities,
      policy_profile=excluded.policy_profile,status=excluded.status,lease_expires_at=excluded.lease_expires_at,
      last_heartbeat_at=excluded.last_heartbeat_at`;
  }
  async listWorkers(): Promise<Worker[]> {
    const rows = await this.sql<Record<string, unknown>[]>`select * from workers order by name`;
    return rows.map((row) =>
      WorkerSchema.parse({
        id: row.id,
        name: row.name,
        platform: row.platform,
        capabilities: row.capabilities,
        policyProfile: row.policy_profile,
        status: row.status,
        lastHeartbeatAt: (row.last_heartbeat_at as Date).toISOString(),
      }),
    );
  }
  async upsertWorkerJob(job: WorkerJob): Promise<void> {
    await this.sql`insert into worker_jobs
      (id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result)
      values (
        ${job.id},${job.runId},${job.taskId ?? null},${job.attemptId ?? null},${job.idempotencyKey ?? null},
        ${job.priority ?? 0},${new Date(job.availableAt ?? Date.now()).toISOString()},${this.sql.json(job.action as unknown as JSONValue)},
        ${this.sql.json(job.requiredCapabilities)},${job.state},${job.workerId ?? null},
        ${job.leaseToken ?? null},${job.leaseExpiresAt ? new Date(job.leaseExpiresAt).toISOString() : null},
        ${job.approval ? this.sql.json(job.approval) : null},
        ${job.result ? this.sql.json(job.result as unknown as JSONValue) : null}
      )
      on conflict (id) do update set
        run_id=excluded.run_id,action=excluded.action,
        task_id=excluded.task_id,attempt_id=excluded.attempt_id,idempotency_key=excluded.idempotency_key,
        priority=excluded.priority,available_at=excluded.available_at,
        required_capabilities=excluded.required_capabilities,state=excluded.state,
        worker_id=excluded.worker_id,lease_token=excluded.lease_token,
        lease_expires_at=excluded.lease_expires_at,approval=excluded.approval,
        result=excluded.result,updated_at=now()`;
  }
  async listWorkerJobs(runId?: string): Promise<WorkerJob[]> {
    const rows = runId
      ? await this.sql<
          WorkerJobRow[]
        >`select id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result
          from worker_jobs where run_id=${runId} and action ? 'workspace' order by created_at,id`
      : await this.sql<
          WorkerJobRow[]
        >`select id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result
          from worker_jobs where action ? 'workspace' order by created_at,id`;
    return rows.map(mapWorkerJob);
  }
  async createAttemptWorkerJob(
    taskId: string,
    attemptId: string,
    job: WorkerJob,
  ): Promise<WorkerJob> {
    return this.sql.begin(async (tx) => {
      if (job.idempotencyKey) {
        const [existing] = await tx<WorkerJobRow[]>`select
            id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,
            required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result
          from worker_jobs where idempotency_key=${job.idempotencyKey}`;
        if (existing) return mapWorkerJob(existing);
      }
      const [task] = await tx<
        Array<{ id: string; attempts: number; max_attempts: number }>
      >`select id,attempts,max_attempts from tasks where id=${taskId} for update`;
      if (!task) throw new Error(`Task ${taskId} was not found`);
      if (task.attempts >= task.max_attempts)
        throw new Error(`Task ${taskId} exhausted its ${task.max_attempts} attempts`);
      await tx`insert into attempts
        (id,task_id,state,workspace_path,started_at)
        values (${attemptId},${taskId},'queued',${`${job.action.workspace.repositoryUrl}#${job.action.workspace.revision}`},now())`;
      await tx`insert into worker_jobs
        (id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,required_capabilities,state)
        values (${job.id},${job.runId},${taskId},${attemptId},${job.idempotencyKey ?? job.id},
          ${job.priority ?? 0},${new Date(job.availableAt ?? Date.now()).toISOString()},
          ${tx.json(job.action as unknown as JSONValue)},${tx.json(job.requiredCapabilities)},'queued')`;
      await tx`update tasks set state='in_progress',attempts=attempts+1,updated_at=now() where id=${taskId}`;
      return job;
    });
  }
  /**
   * Lease the next compatible job, reclaiming any lease that has expired first.
   *
   * `options.onReclaim` is how a reclaim becomes visible. Until 04/10/2026 the
   * `recoveredLeases` statement below took a lease away from a worker and said
   * nothing at all: the only trace was a second `worker_job.leased` event
   * indistinguishable from a first, and `worker_job.lease_reconciled` was
   * emitted on coordinator boot only - so the digest's count of it could never
   * include a reclaim that happened during a run. The callback is deliberately
   * synchronous and side-effect free from this method's point of view: it
   * collects, and the caller emits after the transaction commits. Doing I/O
   * inside this transaction would hold the lease rows open.
   */
  async leaseNextWorkerJob(
    workerId: string,
    capabilities: string[],
    options: {
      now?: Date;
      leaseMs?: number;
      leaseToken: string;
      onReclaim?: (reclaimed: ReclaimedWorkerJobLease) => void;
    },
  ): Promise<WorkerJob | undefined> {
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 30_000));
    return this.sql.begin(async (tx) => {
      const expiredCancellations = await tx<
        Array<{ attempt_id: string | null; task_id: string | null }>
      >`update worker_jobs set
        state='cancelled',worker_id=null,lease_token=null,lease_expires_at=null,updated_at=${now.toISOString()}
        where state='cancel_requested' and lease_expires_at <= ${now.toISOString()}
        returning attempt_id,task_id`;
      for (const cancelled of expiredCancellations) {
        if (cancelled.attempt_id) {
          await tx`update attempts set state='cancelled',finished_at=${now.toISOString()}
            where id=${cancelled.attempt_id} and state not in ('completed','failed','cancelled')`;
        }
        if (cancelled.task_id) {
          await tx`update tasks set state='cancelled',updated_at=${now.toISOString()}
            where id=${cancelled.task_id} and state not in ('done','cancelled')`;
        }
      }
      // Selected before being updated, not `update ... returning`, because
      // PostgreSQL returns the NEW row and the whole point of reporting a
      // reclaim is to name the worker it was taken FROM - which the update has
      // just set to null. (PostgreSQL 18's `returning old.*` would do it in one
      // statement; this runs on 17.) `for update` holds the rows for the rest
      // of the transaction, so selecting and then updating is not a race.
      const recoveredLeases = await tx<
        Array<{
          attempt_id: string | null;
          id: string;
          run_id: string;
          worker_id: string | null;
          lease_expires_at: Date | null;
        }>
      >`select attempt_id,id,run_id,worker_id,lease_expires_at from worker_jobs
        where state='leased' and lease_expires_at <= ${now.toISOString()}
        for update`;
      if (recoveredLeases.length > 0) {
        await tx`update worker_jobs set
          state='queued',worker_id=null,lease_token=null,lease_expires_at=null,updated_at=${now.toISOString()}
          where id in ${tx(recoveredLeases.map((recovered) => recovered.id))}`;
      }
      for (const recovered of recoveredLeases) {
        // Reported before the attempt rows are touched, so the caller hears
        // about every reclaim even if a later statement in this transaction
        // fails.
        options.onReclaim?.({
          jobId: recovered.id,
          runId: recovered.run_id,
          previousWorkerId: recovered.worker_id ?? undefined,
          leaseExpiredAt: recovered.lease_expires_at?.toISOString(),
          overdueMs: recovered.lease_expires_at
            ? Math.max(0, now.getTime() - recovered.lease_expires_at.getTime())
            : undefined,
        });
      }
      for (const recovered of recoveredLeases) {
        if (recovered.attempt_id) {
          await tx`update attempts set state='queued',worker_id=null,lease_token=null,lease_expires_at=null
            where id=${recovered.attempt_id} and state='leased'`;
        }
      }
      const [candidate] = await tx<WorkerJobRow[]>`select
          id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result
        from worker_jobs
        where state='queued' and available_at <= ${now.toISOString()}
          and required_capabilities <@ ${tx.json(capabilities)}::jsonb
        order by priority desc,available_at,created_at,id
        for update skip locked
        limit 1`;
      if (!candidate) return undefined;
      const [leased] = await tx<WorkerJobRow[]>`update worker_jobs set
          state='leased',worker_id=${workerId},lease_token=${options.leaseToken},
          lease_expires_at=${leaseExpiresAt.toISOString()},updated_at=${now.toISOString()}
        where id=${candidate.id} and state='queued'
        returning id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,
          required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result`;
      if (leased?.attempt_id) {
        await tx`update attempts set state='leased',worker_id=${workerId},
          lease_token=${options.leaseToken},lease_expires_at=${leaseExpiresAt.toISOString()}
          where id=${leased.attempt_id}`;
      }
      return leased ? mapWorkerJob(leased) : undefined;
    });
  }
  async renewWorkerJobLease(
    jobId: string,
    workerId: string,
    leaseToken: string,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<WorkerJob | undefined> {
    const now = options.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 30_000));
    const [row] = await this.sql<WorkerJobRow[]>`update worker_jobs set
        lease_expires_at=${leaseExpiresAt.toISOString()},updated_at=${now.toISOString()}
      where id=${jobId} and worker_id=${workerId} and lease_token=${leaseToken}
        and state in ('leased','cancel_requested') and lease_expires_at > ${now.toISOString()}
      returning id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,
        required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result`;
    return row ? mapWorkerJob(row) : undefined;
  }
  async completeWorkerJob(
    jobId: string,
    workerId: string,
    leaseToken: string,
    result: {
      code: number;
      stdout: string;
      stderr: string;
      steps?: Array<{ command: string; code: number; stdout: string; stderr: string }>;
      events?: ProviderEvent[];
      patch?: string;
      retainedWorkspace?: string;
      rawStdoutTail?: string;
      rawStderrTail?: string;
    },
    now = new Date(),
  ): Promise<WorkerJob | undefined> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<WorkerJobRow[]>`update worker_jobs set
          state=case when state='cancel_requested' then 'cancelled'
            when ${result.code}=0 then 'completed' else 'failed' end,
          result=${tx.json(result as unknown as JSONValue)},updated_at=${now.toISOString()}
        where id=${jobId} and worker_id=${workerId} and lease_token=${leaseToken}
          and state in ('leased','cancel_requested') and lease_expires_at > ${now.toISOString()}
        returning id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,
          required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result`;
      if (row?.attempt_id) {
        await tx`update attempts set state=${row.state},finished_at=${now.toISOString()},
          error=${
            result.code === 0
              ? null
              : tx.json({
                  code: 'WORKER_JOB_FAILED',
                  message: result.stderr,
                  ...(result.retainedWorkspace
                    ? { retainedWorkspace: result.retainedWorkspace }
                    : {}),
                })
          }
          where id=${row.attempt_id}`;
      }
      return row ? mapWorkerJob(row) : undefined;
    });
  }
  async cancelWorkerJob(jobId: string): Promise<WorkerJob | undefined> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<WorkerJobRow[]>`update worker_jobs set
          state=case when state='queued' then 'cancelled' else 'cancel_requested' end,
          updated_at=now()
        where id=${jobId} and state in ('queued','leased')
        returning id,run_id,task_id,attempt_id,idempotency_key,priority,available_at,action,
          required_capabilities,state,worker_id,lease_token,lease_expires_at,approval,result`;
      if (!row) return undefined;
      if (row.attempt_id) {
        await tx`update attempts set state=${row.state},
          finished_at=case when ${row.state}='cancelled' then now() else finished_at end
          where id=${row.attempt_id} and state not in ('completed','failed','cancelled')`;
      }
      if (row.task_id && row.state === 'cancelled') {
        await tx`update tasks set state='cancelled',updated_at=now()
          where id=${row.task_id} and state not in ('done','cancelled')`;
      }
      return mapWorkerJob(row);
    });
  }
  async putApproval(approval: Approval): Promise<void> {
    await this
      .sql`insert into approvals (id,run_id,action_class,action_digest,normalized_action,scope,worker_id,status,expires_at,decided_at)
      values (${approval.id},${approval.runId},${approval.actionClass},${approval.actionDigest},${approval.normalizedAction},${approval.scope},${approval.workerId ?? null},${approval.status},${approval.expiresAt},${approval.decidedAt ?? null})
      on conflict (id) do update set status=excluded.status,expires_at=excluded.expires_at,decided_at=excluded.decided_at`;
  }
  async listApprovals(): Promise<Approval[]> {
    const rows = await this.sql<
      Record<string, unknown>[]
    >`select * from approvals order by created_at`;
    return rows.map((row) =>
      ApprovalSchema.parse({
        id: row.id,
        runId: row.run_id,
        actionClass: row.action_class,
        actionDigest: row.action_digest,
        normalizedAction: row.normalized_action,
        scope: row.scope,
        ...(row.worker_id ? { workerId: row.worker_id } : {}),
        status: row.status,
        expiresAt: (row.expires_at as Date).toISOString(),
        ...(row.decided_at ? { decidedAt: (row.decided_at as Date).toISOString() } : {}),
      }),
    );
  }
  async reconcileExpiredLeases(
    now = new Date(),
  ): Promise<Array<{ attemptId: string; taskId: string; runId: string }>> {
    return this.sql.begin(async (tx) => {
      const expired = await tx<
        Array<{ attempt_id: string; task_id: string; run_id: string }>
      >`select a.id as attempt_id,a.task_id,t.run_id from attempts a join tasks t on t.id=a.task_id
        where a.state in ('leased','running') and a.lease_expires_at <= ${now.toISOString()}
        for update skip locked`;
      for (const item of expired) {
        await tx`update attempts set state='expired',finished_at=${now.toISOString()},error=${tx.json({ code: 'LEASE_EXPIRED', retryable: true })} where id=${item.attempt_id}`;
        await tx`update tasks set state='ready',updated_at=${now.toISOString()} where id=${item.task_id} and state='in_progress'`;
      }
      return expired.map((item) => ({
        attemptId: item.attempt_id,
        taskId: item.task_id,
        runId: item.run_id,
      }));
    });
  }
  /**
   * Retention removes whole runs, never individual rows: a run that reached a
   * terminal state and has not been touched since `before` goes with everything
   * that cascades from it, so an event chain is either intact or gone, and an
   * active run never loses the events it would replay on restart. Each deleted
   * run leaves a tombstone with the sequence and hash its chain ended on.
   * The counts are the events and artifacts those runs hold.
   */
  async cleanupRetention(
    before: Date,
    options: { execute?: boolean } = {},
  ): Promise<{ runs: number; events: number; artifacts: number; executed: boolean }> {
    const cutoff = before.toISOString();
    const candidates = await this.sql<
      Array<{ id: string; events: string; artifacts: string }>
    >`select r.id,
        (select count(*) from events e where e.run_id=r.id)::text as events,
        (select count(*) from artifacts a where a.run_id=r.id)::text as artifacts
      from runs r
      where r.updated_at < ${cutoff} and r.state in ${this.sql(retiredRunStates)}
      order by r.updated_at,r.id`;
    const result = {
      runs: candidates.length,
      events: candidates.reduce((sum, run) => sum + Number(run.events), 0),
      artifacts: candidates.reduce((sum, run) => sum + Number(run.artifacts), 0),
      executed: options.execute === true,
    };
    if (!options.execute) return result;
    await this.sql.begin(async (tx) => {
      await allowEventDeletion(tx);
      for (const run of candidates) {
        await tx`insert into audit_tombstones (run_id,last_sequence,last_row_hash,event_count)
          select ${run.id},max(sequence),
            (select row_hash from events where run_id=${run.id} order by sequence desc limit 1),
            count(*)
          from events where run_id=${run.id}
          on conflict (run_id) do nothing`;
        // Re-checked inside the transaction: a run resumed since the preview stays.
        await tx`delete from runs where id=${run.id} and updated_at < ${cutoff}
          and state in ${tx(retiredRunStates)}`;
      }
    });
    return result;
  }
}

/** Run states nothing will move out of, so retention may take the run whole. */
const retiredRunStates = ['completed', 'partially_completed', 'cancelled', 'failed'];

function parseProjectChecks(
  value: unknown,
  key: 'checks' | 'install' = 'checks',
): Array<{ executable: string; args: string[] }> {
  const list = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((check): check is { executable: string; args: string[] } =>
    Boolean(
      isRecord(check) &&
      typeof check.executable === 'string' &&
      Array.isArray(check.args) &&
      check.args.every((argument: unknown) => typeof argument === 'string'),
    ),
  );
}

function mapRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    objective: row.objective,
    constraints: row.constraints,
    state: row.state,
    ...(row.resume_state ? { resumeState: row.resume_state } : {}),
    budget: row.budget,
    spent: row.spent,
    configuration: row.configuration,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
function mapTask(row: TaskRow, dependencies: string[]): Task {
  return TaskSchema.parse({
    id: row.id,
    runId: row.run_id,
    title: row.title,
    description: row.description,
    state: row.state,
    priority: row.priority,
    dependencies,
    acceptanceCriteria: row.acceptance_criteria,
    requiredCapabilities: row.required_capabilities,
    fileOwnership: row.file_ownership,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
function mapEvent(row: EventRow): ForgeEvent {
  return EventSchema.parse({
    id: row.id,
    runId: row.run_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    type: row.type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    // bigserial arrives as a string from postgres.js; hashes are null on legacy rows.
    sequence: Number(row.sequence),
    ...(row.prev_hash ? { prevHash: row.prev_hash } : {}),
    ...(row.row_hash ? { rowHash: row.row_hash } : {}),
  });
}
function mapNotification(row: NotificationRow): Notification {
  return NotificationSchema.parse({
    id: row.id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    payload: row.payload,
    ...(row.last_error && isRecord(row.last_error) ? { lastError: row.last_error } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.sent_at ? { sentAt: row.sent_at.toISOString() } : {}),
  });
}
function mapAttempt(row: AttemptRow): Attempt {
  return AttemptSchema.parse({
    id: row.id,
    taskId: row.task_id,
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    state: row.state,
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.error && isRecord(row.error) ? { error: row.error } : {}),
  });
}
function mapMessage(row: Record<string, unknown>): AgentMessage {
  return AgentMessageSchema.parse({
    id: row.id,
    runId: row.run_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    type: row.type,
    sender: row.sender,
    claim: row.claim,
    ...(row.requested_action ? { requestedAction: row.requested_action } : {}),
    evidence: row.evidence,
    criteria: row.criteria,
    confidence: Number(row.confidence),
    ...(row.uncertainty ? { uncertainty: row.uncertainty } : {}),
    timestamp: (row.created_at as Date).toISOString(),
    idempotencyKey: row.idempotency_key,
  });
}
function mapFinding(row: Record<string, unknown>): Finding {
  return FindingSchema.parse({
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    claim: row.claim,
    severity: row.severity,
    evidence: row.evidence,
    affectedCriterion: row.affected_criterion,
    requestedAction: row.requested_action,
    status: row.status,
  });
}
function mapDecision(row: Record<string, unknown>): Decision {
  return DecisionSchema.parse({
    id: row.id,
    runId: row.run_id,
    title: row.title,
    rationale: row.rationale,
    status: row.status,
    evidence: row.evidence,
    createdAt: (row.created_at as Date).toISOString(),
  });
}
function mapBlocker(row: Record<string, unknown>): Blocker {
  return BlockerSchema.parse({
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    classification: row.classification,
    summary: row.summary,
    evidence: row.evidence,
    impact: row.impact,
    attempts: row.attempts,
    ...(row.workaround ? { workaround: row.workaround } : {}),
    smallestUnblockAction: row.smallest_unblock_action,
    status: row.status,
  });
}
function mapArtifact(row: Record<string, unknown>): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    runId: row.run_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    kind: row.kind,
    label: row.label,
    uri: row.uri,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    metadata: row.metadata,
    createdAt: (row.created_at as Date).toISOString(),
  });
}
function mapUsageRecord(row: Record<string, unknown>): UsageRecord {
  return UsageRecordSchema.parse({
    id: row.id,
    runId: row.run_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    provider: row.provider,
    ...(row.model ? { model: row.model } : {}),
    ...(row.role ? { role: row.role } : {}),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens),
    costUsd: Number(row.cost_usd),
    elapsedMs: Number(row.elapsed_ms),
    tools: row.tools,
    createdAt: (row.created_at as Date).toISOString(),
  });
}

const workerJobStates = new Set<WorkerJobState>([
  'queued',
  'leased',
  'cancel_requested',
  'cancelled',
  'completed',
  'failed',
]);

function mapWorkerJob(row: WorkerJobRow): WorkerJob {
  if (!workerJobStates.has(row.state as WorkerJobState))
    throw new Error(`Invalid worker job state: ${row.state}`);
  const action = parseWorkerJobAction(row.action);
  const requiredCapabilities = parseStringArray(row.required_capabilities, 'required_capabilities');
  const result = row.result === null ? undefined : parseWorkerJobResult(row.result);
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    priority: row.priority,
    availableAt: row.available_at.getTime(),
    action,
    requiredCapabilities,
    state: row.state as WorkerJobState,
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.getTime() } : {}),
    ...(row.approval ? { approval: ApprovalSchema.parse(row.approval) } : {}),
    ...(result ? { result } : {}),
  };
}

function parseWorkerJobAction(value: unknown): WorkerJobAction {
  if (!isRecord(value)) throw new Error('Invalid worker job action');
  const workspace = parseWorkerWorkspaceSnapshot(value.workspace);
  const workingDirectory = parseWorkspacePath(value.workingDirectory, 'workingDirectory', true);
  if (isRecord(value) && value.kind === 'provider') {
    if (!isProviderId(value.providerId)) throw new Error('Invalid provider worker job action');
    return {
      kind: 'provider',
      providerId: value.providerId,
      request: ProviderRequestSchema.parse(value.request),
      workspace,
      workingDirectory,
    };
  }
  if (!('executable' in value) || typeof value.executable !== 'string' || !('args' in value))
    throw new Error('Invalid worker job action');
  // `network` has to be named here or it does not survive the round trip. This
  // parser deliberately allowlists fields rather than passing the stored jsonb
  // through to the worker, which is the right design - but it means a new field
  // is silently dropped unless it is added here too.
  //
  // That is exactly what happened on 05/10/2026, one day after the same class
  // of bug was fixed for `run.constraints`: the install step's network flag was
  // written to the database correctly, stripped on the way back out, and the
  // container ran sealed. `npm ci` then failed on DNS for the second time, and
  // the first diagnosis was that the flag had never been set.
  const network = parseStepNetwork(value.network);
  // `steps` has to be named here for the same reason `network` does: this
  // parser allowlists fields rather than handing stored jsonb to the worker, so
  // anything not listed is dropped silently. That cost a run on 05/10/2026.
  const steps = Array.isArray(value.steps)
    ? value.steps.map((step: unknown) => {
        if (!isRecord(step) || typeof step.executable !== 'string' || !step.executable)
          throw new Error('Invalid worker job action step');
        const stepNetwork = parseStepNetwork(step.network);
        return {
          executable: step.executable,
          args: parseStringArray(step.args, 'action.steps[].args'),
          ...(stepNetwork ? { network: stepNetwork } : {}),
          ...(step.stopOnFailure === true ? { stopOnFailure: true } : {}),
        };
      })
    : undefined;
  return {
    executable: value.executable,
    args: parseStringArray(value.args, 'action.args'),
    workspace,
    workingDirectory,
    ...(network ? { network } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
  };
}

/**
 * Only the two values the type allows. Anything else - including a plausible
 * `bridge` - is refused rather than passed through, because this is what stands
 * between stored jsonb and a sandbox with network access.
 */
function parseStepNetwork(value: unknown): 'none' | 'install' | undefined {
  return value === 'install' || value === 'none' ? value : undefined;
}

function parseWorkerWorkspaceSnapshot(value: unknown): WorkerWorkspaceSnapshot {
  if (
    !isRecord(value) ||
    typeof value.repositoryUrl !== 'string' ||
    value.repositoryUrl.length === 0 ||
    value.repositoryUrl.length > 2_048 ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(value.revision) ||
    typeof value.patch !== 'string' ||
    Buffer.byteLength(value.patch) > 8_000_000 ||
    !Array.isArray(value.untrackedFiles) ||
    value.untrackedFiles.length > 128
  )
    throw new Error('Invalid worker workspace snapshot');
  let encodedBytes = 0;
  const untrackedFiles = value.untrackedFiles.map((file): WorkerWorkspaceFile => {
    if (
      !isRecord(file) ||
      typeof file.contentBase64 !== 'string' ||
      typeof file.executable !== 'boolean'
    )
      throw new Error('Invalid worker workspace file');
    const path = parseWorkspacePath(file.path, 'untracked file path');
    encodedBytes += Buffer.byteLength(file.contentBase64);
    if (Buffer.byteLength(file.contentBase64) > 1_400_000 || encodedBytes > 5_600_000)
      throw new Error('Worker workspace untracked files exceed the encoded size limit');
    return { path, contentBase64: file.contentBase64, executable: file.executable };
  });
  return {
    repositoryUrl: value.repositoryUrl,
    revision: value.revision.toLowerCase(),
    patch: value.patch,
    untrackedFiles,
  };
}

function parseWorkspacePath(value: unknown, field: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 512 || value.includes('\\'))
    throw new Error(`Invalid worker workspace ${field}`);
  if (allowRoot && (value === '' || value === '.')) return '.';
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid worker workspace ${field}`);
  return value;
}

function parseWorkerJobResult(value: unknown): NonNullable<WorkerJob['result']> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('code' in value) ||
    typeof value.code !== 'number' ||
    !Number.isInteger(value.code) ||
    !('stdout' in value) ||
    typeof value.stdout !== 'string' ||
    !('stderr' in value) ||
    typeof value.stderr !== 'string'
  )
    throw new Error('Invalid worker job result');
  if ('events' in value && value.events !== undefined && !Array.isArray(value.events))
    throw new Error('Invalid worker job result events');
  if ('patch' in value && value.patch !== undefined && typeof value.patch !== 'string')
    throw new Error('Invalid worker job result patch');
  if (
    'retainedWorkspace' in value &&
    value.retainedWorkspace !== undefined &&
    typeof value.retainedWorkspace !== 'string'
  )
    throw new Error('Invalid worker job result retainedWorkspace');
  const rawEvents = 'events' in value ? value.events : undefined;
  const events = Array.isArray(rawEvents)
    ? rawEvents.map((event: unknown) => ProviderEventSchema.parse(event))
    : undefined;
  const patch = 'patch' in value && typeof value.patch === 'string' ? value.patch : undefined;
  const retainedWorkspace =
    'retainedWorkspace' in value && typeof value.retainedWorkspace === 'string'
      ? value.retainedWorkspace
      : undefined;
  if ('steps' in value && value.steps !== undefined && !Array.isArray(value.steps))
    throw new Error('Invalid worker job result steps');
  const rawSteps = 'steps' in value && Array.isArray(value.steps) ? value.steps : undefined;
  // Refused rather than filtered. A malformed step dropped quietly would reach
  // the pipeline as a verification that ran fewer commands than it was sent,
  // which is the one thing its own guard is there to catch.
  const steps = rawSteps?.map((step: unknown) => {
    if (
      !isRecord(step) ||
      typeof step.command !== 'string' ||
      typeof step.code !== 'number' ||
      typeof step.stdout !== 'string' ||
      typeof step.stderr !== 'string'
    )
      throw new Error('Invalid worker job result step');
    return { command: step.command, code: step.code, stdout: step.stdout, stderr: step.stderr };
  });
  const rawStdoutTail = optionalStringField(value, 'rawStdoutTail');
  const rawStderrTail = optionalStringField(value, 'rawStderrTail');
  return {
    code: value.code,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(events ? { events } : {}),
    ...(patch !== undefined ? { patch } : {}),
    ...(retainedWorkspace !== undefined ? { retainedWorkspace } : {}),
    ...(rawStdoutTail !== undefined ? { rawStdoutTail } : {}),
    ...(rawStderrTail !== undefined ? { rawStderrTail } : {}),
  };
}

function optionalStringField(value: object, field: string): string | undefined {
  if (!(field in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  if (candidate !== undefined && typeof candidate !== 'string')
    throw new Error(`Invalid worker job result ${field}`);
  return candidate;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`Invalid worker job ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (providerIds as readonly string[]).includes(value);
}
