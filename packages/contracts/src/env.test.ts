import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ENVIRONMENT_REMEDIES,
  EnvironmentError,
  environmentFileArgument,
  formatEnvironmentError,
  normaliseEnvironment,
  parseEnvironment,
} from './env.js';

const schema = z.object({
  FORGE_WORKER_TOKEN: z.string().min(32),
  FORGE_CLAUDE_CREDENTIALS_FILE: z.string().min(1).optional(),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(4400),
});
const token = 'x'.repeat(32);

function capture(run: () => unknown): EnvironmentError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvironmentError) return error;
    throw error;
  }
  throw new Error('expected an EnvironmentError');
}

describe('normaliseEnvironment', () => {
  it('drops empty and undefined values and keeps everything else', () => {
    expect(normaliseEnvironment({ A: 'value', B: '', C: undefined, D: ' ' })).toEqual({
      A: 'value',
      D: ' ',
    });
  });

  it('returns a copy rather than mutating the source', () => {
    const source = { A: 'value', B: '' };
    const normalised = normaliseEnvironment(source);
    normalised.A = 'changed';
    expect(source).toEqual({ A: 'value', B: '' });
  });
});

describe('parseEnvironment', () => {
  it('treats KEY= as unset for optional and defaulted fields', () => {
    const parsed = parseEnvironment(
      schema,
      { FORGE_WORKER_TOKEN: token, FORGE_CLAUDE_CREDENTIALS_FILE: '', HOST: '', PORT: '' },
      'worker',
    );
    expect(parsed).toEqual({ FORGE_WORKER_TOKEN: token, HOST: '127.0.0.1', PORT: 4400 });
    expect(parsed.FORGE_CLAUDE_CREDENTIALS_FILE).toBeUndefined();
  });

  it('throws an EnvironmentError listing one line per variable with its remedy', () => {
    const error = capture(() =>
      parseEnvironment(schema, { FORGE_WORKER_TOKEN: 'short', PORT: 'zero' }, 'worker'),
    );
    expect(error.name).toBe('EnvironmentError');
    expect(error.appName).toBe('worker');
    expect(error.issues.map((issue) => issue.variable)).toEqual(['FORGE_WORKER_TOKEN', 'PORT']);
    const lines = error.message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `FORGE_WORKER_TOKEN: String must contain at least 32 character(s) — ${ENVIRONMENT_REMEDIES.FORGE_WORKER_TOKEN}`,
    );
    expect(lines[1]).toMatch(/^PORT: .+ — a TCP port for the coordinator/);
  });

  it('names a missing required variable', () => {
    const error = capture(() => parseEnvironment(schema, {}, 'coordinator'));
    expect(error.message).toBe(
      "FORGE_WORKER_TOKEN: Required — generate 32+ random characters, e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  });

  it('falls back to a generic remedy for a variable without one', () => {
    const custom = z.object({ MYSTERY: z.string().min(1) });
    expect(() => parseEnvironment(custom, {}, 'test')).toThrow(
      'MYSTERY: Required — set MYSTERY to a valid value in .env (see .env.example)',
    );
  });

  it('keeps several complaints about one variable on one line', () => {
    const custom = z.object({ FORGE_API_URL: z.string().min(10).url() });
    const error = capture(() => parseEnvironment(custom, { FORGE_API_URL: 'nope' }, 'worker'));
    expect(error.message.split('\n')).toHaveLength(1);
    expect(error.message).toMatch(
      /^FORGE_API_URL: String must contain at least 10 character\(s\); Invalid url — the coordinator URL/,
    );
  });
});

describe('environmentFileArgument', () => {
  it('finds --env-file and --env-file-if-exists in either spelling', () => {
    expect(environmentFileArgument(['--env-file-if-exists=../../.env', '--import', 'tsx'])).toBe(
      '../../.env',
    );
    expect(environmentFileArgument(['--env-file', '.env'])).toBe('.env');
    expect(environmentFileArgument(['--import', 'tsx'])).toBeUndefined();
    expect(environmentFileArgument([])).toBeUndefined();
  });
});

describe('formatEnvironmentError', () => {
  const error = new EnvironmentError('coordinator', [
    { variable: 'HOST', message: 'Required', remedy: 'bind somewhere' },
  ]);

  it('leads with the app and the file, then the variable lines', () => {
    expect(formatEnvironmentError(error, 'C:\\forge\\.env').split('\n')).toEqual([
      '[coordinator] Invalid configuration (environment read from C:\\forge\\.env). Fix each variable below in .env, then restart:',
      'HOST: Required — bind somewhere',
    ]);
  });

  it('says so when no file was given', () => {
    expect(formatEnvironmentError(error, undefined)).toContain('no --env-file flag');
  });
});
