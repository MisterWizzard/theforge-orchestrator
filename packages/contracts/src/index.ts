import { z } from 'zod';

export * from './env.js';

export const id = z.string().min(1).max(160);
export const timestamp = z.string().datetime();

/**
 * Worker-to-coordinator transport limits. They must agree with each other:
 * the worker only captures a builder patch it can send, the completion schema
 * only accepts what the worker sends, and the request body limit holds the
 * whole serialised completion. Before these were shared the worker allowed an
 * 8 MB patch and the coordinator schema 0.8 MB, so a patch in between was
 * rejected with a 400 that the worker dropped; the lease expired and the same
 * job re-ran forever without the run ever seeing an error.
 *
 * Body = patch + events + two raw output tails + stdout/stderr + JSON
 * escaping, with room to spare. A pathological text patch can double under
 * escaping and overflow even this; the worker measures the serialised body
 * before sending and fails the job cleanly rather than learning the limit as
 * a 413.
 */
export const MAX_PATCH_BYTES = 8_000_000;
export const MAX_EVENTS_BYTES = 4_000_000;
/** Each of a provider job's raw stdout and stderr tails (docs/OPERATIONS.md "Raw provider output"). */
export const MAX_RAW_TAIL_BYTES = 1_000_000;
export const MAX_COMPLETION_BODY_BYTES = 16 * 1024 * 1024;

export const runStates = [
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
  'paused',
  'blocked',
  'completed',
  'partially_completed',
  'cancelled',
  'failed',
] as const;
export const taskStates = [
  'queued',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'verification',
  'done',
  'deferred',
  'cancelled',
] as const;
/**
 * The group a usage record falls into when it has no role. Named rather than
 * spelled inline so the summary builders and the digest cannot drift apart on
 * the spelling, and so a real role can never collide with it.
 */
export const UNATTRIBUTED_ROLE = 'unattributed';

export const roles = [
  'planner',
  'critic',
  'builder',
  'reviewer',
  'verifier',
  'integrator',
] as const;
/**
 * Every provider a job can name. `claude` and `codex` are cloud CLIs that run
 * in the worker's Docker sandbox with a credential; `ollama` is the local model
 * server, spoken to over HTTP from the worker process itself (ADR-021).
 */
export const providerIds = ['claude', 'codex', 'ollama'] as const;
/** Providers a run may be configured with. Local models are never pinned (ADR-022). */
export const cloudProviderIds = ['claude', 'codex'] as const;
export const actionClasses = ['green', 'amber', 'red'] as const;
export const blockerClasses = [
  'transient',
  'missing_access',
  'external_dependency',
  'product_decision',
  'technical_unknown',
  'safety_constraint',
] as const;

export const EvidenceSchema = z.object({
  id,
  kind: z.enum(['log', 'test', 'diff', 'commit', 'pull_request', 'screenshot', 'trace', 'report']),
  label: z.string().min(1),
  uri: z.string().min(1),
  sha256: z.string().optional(),
  createdAt: timestamp,
});

export const TaskSchema = z.object({
  id,
  runId: id,
  title: z.string().min(1),
  description: z.string(),
  state: z.enum(taskStates),
  priority: z.number().int().min(0),
  dependencies: z.array(id).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  requiredCapabilities: z.array(z.string()).default([]),
  fileOwnership: z.array(z.string()).default([]),
  attempts: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(3),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const RunConfigurationSchema = z.object({
  autonomyProfile: z.enum(['cautious', 'standard', 'high']).default('standard'),
  timeLimitMinutes: z.number().int().min(1).max(1440).default(120),
  targetBranch: z.string().min(1).max(240).default('main'),
  /**
   * Only the roles a run pins. An absent role runs on the default cloud
   * provider, claude (ADR-024); the pipeline decides that at execution, so
   * a stored configuration never claims a provider the run did not ask for.
   */
  providerRoles: z
    .object({
      planner: z.enum(cloudProviderIds).optional(),
      critic: z.enum(cloudProviderIds).optional(),
      builder: z.enum(cloudProviderIds).optional(),
      reviewer: z.enum(cloudProviderIds).optional(),
    })
    .default({}),
});

export const RunSchema = z.object({
  id,
  projectId: id,
  objective: z.string().min(3),
  constraints: z.array(z.string()).default([]),
  state: z.enum(runStates),
  resumeState: z.enum(runStates).optional(),
  budget: z.object({ maxUsd: z.number().nonnegative(), maxTokens: z.number().int().nonnegative() }),
  spent: z.object({ usd: z.number().nonnegative(), tokens: z.number().int().nonnegative() }),
  configuration: RunConfigurationSchema.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const EventSchema = z.object({
  id,
  runId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  type: z.string().min(1),
  payload: z.record(z.unknown()),
  idempotencyKey: id,
  createdAt: timestamp,
  // Assigned by PostgreSQL on insert (migration 006): the run-wide ordering and
  // the hash chain. Absent on an event that has not been stored yet or that
  // lives in an in-memory repository.
  sequence: z.number().int().positive().optional(),
  prevHash: z.string().length(64).optional(),
  rowHash: z.string().length(64).optional(),
});

export const AuditChainVerificationSchema = z.object({
  ok: z.boolean(),
  /** Rows whose hash and link were recomputed and matched. */
  checked: z.number().int().nonnegative(),
  /** Rows written before migration 006, which carry no hash and are skipped. */
  legacy: z.number().int().nonnegative(),
  firstBad: z.object({ sequence: z.number().int(), reason: z.string().min(1) }).optional(),
});

export const notificationChannels = ['ha', 'email', 'file', 'notifier'] as const;
export const notificationStatuses = [
  'pending',
  'sent',
  'failed',
  'skipped',
  'duplicate',
  'coalesced',
] as const;

export const NotificationSchema = z.object({
  id,
  runId: id.optional(),
  /** e.g. 'tier0.merge', 'spend.ceiling', 'security', 'ci_failure', 'decision_needed', 'digest'. */
  kind: z.string().min(1).max(80),
  /** One row per key and channel; a repeat on the same channel is recorded as not inserted. */
  dedupeKey: z.string().min(1).max(512),
  channel: z.enum(notificationChannels),
  status: z.enum(notificationStatuses),
  attempts: z.number().int().nonnegative(),
  payload: z.record(z.unknown()),
  lastError: z.record(z.unknown()).optional(),
  createdAt: timestamp,
  sentAt: timestamp.optional(),
});

/** What a producer supplies; status defaults to pending and the rest is set on insert. */
export const NewNotificationSchema = NotificationSchema.pick({
  id: true,
  runId: true,
  kind: true,
  dedupeKey: true,
  channel: true,
  payload: true,
}).extend({
  status: z.enum(notificationStatuses).default('pending'),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.record(z.unknown()).optional(),
  createdAt: timestamp.optional(),
});

const usageGroupSchema = z.object({
  usd: z.number().nonnegative(),
  count: z.number().int(),
});

export const UsageSummarySchema = z.object({
  usd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  /**
   * The portion of `inputTokens` that was served from the provider's prompt
   * cache, and so billed at a fraction of the fresh rate. A subset of
   * `inputTokens`, never additional to it.
   */
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  byProvider: z.record(usageGroupSchema),
  /**
   * Spend grouped by the pipeline role that incurred it, which is the question
   * the cost review (S14.6) exists to answer and could not until migration 008.
   * Records with no role - anything not produced by the pipeline, or produced
   * before the role was persisted - are grouped under `unattributed` rather
   * than silently dropped, so the group totals always reconcile with `usd`.
   */
  byRole: z.record(usageGroupSchema).default({}),
});

export const AgentMessageSchema = z.object({
  id,
  runId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  type: z.string().min(1),
  sender: z.object({ role: z.enum(roles), provider: z.string().min(1) }),
  claim: z.string().min(1),
  requestedAction: z.string().optional(),
  evidence: z.array(id).default([]),
  criteria: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  uncertainty: z.string().optional(),
  timestamp,
  idempotencyKey: id,
});

export const FindingSchema = z.object({
  id,
  runId: id,
  taskId: id,
  claim: z.string().min(1),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  evidence: z.array(id).min(1),
  affectedCriterion: z.string().min(1),
  requestedAction: z.string().min(1),
  status: z.enum(['open', 'accepted', 'rejected', 'needs_decision', 'blocked', 'resolved']),
});

export const BlockerSchema = z.object({
  id,
  runId: id,
  taskId: id,
  classification: z.enum(blockerClasses),
  summary: z.string().min(1),
  evidence: z.array(id),
  impact: z.string().min(1),
  attempts: z.array(z.string()),
  workaround: z.string().optional(),
  smallestUnblockAction: z.string().min(1),
  status: z.enum(['active', 'mitigated', 'resolved', 'accepted']),
});

export const AttemptSchema = z.object({
  id,
  taskId: id,
  workerId: id.optional(),
  provider: z.string().optional(),
  providerSessionId: z.string().optional(),
  workspacePath: z.string().optional(),
  state: z.string().min(1),
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  error: z.record(z.unknown()).optional(),
});

export const DecisionSchema = z.object({
  id,
  runId: id,
  title: z.string().min(1),
  rationale: z.string().min(1),
  status: z.string().min(1),
  evidence: z.array(id).default([]),
  createdAt: timestamp,
});

export const ArtifactSchema = z.object({
  id,
  runId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  kind: z.enum(['log', 'test', 'diff', 'commit', 'pull_request', 'screenshot', 'trace', 'report']),
  label: z.string().min(1),
  uri: z.string().min(1),
  sha256: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: timestamp,
});

export const UsageRecordSchema = z.object({
  id,
  runId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  provider: z.string().min(1),
  model: z.string().optional(),
  /**
   * The pipeline role this call was made for. Optional because a record is only
   * as good as the event behind it: events written before migration 008 carry
   * the role in their payload (the pipeline always emitted it) but anything not
   * produced by the pipeline has no role to claim.
   */
  role: z.enum(roles).optional(),
  /** Every input token the call consumed, cached and fresh alike. */
  inputTokens: z.number().int().nonnegative(),
  /**
   * The cached subset of `inputTokens`. Normalised across adapters, which
   * disagree: Claude's own `input_tokens` excludes cache and Codex's includes
   * it. Both are converted to "total, of which cached" on the way in.
   */
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  elapsedMs: z.number().int().nonnegative().default(0),
  tools: z.array(z.string()).default([]),
  createdAt: timestamp,
});

export const ApprovalSchema = z.object({
  id,
  runId: id,
  actionClass: z.enum(actionClasses),
  actionDigest: z.string().length(64),
  normalizedAction: z.string().min(1),
  scope: z.string().min(1),
  workerId: id.optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  expiresAt: timestamp,
  decidedAt: timestamp.optional(),
});

export const WorkerSchema = z.object({
  id,
  name: z.string().min(1),
  platform: z.enum(['linux', 'darwin', 'win32']),
  capabilities: z.array(z.string()),
  /** Providers the worker is configured for but withholds because they do not work, with why (ADR-038). */
  providerFaults: z.record(z.string(), z.string()).optional(),
  policyProfile: z.string().min(1),
  status: z.enum(['online', 'busy', 'draining', 'offline']),
  lastHeartbeatAt: timestamp,
});

export const ProviderRequestSchema = z.object({
  runId: id,
  taskId: id,
  role: z.enum(roles),
  prompt: z.string().min(1),
  context: z.array(z.object({ label: z.string(), content: z.string() })).default([]),
  outputSchema: z.record(z.unknown()).optional(),
  sessionId: z.string().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  /**
   * The model to run this request on, in the provider's own naming (an
   * Ollama tag such as `qwen3:8b`, a Claude alias such as `sonnet`). Absent
   * means the adapter's configured default. Set by the router; for an Ollama
   * job it also becomes the `model:<name>` capability the lease must match.
   */
  model: z.string().min(1).optional(),
});

export const ProviderEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_request'), name: z.string(), input: z.record(z.unknown()) }),
  z.object({ type: z.literal('permission_request'), action: z.string(), reason: z.string() }),
  z.object({ type: z.literal('session'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('usage'),
    /** Total input tokens, cached and fresh alike. */
    inputTokens: z.number(),
    /** The cached subset of `inputTokens`; absent from an adapter that cannot report it. */
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number(),
    usd: z.number(),
  }),
  z.object({ type: z.literal('completed'), sessionId: z.string().optional(), output: z.unknown() }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

export type Run = z.infer<typeof RunSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ForgeEvent = z.infer<typeof EventSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Worker = z.infer<typeof WorkerSchema>;
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
export type AuditChainVerification = z.infer<typeof AuditChainVerificationSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NewNotification = z.input<typeof NewNotificationSchema>;
export type NotificationChannel = (typeof notificationChannels)[number];
export type NotificationStatus = (typeof notificationStatuses)[number];
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
export type RunState = (typeof runStates)[number];
export type TaskState = (typeof taskStates)[number];
export type ActionClass = (typeof actionClasses)[number];
export type ProviderId = (typeof providerIds)[number];
