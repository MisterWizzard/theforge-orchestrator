import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

/**
 * Naming shared by the global setup (which locks and sweeps) and the per-file
 * setup (which creates). Everything is keyed on the checkout so that two
 * checkouts of this repository can test against one PostgreSQL server at the
 * same time without either one sweeping the other's live schemas.
 */

export function checkoutPath(): string {
  const path = resolve(process.cwd()).replace(/\\/g, '/');
  // Windows paths are case-insensitive: `C:/forge` and `c:/forge` are one checkout.
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function checkoutTag(): string {
  return createHash('sha1').update(checkoutPath()).digest('hex').slice(0, 6);
}

export function testRunLockKey(): string {
  return `theforge-test:${checkoutPath()}`;
}

/** `t_<test file>_<pid>_<random>_<checkout>`, always a valid unquoted identifier. */
export function testSchemaName(testPath: string, random: string): string {
  const file = basename(testPath)
    .replace(/\.(integration\.)?test\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase()
    .slice(0, 24);
  return `t_${file}_${process.pid}_${random}_${checkoutTag()}`;
}

/** PostgreSQL regex matching every schema `testSchemaName` produced for this checkout. */
export function leftoverSchemaPattern(): string {
  return `^t_.+_${checkoutTag()}$`;
}
