# End-to-End Build Plan

This plan is authoritative for the initial release. Build vertical slices, keep the application runnable, and update `tasks/TASKS.md` after every completed task.

## Phase 0: Foundation and guardrails

- Initialise TypeScript/pnpm/Turborepo monorepo.
- Add formatting, linting, strict type checking, test conventions, commit hooks, CI, environment validation, and dependency policy.
- Add Docker Compose for PostgreSQL and Redis.
- Establish shared contracts and domain package boundaries.

**Gate:** clean install, lint, typecheck, unit test, build, and Docker dependency health checks pass in CI and locally.

## Phase 1: Durable domain and state engine

- Implement database schema and migrations for projects, runs, tasks, dependencies, attempts, events, messages, findings, decisions, blockers, approvals, workers, artefacts, and usage.
- Implement validated run/task state transitions.
- Implement append-only events, idempotency keys, task leases, retries, cancellation, timeout, and restart reconciliation.
- Add fake clock and deterministic state-machine tests.

**Gate:** integration tests prove restart recovery, lease expiry recovery, duplicate command safety, blocked-task isolation, and independent task continuation.

## Phase 2: Git runtime

- Implement repository registration, clone/fetch cache, branch/worktree creation, dirty-state checks, diff/status/commit helpers, secret scanning, cleanup, and GitHub draft PR creation.
- Add fixture repositories and conflict tests.

**Gate:** concurrent fixture tasks receive isolated worktrees, produce focused commits, and integrate without altering the default branch directly.

## Phase 3: Provider abstraction and adapters

- Define provider capability, session, streaming event, structured output, cancellation, error, and usage contracts.
- Build deterministic fake provider first.
- Implement Claude adapter using supported CLI/SDK mechanisms.
- Implement Codex adapter using supported CLI/SDK mechanisms.
- Add authentication diagnostics, model configuration, output schema validation, timeouts, cancellation, and error normalisation.

**Gate:** the same contract suite passes for fake, Claude, and Codex adapters where credentials are available; unavailable providers report actionable diagnostics and do not break fake-provider tests.

## Phase 4: Worker daemon and scheduler

- Build cross-platform worker registration, authentication, capability advertisement, heartbeats, leases, command policy, workspace execution, streaming logs, artefact upload, cancellation, and graceful shutdown.
- Build dependency-aware scheduler with capability matching, budget limits, provider selection, retries, fallback policy, and concurrency limits.
- Package/document Windows, macOS, and Linux operation.

**Gate:** two workers execute independent tasks concurrently; killing one worker causes safe lease recovery without duplicate committed work.

## Phase 5: Orchestration roles and collaboration

- Implement intake, context gathering, planning, critique, revision, builder, reviewer, verifier, repair, and integrator workflows.
- Add structured message and finding schemas.
- Enforce independent reviewer selection where available.
- Enforce maximum three repair rounds and new-evidence requirement.
- Implement blocker pinning, workaround attempts, and continued scheduling.

**Gate:** a seeded bad implementation is rejected with evidence, repaired, reverified, and completed; an unresolvable task is pinned while sibling tasks finish.

## Phase 6: Approval and policy engine

- Implement Green/Amber/Red policies, exact-action approvals, expiration, rejection, audit events, and UI/API controls.
- Redact secrets and scan commands/changes.
- Add prompt-injection and unsafe-command fixtures.

**Gate:** Red actions cannot execute without exact approval; changed commands invalidate approval; secrets are absent from logs and persisted artefacts.

## Phase 7: Web control centre

- Build project/repository setup, provider diagnostics, worker dashboard, new-run form, run list, run detail timeline/task graph, logs, findings, approvals, blockers, costs, artefacts, diff views, and final report.
- Add pause/resume/cancel/retry controls and responsive accessible UI.
- Stream live events and recover after refresh.

**Gate:** Playwright covers setup, run creation, live progress, approval, blocker display, restart/reload, and final PR report.

## Phase 8: Full integration and release hardening

- Add local one-command setup, seeded demo, backup/recovery notes, health endpoints, structured logs, metrics, retention/cleanup, and deployment documentation.
- Run dependency/security scans and threat-model review.
- Execute the canonical release acceptance test against a fixture repository.
- Force coordinator restart and worker loss during the run.
- Capture evidence bundle and create a real draft PR.

**Release gate:** every requirement in `docs/PRODUCT_SPEC.md` is mapped to passing evidence. No critical/high unresolved security finding. No hidden manual implementation step. Remaining optional work is explicitly deferred.

## Canonical acceptance scenario

Input objective:

> Add a persisted notes feature with validation, tests, and a polished responsive UI.

Expected autonomous sequence:

1. Repository context gathered.
2. Executable plan and acceptance criteria produced.
3. Other-provider critique resolved.
4. Worktree created and feature implemented.
5. Independent review produces evidence-backed findings.
6. Repairs applied within bounded loops.
7. Unit, integration, build, and browser tests pass.
8. Coordinator is restarted mid-run and resumes correctly.
9. Draft PR is created.
10. Dashboard displays task graph, logs, costs, artefacts, decisions, resolved blockers, and final report.

## Definition of fully built

“Fully built” means the release gate passes in a fresh environment using documented setup. Scaffolding, mocks, or provider adapters that have never completed a real run do not satisfy this definition.