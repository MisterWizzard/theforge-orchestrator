import { createDatabase, PostgresForgeRepository } from '@theforge/db';
import { parseArgs, type Command } from '../command.js';

/**
 * The slice of the repository this command needs, so the test suite can hand
 * it a fake and prove the reporting without a database.
 */
export type AuditVerifier = {
  getRun(id: string): Promise<{ id: string } | undefined>;
  listRuns(): Promise<Array<{ id: string }>>;
  verifyEventChain(runId: string): Promise<{
    ok: boolean;
    checked: number;
    legacy: number;
    firstBad?: { sequence: number; reason: string } | undefined;
  }>;
};

export type OpenAuditVerifier = (
  databaseUrl: string,
) => Promise<{ verifier: AuditVerifier; close: () => Promise<void> }>;

type RunResult = { runId: string } & Awaited<ReturnType<AuditVerifier['verifyEventChain']>>;

const openPostgres: OpenAuditVerifier = async (databaseUrl) => {
  const sql = createDatabase(databaseUrl);
  return { verifier: new PostgresForgeRepository(sql), close: () => sql.end() };
};

export function createVerifyAuditCommand(open: OpenAuditVerifier = openPostgres): Command {
  return {
    name: 'verify-audit',
    describe:
      'Recompute the event hash chain of one run (--run) or of every run; exit 1 on any break',
    usage: '[--run=<id>] [--all] [--json]',
    async run(argv, ctx) {
      const { flags } = parseArgs(argv);
      const run = flags.get('run');
      const json = flags.has('json');
      if (run === true) {
        ctx.stderr('forge verify-audit: --run needs a value, for example --run=run-2026-09-26-1');
        return 2;
      }
      if (run && flags.has('all')) {
        ctx.stderr('forge verify-audit: --run and --all exclude each other');
        return 2;
      }
      const databaseUrl = ctx.env.DATABASE_URL;
      if (!databaseUrl) {
        ctx.stderr(
          'forge verify-audit: DATABASE_URL is not set (pnpm forge loads .env from the repository root)',
        );
        return 2;
      }
      const { verifier, close } = await open(databaseUrl);
      try {
        let runIds: string[];
        if (run) {
          if (!(await verifier.getRun(run))) {
            ctx.stderr(`forge verify-audit: run '${run}' was not found`);
            return 2;
          }
          runIds = [run];
        } else {
          runIds = (await verifier.listRuns()).map((item) => item.id);
        }
        const results: RunResult[] = [];
        // One run at a time: each verification reads a whole chain, and an
        // operator wants the first break reported in run order, not by race.
        for (const runId of runIds) {
          results.push({ runId, ...(await verifier.verifyEventChain(runId)) });
        }
        const broken = results.filter((result) => !result.ok);
        if (json) {
          ctx.stdout(JSON.stringify({ ok: broken.length === 0, runs: results }));
        } else {
          for (const result of results) ctx.stdout(describe(result));
          ctx.stdout(
            `${results.length} run(s) checked, ${broken.length} broken` +
              (broken.length === 0 ? '' : ' - the audit log has been altered or lost rows'),
          );
        }
        return broken.length === 0 ? 0 : 1;
      } finally {
        await close();
      }
    },
  };
}

function describe(result: RunResult): string {
  const legacy = result.legacy > 0 ? `, ${result.legacy} pre-chain row(s) skipped` : '';
  if (result.ok) return `run ${result.runId}: ok, ${result.checked} event(s) verified${legacy}`;
  const bad = result.firstBad;
  return (
    `run ${result.runId}: BROKEN at sequence ${bad?.sequence ?? '?'}: ${bad?.reason ?? 'unknown'}` +
    ` (${result.checked} event(s) verified before it${legacy})`
  );
}

export const verifyAuditCommand: Command = createVerifyAuditCommand();
