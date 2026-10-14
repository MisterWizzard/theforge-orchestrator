import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { runGit } from '@theforge/git-runtime';

/**
 * The black-box harness: a real coordinator from apps/coordinator/dist and the
 * fixture worker from tests/fixtures/release-worker.mjs, spawned as separate
 * processes and driven over HTTP and the worker's state file. Shared by
 * tests/release-acceptance.test.ts and tests/halt.integration.test.ts; the
 * helpers moved here from release-acceptance unchanged.
 *
 * `children` and `processLogs` are module state on purpose. Vitest evaluates
 * this module once per test file, so every file gets its own copies, and the
 * file's afterEach drains them exactly as release-acceptance always has.
 */
export const children: ChildProcess[] = [];
export const processLogs: string[] = [];

export const notesSource = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export class Notes {
  constructor(path) { this.path = path; }
  add(text) {
    const value = text.trim();
    if (!value || value.length > 200) throw new Error('invalid note');
    const items = this.all();
    const note = { id: crypto.randomUUID(), text: value };
    writeFileSync(this.path, JSON.stringify([...items, note]));
    return note;
  }
  all() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : []; }
}
`;

export const notesTestSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Notes } from './notes.js';
test('persists and validates notes', () => {
  const path = '.notes-test.json';
  rmSync(path, { force: true });
  try {
    const notes = new Notes(path);
    notes.add(' hello ');
    assert.equal(new Notes(path).all()[0].text, 'hello');
    assert.throws(() => notes.add(' '), /invalid note/);
  } finally { rmSync(path, { force: true }); }
});
`;

export type RunDetail = {
  run: { state: string; spent: { usd: number; tokens: number } };
  tasks: Array<{ state: string }>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  messages: Array<{ id: string }>;
  decisions: Array<{ title: string }>;
  blockers: Array<{ status: string; classification: string }>;
  artifacts: Array<{ kind: string }>;
  usage: Array<{ id: string }>;
  attempts: Array<{ providerSessionId?: string }>;
};

export function startCoordinator(label: string, environment: NodeJS.ProcessEnv, port: number) {
  const child = spawnTracked(label, ['apps/coordinator/dist/server.js'], {
    cwd: process.cwd(),
    env: { ...environment, PORT: String(port) },
    stdio: 'pipe',
  });
  children.push(child);
  return child;
}

export function startFixtureWorker(
  label: string,
  common: NodeJS.ProcessEnv,
  port: number,
  overrides: NodeJS.ProcessEnv,
) {
  const child = spawnTracked(label, ['tests/fixtures/release-worker.mjs'], {
    cwd: process.cwd(),
    env: { ...common, ...overrides, FORGE_API_URL: `http://127.0.0.1:${port}` },
    stdio: 'pipe',
  });
  children.push(child);
  return child;
}

export async function registerWorker(api: string, token: string, id: string): Promise<string> {
  const registration = await post<{ sessionToken: string }>(
    `${api}/api/workers/register`,
    { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    {
      id,
      name: `${id}-replacement-session`,
      platform: 'linux',
      capabilities: ['provider:codex'],
      policyProfile: 'release-fixture',
    },
  );
  return registration.sessionToken;
}

export async function waitForRunState(
  api: string,
  headers: Record<string, string>,
  runId: string,
  state: string,
  timeoutMs: number,
) {
  let detail: RunDetail | undefined;
  await waitUntil(async () => {
    detail = await getJson<RunDetail>(`${api}/api/runs/${runId}`, headers);
    return detail.run.state === state;
  }, timeoutMs);
  return detail!;
}

export async function waitForState(
  path: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs: number,
) {
  let state: Record<string, unknown> = {};
  await waitUntil(async () => {
    const value: unknown = await readFile(path, 'utf8')
      .then((content) => JSON.parse(content) as unknown)
      .catch(() => ({}));
    state = isRecord(value) ? value : {};
    return predicate(state);
  }, timeoutMs);
  return state;
}

export async function createFixtureRepository(source: string) {
  await mkdir(source);
  await runGit(['init', '-b', 'main'], source);
  await runGit(['config', 'user.email', 'forge@test.invalid'], source);
  await runGit(['config', 'user.name', 'Forge Release Acceptance'], source);
  await writeFile(source + '/.gitattributes', '* text eol=lf\n');
  await writeFile(source + '/package.json', '{"type":"module","scripts":{"test":"node --test"}}\n');
  await writeFile(source + '/README.md', '# Release acceptance fixture\n');
  await runGit(['add', '.'], source);
  await runGit(['commit', '-m', 'fixture'], source);
}

export async function createAcceptedPatch(source: string, patchPath: string, parent: string) {
  const target = join(parent, 'accepted-result');
  await runGit(['clone', source, target], parent);
  await writeFile(join(target, 'notes.js'), notesSource, 'utf8');
  await writeFile(join(target, 'notes.test.js'), notesTestSource, 'utf8');
  await runGit(['add', 'notes.js', 'notes.test.js'], target);
  const patch = (await runGit(['diff', '--cached', '--binary', 'HEAD', '--'], target)).stdout;
  expect(patch).toContain('notes.js');
  expect(patch).toContain('notes.test.js');
  await writeFile(patchPath, patch, 'utf8');
}

export async function runFixtureTests(cwd: string) {
  const result = await capture(process.execPath, ['--test'], cwd);
  if (result.code !== 0) throw new Error(`Fixture verification failed: ${result.stderr}`);
}

export async function post<T = unknown>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms${lastError ? `: ${formatUnknown(lastError)}` : ''}\n${processLogs.join('\n')}`,
  );
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} was not recorded`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatUnknown(value: unknown): string {
  return value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
}

export function spawnTracked(
  label: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  const child = spawn(process.execPath, args, options);
  child.stdout?.on('data', (chunk: Buffer) => processLogs.push(`${label}: ${chunk.toString()}`));
  child.stderr?.on('data', (chunk: Buffer) => processLogs.push(`${label}: ${chunk.toString()}`));
  child.on('exit', (code, signal) =>
    processLogs.push(`${label}: exited ${code ?? signal ?? 'unknown'}`),
  );
  return child;
}

/**
 * The JSON log records a tracked process has written so far. The coordinator's
 * ForgeLogger emits one JSON object per line; chunks are concatenated first so
 * a line split across two reads still parses. Anything that is not a complete
 * JSON line is skipped rather than failing, because a partial line may still
 * be arriving.
 */
export function logRecords(label: string): Array<Record<string, unknown>> {
  const prefix = `${label}: `;
  const text = processLogs
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .join('');
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Not a complete line yet.
    }
  }
  return records;
}

export async function terminate(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise<void>((resolveWait) => child.once('exit', () => resolveWait())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
}

export async function capture(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}
