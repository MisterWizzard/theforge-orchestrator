/**
 * Role playbooks for local models (ADR-045, phase 1).
 *
 * A local model at the ceiling plans and critiques without tools: it cannot read the repository,
 * run a command or check a path. The cloud planner learns those things by looking. These playbooks
 * tell the local model what a usable answer looks like in this pipeline and how to behave when it
 * cannot look, so the plan or critique it returns can still be used by the builder and the reviewer.
 *
 * Off by default. `FORGE_LOCAL_SKILLS=on` turns them on, after `pnpm forge local-scoreboard` has
 * shown whether they help on the operator's own past runs.
 */
import type { ProviderRequest } from '@theforge/contracts';

export const PLAYBOOKS: Partial<Record<ProviderRequest['role'], string>> = {
  planner: [
    'How to write the plan:',
    '1. Read the CONSTRAINTS first. They override the objective, the critique and your own judgement. If a constraint says only test files may change, every step must touch test files only.',
    '2. Use these headings, in this order: Acceptance criteria, File ownership, Steps, Risks, Checks.',
    '3. Acceptance criteria: numbered, each one something a reviewer can check by reading the diff or running a command.',
    '4. File ownership: every file the builder will create or change, by exact path. Reuse the paths named in the objective exactly.',
    '5. Steps: numbered and small. Say which function or behaviour each step covers.',
    '6. You cannot see the repository. Do not invent file contents, function signatures or test helpers. Where the plan depends on something you have not been shown, write it as "Assumption: ..." so the builder checks it first.',
    '7. Checks: the exact commands that prove the work, using the repository scripts shown in the context when there are any (for example `npm run test`, `npm run lint`, `npm run format:check`). Include the formatter check if the repository has one.',
    '8. Keep it short. No introduction, no summary of the objective, no closing remarks.',
  ].join('\n'),
  critic: [
    'How to write the critique:',
    '1. Return numbered findings. Each finding: a severity (blocker, should-fix or nit), the part of the plan it concerns, what is wrong, and the exact change that would fix it.',
    '2. Check, in this order: the CONSTRAINTS (does any step break one?), the acceptance criteria (can each be verified?), tests (missing cases, weak assertions, tests that need a database or the network when a constraint forbids it), file paths (do they match the objective?), the checks (is the formatter and lint covered?), and security.',
    '3. A limitation that a constraint imposes is not a defect. Say so instead of raising it.',
    '4. You cannot see the repository. Flag claims the plan makes about code it has not shown, and ask for them to be verified rather than asserting they are wrong.',
    '5. If the plan is sound, say so in one line and list at most two nits. Do not approve without saying why.',
  ].join('\n'),
};

/** The playbook for a role, or undefined when the role has none. */
export function playbookFor(role: ProviderRequest['role']): string | undefined {
  return PLAYBOOKS[role];
}
