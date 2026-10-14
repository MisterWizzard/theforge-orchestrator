import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RunSchema,
  UNATTRIBUTED_ROLE,
  UsageRecordSchema,
  type ForgeEvent,
  type Run,
} from '@theforge/contracts';
import { summariseUsage } from '@theforge/domain';
import {
  allowEventDeletion,
  canonicalJsonb,
  createDatabase,
  eventRowHash,
  GENESIS_HASH,
  PostgresForgeRepository,
} from './index.js';

/**
 * The hash chain, the append-only guard, retention by run, notifications and
 * the usage ledger against a real PostgreSQL (this file has its own schema).
 */
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? createDatabase(databaseUrl) : undefined;
const repository = sql ? new PostgresForgeRepository(sql) : undefined;
const prefix = `audit-${randomUUID().slice(0, 8)}`;
const projectId = `${prefix}-project`;

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return RunSchema.parse({
    id,
    projectId,
    objective: 'Prove the audit chain',
    state: 'executing',
    budget: { maxUsd: 1, maxTokens: 1 },
    spent: { usd: 0, tokens: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function makeEvent(runId: string, n: number, overrides: Partial<ForgeEvent> = {}): ForgeEvent {
  return {
    id: `${runId}-event-${n}`,
    runId,
    type: 'test.event',
    payload: { n },
    idempotencyKey: `${runId}-key-${n}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function seedRun(runId: string, count: number): Promise<ForgeEvent[]> {
  await repository!.putRun(makeRun(runId));
  for (let n = 1; n <= count; n += 1) {
    expect(await repository!.appendEvent(makeEvent(runId, n))).toBe(true);
  }
  return repository!.listEvents(runId);
}

// File-level so the one pool outlives every suite below; a suite-level afterAll
// would close it after the first describe and fail the rest with CONNECTION_ENDED.
beforeAll(async () => {
  await repository?.ensureProject({
    id: projectId,
    name: 'Audit chain test',
    repositoryUrl: 'https://example.invalid/audit-chain-test',
  });
});
afterAll(async () => {
  await sql?.end();
});

suite('hash-chained audit log', () => {
  it('links twenty concurrent appends into one chain in sequence order', async () => {
    const runId = `${prefix}-concurrent`;
    await repository!.putRun(makeRun(runId));
    const inserted = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository!.appendEvent(makeEvent(runId, index + 1)),
      ),
    );
    expect(inserted.every(Boolean)).toBe(true);

    const events = await repository!.listEvents(runId);
    expect(events).toHaveLength(20);
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]?.sequence).toBeGreaterThan(events[index - 1]!.sequence!);
      expect(events[index]?.prevHash).toBe(events[index - 1]?.rowHash);
    }
    await expect(repository!.verifyEventChain(runId)).resolves.toEqual({
      ok: true,
      checked: 20,
      legacy: 0,
    });
    // A duplicate idempotency key is still a no-op and leaves the chain alone.
    expect(await repository!.appendEvent(makeEvent(runId, 1))).toBe(false);
    await expect(repository!.verifyEventChain(runId)).resolves.toMatchObject({ checked: 20 });
  });

  it('recomputes the trigger hash in TypeScript for varied event shapes', async () => {
    const runId = `${prefix}-shapes`;
    await repository!.putRun(makeRun(runId));
    const shapes: Array<Partial<ForgeEvent>> = [
      { payload: {} },
      { payload: { list: [], nested: { deeper: { empty: {} } } } },
      {
        payload: {
          numbers: [0, -0, 1, 2.5, -3.75, 1e21, 1.5e21, 1e-7, -1.5e-9, 0.000001, 2 ** 53, 123.456],
        },
      },
      {
        payload: {
          ключ: 'значение',
          日本語: { ünïcödé: ['€', 'emoji 🙂', 'combining é'] },
          '': 'empty key',
          b: 1,
          aa: 2,
          a: 3,
          B: 4,
        },
      },
      {
        payload: {
          control:
            'tab\there\nnewline\r\nquote " backslash \\ slash / bell \u0007 unit \u001f del \u007f',
          bool: [true, false, null],
        },
      },
      { taskId: `${runId}-task`, attemptId: `${runId}-attempt`, type: 'task.transitioned' },
      { taskId: `${runId}-task-only`, payload: { from: 'ready', to: 'in_progress' } },
      { createdAt: '2026-01-05T23:59:59.999Z', payload: { at: 'year boundary' } },
    ];
    for (const [index, shape] of shapes.entries()) {
      expect(await repository!.appendEvent(makeEvent(runId, index + 1, shape))).toBe(true);
    }
    const events = await repository!.listEvents(runId);
    expect(events).toHaveLength(shapes.length);
    const stored = await sql!<Array<{ id: string; payload_text: string }>>`
      select id,payload::text as payload_text from events where run_id=${runId}`;
    for (const event of events) {
      const payloadText = stored.find((row) => row.id === event.id)?.payload_text;
      expect(canonicalJsonb(event.payload), `payload text of ${event.id}`).toBe(payloadText);
      expect(
        eventRowHash({
          sequence: event.sequence!,
          id: event.id,
          runId: event.runId,
          taskId: event.taskId,
          attemptId: event.attemptId,
          type: event.type,
          payload: event.payload,
          createdAt: event.createdAt,
          prevHash: event.prevHash!,
        }),
        `row hash of ${event.id}`,
      ).toBe(event.rowHash);
    }
    await expect(repository!.verifyEventChain(runId)).resolves.toMatchObject({
      ok: true,
      checked: shapes.length,
    });
    await expect(repository!.findEvent(`${runId}-key-6`)).resolves.toMatchObject({
      taskId: `${runId}-task`,
      sequence: events[5]?.sequence,
      rowHash: events[5]?.rowHash,
    });
  });

  it('refuses updates and deletes unless the transaction opted in', async () => {
    const runId = `${prefix}-guard`;
    const other = `${prefix}-guard-other`;
    await seedRun(runId, 2);
    await seedRun(other, 1);
    await expect(sql!`update events set type='altered' where run_id=${runId}`).rejects.toThrow(
      /append-only/,
    );
    await expect(sql!`delete from events where run_id=${runId}`).rejects.toThrow(/append-only/);
    // A cascade from the run fires the same guard.
    await expect(sql!`delete from runs where id=${runId}`).rejects.toThrow(/append-only/);
    await expect(repository!.listEvents(runId)).resolves.toHaveLength(2);
    await sql!.begin(async (tx) => {
      await allowEventDeletion(tx);
      await tx`delete from runs where id=${runId}`;
    });
    await expect(repository!.listEvents(runId)).resolves.toHaveLength(0);
    // The opt-in was transaction-local: the next statement on the pool is refused
    // again. (It must hit a row: a delete that matches nothing fires no row trigger.)
    await expect(sql!`delete from events where run_id=${other}`).rejects.toThrow(/append-only/);
    await expect(repository!.listEvents(other)).resolves.toHaveLength(1);
  });

  it('reports the exact sequence of an altered payload', async () => {
    const runId = `${prefix}-tamper-update`;
    const events = await seedRun(runId, 5);
    const target = events[2]!;
    await sql!.begin(async (tx) => {
      await allowEventDeletion(tx);
      await tx`update events set payload=${tx.json({ n: 3, altered: true })} where id=${target.id}`;
    });
    const verdict = await repository!.verifyEventChain(runId);
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toBe(2);
    expect(verdict.firstBad?.sequence).toBe(target.sequence);
    expect(verdict.firstBad?.reason).toMatch(/row_hash .* does not match the row content/);
  });

  it('reports the row after a deleted middle row', async () => {
    const runId = `${prefix}-tamper-delete`;
    const events = await seedRun(runId, 5);
    await sql!.begin(async (tx) => {
      await allowEventDeletion(tx);
      await tx`delete from events where id=${events[2]!.id}`;
    });
    const verdict = await repository!.verifyEventChain(runId);
    expect(verdict.ok).toBe(false);
    expect(verdict.checked).toBe(2);
    expect(verdict.firstBad?.sequence).toBe(events[3]?.sequence);
    expect(verdict.firstBad?.reason).toMatch(/prev_hash .* does not link to the previous row/);
  });

  it('starts the chain at genesis after pre-migration rows and skips them', async () => {
    const runId = `${prefix}-legacy`;
    await repository!.putRun(makeRun(runId));
    // Rows written before migration 006 have no hashes; the only way to make
    // one now is to insert with the chain trigger switched off.
    await sql!.begin(async (tx) => {
      await tx`alter table events disable trigger events_audit_chain`;
      await tx`insert into events (id,run_id,type,payload,idempotency_key,created_at)
        values (${`${runId}-legacy-1`},${runId},'legacy',${tx.json({})},${`${runId}-legacy-1`},now())`;
      await tx`alter table events enable trigger events_audit_chain`;
    });
    expect(await repository!.appendEvent(makeEvent(runId, 1))).toBe(true);
    const [legacy, first] = await repository!.listEvents(runId);
    expect(legacy?.rowHash).toBeUndefined();
    expect(first?.prevHash).toBe(GENESIS_HASH);
    await expect(repository!.verifyEventChain(runId)).resolves.toEqual({
      ok: true,
      checked: 1,
      legacy: 1,
    });
    // Erasing a hash after the chain has started is damage, not legacy.
    expect(await repository!.appendEvent(makeEvent(runId, 2))).toBe(true);
    await sql!.begin(async (tx) => {
      await allowEventDeletion(tx);
      await tx`update events set row_hash=null where id=${`${runId}-event-2`}`;
    });
    const verdict = await repository!.verifyEventChain(runId);
    expect(verdict.ok).toBe(false);
    expect(verdict.firstBad?.reason).toMatch(/no hash although the chain had already started/);
  });

  it('verifies nothing for an unknown run', async () => {
    await expect(repository!.verifyEventChain(`${prefix}-missing`)).resolves.toEqual({
      ok: true,
      checked: 0,
      legacy: 0,
    });
  });
});

suite('retention by run with tombstones', () => {
  it('removes retired runs whole, records a tombstone and leaves live runs alone', async () => {
    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const old = `${prefix}-retention-old`;
    const active = `${prefix}-retention-active`;
    const recent = `${prefix}-retention-recent`;
    await repository!.putRun(
      makeRun(old, { state: 'completed', updatedAt: '2026-05-01T00:00:00.000Z' }),
    );
    // Older than the cutoff but still executing: retention must not take it.
    await repository!.putRun(
      makeRun(active, { state: 'executing', updatedAt: '2026-05-01T00:00:00.000Z' }),
    );
    await repository!.putRun(makeRun(recent, { state: 'completed' }));
    for (const runId of [old, active, recent]) {
      for (let n = 1; n <= 3; n += 1) await repository!.appendEvent(makeEvent(runId, n));
    }
    await repository!.upsertArtifact({
      id: `${old}-artifact`,
      runId: old,
      kind: 'log',
      label: 'old log',
      uri: 'forge://old',
      metadata: {},
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const oldEvents = await repository!.listEvents(old);

    await expect(repository!.cleanupRetention(cutoff)).resolves.toEqual({
      runs: 1,
      events: 3,
      artifacts: 1,
      executed: false,
    });
    await expect(repository!.listEvents(old)).resolves.toHaveLength(3);

    await expect(repository!.cleanupRetention(cutoff, { execute: true })).resolves.toEqual({
      runs: 1,
      events: 3,
      artifacts: 1,
      executed: true,
    });
    await expect(repository!.getRun(old)).resolves.toBeUndefined();
    await expect(repository!.listEvents(old)).resolves.toHaveLength(0);
    await expect(repository!.listArtifacts(old)).resolves.toHaveLength(0);
    const tombstones = await sql!<
      Array<{ run_id: string; last_sequence: string; last_row_hash: string; event_count: string }>
    >`select run_id,last_sequence,last_row_hash,event_count from audit_tombstones where run_id=${old}`;
    expect(tombstones).toEqual([
      {
        run_id: old,
        last_sequence: String(oldEvents[2]?.sequence),
        last_row_hash: oldEvents[2]?.rowHash,
        event_count: '3',
      },
    ]);
    await expect(sql!`delete from audit_tombstones where run_id=${old}`).rejects.toThrow(
      /append-only/,
    );
    for (const runId of [active, recent]) {
      await expect(repository!.getRun(runId)).resolves.toBeDefined();
      await expect(repository!.verifyEventChain(runId)).resolves.toMatchObject({
        ok: true,
        checked: 3,
      });
    }
    await expect(repository!.cleanupRetention(cutoff)).resolves.toMatchObject({ runs: 0 });
  });
});

suite('notifications', () => {
  it('dedupes on the key, counts attempts and stamps delivery', async () => {
    const runId = `${prefix}-notify`;
    await repository!.putRun(makeRun(runId));
    const key = `${prefix}:tier0.merge:pr-42`;
    const first = {
      id: `${prefix}-notification-1`,
      runId,
      kind: 'tier0.merge',
      dedupeKey: key,
      channel: 'ha' as const,
      payload: { title: 'Merged #42' },
    };
    expect(await repository!.recordNotification(first)).toBe(true);
    expect(await repository!.recordNotification(first)).toBe(false);
    expect(
      await repository!.recordNotification({ ...first, id: `${prefix}-notification-1b` }),
    ).toBe(false);
    expect(
      await repository!.recordNotification({
        ...first,
        id: `${prefix}-notification-2`,
        dedupeKey: `${key}:email`,
        channel: 'email',
      }),
    ).toBe(true);

    const failed = await repository!.markNotification(first.id, 'failed', { message: 'timeout' });
    expect(failed).toMatchObject({
      id: first.id,
      status: 'failed',
      attempts: 1,
      lastError: { message: 'timeout' },
    });
    expect(failed?.sentAt).toBeUndefined();
    const sent = await repository!.markNotification(first.id, 'sent');
    expect(sent).toMatchObject({ status: 'sent', attempts: 2 });
    expect(sent?.lastError).toBeUndefined();
    expect(sent?.sentAt).toBeDefined();
    // A skip is a decision, not a delivery attempt.
    expect(await repository!.markNotification(`${prefix}-notification-2`, 'skipped')).toMatchObject(
      { status: 'skipped', attempts: 0 },
    );
    await expect(repository!.markNotification(`${prefix}-nope`, 'sent')).resolves.toBeUndefined();

    const since = await repository!.listNotificationsSince(new Date(Date.now() - 60_000));
    expect(since.map((item) => item.id)).toEqual([first.id, `${prefix}-notification-2`]);
    expect(since[0]).toMatchObject({
      runId,
      kind: 'tier0.merge',
      dedupeKey: key,
      channel: 'ha',
    });
    await expect(
      repository!.listNotificationsSince(new Date(Date.now() + 60_000)),
    ).resolves.toEqual([]);
  });
});

suite('project registry', () => {
  it("round-trips a project's checks, which is what makes them survive a restart", async () => {
    // Pinned because the behaviour is invisible in the schema and was misread
    // because of it: `projects` has no `checks` column, so checks look
    // unpersisted. They are stored inside the `policy` jsonb instead, and the
    // coordinator rebuilds its in-memory registry from `listProjects` on boot
    // (apps/coordinator/src/server.ts). Nothing asserted the round-trip, so a
    // refactor of `ensureProject` could have dropped checks on the floor and
    // every existing test would still have passed - they all call it as
    // fixture setup and none reads the checks back.
    const id = `${prefix}-checks`;
    const checks = [
      { executable: 'npm', args: ['run', 'lint'] },
      { executable: 'npm', args: ['run', 'typecheck'] },
      { executable: 'npm', args: ['run', 'test'] },
    ];
    await repository!.ensureProject({
      id,
      name: 'Checks round trip',
      repositoryUrl: 'https://example.invalid/checks-round-trip',
      defaultBranch: 'trunk',
      checks,
    });

    const [project] = (await repository!.listProjects()).filter((row) => row.id === id);
    expect(project).toEqual({
      id,
      name: 'Checks round trip',
      repositoryUrl: 'https://example.invalid/checks-round-trip',
      baseRef: 'trunk',
      checks,
      // A project that declares no install step reads back as `[]`, which is
      // what every project registered before 05/10/2026 does. That matters:
      // an empty install list means no container gets network access, so an
      // old project cannot inherit a weaker sandbox by accident.
      install: [],
    });

    // An upsert replaces the checks rather than merging them, so removing a
    // check actually removes it.
    await repository!.ensureProject({
      id,
      name: 'Checks round trip',
      repositoryUrl: 'https://example.invalid/checks-round-trip',
      defaultBranch: 'trunk',
      checks: [{ executable: 'npm', args: ['run', 'test'] }],
    });
    const [replaced] = (await repository!.listProjects()).filter((row) => row.id === id);
    expect(replaced!.checks).toEqual([{ executable: 'npm', args: ['run', 'test'] }]);
  });

  it('round-trips an install step separately from the checks', async () => {
    // `install` commands run in a container that HAS network access, so which
    // list a command lands in decides whether it can reach the internet. They
    // are stored under one `policy` column and must not bleed into each other.
    const id = `${prefix}-install`;
    const install = [{ executable: 'npm', args: ['ci'] }];
    const checks = [{ executable: 'npm', args: ['run', 'test'] }];
    await repository!.ensureProject({
      id,
      name: 'Install round trip',
      repositoryUrl: 'https://example.invalid/install-round-trip',
      checks,
      install,
    });
    const [project] = (await repository!.listProjects()).filter((row) => row.id === id);
    expect(project).toMatchObject({ checks, install });
    // Not the same list read twice.
    expect(project!.checks).not.toEqual(project!.install);
  });

  it('defaults to no checks rather than failing when none are given', async () => {
    // Most callers omit them; the coordinator's own route applies its
    // `pnpm check` default before this is reached, so the storage layer's job
    // is only to not invent one.
    const id = `${prefix}-nochecks`;
    await repository!.ensureProject({
      id,
      name: 'No checks',
      repositoryUrl: 'https://example.invalid/no-checks',
    });
    const [project] = (await repository!.listProjects()).filter((row) => row.id === id);
    expect(project).toMatchObject({ baseRef: 'main', checks: [] });
  });
});

suite('usage ledger windows', () => {
  it('lists by window and sums by provider the same way the in-memory store does', async () => {
    const runId = `${prefix}-usage`;
    await repository!.putRun(makeRun(runId));
    const day = '2026-09-25';
    // Roles are deliberately mixed, and one row has none, so the role grouping
    // is exercised against a provider grouping that does not line up with it:
    // `claude` spans two roles and `builder` spans two providers.
    const rows = [
      {
        provider: 'claude',
        role: 'planner',
        at: `${day}T00:30:00.000Z`,
        usd: 0.5,
        input: 100,
        cached: 80,
        output: 10,
      },
      {
        provider: 'codex',
        role: 'builder',
        at: `${day}T06:00:00.000Z`,
        usd: 0.25,
        input: 50,
        cached: 0,
        output: 5,
      },
      {
        provider: 'claude',
        role: 'builder',
        at: `${day}T12:00:00.000Z`,
        usd: 1.25,
        input: 300,
        cached: 250,
        output: 40,
      },
      // No role: not everything that spends is a pipeline stage, and a record
      // written before migration 008 has none either.
      {
        provider: 'ollama',
        at: `${day}T18:00:00.000Z`,
        usd: 0,
        input: 900,
        cached: 0,
        output: 200,
      },
      {
        provider: 'claude',
        role: 'reviewer',
        at: `2026-09-26T00:00:00.000Z`,
        usd: 9,
        input: 1,
        cached: 0,
        output: 1,
      },
    ];
    const records = rows.map((row, index) =>
      UsageRecordSchema.parse({
        id: `${runId}-usage-${index}`,
        runId,
        provider: row.provider,
        ...(row.role ? { role: row.role } : {}),
        inputTokens: row.input,
        cachedInputTokens: row.cached,
        outputTokens: row.output,
        costUsd: row.usd,
        createdAt: row.at,
      }),
    );
    for (const record of records) await repository!.upsertUsageRecord(record);

    const from = new Date(`${day}T00:00:00.000Z`);
    const to = new Date('2026-09-26T00:00:00.000Z');
    const listed = await repository!.listUsageRecordsSince(from, to);
    expect(listed.map((record) => record.id)).toEqual(records.slice(0, 4).map((r) => r.id));
    // The upper bound is exclusive and the lower bound inclusive.
    await expect(repository!.listUsageRecordsSince(to)).resolves.toEqual([records[4]]);
    await expect(repository!.listUsageRecordsSince(from)).resolves.toHaveLength(5);

    const summary = await repository!.sumUsageSince(from, to);
    expect(summary).toEqual({
      usd: 2,
      inputTokens: 1350,
      cachedInputTokens: 330,
      outputTokens: 255,
      count: 4,
      byProvider: {
        claude: { usd: 1.75, count: 2 },
        codex: { usd: 0.25, count: 1 },
        ollama: { usd: 0, count: 1 },
      },
      byRole: {
        // `builder` spans two providers, which is the case the SQL grouping
        // (by provider AND role) has to re-aggregate correctly.
        builder: { usd: 1.5, count: 2 },
        planner: { usd: 0.5, count: 1 },
        [UNATTRIBUTED_ROLE]: { usd: 0, count: 1 },
      },
    });
    // The role groups account for every record and every cent, with nothing
    // lost to the roleless one.
    expect(Object.values(summary.byRole).reduce((total, group) => total + group.count, 0)).toBe(
      summary.count,
    );
    expect(Object.values(summary.byRole).reduce((total, group) => total + group.usd, 0)).toBe(
      summary.usd,
    );
    // The SQL summary and the in-memory one still agree, now across two
    // groupings rather than one.
    expect(summary).toEqual(summariseUsage(listed));

    // The evidence counter behind the ROLE_ESTIMATES_USD review threshold
    // (ADR-034). Metered calls only, by role, over all time - so the $0 ollama
    // row is excluded on both counts, having neither a cost nor a role, and
    // `builder` spans two providers just as it does above.
    const metered = await repository!.countMeteredCallsByRole();
    expect(metered).toEqual({ builder: 2, planner: 1, reviewer: 1 });
    await expect(repository!.sumUsageSince(new Date('2027-01-01T00:00:00.000Z'))).resolves.toEqual({
      usd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      count: 0,
      byProvider: {},
      byRole: {},
    });
  });
});
