import { describe, expect, it } from 'vitest';
import {
  decide,
  DEFAULT_CONFIG,
  shouldRetry,
  STALE_BASE_HINT,
  type CheckResult,
  type PullRequestFacts,
} from './policy.js';

const pr = (overrides: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  repository: 'MisterWizzard/shopfront',
  number: 26,
  author: 'dependabot[bot]',
  title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
  headSha: 'abcdef1234567890',
  mergeable: true,
  behindBase: false,
  ...overrides,
});

const pass = (name: string): CheckResult => ({
  name,
  command: `pnpm ${name}`,
  exitCode: 0,
  output: 'ok',
});
const fail = (name: string, exitCode = 1): CheckResult => ({
  name,
  command: `pnpm ${name}`,
  exitCode,
  output: 'boom',
});

describe('Tier 0 merge policy', () => {
  it('merges an allowlisted dependency PR whose checks all pass', () => {
    const decision = decide(pr(), [pass('test'), pass('lint')]);
    expect(decision.action).toBe('merge');
  });

  it('allows exactly the two repositories Dan has approved, and no others', () => {
    // Pinned deliberately. Adding a repository here lets Tier 0 merge its pull
    // requests without a human reading them, so it must never happen as a
    // side-effect of some other change: policy B4/B5 wants an explicit say-so, and
    // this assertion is what forces the conversation.
    expect([...DEFAULT_CONFIG.mergeAllowlist].sort()).toEqual([
      'MisterWizzard/PulseApp',
      'MisterWizzard/shopfront',
    ]);
  });

  it('merges an allowlisted repository other than shopfront when green', () => {
    const decision = decide(pr({ repository: 'MisterWizzard/PulseApp' }), [
      pass('test'),
      pass('lint'),
    ]);
    expect(decision.action).toBe('merge');
  });

  it('refuses to merge a repository that is not on the allowlist, even when green', () => {
    // The disqualifier must win over a perfect check run. B4 limits merging to
    // shopfront alone; a green suite elsewhere does not earn a merge.
    const decision = decide(pr({ repository: 'MisterWizzard/game-app' }), [
      pass('test'),
      pass('lint'),
    ]);
    expect(decision.action).toBe('verify-only');
  });

  it('skips pull requests from authors that are not trusted automation', () => {
    const decision = decide(pr({ author: 'MisterWizzard' }), [pass('test')]);
    expect(decision.action).toBe('skip');
  });

  it('checks the author before anything else, so a human PR is never merged', () => {
    // Even fully green, on an allowlisted repo, a human-authored PR is out of
    // scope for Tier 0 entirely.
    const decision = decide(pr({ author: 'someone-else' }), [pass('test'), pass('lint')]);
    expect(decision.action).toBe('skip');
  });

  it('escalates when any single check fails, with the stale-base hint', () => {
    const decision = decide(pr(), [pass('test'), fail('lint')]);
    expect(decision.action).toBe('escalate');
    expect(decision.reason).toContain('lint (exit 1)');
    // shopfront #2 failed both checks against a base seven merges old and passed
    // untouched after Dependabot rebased it; the hint stops that being read
    // as a broken dependency.
    expect(decision).toMatchObject({ hint: STALE_BASE_HINT });
    expect(STALE_BASE_HINT).toContain('@dependabot rebase');
  });

  it('escalates when no checks ran at all, without a rebase hint', () => {
    // An empty check list is the dangerous case: zero failures is not evidence
    // of success. This must never read as a pass, and a rebase would not help.
    const decision = decide(pr(), []);
    expect(decision.action).toBe('escalate');
    expect(decision.reason).toContain('no evidence');
    expect('hint' in decision && decision.hint).toBeFalsy();
  });

  it('escalates an unmergeable pull request without running a merge', () => {
    const decision = decide(pr({ mergeable: false }), [pass('test')]);
    expect(decision.action).toBe('escalate');
    expect(decision).toMatchObject({ hint: STALE_BASE_HINT });
  });

  it('escalates when the branch is behind its base', () => {
    // Checks that passed against a stale base do not describe the merged result.
    const decision = decide(pr({ behindBase: true }), [pass('test')]);
    expect(decision.action).toBe('escalate');
    expect(decision).toMatchObject({ hint: STALE_BASE_HINT });
  });

  it('merges a major version bump when checks pass, per policy C6', () => {
    const decision = decide(pr({ title: 'chore(deps): bump next from 14.0.0 to 15.0.0' }), [
      pass('test'),
      pass('build'),
    ]);
    expect(decision.action).toBe('merge');
  });

  it('reports which commit the evidence belongs to', () => {
    const decision = decide(pr({ headSha: 'deadbeefcafe0000' }), [pass('test')]);
    expect(decision.reason).toContain('deadbeef');
  });
});

describe('Tier 0 retry policy', () => {
  it('retries once and then stops, per policy C3', () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(2)).toBe(false);
    expect(shouldRetry(3)).toBe(false);
  });
});

describe('argument safety', () => {
  it('rejects arguments carrying shell metacharacters', async () => {
    const { assertSafeArgument } = await import('./runner.js');
    for (const bad of [
      'shopfront; rm -rf /',
      'shopfront && curl evil.sh',
      'shopfront | tee out',
      'shopfront`whoami`',
      'shopfront$(id)',
      'shopfront > file',
      'shopfront"quoted"',
    ]) {
      expect(() => assertSafeArgument(bad, 'test')).toThrow(/unsupported characters/);
    }
  });

  it('accepts the shapes Tier 0 legitimately passes', async () => {
    const { assertSafeArgument } = await import('./runner.js');
    for (const good of [
      'MisterWizzard/shopfront',
      '--frozen-lockfile',
      'number,title,author',
      'b7cfc7c9aa11',
      String.raw`C:\Users\operator\tmp\tier0-33`, // a real Windows path, not escape sequences
      '--delete-branch',
    ]) {
      expect(() => assertSafeArgument(good, 'test')).not.toThrow();
    }
  });
});
