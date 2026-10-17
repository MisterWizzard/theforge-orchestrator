# Operations

## Local start

1. Install Node.js 22+, pnpm 11+, Git and Docker.
2. Copy `.env.example` to `.env` and replace both development tokens with independent random values of 32 or more characters, and `FORGE_WEB_OPERATOR_PASSWORD` with a password of 16 or more (see "Operator login"); the placeholders are deliberately too short to be accepted. Leave the optional credential lines commented out until you have a value for them: an empty value such as `GITHUB_TOKEN=` is treated as unset. If anything is wrong, each app exits at startup with one line per variable naming the problem and the fix; the web app instead answers 503 until the password is right.
3. Run `pnpm install --frozen-lockfile`, `pnpm setup:local`, then `pnpm dev`.
4. Open `http://localhost:3000` and sign in with the operator password; coordinator health is `http://localhost:4400/health`.

`pnpm setup:local` starts PostgreSQL and Redis, applies migrations, and builds the pinned `theforge-worker-sandbox:local` Linux image. Start a worker in another terminal with `pnpm --filter @theforge/worker dev`. Keep `FORGE_WORKER_ID` stable across restarts so orphaned containers and lease recovery can be reconciled.

PostgreSQL is authoritative. Redis only carries task identifiers, so queue loss is recovered by coordinator reconciliation. Back up the PostgreSQL volume and managed Git cache. Test restores into a separate volume before relying on a backup.

## Private workers

Join machines to the same Tailscale network, bind the coordinator to its private interface, and use HTTPS or Tailscale Serve. Install Docker with Linux container support, build the sandbox image, and set `FORGE_API_URL`, `FORGE_WORKER_TOKEN`, a stable `FORGE_WORKER_ID`, and a machine-local `FORGE_WORKSPACE_ROOT`, then run `pnpm --filter @theforge/worker dev`. Never expose the worker endpoint unauthenticated to the public internet.

GitHub integration requires a fine-grained `GITHUB_TOKEN` limited to the target repository with Metadata read, Contents read/write, and Pull requests read/write. The same token authenticates the exact approved Git push through an ephemeral askpass environment and the draft-PR API call; it is not written into a remote URL, Git configuration, workspace, or log. Do not reuse a broad operator token when a fixture-scoped token can be issued.

Production workers require a running Linux Docker engine on every host. The Windows/macOS portable CI smoke uses `NODE_ENV=test` host execution only to prove the built daemon protocol and lifecycle; it is not production sandbox evidence. Release evidence for a macOS production worker must come from a controlled macOS host with Docker Desktop or another approved Linux-container runtime.

## Operator login

The web control centre (`apps/web`) needs the operator password before it answers anything (ADR-027). Two variables in `.env`:

- `FORGE_WEB_OPERATOR_PASSWORD` - required, 16 or more characters. Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`. While it is missing or too short every page is a 503 "Operator login is not configured" and every `/forge-api/*` call is 503 JSON; only `/login`, `/logout` and `/forge-api/health` answer. Nothing prints the value: the 503 page, the login page and the doctor name the variable and the rule.
- `FORGE_WEB_SESSION_SECRET` - optional, 16 or more characters. Signs the session cookie. When it is unset the signing key is derived from the password, so changing the password also signs every browser out. Set the secret when you want those apart: rotate the secret to sign out everywhere, change the password without doing so.

Open `http://127.0.0.1:3000/login` (or the tailnet address), enter the password, and you land where you were going. The session is a `forge_session` cookie: HttpOnly, SameSite=Strict, 12 hours from sign-in (not sliding: after 12 hours you sign in again), and `Secure` when the app is served over HTTPS, either directly or behind a proxy that sets `x-forwarded-proto: https`, as Tailscale Serve does. "Log out" in the rail clears it; because the token is stateless that clears one browser and nothing else. Five wrong passwords from one address lock that address out for a minute, fifty from anywhere lock everyone for a minute, and every failure waits 300 ms. The counts live in the web process and are forgotten when it restarts.

The `/forge-api` proxy still forwards with `FORGE_COORDINATOR_TOKEN` and still requires same-origin JSON for mutations; the login sits in front of both. `curl` against `/forge-api/*` now needs the cookie; scripts use the coordinator's `/api/*` with the token, as before.

Restart the web app after changing either variable (`pnpm dev` and `next start` read `.env` at start). `pnpm forge runtime doctor` prints `WARNING` on its `web operator password` line when the variable is missing or short, without failing the pre-flight.

## Recovery

- Restart the coordinator normally; persisted states and expired leases are reconciled. A run resumed before its worker has re-registered waits for it rather than failing (ADR-029); see "Waiting for a worker after a restart".
- A lost worker's lease expires and becomes eligible for reassignment. The replacement reconstructs the exact repository revision, tracked binary patch, and bounded untracked files under its own workspace root; stale completion is rejected by the old fence.
- Legacy pre-transport jobs are retained for audit but migration 005 cancels any obsolete active lease because coordinator-local paths cannot be replayed safely.

## Retention cleanup

Retention is deliberately two-step. First obtain a dry-run count and exact confirmation digest:

```bash
curl -sS http://127.0.0.1:4400/api/operations/retention/preview \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN" \
  --data '{"before":"2026-01-01T00:00:00.000Z"}'
```

After reviewing the counts, send the unchanged cutoff and returned digest with the coordinator token. If the candidate set changed, execution is rejected and a fresh preview is required.

```bash
curl -sS http://127.0.0.1:4400/api/operations/retention/execute \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN" \
  --data '{"before":"2026-01-01T00:00:00.000Z","confirmationDigest":"<digest-from-preview>"}'
```

- Pause affected runs on suspected compromise, rotate worker/coordinator tokens, preserve logs, and inspect the redacted audit stream.
- Do not delete managed worktrees until commits and artifacts are captured.

## Provider diagnostics

Claude Code 2.1.216 and Codex 0.144.6 are pinned in the worker image. Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or point `FORGE_CODEX_AUTH_FILE` at a machine-local JSON credential file. Claude takes `ANTHROPIC_API_KEY` only; Codex takes `OPENAI_API_KEY`, then its auth file. `claude` is the default for every role, is metered, and is what the daily cap and the monthly budget count. The worker reads the selected value, sends it to a per-job container over stdin, writes file credentials only to container tmpfs, and redacts known credential strings from returned events. Credential paths and values are never placed in Docker arguments or workspace snapshots.

**An API key is proved at worker start (ADR-038).** With `ANTHROPIC_API_KEY` set, the worker sends one `max_tokens: 1` request to the Anthropic API before it advertises `provider:claude`, and says so in its log: `claude: API key verified with a one-token request`. If the API rejects the key (HTTP 400, 401, 402 or 403 - an unscoped workspace, an invalid key, no credit, no permission) the worker does **not** advertise Claude and logs `claude: not advertised, the API key was rejected (HTTP nnn): <the API's words>`; `GET /api/providers` and the run's `provider.diagnostic` then read `claude available=true authenticated=false` with the same reason, instead of looking healthy. If the probe cannot decide (network, timeout, rate limit, a 5xx, a retired probe model) the provider is still advertised and the log says it was not verified. It runs once per worker start, so after fixing a key restart `TheForge Worker`; it covers a Claude API key only, not the OpenAI key. If the API answers `This API key is not scoped to a workspace`, either create the key from inside the workspace that holds the credits, or set `FORGE_ANTHROPIC_WORKSPACE_ID=wrkspc_...` in `.env` (not a secret) and restart `TheForge Worker` (ADR-039): the worker then sends it as `anthropic-workspace-id` in the key check and passes it to the Claude CLI in the sandbox as `ANTHROPIC_CUSTOM_HEADERS`, for Claude containers only. When a stage runs on another provider because the first failed (ADR-024), the digest says so under `Provider failover` and in its compact head.

Startup diagnostics execute in the same container boundary as provider work. Commands use no network, except the dependency-install step, which runs alone in its own short-lived container on Docker `bridge` networking before the sealed checks (see SECURITY.md); provider jobs use explicit Docker bridge egress because their APIs require it. A successful diagnostic does not guarantee quota, so complete one real request before release acceptance. Missing or exhausted providers are not advertised, and the deterministic provider remains test-only.

## Provider sandboxing and the Codex bypass

**Why this exists.** The Codex CLI sandboxes its own tool use with landlock, seccomp and a user namespace. Inside TheForge's per-job container — non-root, read-only root filesystem, all capabilities dropped, no `CAP_SYS_ADMIN` — that nested sandbox cannot initialise, and Codex loses its shell: in run `e3de1306` the critic said so itself ("The workspace shell is unavailable because its sandbox cannot create a user namespace") and reviewed the plan blind to the repository (BLK-016, ADR-030, `docs/evidence-cross-provider-2026-09-26.txt`).

**The marker.** `FORGE_EXTERNALLY_SANDBOXED=1` is set on every provider container by the worker, in `sandboxProviderEnvironment()` next to the `docker run` arguments, and is the only thing that makes the Codex adapter pass `--dangerously-bypass-approvals-and-sandbox` instead of `--sandbox workspace-write`. Exactly that value counts: absent, empty, `0` or `true` all mean "not sandboxed", and Codex keeps its own sandbox. The bypass removes Codex's _inner_ sandbox only — the container boundary around it is unchanged and is what actually contains the CLI.

**It is not an operator setting.** `FORGE_EXTERNALLY_SANDBOXED` is deliberately absent from the worker's environment schema; adding it to `.env` changes nothing, because the worker hands the adapter the container's environment rather than its own. Do not set it on the host: it exists so that a process which is _not_ in the container can never see it. In `docker inspect` of a provider container you should see exactly two `--env` values, `HOME=/home/node` and `FORGE_EXTERNALLY_SANDBOXED=1`; a provider container without the marker means Codex will run with a sandbox it cannot build, which reads as a critic that will not look at the diff.

**Claude needs no equivalent.** The Claude CLI nests no sandbox; its tool use is gated by `--permission-mode`, set per role (ADR-016), and it showed no shell loss in the same run. Nothing about it changed.

**The live smoke test.** One real Codex run inside the real image, off by default so CI never depends on it (like `FORGE_OLLAMA_SMOKE` above). It asks the CLI for the contents of a file in its workspace, which only a working shell can answer:

```powershell
$env:FORGE_CODEX_SMOKE = '1'
$env:FORGE_CODEX_AUTH_FILE = "$env:USERPROFILE\.codex\auth.json"   # from `codex login`; never printed
pnpm exec vitest run apps/worker -t 'reads a workspace file through its shell'
```

It skips cleanly, rather than failing, when the flag is unset, when neither `FORGE_CODEX_AUTH_FILE` (existing) nor `OPENAI_API_KEY` is set, or when the `theforge-worker-sandbox:local` image is missing (`pnpm sandbox:build`). Docker must be running: the test drives a real container. Codex on a subscription bills the run at $0, and the prompt is a few hundred tokens. A pass prints the CLI's answer containing the file's one-off token; a failure that mentions a user namespace is BLK-016 returning.

## Waiting for a worker after a restart

**Why this exists.** The coordinator and the worker are separate scheduled tasks, so the coordinator is up and serving before the worker has re-registered. A run resumed in that window used to read provider availability once, see "No online worker advertises provider:claude", and fail — the S5.3 restart test on 27/09/2026 caught the worker re-leasing the job one event after `run.failed` (ADR-029). Every restart and every reboot therefore killed every in-flight run.

**What happens now.** A run that cannot see any usable provider **and** has no worker online at all waits, polling the diagnostics once a second, for up to `FORGE_PROVIDER_WAIT_MS`. The wait ends the moment a worker registers. If the budget runs out the run is **paused**, not failed, and keeps its place.

| Situation                                                      | Behaviour                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A worker is online but does not advertise the provider         | `run.failed` at once: `No authenticated provider is available`. Unchanged. |
| No worker online, run being resumed or a worker row exists     | Wait up to `FORGE_PROVIDER_WAIT_MS`, then pause.                           |
| No worker online, no worker ever registered, run's first start | `run.failed` at once, so a misconfigured machine says so immediately.      |

A run's first start is the only one that comes from state `created`, so a resume, a retry and the `executing` row a killed coordinator leaves behind all count as "being resumed".

**`FORGE_PROVIDER_WAIT_MS`.** Milliseconds, `0`–`3600000`, default `90000`. `0` restores the pre-ADR-029 behaviour: fail immediately, no wait. The value is read at coordinator start, so change it in `.env` and restart the coordinator (`pnpm forge runtime stop`, `pnpm forge runtime start`). It is unrelated to `FORGE_WORKER_JOB_WAIT_MS`, which bounds how long an already-queued job waits for a worker to lease it. Once a worker leases it, `FORGE_WORKER_JOB_EXECUTION_MS` bounds the rest (default `FORGE_STAGE_TIMEOUT_MS` + 5 minutes); until 05/10/2026 one variable bounded both phases, and that cancelled a builder job whose result carried `code: 0`. The stage timeout stops advancing under a halt as well, since 05/10/2026: before that a halt longer than `FORGE_STAGE_TIMEOUT_MS` failed the run anyway, on a job that had never started, which made the sentence above about halts of any length only half true. Two limits are still wall clock on purpose - the provider's own `timeoutMs` and the worker's container deadline - because they bound a job a worker already has, and a halted job is one no worker has taken.

**What to look for in the event stream.**

- `provider.wait_started {reason, budgetMs, intervalMs}` — the run is waiting, not hung. Emitted once per execution.
- `provider.wait_satisfied {waitedMs, providers}` — a worker turned up and the run carried on.
- `run.paused_by_guard {guard: "provider", reason, waitedMs, diagnostics, classification: "safety_constraint", resumeHint}` — the budget ran out. Same event and same blocker shape as a spend pause; `guard` is what tells the two apart. The run is `paused` and nothing was spent.

**Resuming a run paused this way.** Start the worker, confirm it is listed:

```
pnpm forge runtime start
curl -H "Authorization: Bearer $FORGE_COORDINATOR_TOKEN" http://127.0.0.1:4400/api/workers
```

then resume:

```
curl -X POST -H "Authorization: Bearer $FORGE_COORDINATOR_TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"resume"}' \
  http://127.0.0.1:4400/api/runs/<run id>/control
```

The worktree, the plan and the critique are all still there (see "Worktrees and retries"), so the resume picks up at the stage that was interrupted.

**Evidence.** `apps/coordinator/src/server.resume.test.ts` and `packages/workflows/src/pipeline-provider-wait.test.ts`, 27/09/2026. The counterfactual is recorded in ADR-029: with the budget forced to 0 both coordinator tests fail and reproduce the measured trace.

## Release verification

With local PostgreSQL and Redis URLs configured, run:

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm check
pnpm test:acceptance
pnpm test:e2e
pnpm audit --prod
```

Then prove that the worker boots from `.env` rather than from a test default:

1. `pnpm exec vitest run tests/env-example.test.ts` parses `.env.example` through both apps' configuration schemas with `NODE_ENV=development` and must pass.
2. With the coordinator running (`pnpm dev`), start `pnpm --filter @theforge/worker dev` in another terminal. A configuration failure prints `[worker] Invalid configuration (environment read from <path to .env>)` followed by one line per variable and exits before any Docker check, so fix those lines first. A healthy worker prints nothing about configuration and, within a few seconds, `curl -sS http://127.0.0.1:4400/api/workers -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN"` lists your `FORGE_WORKER_ID` with `"status":"online"` and a `sandbox:docker` capability.

`pnpm test:acceptance` fails closed when either infrastructure URL is absent. It deliberately ends at a pending integration approval and never pushes or invents pull-request evidence. The final real-provider/fixture-PR gate additionally requires Claude quota, a least-privilege fixture token, and explicit approval of the exact action shown in the UI.

## Stopping the system (kill switch)

Policy B13: the kill switch is both a file and a command, and the file is the only state. The CLI, the API and a file made by hand all end in the same place, so a halt survives a coordinator restart and a directory listing always agrees with the API.

**Where the file is.** `FORGE_HALT_FILE` when set (use an absolute path); otherwise `FORGE_WORKSPACE_ROOT` is resolved to an absolute path first and the file is `../FORGE_HALT` from there, which with the default workspace root is `<working directory>/.forge/FORGE_HALT`. The working directory is the coordinator's: `pnpm dev` starts it from `apps/coordinator`, whereas `pnpm forge` runs from the repository root, so set `FORGE_HALT_FILE` in `.env` unless both are always started from the same directory. The coordinator logs the path it resolved at startup, `GET /api/halt` returns it, and `pnpm forge status` warns when its own answer differs from the coordinator's.

**Command.** From the repository root (this loads `.env`):

```powershell
pnpm forge halt --reason="why"   # write the halt file
pnpm forge status                # local file; plus /health and /api/halt when FORGE_API_URL and FORGE_COORDINATOR_TOKEN are set
pnpm forge resume                # remove the halt file
```

`halt` and `resume` act on the file directly, so they need no token and work while the coordinator is down; run them on the coordinator's host or on a machine that shares its filesystem.

**API.** The same three operations over HTTP, behind the coordinator token:

```bash
curl -sS -X POST http://127.0.0.1:4400/api/halt \
  -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN" \
  -H 'content-type: application/json' --data '{"reason":"why"}'
curl -sS http://127.0.0.1:4400/api/halt -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN"
curl -sS -X DELETE http://127.0.0.1:4400/api/halt -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN"
```

`POST` writes the file atomically (temporary file, then rename) with `{"requestedAt","requestedBy":"api","reason"}`; `DELETE` removes it; `GET` reports `halted`, `source`, `haltFile` and, when the file carries one, the parsed `request`.

**By hand.** Create a file at the path above by any means - `touch`, a file manager, a network share. An empty file counts. Delete it to resume.

**What a halt does.** The coordinator stops leasing work: `GET /api/workers/:id/jobs/next` answers 204 with `x-forge-halted: file` and workers idle. Nothing in flight is killed - a job that was already leased runs to completion and its worktree is left intact for inspection. A pipeline run that is waiting on a provider when the halt lands is not interrupted either: that wait ends when the provider job completes or when the pipeline's 900 s provider timeout (`packages/workflows/src/index.ts`) expires, whichever comes first, so allow up to 15 minutes for a mid-run halt to go fully quiet. Restarting the coordinator does not clear a halt; only removing the file does, and the coordinator says so at startup when it finds the file present.

## Verifying the audit log

Every `events` row is part of a per-run hash chain (ADR-020): `prev_hash` is the previous row's `row_hash` in sequence order and `row_hash` covers the row's own content. Recompute it whenever the database has been restored, touched by hand, or before trusting a run's history for a decision:

```powershell
pnpm forge verify-audit                 # every run, one line each, exit 1 on any break
pnpm forge verify-audit --run=<run id>  # one run
pnpm forge verify-audit --json          # one JSON document: { ok, runs: [{ runId, ok, checked, legacy, firstBad? }] }
```

Runs from the repository root so `.env` supplies `DATABASE_URL`; nothing else is needed and the coordinator can be down. A healthy run prints `run <id>: ok, N event(s) verified`; a broken one prints `run <id>: BROKEN at sequence S: <reason>`, where the reason says whether the row's own content changed (`row_hash ... does not match`) or a predecessor was removed, reordered or re-hashed (`prev_hash ... does not link`). `legacy` counts rows written before migration 006, which carry no hash and are skipped, not verified. The command reads only; it changes nothing.

The audit tables refuse `UPDATE` and `DELETE`. Retention is the one legitimate path and it removes whole runs, never single events: a run that reached a terminal state (`completed`, `partially_completed`, `cancelled`, `failed`) and was last updated before the cutoff is deleted with everything that cascades from it, after an `audit_tombstones` row records its final sequence and hash. The retention preview under "Retention cleanup" above now reports `runs`, `events` and `artifacts` for that set; runs still executing, paused or blocked are never candidates however old they are. A break that `verify-audit` reports means the log was altered or lost rows outside that path: keep the database as it is, take a backup, and treat it as a security finding (policy B11) before anything else runs.

## Guardrails in dispatch

The guardrails in `packages/guardrails` are pure decision functions. What makes them rules rather than advice is where they are called: on the lease path every job passes through, on the dispatch path every cloud call passes through, and in the worker loop every provider event passes through. Normal execution cannot go around them, and a refusal is a prompt, explained outcome, never a 900 s wait for a worker that will not come.

**The day.** Policy days are Dan's days. The ceiling counts calendar days in `FORGE_TIMEZONE` (default `Australia/Sydney`, daylight saving included), not UTC days, which would roll over at 10:00 or 11:00 local time and split a working morning across two budgets. Every ceiling event carries `day` (`YYYY-MM-DD`) and `timeZone` so a reading is unambiguous.

**What each guard does.**

| Guard                              | Policy | Where                                                         | On refusal                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency cap and memory floor   | B8     | `GET /api/workers/:id/jobs/next`, right after the kill switch | `204` with `x-forge-lease-refused: max-agents (4/4)` or `min-free-memory (<free> MB < <floor> MB)`; the worker keeps polling and is handed work when a slot or the memory frees. Logged at `warn` at most once a minute.                                                                                                            |
| Daily ceiling, before a cloud call | B2, B3 | `dispatchWorkerProvider`, before any job is created           | The run is paused, `run.paused_by_guard` is recorded with an active `safety_constraint` blocker, and the pipeline stops within seconds (see below). The last line: routing projects the same estimate first (ADR-028), so this fires only for a call routing did not see or a day that moved between the decision and the dispatch. |
| Daily ceiling, at run start        | B2, B3 | `POST /api/runs/:id/start`, including a resume                | `409 {"error":"spend_ceiling","message":...}`; the run is paused (or stays paused) with the same event and blocker. Only a day already at or over the ceiling is refused; below it a run starts even when its first stage is projected to cross, and that stage is then routed (ADR-028).                                           |
| Per-task bounds                    | -      | worker, on every provider event                               | The provider is aborted, a non-retryable `TASK_LIMIT` error is the job's first error event, the job completes as failed, and the coordinator records `guard.task_limit` on the run.                                                                                                                                                 |

The agent count is the number of leased provider jobs: each worker runs one job at a time and only a provider job starts an agent. Free memory is `os.freemem()` on the coordinator host. That is the right reading because the coordinator and the worker share this machine (the budget is worked out in `packages/guardrails/src/limits.ts`); a worker on another host would have to report its own figure, and none does yet.

The ceiling is checked _before_ a call with a per-role estimate from the F031 run (`ROLE_ESTIMATES_USD` in `@theforge/guardrails`: planner $0.70, critic $0.25, builder $1.25, reviewer $0.40 - the same table `routeRole` projects with, ADR-028), so one expensive builder call cannot carry the day past the limit; the recorded usage, not the estimate, is what goes into the day total. Codex reports `usd: 0` for every call (F111), so the ceiling cannot see Codex spend: it is treated as $0 and flagged in the log once a day, but it is still refused once the day is over the ceiling, because policy B3 routes to _local_ models then and Codex is not local. The coordinator keeps the day total in memory, fed from the same place usage records are materialised (live and on boot replay, idempotent by record id), so every check is O(1).

**Per-run budget.** `POST /api/runs` defaults `maxUsd` to 5 and `maxTokens` to 100000 (ADR-024; the web form starts from the same values), and the pipeline fails the run with `Run budget exceeded` the moment a usage record takes it past either. A caller may pass a higher `maxUsd` explicitly; the daily ceiling, not the run budget, is what bounds the day. Codex calls are recorded at $0 and so never consume the run's dollar budget either - the digest's `unmetered` line is where they show.

**Events.** `spend.warn {dayUsd, ceilingUsd, fraction, day, timeZone}` once per local day on crossing `FORGE_CEILING_WARN_FRACTION`; `spend.ceiling {dayUsd, ceilingUsd, day, timeZone, routing: "local-only"}` once per local day on the first refusal; `run.paused_by_guard {guard: "spend", role, reason, dayUsd, ceilingUsd, day, timeZone, classification: "safety_constraint", resumeHint}` on every refusal; `guard.task_limit {jobId, workerId, role, providerId, reason, usage: {toolCalls, tokens, elapsedMinutes}}` on a limit-tripped completion. A coordinator restart on a day that is already past the warning fraction may repeat that day's `spend.warn` once. Notification (policy B11) keys on these; this section only records that they exist.

**The knobs.** Coordinator: `FORGE_DAILY_CEILING_USD` (default 20; `0` means no cloud calls at all), `FORGE_CEILING_WARN_FRACTION` (0.75), `FORGE_MAX_AGENTS` (4), `FORGE_MIN_FREE_MEMORY_MB` (3072), `FORGE_TIMEZONE` (`Australia/Sydney`, must be an IANA zone or the coordinator refuses to start). Worker: `FORGE_TASK_MAX_TOOL_CALLS` (200), `FORGE_TASK_MAX_MINUTES` (30), `FORGE_TASK_MAX_TOKENS` (150000). Ranges are listed in `.env.example`. Under `NODE_ENV=test` the memory floor defaults to `0` so hosted 7 GB runners do not refuse every lease; `apps/coordinator/src/guards.lease.test.ts` sets it explicitly to prove the refusal. The coordinator logs the ceiling state and every knob at startup.

**The adaptive monthly budget (ADR-037).** Set `FORGE_MONTHLY_BUDGET_USD` (the credit allowance per period, e.g. `200`) and `FORGE_DAILY_CEILING_USD` stops being the cap and becomes its floor. Each local day's cap is `min( max(floor, remaining / daysLeft), FORGE_MAX_DAILY_CEILING_USD, remaining )`, where `remaining` is the allowance minus everything spent in the period _before_ that day and `daysLeft` counts the day itself. An unspent day therefore raises every later day's cap a little, a heavy day lowers them, and the last days of a period converge on spending what is left, held at `FORGE_MAX_DAILY_CEILING_USD` (default 50) so a runaway loop is still caught the day it starts. Today's spend never moves today's cap, so a day cannot starve itself. `FORGE_BUDGET_RESET_DAY` (1-28, default 1) is the day of the month a fresh allowance arrives; unspent credit is lost at the reset, which is the point of the feature. `FORGE_BUDGET_COUNT_FROM` (ISO date or timestamp) leaves out usage recorded before it, for spend that was never billed to the allowance. Leave `FORGE_MONTHLY_BUDGET_USD` out and the flat ceiling behaves exactly as before. The startup line shows `dailyCeilingUsd` (today's cap), `baseDailyCeilingUsd` (the floor), the period, what it has spent and what is left; the digest prints the same cap in its `today` line plus a `monthly budget` line. Everything downstream (the run-start gate, the dispatch guard, `routeRole`'s projected-crossing demotion, `spend.warn` and `spend.ceiling`) reads the effective cap, so ADR-022 and ADR-028 apply to it unchanged: when it is reached the planner and critic go to the local model and the builder and reviewer stop the run. The cap is computed from the monthly allowance only; it never buys credits (policy B1 is untouched), and once the allowance is spent the cap is `0` and everything routes local until the period resets.

**What a run paused by a guard looks like.** `GET /api/runs/:id` shows `run.state: "paused"` with `resumeState` set to the state it was in (`executing`, or `created` when refused at start). The event log ends `... usage.recorded, spend.warn, plan.completed, spend.ceiling, run.pause, run.paused_by_guard, run.execution_stopped {state: "paused"}` - never `run.failed`, and never a `worker_job.queued` for the refused call, because no job is created. `blockers` holds an active `safety_constraint` entry on the role's task whose `summary` is the reason (`daily cloud ceiling of $20.00 reached ($25.00 spent on 2026-09-25 Australia/Sydney); routing to local models only`) and whose `smallestUnblockAction` is the resume hint. The worktree is left intact for inspection, exactly as after a manual pause.

**How to resume.** Do one of: raise `FORGE_DAILY_CEILING_USD` in `.env` and restart the coordinator; wait for the next local day; or reconfigure the run's provider roles to local models. Then:

```bash
curl -sS -X POST http://127.0.0.1:4400/api/runs/<id>/control \
  -H "authorization: Bearer $FORGE_COORDINATOR_TOKEN" \
  -H 'content-type: application/json' --data '{"action":"resume"}'
```

Resume goes through `POST /api/runs/:id/start`, which runs the same ceiling check. If the day is still over the ceiling the run stays paused, gains another `run.paused_by_guard`, and the control request records `run.restart_failed` with the `409 spend_ceiling` body, so a resume that did not take is visible in the same event log. The run picks up from its checkpoint (`plan.completed`, `critique.completed`, `plan.revised`, `build.completed`), so paid work already done is not repeated. The guard blocker stays `active` until the run reaches `integration.pull_request_created`, as every blocker does.

**Per-task limits, from the worker's side.** The worker tallies `tool_request` events, adds the tokens of every `usage` event, and re-reads the wall clock on every event; the wall-clock bound also has a timer so a provider that goes quiet is still stopped. Tripping a limit pushes the `TASK_LIMIT` event first and then aborts the provider (the container is stopped through the job's abort signal), so the run fails for the limit, not for the provider's own "cancelled". A builder that trips a limit does not have its partial patch transported.

## Escalation and notifications

Policy B9 says Dan is reached through **both** Home Assistant push and email; B11 says when. `@theforge/notify` implements the channels, and the coordinator hooks it on `publishEvent`, the one place every event passes, fire-and-forget with its own logging so a broken channel can never fail a run.

**What triggers a notification.** `apps/coordinator/src/escalation.ts` (`classify`) is the whole policy:

| Trigger (B11)              | Events                                                                                                                                                                                                                           | Kind                                                                       | Severity      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------- |
| Security issue             | `review.completed` with a finding of severity `high`/`critical`; `integration.blocked` with classification `safety_constraint`                                                                                                   | `security.finding`, `security.integration_blocked`                         | warn/critical |
| CI failure on touched work | `verification.completed` with `passed: false`; `run.failed`; `integration.failed`; any `<phase>.worker_job_finished` with a non-zero `code`                                                                                      | `ci.failed`, `run.failed`, `ci.integration_failed`, `ci.worker_job_failed` | warn/critical |
| Decision needed            | `approval.requested`; `integration.blocked` with classification `missing_access`                                                                                                                                                 | `decision.approval`, `decision.missing_access`                             | warn          |
| Spend ceiling (B2/B3)      | `spend.warn`, `spend.ceiling` (emitted by the spend guard)                                                                                                                                                                       | `spend.warn`, `spend.ceiling`                                              | warn/critical |
| Guards                     | `guard.task_limit`, `run.paused_by_guard`                                                                                                                                                                                        | `guard.task_limit`, `run.paused`                                           | warn          |
| Tier 0 merges              | Tier 0 runs outside the coordinator; its outcomes file is ingested with `pnpm forge tier0-ingest` (below)                                                                                                                        | `tier0.merge`, `tier0.escalate`, `tier0.deferred`                          | info/warn     |
| CI failure after the fact  | `pnpm forge ci-watch` (ADR-026, "CI watch" below): a failed workflow run on the default branch after a Tier 0 merge; failed checks on an open `forge/*` pull request                                                             | `ci.post_merge_failed`, `ci.system_pr_failed`                              | warn          |
| Tailnet node returns       | `pnpm forge node-watch` (ADR-031, "Tailnet node watch" below): a watched node answers again after being offline, or one appears that was never recorded; the ordinary offline direction is `info`, so it never reaches the phone | `node.back_online`, `node.appeared`, `node.went_offline`                   | warn/info     |

Every message has the same shape, written to be read on a phone: title, severity and local time (Australia/Sydney), what happened, the options with the consequence of each, a recommendation, the evidence references, and whether anything is paused waiting on the answer.

**`FORGE_HA_NOTIFY_SERVICE` is a device name, and it changes (BLK-022).** A `mobile_app` notify service is named after the device that registered it, so renaming, replacing or re-pairing the phone renames the service and every push stops. On 27/09/2026 `mobile_app_phone` had silently become `mobile_app_phone_2`. The symptom is indistinguishable from a bad token if you only read the status code: Home Assistant answers **400** for a service that does not exist and **401/403** for a token, so a 400 with a working token means the name. `HaPushChannel` now does that reasoning for you — on a 400 it reads `/api/services` and names the notify services that do exist, or says the service exists and the body was rejected. To check by hand:

```bash
curl -s -H "Authorization: Bearer $FORGE_HA_TOKEN" "$FORGE_HA_URL/api/services" \
  | python -c "import sys,json; [print('notify.'+n) for d in json.load(sys.stdin) if d.get('domain')=='notify' for n in sorted(d['services'])]"
```

The default in `NOTIFY_DEFAULTS.haService` names one particular device and will be wrong on any other install; set the variable rather than relying on it.

**Where each severity goes (ADR-023).** Severity decides the channels; the table is `packages/notify/src/routing.ts` and the Notifier applies it on every send:

| Severity   | Phone (Home Assistant push) | Email | File outbox |
| ---------- | --------------------------- | ----- | ----------- |
| `critical` | yes                         | yes   | yes         |
| `warn`     | yes                         | yes   | yes         |
| `info`     | no                          | yes   | yes         |

`info` is the routine traffic - Tier 0 merges and deferrals, the daily digests, notices that nothing is waiting on - so a push notification always means something that may need your hand. The file outbox receives everything. A channel left out by routing is reported as `skipped (severity routing)`, never as failed: it does not affect the exit code, it does not count as a delivery for dedupe, and the coordinator records it as a `skipped` row in `notifications`, so the digest's per-channel counts show it. A coalesced summary is routed by the worst severity it holds, so one warn inside a burst of info still reaches the phone.

Nothing bypasses Do Not Disturb: the Home Assistant body carries `tag` and `group` only, never `importance`, `priority`, `ttl` or `channel: alarm_stream`, whatever the severity. A critical on a silenced phone waits like any other notification; the email and the outbox carry the full text.

**Dedupe, coalescing, retry.** The same dedupe key inside 6 hours is one message; the index is in memory and in `<outbox>/dedupe-index.json`, so a coordinator restart does not re-send. Identical kind and run inside 5 minutes collapse: the first goes out at once, the rest are held and one summary with a count follows when the window closes. Each channel gets three attempts with backoff, independently; the report (and the log line) says which channels succeeded.

**Where the outbox is.** `FORGE_OUTBOX_DIR` when set; otherwise `<absolute FORGE_WORKSPACE_ROOT>/../outbox`, which with the default workspace root is `<working directory>/.forge/outbox`. Every escalation lands there as `<yyyymmdd local>/<timestamp>-<kind>-<key>.md` and `.json` whether or not the push or the email went out. It is the evidence trail and the only channel that works before the secrets exist.

**The two manual secrets.** Neither exists until Dan creates it; the code is complete and tested against fakes, and degrades to the file outbox alone while they are absent.

1. `FORGE_HA_TOKEN`: Home Assistant, profile, Long-lived access tokens, create. Set `FORGE_HA_URL` to the base the proxy serves (`http://192.168.1.10/ha`); the service defaults to `mobile_app_phone`.
2. `FORGE_SMTP_PASSWORD`: Google account, Security, App passwords, create one for "TheForge". Set `FORGE_SMTP_USER` to the sending Gmail address. Port 465 implicit TLS, `AUTH PLAIN`; the client is `packages/notify/src/smtp.ts`, no third-party mailer.

Both are added to the coordinator's redaction list, so they never appear in events, logs, outbox files or thrown errors.

**Proving the secrets.** From the repository root (this loads `.env`):

```powershell
pnpm forge notify-test                    # every configured channel at warn; says which it skipped and why
pnpm forge notify-test --channel=ha       # a phone push at warn, no critical needed; refuses with the missing variable names until FORGE_HA_URL and FORGE_HA_TOKEN exist
pnpm forge notify-test --channel=email    # likewise for FORGE_SMTP_USER and FORGE_SMTP_PASSWORD
pnpm forge notify-test --channel=file
pnpm forge notify-test --severity=info    # every configured channel, phone skipped by routing
pnpm forge notify-test --channel=ha --severity=critical
```

It sends one clearly labelled test escalation (`notify.test`, unique key per run, so dedupe never swallows it) at the given `--severity` (`info`, `warn` or `critical`; default `warn`, the lowest severity that reaches the phone), prints the routing as it applies to the channels this run has, one line per severity, and then the report:

```
channels: file, ha, email
routing: info -> file, email (skipped: ha)
routing: warn -> file, ha, email
routing: critical -> file, ha, email
severity: warn
subject: Forge warning: Test notification from TheForge (all, warn)
result: file sent (attempt 1) · ha sent (attempt 1) · email sent (attempt 1)
```

With `--severity=info` the last line reads `ha skipped (severity routing)` and no HTTP call is made. Exit 0 means every routed channel delivered (a skipped channel is not a failure); 1 means a channel failed after three attempts and the line says why; 2 means the command refused: the channel is not configured, the flag is wrong, or the combination could never send (`--channel=ha --severity=info`).

**Tier 0 outcomes.** `pnpm tier0 <owner/repo> [--execute] [--json=path]` now loads `.env`, and every run writes its outcomes as a JSON array - to `--json=<path>` when given, otherwise to `<outbox>/tier0/<timestamp>.json` - and prints the path. Immediately before `gh pr merge` it re-reads `mergeable`/`mergeStateStatus`; if the base moved since the checks ran it posts `@dependabot rebase` (trusted automated authors only) and records `deferred` instead of failing the merge. Escalations carry a `hint` saying a rebase may resolve them. Then:

```powershell
pnpm forge tier0-ingest .forge/outbox/tier0/<timestamp>.json
```

turns each merge (`tier0.merge`, info), escalation (`tier0.escalate`, warn) and deferral (`tier0.deferred`, info) into a notification through the same channels - so merges and deferrals reach email and the outbox, and only an escalation reaches the phone (ADR-023) - deduplicated on repository, number and head SHA, so re-ingesting a file or re-running Tier 0 against an unchanged head says nothing twice. Skips, verify-only outcomes and a dry run's would-merge are reported as "nothing to notify".

## Kill switch: verified behaviour

Everything in this section was proven by `tests/halt.integration.test.ts` (F116, checklist S4.5) against real processes, not an injected app: a coordinator from `apps/coordinator/dist`, the fixture worker from `tests/fixtures/release-worker.mjs`, and the halt file written and removed by the real CLI (`node --import tsx packages/cli/src/main.ts`, which is what `pnpm forge` runs, minus the `.env` load). The file runs in its own PostgreSQL schema with `FORGE_HALT_FILE` pointing into a temporary directory, `FORGE_JOB_LEASE_MS=6000` and the same notes fixture as release-acceptance, and it is part of `pnpm test` because vitest's `include` already covers `tests/**/*.test.ts`. The unit tests in `apps/coordinator/src/server.test.ts` remain the proof of the API's shape; this is the proof of the operator's procedure.

**A halt does:**

- **Refuse every new lease at once.** With the critic job queued and a worker polling every 100 ms, every poll in a 3 s window was answered `204` with `x-forge-halted: file` (the fixture records each one under `FORGE_FAKE_POLL_LOG=1`); the job stayed `queued` and nothing was `leased`.
- **Survive a coordinator restart.** With the file still present the coordinator was SIGKILLed and restarted on a fresh port. Its startup log was the warn-level `Halt file present at <path>; no work will be leased until it is removed`, carrying the parsed CLI request; `GET /api/halt` still answered `halted: true, source: "file", request: {requestedBy: "cli", reason: "e2e"}`; and a freshly started worker was refused for another 3 s window. The restarted coordinator resumed the run from its event checkpoint and asked for the critic again, and the idempotency key handed back the same queued job rather than a duplicate: exactly two jobs existed, the completed planner and the queued critic.
- **Treat a file made by hand exactly the same.** An empty file written with `fs.writeFile` gave `halted: true, source: "file"` with no `request`; `pnpm forge status` printed `halted: yes`, "made by hand", `coordinator halted: yes (source: file)` and the same path with no mismatch warning; the worker's polls were refused the same way; `DELETE /api/halt` (bearer token, no body) removed it and answered `halted: false`.
- **End the moment the file goes.** After `pnpm forge resume` returned, the next poll leased the queued critic within a fraction of a second (measured 156-166 ms across runs, against the fixture's 100 ms poll interval). Nothing else needs restarting.
- **Name its file where an operator can see it.** The coordinator's startup log carries `Kill switch file: <path>` (`fields.haltFile`), and the CLI prints the same absolute path on `halt`, `resume` and `status`.

**A halt does not:**

- **Kill in-flight work.** The planner job, leased before the halt, was held mid-execution while the file was written; on release its `POST .../complete` was accepted (the fixture records `completedJobId` only on a 2xx), the pipeline emitted `plan.completed` and queued the critic. The same held for the critic under the hand-made halt.
- **Fail, pause or cancel the run.** Through both halts and the restart the run stayed `executing`; `run.failed` and `run.execution_stopped` never appeared.
- **Touch the worktree.** `<FORGE_WORKSPACE_ROOT>/worktrees/<run>-implementation` existed with its files throughout, and both coordinators' `workspace.ready` events named the same directory: the restart reused it rather than recreating it.
- **Change the outcome.** Once cleared, the run finished `partially_completed` at the pending push approval with the counts release-acceptance asserts of an unhalted run: `spent {usd: 0, tokens: 25}`, six jobs all `completed` with unique ids (planner by worker A, critic by worker B), six attempts, five usage records, at least nine messages, the notes files byte-identical to the accepted patch, a clean `git status`, and the fixture's `node --test` green inside the worktree.

**Superseded: this describes the wait before it became halt-aware; see "The halt-aware wait and `FORGE_WORKER_JOB_WAIT_MS`" below, which is current.** Originally, read from the code and not yet proven by a test: a job that is queued when the halt lands is still inside the pipeline's 900 s wait (`waitForWorkerJob`, `apps/coordinator/src/server.ts`; the same bound as the provider wait in `packages/workflows/src/index.ts`). That wait does not pause for a halt: if the file is still present when it expires, the job is cancelled and the run fails with `Worker job … timed out waiting for a compatible worker`. So a halt shorter than 15 minutes is invisible to the run, and a longer one fails every run that had work queued, which is then a normal `run.failed` escalation. Removing the file within 15 minutes, or accepting that failure and restarting the run afterwards, is the operator's choice; a halt-aware deadline is a follow-up, not something this test hides.

**Evidence.** `pnpm exec vitest run tests/halt.integration.test.ts`, 2026-09-26, three consecutive runs green: 19.6 s, 19.0 s and 19.2 s for the whole sequence, restart included; lease resumed 166, 153 and 157 ms after `forge resume`. `pnpm test` with the file running in parallel with release-acceptance and worker-loss: 35 files, 289 passed, 0 failed, 0 skipped. Teardown line each time: `public rows … (unchanged)`.

## Daily digests

Policy B12: two digests a day, at 05:00 and 17:30 Australia/Sydney, so Dan reads what happened overnight before the day starts and what happened during the day before the evening. `pnpm forge digest` builds one from the database directly (the coordinator can be down), the Tier 0 outcome files in the outbox, the halt file and, when `FORGE_API_URL` and `FORGE_COORDINATOR_TOKEN` are set, the coordinator's `/health`; it writes nothing to the database.

**What a digest contains.** One Markdown report (for email and the outbox) with a compact head - title plus six lines, plus a reminders line when there are reminders and a week line on a Monday - that opens the message, so the first screen answers "anything for me?" before the sections:

- your own reminders, first, from the reminders file (below); no file, no section;
- finished runs in the window (completed, partially completed, failed, cancelled) with project, spend and objective; a run counts in the window in which it reached its final state;
- active runs (executing, reviewing, paused and so on) with age and last change; runs still `created` that were never started are counted, not listed;
- blocked runs and every active blocker with its `smallestUnblockAction`;
- failures and retries: attempts that failed or expired in the window, `attempt.lease_expired`, `worker_job.lease_reconciled` and `run.restart_failed` events;
- spend in the window by provider, the local day's total against `FORGE_DAILY_CEILING_USD` (ok / warn / exceeded, `FORGE_TIMEZONE` days), and calls recorded at $0, which the digest labels for what they are - `codex 3 calls (subscription)`, `ollama 2 calls (local)` - followed by `$0, not counted against the ceiling`, so nobody reads a Codex line as a saving or a gap (ADR-025);
- escalations recorded in the `notifications` table in the window: per kind, per channel, per status, and every row still pending or failed;
- guard events: `spend.warn`, `spend.ceiling`, `run.paused_by_guard`, `guard.task_limit`;
- decisions waiting on Dan: pending approvals with their expiry, and active blockers classified `product_decision`, `missing_access` or `safety_constraint`;
- Tier 0 outcomes from the `<outbox>/tier0/*.json` files written in the window: merged, deferred and escalated PRs by number;
- a routing line. `routingSavings()` exists in `packages/guardrails` but nothing produces a `RouteDecision` yet, so the line says `not yet wired` and gives the cloud and unmetered call counts rather than a saving;
- on a Monday morning (or with `--weekly`), a week in review (below);
- a health footer: coordinator reachable (or `not checked` without the token), halt file present or absent.

**Reminders.** `FORGE_REMINDERS_FILE` names a plain text file; unset, it is `<outbox>/reminders.md` beside the escalation folders. Edit it by hand: one reminder per non-empty line, `#` starts a comment, and a line that begins with a date and a space - `2026-10-04 Daylight saving starts; check the 05:00 digest still arrives at 05:00` - is shown from that local day on and hidden until then. Undated lines always show. Every due line goes into the email under "Reminders", followed by a count of the lines still dated for later; the compact head carries the first three and `+N more`. No file means no section and nothing on stderr; a file that exists but cannot be read (a folder in its place, say) is one `could not read` line inside the section and the digest still goes out. The file is read on every digest and never written, and it is not deduplicated: a reminder shows on every digest until you remove it. It lands in the email and on the phone verbatim, so keep secrets out of it.

**Week in review.** When the `morning` digest's local date is a Monday, or whenever `--weekly` is given, a "Week in review" section covers the seven local days before the digest's day (for the Monday 05:00 run that is the previous Monday 00:00 to Sunday 24:00, daylight saving included): cloud spend in USD by provider; unmetered calls by provider, counted separately and labelled `$0, not counted against the ceiling`; runs finished by state; Tier 0 merged / deferred / escalated from the outcome files timestamped inside the seven days; and the local days on which the ceiling was reached, read from the `spend.ceiling` events (the coordinator emits one per day the first time it refuses a cloud call, so a day that went over while the coordinator was down is not listed). It sits after the routing line and before the health footer, with one `week to <date>:` line at the end of the compact head. With `--weekly` outside a Monday morning the heading says `(asked for with --weekly)` and the seven days end on the day before the digest's - a Wednesday review covers the previous Wednesday to Tuesday.

**Windows.** `morning` is the previous local day 17:30 -> now, `evening` is today 05:00 -> now (yesterday's 05:00 when run before 05:00), so the two scheduled runs cover the day between them with no gap; a run finished at 17:29 is in the evening digest, one finished at 17:31 in the next morning's. `now` is the last twelve hours; `--since=<iso>` is any start you like. The window and the local day are computed in `FORGE_TIMEZONE` (default `Australia/Sydney`), daylight saving included. Without `--window`, the digest that is due is chosen: `morning` before noon local, `evening` after.

**Running one by hand.** From the repository root (this loads `.env`):

```powershell
pnpm forge digest --now --dry-run            # last 12 h, printed, nothing sent
pnpm forge digest --window=morning --dry-run # what the 05:00 run would send
pnpm forge digest --window=evening           # send it on every configured channel
pnpm forge digest --since=2026-09-20T00:00:00Z --json   # the data model, one JSON document
pnpm forge digest --channel=file             # file outbox only (email, file or all; ha is refused)
pnpm forge digest --weekly --dry-run         # the week in review on any day, printed, nothing sent
```

It is delivered as one escalation of kind `digest` (severity info, nothing paused) through the same Notifier as everything else, so severity routing (ADR-023) lands it on email and the file outbox (`<outbox>/<yyyymmdd>/<timestamp>-digest-digest-<window>-<date>.md` and `.json`) and never on the phone: with Home Assistant configured the report reads `ha skipped (severity routing)` and no call is made, and `--channel=ha` is refused with exit 2 rather than honoured. `--dry-run` says the same (`ha would be skipped`) and its `--json` carries `channels` (routed) and `skipped`. The dedupe key is `digest:<window>:<local date>`: one morning and one evening per day, so re-running the same digest inside six hours reports `duplicate` and sends nothing; `--now` and `--since` carry the time in the key and are never deduplicated against a scheduled one. `--dry-run` prints the report and the compact head and touches neither the outbox nor the dedupe index. Exit 0 sent (or dry run), 1 a channel failed or the database could not be read, 2 usage or configuration (a named channel whose variables are missing refuses, as `notify-test` does).

**Scheduling.** Two Task Scheduler jobs, registered by an operator and never by the code:

```powershell
pwsh -NoProfile -File scripts/register-digests.ps1 -WhatIf   # shows both registrations, changes nothing
pwsh -NoProfile -File scripts/register-digests.ps1           # "TheForge Digest Morning" 05:00, "TheForge Digest Evening" 17:30, under \TheForge\
pwsh -NoProfile -File scripts/register-digests.ps1 -Unregister
```

Each task runs `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-digest.ps1 <window>` from this checkout as the current user, daily at the machine's local time (AUS Eastern Standard Time; Windows applies daylight saving, which is the same day the digest computes in). A run missed because the machine was asleep starts when it wakes; a run is limited to 15 minutes. By default the tasks use the interactive logon type and run only while the user is logged on; `-RunWhenLoggedOff` registers them with the S4U logon type instead, which runs them whether the user is logged on or not without storing a password (an S4U task has no network credentials, which the digest does not need). Storing a password for the classic "run whether user is logged on or not" is a manual `Register-ScheduledTask -User -Password` and is left to the operator. `scripts/run-digest.ps1` changes to the repository root, runs `corepack pnpm forge digest --window=<window>`, appends everything it prints to `C:\forge\logs\digest-<yyyyMMdd>.log` (`FORGE_DIGEST_LOG_DIR` or `-LogDir` to move it; the folder is created) and exits with the command's exit code, which Task Scheduler records as the last run result. `pwsh -NoProfile -File scripts/run-digest.ps1 now -DryRun -LogDir $env:TEMP` proves the wiring without sending or writing outside the temp folder. Nothing is registered until Stage 4 is proven end to end; the acceptance criterion for F115 is two scheduled digests arriving on consecutive days with the right content.

## CI watch

Policy B11's "CI failure on touched work" for the work the coordinator has let go of (ADR-026): the workflow run GitHub starts on the default branch after a Tier 0 merge, and the checks on a pull request the pipeline opened. `pnpm forge ci-watch` reads the Tier 0 outcome files, asks GitHub through the `gh` CLI (the operator's own login; no token is handled), and sends one **warn** escalation per failure with the run link, through the same channels as everything else.

**What it checks.**

- Every executed merge in `<outbox>/tier0/*.json` written in the last `--hours` (default 48). Tier 0 now records the merge commit as `mergeSha` (`gh pr view --json mergeCommit` right after `gh pr merge`); for an older file, or when that lookup failed, `ci-watch` asks GitHub for it and asks again next run if there is no answer yet. Then `gh run list -R <repo> --commit <sha>`: a completed run with conclusion `failure`, `timed_out` or `startup_failure` is a failure (`ci.post_merge_failed`, "CI failed on shopfront main after Tier 0 merge of #123"); queued, in progress or `action_required` is left for next time; `cancelled`, `skipped`, `neutral` and `stale` are not failures; all done and none failed is a success. Runs GitHub starts on its own behalf (`event: dynamic`: the Dependabot Updates job, CodeQL default setup) are ignored, since they are not the repository's CI. No run at all six hours after the merge is recorded as none, so a repository without CI stops being asked about.
- Every open pull request whose head branch starts with `forge/` on the merge allowlist, on every repository seen in those outcome files, and on any `--repo=owner/name,...`. That prefix is the marker the pipeline sets in code (`apps/coordinator/src/server.ts`, the workflow's `input.branch`); no label is applied and the PR bodies differ, so nothing else is trusted. `gh pr list --json statusCheckRollup` gives the checks: a check run that completed with `FAILURE`, `TIMED_OUT` or `STARTUP_FAILURE`, or a commit status `FAILURE`/`ERROR`, is a failure (`ci.system_pr_failed`, "CI failed on shopfront PR #45 opened by TheForge"); pending checks wait; no checks six hours after the PR's last update is recorded as none. A new push is a new head and is watched afresh.

**Dedupe and state.** The dedupe keys are `ci-watch:merge:<repo>@<merge sha>` and `ci-watch:pr:<repo>#<number>@<head sha>`. Beyond the notifier's six-hour window, `<outbox>/ci-watch/state.json` remembers every commit and head already decided (`success`, `failure` with the run URL and whether the message went out, or `none`), so repeated runs neither query nor escalate them again; markers older than 30 days are dropped. It also keeps the merge commit learned for an outcomes file that predates `mergeSha`, so that lookup happens once rather than every half hour. Delete the file to start over: the worst case is one repeated message per key, which the notifier's own dedupe still catches inside six hours.

**Running one by hand.** From the repository root (this loads `.env`; `gh auth status` must be signed in):

```powershell
pnpm forge ci-watch --dry-run                    # what would be escalated; writes nothing
pnpm forge ci-watch                              # send, record, print one line per merge and PR
pnpm forge ci-watch --hours=6                    # only merges from the last six hours
pnpm forge ci-watch --repo=example-org/other   # also sweep another repository's forge/* PRs
pnpm forge ci-watch --json                       # the whole report as one JSON document
```

Output is one line per merge commit and per system PR (`FAILED (...) -> ci.post_merge_failed -> file sent (attempt 1)`, `success (2 run(s)), recorded`, `pending (1 of 2 still going)`, `already decided` is counted, not listed) and a summary line. `--dry-run` says `would send <kind>` and touches neither the state file nor the outbox. Exit 0 when every check was read and every message sent (or dry run), 1 when a `gh` call or a channel failed (the rest is still processed and recorded), 2 for a bad flag.

**Scheduling.** One Task Scheduler job every 30 minutes, registered by an operator and never by the code, after the Tier 0 task rather than instead of it:

```powershell
pwsh -NoProfile -File scripts/register-ci-watch.ps1 -WhatIf   # shows the registration, changes nothing
pwsh -NoProfile -File scripts/register-ci-watch.ps1           # "TheForge CI Watch" under \TheForge\, every 30 min from the next half hour
pwsh -NoProfile -File scripts/register-ci-watch.ps1 -RunWhenLoggedOff
pwsh -NoProfile -File scripts/register-ci-watch.ps1 -Unregister
```

The task runs `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-ci-watch.ps1` from this checkout as the current user, with the same principal options as the digests: interactive logon by default, `-RunWhenLoggedOff` for S4U (no password stored; the watch needs no network credentials of its own, since `gh` keeps its login in the user's keyring), `-IntervalMinutes` to change the cadence. A missed run starts when the machine wakes; a run is limited to 10 minutes; a run still going when the next is due is left alone. `scripts/run-ci-watch.ps1` changes to the repository root, checks that `corepack` and `gh` are on the task user's PATH (and says which is missing in the log if not), runs `corepack pnpm forge ci-watch --hours=<Hours>`, appends everything it prints to `C:\forge\logs\ci-watch-<yyyyMMdd>.log` (`FORGE_CI_WATCH_LOG_DIR`, then `FORGE_DIGEST_LOG_DIR`, or `-LogDir` to move it) and exits with the command's exit code. `pwsh -NoProfile -File scripts/run-ci-watch.ps1 -DryRun -LogDir $env:TEMP` proves the wiring without sending or writing outside the temp folder.

## Tailnet node watch

A watched Tailscale node coming back online, going offline, or appearing for the first time (ADR-031). `noded` had been offline for 98 days on 27/09/2026 and `nodec` is meant to stay off until a later stage; a node like that waking up is the thing this exists to catch, and the same check notices a Pi that has dropped off. `pnpm forge node-watch` reads `tailscale status --json` once, compares it with a state file under the outbox, and escalates through the same channels as everything else. It is a sibling of the CI watch above: same flags, same state-file conventions, same exit codes.

**Severity, and why.**

| Transition                   | Kind                | Severity | Reaches                   |
| ---------------------------- | ------------------- | -------- | ------------------------- |
| offline → online             | `node.back_online`  | warn     | phone, email, outbox      |
| not in the state file at all | `node.appeared`     | warn     | phone, email, outbox      |
| online → offline             | `node.went_offline` | info     | email and the outbox only |

A node answering when you believe it is off is the surprising direction and the one worth a push (ADR-023 routes warn to the phone); a node dropping off is the ordinary one — a reboot, a power cut, a closed lid — so it is an info that shows up in email and in the digest without waking anyone. An unknown node joining is a warn because it can reach whatever the ACLs allow.

**Which nodes.** `FORGE_WATCH_NODES` is a comma-separated list of short names (the first label of the node's DNS name: `noded`, not `noded.example.ts.net`), and `--node=<name>` overrides it — repeatable, and comma-separated too. **With neither set, every node on the tailnet is watched**, not none: a machine appearing that you did not expect is half the point, and no watch list can name it in advance. To narrow it, set `FORGE_WATCH_NODES=noded,nodec` in `.env` or pass `-Node noded,nodec` to the runner script. Nodes outside the watch set are still recorded in the state file, so narrowing now and widening later does not announce nodes that were already there. A watched name that is not on the tailnet at all is printed (`watched but not on the tailnet: backupnode`) and nothing is escalated for it.

**What it reads.** One `tailscale status --json`, covering `Self` as well as every peer: the short name, `Online`, `OS`, `Tags`, the first `TailscaleIPs` entry, `LastSeen`, and whether `sshHostKeys` is present (which is how the status says Tailscale SSH is enabled). The escalation carries all of it plus how long the node had been offline, because that is what is useful on a phone. `LastSeen` is `0001-01-01T00:00:00Z` for a node tailscale has no reading for, including every online node; that is read as "no idea", never as a duration. If `tailscale` is not on PATH — which is normal for a scheduled task — `C:\Program Files\Tailscale\tailscale.exe` is used instead. A non-zero exit that is not "no such program" (tailscaled stopped, not logged in) is an error and exits 1; it is never retried against another path.

**State and the first run.** `<outbox>/node-watch/state.json` holds one marker per node: online, when it was observed, OS, SSH, tags, IP and `LastSeen`. Because "not in the state file" is a warn, **the first run seeds the file and escalates nothing**, printing `first run: 10 node(s) recorded, nothing escalated`; a state file that cannot be parsed is reported as a warning and treated the same way, so a corrupt file costs one silent reseed rather than a warn per node. A node the status stops listing keeps its marker with a `missingSince` stamp and is dropped after 30 days — removing a node from a tailnet is deliberate, so it is remembered, not reported. Dedupe keys (`node-watch:online:<name>@<last seen>`, `node-watch:offline:<name>@<last seen>`, `node-watch:new:<name>`) come from the tailscale data rather than the clock, so deleting the state file costs at most one repeated message per key inside the notifier's six-hour window. Two nodes returning in the same run coalesce like any two escalations of one kind: the first is sent, the second arrives in the five-minute summary, both named.

**Running one by hand.** From the repository root (this loads `.env`):

```powershell
pnpm forge node-watch --dry-run                  # what would be escalated; sends and writes nothing
pnpm forge node-watch                            # escalate, record, print one line per changed node
pnpm forge node-watch --node=noded --node=nodec # only those two, whatever FORGE_WATCH_NODES says
pnpm forge node-watch --json                     # the whole report as one JSON document
```

Output is the outbox, the state file, the tailscale binary that answered with the node and watch counts, then one line per changed node (`noded: BACK ONLINE after 98 days -> node.back_online -> file sent (attempt 1)`, `nodeb: went offline -> node.went_offline -> ...`, `nodea: NEW node (offline) -> node.appeared -> ...`; unchanged nodes are counted, not listed) and a summary line. Exit 0 when every change was read and every message sent (or dry run), 1 when the tailscale call or a channel failed, 2 for a bad flag.

**Scheduling.** One Task Scheduler job every 15 minutes, registered by an operator and never by the code:

```powershell
pwsh -NoProfile -File scripts/register-node-watch.ps1 -WhatIf   # shows the registration, changes nothing
pwsh -NoProfile -File scripts/register-node-watch.ps1           # "TheForge Node Watch" under \TheForge\, every 15 min from the next quarter hour
pwsh -NoProfile -File scripts/register-node-watch.ps1 -Node noded,nodec
pwsh -NoProfile -File scripts/register-node-watch.ps1 -RunWhenLoggedOff
pwsh -NoProfile -File scripts/register-node-watch.ps1 -Unregister
```

The task runs `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\run-node-watch.ps1` from this checkout as the current user, with the same principal options as the CI watch: interactive logon by default, `-RunWhenLoggedOff` for S4U (no password stored; the watch needs no network credentials of its own), `-IntervalMinutes` to change the cadence. A missed run starts when the machine wakes; a run is limited to 5 minutes; a run still going when the next is due is left alone. `scripts/run-node-watch.ps1` changes to the repository root, checks that `corepack` is on the task user's PATH (it does not check `tailscale`, because the command finds it itself), runs `corepack pnpm forge node-watch`, appends everything it prints to `C:\forge\logs\node-watch-<yyyyMMdd>.log` (`FORGE_NODE_WATCH_LOG_DIR`, then `FORGE_DIGEST_LOG_DIR`, or `-LogDir` to move it) and exits with the command's exit code. `pwsh -NoProfile -File scripts/run-node-watch.ps1 -DryRun -LogDir $env:TEMP` proves the wiring without sending or writing outside the temp folder.

## Scheduled task health

The digest reports any scheduled task that wants attention, and pushes to the phone only
once a task has failed **twice running** (ADR-033). This exists because
`TheForge Node Watch` sat at `LastTaskResult 0x1` for days and nothing said so (BLK-025):
the result was visible to `pnpm forge runtime status`, which nobody runs on a good day.

**A task wants attention when** it is not registered, or it is disabled, or its last
result is not in `HEALTHY_TASK_RESULTS`.

**`0x800710E0` and `0x8004131F` are healthy, not failures.** The BLK-017 watchdog trigger
re-fires every minute and `MultipleInstances IgnoreNew` refuses the repeat, so the
coordinator, worker and web tasks sit on one of those permanently while perfectly well. If
you ever see them reported as failures, something has broken the healthy set and the digest
is about to start crying wolf.

| Setting             | Default                | What it does                                                                                                                |
| ------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_WATCH_TASKS` | TheForge's seven tasks | Comma-separated. A leading `+` **adds** to the defaults, which is usually what you want; without it the list replaces them. |

On NODEE `.env` carries `FORGE_WATCH_TASKS=+Backup task,Offsite task`, so
the hourly backup and the nightly offsite copy are watched too - their silent failure on
01/10/2026 is what this came out of.

To see it now, without sending anything:

```bash
pnpm forge digest --window=now --dry-run
```

The dry run also says how many task escalations it _would_ send, or that it would seed
silently if there is no previous observation. State lives at
`<outbox>/task-health/state.json`; deleting it costs one quiet digest, because the next run
seeds again rather than escalating a first-seen failure.

## Running TheForge as a service on Windows

**The rule first.** Nothing is registered until Stage 4 is proven end to end (F140: both services survive a logon and a forced crash, then the Stage 5 S5.3 restart test on real work). Everything in this section is built and tested; running `register-runtime.ps1` is a Dan-only manual action and the one step this section does not automate. Until then the runtime is started by hand (`pnpm dev`, or the runner scripts below in a terminal).

**What it is.** Three Task Scheduler tasks — "TheForge Coordinator", "TheForge Worker" and "TheForge Web" — each running a PowerShell 7 runner script from `scripts/runtime/` under the interactive user. There is no NSSM or service wrapper; Task Scheduler is the supervisor.

| Task                 | Runner                | App                | Waits for Docker |
| -------------------- | --------------------- | ------------------ | ---------------- |
| TheForge Coordinator | `run-coordinator.ps1` | `apps/coordinator` | yes              |
| TheForge Worker      | `run-worker.ps1`      | `apps/worker`      | yes              |
| TheForge Web         | `run-web.ps1`         | `apps/web`         | no               |

| Property           | Value                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action             | `pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <repo>\scripts\runtime\run-<app>.ps1 -LogDir C:\forge\logs`, working directory the repository root |
| Trigger            | At log on of the registering user; the worker with a 30 s delay                                                                                                       |
| On failure         | Restart every 1 minute, up to 999 times                                                                                                                               |
| Time limit         | None (`ExecutionTimeLimit` PT0S)                                                                                                                                      |
| Multiple instances | Ignore new: a second start while one runs does nothing                                                                                                                |
| Principal          | The registering user, "run only when user is logged on", not elevated                                                                                                 |
| Power              | Start on batteries, do not stop on batteries, start when available after a missed trigger                                                                             |

"Run only when user is logged on" is deliberate: Docker Desktop is per-user and the worker needs its engine, and the interactive session carries the user PATH (node, docker, pwsh) the runners rely on. The alternative, "run whether user is logged on or not", needs a stored password (`LogonType Password`) and a Docker engine that runs without a session; neither is set up. Unattended operation with this registration means auto-logon plus a locked screen.

**Pre-flight.** Before registering, and after any change to the machine:

```powershell
pnpm forge runtime doctor          # exit 1 on any FAIL; --json for the same as one document
```

It prints one `OK`/`FAIL` line per check: repository root (run it from the root), node 22+, pnpm, pwsh 7, the Docker engine answering, the sandbox image present, `.env` present, all three apps built (`apps/coordinator/dist/server.js`, `apps/worker/dist/index.js`, and the `apps/web/.next` directory `next build` writes), the coordinator port free or held by a coordinator whose `/health` answers, port 3000 free or held by the control centre (asked of `/login`, the one page it serves whatever else is wrong — no session, no coordinator, not even an operator password — and whose body names TheForge), the log directory writable or creatable, and the halt file (present or absent; `FORGE_HALT_FILE` must be absolute when set).

Two checks are **advisory**: they report `OK` with a `WARNING` in the detail, because neither stops a task starting and the doctor has no warn level.

- **web operator password** — `FORGE_WEB_OPERATOR_PASSWORD` missing or under 16 characters. The control centre then answers 503 to everything but `/login`. The value itself is never printed (ADR-027).
- **web origin** — `FORGE_WEB_ORIGIN` unset, not an http(s) URL, or still a loopback URL. A tailnet or LAN client then fails the proxy's same-origin check on every mutation with `403 same_origin_json_required`, which reads like a bug rather than a setting. See "Reaching the control centre from elsewhere" below.

`register-runtime.ps1` runs the doctor first and refuses to register on a FAIL (`-SkipDoctor` overrides, for a deliberately partial setup).

**Registration.** From the repository root, as the user who will be logged on:

```powershell
pwsh -NoProfile -File scripts/runtime/register-runtime.ps1 -WhatIf       # prints all three task definitions, registers nothing
pwsh -NoProfile -File scripts/runtime/register-runtime.ps1               # registers all three (idempotent: -Force replaces)
pnpm forge runtime status                                                # all three tasks Ready, "has not run yet"
pwsh -NoProfile -File scripts/runtime/register-runtime.ps1 -Unregister   # stops and removes all three
```

`pnpm runtime:register` is the second command; `pnpm runtime:register -WhatIf` the first. `-LogDir` changes where the runners log; keep `FORGE_LOG_DIR` in `.env` in step with it so `pnpm forge runtime status` reads the same directory.

**No console windows (`run-hidden`).** A task that starts `pwsh` directly under the Interactive logon type gets a console window; on Windows 11 that is a Windows Terminal window, which the watch tasks flash on every run and the three runtime tasks hold open from logon. `register-runtime.ps1`, `register-ci-watch.ps1` and `register-node-watch.ps1` therefore build the task action through `scripts/runtime/task-action.ps1`: when `run-hidden.exe` is installed (`%LOCALAPPDATA%\Programs\run-hidden\`, or the path in `FORGE_RUN_HIDDEN`) the action is `run-hidden.exe "<pwsh>" <arguments>`, a GUI-subsystem launcher that starts `pwsh` with no window, waits for it, and exits with its exit code, so Task Scheduler's last result and `pnpm forge runtime status` stay meaningful. Without it the action is plain `pwsh`, with a warning, and the task works with its window. `register-digests.ps1` is deliberately not changed: the digest tasks run logged off and never had a window, and `run-hidden` has not been tried under that logon type.

**Registration now starts the tasks**, about a minute later, because of the watchdog trigger described below. Pass `-NoWatchdog` for the previous behaviour, where nothing ran until the next logon or `pnpm forge runtime start`.

**What the tasks do.** `run-coordinator.ps1` and `run-worker.ps1` (sharing `runtime-common.ps1`) each: change to the repository root; refuse with exit 3 when `.env` is missing, when the app's `dist` entry is missing (they build nothing; run `corepack pnpm build`), or when `node` is not on PATH; create `C:\forge\logs`; delete all but the newest 14 daily log files for that app; note in the log that they are starting; run `node --env-file-if-exists=.env apps/<app>/dist/<entry>` with stdout and stderr appended to the day's log file; and exit with node's exit code. Both first poll `docker info` every 10 s for up to 5 minutes and exit 4 if the engine never answers, because at logon Docker Desktop comes up some time after the task fires (BLK-019). The worker's own registration retries (8 attempts with backoff, `apps/worker/src/index.ts`) cover the coordinator task starting a little after it.

`run-web.ps1` keeps the same contract — exit 3 without `.env` or a build, the same `web-<yyyyMMdd>.log` rotation, node's exit code passed through — with two differences. Its entry is Next's own binary rather than a bundled file, so the pre-flight looks for the **`apps/web/.next` directory**, and node is started **from `apps/web`**, because `next start` resolves `.next`, `next.config.ts` and `node_modules` from the working directory: `node --env-file-if-exists=<repo>\.env node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000`. That is the same `.env` the other two read, by absolute path. `-Hostname` and `-Port` change the two defaults. (In `runtime-common.ps1` this is `Invoke-ForgeNextApp`, a sibling of `Invoke-ForgeApp`: node takes its own argument list, the working directory is not the repository root, and the build artefact is a directory, and widening the function the coordinator and worker depend on to cover all three would have cost them for a shape only the web app has.)

**The web task waits for nothing.** It holds no PostgreSQL or Redis connection and runs nothing in the sandbox — it reaches the coordinator over HTTP through its own `/forge-api` proxy and degrades gracefully when the coordinator is absent: `/login` and `/forge-api/health` still answer, and a page that needs data shows its error state. So it gets no Docker wait and no start delay; waiting for an engine it never uses would only delay the control centre at the moment an operator most wants it.

**The watchdog trigger, and why it exists (BLK-017).** Each task carries a second trigger: a `Once` trigger with a repetition interval and no duration, which repeats for the life of the task on Windows 10 and later. `-WatchdogMinutes` sets the interval (default 1).

This is what actually brings a dead process back. The `RestartCount 999` / `RestartInterval PT1M` settings **do not work for these tasks**, measured on 27/09/2026: the coordinator was killed mid-run, the runner exited `-1`, the task recorded `LastTaskResult 0xFFFFFFFF` with both settings in place, and Task Scheduler left it `Ready` with no next run — dead for over seven minutes. With the watchdog, the same kill was followed by a revival 22 seconds later, on the trigger's scheduled tick. The settings are left in place because they cost nothing, but do not rely on them.

Because `MultipleInstances` is `IgnoreNew`, every repeat while the process is alive is refused, and Task Scheduler records `0x800710E0` (or `0x8004131F`) as the task's last result each minute. That is the healthy state, and `pnpm forge runtime status` names it as such; `0xFFFFFFFF` and the runner's own exits 3 and 4 still read as faults.

One consequence: **`pnpm forge runtime stop` is undone by the watchdog within a minute.** To stop work durably use the kill switch — `pnpm forge halt` writes `FORGE_HALT` and both runners refuse to lease anything while it exists — which is by design the single source of truth (see "Stopping the system"). Unregistering, or `-NoWatchdog`, is the way to hand process lifetime back to a human.

Because the runners start both apps **from the repository root**, the default `FORGE_WORKSPACE_ROOT`, halt file and outbox resolve to `<repo>\.forge\...`, the same paths `pnpm forge` uses. `pnpm dev` starts the apps from their own directories, where the defaults resolve to `apps\coordinator\.forge\...`; set `FORGE_HALT_FILE`, `FORGE_WORKSPACE_ROOT` and `FORGE_OUTBOX_DIR` to absolute paths in `.env` so every way of starting the system agrees.

**Logs.** `C:\forge\logs\coordinator-<yyyyMMdd>.log`, `worker-<yyyyMMdd>.log` and `web-<yyyyMMdd>.log`, UTF-8, named for the day node was started (a process running across midnight keeps its file; the next start opens the new day's), 14 files per app kept. The runner's own lines are `<ISO timestamp> run-<app>.ps1: <message>` (starting, rotated out, refusing to start, node exited with code); everything else is the app's output, which for the coordinator is one JSON object per line. To follow along:

```powershell
Get-Content -Wait -Tail 50 C:\forge\logs\coordinator-$(Get-Date -Format yyyyMMdd).log
```

**Observing.** `pnpm forge runtime status [--json]` prints, per task, its state (Ready, Running, Disabled), whether it is enabled, the last run time and the decoded last result (`0 (success)`, `0x41301 (running)`, `0x41303 (has not run yet)`, `3 (runner pre-flight failed ...)`, `4 (runner gave up waiting for Docker)`), then the same halt file and coordinator lines as `pnpm forge status`, then the newest line of each app's newest log file. A task that is not registered is reported as such, exit 0. Task Scheduler's own history is in Event Viewer under Applications and Services Logs, Microsoft, Windows, TaskScheduler, Operational, and is the evidence F140 asks for.

**Stopping safely.** Stopping a task terminates the runner and its node process; a provider job in flight at that moment is killed, and its lease later expires and is reassigned (see Recovery). So:

```powershell
pnpm forge runtime stop            # 1. writes the halt file  2. stops web, then the worker, then the coordinator
pnpm forge runtime stop --no-halt  # stops without touching the halt file
```

`start` walks the tasks coordinator, worker, web; `stop` walks them backwards, so the control centre stops taking orders before the system under it goes away. The halt file does not stop the web app — it only ever reads and forwards — so a halted system still has a working control centre, which is the point.

To let in-flight work finish first: `pnpm forge halt`, wait until the coordinator log goes quiet (up to 15 minutes for a run waiting on a provider, as the kill switch section explains), then `pnpm forge runtime stop`. The halt file stays after a stop and the tasks stay registered, so the next logon or `pnpm forge runtime start` brings the coordinator up **halted**: it leases nothing until `pnpm forge resume`, and `runtime start` says so when it sees the file. That is the kill switch honoured across restarts (policy B13).

**Updating.** In this order, from the repository root:

```powershell
pnpm forge runtime stop
git pull
corepack pnpm install --frozen-lockfile
corepack pnpm build
pnpm db:migrate                    # when a migration landed
pnpm forge runtime doctor
pnpm forge resume                  # the stop wrote the halt file
pnpm forge runtime start
pnpm forge runtime status
```

Re-run `register-runtime.ps1` only when the runner scripts or the task definition changed; it replaces both tasks in place.

**Configuration.** All optional, in `.env`: `FORGE_LOG_DIR` (default `C:\forge\logs`; must match the registered `-LogDir`), `FORGE_PWSH` (the PowerShell 7 executable `pnpm forge runtime` spawns when `pwsh` is not on PATH), `FORGE_REPO_ROOT` (where `doctor` looks when not run from the root), `FORGE_WEB_HOST` and `FORGE_WEB_PORT` (default `127.0.0.1` and `3000`; the address `doctor` probes for the control centre — the registration passes neither `-Hostname` nor `-Port`, so the task uses `run-web.ps1`'s own defaults, and these two only need setting if you change those).

### Reaching the control centre from elsewhere

The web app binds loopback and nothing else. `tailscale serve` is what puts it on the tailnet, with a real TLS certificate for the machine's tailnet name, reachable from a phone or from `nodeb`:

```powershell
tailscale serve --bg http://127.0.0.1:3000   # front it at https://<machine>.<tailnet>.ts.net
tailscale serve status                       # what is currently served
tailscale serve reset                        # remove it again
```

**The two halves persist differently, and both are needed.** The serve configuration lives in `tailscaled`'s own preferences and comes back by itself after a reboot; the app does not, which is exactly what the "TheForge Web" task is for. A reboot with the task registered and the serve configuration in place brings back both.

**Loopback is deliberate.** `-Hostname 0.0.0.0` would publish the control centre on the LAN as well, where nothing but the operator password stands in front of it. Keeping it on `127.0.0.1` means the only route in is the tailnet, where Tailscale has already authenticated the device.

**`FORGE_WEB_ORIGIN` must equal the URL the browser actually uses** — `https://<machine>.<tailnet>.ts.net` once `tailscale serve` is in front, not `http://127.0.0.1:3000`. The `/forge-api` proxy refuses any mutation whose `Origin` does not match it, with `403 same_origin_json_required`, so a stale loopback value leaves the UI reading fine and every button failing. `pnpm forge runtime doctor` warns about exactly that (the "web origin" check). It is also the origin the coordinator allows through CORS, so change it in one place — `.env` — and restart both the coordinator and the web task.

**What protects it.** The operator login of ADR-027: every page and every `/forge-api/*` call needs the `forge_session` cookie, `/login` is password-only, compared in constant time and throttled, and the app fails closed to 503 when `FORGE_WEB_OPERATOR_PASSWORD` is not set (see "Operator login"). That password is the whole of the authorisation story once the app is reachable from another device, which is why the doctor warns when it is short or missing. Verified live on 27/09/2026 over the tailnet: `/` redirects 307 to `/login`, `/login` is 200, `/forge-api/runs` is 401 `operator_login_required`, `/forge-api/health` is 200.

## Local models

Ollama serves the two local tiers from ADR-018 - `qwen3:8b` (tier 1, ~130 tok/s) and `devstral-small-2:latest` (tier 2, ~53 tok/s) - and `@theforge/provider-ollama` is how a run reaches them (ADR-021). Nothing about it is a cloud call: no credential, no sandbox, `usd: 0` on every usage record, and the daily ceiling neither counts it nor refuses it.

**What runs where.** The worker probes `FORGE_OLLAMA_URL` (default `http://127.0.0.1:11434`) once at startup with `GET /api/tags` and advertises `provider:ollama` plus one `model:<name>` per listed model. An `ollama` provider job is executed _in the worker process_: the adapter speaks HTTP to the local server, streams `/api/chat` as NDJSON, and hands the events through the same per-task limits and secret redaction as a sandboxed CLI provider. It never enters the Docker sandbox: bridge networking would not reach the host's Ollama, and there is nothing to isolate (no credential, no file edits, no tools). The coordinator dispatches such a job with `requiredCapabilities: ['provider:ollama', 'model:<name>']` - no `sandbox:docker`, no `execution-os:linux` - so it can only be leased by a worker that has that model on disk. A request that names no model gets the tier-2 model.

**Which roles.** Policy (Dan, 26/09/2026 and 27/09/2026): all four pipeline roles stay on cloud by default, and since ADR-024 (27/09/2026) that cloud provider is Claude for every role unless the run pins a role to Codex in `configuration.providerRoles`; a run created without pins shows `providerRoles: {}` and the `routing.decided` and `usage.recorded` events name the provider actually used. Codex is an explicit evidence path, never a default, and never the substitute at the ceiling. When the ceiling says local-only - the day has reached it, or the stage's own estimate would carry the day past it (ADR-028) - the planner and the critic may run on tier 2; the builder and the reviewer stop the run instead (a policy stop, `partially_completed` with a `safety_constraint` blocker, not a pause), because the builder needs an agentic file-editing CLI and a local reviewer would weaken the merge gate. Tier 1 serves the light work classes (triage, classify, summarise, read_logs, commit_message, pr_description, interpret_test_failure), not pipeline roles. The role rule is enforced in provider selection (F121), not in the adapter.

**Environment (worker).**

| Variable                     | Default                  | Meaning                                                     |
| ---------------------------- | ------------------------ | ----------------------------------------------------------- |
| `FORGE_OLLAMA_URL`           | `http://127.0.0.1:11434` | The server the worker probes and calls.                     |
| `FORGE_OLLAMA_NUM_CTX_TIER1` | `8192`                   | `num_ctx` for `qwen3:8b` (5.9 GB resident).                 |
| `FORGE_OLLAMA_NUM_CTX_TIER2` | `16384`                  | `num_ctx` for `devstral-small-2:latest` (15.8 GB resident). |

Any other model takes the server's default context. The two tiers cannot be resident together at these sizes (24 GB card; `docs/evidence-local-model-benchmark-2-2026-09-26.txt`), so a tier switch costs a reload: qwen3 2.5-6.7 s, devstral 5-10.6 s. Ollama serialises requests (`OLLAMA_NUM_PARALLEL=1`), which matches the worker running one job at a time. Every chat is sent with `temperature: 0`, `think: false` for a model that reports the `thinking` capability (qwen3), and `format: <JSON Schema>` when the request carries an output schema; the reply is validated against that schema in the adapter before it becomes a `completed` event.

**How to check it.**

```powershell
curl -s http://127.0.0.1:11434/api/version                                              # {"version":"0.34.4"}
curl -s http://127.0.0.1:11434/api/tags | jq '.models[].name'                            # what is on disk
curl -s http://127.0.0.1:11434/api/ps | jq '.models[] | {name, size_vram, context_length}'  # what is resident now
```

At startup the worker logs one line either way: `ollama: advertising 3 model(s) from http://127.0.0.1:11434: devstral-small-2:latest, nomic-embed-text:latest, qwen3:8b`, or `ollama: not reachable at http://127.0.0.1:11434 (fetch failed (ECONNREFUSED)); provider:ollama not advertised`. A server that is down never stops the worker from starting; it is simply not advertised, and `GET /api/providers` on the coordinator shows `ollama` as unavailable until a worker that has it registers. `pnpm test` never touches the real server: the adapter, worker and coordinator suites run against an in-process fake (`@theforge/provider-ollama/testing`). One real request is behind a flag:

```powershell
$env:FORGE_OLLAMA_SMOKE = '1'; pnpm exec vitest run packages/provider-ollama   # a ten-token prompt on qwen3:8b
```

**Failure shapes.** A refused or reset connection is a retryable `PROCESS_EXIT`; a 4xx (unknown model: `model 'x' not found`) is not retryable; a 5xx is. `request.timeoutMs` produces `TIMEOUT` (retryable), the caller's abort `CANCELLED`, a reply over the 10 MB output bound `OUTPUT_LIMIT`, a reply cut off at the context limit (`done_reason: length`) `OUTPUT_TRUNCATED`, and a reply that misses the schema `STRUCTURED_OUTPUT_INVALID` - all non-retryable, with the message saying which.

## Local-model scoreboard and skills (ADR-045)

**Measuring the local model.** `pnpm forge local-scoreboard` replays recent runs through the local model and scores the result against what Claude wrote for the same run:

```powershell
pnpm forge local-scoreboard                       # the last 8 Claude runs, baseline only
pnpm forge local-scoreboard --compare             # baseline and skills side by side
pnpm forge local-scoreboard --limit=20 --roles=planner --model=devstral-small-2:latest
```

It rebuilds the planner and critic prompts with the pipeline's own prompt builders, sends them to Ollama (`FORGE_OLLAMA_URL`), and scores both answers on the rubric in `packages/cli/src/scoreboard.ts`. The report goes to `<outbox>/scoreboard/scoreboard-<time>.md` and `.json` (`--out=<dir>` overrides), and the Markdown is printed. It reads the database and writes nothing to it. Each local call takes tens of seconds on the 3090 and loads `devstral-small-2` if it is not resident, so run it when the GPU is free; a call that fails is listed in the report rather than stopping the board.

**Turning the skills on.** `FORGE_LOCAL_SKILLS=on` in `.env`, then restart the Coordinator and the Worker. For stages routed to a local model only, the worker's Ollama adapter adds the role's playbook to the system message, and the pipeline adds the repository's own conventions as context (its package scripts and the most relevant passages of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/CONTRIBUTING.md` and `README.md`, at most 6,000 characters). Cloud stages are unchanged. Leave it off until `--compare` shows the skills variant ahead; ADR-045 records the numbers.

## Routing and fallback in the pipeline

Every pipeline stage is placed before its provider is called (ADR-022; `docs/EXECUTION_PROTOCOL.md` "Routing and fallback"). What an operator sees in the run's events:

| Event               | When                                                    | Payload                                                                                                                                                |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routing.decided`   | before every stage call, and again after a substitution | `role, workClass, tier, tierName, providerId, model, reason, ceilingApplied, estimatedUsd, requiresLoad, estimatedLoadSeconds, priorFailures, allowed` |
| `provider.retry`    | a retryable provider error, before the wait             | `role, provider, code, message, attempt, delayMs`                                                                                                      |
| `provider.fallback` | a stage moves to another provider                       | `role, from, to, code, message, attempt, reason`                                                                                                       |
| `run.finished`      | a stage the policy refused ends the run                 | the result, with `blocker` (the reason) and `classification: 'safety_constraint'`, recorded as a blocker on the task                                   |

**Reading a decision.** `tier: 3` is the cloud, `providerId` the adapter that runs it and `model: null` (the adapter chooses); `estimatedUsd` is the per-role figure the decision was projected with, the same one the dispatch guard checks the call against. `tier: 2` with `providerId: 'ollama'` is a stage the ceiling moved to `devstral-small-2:latest`, either because the day has reached the ceiling (`reason` says "daily cloud ceiling of $20.00 reached ...") or because the stage's own estimate would carry it past (`reason` says "projected $20.20 ($19.50 spent on 2026-09-27 Australia/Sydney + $0.70 estimated) would pass the $20.00 ceiling", ADR-028); `ceilingApplied: true` either way. `requiresLoad: true` means Ollama will load it first, `estimatedLoadSeconds` the measured upper bound (10.6 s; `qwen3:8b` 6.7 s). `allowed: false` with `providerId: null` is a stage that may not run: the builder or the reviewer under the ceiling ("builder must not run locally; stopping the run at the ceiling (...)"), or a local-capable role with no `ollama` adapter online ("planner may run locally but no ollama provider is available; stopping the run at the ceiling (...)"). The run then ends `partially_completed` with the reason as its blocker - a policy stop, never a `run.paused_by_guard`; resume it after the next local day, a higher `FORGE_DAILY_CEILING_USD`, or once a worker advertises `provider:ollama`.

**What the coordinator wires.** Four optional fields on `AutonomousPipelineInput`: `usageSource` (its usage records through `toGuardUsage`), `ceiling` (the `CeilingConfig` it builds for `Guards`), `timeZone` (`FORGE_TIMEZONE`) and `residency` (`listLoadedModels` from the provider slice; not wired yet, so a local decision is annotated as a cold load). With `usageSource` every stage is also projected with its role's estimate before it is placed (ADR-028). With none of them the pipeline routes to the cloud as before and the dispatch guards remain the last line.

## Worktrees and retries

A run works in `<FORGE_WORKSPACE_ROOT>/worktrees/<run id>-implementation`, a worktree of the bare cache `<FORGE_WORKSPACE_ROOT>/cache/<project>.git` on the branch `forge/<first 8 characters of the run id>`. Every start and every resume goes through `GitWorkspaceRuntime.createWorktree` (`packages/git-runtime/src/index.ts`), which now recovers the partial state an earlier run can leave instead of failing on it. Each case below is a regression test in `packages/git-runtime/src/git.test.ts`, run against git 2.55 on Windows with the managed root inside this checkout - the same layout as the default `.forge/workspaces`.

**The cache follows the remote (ADR-040, BLK-032).** `register` clones the bare cache once and thereafter sets `remote.origin.fetch` to `+refs/heads/*:refs/remotes/origin/*` and fetches with `--prune` on every call, so `refs/remotes/origin/<branch>` is the remote's current tip. `createWorktree` starts a new worktree from `origin/<baseRef>` when it exists and otherwise from `baseRef` as given (a tag, a commit hash). The cache's own local `main` is no longer read: it is frozen at the first clone, and before this fix that was the commit every objective was built on. To see whether a cache is current: `git --git-dir <cache> rev-parse refs/remotes/origin/main` against `git ls-remote origin refs/heads/main`.

**Failing checks are repaired, not final (ADR-042, BLK-033).** The builder's prompt names every command the pipeline will run and says each must exit 0 (`renderCheckBrief`). If a check still fails after a build, the failing commands and the tail of their output (3,000 characters each, quoted as data) go back to the builder with the run's constraints, and verification runs again. Failing checks and rejected reviews share one budget of three repair rounds (`MAX_REPAIR_ROUNDS`), so a run costs at most three builder calls more than a clean one, about $0.5-0.6 each on a real repository. The run still ends, as `partially_completed`, on a failed install (the builder cannot repair a registry), on a repair that leaves the worktree unchanged, and when the budget is spent; the blocker says which. The ledger shows it as `repair.started` with `{ reason: 'checks' | 'review', round, of, failing | findings }`, and a `verification.completed` carrying `afterRepairs`. To resume a run that still stopped on a check, fix the files in its preserved worktree and use the run's retry control: it re-verifies from the checkpoint without rebuilding.

**What `createWorktree` recovers from.**

- `git worktree prune` runs first, so a registration whose directory was deleted by hand (`rm -rf` rather than `git worktree remove`) is forgotten before anything else is decided.
- A directory that is a registered worktree of the cache on the expected branch is returned as it is: nothing is fetched or checked out again, and files in it survive. That is the resume path, and the halt test proves a restarted coordinator reuses it.
- A registered worktree on another branch is still refused with `Existing workspace branch does not match`; it may hold someone's work.
- A directory that is not a worktree of the cache - empty, a partial clone, an interrupted `worktree add`, junk - is removed and recreated. Two checks decide that, because with the managed root inside a repository a bare `git branch --show-current` in a junk directory walks up and answers with the outer checkout's branch (which is what the old check mistook for a worktree on the wrong branch): the cache's `worktree list --porcelain` must name the directory, and `git rev-parse --show-toplevel` run inside it must answer with the directory itself.
- `worktree add` refused because the branch exists is retried without `-b`, as before. Refused because the branch is held by another worktree (`is already used by worktree at`; older git says `is already checked out at`) or because the path is a missing-but-registered worktree, it is retried after `prune` with `worktree add -f`. Any other git error still propagates.

**When a worktree is cleaned.** Only when the pipeline itself finishes `completed`: the final checks passed, the commit was made, `git push` succeeded and the draft pull request exists, so the directory holds nothing unique. The pipeline then calls `GitWorkspaceRuntime.cleanup` (`git worktree remove --force`, then `rm`) and emits `workspace.cleaned {workspace}`. A directory that will not go (a Windows file lock, typically) emits `workspace.cleanup_failed {workspace, message}` instead and the run is still `completed`; the next `createWorktree` for that run prunes and recreates over what is left. Every other outcome keeps the worktree, which is what "Do not delete managed worktrees until commits and artifacts are captured" under Recovery relies on: `partially_completed` (failed checks, review findings after three rounds, a reviewer that wrote to the tree, the pending push approval), a stage the routing policy refused (`classification: safety_constraint`), a failed or cancelled run, and a coordinator restart mid-run all leave it in place for resume and inspection. A run that completes through the push approval instead (`POST /api/approvals/:id/approve`, coordinator side) is not cleaned by this; that worktree stays until retention removes it.

**The halt-aware wait and `FORGE_WORKER_JOB_WAIT_MS`.** A job the pipeline queues for a worker waits in `waitForWorkerJob` (`apps/coordinator/src/server.ts`) for `FORGE_WORKER_JOB_WAIT_MS` (default `900000`, fifteen minutes; minimum `1000`) of _active_ time. While the halt file exists the lease route answers every worker 204, so a queued job cannot be taken; the wait checks the same file every 250 ms and does not advance its budget while the file is there, and it keeps polling the job meanwhile, since one leased before the halt may finish under it. The paragraph "Read from the code, not yet proven by a test" under "Kill switch: verified behaviour" is superseded: a halt of any length no longer cancels queued jobs or fails their runs. The coordinator logs the transitions, at most once a minute each across all waiting jobs: `worker job wait paused: halt file present; queued jobs are not timing out` (warn; fields `jobId`, `runId`, `haltFile`, `activeMs`, `budgetMs`) when a wait first sees the file, and `worker job wait resumed: halt file removed` (info, same fields) when it goes. Once the budget of active time is spent the behaviour is unchanged: the job is cancelled and the run fails with `Worker job … timed out waiting for a compatible worker`.

**Evidence.** `pnpm exec vitest run packages/git-runtime`, 2026-09-26: 13 tests green in 13.4 s, seven of them the recovery cases above. `pnpm exec vitest run tests/halt.integration.test.ts`, second test, 12.3 s: a coordinator spawned with `FORGE_WORKER_JOB_WAIT_MS=4000` and halted through `POST /api/halt` before the run started, so the planner job was queued into a stopped system; the worker's polls were refused for a 3 s window; 6007 ms after the job was queued (past the 4 s budget) it was still `queued`, the run still `executing`, `run.failed` absent, and the warn record above present with the job's id and `budgetMs: 4000`; `DELETE /api/halt` then had the job leased to the worker 164 ms later, the info record appeared, and the run finished `partially_completed` at the push approval with six completed jobs, as the unhalted run does. The counterfactual was run as well: with the wait made to count wall-clock time (one line, rebuilt, not committed) the same test failed at the 6 s check with the job `cancelled` and the coordinator's log showing the paused record followed by `Escalation run.failed sent via file` 5.1 s after it started listening, the 4 s budget after the job was queued - so the test does tell the two apart. The full gate afterwards, `pnpm test` with the three integration suites in parallel: 40 files, 383 passed, 1 skipped (the flag-gated Ollama smoke request), 0 failed, 35.4 s; teardown `public rows … (unchanged)`.

## Failed workspaces

Every transported job runs in its own checkout, `<FORGE_WORKSPACE_ROOT>/.job-<jobId>`, materialised from the run's repository, revision, patch and untracked files (`materializeWorkerWorkspace`, `apps/worker/src/index.ts`). Until now that directory was removed whatever the outcome, so a failed build, a check that printed something odd, or a provider that edited the wrong file left nothing to look at but the job's stderr. Now the worker keeps it (`executeTransportedJob`):

- **Success** (exit code 0, not cancelled): removed, as before.
- **Failure** (non-zero exit code, or an error thrown while running the job) **or cancellation** (the coordinator's cancel, a lost lease, or the worker shutting down): the directory is renamed to `<FORGE_WORKSPACE_ROOT>/.failed/<yyyyMMddTHHmmss>-<jobId>` (UTC) and a `RETAINED.json` is written inside it - `{ jobId, runId?, role?, code, reason, retainedAt, expiresAt }`, where `reason` is the tail of the job's (already redacted) stderr, or the cancellation reason. The path is reported to the coordinator as `retainedWorkspace` on the completion, kept in `worker_jobs.result`, and copied into the attempt's `error` (`attempts.error.retainedWorkspace`) beside the stderr, so the run's attempts record where to look. The worker's own log has it too: `failed workspaces: kept <path> (job <jobId>, code <code>; expires <expiresAt>)`.
- A workspace materialisation that fails before the job runs is removed by `materializeWorkerWorkspace` itself, as before; there is nothing of the job's in it.

**What to expect on disk.** The retained directory is the checkout exactly as the job left it, which is why nothing serves it: provider and check output written into the workspace can contain secrets, and the isolated credential never touches it (it goes to a tmpfs inside the sandbox), but the files are for a human with access to the worker's disk, not for the web UI or the API. Read it there, with `git status` and `git diff` in the directory for what the job changed.

**Retention.** Two worker variables, both optional:

| Variable                               | Default | Meaning                                                                     |
| -------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `FORGE_FAILED_WORKSPACE_KEEP`          | `5`     | Newest entries kept under `.failed`; `0` keeps nothing (removed as before). |
| `FORGE_FAILED_WORKSPACE_MAX_AGE_HOURS` | `72`    | An entry older than this (by the timestamp in its name) is removed.         |

The sweep runs at worker startup, next to the orphaned-container cleanup, and again after every retention: entries beyond the newest `KEEP`, and entries older than `MAX_AGE_HOURS`, are removed and each removal is logged as `failed workspaces: removed <path> (beyond the newest 5 | older than 72 h)`. Age is read from the entry's name, so a directory you rename (say, to `keep-20260926T031500-job-x`) stops matching and is yours until you delete it. `RETAINED.json`'s `expiresAt` is the same deadline, written for whoever finds the directory without the log.

**Windows.** A sandbox container that has been stopped but not yet removed can still hold the workspace bind mount, and the rename then fails with `EBUSY` or `EPERM`. The worker retries the rename five times, half a second apart; if it still cannot move the directory it removes it as it would have before retention and logs `failed workspaces: could not move <from> to <to> after 5 attempt(s) (...); removing it instead` as a warning. That completion carries no `retainedWorkspace`.

## Raw provider output

A sandboxed CLI provider (`claude`, `codex`) talks to the worker in JSON lines on stdout, and the adapters keep only what they map into provider events: unrecognised JSON, non-JSON lines and everything on stderr never become events. A provider that failed in an unexpected way therefore used to leave nothing behind but its exit code and whatever fitted in the error message. The worker now tees both streams as they are read and can attach the end of each to the job result.

**What is captured.** Every stdout line as read, before parsing (`rawStdoutTail`), and every stderr chunk (`rawStderrTail`), each as a rolling tail that keeps the last `MAX_RAW_TAIL_BYTES` (1,000,000 bytes) and drops the start. An `ollama` job runs in the worker process over HTTP and has no process output, so it never carries tails; neither does a command job.

**When.** `FORGE_RAW_OUTPUT` on the worker. `failure` (the default) attaches the tails only to a provider job that failed: a non-zero exit, a provider `error` event, a tripped task limit or a cancellation. `always` attaches them to every provider job; `never` attaches none. An empty tail is left off. A job the worker could not finish at all (an event list over `MAX_EVENTS_BYTES`, a workspace error) is reported through the poll loop's catch and carries no tails, and a completion the worker has to fail as `COMPLETION_TOO_LARGE` or `COMPLETION_REJECTED` is re-sent without the patch and without the tails.

**Where it lives.** Two optional string fields on the job result, next to `events` and `patch`: in `worker_jobs.result` (jsonb) when the coordinator is durable, in memory otherwise. They are read through `GET /api/runs/:id/jobs`, which the coordinator token protects, and nowhere else: not in the run's events or the SSE stream (`worker_job.completed` carries `jobId`, `workerId` and `code`), not in any prompt (the pipeline consumes a job's `events` and `patch` only), not in the web UI or the CLI. The coordinator rejects a tail over `MAX_RAW_TAIL_BYTES` with 400, and `MAX_COMPLETION_BODY_BYTES` is sized so that patch, events and both tails fit together.

**Retention.** `worker_jobs` rows cascade from their run, so the tails live exactly as long as the run and go with it under "Retention cleanup" above. Nothing prunes them separately.

**Redaction, and its limits.** Before a tail is attached the worker runs `redactSecrets` (packages/policy) over it with the same known values as the job's events - the worker token, plus the API key or every string of eight characters or more from the auth file the provider was given - and the generic patterns: `sk-`/`rk-`/`pk-` keys, GitHub and AWS key shapes, PEM private keys, `token=`/`refresh_token=`/`access_token=`/`client_secret=`/`password=`/`api_key=` pairs, `Bearer <token>`, JWTs, and JSON string fields whose name contains `token`, `secret`, `password`, `apiKey`, `credential` or `private_key` (`"refresh_token":"[REDACTED]"`, also when the JSON is escaped inside another string). This is best effort. A credential the worker was never told about that matches none of those shapes - a token in an unfamiliar format, a secret quoted in prose without a name, a key split across lines - goes through as written, and the same patterns now also apply to events and command output. Treat the tails as sensitive: leave `FORGE_RAW_OUTPUT=failure` unless you are debugging a provider, and read a tail before pasting it into a run's context or an issue.
