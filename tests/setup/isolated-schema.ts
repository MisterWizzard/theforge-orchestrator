import { randomBytes } from 'node:crypto';
import { afterAll, expect } from 'vitest';
import { createIsolatedSchema } from '@theforge/db/testing';
import { testSchemaName } from './schema-name.js';

/**
 * Give this test file its own PostgreSQL schema.
 *
 * Vitest imports setup files before it evaluates the test file, so by the time
 * a static import opens the database at module load - apps/coordinator's
 * server.ts does exactly that - DATABASE_URL already points at the isolated
 * schema. Coordinators and workers spawned by a test inherit process.env and
 * follow along unchanged. Verified empirically; see BLK-011.
 *
 * FORGE_TEST_BASE_DATABASE_URL remembers the real URL so that a worker process
 * which runs several files (`--no-isolate`) still branches off the base rather
 * than off a previous file's schema.
 */
const baseUrl = process.env.FORGE_TEST_BASE_DATABASE_URL ?? process.env.DATABASE_URL;
if (baseUrl) {
  const testPath = expect.getState().testPath ?? 'unknown';
  const schema = await createIsolatedSchema(
    baseUrl,
    testSchemaName(testPath, randomBytes(4).toString('hex')),
  );
  process.env.FORGE_TEST_BASE_DATABASE_URL = baseUrl;
  process.env.DATABASE_URL = schema.url;
  // Registered before the file's own hooks, so with the default `stack` order
  // it runs after them: the coordinator under test closes first, then the
  // schema goes.
  afterAll(async () => {
    await schema.drop();
  });
}
