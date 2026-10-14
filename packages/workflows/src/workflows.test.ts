import { describe, expect, it } from 'vitest';
import type { Run, Task } from '@theforge/contracts';
import { FakeProvider } from '@theforge/providers';
import {
  blockingFindings,
  buildReviewPrompt,
  LeaseManager,
  OrchestrationRun,
  parseReview,
  renderRepairPrompt,
  retryDelayMs,
  Scheduler,
  WorkerRegistry,
  type ReviewFinding,
} from './index.js';
const now = '2026-07-22T00:00:00.000Z';
const run: Run = {
  id: 'r',
  projectId: 'p',
  objective: 'Build notes',
  constraints: [],
  state: 'created',
  budget: { maxUsd: 10, maxTokens: 1000 },
  spent: { usd: 0, tokens: 0 },
  createdAt: now,
  updatedAt: now,
};
const task = (id: string, deps: string[] = []): Task => ({
  id,
  runId: 'r',
  title: id,
  description: '',
  state: deps.length ? 'queued' : 'ready',
  priority: 1,
  dependencies: deps,
  acceptanceCriteria: ['pass'],
  requiredCapabilities: ['git'],
  fileOwnership: [],
  attempts: 0,
  maxAttempts: 3,
  createdAt: now,
  updatedAt: now,
});
describe('scheduler and recovery', () => {
  it('matches capabilities and budgets', async () => {
    const token = 'x'.repeat(32);
    const registry = new WorkerRegistry(WorkerRegistry.digestToken(token));
    registry.register(
      {
        id: 'w',
        name: 'worker',
        platform: 'linux',
        capabilities: ['git'],
        policyProfile: 'default',
      },
      token,
    );
    const scheduler = new Scheduler(registry, [new FakeProvider()]);
    expect(await scheduler.schedule([task('a')], 0, 1)).toHaveLength(1);
    expect(await scheduler.schedule([task('a')], 0, 0)).toHaveLength(0);
  });
  it('recovers expired leases', () => {
    let time = new Date(now);
    const leases = new LeaseManager({ now: () => time }, 100);
    leases.acquire('t', 'w');
    time = new Date(time.getTime() + 101);
    expect(leases.recoverExpired()).toHaveLength(1);
  });
  it('uses bounded exponential retry backoff', () => {
    expect(retryDelayMs(1, { baseMs: 100, maxMs: 500, jitter: 0 }, () => 0.5)).toBe(100);
    expect(retryDelayMs(4, { baseMs: 100, maxMs: 500, jitter: 0 }, () => 0.5)).toBe(500);
  });
  it('pins a blocked task while a sibling finishes', async () => {
    const orchestration = new OrchestrationRun(run, [task('bad'), task('good')], {
      builder: async (t) => {
        if (t.id === 'bad') throw new Error('external failure');
      },
    });
    const report = await orchestration.execute();
    expect(report.tasks.find((t) => t.id === 'good')?.state).toBe('done');
    expect(report.tasks.find((t) => t.id === 'bad')?.state).toBe('blocked');
    expect(report.run.state).toBe('partially_completed');
  });
  it('bounds repair loops and completes a repaired task', async () => {
    let checks = 0;
    const orchestration = new OrchestrationRun(run, [task('a')], {
      verify: async () => ++checks > 1,
    });
    const report = await orchestration.execute();
    expect(report.run.state).toBe('completed');
    expect(report.repairRounds).toBe(1);
    expect(checks).toBe(2);
  });
  it('blocks a task that still fails after three repairs', async () => {
    let checks = 0;
    const orchestration = new OrchestrationRun(run, [task('a')], {
      verify: async () => {
        checks++;
        return false;
      },
    });
    const report = await orchestration.execute();
    expect(report.run.state).toBe('partially_completed');
    expect(report.tasks[0]?.state).toBe('blocked');
    expect(report.repairRounds).toBe(3);
    expect(checks).toBe(4);
  });
});

describe('parseReview', () => {
  const VERDICT = '{"approved": true, "findings": []}';

  it('accepts a bare terminal verdict', () => {
    expect(parseReview(VERDICT).approved).toBe(true);
  });

  it('accepts a verdict preceded by prose', () => {
    // The exact shape that failed in run fbc717e6: the reviewer narrated before
    // its verdict, and the old terminal-anchored regex missed it entirely.
    const text =
      'The DIFF section is empty. Let me verify against the actual repository\n' +
      'state before concluding.## Review: `formatCount(n)` implementation\n\n' +
      VERDICT;
    expect(parseReview(text).approved).toBe(true);
  });

  it('accepts a verdict followed by trailing prose', () => {
    const text = VERDICT + '\n\nLet me know if you would like anything expanded.';
    expect(parseReview(text).approved).toBe(true);
  });

  it('accepts a verdict inside a markdown fence', () => {
    const text = 'Here is my verdict:\n\n```json\n' + VERDICT + '\n```\n\nDone.';
    expect(parseReview(text).approved).toBe(true);
  });

  it('accepts keys in any order', () => {
    expect(parseReview('{"findings": [], "approved": true}').approved).toBe(true);
  });

  it('takes the last verdict when a model revises itself', () => {
    const text =
      'First pass: {"approved": true, "findings": []}\n' +
      'On reflection that was wrong.\n' +
      '{"approved": false, "findings": [{"severity": "high", "claim": "missed a case", "action": "cover it"}]}';
    const result = parseReview(text);
    expect(result.approved).toBe(false);
    expect(result.findings.map((finding) => finding.claim)).toEqual(['missed a case']);
  });

  it('is not confused by braces inside strings', () => {
    const text = '{"approved": true, "findings": [], "note": "watch for { and } here"}';
    expect(parseReview(text).approved).toBe(true);
  });

  it('withholds approval when a high-severity finding is present', () => {
    const text =
      '{"approved": true, "findings": [{"severity": "high", "claim": "leak", "action": "fix"}]}';
    const result = parseReview(text);
    expect(result.approved).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('withholds approval on a high finding whether or not the reviewer says so', () => {
    const text =
      '{"approved": false, "findings": [{"severity": "high", "claim": "leak", "action": "fix"}]}';
    const result = parseReview(text);
    expect(result.approved).toBe(false);
    expect(result.approvedByPolicy).toBeUndefined();
  });

  it('approves by policy when approval is withheld over low or medium findings only', () => {
    // The first live run: approval withheld over an import split across two
    // lines, which then cost a repair round.
    const text =
      '{"approved": false, "findings": [' +
      '{"severity": "low", "claim": "import split across two lines", "action": "join it"},' +
      '{"severity": "medium", "claim": "helper could be shorter", "action": "shorten it"}]}';
    const result = parseReview(text);
    expect(result.approved).toBe(true);
    expect(result.approvedByPolicy).toBe(true);
    expect(result.findings).toEqual([
      { severity: 'low', claim: 'import split across two lines', action: 'join it' },
      { severity: 'medium', claim: 'helper could be shorter', action: 'shorten it' },
    ]);
  });

  it('does not mark an outright approval as approved by policy', () => {
    expect(parseReview(VERDICT).approvedByPolicy).toBeUndefined();
  });

  it('reads an unknown severity as medium, which does not block', () => {
    const text =
      '{"approved": false, "findings": [{"severity": "blocker", "claim": "x", "action": "y"}]}';
    const result = parseReview(text);
    expect(result.findings[0]?.severity).toBe('medium');
    expect(result.approved).toBe(true);
    expect(result.approvedByPolicy).toBe(true);
  });

  it('reports a missing verdict when the text carries no JSON object', () => {
    const result = parseReview('Looks good to me, ship it.');
    expect(result.approved).toBe(false);
    expect(result.approvedByPolicy).toBeUndefined();
    expect(result.findings[0]?.claim).toBe('Reviewer output lacked a valid verdict');
  });

  it('treats an unbalanced object as an absent verdict', () => {
    const result = parseReview('{"approved": true, ');
    expect(result.approved).toBe(false);
    expect(result.findings[0]?.claim).toBe('Reviewer output lacked a valid verdict');
  });

  it('reports invalid JSON when a balanced object will not parse', () => {
    const result = parseReview("{'approved': true}");
    expect(result.approved).toBe(false);
    expect(result.findings[0]?.claim).toBe('Reviewer verdict JSON was invalid');
  });
});

describe('review prompt constraints', () => {
  const base = {
    objective: 'Add unit tests for src/lib/auth.ts',
    plan: 'step one',
    diff: 'diff --git a/a b/a',
    changedFiles: 'a',
  };

  it('tells the reviewer the constraints, and that breaking one is critical', () => {
    // The reviewer is the last gate before a pull request. It cannot report
    // that a diff broke a stated constraint if it was never told the
    // constraints - which it was not, for the whole life of the project, until
    // 04/10/2026.
    const prompt = buildReviewPrompt({
      ...base,
      constraints: ['Do not modify src/lib/auth.ts', 'Do not add any dependency'],
    });
    expect(prompt).toContain('- Do not modify src/lib/auth.ts');
    expect(prompt).toContain('- Do not add any dependency');
    expect(prompt).toContain('a change that breaks one of these is a critical finding');
  });

  it('says nothing about constraints when the run set none', () => {
    // Byte-for-byte unchanged for a run without constraints, so this cannot
    // alter the behaviour of anything that already worked.
    expect(buildReviewPrompt({ ...base, constraints: [] })).toBe(buildReviewPrompt(base));
    expect(buildReviewPrompt(base)).not.toContain('CONSTRAINTS');
  });
});

describe('review prompts', () => {
  const finding = (severity: ReviewFinding['severity'], claim: string): ReviewFinding => ({
    severity,
    claim,
    action: `fix: ${claim}`,
  });

  it('briefs the reviewer with the scale, the approval rule and the unchanged verdict contract', () => {
    const prompt = buildReviewPrompt({
      objective: 'obj',
      plan: 'plan',
      diff: 'diff --git a/x b/x\n+1\n',
      changedFiles: ' x | 1 +\n',
    });
    expect(prompt).toContain(
      'report only findings the diff supports, and cite the file and the hunk in every claim',
    );
    expect(prompt).toContain(
      '- critical: the change is wrong, unsafe, or violates the objective or a constraint.',
    );
    expect(prompt).toContain(
      '- high: must be fixed before merge - a real defect, a missing test for changed behaviour, or a security or data-loss risk.',
    );
    expect(prompt).toContain('- medium: should be fixed; does not block the merge.');
    expect(prompt).toContain('- low: style, naming, formatting; never blocks.');
    expect(prompt).toContain('Formatting, import ordering, and whitespace are never above low.');
    expect(prompt).toContain('Set "approved" to true when there is no high or critical finding.');
    // The contract parseReview reads, byte for byte as before.
    expect(prompt).toContain(
      'End with a JSON object {"approved":boolean,"findings":[{"severity":"low|medium|high|critical","claim":"...","action":"..."}]}.',
    );
    expect(prompt.endsWith('OBJECTIVE:\nobj\nPLAN:\nplan\nDIFF:\ndiff --git a/x b/x\n+1\n')).toBe(
      true,
    );
    expect(prompt).not.toContain('CHANGED FILES');
  });

  it('cuts a diff over the limit at a line boundary and lists the changed files', () => {
    // Forty lines of 30 bytes each, newline included.
    const lines = Array.from(
      { length: 40 },
      (_, index) => `+line ${String(index).padStart(2, '0')} ${'x'.repeat(20)}`,
    );
    const prompt = buildReviewPrompt({
      objective: 'o',
      plan: 'p',
      diff: `${lines.join('\n')}\n`,
      changedFiles: ' a.ts | 40 +\n',
      limitBytes: 500,
    });
    // The last newline at or before byte 500 ends line 15 (byte 479).
    expect(prompt).toContain(
      'DIFF (diff truncated: first 479 bytes shown, 721 more bytes not shown; the file list below is complete):',
    );
    expect(prompt).toContain(`${lines[15]}\nCHANGED FILES (git diff --stat):\n a.ts | 40 +\n`);
    expect(prompt).not.toContain(lines[16]);
  });

  it('shows a diff at exactly the limit whole', () => {
    const diff = 'x'.repeat(100);
    const prompt = buildReviewPrompt({
      objective: 'o',
      plan: 'p',
      diff,
      changedFiles: '',
      limitBytes: 100,
    });
    expect(prompt.endsWith(`DIFF:\n${diff}`)).toBe(true);
    expect(prompt).not.toContain('diff truncated');
  });

  it('counts bytes rather than characters and never splits a character', () => {
    // Two lines of sixty two-byte characters: 121 bytes each, 122 characters in all.
    const line = 'é'.repeat(60);
    const prompt = buildReviewPrompt({
      objective: 'o',
      plan: 'p',
      diff: `${line}\n${line}\n`,
      changedFiles: '',
      limitBytes: 200,
    });
    expect(prompt).toContain('first 120 bytes shown, 122 more bytes not shown');
    expect(prompt).toContain(`${line}\nCHANGED FILES`);
    expect(prompt).not.toContain('�');
  });

  it('briefs the builder with the blocking findings only, numbered, with claim and action', () => {
    const findings = [
      finding('low', 'import split across two lines'),
      finding('high', 'no test for the new branch'),
      finding('medium', 'helper could be shorter'),
      finding('critical', 'deletes user rows'),
    ];
    expect(blockingFindings(findings).map((item) => item.claim)).toEqual([
      'no test for the new branch',
      'deletes user rows',
    ]);
    const prompt = renderRepairPrompt(findings);
    expect(prompt).toContain('and nothing else');
    expect(prompt).toContain('Do not push.');
    expect(prompt).toContain(
      'BLOCKING FINDINGS (2):\n' +
        '1. [high] no test for the new branch\n   Action: fix: no test for the new branch\n' +
        '2. [critical] deletes user rows\n   Action: fix: deletes user rows',
    );
    expect(prompt).not.toContain('import split across two lines');
    expect(prompt).not.toContain('helper could be shorter');
  });
});
