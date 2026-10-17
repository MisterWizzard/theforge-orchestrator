import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { criticPrompt, plannerPrompt, renderConstraintBlock, revisionPrompt } from './prompts.js';
import { readConventionFiles, selectRepositoryContext } from './repo-context.js';

describe('selectRepositoryContext', () => {
  const files = [
    {
      path: 'package.json',
      content: JSON.stringify({
        scripts: { test: 'vitest run', 'format:check': 'prettier --check .' },
      }),
    },
    {
      path: 'AGENTS.md',
      content: [
        '# Deployment',
        'Deploys go through Vercel previews and are promoted by hand.',
        '# Tests',
        'Unit tests live next to the module as *.test.ts and use vitest. Never touch the database in a unit test.',
      ].join('\n'),
    },
  ];

  it('puts the package scripts first and picks the passage the objective is about', () => {
    const context = selectRepositoryContext(files, 'Add unit tests for src/lib/content/aeo.ts');
    expect(context[0]).toEqual({
      label: 'package.json scripts',
      content: 'test: vitest run\nformat:check: prettier --check .',
    });
    expect(context.map((section) => section.label)).toContain('AGENTS.md - Tests');
    expect(context.map((section) => section.label)).not.toContain('AGENTS.md - Deployment');
  });

  it('stays within the character budget', () => {
    const long = { path: 'README.md', content: `# Tests\n${'unit tests vitest '.repeat(400)}` };
    const context = selectRepositoryContext([long], 'unit tests', 2_000);
    expect(context.reduce((sum, section) => sum + section.content.length, 0)).toBeLessThanOrEqual(
      2_000,
    );
  });

  it('returns nothing for a repository with no convention files', () => {
    expect(selectRepositoryContext([], 'anything')).toEqual([]);
  });
});

describe('readConventionFiles', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reads the files that exist and skips the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'conventions-'));
    await writeFile(join(dir, 'README.md'), '# Readme');
    const files = await readConventionFiles(dir);
    expect(files.map((file) => file.path)).toEqual(['README.md']);
  });
});

describe('the shared stage prompts', () => {
  // The pipeline sends these exact strings; the scoreboard replays them (ADR-045).
  it('renders the constraints block, or nothing', () => {
    expect(renderConstraintBlock([])).toBe('');
    expect(renderConstraintBlock(['a', 'b'])).toBe(
      '\nCONSTRAINTS (these bound the work; obey them even when the plan, the critique or your own judgement suggests otherwise):\n- a\n- b',
    );
  });

  it('keeps the planner, critic and revision wording the pipeline has always sent', () => {
    expect(plannerPrompt('do X', '', '## main')).toBe(
      'Create an executable implementation plan for this objective: do X\nRepository status:\n## main\nReturn acceptance criteria, file ownership, risks, and exact checks. Do not edit files yet.',
    );
    expect(criticPrompt('', 'PLAN')).toBe(
      'Independently critique this plan against the objective, its constraints, security policy, missing tests, and unverifiable claims. Return concrete findings. A plan that respects a constraint is not deficient for doing so; say when a constraint is what limits it.\n\nPLAN',
    );
    expect(revisionPrompt('', 'P', 'C')).toBe(
      'Revise the plan by resolving every evidence-backed critique that can be resolved within the objective and its constraints. Preserve the objective and do not widen its scope. Where a critique cannot be addressed without breaking a constraint, leave the plan as it is and note the finding for the pull request description instead.\nPLAN:\nP\nCRITIQUE:\nC',
    );
  });
});
