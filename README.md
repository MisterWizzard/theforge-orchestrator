# TheForge

TheForge takes a plain-language objective for a software repository, turns it into a plan, has the work done by coding agents in isolated copies of the repository, checks the result, and opens a draft pull request. A person approves the push and the pull request.

**Source published for review. All rights reserved.**

This is a code sample. No licence is granted; any use needs the author’s written permission.

## Status

Release candidate. A handful of real runs so far; not yet proven at volume.

The defects found along the way, and how they were fixed, are recorded as decisions in [docs/DECISIONS.md](docs/DECISIONS.md). Expect rough edges. The operator documentation assumes a single Windows machine with a Linux VM, because that is where it has been run.

The author's internal working records (session log, blocker ledger, task list) are not part of this public copy. The decision log, security policy and threat model are. Names of machines, networks and private repositories in the code and documents have been replaced with placeholders (the private repositories appear as `PulseApp`, `shopfront` and similar), so a few examples read oddly. The author’s public GitHub handle and first name are left in.

## The problem

A coding agent given a whole objective will happily rewrite things it was not asked to touch, spend more than you intended, leave a half-finished branch, or push to the wrong place. TheForge puts a fixed process and hard limits around the agents instead of trusting one long prompt:

- a planner writes the plan and a critic attacks it before any code is written;
- a builder edits files only inside an isolated copy of the repository;
- deterministic checks (install, lint, typecheck, tests) run against the result first, and a failing check stops the run with a recorded blocker;
- a reviewer reads the diff against the plan; its blocking findings go back to the builder, with the checks re-run after each repair, for up to three review rounds (so at most two repairs), and approval is decided from the findings rather than from the reviewer’s own "approved" flag;
- pushing a branch and opening a pull request wait for a human decision.

Run events are written to an append-only, hash-chained log in PostgreSQL, so a run can be audited afterwards, and after a crash the operator can restart it from its recorded stage events.

## Architecture

```text
 operator ──► web (Next.js) ──► coordinator (Fastify) ◄───────────────┐
              approvals,        run state, pipeline, approvals,       │ lease, heartbeats,
              run controls      spend guards, git cache + worktrees   │ result + patch
                                   │            │                     │
                      PostgreSQL ◄─┘            └─► Redis (job-id     worker (one per machine)
                  runs, jobs, leases,               hint only)          │
                  approvals, hash-chained events                        ├─ throwaway clone + patch per job
                                                                        └─ Docker sandbox ─► provider CLI (Claude or Codex)
                                                                           local model (Ollama): runs in the worker process
```

| Part                                               | What it does                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                                         | Dashboard and approval screens. Password-protected; binds loopback.                                                                                                                 |
| `apps/coordinator`                                 | Runs the pipeline and owns run state, the git cache and worktrees, job leases, limits and the event log.                                                                            |
| `apps/worker`                                      | Takes leased jobs: makes a throwaway clone with the coordinator's patch, runs the provider or the checks.                                                                           |
| `packages/domain`                                  | Entities and the full run and task state machines, with no I/O.                                                                                                                     |
| `packages/workflows`                               | The pipeline: plan, critique, build, verify, review, repair.                                                                                                                        |
| `packages/policy`                                  | Secret redaction; green, amber and red classification of commands the system runs itself; digest-pinned approval matching; a crude prompt-injection pattern check on operator text. |
| `packages/guardrails`                              | Spend ceiling, projected-cost check and role-to-model routing.                                                                                                                      |
| `packages/git-runtime`                             | Bare-clone cache, worktrees, branches, diffs, the approved push and the draft pull request.                                                                                         |
| `packages/db`, `queue`, `contracts`                | Schema and migrations, the job-id hint queue, and the Zod schemas every message is validated against.                                                                               |
| `packages/provider-*`                              | Adapters for each model provider, behind one contract.                                                                                                                              |
| `packages/tier0`, `notify`, `observability`, `cli` | A narrow auto-merge path, escalation channels, redaction and metrics, and the `pnpm forge` command.                                                                                 |

The domain package defines the full run state machine: `created`, `context_gathering`, `planning`, `critique`, `plan_revision`, `executing`, `reviewing`, `verifying`, `repairing`, `integrating`, then `completed` or `partially_completed`, with `paused`, `blocked`, `cancelled` and `failed` reachable from any active state. The demonstration walks the happy path through the planning, execution and integration states, and the domain tests check the transition table; nothing in the code moves a run into `repairing` or `blocked`, because repair rounds are task-level. The live coordinator today moves a run through a subset (`created`, `executing`, `paused`, then `completed`, `partially_completed`, `failed` or `cancelled`) and records the finer steps as events. The fuller design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Design choices

**Approval gates.** Every action belongs to one of three classes ([docs/SECURITY.md](docs/SECURITY.md)). Green actions run on their own: reading, editing inside the isolated copy, running checks in the sandbox. Amber actions are policy-controlled; the one that always needs a recorded approval is pushing a branch. Red actions, such as merging to a default branch, need explicit operator approval. The one documented exception is Tier 0, a narrow separate path that can merge Dependabot updates in two allowlisted repositories under a standing approval. Pipeline approvals are rows in the database that expire, and each is pinned to the exact commit being approved, so a stale approval cannot be replayed against different code.

**Worktree isolation.** Each project has one managed bare clone on the coordinator's host, and each run gets its own worktree and branch off the current remote head; the cache follows the remote, so a stale clone cannot produce a stale base. A worker never touches that cache: for each job it makes a throwaway clone at a pinned revision, applies the coordinator's patch, and mounts that into a Docker container with a read-only root, dropped capabilities, per-task limits and no credentials beyond the model login it needs. The builder's work comes back as a patch, which the coordinator applies to the run's worktree. The pipeline itself never merges: it opens draft pull requests.

**Scheduler.** Jobs and their leases live in PostgreSQL, which is the source of truth; workers poll the coordinator, which leases from PostgreSQL. Redis receives a best-effort copy of each new job id, which the coordinator drains on each lease poll, and scheduling is the same without it. A worker takes a time-limited lease and sends heartbeats, and completion is fenced by the lease token, so a worker that lost its lease cannot overwrite the result. If a lease expires, the coordinator reconciles it on the next lease poll and at start-up, and the job is queued again. Spend is checked before every provider call against a daily ceiling that counts metered API spend (the subscription lanes are not counted, but are refused past the ceiling), and when the ceiling is reached the cheaper planning roles can fall back to a local model while the builder and reviewer stop the run with a recorded blocker for the operator to resolve.

**Model independence.** Domain code never branches on which model is in use. Providers implement one adapter contract (availability, capabilities, start, resume and cancel, streamed events, usage, retryability), and which provider serves which role is decided by the router and the pipeline’s provider selection, while provider-specific credential and metering handling lives in the worker and the coordinator’s guards. Claude, Codex and a local Ollama model are all adapters today. Every model output is validated against a schema before anything acts on it, and repository text, tool output and model text are treated as untrusted.

## Run it locally

These steps document how the author runs the project, so a reviewer can check the claims above. They do not grant a licence.

You need Node 22 or later, pnpm 11 (`corepack enable` will fetch it), Git and Docker. Postgres and Redis run in containers on loopback ports 5432 and 6379.

```bash
pnpm install
cp .env.example .env     # then set the values marked "replace"; see below
pnpm setup:local         # starts Postgres and Redis, runs migrations, builds the sandbox image
pnpm check               # format, lint, typecheck, the full test suite and the build
```

In `.env`, set `FORGE_WORKER_TOKEN` and `FORGE_COORDINATOR_TOKEN` to random strings of at least 32 characters, `FORGE_WEB_OPERATOR_PASSWORD` to a password of 16 or more characters, and `FORGE_WORKER_ID` to any stable name. For example: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.

The tests use the database from `.env`, each test file in its own schema, so they do not touch other data.

To see the state machine and the task-dependency scheduling without any model account, run the in-memory demonstration (it is not the full plan, build and review pipeline, and it does not use the job queue):

```bash
pnpm demo
```

`pnpm demo` and `pnpm dev` need the workspace packages built, which `pnpm check` does (or run `pnpm build`). To start the services (web on `http://127.0.0.1:3000`, coordinator on port 4400, and a worker):

```bash
pnpm dev
```

Real runs need a model login for the sandbox (`ANTHROPIC_API_KEY`, or the credentials-file variables described in [docs/OPERATIONS.md](docs/OPERATIONS.md)) and, to push and open the draft pull request, a `GITHUB_TOKEN`. Without a model login the services start, but a run cannot get past provider selection, so nothing is planned, built or checked. Without `GITHUB_TOKEN` a run completes everything up to the approved push and then stops with a blocker. [docs/OPERATIONS.md](docs/OPERATIONS.md) covers everything else, including the Windows service setup the author uses; that part has only been exercised on one machine.

The default local database password (`forge`) is for the loopback-only development containers. Do not reuse it anywhere reachable.

## Where to look

- [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md): what it is meant to do, and the release acceptance test.
- [docs/DECISIONS.md](docs/DECISIONS.md): the significant design decisions, with the evidence behind them and what superseded what.
- [docs/SECURITY.md](docs/SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): the permission model and the threats considered.
- [AGENTS.md](AGENTS.md): the rules the coding agents working on this repository are held to.

## Rights

Source published for review. All rights reserved.
