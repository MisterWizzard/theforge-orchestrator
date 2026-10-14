# Decision Log

Use sequential IDs. Never delete superseded decisions; mark them superseded and link the replacement.

## ADR-001 — Provider-neutral orchestration core

**Status:** accepted  
**Decision:** Claude, Codex, and future providers implement adapters behind shared contracts. Domain and scheduler code do not depend on provider-specific concepts.  
**Reason:** prevents lock-in and lets roles be assigned by capability, availability, cost, and independence.

## ADR-002 — Direct SDK/CLI integrations before GUI automation

**Status:** accepted  
**Decision:** Use supported SDKs, CLIs, app servers, and APIs as primary integrations. Desktop/browser automation is an explicit fallback only.  
**Reason:** direct integrations are more reliable, testable, observable, and recoverable.

## ADR-003 — TypeScript monorepo

**Status:** accepted  
**Decision:** Build the initial release as a strict TypeScript pnpm/Turborepo monorepo with Next.js, a Node coordinator, Node worker, PostgreSQL, and Redis-compatible queue.  
**Reason:** shared contracts across UI, coordinator, worker, and providers reduce integration drift and support cross-platform packaging.

## ADR-004 — PostgreSQL is authoritative

**Status:** accepted  
**Decision:** Durable run state lives in PostgreSQL. Queue messages are delivery hints containing identifiers, never the sole source of truth.  
**Reason:** restart recovery, auditing, idempotency, and reconciliation require durable authoritative state.

## ADR-005 — Git worktrees for isolation

**Status:** accepted  
**Decision:** Each parallel implementation task uses an isolated branch/worktree. Integration occurs through reviewed commits.  
**Reason:** prevents agents overwriting one another and makes rollback and evidence straightforward.

## ADR-006 — Bounded repair loops

**Status:** accepted  
**Decision:** Review/repair loops stop after three rounds unless a recorded exception is approved. Each round must add new evidence.  
**Reason:** prevents infinite model debate and uncontrolled token spend.

## ADR-007 — Private distributed workers

**Status:** accepted  
**Decision:** Personal distributed mode assumes authenticated encrypted communication over Tailscale or equivalent private networking.  
**Reason:** avoids exposing powerful machine-control endpoints to the public internet.

## ADR-008 — Same-origin server-side web control boundary

**Status:** accepted
**Decision:** Browser code calls a Next.js same-origin BFF. Only that server route receives `FORGE_COORDINATOR_TOKEN`; the coordinator rejects unauthenticated API requests and restricts CORS to `FORGE_WEB_ORIGIN`.
**Reason:** control and approval authority must not be embedded in public browser JavaScript or exposed through permissive CORS.

## ADR-009 — Package-owned provider executables

**Status:** accepted
**Decision:** Claude Code and Codex CLI are pinned dependencies of their adapter packages. Adapters resolve their package-owned native/Node entrypoints and always spawn with `shell: false`.
**Reason:** PATH and Windows `.cmd` shims are not portable with safe direct spawning, while a shell would reinterpret untrusted prompt/schema arguments.

## ADR-010 — Honest checkpoint recovery

**Status:** accepted
**Decision:** Persist phase outputs and durable worker jobs, reuse exact worktree checkpoints, and expose resume/retry only through coordinator-controlled reconstruction. Never fabricate a PR URL or call an in-memory snapshot a process restart.
**Consequences:** phase outputs, attempts, provider session IDs, and completed job results are durable and idempotently reconstructed. A provider CLI may still keep machine-local session files, so cross-machine recovery is guaranteed at the durable job/phase boundary rather than by transferring private CLI state.

## ADR-011 — PostgreSQL-fenced worker scheduling

**Status:** accepted
**Decision:** PostgreSQL atomically creates attempts, leases capability-compatible jobs, renews leases, fences completion, and recovers expiry. Redis contains job identifiers only and is a best-effort wake-up hint. Provider and deterministic-check phases use the same worker protocol.
**Consequences:** coordinator restart and duplicate/lost queue hints cannot create a second accepted result. Builder work is returned as a binary patch from an isolated attempt and is applied only after the matching fenced job completes.
**Evidence:** concurrent-claim, stale-fence, capability, idempotency, accepted-patch, and real worker-loss integration tests.

## ADR-012 — Mandatory Linux container boundary for worker execution

**Status:** accepted
**Decision:** Production command and provider jobs execute in the pinned Linux Docker image with a read-only root, non-root user, dropped capabilities, no-new-privileges, resource/PID/time limits, and a workspace-only host bind. Host process execution is test-only. Commands have no network; provider jobs receive explicit bridge egress and credentials/prompts over stdin.
**Consequences:** Windows, macOS, and Linux workers provide one consistent execution environment. Provider network access remains a narrower but non-zero trust boundary, and provider CLI-local session files are not transferred between machines.
**Evidence:** sandbox tests prove non-root execution, read-only root, command network denial, provider boundary arguments, stdin-only secret handling, literal arguments, workspace writes, real provider entrypoint startup, and cancellation.
**Amended 05/10/2026:** command network denial applies to the checks (lint, typecheck, tests). The dependency-install step runs alone, before them, in a short-lived container on Docker `bridge` networking; see `docs/SECURITY.md`.

## ADR-013 — Run-scoped configuration and bounded autonomy

**Status:** accepted
**Decision:** Persist target branch, provider role assignments, required checks, USD/token/time ceilings, and the selected cautious/standard/high autonomy profile with every run. Green work remains automatic, Amber work remains policy-controlled, and every Red action always requires an exact explicit approval. No autonomy profile may weaken command, secret, protected-branch, or external-action boundaries.
**Consequences:** runs resume with the same execution policy after restart. The initial release uses exact approval for outward Git integration under every profile; higher autonomy only applies within safe, reversible run scope.

## ADR-014 — Ephemeral credential boundary for authenticated Git pushes

**Status:** accepted
**Decision:** The integration path uses the approved repository-scoped GitHub token for both Git push and pull-request API calls. Git receives the token only through a short-lived askpass child environment with credential helpers disabled; the token is never embedded in arguments, URLs, Git configuration, workspace files, logs, or returned output.
**Consequences:** a fixture-scoped token is sufficient without relying on ambient Git Credential Manager state. Askpass files are removed on success or failure, reflected secrets are redacted, and exact commit/branch approval checks still precede the push.
**Evidence:** authenticated-push unit tests inspect the child process boundary, assert token-free arguments/files/output, and prove cleanup and redaction for successful and failed pushes.

## ADR-015 — Initial release targets Windows and Linux; macOS deferred

**Status:** accepted
**Context:** `docs/PRODUCT_SPEC.md` and `docs/ARCHITECTURE.md` promised cross-platform workers across Windows, macOS, and Linux. BLK-005 has held F041 in `verification` and F090 in `blocked` since 2026-07-22 solely because production execution requires a Linux-container boundary and GitHub-hosted macOS runners cannot provide nested virtualisation. The authored built-daemon portability lifecycle already passes on `macos-latest` (registration, heartbeat, exact-revision claim, active cancellation, fenced evidence, cleanup, shutdown); only the real Docker sandbox smoke is missing, and this private repository has no self-hosted runners.

A machine audit of the operator's estate on 2026-09-24 found no macOS hardware of any kind: one Windows 11 workstation (NODEE), Raspberry Pi nodes running Debian 13 aarch64, and WSL2 Ubuntu 26.04. There is no Mac to register as a runner, and no user-facing requirement that a macOS worker exist.

Continuing to hold the release on this criterion contradicts `AGENTS.md` §4, which requires the release acceptance test to be the lighthouse and defers work that does not move toward it.

**Decision:** The initial release targets **Windows and Linux workers only**. macOS worker support moves to P1 as `P107 — macOS worker runtime support`. BLK-005 is reclassified `deferred` rather than `active`. F041 may reach `done` on Windows and Linux evidence alone.

The macOS portability job stays in CI. It passes, it costs nothing, and it preserves the evidence needed to close P107 cheaply if a Mac ever enters the estate. What is dropped is the *release gate*, not the code or the coverage.

**Consequences:**
- F041 and F090 are unblocked without weakening any criterion that applies to a platform actually in use. No test is disabled, stubbed, or skipped.
- `docs/PRODUCT_SPEC.md` and `docs/ARCHITECTURE.md` must state the narrowed initial-release platform target so the documents stop promising something the release does not claim.
- Production execution remains Docker-only on every supported platform. The host executor stays confined to `NODE_ENV=test`.
- Any future macOS claim requires the real sandbox execution/cancellation/orphan-cleanup smoke on a Docker-capable macOS host. P107 records this.

**Evidence:** GitHub Actions run `30185609945` at `1fecd2b1` — `quality`, `browser`, `portable (windows-latest)` and `portable (macos-latest)` all success. `docs/BLOCKERS.md` BLK-005 records the nested-virtualisation limitation and the absence of registered self-hosted runners. Operator estate audit, 2026-09-24: no macOS hosts.

**Supersedes / superseded by:** narrows the platform scope asserted in `docs/PRODUCT_SPEC.md` and `docs/ARCHITECTURE.md` for the initial release only. Supersedes nothing.

## ADR-016 — Deterministic checks run in the worker, not in the reviewing model

**Status:** accepted
**Context:** Fixing BLK-009 raised an open question: the builder prompt asks it to "run relevant local checks", and `acceptEdits` auto-approves file edits but not Bash. The obvious next step looked like granting `bypassPermissions` to the builder, on the grounds that the mandatory Docker boundary is the real containment. That would have widened what a model may do inside the sandbox.

Run `9d6cf990` answered the question without needing the change. The reviewer recorded a finding, at `low` severity, stating plainly:

> node --test was not executed in this review (Bash denied in don't-ask mode); test pass/exit-0 is verified by static analysis of the verified source, not by running the suite.

The same run also shows the deterministic check executing properly, in the worker's Docker sandbox, with real output captured as evidence:

```
verification.completed  checks: [{ code: 0, stdout: "TAP version 13 ... ok 1 - renders an honest ready state ..." }]
```

**Decision:** Keep `dontAsk` for every role except the builder. Do not grant `bypassPermissions`. Deterministic verification stays the responsibility of the worker's check runner, which executes the project's configured command and records exit code and output, rather than of a model asked to run the command itself.

**Consequences:**
- A reviewing model reports on what it can read and is explicit about what it did not execute. That is the correct division: a model's claim that a suite passes is an assertion, while the check runner's captured exit code is evidence. AGENTS.md section 10 requires the latter.
- The builder holds the narrowest permission that lets it do its job - it may edit files in its worktree and nothing more. Its work is validated afterwards by the check runner regardless of what it could or could not run itself.
- No change is needed for the builder to be unable to run checks. If a future objective genuinely requires the builder to execute commands, revisit this rather than widening permissions by default.

**Evidence:** run `9d6cf990`; reviewer finding recorded at `low`/`resolved`; `verification.completed` events at 20:50:47 and 20:51:26 with `code: 0` and TAP output; pull request <https://github.example/example-org/acceptance-fixture/pull/1>.

**Supersedes / superseded by:** resolves the open question recorded on BLK-009. Supersedes nothing.

## ADR-017 — The overclock is stable for sustained inference; run at stock power

**Status:** accepted
**Context:** An unstable overclock under inference does not crash. It produces silently wrong tokens, which an agent pipeline would consume as though they were correct. A gaming stress test would pass while the card quietly corrupted agent output, so thermals alone are not evidence.

The decisive test is therefore determinism: the same prompt, the same seed, temperature 0, repeated under sustained load. Every response must be byte-identical.

**Decision:** The operator's overclock is confirmed stable and is retained. Power limit stays at the stock 420 W; no undervolt is applied.

**Evidence:** 60 minutes of continuous generation on `qwen3:8b`, 2026-09-25:

| | |
| --- | --- |
| iterations | 4,635 |
| API errors | 0 |
| **distinct outputs** | **1** |
| temperature | 39–55 °C |
| power draw | 321–415 W |
| SM clock | 1980–2130 MHz |
| active slowdowns | SW Power Cap only |
| retired pages / remapped rows | none |

4,635 byte-identical responses. The only active slowdown is the software power cap, which is the 420 W limit behaving correctly rather than a fault; there was no thermal or hardware throttling. A 55 °C peak on a water-cooled card leaves substantial headroom.

**Consequences:**
- Local models may be trusted for production agent work. The blocking condition recorded on the original plan - that no local tier is trusted until burn-in passes - is satisfied.
- The earlier recommendation to undervolt to ~300-330 W is withdrawn. It was offered against an unknown overclock on the reasoning that stability matters more than the last 5% of throughput. Stability is now measured rather than assumed, and thermals are not close to a limit, so there is nothing to buy by lowering the cap.
- Re-run this burn-in after any driver update, any change to the Afterburner profile, or any cooling change. Determinism is the check; temperature is only supporting evidence.

**Supersedes / superseded by:** supersedes the provisional undervolt recommendation. Supersedes nothing formally accepted.

## ADR-018 — Local model tiers, chosen on measurement rather than architecture

**Status:** accepted
**Context:** Routing work to local models is the main lever on cost: the full cloud pipeline runs about $2.50 per task, and triage, summarisation, log reading and mechanical edits do not need it. Which models fill which tier had been chosen from vendor descriptions and search results, neither of which is evidence.

Benchmarked on NODEE (RTX 3090, 24 GB), Ollama 0.34.4, warm, temperature 0:

| model | cold load | tokens/sec | time to first token | valid structured output |
| --- | --- | --- | --- | --- |
| `qwen3:8b` | 5.0 s | **130** | 0.02 s | 5/5 |
| `devstral-small-2` (24B dense) | 11.8 s | **54** | 0.04 s | 5/5 |
| `north-mini-code-1.0:q4_K_M` (30B MoE, 3B active) | 34.7 s | **15.4** | 0.23 s | 5/5 |

**Decision:**

- **Fast tier: `qwen3:8b`.** Triage, classification, log reading, summarisation, commit messages, pull request descriptions.
- **Coding tier: `devstral-small-2`.** Mechanical edits, single-file transforms, applying known codemods.
- **Embeddings: `nomic-embed-text`.**
- **`north-mini-code-1.0` is not adopted.** It is retained on disk for a harder retest but nothing routes to it. *(No longer on disk — see the 2026-09-26 amendment below.)*

**Consequences and what the numbers actually showed:**

- The mixture-of-experts model was **3.5x slower than the dense 24B at identical VRAM**, both fully GPU-resident. Three billion active parameters was the entire reason for choosing that architecture, and on this hardware and runtime it bought nothing. Architecture is not a proxy for throughput.
- `nemotron-cascade-2`, the originally requested medium tier, was rejected earlier for a different measured reason: at 24 GB it leaves no room for a KV cache against 24,576 MiB of VRAM and would spill to system memory.
- **Every model returned valid structured output 5/5.** This was the gate most expected to fail, since a model that writes well but emits malformed JSON is useless in an agent loop where every downstream step parses its result. None of the three is disqualified on that basis.
- Cold load must be excluded from throughput. An initial measurement of `qwen3:8b` reported 12.9 tokens/sec because it folded in a 44 s first load and a thinking budget consumed before any visible output - roughly a tenth of the real figure. Any future benchmark must warm the model and disable thinking, or it will mislead.
- Only one model fits the coding tier at a time. `devstral-small-2` and `north-mini-code-1.0` are 15 GB and 19 GB; both cannot be resident together, so the router must treat a tier switch as costing a cold load. *(The sizes here mix on-disk and resident figures — see the 2026-09-26 amendment below.)*

**Limits of this evidence:** a single prompt shape, five structured-output attempts, one quantisation each. It is enough to choose a default and not enough to rank these models generally. Retest against real task transcripts once the router has traffic to replay.

**Evidence:** `docs/evidence-local-model-benchmark-2026-09-25.txt`.

**Amended 2026-09-26:** two corrections of fact. The decision itself is unchanged.

- *VRAM.* The "15 GB and 19 GB" above conflates on-disk size with resident size. The evidence file records every model at its resident size with a 32,768-token context: `qwen3:8b` 10.0 GB (`docs/evidence-local-model-benchmark-2026-09-25.txt:5`), `devstral-small-2` 19 GB (`:12`), `north-mini-code-1.0:q4_K_M` 19 GB (`:19`). 15 GB is `devstral-small-2`'s on-disk size as `ollama list` reports it. So "identical VRAM" for the dense 24B and the MoE is right, and the consequence stands: the two coding candidates could not be resident together. Nor can the fast and coding tiers as measured - 10 GB plus 19 GB is 29 GB against 24 GB at that context - so the router must treat *any* tier switch as costing a cold load until a smaller `num_ctx` is measured (Batch C).
- *`north-mini-code-1.0`.* Deleted from disk on 26/09/2026 by Dan's decision, reclaiming about 17 GB (the models directory went from 37 GB to 20 GB). `ollama list` on 26/09/2026: `devstral-small-2` 15 GB, `qwen3:8b` 5.2 GB, `nomic-embed-text` 274 MB. "Retained on disk for a harder retest" no longer holds; a retest would need a fresh pull. Nothing routed to it, so nothing changes in the router.

## ADR-019 — F091 security and release review: outcome and release label

**Status:** accepted
**Context:** Reserved for the last item of the release. PRs #13–#18 shipped on 26/09/2026 (`e8f7f47`, `8d51928`, `dd42aca`, `e4068af`, `b507535`, `b8b0ed8`): fail-fast environment, schema-per-file tests, the durable kill switch and halt-aware wait, the hash-chained audit log, the wired guards, escalation to Dan, Tier 0 outcomes, digests, the runtime scripts, the Ollama adapter and routing, worktree recovery, failed-workspace retention, raw provider tails and the reviewer brief. `docs/THREAT_MODEL.md` (2026-07-26) and `docs/SECURITY.md` (2026-07-21) predated all of it. The review had to describe what the code does, not the plan, and map every requirement in `docs/PRODUCT_SPEC.md` to evidence.

**Decision:**

- `docs/RELEASE_REVIEW.md` is the requirement-to-evidence matrix for this release and is declared by this ADR. `docs/THREAT_MODEL.md` and `docs/SECURITY.md` are rewritten for `main` @ `b8b0ed8`; `docs/evidence-dependency-audit-2026-09-26.txt` records both audits verbatim with each dev-only advisory dispositioned.
- **Release label: `release_candidate`, not `fully_built`.** The review found CI on `main` red on every push since PR #14 (`36207611749` … `36213642655`) on two test defects the Windows gates could not see (a drive-letter assertion in `packages/tier0/src/report.test.ts` and a coordinator test that clones the shallow CI checkout). Both are fixed and reproduced locally in the review; the fix is unverified in CI until it merges. Live cross-provider execution (F050/F051), live Home Assistant or email delivery, the persistent runtime, the unattended restart test and the first real local-model stage are all still undemonstrated. `fully_built` requires a green CI run on all four jobs after this merge, one live run with the critic or reviewer on Codex with its subscription cost recorded, and one real escalation received.
- **Tier 0's merge is an Amber action under a standing approval**, not a Red per-action one. `docs/SECURITY.md` lists "merge to protected branches" as Red for the pipeline, and that stands. Tier 0 merges Dependabot pull requests into `MisterWizzard/shopfront` only, on green checks, after a pre-merge re-check, with every outcome ingested into the notification channels. The allowlist is the approval, given once (policies B4/B5); expanding it is a Red decision made in a reviewed change to `packages/tier0/src/policy.ts`. Recorded here because AGENTS.md §3 requires a conflict between SECURITY.md and shipped behaviour to be resolved in this file rather than silently.
- Remediated in the review, each with a test: constant-time bearer-token comparison (`secretEquals` in `@theforge/policy`, used at every coordinator check); a specific fail-fast remedy for every coordinator and worker variable; the two CI test defects; `next dev` bound to loopback like `next start`; three dev-only advisories patched by override. GitHub Actions are SHA-pinned and the portable job's test step says what it skips; a non-blocking full `pnpm audit` step reports the dev-only list on every run.
- Left open, recorded as residual risks in the threat model and as findings in the review: `C:\forge` readable and writable by every local account (which also makes the kill-switch file writable by them); Tier 0 executing untrusted dependency code on the host under the operator's `gh` token; the Home Assistant token travelling over plain HTTP on the LAN once it exists; the web control centre relying on network position rather than a login; a refless bare cache making a run wait instead of fail.

**Consequences:** the README's "hardened release candidate" wording stays true; STATUS and TASKS (integrator-owned) should carry the CI finding and the three conditions for `fully_built`. No test was disabled, skipped or weakened. The operator's next actions are the ACL fix and token rotation, the notification secrets, then F140.

**Evidence:** `docs/RELEASE_REVIEW.md` (every row cites a file:line, a test, a CI run id, a pull request or an ADR); `docs/THREAT_MODEL.md` T1–T16; `docs/evidence-dependency-audit-2026-09-26.txt`; the F091 gate recorded in the review's structured result; CI runs `36201715186` (last green, `e8f7f47`) and `36207611749`–`36213642655` (red); local reproduction of the shallow-checkout failure on 26/09/2026 (30.1 s fail from a depth-1 clone, 2.8 s pass from a full clone).

**Supersedes / superseded by:** none. Refines the Red classification of "merge to protected branches" in `docs/SECURITY.md` for Tier 0 only.

## ADR-020 — Hash-chained event log, verified in TypeScript and retained by run

**Status:** accepted
**Context:** The `events` table is the audit trail every run reconstructs from and every decision points back at, and until migration 006 nothing distinguished an event as written from one altered or removed afterwards. Policy B11 (notify on autonomous merges, spend, CI failures, security issues) needs a record an operator can trust after the fact. An earlier prototype chained its audit log with `sha256(prev ':' canonical JSON)` from a `GENESIS` seed but ordered by timestamp and shipped no verifier, so a fork or a gap could not be shown. ADR-019 is reserved for F091.

**Decision:**

- Chain by `sequence`, not time. A `BEFORE INSERT` trigger takes `pg_advisory_xact_lock(7106, hashtext(run_id))`, draws the sequence number under that lock, reads the run's latest `row_hash`, and stores `prev_hash` and `row_hash = sha256(jsonb_build_array(sequence, id, run_id, task_id, attempt_id, type, payload, created_at as millisecond UTC ISO, prev_hash)::text)`. Client-supplied `created_at` is hashed but never ordered on.
- The canonical form is PostgreSQL's own jsonb text rendering, and `@theforge/db` re-implements that rendering (`canonicalJsonb`: keys by byte length then bytes, `", "` and `": "` separators, escape_json rules, numerics without exponents) so `verifyEventChain` recomputes every hash from the row it reads back with `node:crypto`, and a test holds the TypeScript and PostgreSQL renderings to the same bytes for unicode keys, nested payloads and edge-case numbers.
- `events` and `audit_tombstones` are append-only by trigger. The only way through is `set_config('forge.allow_event_delete', 'on', true)` for one transaction; cascades from `runs` pass through the same guard, so run deletion must opt in too.
- Retention deletes whole runs (terminal state, `updated_at` before the cutoff), never individual events, and writes a tombstone `(run_id, last_sequence, last_row_hash, event_count, deleted_at)` first. The preview and execute counts are the events and artifacts of those runs plus the run count.
- Rows from before the migration keep NULL hashes. The chain starts at the first row after it and the verifier reports those rows as `legacy`, skipped, not verified.
- `pnpm forge verify-audit [--run=<id>] [--all] [--json]` exits 1 on any break and prints the first bad sequence with the reason.

**Consequences:**
- Every event insert costs an advisory lock, a second `nextval` (the column default has already drawn one, so sequences have gaps) and a SHA-256; per run, appends are serialised. That is the price of a chain that cannot fork under the coordinator's fire-and-forget appends.
- Sequence numbers are exposed on events (`sequence`, `prevHash`, `rowHash`, all optional in the contract so in-memory events still validate).
- Editing an event by hand now needs the opt-in, and the edit is then visible to the verifier because nothing re-hashes an update. That is intended.
- Removing the last row of a run is not detectable from the chain alone; the tombstone written by retention is the legitimate record of a chain's end, and any other missing tail is an operational finding, not a verifier one.
- The migration must run on PGlite 0.3 (PostgreSQL 17 in WASM) because the migration test applies every file there twice: plpgsql, `sha256(bytea)`, `create or replace trigger`, `pg_advisory_xact_lock` and `current_setting(name, true)` were confirmed to work; pgcrypto's `digest()` was avoided because the test does not load extensions.
- Test suites that delete runs must opt in (`allowEventDeletion`); dropping the per-file schema needs nothing, since `DROP TABLE` fires no row triggers.

**Evidence:** `packages/db/src/migration.test.ts` (PGlite: triggers exist, two rows link, update and delete refused, opt-in allowed, hash equals the TypeScript recomputation), `packages/db/src/audit.test.ts` (PostgreSQL: twenty concurrent appends form one chain, tamper by update and by delete reported at the exact sequence, legacy rows, retention with tombstones, notifications dedupe, usage windows), `packages/cli/src/cli.test.ts` (`verify-audit` reporting with an injected verifier and against the real database).

**Supersedes / superseded by:** none.

## ADR-021 — Local models run in the worker process through an Ollama HTTP adapter

**Status:** accepted
**Context:** ADR-018 chose the two local tiers (`qwen3:8b`, `devstral-small-2`) and measured them; nothing could yet run on them. The cloud providers run as CLIs inside the worker's Docker sandbox, which exists to contain a credential and a file-editing agent behind a read-only root and bridge-only egress. Ollama is a local HTTP server on the worker host with neither: no credential, no tools, no file edits, and the sandbox's bridge network cannot reach it anyway (host networking is forbidden by ADR-012). The daily ceiling (B2/B3) refuses cloud calls and routes to local models, so the local path must be the one path the ceiling never refuses, and a local job must land on a worker that actually has the model.

**Decision:**

- `@theforge/provider-ollama` implements `ProviderAdapter` over plain HTTP with the global `fetch`, no new dependency: one streamed `POST /api/chat` per request (`temperature: 0`, `num_ctx` per tier, `think: false` for a model whose `/api/show` capabilities include `thinking`, `format: <JSON Schema>` when the request carries one), NDJSON split as it arrives, `text_delta` per chunk, `usage` from `prompt_eval_count`/`eval_count` with `usd: 0`, `completed` with the text or the schema-validated JSON. Output is bounded at 10 MB like a CLI provider's stdout; the request timeout, the caller's abort and every failure shape map to the existing event codes (`TIMEOUT`, `CANCELLED`, retryable `PROCESS_EXIT` for a refused connection or a 5xx, non-retryable for a 4xx, `STRUCTURED_OUTPUT_INVALID` at the trust boundary).
- The worker runs an `ollama` job **in its own process**, never in the sandbox: no credential envelope, no container; the same `collectProviderEvents` applies the per-task limits and secret redaction. At startup it probes `FORGE_OLLAMA_URL` and advertises `provider:ollama` plus `model:<name>` for each listed model; an unreachable server is one log line, not a failed start.
- `ProviderRequest` gains an optional `model`; the Claude and Codex adapters honour it over their configured default. `providerIds` (`claude | codex | ollama`) in `@theforge/contracts` is the one enumeration, used by `providerRoles`, the jobs API, the database's stored action and the worker.
- The coordinator dispatches an `ollama` job with `requiredCapabilities: [provider:ollama, model:<name>]` and nothing about Docker or Linux; a request naming no model gets the tier-2 model so the requirement is always concrete. `Guards.beforeCloudCall` returns `allowed` for a local provider before any ceiling arithmetic: it is neither estimated, nor warned about, nor refused. `UsageRecord.model` is filled from `usage.recorded` when the pipeline reports it.
- Roles: all four pipeline roles stay on cloud by default (Dan, 26/09/2026). At the ceiling the planner and the critic may run on tier 2; the builder and the reviewer pause and escalate, because the builder needs an agentic file-editing CLI and a local reviewer would weaken the merge gate. That rule lives in provider selection (F121), not in the adapter, which serves any role it is given. Tier 1 serves the light work classes, not pipeline roles.

**Consequences:**
- A local call costs nothing and the ceiling cannot see it, by design. It also cannot be *distinguished* from an unmetered cloud call by cost alone, which is why the guard keys on the provider id (`LOCAL_PROVIDERS`), not on `usd`.
- The worker process now makes outbound HTTP to the loopback address it is configured with. `FORGE_OLLAMA_URL` is trusted configuration, like `FORGE_API_URL`; pointing it at a remote Ollama would be a policy change (egress from the worker host) and is not enabled by this ADR.
- The two tiers cannot be resident together, so a run that alternates tiers pays a reload each time (measured 26/09/2026: qwen3 2.5–6.7 s, devstral 5–10.6 s). Residency is readable through `listLoadedModels` (`/api/ps`) for the router to price that.
- `pnpm test` never touches the real server; the adapter, worker and coordinator suites run against an in-process fake (`@theforge/provider-ollama/testing`). The one real request is behind `FORGE_OLLAMA_SMOKE=1`.
- `packages/workflows` still types `providerRoles` as `claude | codex`; the coordinator casts until F121 widens it. The web form's provider select does not yet offer `ollama`.

**Evidence:** `packages/provider-ollama/src/adapter.test.ts` (streaming, usage, schema pass-through and validation, abort, timeout, refused connection, 4xx/5xx, output bound, diagnostics, `/api/ps`; the smoke test against `qwen3:8b` and its recorded output), `apps/worker/src/index.test.ts` "worker local models" (capability advertising against a fake tags server; an in-process job with model, `num_ctx` and redaction), `apps/coordinator/src/guards.test.ts` (a local provider allowed under an exceeded ceiling with no events), `apps/coordinator/src/server.test.ts` (an ollama job accepted, stored and leased on its model capability; a run whose planner is ollama dispatched without a sandbox requirement next to a sandboxed critic).

**Supersedes / superseded by:** none. Builds on ADR-012 (the sandbox boundary is unchanged for cloud providers) and ADR-018 (the tiers).

## ADR-022 — Routing: cloud by default, local under the ceiling for planner and critic only

**Status:** accepted
**Context:** The guards (PR #15) refuse a cloud dispatch once the local day is over the ceiling and pause the run. That is the right last line, but it fires *after* the pipeline has chosen a provider, so a stage that could have run locally was paused instead, and the operator learned about it from a guard refusal rather than from a routing decision. `route()` in `@theforge/guardrails` already demotes tier-3 work to tier 2 at the ceiling; nothing connected it to the pipeline's four roles, and the routing table had no opinion on which roles may go local at all. Measured on 26/09/2026 (`docs/evidence-local-model-benchmark-2-2026-09-26.txt`): `qwen3:8b` ~130 tok/s, `devstral-small-2` ~53 tok/s; the two are never co-resident on the 24 GB card, a tier switch costs a reload (qwen3 2.5–6.7 s, devstral 5–10.6 s); recommended `num_ctx` 8192 (tier 1) and 16384 (tier 2); Ollama serialises requests (`OLLAMA_NUM_PARALLEL=1`). Dan's policy, 26/09: every pipeline role stays on cloud by default; under the ceiling the planner and the critic may run on tier 2, the builder and the reviewer must pause and escalate. ADR-019 is reserved; ADR-021 belongs to the provider slice that adds the `ollama` adapter.

**Decision:**

- `routeRole` (`packages/guardrails/src/router.ts`) places a stage. `ROLE_WORK_CLASS` maps planner → `architecture`, critic → `code_review`, builder → `multi_file_feature`, reviewer → `code_review`, all tier 3; `LOCAL_FALLBACK_ROLES = ['planner', 'critic']`. Tier 3 goes to the role's configured cloud provider, or to another available cloud provider when that one is unavailable or has already failed the stage. Tier 2 goes to `ollama` with `devstral-small-2:latest`, only for a role in `LOCAL_FALLBACK_ROLES` and only when an `ollama` adapter is available; otherwise `allowed: false` with a reason naming the policy ("builder must not run locally; pausing for the ceiling" - reworded to "stopping the run at the ceiling" by ADR-028, since the outcome is a policy stop, not a pause). Tier 2 is the floor for a pipeline role, so tier 1 is structurally unreachable for them. The tier's `claude` label is not a model name: a cloud decision carries `model: null` and the adapter chooses.
- `AutonomousPipeline` (`packages/workflows/src/index.ts`) routes every stage through `routeRole` before the provider call and emits `routing.decided`. A refused first decision ends the run as `partially_completed` with `blocker` set to the reason and `classification: 'safety_constraint'`, which the coordinator already turns into a blocker from `run.finished`. Retry and fallback per `docs/EXECUTION_PROTOCOL.md` "Routing and fallback": one retry on the same provider for a retryable error, then the other cloud provider, then failure as before; `provider.retry` and `provider.fallback` are emitted; nothing is retried once the run's signal is aborted. A builder is never retried onto a worktree that changed under the failed attempt. `usage.recorded` and the `ProviderRequest` carry `model` for a local stage.
- Residency (`route({ residency })`) annotates a decision with `requiresLoad` and `estimatedLoadSeconds`, seeded from the measured upper bounds (`MODEL_LOAD_SECONDS`: qwen3 6.7 s, devstral 10.6 s). Annotation only.
- The pipeline never picks `ollama` as a default provider for any role, and refuses a role pinned to `ollama` in `providerRoles`: local execution is granted by the ceiling policy, not configured.

**Consequences:**

- The coordinator wires four optional inputs on `AutonomousPipelineInput`: `usageSource` (its usage records in the guard shape, `toGuardUsage`), `ceiling` (the `CeilingConfig` it builds for `Guards`), `timeZone` (`FORGE_TIMEZONE`) and `residency` (`listLoadedModels` from the provider slice). Without `usageSource` the pipeline routes to the cloud exactly as before, so the guards remain the last line and nothing regresses if wiring lags.
- A day over the ceiling now costs the builder stage a policy stop instead of a wasted dispatch and a guard pause; the planner and critic stages complete locally first, so a resumed run picks up at the builder with plan and critique in hand.
- `RouteDecision` gains two required fields; anything constructing one by hand (none in the repository today) must supply them.
- The escalation table does not yet notify on a `run.finished` carrying `classification: 'safety_constraint'`; that is a coordinator follow-up if the operator wants a phone message for a policy stop as for a guard pause.

**Evidence:** `packages/guardrails/src/guardrails.test.ts` (`routeRole`: every branch, residency annotation, no tier 1 for any role), `packages/workflows/src/pipeline-routing.test.ts` (real temporary git repository, scripted `claude`/`codex`/`ollama` adapters: cloud by default with `routing.decided` before the call; planner and critic on `ollama`+devstral under the ceiling with `model` on the request and the usage record, builder stops the run with the `safety_constraint` blocker; retry then success; exhausted retries fall back; non-retryable falls back to the other cloud provider with the substitution announced; exhausted fallback fails as before; partial builder edits are never retried; reviewer read-only across a substitution; nothing retried once aborted).

**Supersedes / superseded by:** extends ADR-018 (tiers) to the pipeline roles; amended by ADR-028 (the ceiling trigger includes a projected crossing, and a refusal is worded as the policy stop it is); none superseded.

## ADR-023 — Escalation severity routing and no DND bypass

**Status:** accepted (Dan, 27/09/2026)
**Context:** Until now the Notifier sent every escalation to every configured channel, so once `FORGE_HA_TOKEN` exists the phone would receive the routine traffic too: every Tier 0 merge and deferral (`tier0.merge`, `tier0.deferred`, both info), both daily digests (info), and any other notice that nothing is waiting on. A push notification that is usually routine is one Dan learns to ignore, which defeats policy B9. Separately, `haNotificationBody` marked critical escalations `importance: high, priority: high, ttl: 0`, which the companion app treats as "override the phone's own settings"; nothing in TheForge is urgent enough to shout over Do Not Disturb, and the email and the outbox carry the full text regardless. The `notifications` table already allows a `skipped` status (migration 006), so a channel left out by policy can be recorded without pretending it failed.

**Decision:**

- Severity decides where an escalation goes. `warn` and `critical` reach the phone (Home Assistant push), email and the file outbox. `info` reaches email and the file outbox only, never the phone. The file outbox receives everything. The table is one pure function, `channelsForSeverity` in `packages/notify/src/routing.ts`; the Notifier applies it on every dispatch (a coalesced summary is routed by its worst held severity) and `pnpm forge notify-test` prints it, so the two cannot disagree. A channel the table does not name receives every severity: the only thing severity withholds is the phone.
- A channel routing leaves out is reported explicitly: `ChannelResult.status: 'skipped'` with `reason: 'severity_routing'`, attempts 0. It never counts as a delivery for dedupe, never makes the command exit non-zero, and the coordinator records it as a `skipped` row rather than omitting it or calling it `failed`, so the digest's per-channel counts show the routing at work.
- Nothing bypasses Do Not Disturb. The Home Assistant body carries `tag` (so a coalesced follow-up replaces rather than stacks) and `group`, and nothing else: no `importance`, `priority` or `ttl` for any severity, and never `channel: alarm_stream`. A critical escalation reaches the phone because routing sends it there, not by overriding the phone.
- `pnpm forge notify-test` takes `--severity=info|warn|critical` (default `warn`, the lowest severity that reaches the phone, so a push is proven without sending a critical), prints `routing: <severity> -> <channels>` for each severity before it sends, and refuses `--channel=ha --severity=info` rather than exit 0 having sent nothing.
- A digest is info by definition, so `pnpm forge digest --channel=ha` is refused rather than honoured, and a digest never mentions the phone as missing. The compact head (title plus six lines) still opens the email and the outbox file; it is no longer a phone rendering.

**Consequences:**

- Once `FORGE_HA_TOKEN` exists the phone sees only what may need Dan's hand: decisions, CI and run failures, security findings, spend and guard events. Tier 0 merges and deferrals and the two daily digests arrive by email and in the outbox.
- A critical escalation on a silenced phone waits like any other notification. If a class of event ever needs to override Do Not Disturb, that is a new decision, not a flag.
- `ChannelResult.status` gains `skipped` and `NotificationRecord.status` in the coordinator gains `skipped`; anything that treats "not sent" as "failed" must check the status, which `formatReport`, the escalation hook's log line and the digest's counts now do.
- `SEVERITY_ROUTING` is the one place to change if a channel is added or a severity is moved.

**Evidence:** `packages/notify/src/routing.test.ts` (the table, order, unknown channels), `packages/notify/src/notifier.test.ts` "severity routing" (info skips the phone and reports it; warn and critical reach it; a skipped channel is not a delivery for dedupe; a warn inside a burst of info routes the summary to the phone; an injected route is honoured), `packages/notify/src/ha.test.ts` (same `tag` and `group` for every severity, no `importance`/`priority`/`ttl`/`channel`, no `alarm_stream`), `apps/coordinator/src/escalation.test.ts` (a skipped channel is logged and recorded as skipped), `packages/cli/src/cli.test.ts` "notify-test" (`--severity` validation, the info-to-phone refusal, the routing lines, a critical body with only `tag` and `group`, `--severity=info` skipping a configured phone with no HTTP call), `packages/cli/src/digest.test.ts` (`--channel=ha` refused; with Home Assistant configured the digest reports `ha skipped (severity routing)` and never calls it, in dry run and for real).

**Supersedes / superseded by:** refines the delivery half of policy B9 as implemented in F113 (`@theforge/notify`); none superseded.

## ADR-024 — Claude is the default provider for every role; per-run budget default $5

**Status:** accepted (Dan, 27/09/2026)
**Context:** Until now a run that named no providers was spread across both cloud CLIs: `RunConfigurationSchema` defaulted the planner and the builder to `codex` and the critic and the reviewer to `claude`, and `AutonomousPipeline` independently chose "the first cloud adapter" for the planner and "the other cloud adapter" for the critic and the reviewer when a role was left unpinned. Two things made that the wrong default. Codex runs on a subscription and its adapter records `usd: 0` for every call (F111), so a default run's cost was partly invisible to the run budget, the daily ceiling and the digest, which had to carry an "unmetered" line to explain the gap. And both live runs to date (`9d6cf990`, `fbc717e6`) pinned every role to Claude anyway; the Codex split existed only in the fake-provider acceptance test. Separately, the per-run budget defaulted to $10 in `POST /api/runs` and the web form while the demo used $5 and the proven live run cost $2.55 against an $8 cap; a $10 default let one unattended run spend half the $20 day. Questions Q20-Q22 and Q24 of the 27/09 review. ADR-023 is unassigned.

**Decision:**

- One provider by default. `DEFAULT_CLOUD_PROVIDER_ID = 'claude'` (`packages/guardrails/src/router.ts`). In `AutonomousPipeline` every role a run does not pin runs on the authenticated `claude` adapter; when no `claude` adapter is authenticated, the first authenticated cloud adapter takes every unpinned role instead. The "other provider" pairing is gone: an unpinned critic no longer looks for a provider different from the planner, and an unpinned reviewer no longer looks for one different from the builder.
- Codex is an explicit choice. A run reaches Codex only by pinning a role in `configuration.providerRoles` (the evidence runs do, for all four roles). `RunConfigurationSchema.providerRoles` therefore stores only the roles a run pins: its four fields are optional with no default, so a stored configuration never claims a provider the run did not ask for, and `GET /api/runs/:id` shows `providerRoles: {}` for a default run. The web form starts every role on Claude and sends what the operator chose.
- Pinning is unchanged. A pinned role is honoured or refused exactly as before: pinning `ollama` throws (`planner cannot be pinned to ollama; local execution is decided by the ceiling policy`), pinning a provider that is not authenticated throws (`Configured reviewer provider codex is not available`), and a partial pin (say `builder: codex`) leaves the other roles on the default.
- The ceiling routing of ADR-022 is untouched. Under the ceiling the planner and the critic go to `devstral-small-2` through `ollama` and the builder and the reviewer refuse with the `safety_constraint` blocker; the default provider plays no part in that decision, and Codex is never the substitute at the ceiling (it is unmetered, not local). `routeRole`'s tier-3 substitution order (`CLOUD_PROVIDER_IDS`, claude first) already agrees with the default.
- Per-run budget. `POST /api/runs` defaults `maxUsd` to 5 (was 10); `maxTokens` stays 100000. The web form and the testkit fixture start from the same figure. A caller may still pass any higher value explicitly; nothing caps what is asked for except the daily ceiling.
- Q20/Q21, confirmed in code rather than changed: Codex usage is recorded at $0 (`packages/provider-codex/src/index.ts`), the guards treat `codex` as unmetered (`UNMETERED_PROVIDERS`, estimate $0, one warning per day, never added to the day total) and still refuse it once the day is over the ceiling, and `pnpm forge digest` lists such calls under `unmetered` with "the ceiling cannot see these". Nothing in the routing or the guards uses Codex as a fallback at the ceiling.

**Why:** one provider by default keeps cost accounting simple: a default run's `spent.usd`, the day total and the digest all describe the same calls, and the budget a run is given means what it says. Codex stays an explicit evidence path, chosen when a run is meant to demonstrate cross-provider execution (F050/F051), not something a default run drifts into. A $5 default is above the cost of the one proven live run and below a quarter of the day.

**Consequences:**

- A default run now costs metered dollars for all four stages where before two of them were $0 on the subscription. That is the point, and the daily ceiling bounds it.
- The default no longer buys provider independence between planner and critic, or builder and reviewer, for free. A run that wants a second opinion from a different vendor pins the critic or the reviewer to `codex`. `docs/EXECUTION_PROTOCOL.md` "Provider order is configurable. Independence matters more than brand order" still holds: independence is a choice the run makes, not a default it inherits.
- Stored runs whose configuration already carries four roles keep them and resume exactly as before; the coordinator passes whatever `providerRoles` a run holds, and the pipeline treats an absent or `undefined` role as unpinned (`AutonomousPipelineInput.providerRoles` widened accordingly for `exactOptionalPropertyTypes`).
- With Claude quota-blocked and Codex authenticated, a default run now goes to Codex for every role rather than failing on a pinned Claude, and the digest flags every call as unmetered. That is deliberate: the fallback is a way to keep working, not a way to hide spend.
- The Playwright flows assert the new form defaults (`maxUsd: 5`, every role `claude`) and select `codex` to prove persistence, since the previous choice of `claude` is now the default and would no longer show a reset.

**Evidence:** `packages/workflows/src/pipeline-routing.test.ts` "AutonomousPipeline default providers" (claude for every role with codex listed first; the same with `providerRoles` absent; fallback to the first authenticated cloud adapter when claude is not authenticated, ollama untouched; a pinned `builder: codex` beside claude defaults; all four pinned to codex; a pinned unauthenticated provider still refused; ceiling routing unchanged for the default provider), `apps/coordinator/src/server.test.ts` "defaults a new run to a $5 budget and pins no role" (`budget {maxUsd: 5, maxTokens: 100000}`, `providerRoles: {}`, a higher explicit cap and a partial pin stored as given), `packages/guardrails/src/guardrails.test.ts` (`DEFAULT_CLOUD_PROVIDER_ID` is `claude`, a cloud id, first among substitutes), `apps/coordinator/src/guards.test.ts` (codex unmetered and still refused over the ceiling, unchanged).

**Supersedes / superseded by:** refines ADR-022 (which roles may go local is unchanged; which cloud provider they default to is now fixed); none superseded.

## ADR-025 — Digest: operator reminders file and the Monday week-in-review

**Status:** accepted (27/09/2026)
**Context:** The digest (policy B12, `pnpm forge digest`) reports what the system did, not what Dan asked himself to remember (Q14/Q39): "rotate the staging token before the 30th" had nowhere to live that would reach the phone at 05:00. Two digests a day also hide the week's shape - what the cloud cost, how much ran at $0 on the Codex subscription or the local models, what finished, what Tier 0 merged, on which days the ceiling was hit - and Monday morning is the natural time to read that (Q35). Finally the digest's `$0` figures for Codex read as a saving or an accounting gap rather than what they are (Q20): calls on a subscription, outside the ceiling by design (ADR-021). Dan decided all three on 27/09/2026.

**Decision:**

- **Reminders.** `FORGE_REMINDERS_FILE` (default `<outbox>/reminders.md`) is a plain text file the operator edits by hand: one reminder per non-empty line, `#` starts a comment. A line may begin with `YYYY-MM-DD ` (a date, then whitespace) meaning "show from that local day on"; an undated line always shows, a dated one only once the digest's local day has reached it, and a line that is only a date is dropped. The digest renders a "Reminders" section first in the Markdown (every due line, then a count of lines dated for later) and one `reminders:` line in the compact head (three reminders, then `+N more`). No file is no section and no error. A file that exists but cannot be read is one line inside the section, never a failed digest. The digest reads the file and never writes it.
- **Week in review.** On a `morning` digest whose local date (`FORGE_TIMEZONE`) is a Monday, or on any window when `--weekly` is given, a "Week in review" section covers the seven local days before the digest's day - Monday 00:00 to Sunday 24:00 in the scheduled case, computed with the same zone maths as the windows, daylight saving included. It reports: cloud spend in USD by provider (`sumUsageSince` over the range, providers with a nonzero total); unmetered calls counted separately by provider and labelled `$0, not counted against the ceiling`; runs finished by state (a run's final `updatedAt` inside the range); Tier 0 merged / deferred / escalated counted from the `<outbox>/tier0/*.json` outcome files timestamped inside the range (the same reader the daily section uses, `parseOutcomeRecords`); and the local days that carry a `spend.ceiling` event (the event's `day` payload, with the event's timestamp in the zone as a fallback). It sits after the routing line and before the health footer, with one `week to <date>:` line appended to the compact head. Outside a Monday morning the heading says `(asked for with --weekly)`, the JSON carries `forced: true`, and the escalation's evidence line records the flag.
- **Wording.** Wherever the digest shows Codex or any other unmetered call, the text says what it is: `codex 1 call (subscription): $0, not counted against the ceiling`; the spend-by-provider list marks a $0 `codex` entry `(subscription)` and a $0 `ollama` entry `(local)`; the routing line reads `N unmetered (subscription or local, $0, not counted against the ceiling)`. The classification stays by provider id, as ADR-021 chose, not by cost.

**Consequences:**

- The compact head is no longer a fixed title-plus-six-lines: a reminders line and a week line are appended when present, so a Monday with reminders shows nine lines. Home Assistant shows them last; nothing in the repository parses the head by line count.
- The reminders file is operator-authored and rendered verbatim into the email and the phone push. It must not hold secrets, and nothing in it is interpreted beyond the optional date prefix.
- `--weekly` is relative to the digest's local day, so on a Wednesday it reviews the previous Wednesday to Tuesday, not the calendar week; the heading gives the dates so there is no guessing.
- Ceiling days come from `spend.ceiling` events, which the coordinator emits once per local day the first time it refuses a cloud call. A day that went over while the coordinator was down leaves no event and is not listed; the daily spend figure is the number to trust for that.
- `DigestData` gains `reminders` (always present) and `weekly` (present only when due or forced); `CollectOptions` gains `remindersFile` and `weekly`. `--json` consumers see both.

**Evidence:** `packages/cli/src/digest.test.ts`. Without a database: `parseReminders` (comments, blanks, CRLF, a tab after the date, a bare date, a colon after a date, past / today / future gating), `remindersFilePath`, `isMonday`, `weekRange` (including across the 04/10/2026 daylight-saving change) and `weeklyDue`; `--weekly=<value>` refused. Against PostgreSQL with the injected clock: the reminders section and compact line from `<outbox>/reminders.md` (five due, three shown, `+2 more`, one dated for later), `FORGE_REMINDERS_FILE` pointing elsewhere, an unreadable file reported inside the section with exit 0; the Monday 28/09/2026 morning review with the expected spend, unmetered, runs-by-state, Tier 0 and ceiling-day figures, and its absence from the same Monday's evening digest, the Saturday morning and `--now`; `--weekly` on the Saturday evening producing the different seven-day figures and the `(asked for with --weekly)` heading; the reworded unmetered, provider and routing lines. 17 tests in the file, 53 in `@theforge/cli`, all green on 27/09/2026.

**Supersedes / superseded by:** none. Extends the daily digest (policy B12; `docs/OPERATIONS.md` "Daily digests"); the wording follows ADR-021.

## ADR-026 — ci-watch: post-merge and system-PR CI failures escalate as warn

**Status:** accepted (27/09/2026)
**Context:** Policy B11 lists "CI failure on touched work" among the reasons Dan is reached. The coordinator's escalation table (`apps/coordinator/src/escalation.ts`) covers the CI the coordinator itself runs: `ci.failed`, `ci.integration_failed`, `ci.worker_job_failed`. Two kinds of touched work outlive the coordinator and nothing watched them. A Tier 0 merge runs the repository's checks locally and squash-merges (policy B4/C6); GitHub's own workflow then runs on the default branch and nobody reads it, so a bump that passes `pnpm test` locally but fails a job the workflow adds (a matrix leg, a build, a deploy) fails silently on `main`. The pipeline pushes `forge/<run>` and opens a draft pull request, then its run completes; the PR's checks run unread. Dan decided on 27/09/2026 (B11 scope, Q27): both are "CI failure on touched work", both produce a **warn** escalation, once per merge commit and once per PR head, with a link to the run. Two facts shaped the design: `gh pr merge` prints nothing machine-readable, so Tier 0 had never recorded the merge commit; and the pipeline applies no label and writes two different PR bodies, so the head branch prefix `forge/` (set in code by both PR paths, `apps/coordinator/src/server.ts` and the workflow's `input.branch`) is the only reliable marker of a system-opened pull request.

**Decision:**

- Tier 0 records the merge commit. After a successful `gh pr merge` the runner asks `gh pr view --json mergeCommit` (`lookupMergeSha`, `packages/tier0/src/runner.ts`) and writes it as `mergeSha` on the outcome record. A failed lookup leaves the field absent and the merge stands. `parseOutcomeRecords` treats `mergeSha` as optional, so every outcomes file written before this still reads; `ci-watch` asks GitHub for the SHA when a file lacks it, and asks again next run if GitHub has no answer yet.
- `pnpm forge ci-watch` (`packages/cli/src/commands/ci-watch.ts`) reads the executed merges from `<outbox>/tier0/*.json` written in the last `--hours` (default 48) and asks `gh run list -R <repo> --commit <sha>` for their workflow runs. For the merge allowlist, every repository seen in those files and any `--repo=owner/name`, it lists open pull requests and keeps the ones whose head branch starts with `forge/`, reading their `statusCheckRollup`. A completed failure (run conclusion `failure`, `timed_out` or `startup_failure`; check run likewise; commit status `FAILURE` or `ERROR`) becomes `ci.post_merge_failed` ("CI failed on shopfront main after Tier 0 merge of #123") or `ci.system_pr_failed` ("CI failed on shopfront PR #45 opened by TheForge"), severity warn, nothing paused, the run URL first in the evidence, dedupe key `ci-watch:merge:<repo>@<sha>` or `ci-watch:pr:<repo>#<n>@<head>`. A failure wins even while other runs are still going. Success records a marker. Queued, in progress or `action_required` records nothing and is re-checked next run. `cancelled`, `skipped`, `neutral` and `stale` are not failures. Runs with `event: dynamic` (GitHub's own Dependabot Updates job, CodeQL default setup) are left out before deciding: on shopfront merge `c8b2fcf0` the "Dependabot Updates" run had failed while the repository's CI passed, and that is not CI on the touched work. No runs at all stays pending for six hours after the merge (or the PR's last update), then is recorded as `none`, so a repository whose workflow never runs on push stops being queried.
- State lives in `<outbox>/ci-watch/state.json`: one marker per key with the outcome, the time and, for a failure, the run URL and whether the message went out. A key with a marker is neither queried nor escalated again; markers older than 30 days are pruned. A new push to a system PR is a new head and a new key. `--dry-run` sends nothing and writes neither the state file nor the outbox; `--json` prints the whole report as one document. Exit 0 when every check was read and every message sent, 1 when a `gh` call or a channel failed, 2 for usage.
- GitHub is reached the way Tier 0 reaches it: the `gh` CLI through the injectable `CommandRunner`, so the command inherits the operator's login and never handles a token, and the tests feed it JSON with no network.
- It runs on a schedule after Tier 0: `scripts/register-ci-watch.ps1` registers "TheForge CI Watch" under `\TheForge\` every 30 minutes, running `scripts/run-ci-watch.ps1` with the same principal options as the digests (`-RunWhenLoggedOff` → S4U). Nothing registers itself; an operator runs the script.

**Consequences:**

- B11's "CI failure on touched work" now covers work the coordinator has let go of. A failing post-merge workflow or a failing system PR reaches Dan within about half an hour, once, with the run link, and the digest's escalation section counts it like any other.
- The scheduled task needs the `gh` login of the task user, which is broader than the fine-grained `GITHUB_TOKEN` the pipeline uses (`docs/THREAT_MODEL.md` already records the `gh` token as a credential); `ci-watch` only reads with it.
- Cost is bounded: one `gh pr view` per Tier 0 merge at merge time, then per `ci-watch` run one `gh run list` per merge commit not yet decided and one `gh pr list` per repository. A quiet half hour is two or three calls.
- The notifier's six-hour dedupe still sits in front of every send; the state file is the long-term dedupe, so a state file lost or hand-edited costs at most one repeated message per key.
- A failure that is later fixed by re-running the workflow is not "un-escalated": the marker stands, the next digest shows the escalation, and nothing further is said about that commit.

**Evidence:** `packages/cli/src/ci-watch.test.ts` (run and rollup classification for every conclusion; both escalation shapes; outcome files in and out of the window, old shape without `mergeSha`, unreadable file; state file missing, malformed and pruned; end to end against a fake `gh`: failure escalated and written to the outbox, success recorded, pending left alone, old-shape merge looked up, a human's failing PR ignored, second run escalates only the newly failed merge and the moved PR head, third run is silent with no `gh run list` at all; `--dry-run` writes nothing; `--json`; a `gh` failure reported with exit 1 while the rest proceeds; the six-hour no-runs grace; `--repo` and flag validation), `packages/tier0/src/runner.test.ts` (merge path makes the lookup its last call and records the SHA; a failed, unparseable, null or malformed answer leaves `mergeSha` unset and the merge intact), `packages/tier0/src/report.test.ts` (`mergeSha` round-trips, is absent when nothing merged, is ignored when malformed; the old shape parses; `outcomeReportTime`).

**Supersedes / superseded by:** extends the Tier 0 decisions (B4, C3, C6) and the B11 escalation table; none superseded.

## ADR-027 — Operator login for the web control centre

**Status:** accepted (27/09/2026)
**Context:** Until now `apps/web` authenticated nothing. `apps/web/app/forge-api/[...path]/route.ts` forwarded every request to the coordinator with `FORGE_COORDINATOR_TOKEN`, mutations were gated only by same-origin headers, and the sole boundary was the network: `next start` on `127.0.0.1` (threat model T15, residual risk 4). Dan's decision, 27/09/2026 (Q49): the web app gets its own operator login before it is ever reachable over Tailscale, and it fails closed. Constraints: one operator and one password, so no user database; a session that survives a page reload but not a laptop left signed in for a day; the coordinator token never reaches the browser; nothing new to install; the existing hermetic Playwright stack keeps proving the dashboard.

**Decision:**

- Configuration. `FORGE_WEB_OPERATOR_PASSWORD` (16+ characters) is required. `FORGE_WEB_SESSION_SECRET` (16+ characters) is optional; when it is unset the session key is derived from the password with HKDF-SHA256 (fixed public salt and info, `apps/web/lib/auth/session.ts`), so one variable is enough. With the password missing or short, every route except `/login`, `/logout` and `/forge-api/health` answers 503 - a page, or `{"error":"operator_login_not_configured"}` under `/forge-api/` - and never the app (`apps/web/lib/auth/config.ts`, `gate.ts`).
- Login. `GET /login` renders a password-only form outside the shell. `POST /login/session` (node runtime) applies the proxy's same-origin rule (`Origin` equal to `FORGE_WEB_ORIGIN` or the request origin, and `Sec-Fetch-Site: same-origin`; anything else is 403), compares the SHA-256 digests of the submitted and configured password with `crypto.timingSafeEqual` (`password.ts`), and on success sets `forge_session`: HttpOnly, SameSite=Strict, Path=/, Max-Age 12 h, Secure when the request, `x-forwarded-proto` or `FORGE_WEB_ORIGIN` is HTTPS. The cookie is `v1.<base64url {issuedAt, expiresAt, nonce}>.<base64url HMAC-SHA256>`; verification is Web Crypto so the same module runs in the edge-runtime middleware, refuses a token that claims a longer life than we issue, and compares nothing with `===`. Two Next.js details the same-origin rule depends on: `/login` carries `Referrer-Policy: same-origin` instead of the site-wide `no-referrer`, because under `no-referrer` Chromium sends `Origin: null` on a form navigation (a `fetch()` keeps its origin, which is why the proxy never noticed); and `skipMiddlewareUrlNormalize` is on, because the middleware adapter otherwise rewrites a redirect to `127.0.0.1` as `localhost`, where the cookie is not. Redirects are built on the `Host` (or `x-forwarded-host`) the browser addressed, never on `request.url`, which self-hosted `next start` reports as `localhost` whatever was typed.
- Throttle. In the web process, per source (`x-forwarded-for` first hop, else `x-real-ip`, else `direct`): five failures lock that source for 60 s and the count restarts when the lock lapses; fifty failures from all sources within ten minutes lock everyone for 60 s, so rotating `x-forwarded-for` cannot dodge the first rule; every failure also waits 300 ms; a success clears that source only (`throttle.ts`). Forgotten on restart, by design.
- Gate. `apps/web/middleware.ts` runs on every request except Next's static assets. Without a valid cookie a page request is redirected to `/login?next=<path>` (307; 303 for a non-GET) and a `/forge-api/*` request gets 401 `{"error":"operator_login_required"}`; `/forge-api/health` stays open so a monitor can tell web-up from web-down. A signed-in `GET /login` goes to `/`. The same-origin JSON check on proxied mutations is unchanged and now sits behind the session.
- Logout. `/logout` (GET or POST) clears the cookie and lands on `/login`; the token is stateless, so the cookie is the whole session. The signed-in layout (`app/(shell)/layout.tsx`) carries a "Log out" link; the root layout is the document only, so `/login` has no rail.
- Doctor. `pnpm forge runtime doctor` gains an advisory `web operator password` line: `OK` with a `WARNING` detail when the variable is missing or short. It never fails the pre-flight, because the web app is not one of the registered tasks and the value is never printed.

**Consequences:**

- The coordinator token now sits behind a session as well as the network. The web app can be published on the tailnet (Tailscale Serve for HTTPS, which also gives the cookie `Secure`) without handing the whole coordinator API to anything that reaches the port. Threat model T15 and residual risk 4 are updated.
- One password, one operator: no accounts, no roles, no change-password flow beyond editing `.env` and restarting. With no separate secret, changing the password also invalidates every session, because the key is derived from it; set `FORGE_WEB_SESSION_SECRET` to keep the two apart (rotate the secret to sign every browser out, change the password without doing so).
- Sessions are 12 h fixed from sign-in, not sliding, and nothing is stored server-side: a copied cookie is valid until it lapses or the key changes, and "Log out" clears one browser's cookie and nothing else. Rotate the secret to revoke.
- `curl` against `/forge-api/*` now needs the cookie; scripts use the coordinator's `/api/*` with the token, as before.
- The e2e stack signs in through the real form for every spec (`tests/e2e/login.ts`); there is no test back door. The lockout is per source label, so the lockout spec gives itself an `x-forwarded-for` of its own and the desktop and mobile projects cannot lock each other out.
- ADR-023 to ADR-026 are not in this file at the time of writing; the number was assigned by Dan for this slice.

**Evidence:** `apps/web/lib/auth/*.test.ts` (41 tests: sign/verify round trip; expiry at exactly 12 h and a future `issuedAt`; tampered payload, tampered and swapped signature, another key, well-signed but wrong claims, malformed and over-long tokens; digest compare exact, length-safe and byte-exact; throttle threshold, lapse, per-source isolation, reset, global cap, pruning; configuration rules; every gate decision; source label, HTTPS detection, the browser-addressed origin and the same-origin rule), `packages/cli/src/runtime.test.ts` (the doctor line, three states), `tests/e2e/operator-login.spec.ts` on desktop Chromium and Pixel 7 (unauthenticated redirect carrying `next`; 401 JSON on the API and on a same-origin mutation without a cookie; health open; wrong password stays on `/login` with an error and no cookie; right password lands on the requested page and on `/`; cookie HttpOnly, Strict, non-Secure over HTTP, 12 h; signed-in `/login` goes home; logout ends the session; five failures lock the source and the right password is then refused; a cross-site or headless form POST is 403; no horizontal scroll at phone width), and the three existing specs behind the login.

**Supersedes / superseded by:** none; closes threat model residual risk 4 (T15) as recorded there.

## ADR-028 — A projected ceiling crossing routes planner/critic local instead of pausing

**Status:** accepted (27/09/2026)
**Context:** Policy B3 says that on hitting the cloud ceiling the system switches to local models only, and ADR-022 placed that switch in `routeRole`: at the ceiling the planner and the critic go to tier 2, the builder and the reviewer are refused as a policy stop. The routing decision, though, looked only at _recorded_ spend (`spent >= dailyUsd`), while the dispatch guard behind it (`Guards.beforeCloudCall`, PR #15) checks every cloud call with a per-role estimate (`ROLE_ESTIMATES_USD`: planner $0.70, critic $0.25, builder $1.25, reviewer $0.40) and refuses when `spent + estimate > dailyUsd`. Between the two rules lies a band one estimate wide in which the router says cloud and the guard says no. Live run `00a3c994` on 27/09/2026 (ceiling set to $0.02, day at $0) showed it: `routing.decided` planner tier 3 "architecture routes to cloud by default", then the guard: "estimated $0.70 would take today's total to $0.70, past the $0.02 ceiling", `spend.ceiling` with routing `local-only`, `run.pause`, `run.paused_by_guard` - the run paused at the planner, a stage the policy says may run locally. With the default $20 ceiling the same happens from $19.30 on, and the local path was reached only once recorded usage had already crossed the ceiling, which takes an estimate that turned out low. Dan, 27/09/2026: a projected crossing is to be treated exactly as a reached ceiling; the guard stays as the last line; a run still may not start on a day already at the ceiling; and when the local model is unavailable at the ceiling the run stops rather than spends (Q26).

**Decision:**

- One estimate table. `ROLE_ESTIMATES_USD`, `DEFAULT_ROLE_ESTIMATE_USD` and `roleEstimateUsd(role)` live in `packages/guardrails/src/spend.ts`; `apps/coordinator/src/guards.ts` imports them and re-exports the two constants. The router projects with the figure the guard checks against, so the two cannot disagree on a call.
- `route()` takes an optional `estimatedUsd`. With `usage` present it evaluates `canStartCloudCall` - the same function behind the guard - so tier 3 drops to tier 2 both when the day has reached the ceiling and when `spent + estimatedUsd > dailyUsd`; exactly the ceiling is allowed, as the guard allows it. Without `usage` nothing is projected, so a pipeline without `usageSource` still routes to the cloud as before. `routeRole` defaults `estimatedUsd` from the table by role, accepts an override, clamps a negative to zero, and records the figure on the decision (`estimatedUsd`), which `routing.decided` now carries.
- The reason names the projection and is worded apart from the guard's refusal so a log reader can tell the two apart: `would route to cloud, but projected $20.20 ($19.50 spent on 2026-09-27 Australia/Sydney + $0.70 estimated) would pass the $20.00 ceiling; routing to local models only`, followed by `; planner runs locally on devstral-small-2:latest` for a local stage. `ceilingApplied` is true for a projected decision as for a reached one.
- Which roles, unchanged from ADR-022: the planner and the critic go to tier 2; the builder and the reviewer are refused, and the pipeline ends the run `partially_completed` with a `safety_constraint` blocker. That is a policy stop, not a pause, and the refusal now says so: `builder must not run locally; stopping the run at the ceiling (...)` replaces "pausing for the ceiling", which described what the guard used to do. Q26 stands: a local-capable role with no `ollama` adapter online is refused the same way (`planner may run locally but no ollama provider is available; stopping the run at the ceiling (...)`), with the projection named; the run stops and nothing is spent.
- The dispatch guard is unchanged and remains the last line: a cloud call that still arrives when it would cross the ceiling pauses the run as before. With routing projecting first it no longer fires in this scenario; it can fire only for a call routing did not see (none in the pipeline today) or when the day moved between the decision and the dispatch.
- The start gate is unchanged: `POST /api/runs/:id/start` refuses with `409 spend_ceiling` only when the day is already at or over the ceiling. Below it a run is admitted even when its first stage is projected to cross; that stage is then routed local (planner, critic) or refused as a policy stop (builder, reviewer), never paused.

**Consequences:**

- Per role, not per run. At $19.50 the planner ($0.70) is projected past $20 and goes local while the critic ($0.25, to $19.75) still fits and goes to the cloud; if that call then records more than estimated the day crosses, `spend.ceiling` is announced once and every later stage sees a reached ceiling. The recorded usage, not the estimate, is still what goes into the day total.
- A run started just under the ceiling now completes its planner and critic stages at $0 and stops at the builder, where before it paused at the planner having done nothing; a resume picks up at the builder with plan and critique in hand.
- `RoleRouteDecision` gains a required `estimatedUsd`; `routing.decided` gains the field; `RouteRequest` and `RoleRouteRequest` gain the optional input. `apps/coordinator/src/guards.ts` re-exports the table, so nothing importing it from there changes.
- The two refusal reasons changed wording; the tests and documents in this repository that matched "pausing for the ceiling" were updated, and nothing outside it did.
- Residency (`listLoadedModels`) is still not wired into the coordinator; a local decision is annotated as a cold load, as before.

**Evidence:** `packages/guardrails/src/guardrails.test.ts` (`route`: a projected crossing demotes, exactly the ceiling does not, no usage means no projection; `routeRole`: planner local at $19.50 with the projected reason, critic on the cloud at $19.50 and local at $19.80, builder and reviewer refused on a projection, no `ollama` online refused with the projection named, the estimate on every decision), `packages/workflows/src/pipeline-routing.test.ts` ($19.80: planner and critic on `ollama`, builder stops the run, no cloud request and $0 recorded; $19.50 with a live day total: planner local, critic on the cloud, its recorded spend reaches the ceiling and the revision is local for that reason; $18.75: every stage on the cloud with the builder exactly at the ceiling; $19.50 without `ollama`: the run stops at the planner with no provider called), `apps/coordinator/src/server.test.ts` (the live coordinator with its real guards: planner and critic on the cloud to $19.70, the revision routed local by projection, builder refused, no `run.paused_by_guard` and no `spend.ceiling`; then a second run admitted at $19.70, planner local by projection, critic on the cloud crossing to $25, `spend.ceiling` once, revision local as reached, builder refused, restart `409 spend_ceiling`), `apps/coordinator/src/guards.test.ts` (the guard reads the shared table).

**Supersedes / superseded by:** amends ADR-022 (the ceiling trigger and the refusal wording); nothing superseded.

## ADR-029 — A resumed run waits for a worker instead of failing on a cold coordinator start

**Status:** accepted (27/09/2026)
**Context:** The coordinator and the worker run as separate Windows scheduled tasks, so they come up independently. The S5.3 restart test on 27/09/2026 started a run on a real project, let the planner's provider job be leased, then killed the coordinator mid-run to prove recovery. Recovery itself was correct. Run `485111dd-6fe6-4496-9d7f-5fe588394a0b`:

```
1107 worker_job.leased            {jobId 8dcbb856, workerId nodee-worker-1}
--- coordinator killed here, then restarted ---
1109 worker_job.lease_reconciled  {jobId 8dcbb856, state: "queued"}
1111 attempt.lease_expired        {taskId ..., attemptId ..., recoveredTo: "ready"}
1113 workspace.ready              {branch forge/485111dd, workspace ...}
1115 provider.diagnostic          {provider: claude, available: false, detail: "No online worker advertises provider:claude"}
1117 provider.diagnostic          {provider: codex,  available: false, ...}
1119 provider.diagnostic          {provider: ollama, available: false, ...}
1121 run.failed                   {message: "No authenticated provider is available"}
1123 worker_job.leased            {jobId 8dcbb856, workerId nodee-worker-1}   <-- one event too late
1125 worker_job.completed
```

Lease reconciliation, attempt recovery and the re-established workspace all worked; the worker re-registered and re-leased the job one event after the run had already been failed. The cause is the eager availability check in `AutonomousPipeline.execute`: it read `ProviderAdapter.diagnose()` once, and the coordinator's `WorkerProviderAdapter.diagnose()` answers "No online worker advertises provider:X" whenever no worker is online — which a freshly started coordinator, by definition, has for the first moments of its life. Nothing was spent (0 usage records) and nothing was corrupted, but every coordinator restart and every machine reboot killed every in-flight run, which makes unattended operation impossible.

**Decision:**

- Availability resolution becomes a bounded wait, `resolveAvailableProviders` in `packages/workflows/src/index.ts`. The first reading is announced as `provider.diagnostic` exactly as before; if nothing is usable the resolution polls, and the reading that ends the wait is announced too. Intermediate polls are silent — 90 s at one second a poll would otherwise be 270 events.
- The two cases are treated differently, and the pipeline is told which it is in rather than guessing. `AutonomousPipelineInput.providerWait` carries `totalMs`, `intervalMs` and `fleetEmpty()`; `fleetEmpty` is the coordinator's `isFleetEmpty()`, true only while **no** worker is online at all, and it is re-read at every poll.
  - **No worker online** (the cold start): wait, up to `FORGE_PROVIDER_WAIT_MS` (default 90000, poll `PROVIDER_WAIT_POLL_MS` = 1000). A worker registering ends the wait immediately.
  - **A worker online that does not advertise the provider** (Codex not logged in): no wait at all. The live worker's answer is informative, so `Error('No authenticated provider is available')` is thrown at once, unchanged. This also holds when a worker appears mid-wait and still advertises nothing.
- An expired wait pauses the run; it does not fail it. `resolveAvailableProviders` throws the exported `ProviderWaitExpired` (`classification: 'safety_constraint'`, `waitedMs`, the final `diagnostics`), and the coordinator's execution `catch` branches on it before the failure path and calls `pauseRunForProviderWait`. That reuses the existing pause: `controlRun(run, 'pause')`, then `run.paused_by_guard` with `guard: 'provider'`, the reason, `waitedMs`, `classification: 'safety_constraint'` and a `resumeHint` of "start the worker (pnpm forge runtime start), confirm it appears in GET /api/workers, then resume the run". `persistStructuredEvidence` turns that into an active `safety_constraint` blocker and `escalation.ts` already classifies the event generically, so the dashboard, the digest and the phone need no change.
- Who waits, and for how long, is decided in `providerWaitBudgetMs(resuming)` at `POST /api/runs/:id/start`. A worker online means 0. Otherwise the full budget when the run is being resumed (`run.state !== 'created'`, or a restored checkpoint exists — a run's first start is the only one that comes from `created`, so a resume, a retry and the `executing` row a killed coordinator left behind all qualify) or when a worker row exists in the store, and 0 when neither holds. A first start on a machine where no worker has ever registered therefore still surfaces the misconfiguration immediately instead of 90 seconds later, while a first start after a reboot — where the worker row is in PostgreSQL and the worker task is still coming up — gets the wait, because that is the same transient condition.
- `POST /api/runs/:id/start` is the only path into the pipeline: `restartRunWhenIdle` (behind `control` `resume` and `retry`) injects into it, and coordinator startup hydration reconciles leases and expired attempts without starting anything. One decision point therefore covers every restart path. The other place a run could die waiting for a worker, `waitForWorkerJob`, already waits `FORGE_WORKER_JOB_WAIT_MS` (900000, halt-aware), so the two are now consistent: the coordinator waits for a worker rather than failing the moment it cannot see one.

**Consequences:**

- A coordinator restart or a reboot no longer kills in-flight runs. The worst case with no worker at all is a paused run after 90 s, resumable with `POST /api/runs/:id/control {"action":"resume"}` once the worker is back.
- A resumed run can now sit `executing` for up to `FORGE_PROVIDER_WAIT_MS` doing nothing visible except `provider.wait_started`. That event, and `provider.wait_satisfied` or the `run.paused_by_guard` that closes it, are what an operator reads to tell a wait from a hang.
- `run.paused_by_guard` now has two producers. `guard: 'spend'` and `guard: 'provider'` are what tell them apart; anything matching on the event type alone sees both.
- `FORGE_PROVIDER_WAIT_MS=0` restores the old behaviour exactly, for a deployment that would rather fail fast.
- `AutonomousPipelineInput` gains an optional `providerWait`; a pipeline constructed without it resolves availability once, so no other caller changes.

**Evidence:** `packages/workflows/src/pipeline-provider-wait.test.ts` (the wait polls and the run reaches the push gate once a worker advertises `claude`, with both the cold-start and the satisfying `provider.diagnostic` in the trace; a worker online that does not advertise `codex` fails at once against a 600 s budget and is probed exactly once; a 300 ms budget with the fleet permanently empty ends in `ProviderWaitExpired` with `classification: 'safety_constraint'` and the diagnostics attached, neither hanging nor failing; no `providerWait` resolves once as before). `apps/coordinator/src/server.resume.test.ts` — its own vitest file, because "no worker is online" is only reachable in a process where no other test has registered one: an interrupted run resumed with an empty fleet is paused, not failed, with `guard: 'provider'`, `waitedMs >= 6000`, no `run.failed`, and an active `safety_constraint` blocker naming the worker; and a second resumed run waits, has a worker register mid-wait, emits `provider.wait_satisfied` and has its planner job leased with `providerId: 'claude'`, still `executing` and never paused. Counterfactual, 27/09/2026: with `providerWaitBudgetMs` forced to 0 (one line, reverted) both coordinator tests fail and reproduce the measured trace exactly — `workspace.ready, provider.diagnostic, provider.diagnostic, provider.diagnostic, run.failed`.

**Supersedes / superseded by:** amends ADR-011 (restart recovery) by extending it from leases and attempts to provider availability; nothing superseded.

## ADR-030 — The Codex CLI does not sandbox itself inside TheForge's sandbox

**Status:** accepted (27/09/2026)
**Context:** The cross-provider run `e3de1306-ada4-4a8d-85ea-2d2becc034a7` (26/09/2026, `docs/evidence-cross-provider-2026-09-26.txt`) put a Codex critic in front of a Claude planner for the first time. Codex opened its critique with its own diagnosis:

```
The workspace shell is unavailable because its sandbox cannot create a user namespace.
I'll still audit the plan itself, but repository-specific 'verified' claims remain
independently unverified in this run.
```

The Codex CLI sandboxes its own tool use with landlock, seccomp and a user namespace. Every provider job already runs in TheForge's per-job container — non-root, read-only root filesystem, all capabilities dropped, no `CAP_SYS_ADMIN`, workspace-only mount (ADR-012) — so Codex's nested sandbox cannot initialise and the CLI loses its shell entirely. The measured consequence is not cosmetic: blind to the repository, the critic raised a finding that `npm run check` was unsupported, which the Claude planner then refuted by reading `package.json`. A critic that cannot read the diff it is reviewing is materially weaker than one that can, and a Codex *builder*, whose whole job is editing files, would be unusable. Recorded as BLK-016.

**Decision:**

- The Codex adapter passes `--dangerously-bypass-approvals-and-sandbox` (verified against `codex exec --help` for the installed `@openai/codex` 0.144.6, whose own text reads "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed"). TheForge's container *is* that external sandbox, so this is the configuration the flag exists for rather than a loosening of the boundary.
- It is passed **only** when the environment the CLI will run in carries the marker `FORGE_EXTERNALLY_SANDBOXED=1` (`EXTERNAL_SANDBOX_MARKER` and `isExternallySandboxed` in `packages/provider-codex/src/index.ts`). Exactly that value counts; absent, empty, `0`, `true` or anything else means "not sandboxed" and the adapter keeps Codex's own sandbox, unchanged from before. A configuration mistake therefore cannot silently turn the bypass on, and the flag can never reach a Codex process running on the host.
- The marker is set by the code that launches the container and nowhere else: `sandboxProviderEnvironment()` in `apps/worker/src/index.ts` is the single source for both the container's `--env` arguments (`createProviderDockerRunArgs`) and the environment handed to the adapter that assembles arguments for that container (`createDockerProviderAdapter`). The adapter is explicitly told; it never infers containment from `/proc`, a hostname or a mount table, and it defaults to `process.env`, where the marker is absent.
- Exactly one of the two is ever in the argument list: `--dangerously-bypass-approvals-and-sandbox` inside the container, `--sandbox workspace-write` everywhere else. Measured, 0.144.6 accepts both together rather than rejecting the pair, so this is a legibility rule rather than a constraint the CLI enforces: the bypass supersedes the sandbox mode, and an argument list carrying both would not say which policy is in force.
- Rejected alternatives. `-s danger-full-access` reaches the same sandbox state but says nothing about approvals, leaving the intent split across two flags that must stay consistent; it is also not the option the CLI documents for an externally sandboxed host, so a reader cannot tell "no sandbox because something else contains us" from "no sandbox because someone wanted more access". `-c sandbox_mode=danger-full-access` is the same setting through a config override — less discoverable, subject to the CLI's config parsing, and invisible in `--help`. The named flag states the reason in its own name, which is what makes the argument list auditable.
- The Claude adapter needs no equivalent and is unchanged. The Claude CLI nests no sandbox of its own; it gates tool use by permission mode, which ADR-016 already sets per role (`acceptEdits` for the builder, `dontAsk` for every read-only role) and which the container boundary contains. It showed no shell loss in the same run.

**Consequences:**

- Inside the container Codex has a working shell, so a Codex critic can read the diff and a Codex builder becomes possible. The bypass removes Codex's *inner* sandbox only; the outer one — non-root, read-only root, dropped capabilities, no-new-privileges, 2 GB / 2 CPU / 256 pids, bridge egress for provider APIs, `/workspace` as the only host mount — is untouched and remains the actual boundary.
- The safety of the configuration now rests on the marker being set only where the container is real. That is why it is set in one function next to the `docker run` arguments, asserted by a test, and why the adapter refuses every value but `1`.
- Running the Codex CLI on the host through this adapter (the test-only host executor, or a direct construction) keeps Codex's own sandbox, because the marker is not there.

**Evidence:** `packages/provider-codex/src/adapter.test.ts` "Codex external sandbox marker" — the bypass present and `--sandbox` absent with the marker set, `--sandbox workspace-write` present and the bypass absent with it unset, and neither the flag nor a `true` verdict for eight unexpected marker values. `apps/worker/src/index.test.ts` "marks every provider container as externally sandboxed" (both provider containers get `FORGE_EXTERNALLY_SANDBOXED=1` and nothing else beyond `HOME`, and the host process does not have it) and, flag-gated on `FORGE_CODEX_SMOKE=1`, "reads a workspace file through its shell inside the container", which runs the real CLI in the real image against a prompt only a working shell can answer.

Measured first-hand inside the real image on 27/09/2026, with no credential and no network, which is what ties the flag to the symptom:

```
# codex's own sandbox, inside TheForge's container
$ docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges=true \
    --tmpfs /tmp --tmpfs /home/node --env HOME=/home/node \
    --entrypoint codex theforge-worker-sandbox:local sandbox -- /bin/echo forge-shell-proof
bwrap: No permissions to create a new namespace, likely because the kernel does not allow
non-privileged user namespaces.

# the same command with Codex's sandbox out of the way, which is what the bypass leaves
$ docker run ... --entrypoint /bin/echo theforge-worker-sandbox:local forge-shell-proof
forge-shell-proof
```

The chosen arguments were also confirmed to parse in that image (`--ask-for-approval never exec --json --color never --dangerously-bypass-approvals-and-sandbox -`: the CLI got as far as "No prompt provided via stdin"), and so is the pair `--sandbox workspace-write` plus the bypass, which is why passing only one is this repository's rule and not the CLI's.

**Supersedes / superseded by:** amends ADR-012 (the mandatory Docker boundary) by naming the container as the external sandbox a provider CLI may rely on instead of nesting its own; nothing superseded.

## ADR-031 — Watching the tailnet for nodes coming back

**Status:** accepted (27/09/2026)
**Context:** Dan's tailnet has nodes that are meant to be quiet. `noded` (linux, `tag:orchestrator-node`, Tailscale SSH on, `100.64.0.10`) was last seen on 21/06/2026 — 98 days before today — and `nodec` is meant to stay off until a later stage. Nothing watched any of it: a node waking up, or a new node joining, would have gone unnoticed indefinitely. Dan asked on 27/09/2026 to be told if `noded` ever comes back online, on the grounds that an unexpected node waking up is exactly the kind of thing he wants to hear about; the same mechanism covers `nodec` and notices a Pi that has dropped off. `tailscale status --json` already carries everything needed — per node the `DNSName` (whose first label is the tailnet short name), `Online`, `OS`, `Tags`, `TailscaleIPs`, `LastSeen` and `sshHostKeys` (present only when the node advertises Tailscale SSH) — for `Self` as well as every entry of `Peer`, and it is a local call against `tailscaled`, not a cloud API. Two facts shaped the design: `LastSeen` is the zero time `0001-01-01T00:00:00Z` rather than absent for a node tailscale has no reading for (every online node on this tailnet, including `Self`), which must not be read as "offline since the year one"; and `tailscale` is frequently not on a scheduled task's PATH, the same problem `Wait-ForgeDocker` already solves for docker by falling back to the installed path.

**Decision:**

- `pnpm forge node-watch` (`packages/cli/src/commands/node-watch.ts`) reads `tailscale status --json` once per run, compares each node with `<outbox>/node-watch/state.json`, and escalates transitions. It is a sibling of `ci-watch` (ADR-026) by design: same flag handling, same state-file conventions, same `CommandRunner` seam, same `--dry-run`/`--json`, same exit codes (0 normal, 1 the tailscale call or a channel failed, 2 a bad flag).
- **Severity is chosen by direction, not by magnitude.** Offline → online is **warn**, which under ADR-023 reaches the phone as well as email and the outbox. That is the direction Dan asked about and the surprising one: a machine he believes is off answering on the tailnet is either his own doing, in which case a push he can dismiss costs him a second, or it is not, in which case he wants to know now and not at the next digest. A node the state file has never held is **warn** for the same reason — an unknown machine on the tailnet can reach whatever the ACLs allow, and that is worth a look while it is still happening. Online → offline is **info**: email and the file outbox, never the phone. A machine that is normally up dropping off is worth a record and worth noticing in the digest, but it is the ordinary direction — a reboot, a power cut, a lid closing — and waking Dan for it would teach him to ignore the channel that carries the case he actually asked for. So the escalation that can wake him is only ever "something came back or something new arrived".
- **Which nodes are watched defaults to all of them.** `FORGE_WATCH_NODES` is a comma-separated list of short names and `--node=<name>` (repeatable, and comma-separated) overrides it. With neither set, every node the status lists is watched, rather than nothing: a node appearing that Dan does not know about is one of the two things this exists to catch, and a watch list cannot name a node nobody knew was coming. Narrowing is one environment variable away and is documented next to the command.
- **The first run seeds and says nothing.** Because "not in the state file" is a warn, the very first run would otherwise escalate once per existing node. A missing state file — and a malformed one, which is reported as a warning and treated the same way — records every node silently and prints `first run: N node(s) recorded, nothing escalated`. Every node the status lists is recorded whether it is watched or not, so widening the watch set later does not announce nodes that were already there.
- **What the message carries** is what is useful on a phone: the node's short name, its OS, whether Tailscale SSH is enabled on it, its tags, how long it had been offline (from the `LastSeen` recorded at the previous observation, rendered as "98 days"), and its tailnet IP. Kinds are `node.back_online`, `node.went_offline` and `node.appeared`; dedupe keys are `node-watch:online:<name>@<last seen before the return>`, `node-watch:offline:<name>@<last seen>` and `node-watch:new:<name>`, all derived from observed data rather than the run clock, so a rebuilt state file cannot turn one event into two messages inside the notifier's six-hour window. Two returns in the same run coalesce the way any two escalations of one kind do (five-minute window): the first is sent and the second arrives in the summary, both named.
- **State** is `<outbox>/node-watch/state.json`, versioned, one marker per node (online, the observation time, OS, SSH, tags, IP and `LastSeen`). A node the status no longer lists keeps its marker with a `missingSince` stamp and is dropped after 30 days; it is not escalated, because removing a node from a tailnet is a deliberate act. `--dry-run` writes neither the state file nor the outbox.
- **Finding the binary** mirrors `Wait-ForgeDocker` (`scripts/runtime/runtime-common.ps1`): the bare name first, then `C:\Program Files\Tailscale\tailscale.exe` (and `/usr/bin/tailscale`) if it exists. A non-zero exit that is not "no such program" — tailscaled not running, not logged in — is an error and is reported as one, never retried against another path, so a stopped daemon is never mistaken for a missing install.
- It runs on a schedule an operator registers and the code never does: `scripts/register-node-watch.ps1` registers "TheForge Node Watch" under `\TheForge\` every 15 minutes (`-IntervalMinutes` to change it), running `scripts/run-node-watch.ps1`, with the same principal options as the digests and the CI watch (`-RunWhenLoggedOff` → S4U). Fifteen minutes because the whole check is one local call, so news of a return is a quarter hour old at worst.

**Consequences:**

- A node coming back reaches Dan's phone within about fifteen minutes, once, naming the node, how long it was away, and enough about it to decide whether to go and look. `noded` and `nodec` are covered without being named anywhere in the code.
- The default of watching everything means the first unexpected node to join the tailnet is a warn rather than silence. The cost is that adding a node Dan does expect also produces one warn, which is the trade he asked for; `FORGE_WATCH_NODES` narrows it for anyone who would rather not have that.
- Nothing here handles a secret. The status document contains public node keys and tailnet IPs; no token is read, and the tailnet is reached through the CLI's own local connection rather than the Tailscale API.
- A node that flaps produces one info per departure and one warn per return. The notifier's six-hour dedupe covers a flap inside that window for the same offline stretch, and the coalescing window folds a burst of one kind into a summary; a genuinely unstable node would still be noisy, which is information rather than a fault.
- The watch reads nothing but tailscale, so it works while the coordinator is down and is unaffected by the halt file. It is also the first check in the system whose subject is the machines rather than the work.

**Evidence:** `packages/cli/src/node-watch.test.ts` (23 tests: the real `tailscale status --json` shape parsed down to short name, OS, online, tags, SSH and IP for `Self` and peers; the zero `LastSeen` ignored; host-name fallback; non-JSON and non-object output refused; age rendering; a missing binary told apart from a program that said no; the watch-set precedence; all three escalation shapes with their severities and keys; state file missing, malformed and pruned; and end to end against a fake tailscale — first run seeds silently and escalates nothing, a return is a warn, a departure is an info, an unknown node is a warn, no transition says nothing, a repeat run is quiet, `FORGE_WATCH_NODES` narrows while still recording every node, `--node` overrides it and repeats, a watched name absent from the tailnet is reported not escalated, a malformed state file reseeds silently and compares again next run, a non-zero tailscale exit is an error with exit 1 and no writes, the installed-path fallback, `--dry-run` writing nothing, `--json`, and a departed node remembered rather than reported). Run read-only against the real tailnet on 27/09/2026: `pnpm forge node-watch --dry-run` read 10 nodes through `tailscale` on PATH and seeded nothing, and with a hand-written state file the same dry run reported `nodeb: BACK ONLINE after 7 days`, `backupnode: NEW node (online)` and `noded: went offline` without sending or writing anything. `scripts/run-node-watch.ps1 -DryRun` and `scripts/register-node-watch.ps1 -WhatIf` were both exercised; nothing is registered.

**Supersedes / superseded by:** applies the ADR-023 severity routing to a new source and follows the ADR-026 shape for a scheduled check; extends the B11 escalation table with `node.back_online`, `node.went_offline` and `node.appeared`. Nothing superseded.

## ADR-032 - CI pays only for signal that is not already in hand

**Date:** 2026-09-28 (decided 27/09/2026 evening)
**Status:** accepted
**Supersedes, in part:** ADR-015, which put a hosted macOS job on the routine path.

### Context

On 27/09/2026 at 11:20 UTC the post-merge run for `main` (`dc9f2c0`, PR #28) failed with all
four jobs dead in two to five seconds, **zero steps executed**, no annotations and no output.
The same four checks had passed on the pull request head `c6a09d8` minutes earlier, and
`c6a09d8^{tree}` equals `dc9f2c0^{tree}` - byte-identical trees - so nothing was wrong with
the code. Jobs created and then killed before any step runs is a runner never being
allocated, which on a private repository means the account's included Actions minutes.

The multipliers are the whole story, and they are invisible if you read wall-clock time.
macOS bills at **10x** and Windows at **2x**. Measured across the last 8 successful runs:

| Job | wall | multiplier | billed |
| --- | ---: | ---: | ---: |
| `quality` (ubuntu) | 51 min | 1x | 51 min |
| `portable (windows-latest)` | 41 min | 2x | 82 min |
| `portable (macos-latest)` | 7 min | 10x | **70 min** |
| `browser` (ubuntu) | 16 min | 1x | 16 min |
| | **128 min** | | **~256 min** |

The macOS leg was the second most expensive job in the matrix while being the fastest by
wall-clock, and it covers a platform that exists nowhere in the estate - P107 (macOS worker
runtime support) is `deferred` precisely because there is no macOS hardware to run it on.

Confirming the quota directly needs the billing page or a token with the `user` scope, which
was not added: a scope on the operator's credential is his to grant. The diagnosis therefore
rests on the signature plus the arithmetic, which is stated here as inference rather than as
a reading of the billing page.

### Decision

Two rules, both the same principle - do not pay for a signal already in hand.

1. **macOS runs on `workflow_dispatch` only.** The job is kept in full, as `portable-macos`,
   and is one button on the Actions tab. Run it before a release, or when a change touches
   path handling, process spawning, or the worker daemon lifecycle.
2. **A push to `main` runs `quality` only.** `portable` and `browser` carry
   `if: github.event_name != 'push'`. When a pull request merges into an unmoved `main` the
   merge commit's tree is identical to the head just tested, so the second full matrix buys
   nothing. `quality` is kept for direct pushes.

Estimated effect: roughly 54 billed minutes per merged pull request becomes roughly 25.

### Consequences

- **macOS regressions will not be caught automatically.** This is accepted, not overlooked.
  Nothing in the estate runs macOS, P107 is deferred, and the cover is one click away when it
  matters. If macOS ever becomes a supported target, this decision is the first to revisit.
- **A direct push to `main` gets `quality` but not the portability or browser legs.** That is
  a real, if narrow, hole. It exists because there is **no branch protection on this
  repository** - it is a GitHub Pro feature and the repository was private on the free plan at the time -
  so direct pushes cannot be prevented, only cheaply checked.
- **The merge gate is discipline, not enforcement.** Since GitHub requires no status checks
  here, BLK-013's rule of waiting for a completed, all-green rollup is upheld only by whoever
  is merging. Removing a job from the workflow cannot block a merge and must not be relied on
  to. This was already true; measuring it for this decision is what made it explicit.
- **`portable (windows-latest)` keeps its check name**, so nothing that refers to it by name
  breaks.
- A separate `portable-macos` job was chosen over a conditional matrix expression on purpose.
  An expression that silently evaluates to the wrong list would be indistinguishable from a
  runner that never started - which is the exact failure this ADR responds to.

### Verification, and its limits

**This change could not be verified by CI, because CI is what is broken.** What was done
instead: the workflow was parsed with a YAML loader and the resolved triggers, `runs-on`
values, matrix and `if:` expression of every job printed and checked by eye; and the full
local gate was run - the database-backed suite, lint, typecheck and format (three
consecutive green full runs: 562 passed, 2 skipped).

**The gating was then verified live, on PR #29's own run (36325365967).** GitHub parsed the
workflow, evaluated both `if:` expressions and built the job set correctly:

| Job | result | steps | seconds |
| --- | --- | ---: | ---: |
| `quality` | failure | 0 | 2 |
| `portable (windows-latest)` | failure | 0 | 2 |
| `browser` | failure | 0 | 2 |
| `portable-macos` | **skipped** | 0 | 0 |

So rule 1 works and costs nothing when it does not apply, and the three failures carry the
unchanged BLK-023 signature - zero steps, two seconds - which also rules out this change
having broken the workflow. What is still unverified is rule 2's push branch: that `portable`
and `browser` skip on a push to `main` is first exercised by the merge of this pull request
itself. Whoever merges is accepting that one remaining gap, not the whole change.

## ADR-033 - the digest watches the watchers

**Date:** 2026-10-04
**Status:** accepted

### Context

Over 01-04/10/2026 three monitoring failures went unnoticed until a human asked for a
status check:

- `TheForge Node Watch` recorded `LastTaskResult 0x1` on **every run for days** (BLK-025).
  The tailnet monitor was dead at exactly the moment three nodes joined.
- `TheForge Digest Morning` failed through the Docker outage and said nothing.
- The hourly backup logged restic's failure and **exited 0**, reporting success for an hour.

Everything this system monitors - runs, spend, CI, tailnet nodes - is watched by
something. **Nothing watched the watchers.** A scheduled task's `LastTaskResult` was
visible to anyone who ran `pnpm forge runtime status`, and nobody runs that on a good day.

### Decision

The digest reports scheduled tasks that want attention, and escalates one to the phone
only after it has failed twice running.

**Three judgements, kept separate on purpose:**

1. **Is a result code a failure?** `HEALTHY_TASK_RESULTS` / `isTaskResultHealthy` in
   `runtime.ts`. The set is explicit rather than derived from `describeTaskResult`'s
   wording, because a decision must not depend on prose someone may reword.
2. **Does a task want attention?** `taskNeedsAttention` - broader: a task that is absent
   or disabled has not *failed*, but it is not doing its job either.
3. **Is it worth a phone push?** Only when it wanted attention at the previous
   observation too (`repeatedFailures`), and then at most once per local day
   (`dueForEscalation`).

**The watchdog codes are the crux.** Once BLK-017's trigger is registered it re-fires
every minute and `MultipleInstances IgnoreNew` refuses the repeat, so a **healthy**
coordinator, worker or web task sits on `0x800710E0` or `0x8004131F` permanently. Anything
treating those as failures would raise an alarm in every digest forever - worse than
raising none, because it teaches the operator to ignore the channel.

**Why a repeated failure rather than the first.** The digests run 05:00 and 17:30, so this
is roughly a twelve-hour confirmation - slower than it could be, deliberately. A single
non-zero exit is ordinary. An alarm that fires on one would be ignored inside a week, and
then the next real BLK-025 passes unseen again.

**Why the digest and not a new scheduled job.** A new watcher would need watching. The
digest already runs twice a day, already reaches email and the outbox, and already fails
loudly if it cannot send.

### Consequences

- A healthy machine's digest is **byte-identical** to before: the section and its compact
  line appear only when something is wrong. This is asserted in a test.
- `FORGE_WATCH_TASKS` extends the list (a leading `+` adds to the defaults). The defaults
  are TheForge's own seven tasks; other projects' tasks are added from `.env` rather than
  hardcoded here. On NODEE that means `+Backup task,Offsite task`.
- A first run seeds silently, so installing this cannot produce a burst about history.
- **A fix to `taskStatusScript` came out of this.** It looked a task up by name twice, and
  `Get-ScheduledTaskInfo -TaskName` resolves only the **root** folder: for a task under
  `-TaskPath '\TheForge\'` it fails with "The system cannot find the file specified", and
  with `$ErrorActionPreference = 'Stop'` that killed the whole script. The task object is
  now piped in, carrying its path. So `runtime status` could not read the node watch, the
  CI watch or either digest task before today - the four tasks most worth reading.
- The state file is a new artefact under `<outbox>/task-health/state.json`, mirroring the
  node watch's. Losing it costs one quiet digest, not a wrong one.
- `task.failing` is a new escalation kind at `warn`, so ADR-023 routing sends it to the
  phone, email and the outbox.

## ADR-034 - the ledger records the truth; the limits keep their calibration

**Date:** 2026-10-04
**Status:** accepted

### Context

The 04/10/2026 cost review (S14.6) set out to answer which pipeline role the money goes
to, and could not. Two separate gaps, found while reading the ledger rather than the code.

**No role was stored.** `usage_records` had no `role` column, so every query could group
spend by provider and by nothing else. The pipeline had been emitting the role all along -
`usage.recorded` carries `role: 'planner' | 'critic' | 'builder' | 'reviewer'` from
`accountUsage` in `packages/workflows/src/index.ts`, and all 31 stored events had it - but
the coordinator's event handler read the payload and dropped the field, because there was
nowhere to put it. That made `ROLE_ESTIMATES_USD`, the per-role table the dispatch guard
consults to decide cloud against local, **unfalsifiable**: no measured per-role cost
existed to check the guesses against.

**Claude's input tokens were not credible.** The ledger held 4, 4, 4, 28, 8 and 11 input
tokens for calls that produced 2,000-16,000 output tokens and cost up to $1.27. Codex, over
the same window, reported 27,490. The two CLIs disagree about what `input_tokens` means:

- **Claude's excludes the cache.** The volume sits in `cache_creation_input_tokens` and
  `cache_read_input_tokens`. Claude Code caches by default, so what we recorded was the
  uncached residual - a rounding error on the real figure.
- **Codex's includes the cache**, with `cached_input_tokens` as a subset of it. Which is
  why that adapter's numbers looked sane and nobody questioned them.

### Decision

Both adapters are normalised onto one contract - **total input, of which cached** - and
the record carries the role. Migration 008 adds `role` and `cached_input_tokens`.

**Correcting the ledger must not change what a run is allowed to do.** This is the part
worth recording, because the obvious implementation is wrong. Every threshold in the
system counted `inputTokens + outputTokens`:

- the run budget, `maxTokens`, 100,000 by default (`accountUsage`, which throws
  `Run budget exceeded`);
- the per-task limit, `DEFAULT_TASK_LIMITS.maxTokens`, 150,000 (`checkTaskLimits`);
- the daily ceiling's token figure (`toGuardUsage`).

All three were calibrated against the **understated** numbers. A corrected total of 31,004
where 4 used to be would have made runs that always finished start aborting roughly a
dozen stages early - a silent, confusing regression introduced by what was advertised as
an accounting fix. Raising the limits to compensate was rejected outright: that loosens a
spend guard, and loosening a spend guard is Dan's call, not a side-effect of a bug fix.

So the thresholds read **`freshTokens`** - total input less the cached portion, plus output
- which for Claude equals exactly what they counted before. Calibration is preserved, the
ledger holds the truth, and a cache read (a tenth the price of a fresh token) is no longer
charged at par. The consequence is a deliberate discrepancy: `runs.spent.tokens` is
smaller than the sum of `input_tokens + output_tokens` over the same run, and the
difference is precisely `cached_input_tokens`. It is documented on `freshTokens` itself,
because the next person to compare those two numbers will assume one of them is broken.

**A roleless record is grouped, not dropped.** `byRole` puts it under `unattributed`, so
the role totals always reconcile with the overall figure; a summary whose parts do not add
up to its whole is worse than no breakdown. The digest renders the by-role line only when
something is actually attributable, so a window of pre-008 records does not get a line
that merely restates the call count.

### Consequences

`role` needed no backfill. Events are the source of truth and the coordinator re-materialises
usage records on boot replay, so restarting it repopulated all 31 rows from the events that
had been carrying the field all along. Cached token counts genuinely cannot be recovered -
those figures were never read from the CLI - so historical rows stay at 0 rather than having
a plausible number invented for them. Only calls made from here on have a true input count.

**The backfill is reversible in principle, and that is worth knowing.** Replay repopulates
`role` from the events, but replay is only as good as the code running at the time: a
coordinator built from a commit *without* this change re-materialises the same events and
writes `role = null` straight back over them. So the attribution is durable only once this is
on `main` and `main` is what the runtime is built from. Nothing is lost either way - the
events always hold the role - but a query run against a half-reverted runtime reports every
call as `unattributed`, which looks exactly like the bug this change fixes.

**Corrected 04/10/2026.** This paragraph first claimed the reversal had been *observed* - that
a rebuild under the running task made the watchdog restart the coordinator and strip the
roles, and that a further restart restored them. **The coordinator did not restart on either
occasion.** The log records exactly two successful starts that day, 07:49 and 13:51, with
none in between; what sat on port 4400 throughout was the 07:49 process, and every start the
watchdog attempted in that window died on `EADDRINUSE` (BLK-026). The roles did change twice
in that window, and **no explanation for it has been established** - the coordinator is the
only writer of the column, and the test suite gives every file its own schema. It is recorded
as unexplained rather than attributed to a mechanism that the logs rule out.

**The estimates can now be checked, and three of the four are wrong.** Measured against
`provider='claude'` only, since the table is a cloud estimate:

| role | estimate | measured mean | worst case | calls |
| --- | --- | --- | --- | --- |
| planner | $0.70 | $0.328 | $0.480 | 8 |
| critic | $0.25 | $0.207 | $0.220 | 3 |
| builder | $1.25 | $0.821 | $1.270 | 6 |
| reviewer | $0.40 | $0.419 | $0.481 | 7 |

`reviewer` is accurate and `critic` close. `planner` is roughly double what a planner
actually costs. `builder`'s mean is well under its estimate, but its worst observed call is
$1.270 against a $1.25 estimate, so the figure reads as a ceiling rather than an average -
which, for a guard deciding whether a stage would breach the daily limit, is the useful
reading.

**The table is deliberately left alone.** Every error is in the conservative direction: an
over-estimate makes the dispatch guard route to the local model sooner than strictly
necessary, which spends less rather than more. Correcting them downward would send more work
to the cloud, and that is a spend decision requiring explicit approval (policy B2/B5), not a
tidy-up. Three to eight calls per role is also too thin to recalibrate against; the point of
this change is that the next review will have real data to argue from.

**Dan's decision, 04/10/2026: revisit at 50 metered calls and correct them then.**
`ROLE_ESTIMATE_REVIEW_CALLS = 50` in `packages/guardrails/src/spend.ts` is that threshold,
and it is counted across all roles rather than per role - 50 each would mean 200 metered
calls and roughly $90 of spend at the measured mean, a long way from the $11.11 recorded so
far, where 50 in total gives a dozen or so per role. Only metered calls count: a $0 local or
subscription call says nothing about what a stage costs on the cloud, which is the only thing
the table claims.

The threshold is **a trigger rather than a note**, because a decision deferred on a condition
nobody measures is a decision that quietly never happens - which is the failure mode this
whole day has been about. `countMeteredCallsByRole` counts it in SQL, for the same reason
`sumUsageSince` exists, and the digest says so once the threshold is met and stays silent
until then: a running "24 of 50" every twelve hours for weeks would be noise, and nothing
needs doing until the number is reached. At the time of writing it stands at 24 - planner 8,
reviewer 7, builder 6, critic 3.

**Evidence:** migration 008 applied to the live database 04/10/2026. The replay backfill is
demonstrated by the coordinator start at 13:51 - the first successful one since 07:49, once
the orphan holding port 4400 was cleared - which re-materialised all 31 usage records with
their roles. Shown by transaction age rather than by inference: with `txid_current()` at
243755, every one of the 31 rows carried an `xmin` between 243719 and 243734, one transaction
each, so they were written by that boot and not merely present during it. Per-role spend
queried above; the digest's new line rendered against that real data as
`by role: builder $4.93 / 6 calls; reviewer $2.94 / 7 calls; planner $2.62 / 12 calls;
critic $0.62 / 6 calls`, matching the SQL totals exactly, and correctly absent from a
`--window=now` digest with no spend in it. 617 tests pass, 8 new - the ones that matter being the Claude cache mapping, the
Codex asymmetry in the opposite direction, and `freshTokens` holding
`{input: 31004, cached: 31000, output: 2183}` equal to the `{input: 4, output: 2183}` the
limits used to see.

**Supersedes / superseded by:** neither. Builds on ADR-028 (projected ceiling routes local),
whose `ROLE_ESTIMATES_USD` inputs this makes measurable for the first time.

## ADR-035 - `fully_built` means every feature exercised end to end, and this is not that

**Date:** 2026-10-04
**Status:** accepted
**Supersedes:** the release label set by ADR-019 (that ADR's three conditions stand as recorded and are not in dispute).

### Context

Dan, 04/10/2026: *"version 1 `fully_built` is only true when all features are able to be used
to their full capacity e2e."*

ADR-019 named three conditions for promoting `release_candidate` to `fully_built`: a green CI
run on all four jobs after its merge, one live run with the critic or reviewer on Codex with
its subscription cost recorded, and one real escalation received. **All three genuinely hold,
each with its own evidence, and `docs/STATUS.md` records them correctly.** The label was not
claimed loosely; it was claimed against the definition in force.

The definition was the problem. Nothing in it required the pipeline to do real work, and the
ledger shows it largely has not. Measured, not estimated:

| | |
| --- | --- |
| runs ever started | 14 |
| runs that reached `completed` | **1** |
| `integration.pull_request_created` events, ever | **1** |
| `repair.*` events, ever | **0** |
| objectives that were not a toy on the acceptance fixture | **0** |

Every objective on record is of the form *"add an exported `clamp(value, min, max)` helper to
app.js"*, *"add an exported `truncate(text, maxLength)` helper"*, or *"add a one-line note to
README.md"*, all against `acceptance-fixture`. **And now the reason is known: BLK-027.**
`GITHUB_TOKEN` is a fine-grained token scoped to that one repository - PulseApp and shopfront return 404 to it - so the pipeline could not physically reach anything else. The
toy objectives were not neglect; they were the only work the credentials permitted, and that
constraint was never written down. The dearest was $4.49 and failed; the
one that completed cost $2.55 and added a `formatCount` helper.

`repairing` is a real run state with real transitions - `reviewing -> repairing`,
`verifying -> repairing`, `repairing -> reviewing | verifying | partially_completed` - and it
has **never executed**. A named stage of the pipeline has never once run.

The checklist knew this. S5's own gate reads *"the complete loop runs on real work and
survives a restart. Everything after this is extension rather than proof"*, and S5.2 - *"run
one objective: clear the open dependency PRs on shopfront"* - has been open the whole time. So the
release label asserted more than the project's own Phase 1 gate allowed.

`README.md` had meanwhile drifted the other way, still saying *"it is not yet `fully_built`"*
for reasons that are now stale (Claude quota, a fixture pull request, macOS evidence) while
`docs/STATUS.md` said it was. Two documents in the same repository disagreeing about the
release label is its own defect.

### Decision

**The label returns to `release_candidate`**, and `fully_built` now means what Dan said it
means. The `v1.0.0` tag stays where it is: a tag marks a commit and deleting it would rewrite
history to make a document look better, which is the opposite of the point.

Three conditions, written to be checkable rather than arguable - vague conditions are how a
label came to overclaim in the first place:

1. **A real objective on a real repository reaches `completed`** - not `partially_completed` -
   with a pull request the pipeline opened itself, and Dan's judgement that the work is
   genuinely good rather than merely green. That is S5.2, S5.4 and S5.6 together, and it is
   the condition that matters most, because it is the only one that tests the whole loop
   against work nobody scripted.
2. **The repair loop executes once and recovers.** A review or verification failure routed to
   `repairing` and coming back out, with the events to show it. A stage that has never run is
   not a built feature.
3. **`portable-macos` green on the release commit.** ADR-032 took it off the routine path for
   cost, so it is run from the Actions tab before a release; a portability claim no one has
   tested on the platform is not a claim.

Not included, deliberately. A **local builder** is refused by design (ADR-022, `routeRole`
stops the run rather than putting a builder on a local model), so "every feature at full
capacity" cannot mean that, and a condition the architecture forbids would be dishonest.
Local planner and critic stages have already run on real routing decisions.

### Consequences

The honest reading of today is that the system is well built and barely used. Eight pull
requests merged on 04/10/2026 and two autonomous Tier 0 merges on PulseApp, all of which is
real - but Tier 0 runs checks and merges, it never calls a model. None of it exercised the
pipeline this ADR is about.

This also reframes what the per-role spend figures are. ADR-034 measured planner, critic,
builder and reviewer costs across 24 metered calls and found three of four estimates wrong;
those 24 calls came from toy objectives against a fixture. The estimates will want checking
again once real objectives have run, which is part of why the correction waits for 50
(`ROLE_ESTIMATE_REVIEW_CALLS`).

**Separately decided 04/10/2026, same conversation:** the merge allowlist bar stays as
written - ten green merges over fourteen days with containerised verification - and `shopfront`
and `PulseApp` are recorded as explicit exceptions Dan made for small-blast-radius
repositories, not as the bar being met. The bar has therefore never been exercised, and
saying so is better than quietly lowering it to match practice. S5.7 is updated accordingly.

**Evidence:** run states and event-type counts queried from the live database on 04/10/2026
and quoted above; `repairing` transitions in `packages/domain/src/index.ts`; S5's gate text
and S5.2's status in `MASTER-CHECKLIST.md`; the contradiction between `README.md` and
`docs/STATUS.md` as they stood before this change.

## ADR template

```markdown
## ADR-NNN — Title

**Status:** proposed | accepted | superseded | rejected  
**Context:**  
**Decision:**  
**Consequences:**  
**Evidence:**  
**Supersedes / superseded by:**
```

## ADR-036 - the Vercel check stays red on pipeline pull requests, and that is the decision

**Date:** 2026-10-06
**Status:** accepted

### Context

shopfront deploys through Vercel, and Vercel posts a status check on every pull request. The
pipeline commits as `TheForge <theforge@users.noreply.github.com>`, an identity that is not on
the Vercel team, so that check fails on every pull request the pipeline opens:

    Vercel  fail  Git author TheForge must have access to the project on Vercel
                  to create deployments.

PulseApp never showed this because it is not Vercel-deployed. shopfront #50 was the first
pipeline pull request to a Vercel project.

### What was measured, not assumed

The worry worth checking was whether this breaks the **production** deploy, since that would
make every pipeline merge a deployment outage. It does not, and this was confirmed on the
merged commit rather than reasoned about:

    commit 1a7fc54b on shopfront main
      author:    MisterWizzard <51569665+MisterWizzard@users.noreply.github.com>
      committer: GitHub <noreply@github.com>
      Lint, typecheck & build  success
      Vercel                   success  "Deployment has completed"

The squash rewrites the commit with Dan as author, so the `TheForge` identity never reaches
`main`; it exists only on the short-lived branch commit. shopfront is squash-only
(`allow_merge_commit: false`), so that is the only path a pull request can take.

### Decision

Leave it failing. Dan, 06/10/2026, having been shown the above: *"ignore it then"*.

### What it costs

Exactly one thing: **no preview deployment on pipeline pull requests.** There is no
`vercel.app` URL to click while reviewing. The real gate - `Lint, typecheck & build` - still
runs, merging still works, and production still deploys.

For a test-writing objective that costs nothing, since the tests change no rendered pixel. For
a future pipeline pull request that touches UI it is a genuine loss, and that is the point at
which this decision should be revisited rather than inherited.

### The risk this accepts, named so it is not discovered later

A permanently red check trains a reader to skim the check list, which is the same failure mode
as the flaky test fixed in BLK-030 on the same day: a signal that is always red stops being
read, and the next red one hides inside it. The mitigation is this ADR - the red X has a
written reason, so a second one is a question rather than noise.

### Alternatives, and why not

- **Add `TheForge` to the Vercel project.** Restores previews, and gives a bot identity the
  ability to trigger deployments. A bot that cannot deploy is the safer default.
- **Point `FORGE_GIT_AUTHOR_NAME`/`FORGE_GIT_AUTHOR_EMAIL` at Dan.** One `.env` line, no Vercel
  admin needed, restores previews - and makes pipeline commits indistinguishable from his own
  at a glance on the branch. The distinguishability is worth more than the preview today.

### Revisit when

A pipeline objective changes UI, or shopfront stops being squash-only - a true merge commit would
carry the original author onto `main`, and the production claim above would need re-checking
before it could be relied on.


## ADR-037 - the daily cloud ceiling follows a monthly credit allowance

**Status:** accepted

The full record is withheld from this published copy because it contains personal billing detail.
The decision: when a monthly budget is configured, the daily cloud ceiling is no longer a flat
figure. The configured daily ceiling becomes a floor, and the cap for each day is derived from
what is left of the monthly budget and the days left in the period, up to a configured maximum,
so unspent days raise the cap later in the period. See `packages/guardrails/src/budget.ts` and
the adaptive monthly budget section of `docs/OPERATIONS.md`.

## ADR-038 - a provider key is proved, not presumed, and a failover is said out loud

**Date:** 2026-10-13
**Status:** accepted

### Context

BLK-031 (12/10/2026). The new Anthropic API key returned HTTP 400 `This API key is not scoped
to a workspace` on every request. The worker still advertised `provider:claude` because a key
was _present_, the coordinator's `provider.diagnostic` therefore said `authenticated: true`, the
planner call failed, and ADR-024's automatic fallback ran the stage on Codex at $0. A broken key
was indistinguishable from a system that was merely cheap, and nothing in the digest said a
failover had happened. ADR-037 recorded this as its follow-up.

### Decision

**The worker proves an API key once, at startup.** For Claude on an API key
(`apps/worker/src/key-probe.ts`) it sends one request, `max_tokens: 1` on `claude-haiku-5-5`, to
`https://api.anthropic.com/v1/messages`. The result is one of three:

- **`ok`:** advertise `provider:claude` as before.
- **`rejected`** (HTTP 400, 401, 402 or 403, so the API looked at the key, its workspace or its
  credit and said no): do **not** advertise `provider:claude`, and register the API's own words
  as `providerFaults.claude`. The worker logs the same line.
- **`inconclusive`** (network error, timeout, 404 such as a retired probe model, 408, 429, 5xx):
  advertise anyway and log that the key could not be verified. A blip at startup says nothing
  about the key and must not switch Claude off until the worker is restarted.

**The coordinator says why.** `providerAvailability` (`apps/coordinator/src/provider-diagnostic.ts`)
returns `available: true, authenticated: false` and "claude is configured on worker X but does
not work: <reason>" when an online worker withheld the provider with a fault, instead of the
bare "No online worker advertises provider:claude". `GET /api/providers` and the run's
`provider.diagnostic` events carry it. `providerFaults` is a new optional field on worker
registration, bounded to 64-character keys and 500-character values because that text reaches
events and the digest.

**The digest names every failover.** A `Provider failover` section lists, per direction, how many
stages ran on another provider and the last reason, built from the existing `provider.fallback`
events; the compact head gains `provider failover: N`. Both appear only when something failed
over, so a healthy day's digest is unchanged.

### Consequences

- With a bad key the router now sees Claude as unavailable up front, so a stage goes to Codex
  without first spending a failed Claude job and a retry, and `routing.decided` says so. Nothing
  is spent either way; what changed is that it is no longer silent.
- The probe costs about a thousandth of a cent per worker start and sends the key from the
  worker host to Anthropic over HTTPS, as a header only. SECURITY.md's secrets table says so.
  The error text is scrubbed of the key and cut to 300 characters.
- **Not periodic.** The probe runs at worker start, so a key fixed later needs a worker restart
  (which the unblock step for BLK-031 already is), and a key that breaks _after_ start is caught
  by the failing job, the fallback, and the new digest line, not by the probe. The task brief
  asked for a cache of some minutes; with one probe per start there is nothing to cache.
- **Claude on an API key only.** A Claude OAuth credentials file is still checked by
  `claude auth status`, which says nothing about credit or workspace; the OpenAI key reaching
  Codex is still checked by `codex login status`. Neither is probed here.
- The probe model id is a constant. If Anthropic retires it the API answers 404, which is
  classed inconclusive, so the probe quietly stops proving anything and the worker log says
  "could not be verified". Update `KEY_PROBE_MODEL` then.
- Faults live in the coordinator's memory and are re-sent when a worker re-registers, which it
  does on any lost session; they are not persisted to the database.

### Verified

27 new tests: `key-probe.test.ts` (19: the request shape, the key never in the URL or body, every
status class, an unreachable API, a timeout, redaction of an echoed key, truncation, the verdict),
`provider-diagnostic.test.ts` (5), two registration tests in `server.test.ts` (faults stored and
listed; an over-long fault refused) and one digest test (the section, its absence in a quiet
window, the compact head). Full gate: 58 files, 735 tests, 733 passed, 2 skipped, 0 failed;
eslint and typecheck 20/20 clean.

**Live, 13/10/2026, against the real key:** after restarting the worker the log reads `claude:
not advertised, the API key was rejected (HTTP 400): This API key is not scoped to a workspace,
...`, and `GET /api/providers` reports `claude available=true authenticated=false` with the same
reason while `codex` and `ollama` stay `authenticated=true`. The worker log holds no `sk-ant`
string. This is the first time the bad key has been visible to the system without a run having
to fail on it.

**Supersedes / superseded by:** completes the follow-up named in ADR-037; amends what the
`provider.diagnostic` event means ("authenticated" now means proved, for a Claude API key);
ADR-024's fallback is unchanged.


## ADR-039 - an unscoped API key is sent with its workspace id

**Date:** 2026-10-13
**Status:** accepted

### Context

BLK-031. A fresh Anthropic API key, created on 13/10/2026 after the first one failed, was rejected
with the identical HTTP 400 `This API key is not scoped to a workspace, so this request must
include the anthropic-workspace-id header`. ADR-038 had already made that visible: the worker
withheld Claude and `GET /api/providers` said why. Creating a key "inside the workspace" did not
change the answer, so the fix had to be on the request side, which the API's own message names.

### What was measured, not assumed

Before any code was written, the same one-token request that the probe sends was repeated with the
header `anthropic-workspace-id: wrkspc_01ExampleWorkspaceIdXXXX` added. The API returned HTTP 200
(`claude-haiku-5-5`, 10 input tokens, 1 output token). Without the header, the same key returns 400.

### Decision

Dan, 13/10/2026, supplied the workspace id (it is an identifier, not a secret).

- New optional worker setting `FORGE_ANTHROPIC_WORKSPACE_ID`, validated as `wrkspc_` plus
  alphanumerics so a typo fails at start instead of at the first run.
- The key probe (ADR-038) sends it as `anthropic-workspace-id`.
- The Claude container gets `ANTHROPIC_CUSTOM_HEADERS=anthropic-workspace-id: <id>` as a plain
  `--env` on `docker run` (`sandboxProviderEnvironment`). Claude containers only; the Codex
  container never sees it. It is a plain argument because it is not a secret, and that means the
  sandbox image's entrypoint is untouched and nothing needs a rebuild.
- Unset, behaviour is exactly as before: no header, and the existing tests that count `--env`
  flags pass `null` so they do not depend on what the developer's `.env` holds.

### Verified

Four new tests (probe header present only when given; the container argument present for Claude,
absent for Codex and when unset). Full gate green; eslint and typecheck 20/20 clean.

**Live, 13/10/2026 05:36 AEDT.** With the id in `.env` and the worker restarted:
`claude: API key verified with a one-token request`; `GET /api/providers` shows `claude
authenticated=true`. A run on the acceptance fixture (`6b8b44f9`, the `clampPercent` objective)
then ran **every stage on Claude with no fallback**, the first calls billed to the API key:

    planner   $0.1788   critic   $0.1279   planner (revision)   $0.1503
    builder   $0.1797   reviewer $0.1172          total $0.7539

339,853 input tokens (339,822 cached), 12,199 output. `node --test` passed in the worker, the
reviewer approved with no findings, and the run committed `0aae92f`. It ended `partially_completed`
only because the push and draft PR are an Amber action awaiting Dan's approval, as designed. The
digest's monthly line shows the adaptive cap (ADR-037) working: tomorrow's cap will be higher by the unspent share.

Measured costs sit well under the estimates the guards use (planner $0.18 and $0.15 against $0.70;
builder $0.18 against $1.25; reviewer $0.12 against $0.40; critic $0.13 against $0.25), so the guard
will turn work away earlier than the real spend requires. That is the safe direction and the
recalibration at 50 metered calls (ADR-034) is unchanged; five calls is not evidence.

### What it costs

One more setting. A worker that serves several Anthropic workspaces would need one id per key; this
is one id per worker, which is all there is today.

**Supersedes / superseded by:** completes the unblock named in BLK-031; extends ADR-038's probe.


## ADR-040 - the repository cache fetches into remote-tracking refs, and worktrees start from them

**Date:** 2026-10-13
**Status:** accepted

### Context

BLK-032. Run `0117dba8` built on the acceptance fixture at `2a8bd4c` while the fixture's `main`
was `75aea59`, and a plan described the fixture as lacking a helper it already had. All three
caches under `C:\forge\workspaces\cache` were behind their real `main` (fixture, PulseApp,
shopfront). `GitWorkspaceRuntime.register` created the cache with `git clone --bare` and thereafter
"refreshed" it with `git fetch --prune origin`. A bare clone is created with no
`remote.origin.fetch` refspec, so that fetch downloaded objects and moved no branch;
`createWorktree` branched from the cache's own `main`, frozen at the first clone. Every objective
on a repository that had moved since the Forge first saw it was planned, built, verified and
reviewed on stale code, and the pull request it opened was a branch off an old commit.

### Decision

- `register` clones on first sight only, then **always** sets
  `remote.origin.fetch = +refs/heads/*:refs/remotes/origin/*` (`config --replace-all`, so it is
  idempotent and repairs a cache cloned before this fix) and fetches with `--prune`.
- The destination is **remote-tracking refs, not `refs/heads/*`**. Git refuses to update a branch
  that a worktree has checked out, and the `forge/*` task branches are exactly that; a
  `+refs/heads/*:refs/heads/*` refspec would break the refresh whenever a task branch exists on
  the remote.
- `createWorktree` starts from `refs/remotes/origin/<baseRef>` when it exists, and otherwise from
  `baseRef` as given, so a tag, a commit hash or a name that exists only locally still works.
- A failure to fetch now surfaces as itself. The old shape (`try fetch, catch clone`) turned a
  network error on an existing cache into a confusing "destination path already exists" from the
  clone that followed.

### Consequences

- The live caches repair themselves the next time a run calls `register`; nothing is edited by
  hand. The coordinator must be rebuilt and restarted for it to run the new code.
- Existing worktrees are unaffected. A worktree already created from a stale base stays where it
  is; only new ones start from the remote tip.
- The cache's local `refs/heads/main` stays at the old commit forever and is now unused. Nothing
  else reads it (`createWorktree` was the only consumer of `baseRef` in the runtime).
- A force-pushed or rewritten remote branch moves the remote-tracking ref (the `+` in the
  refspec), which is the intended behaviour for a cache.
- Runs and pushes already in flight on a stale base (`0117dba8`, `486b8e1e`) are not repaired by
  this; their Amber approvals should be left to expire.

### Verified

Six new tests in `packages/git-runtime/src/git.test.ts`, against real temporary repositories:
a worktree starts at the remote's new tip after it moves; a pre-fix cache with no refspec is
repaired; registering twice leaves one refspec; a refresh succeeds while a `forge/*` branch is
checked out (the case that rules out the obvious refspec); a commit hash and a tag still work
as bases; a deleted remote branch is pruned. **Four of the six fail on the old code** (the
advance, the repair, the idempotency and the prune), which is the defect reproduced; the other
two are guards against the naive fix and against regression. Git-runtime suite 29 of 29.

**Against the real stale cache:** a copy of the live fixture cache (`main` at `2a8bd4c`, no
refspec) was run through the fixed `register` and `createWorktree` against the real GitHub
remote: the refspec appeared, `refs/remotes/origin/main` became `75aea598`, and the new worktree's
HEAD was `75aea598`, GitHub's current `main`. The live cache itself was not touched and still
reads `2a8bd4cf`.

**Supersedes / superseded by:** resolves BLK-032; nothing superseded.
## ADR-041 - Claude has two lanes: the metered API key and the subscription login

**Date:** 2026-10-13
**Status:** accepted (step 1 of 2; step 2, removing Codex, is a separate decision to be recorded when it is built)

### Context

Dan, 13/10/2026, wants GPT (Codex) out of the Forge and Claude used alone, to reduce cost, with the
Claude side split into the metered API key and the login lane. His answers to the three questions that
decide the shape: the aim is **cost reduction**; at the daily cap the Forge should **go local** (as
today, policy B3); and the subscription lane shares the login's usage limits.

Codex gives the Forge three things: a lane that costs nothing metered, a second vendor's judgement
for the critic and reviewer, and a substitute when Claude fails. Dropping it is only sensible once the
first and third are provided another way, so this is done in two steps and this ADR is the first: add
the free Claude lane and prove it. Removing Codex follows.

### Decision

- A second provider id, **`claude-sub`**, runs the same Claude Code CLI in the same sandbox on a
  **subscription login** (`FORGE_CLAUDE_CREDENTIALS_FILE`). The existing `claude` id becomes the
  **API-key lane** and takes `ANTHROPIC_API_KEY` only. Each id takes exactly one kind of credential
  (`credentialSourceFor`), which is what lets one worker advertise both. Before this the key silently
  won over the login file under the single id, so the two could not coexist.
- **`claude-sub` records $0.** The CLI reports a notional `total_cost_usd` even on a subscription;
  `ClaudeAdapter` takes `metered: false` for this lane and discards it. Otherwise the daily cap and the
  monthly budget (ADR-037) would count dollars the API never charged. It joins `UNMETERED_PROVIDERS`
  and the digest labels it `(subscription)`.
- **Routing is unchanged in shape.** `CLOUD_PROVIDER_IDS` is `claude`, `claude-sub`, `codex`, so
  `claude-sub` is the first substitute for a failed or absent `claude` and can be pinned per role from
  the run form. **It never substitutes at the cap**, per Dan's answer: past the ceiling planner and
  critic go to the local model and builder and reviewer stop (ADR-022, ADR-028, policy B3), exactly as
  for Codex.
- **The container entrypoint is untouched.** It knows only `claude` and `codex`, so both Claude ids reach
  it as `claude` (`cliFor`); the sandbox image needs no rebuild. The workspace header (ADR-039) and the
  key probe (ADR-038) belong to the API lane only: a subscription login is not an API key.

### Consequences

- **A dedicated login is strongly advised.** The CLI inside the container may refresh and rotate its tokens on a copy of the file; if that copy is the operator's everyday login, the host's login can be invalidated. A separate login made with `CLAUDE_CONFIG_DIR=<dir> claude auth login` avoids this.
- **Breaking, narrowly:** an install with a login file and no API key used to get `claude`; it now gets
  `claude-sub` and no `claude`.
- **Independence is weaker than Codex's.** Pinning the reviewer to `claude-sub` gives a different
  credential and a free call, not a different model. The ADR-035 recovery attempt that used a Codex
  reviewer would need another route after step 2.
- Step 2 (delete `packages/provider-codex`, the Codex CLI from the sandbox image, `OPENAI_API_KEY` and
  `FORGE_CODEX_AUTH_FILE`, the run-form option and 17 tests) is not done here.

### Verified

Fourteen new tests: the adapter records $0 for `metered: false` and the real cost otherwise, in both
`mapClaudeEvent` and a full run, and answers to the id it is given; the credential matrix (the key never
reaches the login lane, the file never reaches the API lane, Codex unchanged); the container receives
`claude` for both lanes and the workspace header only for the API lane; routing (first substitute, absent
`claude`, pinned, and not at the ceiling); the guard treats it as unmetered and refuses it past the
ceiling; the digest labels it. Full gate: see the pull request.

**Not verified live.** The subscription lane has not run a stage. It needs a login at
`FORGE_CLAUDE_CREDENTIALS_FILE`, a rebuilt and restarted worker and coordinator, and a run with a role
pinned to `claude-sub`; none of that has happened.

**Supersedes / superseded by:** extends ADR-024 (the default provider is unchanged; the substitute order
gains a lane) and ADR-038 and ADR-039 (both now scoped to the API lane); step 2 will supersede ADR-019's
Codex evidence and ADR-030's Codex sandbox handling.
