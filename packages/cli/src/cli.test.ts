import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowEventDeletion, createDatabase, PostgresForgeRepository } from '@theforge/db';
import type { CommandContext } from './command.js';
import { commands } from './commands/index.js';
import { haltCommand } from './commands/halt.js';
import {
  createVerifyAuditCommand,
  verifyAuditCommand,
  type AuditVerifier,
} from './commands/verify-audit.js';
import { createRegistry } from './registry.js';

type Call = { url: string; authorization?: string };

function harness(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch:
      fetch ??
      (() => {
        throw new Error('this command must not reach for the network');
      }),
  };
  return { out, err, run: (argv: string[]) => createRegistry(commands).run(argv, ctx) };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeCoordinator(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url,
      ...(headers?.authorization ? { authorization: headers.authorization } : {}),
    });
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!route) throw new Error(`no fake route for ${url}`);
    return route[1]();
  };
  return { calls, fetch };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-cli-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('command registry', () => {
  it('lists every command, and rejects an unknown one with usage', async () => {
    const { run, out, err } = harness({});
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('usage: forge <command>');
    for (const name of [
      'halt',
      'resume',
      'status',
      'notify-test',
      'tier0-ingest',
      'ci-watch',
      'node-watch',
    ])
      expect(err.join('\n')).toContain(name);

    expect(await run(['help'])).toBe(0);
    expect(out.join('\n')).toContain('usage: forge <command>');

    err.length = 0;
    expect(await run(['nope'])).toBe(2);
    expect(err[0]).toContain("unknown command 'nope'");
  });

  it('refuses two commands with the same name', () => {
    expect(() => createRegistry([haltCommand, haltCommand])).toThrow(/duplicate/);
  });
});

describe('halt and resume', () => {
  it('writes the file where FORGE_HALT_FILE points and removes it again', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const { run, out } = harness({ FORGE_HALT_FILE: haltFile });

    expect(await run(['halt', '--reason=disk nearly full'])).toBe(0);
    expect(existsSync(haltFile)).toBe(true);
    expect(JSON.parse(await readFile(haltFile, 'utf8'))).toMatchObject({
      requestedBy: 'cli',
      reason: 'disk nearly full',
    });
    expect(out[0]).toBe(`halted; halt file written: ${haltFile}`);
    expect(out[1]).toBe('reason: disk nearly full');

    out.length = 0;
    expect(await run(['halt'])).toBe(0);
    expect(out[0]).toMatch(/^already halted since .* \(cli\); halt file rewritten:/);

    out.length = 0;
    expect(await run(['resume'])).toBe(0);
    expect(existsSync(haltFile)).toBe(false);
    expect(out[0]).toBe(`resumed; halt file removed: ${haltFile}`);

    out.length = 0;
    expect(await run(['resume'])).toBe(0);
    expect(out[0]).toBe(`not halted; no halt file at ${haltFile}`);
  });

  it('defaults to the file beside the workspace root, creating the parent if needed', async () => {
    // Mirrors the coordinator's default so the two agree without configuration
    // when they share a working directory.
    const workspaceRoot = join(directory, 'nested', '.forge', 'workspaces');
    const { run, out } = harness({ FORGE_WORKSPACE_ROOT: workspaceRoot });
    expect(await run(['halt'])).toBe(0);
    const expected = join(directory, 'nested', '.forge', 'FORGE_HALT');
    expect(existsSync(expected)).toBe(true);
    expect(out[0]).toContain(expected);
  });

  it('rejects --reason without a value', async () => {
    const { run, err } = harness({ FORGE_HALT_FILE: join(directory, 'FORGE_HALT') });
    expect(await run(['halt', '--reason'])).toBe(2);
    expect(err[0]).toContain('--reason needs a value');
    expect(existsSync(join(directory, 'FORGE_HALT'))).toBe(false);
  });
});

describe('status', () => {
  it('reports the local file and skips the coordinator without credentials', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const { run, out } = harness({ FORGE_HALT_FILE: haltFile });
    expect(await run(['status'])).toBe(0);
    expect(out).toEqual([
      'halted: no',
      `halt file: ${haltFile} (absent)`,
      'coordinator: not queried (set FORGE_API_URL and FORGE_COORDINATOR_TOKEN to include it)',
    ]);

    await run(['halt', '--reason=because']);
    out.length = 0;
    expect(await run(['status'])).toBe(0);
    expect(out[0]).toBe('halted: yes');
    expect(out[1]).toBe(`halt file: ${haltFile}`);
    expect(out[2]).toMatch(/^requested: .* by cli$/);
    expect(out[3]).toBe('reason: because');

    // A bare file, as an operator's `touch` would leave it.
    await writeFile(haltFile, '', 'utf8');
    out.length = 0;
    expect(await run(['status'])).toBe(0);
    expect(out[0]).toBe('halted: yes');
    expect(out[2]).toContain('made by hand');
  });

  it('queries /health and /api/halt with the token, and warns when the paths differ', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const coordinator = fakeCoordinator({
      '/health': () => jsonResponse({ status: 'ok' }),
      '/api/halt': () =>
        jsonResponse({
          halted: true,
          source: 'file',
          haltFile: join(directory, 'elsewhere', 'FORGE_HALT'),
          request: { requestedAt: 't', requestedBy: 'api' },
        }),
    });
    const { run, out, err } = harness(
      {
        FORGE_HALT_FILE: haltFile,
        FORGE_API_URL: 'http://127.0.0.1:4400/',
        FORGE_COORDINATOR_TOKEN: 'test-coordinator-token-that-is-long-enough',
      },
      coordinator.fetch,
    );
    expect(await run(['status'])).toBe(0);
    expect(coordinator.calls).toEqual([
      { url: 'http://127.0.0.1:4400/health' },
      {
        url: 'http://127.0.0.1:4400/api/halt',
        authorization: 'Bearer test-coordinator-token-that-is-long-enough',
      },
    ]);
    expect(out).toContain('coordinator health: ok');
    expect(out).toContain('coordinator halted: yes (source: file)');
    expect(out).toContain(`coordinator halt file: ${join(directory, 'elsewhere', 'FORGE_HALT')}`);
    expect(err[0]).toContain('different path than this CLI');
  });

  it('stays quiet about the path when the coordinator agrees, and survives an unreachable one', async () => {
    const haltFile = join(directory, 'FORGE_HALT');
    const agreeing = fakeCoordinator({
      '/health': () => jsonResponse({ status: 'ok' }),
      '/api/halt': () => jsonResponse({ halted: false, source: 'none', haltFile }),
    });
    const env = {
      FORGE_HALT_FILE: haltFile,
      FORGE_API_URL: 'http://127.0.0.1:4400',
      FORGE_COORDINATOR_TOKEN: 'test-coordinator-token-that-is-long-enough',
    };
    const agreed = harness(env, agreeing.fetch);
    expect(await agreed.run(['status'])).toBe(0);
    expect(agreed.out).toContain('coordinator halted: no');
    expect(agreed.err).toEqual([]);

    const down = harness(env, async () => {
      throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
    });
    expect(await down.run(['status'])).toBe(0);
    expect(down.out.at(-1)).toBe(
      'coordinator: unreachable at http://127.0.0.1:4400 (fetch failed: ECONNREFUSED)',
    );
  });
});

describe('verify-audit', () => {
  type Verdict = Awaited<ReturnType<AuditVerifier['verifyEventChain']>>;
  function fakeDatabase(chains: Record<string, Verdict>) {
    const opened: string[] = [];
    let closed = 0;
    const verifier: AuditVerifier = {
      getRun: async (id) => (id in chains ? { id } : undefined),
      listRuns: async () => Object.keys(chains).map((id) => ({ id })),
      verifyEventChain: async (runId) => {
        const verdict = chains[runId];
        if (!verdict) throw new Error(`fake verifier has no run ${runId}`);
        return verdict;
      },
    };
    const command = createVerifyAuditCommand(async (url) => {
      opened.push(url);
      return {
        verifier,
        close: async () => {
          closed += 1;
        },
      };
    });
    const run = (
      argv: string[],
      env: Record<string, string | undefined> = { DATABASE_URL: 'postgres://fake' },
    ) => {
      const { out, err } = harness(env);
      const ctx: CommandContext = {
        env,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        fetch: () => {
          throw new Error('unused');
        },
      };
      return createRegistry([command])
        .run(['verify-audit', ...argv], ctx)
        .then((code) => ({ code, out, err, opened, closed }));
    };
    return { run };
  }
  const intact: Verdict = { ok: true, checked: 12, legacy: 0 };
  const broken: Verdict = {
    ok: false,
    checked: 4,
    legacy: 0,
    firstBad: {
      sequence: 907,
      reason: 'row_hash abc does not match the row content (recomputed def)',
    },
  };

  it('refuses to start without DATABASE_URL and never opens a connection', async () => {
    const result = await fakeDatabase({ 'run-a': intact }).run([], {});
    expect(result.code).toBe(2);
    expect(result.err[0]).toContain('DATABASE_URL is not set');
    expect(result.opened).toEqual([]);
  });

  it('verifies every run by default, reports each, and exits 0 when all are intact', async () => {
    const result = await fakeDatabase({
      'run-a': intact,
      'run-b': { ok: true, checked: 3, legacy: 2 },
    }).run([]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'run run-a: ok, 12 event(s) verified',
      'run run-b: ok, 3 event(s) verified, 2 pre-chain row(s) skipped',
      '2 run(s) checked, 0 broken',
    ]);
    expect(result.opened).toEqual(['postgres://fake']);
    expect(result.closed).toBe(1);
  });

  it('exits 1 and names the first bad sequence with its reason', async () => {
    const result = await fakeDatabase({ 'run-a': intact, 'run-b': broken }).run(['--all']);
    expect(result.code).toBe(1);
    expect(result.out[1]).toBe(
      'run run-b: BROKEN at sequence 907: row_hash abc does not match the row content (recomputed def) (4 event(s) verified before it)',
    );
    expect(result.out[2]).toContain('2 run(s) checked, 1 broken');
    expect(result.closed).toBe(1);
  });

  it('checks a single run with --run and rejects an unknown one or a clash with --all', async () => {
    const chains = { 'run-a': intact, 'run-b': broken };
    const one = await fakeDatabase(chains).run(['--run=run-a']);
    expect(one.code).toBe(0);
    expect(one.out).toEqual(['run run-a: ok, 12 event(s) verified', '1 run(s) checked, 0 broken']);

    const missing = await fakeDatabase(chains).run(['--run=run-zzz']);
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toContain("run 'run-zzz' was not found");
    expect(missing.closed).toBe(1);

    const clash = await fakeDatabase(chains).run(['--run=run-a', '--all']);
    expect(clash.code).toBe(2);
    expect(clash.err[0]).toContain('exclude each other');
    expect(clash.opened).toEqual([]);

    const bare = await fakeDatabase(chains).run(['--run']);
    expect(bare.code).toBe(2);
    expect(bare.err[0]).toContain('--run needs a value');
  });

  it('prints one JSON document with --json', async () => {
    const result = await fakeDatabase({ 'run-b': broken }).run(['--json']);
    expect(result.code).toBe(1);
    expect(result.out).toHaveLength(1);
    expect(JSON.parse(result.out[0]!)).toEqual({
      ok: false,
      runs: [{ runId: 'run-b', ...broken }],
    });
  });

  it.runIf(Boolean(process.env.DATABASE_URL))(
    'walks a real chain through DATABASE_URL and catches a tampered row',
    async () => {
      const databaseUrl = process.env.DATABASE_URL!;
      const sql = createDatabase(databaseUrl);
      const repository = new PostgresForgeRepository(sql);
      const runId = `cli-verify-${Date.now()}`;
      try {
        await repository.ensureProject({
          id: `${runId}-project`,
          name: 'CLI verify fixture',
          repositoryUrl: 'https://example.invalid/cli-verify',
        });
        const now = new Date().toISOString();
        await repository.putRun({
          id: runId,
          projectId: `${runId}-project`,
          objective: 'Verify from the CLI',
          constraints: [],
          state: 'executing',
          budget: { maxUsd: 1, maxTokens: 1 },
          spent: { usd: 0, tokens: 0 },
          createdAt: now,
          updatedAt: now,
        });
        for (const n of [1, 2, 3]) {
          await repository.appendEvent({
            id: `${runId}-${n}`,
            runId,
            type: 'test',
            payload: { n },
            idempotencyKey: `${runId}-${n}`,
            createdAt: now,
          });
        }
        const env = { DATABASE_URL: databaseUrl };
        const intact = harness(env);
        const registry = createRegistry([verifyAuditCommand]);
        expect(
          await registry.run(['verify-audit', `--run=${runId}`], {
            env,
            stdout: (line) => intact.out.push(line),
            stderr: (line) => intact.err.push(line),
            fetch: globalThis.fetch,
          }),
        ).toBe(0);
        expect(intact.out[0]).toBe(`run ${runId}: ok, 3 event(s) verified`);

        const [second] = await sql<Array<{ sequence: string }>>`
          select sequence from events where id=${`${runId}-2`}`;
        await sql.begin(async (tx) => {
          await allowEventDeletion(tx);
          await tx`update events set type='tampered' where id=${`${runId}-2`}`;
        });
        const tampered = harness(env);
        expect(
          await registry.run(['verify-audit', `--run=${runId}`, '--json'], {
            env,
            stdout: (line) => tampered.out.push(line),
            stderr: (line) => tampered.err.push(line),
            fetch: globalThis.fetch,
          }),
        ).toBe(1);
        expect(JSON.parse(tampered.out[0]!)).toMatchObject({
          ok: false,
          runs: [
            { runId, ok: false, checked: 1, firstBad: { sequence: Number(second?.sequence) } },
          ],
        });
      } finally {
        await sql.end();
      }
    },
    30_000,
  );
});

describe('notify-test', () => {
  it('refuses a named channel whose variables are absent, naming them', async () => {
    const { run, err } = harness({ FORGE_OUTBOX_DIR: join(directory, 'outbox') });
    expect(await run(['notify-test', '--channel=ha'])).toBe(2);
    expect(err[0]).toBe(
      'forge notify-test: refusing to send; ha: missing FORGE_HA_URL, FORGE_HA_TOKEN (add them to .env)',
    );
    err.length = 0;
    expect(await run(['notify-test', '--channel=email'])).toBe(2);
    expect(err[0]).toContain('email: missing FORGE_SMTP_USER, FORGE_SMTP_PASSWORD');
    expect(await run(['notify-test', '--channel=pigeon'])).toBe(2);
    expect(existsSync(join(directory, 'outbox'))).toBe(false);
  });

  it('rejects a bad severity, and a phone test at info, which routing would never send', async () => {
    const { run, err } = harness({
      FORGE_OUTBOX_DIR: join(directory, 'outbox'),
      FORGE_HA_URL: 'http://192.168.1.10/ha',
      FORGE_HA_TOKEN: 'test-ha-long-lived-token',
    });
    expect(await run(['notify-test', '--severity=loud'])).toBe(2);
    expect(err[0]).toBe('forge notify-test: --severity must be one of info, warn or critical');
    err.length = 0;
    expect(await run(['notify-test', '--severity'])).toBe(2);
    expect(err[0]).toContain('--severity must be one of');
    err.length = 0;
    expect(await run(['notify-test', '--channel=ha', '--severity=info'])).toBe(2);
    expect(err[0]).toBe(
      'forge notify-test: info never reaches ha (severity routing, ADR-023); use --severity=warn or --severity=critical',
    );
    expect(existsSync(join(directory, 'outbox'))).toBe(false);
  });

  it('sends to the file outbox at warn by default, prints the routing per severity, and with --channel=all says which channels it skipped', async () => {
    const outbox = join(directory, 'outbox');
    const { run, out, err } = harness({ FORGE_OUTBOX_DIR: outbox });
    expect(await run(['notify-test', '--channel=file'])).toBe(0);
    expect(out).toEqual([
      `outbox: ${outbox}`,
      'channels: file',
      'routing: info -> file',
      'routing: warn -> file',
      'routing: critical -> file',
      'severity: warn',
      'subject: Forge warning: Test notification from TheForge (file, warn)',
      'result: file sent (attempt 1)',
    ]);
    const day = (await readdir(outbox)).find((name) => /^\d{8}$/.test(name))!;
    const files = await readdir(join(outbox, day));
    expect(files.some((name) => name.includes('-notify.test-') && name.endsWith('.md'))).toBe(true);
    const markdown = await readFile(
      join(
        outbox,
        day,
        files.find((n) => n.endsWith('.md'))!,
      ),
      'utf8',
    );
    expect(markdown).toContain('pnpm forge notify-test --channel=file --severity=warn');

    out.length = 0;
    expect(await run(['notify-test'])).toBe(0);
    expect(err).toEqual([
      'notify-test: skipping ha: missing FORGE_HA_URL, FORGE_HA_TOKEN',
      'notify-test: skipping email: missing FORGE_SMTP_USER, FORGE_SMTP_PASSWORD',
    ]);
    expect(out[1]).toBe('channels: file');

    out.length = 0;
    expect(await run(['notify-test', '--channel=file', '--severity=info'])).toBe(0);
    expect(out[5]).toBe('severity: info');
    expect(out[6]).toBe('subject: Forge: Test notification from TheForge (file, info)');
  });

  it('posts to Home Assistant through the injected fetch when configured, at warn without a critical', async () => {
    const ha = fakeCoordinator({
      '/api/services/notify/mobile_app_phone': () => jsonResponse([]),
    });
    const { run, out } = harness(
      {
        FORGE_OUTBOX_DIR: join(directory, 'outbox'),
        FORGE_HA_URL: 'http://192.168.1.10/ha',
        FORGE_HA_TOKEN: 'test-ha-long-lived-token',
      },
      ha.fetch,
    );
    expect(await run(['notify-test', '--channel=ha'])).toBe(0);
    expect(ha.calls).toEqual([
      {
        url: 'http://192.168.1.10/ha/api/services/notify/mobile_app_phone',
        authorization: 'Bearer test-ha-long-lived-token',
      },
    ]);
    expect(out.slice(1, 7)).toEqual([
      'channels: ha',
      'routing: info -> none (skipped: ha)',
      'routing: warn -> ha',
      'routing: critical -> ha',
      'severity: warn',
      'subject: Forge warning: Test notification from TheForge (ha, warn)',
    ]);
    expect(out.at(-1)).toBe('result: ha sent (attempt 1)');
  });

  it('skips the phone for an info test on every channel, and sends a critical with nothing that bypasses Do Not Disturb', async () => {
    const bodies: Array<{ title: string; data: Record<string, unknown> }> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '{}';
      bodies.push(JSON.parse(body) as (typeof bodies)[number]);
      return jsonResponse([]);
    };
    const env = {
      FORGE_OUTBOX_DIR: join(directory, 'outbox'),
      FORGE_HA_URL: 'http://192.168.1.10/ha',
      FORGE_HA_TOKEN: 'test-ha-long-lived-token',
    };
    const info = harness(env, fetch);
    expect(await info.run(['notify-test', '--severity=info'])).toBe(0);
    expect(bodies).toEqual([]);
    expect(info.out.slice(1, 5)).toEqual([
      'channels: file, ha',
      'routing: info -> file (skipped: ha)',
      'routing: warn -> file, ha',
      'routing: critical -> file, ha',
    ]);
    expect(info.out.at(-1)).toBe('result: file sent (attempt 1) · ha skipped (severity routing)');

    const critical = harness(env, fetch);
    expect(await critical.run(['notify-test', '--channel=ha', '--severity=critical'])).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.title).toBe('Forge CRITICAL: Test notification from TheForge (ha, critical)');
    expect(Object.keys(bodies[0]!.data).sort()).toEqual(['group', 'tag']);
    expect(critical.out.at(-1)).toBe('result: ha sent (attempt 1)');
  });

  it('exits 1 and reports the failure when the channel refuses', async () => {
    const ha = fakeCoordinator({
      '/api/services/notify/mobile_app_phone': () => jsonResponse({ message: 'Unauthorized' }, 401),
    });
    const { run, out } = harness(
      {
        FORGE_OUTBOX_DIR: join(directory, 'outbox'),
        FORGE_HA_URL: 'http://192.168.1.10/ha',
        FORGE_HA_TOKEN: 'test-ha-long-lived-token',
      },
      ha.fetch,
    );
    expect(await run(['notify-test', '--channel=ha'])).toBe(1);
    expect(out.at(-1)).toMatch(
      /^result: ha FAILED after 3 attempt\(s\): Home Assistant answered HTTP 401/,
    );
    expect(out.at(-1)).not.toContain('test-ha-long-lived-token');
  }, 15_000);
});

describe('tier0-ingest', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    repository: 'example-org/shopfront',
    number: 26,
    title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
    author: 'dependabot[bot]',
    headSha: 'abcdef1234567890abcdef1234567890abcdef12',
    mode: 'execute',
    action: 'merge',
    reason: 'all 2 checks passed against abcdef12',
    checks: [{ name: 'test', command: 'pnpm run test', exitCode: 0 }],
    attempts: 1,
    merged: true,
    mergedAt: '2026-09-26T01:00:00.000Z',
    durationMs: 1000,
    tier0Commit: 'e8f7f47',
    ...overrides,
  });

  it('notifies once per merge, escalation and deferral, and nothing for the rest', async () => {
    const outbox = join(directory, 'outbox');
    const file = join(directory, 'outcomes.json');
    await writeFile(
      file,
      JSON.stringify([
        record(),
        record({
          number: 27,
          action: 'escalate',
          reason: '1 of 2 checks failed: test (exit 1)',
          merged: false,
          hint: 'A rebase may resolve this',
        }),
        record({ number: 28, action: 'deferred', reason: 'merge state is BEHIND', merged: false }),
        record({ number: 29, action: 'skip', reason: 'human author', merged: false }),
        record({ number: 30, mode: 'dry-run', merged: false }),
      ]),
    );
    const { run, out } = harness({ FORGE_OUTBOX_DIR: outbox });
    expect(await run(['tier0-ingest', file])).toBe(0);
    expect(out).toEqual([
      `outbox: ${outbox}`,
      'channels: file',
      '#26 merge: tier0.merge -> file sent (attempt 1)',
      '#27 escalate: tier0.escalate -> file sent (attempt 1)',
      '#28 deferred: tier0.deferred -> file sent (attempt 1)',
      '#29 skip: nothing to notify',
      '#30 merge (dry run): nothing to notify',
      '3 notified, 2 not sent, 0 with a failed channel',
    ]);
    const day = (await readdir(outbox)).find((name) => /^\d{8}$/.test(name))!;
    const written = await readdir(join(outbox, day));
    expect(written.filter((name) => name.endsWith('.md'))).toHaveLength(3);

    // The same file again: every record is a duplicate inside the window.
    out.length = 0;
    expect(await run(['tier0-ingest', file])).toBe(0);
    expect(out[2]).toMatch(/^#26 merge: tier0\.merge -> duplicate: already sent at /);
    expect(out.at(-1)).toBe('0 notified, 5 not sent, 0 with a failed channel');
  });

  it('rejects a missing or malformed file with exit 2', async () => {
    const { run, err } = harness({ FORGE_OUTBOX_DIR: join(directory, 'outbox') });
    expect(await run(['tier0-ingest'])).toBe(2);
    expect(err[0]).toContain('give the outcomes file');
    expect(await run(['tier0-ingest', join(directory, 'absent.json')])).toBe(2);
    expect(err[1]).toMatch(/cannot read .*absent\.json: /);
    const bad = join(directory, 'bad.json');
    await writeFile(bad, '{"not":"an array"}');
    expect(await run(['tier0-ingest', bad])).toBe(2);
    expect(err[2]).toContain('expected a JSON array of Tier 0 outcomes');
  });
});
