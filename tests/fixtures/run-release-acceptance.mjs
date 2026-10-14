/* global process */
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

const requirements = [
  ['DATABASE_URL', ['postgres:', 'postgresql:'], 'an isolated-schema-capable PostgreSQL database'],
  ['REDIS_URL', ['redis:', 'rediss:'], 'a disposable Redis queue endpoint'],
];
const missing = [];
for (const [name, protocols, purpose] of requirements) {
  const value = process.env[name];
  if (!value) {
    missing.push(`${name}: ${purpose}`);
    continue;
  }
  try {
    const protocol = new URL(value).protocol;
    if (!protocols.includes(protocol)) missing.push(`${name}: expected ${protocols.join(' or ')}`);
  } catch {
    missing.push(`${name}: expected an absolute connection URL`);
  }
}
if (missing.length) {
  process.stderr.write(
    [
      'Release acceptance did not run because required infrastructure is missing or invalid:',
      ...missing.map((item) => `- ${item}`),
      '',
      'Start the documented local infrastructure, then provide both URLs.',
      'Example: DATABASE_URL=postgres://forge:forge@127.0.0.1:5432/forge',
      '         REDIS_URL=redis://127.0.0.1:6379',
      '',
      'This deterministic command intentionally stops at a pending integration approval.',
      'It never pushes a branch, creates a pull request, or substitutes fake PR evidence.',
    ].join('\n') + '\n',
  );
  process.exit(1);
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this entrypoint through pnpm test:acceptance');
await runPnpm(['test:prepare']);
await runPnpm(['exec', 'vitest', 'run', 'tests/release-acceptance.test.ts', '--reporter=verbose']);

async function runPnpm(args) {
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [pnpmCli, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('close', (status) => resolvePromise(status ?? 1));
  });
  if (code !== 0) process.exit(code);
}
