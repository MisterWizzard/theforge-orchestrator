import { describe, expect, it } from 'vitest';
import type { ProviderRequest } from '@theforge/contracts';
import {
  renderScoreboard,
  runScoreboard,
  type ScoreboardDeps,
} from './commands/local-scoreboard.js';
import { pathsIn, scoreCritique, scorePlan, summarise } from './scoreboard.js';

const run = {
  objective: 'Add unit tests for src/lib/content/aeo.ts, which currently has none.',
  constraints: ['Do not modify any file that is not a test file.'],
};

const goodPlan = [
  '## Acceptance criteria',
  '1. getLocation returns the entry for a known slug and undefined for an unknown one.',
  '## File ownership',
  '- Create src/lib/content/aeo.test.ts (new file). Do not modify src/lib/content/aeo.ts.',
  '## Steps',
  '1. Import the three lookups from src/lib/content/aeo.ts and cover each with a known and an unknown slug.',
  '## Risks',
  '- Slugs may change; assert against the exported arrays rather than literals.',
  '## Checks',
  '- npm run test',
  '- npm run lint',
  '- npm run format:check',
].join('\n');

describe('scorePlan', () => {
  it('passes every check for a plan the builder can follow', () => {
    const scored = scorePlan(goodPlan, run);
    expect(scored.checks).toEqual({
      acceptanceCriteria: true,
      fileOwnership: true,
      risks: true,
      exactChecks: true,
      namesTargets: true,
      respectsTestOnly: true,
      sizeUsable: true,
    });
    expect(scored.score).toBe(scored.max);
  });

  it('catches a plan that changes a production file when only tests may change', () => {
    const plan = `${goodPlan}\n- Refactor src/lib/content/aeo.ts to export the slug list.`;
    expect(scorePlan(plan, run).checks.respectsTestOnly).toBe(false);
  });

  it('does not count a sentence that says not to change the production file', () => {
    expect(scorePlan(goodPlan, run).checks.respectsTestOnly).toBe(true);
  });

  it('marks a vague plan down on every structural check', () => {
    const scored = scorePlan(
      'Write some tests for the content module and make sure they pass.',
      run,
    );
    expect(scored.score).toBe(1); // only respectsTestOnly, which a plan that changes nothing passes
  });

  it('finds the paths an objective names', () => {
    expect(pathsIn(run.objective)).toEqual(['src/lib/content/aeo.ts']);
  });
});

describe('scoreCritique', () => {
  const critique = [
    '1. should-fix: the plan never tests getGuide with an unknown slug; add that case.',
    '2. nit: src/lib/content/aeo.test.ts should follow the existing tests in src/lib.',
    'The constraint against editing src/lib/content/aeo.ts is respected.',
  ].join('\n');

  it('passes a grounded, concrete critique', () => {
    const scored = scoreCritique(critique, { plan: goodPlan, constraints: run.constraints });
    expect(scored.score).toBe(scored.max);
  });

  it('fails a rubber stamp', () => {
    const scored = scoreCritique('Looks good to me.', {
      plan: goodPlan,
      constraints: run.constraints,
    });
    expect(scored.checks.notRubberStamp).toBe(false);
    expect(scored.checks.concreteFindings).toBe(false);
  });
});

describe('runScoreboard', () => {
  const deps = (
    answers: Record<string, string>,
  ): ScoreboardDeps & { requests: ProviderRequest[]; playbookFlags: boolean[] } => {
    const requests: ProviderRequest[] = [];
    const playbookFlags: boolean[] = [];
    return {
      requests,
      playbookFlags,
      loadRuns: async () => [
        {
          id: 'run-1',
          projectId: 'project-x',
          objective: run.objective,
          constraints: run.constraints,
          plan: goodPlan,
          critique: 'Looks good.',
        },
      ],
      askLocal: async (req, playbooks) => {
        requests.push(req);
        playbookFlags.push(playbooks);
        return { text: answers[req.role] ?? '', seconds: 2, outputTokens: 100 };
      },
      conventionFiles: async () => [
        {
          path: 'package.json',
          content: JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }),
        },
        {
          path: 'AGENTS.md',
          content: '# Tests\nUnit tests live next to the module as *.test.ts and use vitest.',
        },
      ],
      now: () => new Date('2026-10-17T00:00:00Z'),
    };
  };

  it('replays the pipeline prompts and scores both answers on the same rubric', async () => {
    const d = deps({ planner: goodPlan, critic: 'Looks good.' });
    const lines = await runScoreboard(d, {
      limit: 5,
      model: 'devstral-small-2:latest',
      variants: ['baseline'],
      roles: ['planner', 'critic'],
    });
    expect(lines.map((line) => line.role)).toEqual(['planner', 'critic']);
    expect(d.requests[0]!.prompt).toContain(
      'Create an executable implementation plan for this objective:',
    );
    expect(d.requests[0]!.prompt).toContain('CONSTRAINTS');
    // The local critic is given Claude's plan, the same input Claude's critic had.
    expect(d.requests[1]!.prompt).toContain('## Acceptance criteria');
    expect(d.requests.every((req) => req.context.length === 0)).toBe(true);
    expect(d.playbookFlags).toEqual([false, false]);
    expect(lines[0]!.local.score).toBe(lines[0]!.local.max);
  });

  it('adds the playbooks and the repository conventions only for the skills variant', async () => {
    const d = deps({ planner: goodPlan, critic: 'Looks good.' });
    await runScoreboard(d, {
      limit: 5,
      model: 'm',
      variants: ['baseline', 'skills'],
      roles: ['planner'],
    });
    expect(d.playbookFlags).toEqual([false, true]);
    expect(d.requests[0]!.context).toEqual([]);
    expect(d.requests[1]!.context.map((section) => section.label)).toContain(
      'package.json scripts',
    );
  });

  it('records a failed local call instead of stopping the board', async () => {
    const d = deps({});
    d.askLocal = async () => {
      throw new Error('ollama unreachable');
    };
    const lines = await runScoreboard(d, {
      limit: 5,
      model: 'm',
      variants: ['baseline'],
      roles: ['planner'],
    });
    expect(lines[0]!.error).toBe('ollama unreachable');
    expect(summarise(lines)).toEqual([]);
    expect(renderScoreboard(lines, 'm')).toContain('Failed calls (1)');
  });
});
