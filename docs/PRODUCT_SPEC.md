# Initial Product Specification

## User journey

1. User connects a GitHub repository and configures Anthropic/OpenAI API keys or a Codex auth file.
2. User submits an objective, optional constraints, budget, and approval profile.
3. TheForge creates a durable run, gathers repository context, and produces an executable plan.
4. A separate role critiques the plan; the planner revises it.
5. The scheduler creates tasks with dependencies and assigns them to eligible workers/providers.
6. Builders edit isolated Git worktrees. Reviewers inspect diffs. Verifiers run tests and browser/API checks.
7. Repair loops run at most three rounds unless explicitly extended.
8. TheForge opens a draft PR when release gates pass, or reports exact remaining blockers.

## Required surfaces

### Dashboard
- Run list with status, progress, cost, provider usage, blockers, and last activity.
- Worker health and capabilities.
- Approval inbox.

### New run
- Repository selector.
- Objective and constraints.
- Autonomy profile: cautious, standard, or high-autonomy.
- Budget and time ceilings.
- Required checks and target branch.

### Run detail
- Current phase and task graph.
- Structured agent messages and decisions.
- Live logs with secret redaction.
- Files, commits, diffs, screenshots, traces, and test evidence.
- Blockers, retries, approvals, costs, and final report.
- Pause, resume, cancel, retry, and approve controls.

### Settings
- Provider adapters and model selection.
- GitHub integration.
- Worker registration.
- Command policy and approval rules.
- Secret references, never raw secret display.

## Functional requirements

### Orchestration
- Durable state machine with resumable transitions.
- Dependency-aware task queue, leases, heartbeat, retry, timeout, cancellation, and idempotency.
- Continue independent tasks when one task is blocked.
- Pin blockers with classification, evidence, attempted workarounds, impact, and smallest unblock action.

### Providers
- Common adapter contract for Claude and Codex.
- Structured input/output schemas.
- Streaming events, tool calls, cancellation, usage, and error normalisation.
- Provider fallback only when policy permits.

### Repository execution
- Clone/fetch repositories safely.
- One branch/worktree per task or coordinated change set.
- Detect dirty/conflicting workspaces.
- Produce focused commits and draft PRs.
- Never push secrets or overwrite unrelated work.

### Collaboration
- Roles: planner, critic, builder, reviewer, verifier, integrator.
- Structured findings with claim, severity, evidence, criterion, and requested action.
- Responses: accepted, rejected with counter-evidence, needs_decision, or blocked.

### Workers
- Cross-platform daemon for Windows and Linux in the initial release. macOS support is deferred to P1 (`P107`); see ADR-015.
- Capability advertisement, authentication, heartbeats, leases, logs, artefact upload, cancellation, and policy enforcement.
- Tailscale/private-network friendly; no unauthenticated public worker endpoints.

### Approvals
- Green actions auto-run.
- Amber actions depend on user policy.
- Red actions always require explicit approval in the initial release.

### Observability
- Append-only run events.
- Correlation IDs across run/task/attempt/tool call.
- Cost and token accounting.
- Secret redaction.
- Exportable final report.

## Non-functional requirements

- Restart-safe and idempotent.
- Type-safe boundaries and schema validation.
- Secure by default and least privilege.
- Local development via one documented command plus Docker dependencies.
- Unit, integration, contract, and end-to-end tests.
- Useful error messages and accessible UI.
- Provider/domain separation sufficient to add another provider without rewriting orchestration.

## Release acceptance test

Against a fixture repository containing a small web application, submit: “Add a persisted notes feature with validation, tests, and a polished responsive UI.” TheForge must plan, critique, implement, review, repair, verify, survive a forced coordinator restart, and create a draft PR. The UI must show the full task graph, evidence, costs, and any resolved blockers. No manual intervention is permitted except configured approvals.