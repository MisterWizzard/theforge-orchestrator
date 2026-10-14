import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Read DATABASE_URL and REDIS_URL out of `.env`, and nothing else.
 *
 * Four suites guard themselves on `process.env.DATABASE_URL`
 * (`tests/release-acceptance.test.ts`, `tests/worker-loss.integration.test.ts`,
 * `packages/db/src/worker-jobs.test.ts`, `packages/db/src/evidence.test.ts`),
 * and `apps/coordinator/src/server.test.ts` is database-backed without a guard:
 * it imports the live app, which opens PostgreSQL whenever the variable is set
 * and silently falls back to in-memory state when it is not.
 * Vitest never loaded `.env`, so on a developer machine `pnpm test` exited 0
 * reporting "55 passed | 10 skipped" - silently skipping the restart, lease
 * fencing and Docker boundary proofs, which are the tests that matter most.
 * With the variables present the same commit reports 65 passed, 0 skipped.
 * See BLK-008.
 *
 * Deliberately an allowlist rather than a full `.env` load. Loading everything
 * injects FORGE_COORDINATOR_TOKEN and FORGE_WORKER_TOKEN, which breaks five
 * coordinator tests that generate their own and then assert 400 where they
 * would now receive 401.
 *
 * A variable already present in the real environment always wins. The CI
 * `quality` job sets both explicitly and runs everything; the `portable` job
 * (Windows and macOS) runs `pnpm test` with neither, so the database-backed
 * suites skip there and only the warning below records it.
 */
function databaseEnvironmentFromDotEnv(): Record<string, string> {
  const inherited: Record<string, string> = {};
  if (!existsSync('.env')) return inherited;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key !== 'DATABASE_URL' && key !== 'REDIS_URL') continue;
    if (process.env[key]) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (value) inherited[key] = value;
  }
  return inherited;
}

const inheritedEnvironment = databaseEnvironmentFromDotEnv();

// If the database is still unreachable the guarded suites will skip. Say so
// loudly: a silent skip inside an exit-0 run is indistinguishable from a pass,
// which is precisely the failure BLK-008 records.
if (!process.env.DATABASE_URL && !inheritedEnvironment.DATABASE_URL) {
  console.warn(
    '\n[vitest] DATABASE_URL is not set and none was found in .env.\n' +
      '[vitest] The database-backed suites - release acceptance, worker-loss recovery,\n' +
      '[vitest] worker jobs and durable evidence - WILL BE SKIPPED. This run cannot\n' +
      '[vitest] prove restart recovery or lease fencing. Start local infrastructure with\n' +
      '[vitest] `pnpm infra:up` before treating a green result as meaningful.\n',
  );
}

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'], include: ['packages/*/src/**/*.ts'] },
    testTimeout: 20_000,
    env: inheritedEnvironment,
    // Files run in parallel because none of them share database state any
    // more: every test file gets its own PostgreSQL schema (setupFiles) and a
    // run holds an advisory lock on its checkout so a second vitest process,
    // such as a pre-commit hook, fails fast instead of racing it (globalSetup).
    // Before this the shared `public` schema made the gate nondeterministic
    // even with `fileParallelism: false`: a queued job left behind by an
    // earlier run was leased first, oldest first. See BLK-011.
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/isolated-schema.ts'],
    reporters: ['default', 'json'],
    outputFile: { json: '.forge/test-results/vitest.json' },
  },
});
