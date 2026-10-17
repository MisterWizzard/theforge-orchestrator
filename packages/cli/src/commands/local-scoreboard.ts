import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderRequest } from '@theforge/contracts';
import { createDatabase, PostgresForgeRepository } from '@theforge/db';
import { OllamaAdapter } from '@theforge/provider-ollama';
import {
  CONVENTION_FILES,
  criticPrompt,
  plannerPrompt,
  renderConstraintBlock,
  selectRepositoryContext,
  type ContextSection,
  type RepositoryFile,
} from '@theforge/workflows';
import { parseArgs, type Command } from '../command.js';
import { scoreCritique, scorePlan, summarise, type ScoreLine } from '../scoreboard.js';

const run = promisify(execFile);

/**
 * `forge local-scoreboard` (ADR-045, phase 0): how far behind Claude is the local model on this
 * operator's own runs?
 *
 * For recent runs whose plan and critique Claude wrote, the planner and critic prompts are rebuilt
 * with the pipeline's own prompt builders and sent to the local model; both answers are scored on
 * the same rubric (`../scoreboard.ts`). `--skills` turns on the phase-1 playbooks and repository
 * conventions; `--compare` runs without and with them. Nothing is written to the database.
 */

export type HistoricalRun = {
  id: string;
  projectId: string;
  objective: string;
  constraints: string[];
  plan: string;
  critique?: string;
};

export type LocalAnswer = { text: string; seconds: number; outputTokens: number };

export type ScoreboardDeps = {
  loadRuns(limit: number): Promise<HistoricalRun[]>;
  askLocal(request: ProviderRequest, playbooks: boolean): Promise<LocalAnswer>;
  conventionFiles(projectId: string): Promise<RepositoryFile[]>;
  now(): Date;
};

async function loadRunsFromPostgres(databaseUrl: string, limit: number): Promise<HistoricalRun[]> {
  const sql = createDatabase(databaseUrl);
  try {
    const repository = new PostgresForgeRepository(sql);
    const runs = (await repository.listRuns()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const found: HistoricalRun[] = [];
    for (const item of runs) {
      if (found.length >= limit) break;
      const events = await repository.listEvents(item.id);
      const plan = events.find(
        (event) => event.type === 'plan.completed' && event.payload.provider === 'claude',
      );
      if (!plan || typeof plan.payload.plan !== 'string') continue;
      const critique = events.find(
        (event) => event.type === 'critique.completed' && event.payload.provider === 'claude',
      );
      found.push({
        id: item.id,
        projectId: item.projectId,
        objective: item.objective,
        constraints: item.constraints,
        plan: plan.payload.plan,
        ...(critique && typeof critique.payload.critique === 'string'
          ? { critique: critique.payload.critique }
          : {}),
      });
    }
    return found;
  } finally {
    await sql.end();
  }
}

function ollamaAsker(baseUrl: string, model: string) {
  return async (request: ProviderRequest, playbooks: boolean): Promise<LocalAnswer> => {
    const adapter = new OllamaAdapter({ baseUrl, model, numCtx: 16_384, playbooks });
    const started = Date.now();
    let text = '';
    let outputTokens = 0;
    for await (const event of adapter.run(request, { cwd: process.cwd() })) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'usage') outputTokens += event.outputTokens;
      if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
    }
    return { text, seconds: (Date.now() - started) / 1000, outputTokens };
  };
}

/** The project's convention files at the cache's view of origin/main. */
function cacheReader(workspaceRoot: string) {
  return async (projectId: string): Promise<RepositoryFile[]> => {
    const gitDir = join(workspaceRoot, 'cache', `${projectId}.git`);
    const files: RepositoryFile[] = [];
    for (const path of CONVENTION_FILES) {
      try {
        const { stdout } = await run(
          'git',
          ['--git-dir', gitDir, 'show', `refs/remotes/origin/main:${path}`],
          {
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        files.push({ path, content: stdout });
      } catch {
        // absent in this repository
      }
    }
    return files;
  };
}

function request(
  runId: string,
  role: 'planner' | 'critic',
  prompt: string,
  context: ContextSection[],
  model: string,
): ProviderRequest {
  return {
    runId,
    taskId: `${runId}-scoreboard-${role}`,
    role,
    prompt,
    context,
    timeoutMs: 600_000,
    model,
  };
}

export async function runScoreboard(
  deps: ScoreboardDeps,
  options: {
    limit: number;
    model: string;
    variants: Array<'baseline' | 'skills'>;
    roles: Array<'planner' | 'critic'>;
  },
): Promise<ScoreLine[]> {
  const lines: ScoreLine[] = [];
  const runs = await deps.loadRuns(options.limit);
  const conventions = new Map<string, RepositoryFile[]>();
  for (const item of runs) {
    const constraintBlock = renderConstraintBlock(item.constraints);
    // The pipeline's context is `git status --short --branch` of a fresh worktree: a clean tree on
    // the run's branch. This is that output, up to the exact upstream name.
    const status = `## forge/${item.id.slice(0, 8)}`;
    for (const variant of options.variants) {
      let context: ContextSection[] = [];
      if (variant === 'skills') {
        if (!conventions.has(item.projectId))
          conventions.set(item.projectId, await deps.conventionFiles(item.projectId));
        context = selectRepositoryContext(
          conventions.get(item.projectId)!,
          [item.objective, ...item.constraints].join(' '),
        );
      }
      const playbooks = variant === 'skills';
      if (options.roles.includes('planner')) {
        const prompt = plannerPrompt(item.objective, constraintBlock, status);
        lines.push(
          await scoreOne(deps, {
            runId: item.id,
            role: 'planner',
            variant,
            request: request(item.id, 'planner', prompt, context, options.model),
            playbooks,
            claudeText: item.plan,
            score: (text) => scorePlan(text, item),
          }),
        );
      }
      if (options.roles.includes('critic') && item.critique) {
        // The local critic critiques Claude's plan, the same input Claude's critic had.
        const prompt = criticPrompt(constraintBlock, item.plan);
        lines.push(
          await scoreOne(deps, {
            runId: item.id,
            role: 'critic',
            variant,
            request: request(item.id, 'critic', prompt, context, options.model),
            playbooks,
            claudeText: item.critique,
            score: (text) =>
              scoreCritique(text, { plan: item.plan, constraints: item.constraints }),
          }),
        );
      }
    }
  }
  return lines;
}

async function scoreOne(
  deps: ScoreboardDeps,
  job: {
    runId: string;
    role: 'planner' | 'critic';
    variant: string;
    request: ProviderRequest;
    playbooks: boolean;
    claudeText: string;
    score: (text: string) => ScoreLine['claude'];
  },
): Promise<ScoreLine> {
  const { runId, role, variant } = job;
  const claude = job.score(job.claudeText);
  try {
    const answer = await deps.askLocal(job.request, job.playbooks);
    return {
      runId,
      role,
      variant,
      claude,
      local: job.score(answer.text),
      localSeconds: answer.seconds,
      localOutputTokens: answer.outputTokens,
    };
  } catch (error) {
    return {
      runId,
      role,
      variant,
      claude,
      local: { score: 0, max: claude.max, checks: {} },
      localSeconds: 0,
      localOutputTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderScoreboard(lines: readonly ScoreLine[], model: string): string {
  const rows = summarise(lines)
    .map(
      (row) =>
        `| ${row.role} | ${row.variant} | ${row.runs} | ${row.claude.toFixed(2)} | ${row.local.toFixed(2)} | ${row.gap.toFixed(2)} | ${row.meanLocalSeconds} |`,
    )
    .join('\n');
  const failures = lines.filter((line) => line.error);
  const misses = new Map<string, number>();
  for (const line of lines)
    for (const [check, passed] of Object.entries(line.local.checks))
      if (!passed)
        misses.set(
          `${line.role}/${line.variant}: ${check}`,
          (misses.get(`${line.role}/${line.variant}: ${check}`) ?? 0) + 1,
        );
  return [
    `# Local-model scoreboard (${model})`,
    '',
    "Scores are the fraction of rubric checks passed (see packages/cli/src/scoreboard.ts). Claude's column scores the plan and critique it actually wrote for the same run.",
    '',
    '| role | variant | runs | Claude | local | gap | local s |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## Checks the local model missed most',
    '',
    ...[...misses.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([check, count]) => `- ${check}: ${count}`),
    ...(failures.length
      ? [
          '',
          `## Failed calls (${failures.length})`,
          '',
          ...failures.map((line) => `- ${line.runId} ${line.role}/${line.variant}: ${line.error}`),
        ]
      : []),
    '',
  ].join('\n');
}

export function createLocalScoreboardCommand(overrides?: Partial<ScoreboardDeps>): Command {
  return {
    name: 'local-scoreboard',
    describe:
      'Replay recent planner and critic prompts through the local model and score them against what Claude wrote (ADR-045)',
    usage:
      '[--limit=8] [--model=devstral-small-2:latest] [--skills | --compare] [--roles=planner,critic] [--out=<dir>] [--json]',
    async run(argv, ctx) {
      const { flags } = parseArgs(argv);
      const text = (name: string, fallback: string) => {
        const value = flags.get(name);
        return typeof value === 'string' ? value : fallback;
      };
      const limit = Number(text('limit', '8'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        ctx.stderr('forge local-scoreboard: --limit must be a whole number from 1 to 100');
        return 2;
      }
      const model = text('model', 'devstral-small-2:latest');
      const roles = text('roles', 'planner,critic')
        .split(',')
        .filter((role): role is 'planner' | 'critic' => role === 'planner' || role === 'critic');
      const variants: Array<'baseline' | 'skills'> = flags.has('compare')
        ? ['baseline', 'skills']
        : flags.has('skills')
          ? ['skills']
          : ['baseline'];
      const databaseUrl = ctx.env.DATABASE_URL;
      if (!databaseUrl && !overrides?.loadRuns) {
        ctx.stderr(
          'forge local-scoreboard: DATABASE_URL is not set (pnpm forge loads .env from the repository root)',
        );
        return 2;
      }
      const deps: ScoreboardDeps = {
        loadRuns: (n) => loadRunsFromPostgres(databaseUrl!, n),
        askLocal: ollamaAsker(ctx.env.FORGE_OLLAMA_URL ?? 'http://127.0.0.1:11434', model),
        conventionFiles: cacheReader(resolve(ctx.env.FORGE_WORKSPACE_ROOT ?? '.forge/workspaces')),
        now: () => new Date(),
        ...overrides,
      };
      const lines = await runScoreboard(deps, { limit, model, variants, roles });
      const markdown = renderScoreboard(lines, model);
      const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
      const outDir = resolve(
        text('out', join(ctx.env.FORGE_OUTBOX_DIR ?? '.forge/outbox', 'scoreboard')),
      );
      const base = join(outDir, `scoreboard-${stamp}`);
      await mkdir(dirname(base), { recursive: true });
      await writeFile(
        `${base}.json`,
        JSON.stringify({ model, variants, roles, lines, summary: summarise(lines) }, null, 2),
      );
      await writeFile(`${base}.md`, markdown);
      if (flags.has('json')) ctx.stdout(JSON.stringify(summarise(lines)));
      else ctx.stdout(markdown);
      ctx.stdout(`written: ${base}.md`);
      return lines.length === 0 ? 1 : 0;
    },
  };
}

export const localScoreboardCommand = createLocalScoreboardCommand();
