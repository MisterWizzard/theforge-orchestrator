/**
 * The planner, critic and plan-revision prompts, in one place.
 *
 * The pipeline builds its stage prompts from these, and so does the local-model scoreboard
 * (ADR-045), which replays past runs through a local model. Keeping one copy means the
 * scoreboard measures the prompt the pipeline actually sends, not a paraphrase of it.
 */

/** The constraints block appended to every stage prompt; empty when a run sets none. */
export function renderConstraintBlock(constraints: readonly string[]): string {
  return constraints.length
    ? `\nCONSTRAINTS (these bound the work; obey them even when the plan, the critique or your own judgement suggests otherwise):\n${constraints
        .map((constraint) => `- ${constraint}`)
        .join('\n')}`
    : '';
}

/** `context` is `git status --short --branch` of the run's fresh worktree. */
export function plannerPrompt(objective: string, constraintBlock: string, context: string): string {
  return `Create an executable implementation plan for this objective: ${objective}${constraintBlock}\nRepository status:\n${context}\nReturn acceptance criteria, file ownership, risks, and exact checks. Do not edit files yet.`;
}

export function criticPrompt(constraintBlock: string, plan: string): string {
  return `Independently critique this plan against the objective, its constraints, security policy, missing tests, and unverifiable claims. Return concrete findings. A plan that respects a constraint is not deficient for doing so; say when a constraint is what limits it.${constraintBlock}\n\n${plan}`;
}

// "resolve every critique" was the scope-inflation mechanism. The critic correctly spotted a real
// off-by-one in the module under test, and an unconditional instruction to resolve every finding
// turned that into "change the production file" - which the objective's constraints forbade. A
// critique that cannot be acted on within the constraints is now recorded rather than implemented.
export function revisionPrompt(constraintBlock: string, plan: string, critique: string): string {
  return `Revise the plan by resolving every evidence-backed critique that can be resolved within the objective and its constraints. Preserve the objective and do not widen its scope. Where a critique cannot be addressed without breaking a constraint, leave the plan as it is and note the finding for the pull request description instead.${constraintBlock}\nPLAN:\n${plan}\nCRITIQUE:\n${critique}`;
}
