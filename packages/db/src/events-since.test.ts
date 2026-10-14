import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunSchema, type ForgeEvent, type Run } from '@theforge/contracts';
import { InMemoryForgeRepository } from '@theforge/domain';
import { createDatabase, PostgresForgeRepository } from './index.js';

/**
 * listEventsSince: the time-window read the digests use (migration 007 adds
 * the index it needs). Both stores answer the same question the same way.
 */
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? createDatabase(databaseUrl) : undefined;
const repository = sql ? new PostgresForgeRepository(sql) : undefined;

const projectId = 'events-since-project';

function makeRun(id: string): Run {
  const now = '2026-09-25T00:00:00.000Z';
  return RunSchema.parse({
    id,
    projectId,
    objective: 'Read events by window',
    state: 'executing',
    budget: { maxUsd: 1, maxTokens: 1 },
    spent: { usd: 0, tokens: 0 },
    createdAt: now,
    updatedAt: now,
  });
}

/** Two runs, five events, in a deliberately non-chronological insert order. */
const fixture: ForgeEvent[] = [
  {
    id: 'e-c',
    runId: 'run-a',
    type: 'spend.warn',
    payload: { n: 3 },
    idempotencyKey: 'e-c',
    createdAt: '2026-09-25T12:00:00.000Z',
  },
  {
    id: 'e-a',
    runId: 'run-a',
    type: 'run.paused_by_guard',
    payload: { n: 1 },
    idempotencyKey: 'e-a',
    createdAt: '2026-09-25T07:29:59.000Z',
  },
  {
    id: 'e-b',
    runId: 'run-b',
    type: 'run.paused_by_guard',
    payload: { n: 2 },
    idempotencyKey: 'e-b',
    createdAt: '2026-09-25T07:30:00.000Z',
  },
  {
    id: 'e-e',
    runId: 'run-b',
    type: 'task.transitioned',
    payload: { n: 5 },
    idempotencyKey: 'e-e',
    createdAt: '2026-09-25T19:00:00.000Z',
  },
  {
    id: 'e-d',
    runId: 'run-b',
    type: 'spend.warn',
    payload: { n: 4 },
    idempotencyKey: 'e-d',
    createdAt: '2026-09-25T18:59:59.999Z',
  },
];
const from = new Date('2026-09-25T07:30:00.000Z');
const to = new Date('2026-09-25T19:00:00.000Z');

async function seed(target: {
  putRun(run: Run): Promise<void>;
  appendEvent(event: ForgeEvent): Promise<boolean>;
}): Promise<void> {
  await target.putRun(makeRun('run-a'));
  await target.putRun(makeRun('run-b'));
  for (const event of fixture) expect(await target.appendEvent(event)).toBe(true);
}

function expectWindowSemantics(
  list: (from: Date, to?: Date, types?: readonly string[]) => Promise<ForgeEvent[]>,
) {
  return async () => {
    // Inclusive at `from`, exclusive at `to`, oldest first, every run.
    const inWindow = await list(from, to);
    expect(inWindow.map((event) => event.id)).toEqual(['e-b', 'e-c', 'e-d']);
    expect(inWindow.map((event) => event.runId)).toEqual(['run-b', 'run-a', 'run-b']);
    // Open-ended when `to` is absent.
    expect((await list(from)).map((event) => event.id)).toEqual(['e-b', 'e-c', 'e-d', 'e-e']);
    // Restricted to the named types.
    expect((await list(from, to, ['spend.warn'])).map((event) => event.id)).toEqual(['e-c', 'e-d']);
    expect(
      (await list(from, undefined, ['spend.warn', 'task.transitioned'])).map((event) => event.id),
    ).toEqual(['e-c', 'e-d', 'e-e']);
    // An empty type list matches nothing; an unknown type matches nothing.
    await expect(list(from, to, [])).resolves.toEqual([]);
    await expect(list(from, to, ['no.such.type'])).resolves.toEqual([]);
    // A window with nothing in it.
    await expect(list(new Date('2026-09-26T00:00:00.000Z'))).resolves.toEqual([]);
  };
}

describe('InMemoryForgeRepository.listEventsSince', () => {
  it('lists by window and type', async () => {
    const memory = new InMemoryForgeRepository();
    await seed(memory);
    await expectWindowSemantics((f, t, types) => memory.listEventsSince(f, t, types))();
    // Copies out, so a caller cannot edit the store's row.
    const [first] = await memory.listEventsSince(from, to);
    first!.payload.n = 99;
    expect((await memory.listEventsSince(from, to))[0]?.payload.n).toBe(2);
  });
});

suite('PostgresForgeRepository.listEventsSince', () => {
  beforeAll(async () => {
    await repository!.ensureProject({
      id: projectId,
      name: 'Events window test',
      repositoryUrl: 'https://example.invalid/events-since',
    });
    await seed(repository!);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it(
    'lists by window and type across runs, in time order, with the chain fields',
    expectWindowSemantics((f, t, types) => repository!.listEventsSince(f, t, types)),
  );

  it('returns the same rows listEvents does, hashes included', async () => {
    const [byWindow] = await repository!.listEventsSince(from, to, ['run.paused_by_guard']);
    const byRun = (await repository!.listEvents('run-b')).find((event) => event.id === 'e-b');
    expect(byWindow).toEqual(byRun);
    expect(byWindow?.rowHash).toHaveLength(64);
    expect(byWindow?.sequence).toBeGreaterThan(0);
  });

  it('is served by the created_at index from migration 007', async () => {
    const [index] = await sql!<Array<{ indexdef: string }>>`
      select indexdef from pg_indexes
      where tablename='events' and schemaname=current_schema() and indexname='events_created_at_idx'`;
    expect(index?.indexdef).toMatch(/\(created_at\)$/);
  });
});
