/**
 * The local-model scoreboard's rubric (ADR-045, phase 0).
 *
 * Each check is a plain property of the text that the next stage depends on: a plan the builder can
 * follow names its files, its acceptance criteria and the exact commands that prove it; a critique
 * the planner can act on has concrete, grounded findings. The checks are deliberately simple and
 * deterministic, so a score is reproducible and two answers to the same prompt are scored the same
 * way, whoever wrote them. A high score does not prove a good plan; a low one reliably finds a
 * plan the builder would have to guess around.
 */

export type RubricResult = {
  score: number;
  max: number;
  /** Check name to passed. */
  checks: Record<string, boolean>;
};

const PATH = /(?:[\w@-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|yml|yaml|css|sql)\b/g;
const COMMAND =
  /\b(?:npm|pnpm|yarn|npx|bun|vitest|jest|tsc|eslint|prettier|pytest|go test|cargo)\b/;
const TEST_ONLY =
  /not a test file|only (?:the )?test files|test files? only|only add (?:a )?tests?/i;
const CHANGE_VERB = /\b(?:modify|change|edit|update|refactor|fix|rewrite|alter)\b/i;
const NEGATION =
  /\b(?:do not|don't|must not|never|no changes? to|without (?:changing|modifying)|unchanged|leave)\b/i;
const TEST_PATH = /(?:test|spec|__tests__|fixtures?)/i;

function result(checks: Record<string, boolean>): RubricResult {
  const values = Object.values(checks);
  return { score: values.filter(Boolean).length, max: values.length, checks };
}

/** Paths an objective names, which a plan for it should name too. */
export function pathsIn(text: string): string[] {
  return [...new Set(text.match(PATH) ?? [])];
}

/** A line that proposes changing a non-test file, when the run allows only test files. */
function breaksTestOnly(plan: string): boolean {
  return plan.split(/\r?\n/).some((line) => {
    if (!CHANGE_VERB.test(line) || NEGATION.test(line)) return false;
    const paths = line.match(PATH) ?? [];
    return paths.some((path) => !TEST_PATH.test(path));
  });
}

export function scorePlan(
  plan: string,
  run: { objective: string; constraints: readonly string[] },
): RubricResult {
  const targets = pathsIn(run.objective);
  const testOnly = run.constraints.some((constraint) => TEST_ONLY.test(constraint));
  return result({
    acceptanceCriteria: /acceptance criteria/i.test(plan),
    fileOwnership: /file ownership|files? to (?:create|change|add)|new files?\b/i.test(plan),
    risks: /\brisks?\b/i.test(plan),
    exactChecks: COMMAND.test(plan),
    namesTargets: targets.every((target) => plan.includes(target)),
    respectsTestOnly: !testOnly || !breaksTestOnly(plan),
    sizeUsable: plan.trim().length >= 300 && plan.length <= 12_000,
  });
}

function listItems(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
}

/** Identifiers and paths that are distinctive enough to show a critique read the plan. */
function distinctiveTerms(text: string): Set<string> {
  const found = text.match(/[A-Za-z_][\w]*(?:[.(/][\w./-]+)+|\b[a-z]+[A-Z]\w+\b/g) ?? [];
  return new Set(found.map((term) => term.replace(/[().,;:]+$/, '')));
}

export function scoreCritique(
  critique: string,
  run: { plan: string; constraints: readonly string[] },
): RubricResult {
  const planTerms = distinctiveTerms(run.plan);
  const shared = [...distinctiveTerms(critique)].filter((term) => planTerms.has(term)).length;
  return result({
    concreteFindings: listItems(critique) >= 2,
    groundedInPlan: shared >= 2,
    coversTests: /\btests?\b/i.test(critique),
    constraintAware: run.constraints.length === 0 || /constraint/i.test(critique),
    severityStated:
      /\b(?:blocker|should-fix|must|nit|critical|high|medium|low|major|minor)\b/i.test(critique),
    notRubberStamp: !(
      critique.trim().length < 400 && /looks good|lgtm|no (?:issues|findings)/i.test(critique)
    ),
  });
}

export type ScoreLine = {
  runId: string;
  role: 'planner' | 'critic';
  variant: string;
  claude: RubricResult;
  local: RubricResult;
  localSeconds: number;
  localOutputTokens: number;
  error?: string;
};

/** Per role and variant: mean score as a fraction of the maximum, for Claude and for the local model. */
export function summarise(lines: readonly ScoreLine[]): Array<{
  role: string;
  variant: string;
  runs: number;
  claude: number;
  local: number;
  gap: number;
  meanLocalSeconds: number;
}> {
  const groups = new Map<string, ScoreLine[]>();
  for (const line of lines) {
    if (line.error) continue;
    const key = `${line.role}\u0000${line.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const fraction = (r: RubricResult) => (r.max === 0 ? 0 : r.score / r.max);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  return [...groups.entries()].map(([key, group]) => {
    const [role, variant] = key.split('\u0000') as [string, string];
    const claude = mean(group.map((line) => fraction(line.claude)));
    const local = mean(group.map((line) => fraction(line.local)));
    return {
      role,
      variant,
      runs: group.length,
      claude: Math.round(claude * 100) / 100,
      local: Math.round(local * 100) / 100,
      gap: Math.round((claude - local) * 100) / 100,
      meanLocalSeconds: Math.round(mean(group.map((line) => line.localSeconds))),
    };
  });
}
