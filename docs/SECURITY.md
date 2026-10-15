# Security and Approval Policy

> **A dated document.** Written on 26/09/2026 and updated in places since. Where it describes the system as it was then (for example a task "not yet registered", CI "red", or no web login), the later records in `docs/DECISIONS.md` and `docs/OPERATIONS.md` supersede it.

Refreshed 26/09/2026 (F091) for `main` @ `b8b0ed8`. `docs/THREAT_MODEL.md` holds the threats and the evidence for each control named here; this file is the policy. Where the two disagree, the threat model describes what the code does and this file says what it must do.

## Trust model

Model output, repository content, tool output, worker messages, web content, local-model output, notification content and user-supplied prompts are untrusted until validated. TheForge must assume prompt injection and malformed output are possible from every provider, cloud or local (ADR-021: a local model is a model, not a trusted service).

Trusted configuration: `.env` and the variables it sets, including `FORGE_OLLAMA_URL`, `FORGE_HA_URL` and `FORGE_API_URL`. Changing one of these is a policy change, not a runtime decision.

## Action classes

### Green: automatic

- Read repository files and metadata.
- Create isolated branches/worktrees; recover a partial worktree (F130).
- Edit files inside an assigned workspace (the builder role only; ADR-016).
- Run allowlisted local tests, formatters, type checks, and builds inside the Docker sandbox.
- Create local commits, after the staged-diff secret scan.
- Read non-secret configuration.
- **Local-model calls** (`ollama`, ADR-021): green. They spend nothing, hold no credential, expose no tool, run on loopback, and are validated like any other provider output. They are permitted only for the planner and critic roles and only when the ceiling routes local (ADR-022); a run configuration may not pin a role to a local model. Pointing `FORGE_OLLAMA_URL` off-host would make this an outbound-network action and is not permitted without a recorded decision.
- Writing to the file outbox and the halt file (these are how the system talks to the operator).
- Retaining a failed workspace under `<root>/.failed` and attaching redacted raw provider tails to a job result (F131/F132): green, because nothing serves them and both are bounded and swept; see "Retention" for what that does not protect.

### Amber: policy-controlled

- Install or update dependencies (inside the sandbox for pipeline work; **on the host** for Tier 0, see below).
- Access the public internet (cloud provider calls, `gh`, GitHub API).
- Start containers or local services.
- Modify development databases.
- Push non-protected branches (digest-bound approval, ADR-014 askpass boundary).
- Use paid provider calls: every cloud call is gated by the daily ceiling (`FORGE_DAILY_CEILING_USD`, policies B2/B3) before it is dispatched and at run start; at the ceiling the planner and critic route local and the builder and reviewer stop the run with a `safety_constraint` blocker.
- Execute commands outside the repository workspace.
- **Notifications** (F113): outbound HTTP to Home Assistant and SMTP to Gmail with long-lived secrets. Amber, not green, because they leave the host and carry model-influenced text. Policy-controlled by configuration: each channel exists only when its variables are set; the file outbox is always on and needs no secret. Rate is bounded by dedupe (6 h per key) and coalescing (5 min per run and kind).
- **Tier 0 merge** (`pnpm tier0 <repo> --execute`): Amber under a **standing** approval, recorded in ADR-019. A merge to a default branch is listed under Red below for the pipeline, and it stays Red there. Tier 0 is different in kind: the approval is the allowlist (`packages/tier0/src/policy.ts` `DEFAULT_CONFIG.mergeAllowlist`, exactly the two repositories named in `DEFAULT_CONFIG`: `example-org/shopfront` and `example-org/pulse-app`, the second added by ADR-035), given once by Dan for machine-generated dependency bumps only, with the checks, the pre-merge re-check, the deferral on a moved base and the B11 notification as the controls. Expanding the allowlist is a Red decision (policy B5) made by editing that constant in a reviewed change, never by the tool. Tier 0's verification runs the PR's install and check scripts **on the host, unsandboxed**; that is the reason the allowlist is two low-stakes repositories and must stay small until the verification is containerised.
- Scheduled tasks: registering `scripts/register-digests.ps1` or `scripts/runtime/register-runtime.ps1` is an operator action, never automated; the tasks run as the interactive user at `RunLevel Limited`.

### Red: explicit approval required in initial release

- Merge to protected branches (the pipeline never does this; it opens a draft pull request).
- Deploy to production or alter production infrastructure/data.
- Send external communications other than the configured escalation channels to Dan.
- Spend money or initiate financial transactions (refused by `checkSpend` in `packages/guardrails/src/spend.ts` (forbidden action names, payment hosts, and a `spend` capability treated as a configuration fault), which is implemented and tested but has no production call site yet; see the threat model, "Not covered").
- Change DNS, authentication, permissions, or secrets; expand the Tier 0 allowlist or trusted-author list.
- Delete remote data or repositories.
- Run privileged/system-wide commands.
- Expose a worker, the coordinator or the web control centre to the public internet.
- Give a local model tools, file access or the builder/reviewer role.

## Command policy

Commands are parsed and evaluated before execution. Deny by default when a command:

- contains destructive filesystem or Git operations;
- requests privilege escalation;
- accesses secret locations (`.ssh`, `.aws`, `.config/gh`, `.codex`, keychains, credential files);
- escapes the assigned workspace;
- opens an unapproved listener;
- pipes remote content directly to a shell;
- modifies system configuration;
- conflicts with project policy.

Approval binds to the exact normalised action, scope, worker, expiry, and relevant arguments (SHA-256 digest, constant-time comparison). Materially changed actions require new approval; an integration push whose worktree HEAD no longer matches the approved commit is refused and escalated as a security signal.

## Secrets

- Never store secrets in Git, prompts, logs, artefacts, or database plaintext.
- Local mode uses `.env` (gitignored) and isolated credential files; the OS keychain is not used. Persist secret references only.
- Redact known and pattern-detected secrets from all event streams, command output, raw provider tails, notification bodies and thrown errors.
- Prevent model access to secrets unless the specific tool invocation requires it; the local model never receives one.
- Rotate credentials after suspected exposure. Rotate both tokens after fixing the `C:\forge` ACL (threat model T10).

What each secret is, where it goes, and how it is redacted:

| Secret                                                           | Used by                                                                                                                                                    | Leaves the host?                                                                        | Redaction                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_COORDINATOR_TOKEN`                                        | Every `/api/*` call; the web BFF route; CLI `status`, `runtime`, `digest` health line                                                                       | No (loopback or Tailscale)                                                              | Compared in constant time (`secretEquals`); never logged; the generic `Bearer` pattern covers accidental echoes                                                                                                                |
| `FORGE_WORKER_TOKEN`                                             | Worker registration; the worker adds it to its known-secret list for every job                                                                             | Only to the coordinator                                                                 | Known-value redaction on every provider event, command output and raw tail (`apps/worker/src/index.ts:865`); stored in the database only as a SHA-256                                                                         |
| Worker session token                                             | Every worker call after registration                                                                                                                       | Only to the coordinator                                                                 | Short-lived, bound to the worker id; never persisted                                                                                                                                                                          |
| `FORGE_WEB_OPERATOR_PASSWORD`                                    | `POST /login/session` in the web app, and nothing else (ADR-027)                                                                                            | No                                                                                      | Compared as SHA-256 digests with `timingSafeEqual` (`apps/web/lib/auth/password.ts`); never logged or echoed: the 503 page, the login page and the doctor name the variable and the rule, not the value                       |
| `FORGE_WEB_SESSION_SECRET` (the password stands in when unset)   | HKDF-SHA256 into the HMAC key that signs the `forge_session` cookie (`apps/web/lib/auth/session.ts`)                                                       | No; only the signed token reaches the browser                                           | Derived in memory and never written; the cookie is HttpOnly, SameSite=Strict, 12 h, `Secure` over HTTPS; verification is `crypto.subtle.verify`, constant time                                                                |
| `GITHUB_TOKEN`                                                   | The approved push and the draft-PR API call                                                                                                                | To GitHub, over HTTPS                                                                   | Passed to Git only through a temporary askpass launcher with credential helpers disabled (ADR-014); reflected in remote errors is redacted; never in arguments, URLs, config or workspace files                                 |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                            | Sandboxed provider CLI; and, for `ANTHROPIC_API_KEY`, one startup probe from the worker process (ADR-038)                                                  | To the provider, from inside the container; the probe goes from the worker host to `api.anthropic.com` over HTTPS, as the `x-api-key` header only                | Known-value redaction (the key itself); the probe's error text is scrubbed of the key and cut to 300 characters before it reaches an event, the diagnostic or the digest |
| `FORGE_CODEX_AUTH_FILE` | Codex: read by the worker, sent over stdin into a tmpfs in the container; never on the workspace                                                                  | To the provider, from inside the container                                              | Every string of 8+ characters in the file is a known value for redaction; the file must be a regular JSON file under 1 MB                                                                                                     |
| `FORGE_HA_TOKEN`                                                 | `POST <FORGE_HA_URL>/api/services/notify/<service>` as a bearer                                                                                            | To Home Assistant on the LAN, **plain HTTP** at the documented URL                      | Redacted (raw and base64) from every rendered message, outbox file, log line and error (`packages/notify/src/redact.ts`); HA's error bodies never echo it                                                                      |
| `FORGE_SMTP_PASSWORD`                                            | `AUTH PLAIN` over implicit TLS to `FORGE_SMTP_HOST:465`                                                                                                    | To Gmail, TLS with hostname verification                                                | Redacted raw and base64; a rejected login is reported with the server text and without the password (`smtp.test.ts:173`)                                                                                                      |
| `gh` CLI login (operator's OAuth token, `repo` scope)            | Tier 0 (`gh pr list/view/merge/comment`, `gh repo clone`)                                                                                                  | To GitHub                                                                               | Not managed by TheForge; lives in the OS keyring; broader than any repository-scoped token. Tier 0 output records commands and exit codes, not `gh`'s environment                                                              |
| Contents of a target repository (may contain someone's secrets) | Cloned into the bare cache and worktrees; shown to the builder and reviewer                                                                               | To the cloud provider as prompt context                                                 | The staged-diff scan refuses to commit a likely secret; `redactSecrets` patterns apply to whatever a provider echoes; a retained failed workspace is **not** redacted                                                          |

Nothing above protects a secret from a local account that can read `C:\forge` (threat model T10, open).

## Worker security

- Mutual authentication and encrypted transport (shared token to register, short-lived session per worker; Tailscale or HTTPS for anything off-host).
- Short-lived worker credentials.
- Capability and policy attestation at registration; a job is leased only to a worker advertising every required capability, including `model:<name>` for a local-model job.
- Time-bound task leases, heartbeat expiry, fenced completion.
- Workspace sandboxing in the pinned Docker image with a read-only root, dropped capabilities, no-new-privileges, workspace-only mounts, bridge egress for providers and no network for commands (ADR-012), the one exception being the dependency-install step: since 05/10/2026 a project’s declared install commands run alone in a short-lived container on Docker `bridge` networking, and lint, typecheck and tests then run sealed with `--network none` against the installed dependencies (`DockerNetworkBoundary` in `apps/worker/src/index.ts`; install commands can run dependency lifecycle scripts, so that container is not sealed); the host executor is test-only.
- A provider CLI inside that image does not nest a sandbox of its own. Codex's landlock/seccomp/user-namespace sandbox cannot initialise without `CAP_SYS_ADMIN` and cost it its shell, so it is given `--dangerously-bypass-approvals-and-sandbox` — and only when the container it is launched into carries `FORGE_EXTERNALLY_SANDBOXED=1` (ADR-030). The Docker boundary is the sandbox; nothing about it is relaxed, and on the host the marker is absent and Codex sandboxes itself as before. Claude needs nothing equivalent: its tool use is gated by `--permission-mode` per role.
- The `ollama` job is the one job that runs in the worker process. It is allowed to because it has no credential, no tools, no file access and no command; it is still subject to the per-task limits and redaction.
- No unauthenticated inbound command endpoint.
- Failed workspaces are retained on the worker's disk for a human with disk access; they are never served.

## Repository safety

- Never edit a dirty user workspace without explicit acknowledgement.
- Use managed clones and isolated worktrees; clean a worktree only after a completed push.
- Scan staged changes for likely secrets, including bearer and JWT shapes.
- Protect default branches; the pipeline opens draft pull requests only. Tier 0 merges only on its allowlist, only Dependabot's PRs, only after green checks and a pre-merge re-check.
- Require passing checks before integration.
- Keep a complete audit trail of commands, approvals, commits and artefacts: the `events` table is a per-run hash chain (ADR-020) and `pnpm forge verify-audit` proves it.

## Retention

- `events` and `audit_tombstones` are append-only by trigger. Retention deletes whole terminal runs after a preview and a confirmation digest, never single events, and writes a tombstone first.
- Raw provider tails live in `worker_jobs.result` for exactly as long as their run.
- Failed workspaces: newest `FORGE_FAILED_WORKSPACE_KEEP` (5) for `FORGE_FAILED_WORKSPACE_MAX_AGE_HOURS` (72), swept at worker start and after each retention; `KEEP=0` disables retention. Treat the directory as containing secrets.
- Outbox files and Tier 0 outcome files are not pruned by the code.
- Notification rows are retained with their run (cascade) or indefinitely when they have no run.

## Prompt-injection defence

Repository and web instructions never override system policy, user approvals, or `AGENTS.md`. Providers receive narrowly scoped tasks and tools; the builder alone may edit, and only inside its worktree. Suspicious instructions are recorded as evidence and ignored. Tool results and every provider completion, cloud or local, are validated against expected schemas and paths. The reviewer's `approved` flag is advisory: approval is decided from the findings and their severities, and a verdict that disagrees is marked `approvedByPolicy` so the disagreement is visible.

## Operator controls

**Kill switch.** `pnpm forge halt --reason="why"` writes the halt file; `pnpm forge status` shows it and, with the coordinator variables, what the coordinator thinks; `pnpm forge resume` removes it. The same three operations exist as `POST/GET/DELETE /api/halt` behind the coordinator token, and a file made by any means counts. A halt refuses every new lease immediately, lets in-flight jobs finish, keeps every worktree, survives a coordinator restart, and ends the moment the file goes. Proven on real processes by `tests/halt.integration.test.ts`. Because it is a file, anyone who can write the directory can halt or resume; fix the `C:\forge` ACL.

**Halt-aware wait.** A job queued when the halt lands waits `FORGE_WORKER_JOB_WAIT_MS` (default 15 minutes) of *active* time while queued, and `FORGE_WORKER_JOB_EXECUTION_MS` once leased; halted time does not count against either, so a halt of any length no longer fails runs that had work queued (`tests/halt.integration.test.ts:403`). The coordinator logs `worker job wait paused` and `resumed` at most once a minute.

**Ceiling.** `FORGE_DAILY_CEILING_USD` (20) per local day in `FORGE_TIMEZONE` (`Australia/Sydney`); `spend.warn` once at `FORGE_CEILING_WARN_FRACTION` (0.75), `spend.ceiling` once at the crossing; both reach Dan through the escalation channels. At the ceiling: planner and critic on `devstral-small-2` through Ollama, builder and reviewer stop the run with a `safety_constraint` blocker. To continue the same day, raise the ceiling in `.env` and restart the coordinator, then retry the run; otherwise wait for the next local day. Codex is unmetered (`usd: 0`) and is still refused at the ceiling. `0` means no cloud calls at all.

**Concurrency.** `FORGE_MAX_AGENTS` (4) leased provider jobs and `FORGE_MIN_FREE_MEMORY_MB` (3072) free on the coordinator host; a refusal is a 204 with `x-forge-lease-refused` and the worker keeps polling. Per job: `FORGE_TASK_MAX_TOOL_CALLS` (200), `FORGE_TASK_MAX_MINUTES` (30), `FORGE_TASK_MAX_TOKENS` (150000); tripping one fails the job with `TASK_LIMIT`.

**When Ollama is down.** The worker probes `FORGE_OLLAMA_URL` once at startup; a worker started while the server is down does not advertise `provider:ollama` and will not until it is restarted. A server that dies mid-request produces a retryable `PROCESS_EXIT`: the stage is retried once, then routed again, which under the ceiling means the planner or critic stage is refused and the run ends `partially_completed` with the reason as its blocker. Nothing is lost: resume the run after the next local day, after raising the ceiling, or after `ollama serve` is back and the worker has been restarted. Check with `curl -s http://127.0.0.1:11434/api/version` and `pnpm forge runtime doctor`. Ollama stopped twice on 26/09/2026 under a sustained benchmark; until it has run a real pipeline stage, treat local routing as best effort and the cloud as the path that is proven.

**Audit.** `pnpm forge verify-audit` after any restore, manual database change, or before trusting a run's history. A break is a security finding: keep the database as it is, back it up, and stop autonomous execution until it is explained.

**Notifications.** `pnpm forge notify-test --channel=<ha|email|file>` proves a channel once its variables exist. Until `FORGE_HA_TOKEN` and `FORGE_SMTP_PASSWORD` exist, only the file outbox delivers; read `<outbox>/<yyyymmdd>/` or the digest.

**Runtime.** Nothing is registered as a Windows task except the two digests. Registering the coordinator and worker (`pnpm runtime:register`) is a Dan-only action gated on `pnpm forge runtime doctor` and on the notification secrets existing, so an unattended failure can reach him.

**Web control centre.** `FORGE_WEB_OPERATOR_PASSWORD` (16+ characters) gates every page and every `/forge-api/*` call (ADR-027); without it the web app answers 503 to everything but `/login`, `/logout` and `/forge-api/health`, never the app. The login form is password-only, accepted only from this origin (the proxy's same-origin rule), and throttled in the web process: five wrong passwords from one address lock it for a minute, fifty from anywhere lock everyone for a minute, and every failure waits 300 ms. The session is a signed, stateless `forge_session` cookie good for 12 hours; "Log out" clears one browser's cookie and nothing else. To sign every browser out, change `FORGE_WEB_SESSION_SECRET` (or the password, when no secret is set) and restart the web app. Serve the app over HTTPS (Tailscale Serve) so the cookie is `Secure`; never publish it to the public internet.

## Incident behaviour

On suspected compromise: write the halt file (`pnpm forge halt --reason=...`), revoke leases, stop workers where possible (`pnpm forge runtime stop`), preserve evidence (do not delete `.failed`, the outbox or the database; take a backup), run `pnpm forge verify-audit`, redact display surfaces, rotate both tokens and any provider or notification secret that may have been read, and provide the user with precise containment and rotation steps. Do not continue autonomous execution through a suspected security boundary failure.
