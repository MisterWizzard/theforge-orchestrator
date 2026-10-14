import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { commandEnvironment, runCommand } from './runner.js';

const scratch = join(process.cwd(), '.forge', 'test-tmp', 'command-environment');

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('commandEnvironment (BLK-015)', () => {
  it('withholds GITHUB_TOKEN and GH_TOKEN so gh uses its own login', () => {
    const env = commandEnvironment({
      PATH: '/bin',
      GITHUB_TOKEN: 'fixture-scoped',
      GH_TOKEN: 'also-scoped',
      FORGE_OUTBOX_DIR: 'C:/forge/outbox',
    });
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env.PATH).toBe('/bin');
    expect(env.FORGE_OUTBOX_DIR).toBe('C:/forge/outbox');
    expect(env.CI).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('runCommand spawns children without the token variables', async () => {
    mkdirSync(scratch, { recursive: true });
    const script = join(scratch, 'print-token.cjs');
    writeFileSync(script, "process.stdout.write(String(process.env.GITHUB_TOKEN ?? 'unset'));\n");
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fixture-scoped';
    try {
      const result = await runCommand(process.execPath, ['print-token.cjs'], scratch);
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe('unset');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});
