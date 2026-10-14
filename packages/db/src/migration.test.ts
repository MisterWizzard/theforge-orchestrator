import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { canonicalJsonb, eventRowHash, GENESIS_HASH } from './audit-chain.js';
import { MIGRATION_FILES } from './migrations/index.js';

type ChainRow = {
  sequence: number;
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  type: string;
  payload: unknown;
  payload_text: string;
  created_at: Date;
  prev_hash: string;
  row_hash: string;
};

describe('PostgreSQL migration', () => {
  it('applies idempotently and creates every authoritative entity table', async () => {
    const database = new PGlite();
    for (const name of MIGRATION_FILES) {
      const migration = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
      await database.exec(migration);
      await database.exec(migration);
    }
    const result = await database.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    );
    const names = result.rows.map((row) => row.tablename);
    for (const table of [
      'projects',
      'runs',
      'tasks',
      'attempts',
      'events',
      'messages',
      'findings',
      'decisions',
      'blockers',
      'approvals',
      'workers',
      'worker_jobs',
      'artifacts',
      'usage_records',
    ]) {
      expect(names).toContain(table);
    }
    const columns = await database.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='worker_jobs' order by ordinal_position",
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'run_id',
      'action',
      'required_capabilities',
      'state',
      'worker_id',
      'lease_token',
      'lease_expires_at',
      'approval',
      'result',
      'created_at',
      'updated_at',
      'task_id',
      'attempt_id',
      'idempotency_key',
      'priority',
      'available_at',
    ]);
    await database.exec(`
      insert into projects (id,name,repository_url) values ('project-1','Fixture','https://example.invalid/repo');
      insert into runs (id,project_id,objective,state,budget,spent,created_at,updated_at)
        values ('run-1','project-1','Test','executing','{}','{}',now(),now());
      insert into workers (id,name,platform,capabilities,policy_profile,credential_digest,status,lease_expires_at,last_heartbeat_at)
        values ('worker-1','Fixture worker','win32','["git"]','standard','${'0'.repeat(64)}','online',now() + interval '1 minute',now());
      insert into worker_jobs (id,run_id,action,required_capabilities,state,worker_id,lease_token,lease_expires_at)
        values ('job-1','run-1','{"executable":"git","args":["status"],"cwd":"C:/repo"}','["git"]','leased','worker-1','fence-1',now() + interval '30 seconds');
    `);
    const jobs = await database.query<{ id: string; lease_token: string }>(
      'select id,lease_token from worker_jobs',
    );
    expect(jobs.rows).toEqual([{ id: 'job-1', lease_token: 'fence-1' }]);
    await expect(
      database.exec(`insert into worker_jobs (id,run_id,action,state)
        values ('job-unfenced','run-1','{"executable":"git","args":[],"cwd":"C:/repo"}','leased')`),
    ).rejects.toThrow();
    await expect(
      database.exec(`insert into worker_jobs (id,run_id,action,state,lease_token)
        values ('job-duplicate','run-1','{"executable":"git","args":[],"cwd":"C:/repo"}','completed','fence-1')`),
    ).rejects.toThrow();
    const transportMigration = await readFile(
      new URL('./migrations/005_worker_workspace_transport.sql', import.meta.url),
      'utf8',
    );
    await database.exec(transportMigration);
    const upgraded = await database.query<{ state: string; lease_token: string | null }>(
      "select state,lease_token from worker_jobs where id='job-1'",
    );
    expect(upgraded.rows).toEqual([{ state: 'cancelled', lease_token: null }]);

    // 006: audit chain, append-only guard, tombstones, notifications.
    expect(names).toContain('notifications');
    expect(names).toContain('audit_tombstones');
    const eventColumns = await database.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='events' order by ordinal_position",
    );
    expect(eventColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['sequence', 'prev_hash', 'row_hash']),
    );
    const triggers = await database.query<{ tgname: string }>(
      'select tgname from pg_trigger where not tgisinternal order by tgname',
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'audit_tombstones_append_only',
      'events_append_only',
      'events_audit_chain',
    ]);

    const payload = { z: [1, 2.5, 1e21, 1e-7], a: { ünï: 'cödé', '': 'empty', bb: null }, m: 'x' };
    await database.query(
      `insert into events (id,run_id,type,payload,idempotency_key,created_at)
        values ('event-1','run-1','run.transitioned',$1,'key-1','2026-09-26T10:00:00.123Z')`,
      [JSON.stringify(payload)],
    );
    await database.query(
      `insert into events (id,run_id,task_id,attempt_id,type,payload,idempotency_key,created_at)
        values ('event-2','run-1','task-1','attempt-1','task.transitioned',$1,'key-2','2026-09-26T10:00:01.999Z')`,
      [JSON.stringify({ from: 'ready', to: 'in_progress' })],
    );
    const chain = await database.query<ChainRow>(
      'select sequence,id,run_id,task_id,attempt_id,type,payload,payload::text as payload_text,created_at,prev_hash,row_hash from events order by sequence',
    );
    expect(chain.rows).toHaveLength(2);
    const [first, second] = chain.rows as [ChainRow, ChainRow];
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.prev_hash).toBe(first.row_hash);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    for (const row of chain.rows) {
      expect(canonicalJsonb(row.payload)).toBe(row.payload_text);
      expect(
        eventRowHash({
          sequence: Number(row.sequence),
          id: row.id,
          runId: row.run_id,
          taskId: row.task_id,
          attemptId: row.attempt_id,
          type: row.type,
          payload: row.payload,
          createdAt: row.created_at,
          prevHash: row.prev_hash,
        }),
      ).toBe(row.row_hash);
    }

    await expect(database.query("update events set type='x' where id='event-1'")).rejects.toThrow(
      /append-only/,
    );
    await expect(database.query("delete from events where id='event-1'")).rejects.toThrow(
      /append-only/,
    );
    // Cascading from the run reaches the same guard.
    await expect(database.query("delete from runs where id='run-1'")).rejects.toThrow(
      /append-only/,
    );
    await database.exec(
      "begin; select set_config('forge.allow_event_delete','on',true); update events set type='x' where id='event-1'; commit;",
    );
    const altered = await database.query<{ type: string; row_hash: string }>(
      "select type,row_hash from events where id='event-1'",
    );
    // The opt-in permits the write; it does not re-hash, which is what the verifier catches.
    expect(altered.rows).toEqual([{ type: 'x', row_hash: first.row_hash }]);
    await expect(database.query("delete from events where id='event-1'")).rejects.toThrow(
      /append-only/,
    );

    // 007: the digests read events by time window across every run.
    const eventIndexes = await database.query<{ indexname: string }>(
      "select indexname from pg_indexes where tablename='events' order by indexname",
    );
    expect(eventIndexes.rows.map((row) => row.indexname)).toContain('events_created_at_idx');

    await database.exec(`
      insert into notifications (id,kind,dedupe_key,channel,status,payload)
        values ('notification-1','digest','digest:2026-09-26:05:00','email','pending','{}');
      insert into notifications (id,run_id,kind,dedupe_key,channel,status,payload)
        values ('notification-2','run-1','tier0.merge','merge:run-1:1','ha','sent','{}');
    `);
    await expect(
      database.exec(`insert into notifications (id,kind,dedupe_key,channel,status,payload)
        values ('notification-3','digest','digest:2026-09-26:05:00','email','pending','{}')`),
    ).rejects.toThrow();
    // The same key on another channel is a separate delivery, not a duplicate.
    await database.exec(`insert into notifications (id,kind,dedupe_key,channel,status,payload)
        values ('notification-3b','digest','digest:2026-09-26:05:00','file','pending','{}')`);
    await expect(
      database.exec(`insert into notifications (id,kind,dedupe_key,channel,status,payload)
        values ('notification-4','digest','digest:other','file','delivered','{}')`),
    ).rejects.toThrow();
    await database.close();
  });
});
