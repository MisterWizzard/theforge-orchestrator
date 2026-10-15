/**
 * Tier 0 merge policy.
 *
 * Every decision about whether a pull request may be merged lives here, as pure
 * functions over plain data. Nothing in this file performs I/O, so the rules can
 * be tested exhaustively without a network, a repository, or a running system.
 *
 * That separation is the point. A rule enforced only inside a long procedure
 * that also clones repositories and runs installs is a rule nobody can prove.
 */

/** A check the repository defines for itself, and the result of running it. */
export type CheckResult = {
  /** Human-readable label, e.g. "test" or "lint". */
  name: string;
  /** Exact command executed, for evidence. */
  command: string;
  /** Process exit code. Anything other than 0 is a failure. */
  exitCode: number;
  /** Captured output, truncated by the caller. */
  output: string;
};

export type PullRequestFacts = {
  repository: string;
  number: number;
  /** Login of the PR author, e.g. "dependabot[bot]". */
  author: string;
  title: string;
  /** Head commit SHA the checks were actually run against. */
  headSha: string;
  /** GitHub's own mergeability signal. */
  mergeable: boolean;
  /** True when the base branch has moved on and the PR is out of date. */
  behindBase: boolean;
};

export type Tier0Config = {
  /**
   * Repositories where Tier 0 may merge. Everything else is verify-only.
   * Policy B4: `shopfront` to begin with; expansion requires Dan's explicit say-so
   * (B5), never automatic promotion.
   */
  mergeAllowlist: readonly string[];
  /**
   * Authors whose pull requests Tier 0 will consider at all. Tier 0 exists to
   * verify machine-generated dependency bumps, not human work.
   */
  trustedAuthors: readonly string[];
};

export const DEFAULT_CONFIG: Tier0Config = {
  // `PulseApp` added 04/10/2026 on Dan's explicit instruction (policy C20).
  //
  // Recorded honestly: this is a **deliberate exception to Q28's promotion bar** -
  // ten green merges over fourteen days with containerised verification first -
  // and not a case of having met it. He was offered the narrower arrangement, where
  // the pipeline opens pull requests and he merges them, and chose the wider one on
  // the grounds that PulseApp is a portfolio demo and the blast radius is small.
  //
  // Two things were put in place first, because adding a repository here is the
  // moment its own guardrails start to matter:
  //   - PulseApp's `dependabot.yml` had NO major-version ignore rule, unlike
  //     shopfront's. Its first two batches carried 21 major bumps between them, React
  //     18->19 and TypeScript 5->7 among them. The rule is now there, and the
  //     re-raised batches carry none.
  //   - PulseApp's CI had been red on `main` since May - a desynced lock file and
  //     a test fixture that expired on 20/05/2026 - so nothing could ever have been
  //     merged here anyway. Both fixed.
  mergeAllowlist: ['example-org/shopfront', 'example-org/pulse-app'],
  trustedAuthors: ['dependabot[bot]', 'app/dependabot'],
};

export type Decision =
  | { action: 'merge'; reason: string }
  | { action: 'escalate'; reason: string; hint?: string }
  | { action: 'skip'; reason: string }
  | { action: 'verify-only'; reason: string }
  /**
   * The runner's pre-merge re-check found the pull request no longer mergeable
   * or its base moved since the checks ran. Nothing was merged; Dependabot has
   * been asked to rebase and the next Tier 0 run will verify the new head.
   */
  | { action: 'deferred'; reason: string; hint?: string };

/**
 * Attached to escalations whose cause may simply be a stale base (see the note
 * on `shouldRetry`), so that "tests failed" is never read as "this upgrade is
 * unsafe" without checking the base first.
 */
export const STALE_BASE_HINT =
  'A rebase may resolve this: the checks ran against a head whose base branch may since have moved. ' +
  'Comment "@dependabot rebase" on the pull request and let the next Tier 0 run verify the new head before treating the failure as real.';

/**
 * Decide what to do with a pull request given its facts and its check results.
 *
 * Ordering matters and is deliberate: the cheapest and most restrictive
 * disqualifiers are evaluated first, so a repository outside the allowlist can
 * never reach a merge decision regardless of how green its checks are.
 */
export function decide(
  pr: PullRequestFacts,
  checks: readonly CheckResult[],
  config: Tier0Config = DEFAULT_CONFIG,
): Decision {
  if (!config.trustedAuthors.includes(pr.author)) {
    return {
      action: 'skip',
      reason: `author ${pr.author} is not a trusted automated author; Tier 0 only handles machine-generated dependency updates`,
    };
  }

  if (!pr.mergeable) {
    return {
      action: 'escalate',
      reason: 'GitHub reports the pull request is not mergeable, most likely a conflict',
      hint: STALE_BASE_HINT,
    };
  }

  if (pr.behindBase) {
    return {
      action: 'escalate',
      reason: 'the base branch has moved; the checks would not reflect the merged result',
      hint: STALE_BASE_HINT,
    };
  }

  if (checks.length === 0) {
    return {
      action: 'escalate',
      reason: 'no checks were run, so there is no evidence the change is safe',
    };
  }

  const failed = checks.filter((check) => check.exitCode !== 0);
  if (failed.length > 0) {
    return {
      action: 'escalate',
      reason: `${failed.length} of ${checks.length} checks failed: ${failed.map((c) => `${c.name} (exit ${c.exitCode})`).join(', ')}`,
      hint: STALE_BASE_HINT,
    };
  }

  // Policy C6: any version, including major, may merge once checks pass. Tests
  // passing does not prove a major bump is safe - a suite only exercises what it
  // covers - so this is a deliberate, recorded risk, contained by the allowlist
  // being a single low-stakes repository.
  if (!config.mergeAllowlist.includes(pr.repository)) {
    return {
      action: 'verify-only',
      reason: `${pr.repository} is not on the merge allowlist; checks passed but Tier 0 will not merge`,
    };
  }

  return {
    action: 'merge',
    reason: `all ${checks.length} checks passed against ${pr.headSha.slice(0, 8)}`,
  };
}

/**
 * Policy C3: a failing run is retried exactly once before a human is involved.
 * A second failure escalates rather than escalating to the paid AI pipeline,
 * because spending money to investigate should be Dan's choice, not a default.
 *
 * An escalation is not proof the dependency is broken. Observed 2026-09-26:
 * shopfront #2 failed both test and lint, escalated correctly, and was then reopened
 * by Dependabot as #36 after a rebase - at which point the identical bump
 * passed. Its checks had originally run against a base that seven merges had
 * since moved. When escalating, say that a rebase may resolve it, so nobody
 * reads "tests failed" as "this upgrade is unsafe".
 */
export function shouldRetry(attempt: number): boolean {
  return attempt < 2;
}
