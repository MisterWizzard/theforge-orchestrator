# Product Vision

## North star

TheForge turns an imprecise human objective into verified completed work by coordinating multiple AI agents, repositories, tools, and device workers through a durable, auditable process.

The user supplies intent. TheForge supplies decomposition, execution, critique, repair, verification, and a concise final account.

## Primary user

The initial user is a technically capable solo builder managing many products across Windows, macOS, Linux, remote machines, GitHub, Claude, and Codex. The interface must minimise supervision without concealing uncertainty or risk.

## Core outcomes

TheForge succeeds when it can:

1. accept a rough feature or project objective;
2. inspect relevant repository and project context;
3. create an executable specification and dependency graph;
4. assign complementary roles to Claude and Codex;
5. run work in isolated branches or worktrees;
6. continue independent work when one task is blocked;
7. collect review and verification evidence;
8. produce a tested pull request or an exact residual-work report;
9. resume safely after process, provider, or machine failure;
10. preserve enough durable memory that a new agent session can continue immediately.

## Product principles

- **Completion over conversation.** Discussion exists to advance work.
- **Evidence over confidence.** Assertions do not count as verification.
- **Durable state over chat memory.** Runs, tasks, decisions, blockers, and artefacts persist.
- **Bounded autonomy.** Agents can act broadly inside safe, reversible boundaries.
- **Provider neutrality.** Claude and Codex are adapters, not the domain model.
- **Graceful degradation.** A failed provider, worker, or task does not collapse the whole run.
- **Useful interruption.** Human questions contain options, consequences, evidence, and a recommendation.
- **Reversibility.** Work occurs in branches, worktrees, sandboxes, and transaction-safe operations.

## Initial release definition

The initial release is complete only when a user can connect a GitHub repository, submit a real objective, and TheForge autonomously:

- creates a run and plan;
- obtains an independent critique;
- revises the plan;
- implements the change through at least one provider;
- reviews it through the other provider or an independent role;
- runs relevant checks;
- performs bounded repairs;
- creates a draft pull request;
- displays evidence, costs, activity, decisions, and blockers in the web UI;
- survives a coordinator restart without losing the run.

## Explicit non-goals for the initial release

- replacing IDEs;
- controlling desktop applications as the primary integration;
- autonomous production deployment;
- billing or a public marketplace;
- multi-tenant enterprise administration;
- arbitrary consumer-computer control;
- supporting every model provider;
- perfect general intelligence or unbounded self-improvement.

## Longer-term direction

After the initial release is proven, TheForge may become a personal engineering operating system with reusable organisational memory, scheduled maintenance, cross-project dependency awareness, specialised agent teams, remote mobile control, and safe production operations.