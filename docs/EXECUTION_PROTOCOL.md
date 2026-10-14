# Autonomous Execution Protocol

## Standard run

1. **Intake:** persist objective, constraints, repository, budget, approvals, and required evidence.
2. **Context:** inspect repository, existing docs, issues, tests, CI, and environment. Resolve questions from evidence first.
3. **Plan:** produce requirements, assumptions, acceptance criteria, task graph, risks, and verification strategy.
4. **Critique:** a separate role attacks omissions, unsafe assumptions, unnecessary complexity, and unverifiable criteria.
5. **Revision:** planner resolves each finding and locks an executable specification.
6. **Execution:** scheduler dispatches ready tasks to eligible workers in isolated worktrees.
7. **Review:** an independent role reviews actual diffs against criteria, not stylistic preference.
8. **Verification:** run formatting, types, unit/integration/E2E/security/build checks appropriate to the change.
9. **Repair:** address evidence-backed findings. Maximum three rounds unless a recorded exception exists.
10. **Integration:** rebase or merge safely, rerun gates, push branch, and create a draft PR.
11. **Report:** summarise delivered behaviour, evidence, decisions, cost, blockers, and remaining work.

## Question policy

Agents must not interrupt the user for information discoverable from the repository, tools, established conventions, or reversible experimentation. When a true product decision is needed, ask one compact question containing:

- the decision;
- viable options;
- consequences;
- recommendation;
- default action if no answer is available and that default is safe.

## Blocker handling

On failure:

1. capture evidence;
2. classify the blocker;
3. retry transient errors with bounded backoff;
4. try an allowed environment, provider, or implementation fallback;
5. split the task if partial independent work can continue;
6. pin the blocked portion in `docs/BLOCKERS.md` and the database;
7. schedule all other ready work;
8. revisit pinned blockers after relevant changes;
9. report only the smallest unresolved user action at the end.

Never weaken required behaviour, delete tests, or report a stub as complete.

## Scheduling rules

- Highest priority ready task first.
- Respect dependencies, file ownership, worker capability, budget, and approval policy.
- Prefer parallel work only when integration risk is low.
- Lease every task attempt and recover expired leases.
- Failed attempts do not erase earlier evidence.
- Repeated identical failure without new evidence stops the loop.

## Agent turn order

Default sequence:

```text
Claude or Codex planner
→ other-provider critic
→ planner revision
→ best-fit builder(s)
→ other-provider reviewer
→ verifier using deterministic tools first
→ builder repair
→ independent final verifier
→ integrator
```

Provider order is configurable. Independence matters more than brand order. A provider must not approve its own unsupported claims.

## Routing and fallback

Every pipeline stage is placed by `routeRole` (`packages/guardrails/src/router.ts`) before its provider is called, and the decision is recorded as a `routing.decided` event. The policy (ADR-022, ADR-028):

- All four roles - planner, critic, builder, reviewer - are cloud work by default, on Claude unless the run configuration pins the role to another cloud provider (ADR-024). Codex is an explicit choice for evidence runs, never a default; when no Claude adapter is authenticated the first authenticated cloud adapter takes every unpinned role.
- When the daily cloud ceiling says local-only - the day has reached it, or the stage's estimated cost (the same per-role figure the dispatch guard checks, `ROLE_ESTIMATES_USD`) would carry the day past it - the planner and the critic may run on tier 2 (`devstral-small-2` through the `ollama` adapter). The builder and the reviewer never run locally: the builder needs an agentic file-editing CLI, and a local reviewer would weaken the merge gate. A stage that may not run ends the run as `partially_completed` with a `safety_constraint` blocker whose message is the decision's reason, before any dispatch the guards would refuse; that is a policy stop, not a pause. A local-capable role with no `ollama` adapter online is refused the same way rather than sent to the cloud.
- Tier 1 (`qwen3:8b`) serves the light work classes (triage, classify, summarise, read_logs, commit_message, pr_description, interpret_test_failure), never a pipeline role.
- A retryable provider error is retried once on the same provider with bounded backoff (`provider.retry`). A non-retryable error, or an exhausted retry, routes the stage again with one more failure, which for a cloud stage means the other available cloud provider (`provider.fallback`); when none remains the stage fails with the provider's error. Nothing is retried or substituted once the run has been paused or cancelled.
- A failed builder attempt never leaves edits behind through the worker (a patch is captured only on success and applied only when present); a worktree that has changed under a failed builder is a stage failure, never a retry.
- The reviewer's read-only rule is checked across the whole stage, so it holds across a retry or a substitution.
- Residency (which models Ollama has loaded) annotates a local decision with `requiresLoad` and `estimatedLoadSeconds` from the measured cold loads; it never changes the tier.

Event shapes: `routing.decided` `{role, workClass, tier, tierName, providerId, model, reason, ceilingApplied, estimatedUsd, requiresLoad, estimatedLoadSeconds, priorFailures, allowed}`; `provider.retry` `{role, provider, code, message, attempt, delayMs}`; `provider.fallback` `{role, from, to, code, message, attempt, reason}`. `usage.recorded` carries `model` when the stage ran on a named local model. A local decision also sets `model` on the `ProviderRequest`.

## Message schema

Every substantive inter-agent message includes:

- run/task/attempt IDs;
- type;
- sender role/provider;
- claim or requested action;
- evidence references;
- affected acceptance criteria;
- confidence and uncertainty where relevant;
- timestamp and idempotency key.

Free-form prose may accompany structured data but never replace required fields.

## Completion rules

A task is done only when:

- implementation exists;
- acceptance criteria pass;
- evidence is stored;
- review findings are resolved or explicitly waived by authorised approval;
- durable trackers are updated.

A run is completed only when the release gate passes and the intended integration artefact exists. Otherwise it ends as `partially_completed`, `blocked`, `cancelled`, or `failed` with an exact report.

## Review verdicts

The reviewer's brief (`buildReviewPrompt`, `packages/workflows/src/index.ts`) defines the severity scale, and `parseReview` applies the same scale to decide approval, so what the reviewer is told blocks a merge is what blocks it.

| Severity   | Meaning                                                                                                              | Blocks merge |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------ |
| `critical` | The change is wrong, unsafe, or violates the objective.                                                              | yes          |
| `high`     | Must be fixed before merge: a real defect, a missing test for changed behaviour, or a security or data-loss risk.     | yes          |
| `medium`   | Should be fixed; does not block.                                                                                     | no           |
| `low`      | Style, naming, formatting.                                                                                           | no           |

- **Findings.** Every finding must be supported by the diff and cite the file and hunk. Formatting, import ordering and whitespace are never reported above `low`. A severity outside the scale is read as `medium`. Findings of every severity are recorded from the `review.completed` payload as Findings.
- **Approval rule.** A review round is approved when it reports no `high` or `critical` finding. The reviewer's own `approved` flag is advisory: when it withholds approval while reporting nothing that blocks, the round is approved and `review.completed` carries `approvedByPolicy: true` so the disagreement stays visible; `approved: true` beside a `high` finding is still not approved. Output without a parseable verdict yields one synthetic `high` finding and is never approved.
- **Repair scope.** A repair round receives only the blocking findings, as a numbered list of claim and requested action (`renderRepairPrompt`), and is told to fix those and nothing else. `low` and `medium` findings are not repaired, so none of the three rounds can go to style, which is what consumed the budget on the first live run (BLK-010).
- **Diff bound.** The reviewer sees at most `REVIEW_DIFF_LIMIT_BYTES` (200 KB) of the diff, cut at a line boundary. Past that the brief says how many bytes were not shown and appends `git diff --stat`, so every changed file is named even when its hunks are not.

Event shape: `review.completed` `{round, approved, findings: [{severity, claim, action}], approvedByPolicy?, rawReviewExcerpt?}`; `approvedByPolicy` is present only when the flag and the findings disagreed in the reviewer's favour, `rawReviewExcerpt` only when no verdict parsed.