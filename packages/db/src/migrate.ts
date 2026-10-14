import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { MIGRATION_FILES } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
// Keep the migration entrypoint independent of compiled workspace packages so it
// can bootstrap a completely fresh checkout before the monorepo build runs.
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
try {
  for (const name of MIGRATION_FILES) {
    const migration = await readFile(
      fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)),
      'utf8',
    );
    await sql.unsafe(migration);
  }
  console.info('database migration complete');
} finally {
  await sql.end();
}
