import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_REMEDIES, environmentRemedy } from '../packages/contracts/src/env.js';
import {
  CoordinatorEnvironmentSchema,
  loadEnvironment as loadCoordinatorEnvironment,
} from '../apps/coordinator/src/env.js';
import {
  WorkerEnvironmentSchema,
  loadEnvironment as loadWorkerEnvironment,
} from '../apps/worker/src/env.js';

/**
 * `.env.example` is the file every operator starts from, and until now nothing
 * parsed it through the schemas that would reject it. The worker died on it
 * (`KEY=` is the empty string under `--env-file`, which `min(1).optional()`
 * refuses) and the coordinator accepted an empty GITHUB_TOKEN it later treated
 * as missing. This runs the shipped file through both apps exactly as a
 * developer start would, with NODE_ENV forced away from `test` so no test
 * default can paper over a gap. It needs no database: parsing never connects.
 */
const exampleFile = resolve(process.cwd(), '.env.example');
const loaders = {
  coordinator: loadCoordinatorEnvironment,
  worker: loadWorkerEnvironment,
};

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

async function exampleText(): Promise<string> {
  return readFile(exampleFile, 'utf8');
}

async function shippedExample(): Promise<Record<string, string | undefined>> {
  return { ...parseEnv(await exampleText()), NODE_ENV: 'development' };
}

async function completedExample(): Promise<Record<string, string | undefined>> {
  return {
    ...(await shippedExample()),
    FORGE_WORKER_TOKEN: randomToken(),
    FORGE_COORDINATOR_TOKEN: randomToken(),
  };
}

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the environment to be rejected');
}

function without(
  source: Record<string, string | undefined>,
  variable: string,
): Record<string, string | undefined> {
  const copy = { ...source };
  delete copy[variable];
  return copy;
}

describe('.env.example', () => {
  it('is rejected as shipped, naming both placeholder tokens', async () => {
    const source = await shippedExample();
    const coordinator = failure(() => loaders.coordinator(source));
    expect(coordinator.name).toBe('EnvironmentError');
    expect(coordinator.message.split('\n')).toEqual([
      expect.stringMatching(
        /^FORGE_WORKER_TOKEN: String must contain at least 32 character\(s\) — generate 32\+ random characters/,
      ),
      expect.stringMatching(
        /^FORGE_COORDINATOR_TOKEN: String must contain at least 32 character\(s\) — generate 32\+ random characters/,
      ),
    ]);
    const worker = failure(() => loaders.worker(source));
    expect(worker.name).toBe('EnvironmentError');
    expect(worker.message.split('\n')).toEqual([
      expect.stringMatching(
        /^FORGE_WORKER_TOKEN: String must contain at least 32 character\(s\) — generate 32\+ random characters/,
      ),
    ]);
  });

  it('boots both apps once the two placeholder tokens are replaced', async () => {
    const source = await completedExample();
    const coordinator = loaders.coordinator(source);
    expect(coordinator).toMatchObject({
      PORT: 4400,
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://forge:forge@localhost:5432/forge',
      REDIS_URL: 'redis://localhost:6379',
      FORGE_JOB_LEASE_MS: 30_000,
      FORGE_VOLATILE_MODE: 'false',
    });
    expect(coordinator.GITHUB_TOKEN).toBeUndefined();
    const worker = loaders.worker(source);
    expect(worker).toMatchObject({
      FORGE_API_URL: 'http://localhost:4400',
      FORGE_WORKER_EXECUTOR: 'docker',
      FORGE_SANDBOX_IMAGE: 'theforge-worker-sandbox:local',
      FORGE_JOB_HEARTBEAT_MS: 10_000,
    });
    for (const credential of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'FORGE_CLAUDE_CREDENTIALS_FILE',
      'FORGE_CODEX_AUTH_FILE',
    ] as const) {
      expect(worker[credential], credential).toBeUndefined();
    }
  });

  it('accepts an empty optional line as unset', async () => {
    const source = {
      ...(await completedExample()),
      GITHUB_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      FORGE_CLAUDE_CREDENTIALS_FILE: '',
      PORT: '',
    };
    expect(loaders.coordinator(source).GITHUB_TOKEN).toBeUndefined();
    expect(loaders.coordinator(source).PORT).toBe(4400);
    const worker = loaders.worker(source);
    expect(worker.ANTHROPIC_API_KEY).toBeUndefined();
    expect(worker.FORGE_CLAUDE_CREDENTIALS_FILE).toBeUndefined();
  });

  it('names the variable and a remedy when FORGE_WORKER_TOKEN is missing', async () => {
    const source = without(await completedExample(), 'FORGE_WORKER_TOKEN');
    for (const app of ['coordinator', 'worker'] as const) {
      const error = failure(() => loaders[app](source));
      expect(error.name, app).toBe('EnvironmentError');
      expect(error.message, app).toBe(
        "FORGE_WORKER_TOKEN: Required — generate 32+ random characters, e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
  });

  it('does not default the coordinator database outside NODE_ENV=test', async () => {
    const source = without(await completedExample(), 'DATABASE_URL');
    const error = failure(() => loaders.coordinator(source));
    expect(error.message).toContain(
      'DATABASE_URL: DATABASE_URL is required; volatile coordinator state must be explicitly enabled — ',
    );
    expect(
      loaders.coordinator({ ...source, FORGE_VOLATILE_MODE: 'true' }).DATABASE_URL,
    ).toBeUndefined();
  });

  it('bounds queued and executing time separately, with room above the stage timeout', async () => {
    // Attempt eighteen of the first real objective. One variable bounded both
    // phases, and they want opposite values: waiting for a worker should give
    // up early, while a worker that HAS the job needs longer than one stage's
    // wall clock. At 30 minutes each the coordinator cancelled a builder job
    // whose result carried `code: 0` - the run failed with the work done.
    //
    // Asserting the defaults rather than an ordering rule. A rule was tried
    // first and was wrong: a short queue budget under a long stage timeout is
    // the shipped configuration and what the halt integration test exercises,
    // so refusing it would have rejected the product's own setup.
    const env = loaders.coordinator(await completedExample());
    // Queueing gives up early, and keeps the value and meaning it always had.
    expect(env.FORGE_WORKER_JOB_WAIT_MS).toBe(900_000);
    // Executing leaves room above the stage it contains, plus the lease, the
    // workspace materialisation and the transport of the result.
    expect(env.FORGE_WORKER_JOB_EXECUTION_MS).toBeGreaterThan(env.FORGE_STAGE_TIMEOUT_MS);
    // And above the worker's own container deadline, so the coordinator does
    // not give up before the worker's hard kill can report.
    expect(env.FORGE_WORKER_JOB_EXECUTION_MS).toBeGreaterThan(31 * 60_000);
    // The two are independent: shrinking the queue budget must not drag the
    // execution budget down with it, which is the whole point of the split.
    const impatient = loaders.coordinator({
      ...(await completedExample()),
      FORGE_WORKER_JOB_WAIT_MS: '4000',
    });
    expect(impatient.FORGE_WORKER_JOB_WAIT_MS).toBe(4_000);
    expect(impatient.FORGE_WORKER_JOB_EXECUTION_MS).toBeGreaterThan(
      impatient.FORGE_STAGE_TIMEOUT_MS,
    );
  });

  it('mentions every variable either app reads, even the commented-out ones', async () => {
    const documented = new Set(
      // Digits are part of a name (FORGE_OLLAMA_NUM_CTX_TIER1), not a separator.
      [...(await exampleText()).matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((match) => match[1]),
    );
    const read = new Set([
      ...Object.keys(CoordinatorEnvironmentSchema.shape),
      ...Object.keys(WorkerEnvironmentSchema.shape),
    ]);
    expect([...read].filter((variable) => !documented.has(variable))).toEqual([]);
    expect(documented.has('FORGE_WORKER_NAME')).toBe(false);
  });

  it('names a specific remedy for every variable either app reads, so a failed start never points at the generic fallback', () => {
    const read = [
      ...Object.keys(CoordinatorEnvironmentSchema.shape),
      ...Object.keys(WorkerEnvironmentSchema.shape),
    ];
    const generic = read.filter((variable) => !(variable in ENVIRONMENT_REMEDIES));
    expect(generic).toEqual([]);
    for (const variable of read)
      expect(environmentRemedy(variable)).not.toContain('see .env.example');
  });
});
