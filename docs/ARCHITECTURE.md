# Target Architecture

## Recommended stack

- TypeScript monorepo with `pnpm` and Turborepo.
- Next.js web application for dashboard and API/BFF.
- Node.js coordinator service for orchestration.
- PostgreSQL (the `postgres` driver and plain SQL migrations) for durable state.
- A Redis-compatible queue as a best-effort hint of new job ids (ADR-011), drained on each lease poll; workers poll the coordinator, which leases from PostgreSQL. Jobs and leases are authoritative in PostgreSQL, and the system works without Redis.
- WebSocket or Server-Sent Events for live run updates.
- Cross-platform Node.js worker daemon packaged as a standalone executable where practical. The initial release targets Windows and Linux; macOS is deferred (ADR-015).
- Zod or equivalent runtime schemas at every trust boundary.
- Vitest, Playwright, and containerised integration tests.

The build agent may adjust a component only when evidence shows a blocker and the decision is recorded.

## Monorepo shape

```text
apps/
  web/             dashboard, run controls, API/BFF
  coordinator/     state machine, scheduler, approvals, integration
  worker/          cross-platform execution daemon
packages/
  domain/          entities, state transitions, policies
  db/              schema, migrations, repositories
  contracts/       events, commands, provider/worker schemas
  providers/       adapter interfaces and shared utilities
  provider-claude/
  provider-codex/
  git-runtime/     clone, branch, worktree, diff, commit, PR helpers
  policy/          command and approval engine
  observability/   logs, traces, metrics, redaction, usage
  testkit/         fixtures, fake providers, fake workers
infra/
  docker/
  deployment/
docs/
tasks/
```

## Core domain entities

- `Project`: repository configuration and policies.
- `Run`: one user objective from intake to terminal report.
- `Task`: dependency-aware unit of work.
- `Attempt`: one execution of a task by a provider/worker.
- `AgentRole`: planner, critic, builder, reviewer, verifier, integrator.
- `Message`: validated structured communication.
- `Finding`: review claim and evidence.
- `Decision`: accepted choice and rationale.
- `Blocker`: classified impediment with workaround history.
- `ApprovalRequest`: proposed gated action and user response.
- `Worker`: authenticated machine and capability inventory.
- `Artifact`: diff, log, screenshot, trace, report, test output.
- `UsageRecord`: tokens, provider cost, elapsed time, tool usage.

## Run state machine

```text
created → context_gathering → planning → critique → plan_revision
→ executing → reviewing → verifying → repairing ↺
→ integrating → completed (or partially_completed)

Any active state may move to paused, blocked, cancelled, or failed.
Blocked runs return to the prior actionable state after resolution.
```

State transitions must be validated in domain code and persisted atomically with an append-only event.

## Provider adapter contract

Each provider implements:

- availability and authentication check;
- capability declaration;
- start/resume/cancel operation;
- structured prompt and context input;
- streaming normalised events;
- tool and permission requests;
- structured terminal output;
- usage/cost extraction;
- retryability classification;
- provider session reference persistence.

Domain code must not branch on Claude/Codex outside adapter selection policy.

## Worker protocol

Workers authenticate with short-lived credentials and advertise OS, tools, repository access, compute, and policy profile. Coordinator grants a time-bound lease. Workers heartbeat, stream redacted events, upload artefacts, and acknowledge cancellation. Expired leases are safely recoverable through idempotency keys and workspace inspection.

## Persistence and recovery

- PostgreSQL is authoritative for runs, tasks, attempts, approvals, decisions, blockers, workers, and events.
- Queue payloads contain identifiers, not authoritative state.
- Every command has an idempotency key.
- On startup, coordinator reconciles stale leases and resumable states.
- Provider session IDs and workspace locations are persisted.
- Append-only events support audit and UI reconstruction.

## Audit log integrity

The `events` table is a per-run hash chain (ADR-020, migration 006). A `BEFORE INSERT` trigger sets `prev_hash` to the `row_hash` of the run's latest row by `sequence` (or the SHA-256 of `GENESIS` for the first) and `row_hash` to the SHA-256 of the jsonb text of `[sequence, id, run_id, task_id, attempt_id, type, payload, created_at, prev_hash]`, with `created_at` as millisecond UTC ISO-8601. The trigger holds a per-run transaction advisory lock and draws the sequence number under it, so concurrent fire-and-forget appends cannot fork a chain and sequence order is chain order. `@theforge/db` renders the same canonical text in TypeScript (`canonicalJsonb`, `eventRowHash`), which is what `verifyEventChain(runId)` and `pnpm forge verify-audit` recompute; the first row whose hash or link disagrees is reported with its sequence.

`UPDATE` and `DELETE` on `events` and `audit_tombstones` raise unless the transaction has set `forge.allow_event_delete = 'on'` (`allowEventDeletion(tx)`). Retention therefore never deletes individual events: it deletes whole runs that reached a terminal state and were last updated before the cutoff, writes an `audit_tombstones` row with the chain's final sequence and hash first, and lets the cascade remove the rest. Rows written before migration 006 carry no hashes; a run's chain starts at its first row after it, and the verifier counts those rows as `legacy` rather than claiming to have checked them. Removing the last row of a run is the one alteration the chain alone cannot see, which is what the tombstone is for.

## Git isolation

A project has a managed bare clone/cache. Each run receives a dedicated worktree and branch (a task-level worktree is the target design, not what the live system does). Integration occurs only through reviewed commits. Parallel tasks declare file ownership hints; conflicts become explicit integration tasks.

## Deployment modes

1. Local single-user: Docker Compose for Postgres/Redis, services on one trusted machine.
2. Personal distributed: coordinator on an always-on machine or private cloud, workers over Tailscale/private TLS.
3. Future hosted: multi-tenant isolation, external secret manager, hardened sandboxing, and billing, outside initial scope.