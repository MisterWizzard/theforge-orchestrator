import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { MIGRATION_FILES } from './migrations/index.js';

/**
 * Test-only helpers for running suites against a real PostgreSQL server
 * without sharing state between them. Nothing here is used at runtime.
 */

export type IsolatedSchema = {
  /** Connection URL whose `search_path` is pinned to the schema. */
  url: string;
  schema: string;
  drop: () => Promise<void>;
};

export type AdvisoryLock = {
  acquired: boolean;
  release: () => Promise<void>;
};

/**
 * Create `schemaName`, apply every migration inside it and return a URL that
 * connects straight into it. The scope travels in the URL itself
 * (`options=-c search_path=<schema>`), so a coordinator or worker spawned with
 * that URL lands in the same schema without knowing anything about tests.
 *
 * Lower-case only: the schema is created quoted, but `search_path` in the URL
 * is unquoted and the server folds it to lower case.
 */
export async function createIsolatedSchema(
  baseUrl: string,
  schemaName: string,
): Promise<IsolatedSchema> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new Error(`Refusing to create an unsafe schema name: ${schemaName}`);
  }
  await withConnection(baseUrl, async (sql) => {
    await sql.unsafe(`create schema "${schemaName}"`);
  });
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName}`);
  const isolatedUrl = url.toString();
  await withConnection(isolatedUrl, async (sql) => {
    for (const name of MIGRATION_FILES) {
      const migration = await readFile(
        fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)),
        'utf8',
      );
      await sql.unsafe(migration);
    }
  });
  return {
    url: isolatedUrl,
    schema: schemaName,
    drop: () =>
      withConnection(baseUrl, async (sql) => {
        await sql.unsafe(`drop schema if exists "${schemaName}" cascade`);
      }),
  };
}

/**
 * Try to take a session-level advisory lock and keep the session open until
 * `release`, because PostgreSQL drops the lock the moment the session ends.
 * Non-blocking: a second caller learns immediately that the key is taken.
 */
export async function acquireAdvisoryLock(baseUrl: string, key: string): Promise<AdvisoryLock> {
  const sql = postgres(baseUrl, { max: 1, connect_timeout: 10 });
  try {
    const [row] = await sql<
      Array<{ acquired: boolean }>
    >`select pg_try_advisory_lock(hashtext(${key})) as acquired`;
    if (row?.acquired) return { acquired: true, release: () => sql.end() };
  } catch (error) {
    await sql.end();
    throw error;
  }
  await sql.end();
  return { acquired: false, release: async () => {} };
}

/** Drop every schema whose name matches `pattern` (a PostgreSQL regex). */
export async function dropSchemasMatching(baseUrl: string, pattern: string): Promise<string[]> {
  return withConnection(baseUrl, async (sql) => {
    const rows = await sql<
      Array<{ nspname: string }>
    >`select nspname from pg_namespace where nspname ~ ${pattern} order by nspname`;
    for (const { nspname } of rows) {
      await sql.unsafe(`drop schema if exists "${nspname}" cascade`);
    }
    return rows.map((row) => row.nspname);
  });
}

/**
 * Row counts for the schema-qualified tables that exist. A table that has not
 * been migrated yet is simply absent from the result.
 */
export async function countRows(
  baseUrl: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  return withConnection(baseUrl, async (sql) => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const [exists] = await sql<
        Array<{ present: boolean }>
      >`select to_regclass(${table}) is not null as present`;
      if (!exists?.present) continue;
      const [row] = await sql.unsafe<Array<{ count: number }>>(
        `select count(*)::int as count from ${table}`,
      );
      counts[table] = row?.count ?? 0;
    }
    return counts;
  });
}

async function withConnection<T>(url: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  // Cascade drops raise one NOTICE per table; forty leftover schemas would bury
  // the test summary under six hundred lines of them.
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}
