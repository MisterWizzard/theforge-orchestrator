import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  escalationFromOutcomeRecord,
  outcomeReportPath,
  outcomeReportTime,
  parseOutcomeRecords,
  toOutcomeRecord,
  writeOutcomeReport,
  type Tier0OutcomeRecord,
} from './report.js';
import type { PullRequestOutcome } from './runner.js';

const outcome = (overrides: Partial<PullRequestOutcome> = {}): PullRequestOutcome => ({
  pullRequest: {
    repository: 'MisterWizzard/shopfront',
    number: 26,
    author: 'dependabot[bot]',
    title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
    headSha: 'abcdef1234567890abcdef1234567890abcdef12',
    mergeable: true,
    behindBase: false,
  },
  checks: [
    { name: 'install', command: 'pnpm install --frozen-lockfile', exitCode: 0, output: 'lots' },
    { name: 'test', command: 'pnpm run test', exitCode: 0, output: 'of output' },
  ],
  decision: { action: 'merge', reason: 'all 2 checks passed against abcdef12' },
  attempts: 1,
  merged: true,
  durationMs: 61_500,
  ...overrides,
});

const MERGE_SHA = '0123456789abcdef0123456789abcdef01234567';

const merged = (): PullRequestOutcome =>
  outcome({ mergedAt: '2026-09-26T01:00:00.000Z', mergeSha: MERGE_SHA });

/** The record shape Tier 0 wrote before F116 recorded the merge commit. */
function withoutMergeSha(record: Tier0OutcomeRecord): Tier0OutcomeRecord {
  const copy: Record<string, unknown> = { ...record };
  delete copy.mergeSha;
  return copy as Tier0OutcomeRecord;
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-tier0-report-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('Tier 0 outcome records', () => {
  it('flattens an outcome and drops check output', () => {
    const record = toOutcomeRecord(merged(), 'execute', 'e8f7f47deadbeef');
    expect(record).toEqual({
      repository: 'MisterWizzard/shopfront',
      number: 26,
      title: 'chore(deps): bump nanoid from 3.3.11 to 3.3.18',
      author: 'dependabot[bot]',
      headSha: 'abcdef1234567890abcdef1234567890abcdef12',
      mode: 'execute',
      action: 'merge',
      reason: 'all 2 checks passed against abcdef12',
      checks: [
        { name: 'install', command: 'pnpm install --frozen-lockfile', exitCode: 0 },
        { name: 'test', command: 'pnpm run test', exitCode: 0 },
      ],
      attempts: 1,
      merged: true,
      mergedAt: '2026-09-26T01:00:00.000Z',
      mergeSha: MERGE_SHA,
      durationMs: 61_500,
      tier0Commit: 'e8f7f47deadbeef',
    });
    expect(JSON.stringify(record)).not.toContain('lots');
  });

  it('carries the hint and omits mergedAt and mergeSha when nothing merged', () => {
    const record = toOutcomeRecord(
      outcome({
        merged: false,
        decision: { action: 'deferred', reason: 'merge state is BEHIND', hint: 'rebase first' },
      }),
      'execute',
      'c0ffee',
    );
    expect(record).toMatchObject({ action: 'deferred', hint: 'rebase first', merged: false });
    expect('mergedAt' in record).toBe(false);
    expect('mergeSha' in record).toBe(false);
  });

  it('reads files written before the merge commit was recorded, and ignores a malformed one', () => {
    const oldShape = withoutMergeSha(toOutcomeRecord(merged(), 'execute', 'c0ffee'));
    const [parsed] = parseOutcomeRecords(JSON.stringify([oldShape]));
    expect(parsed).toEqual(oldShape);
    expect('mergeSha' in parsed!).toBe(false);
    const [malformed] = parseOutcomeRecords(JSON.stringify([{ ...oldShape, mergeSha: 42 }]));
    expect('mergeSha' in malformed!).toBe(false);
    const [empty] = parseOutcomeRecords(JSON.stringify([{ ...oldShape, mergeSha: '' }]));
    expect('mergeSha' in empty!).toBe(false);
  });

  it('reads the write time back out of a default file name, and nothing out of any other', () => {
    expect(outcomeReportTime('20260926T010203Z.json')).toBe(Date.parse('2026-09-26T01:02:03Z'));
    expect(outcomeReportTime('run.json')).toBeUndefined();
    expect(outcomeReportTime('20260926T010203Z.json.bak')).toBeUndefined();
  });

  it('writes a JSON array that parses back, and defaults under the outbox', async () => {
    const path = join(directory, 'nested', 'run.json');
    const records = [toOutcomeRecord(outcome(), 'dry-run', 'c0ffee')];
    await writeOutcomeReport(path, records);
    expect(parseOutcomeRecords(await readFile(path, 'utf8'))).toEqual(records);
    expect(
      outcomeReportPath({ FORGE_OUTBOX_DIR: directory }, Date.parse('2026-09-26T01:02:03Z')),
    ).toBe(resolve(directory, 'tier0', '20260926T010203Z.json'));
    // Beside the workspace root, on whatever filesystem this runs on. The
    // earlier assertion was written against a Windows drive letter and failed
    // on the Linux and macOS runners (CI runs 36207611749 through 36213642655).
    const workspaceRoot = resolve(directory, 'state', 'workspaces');
    const defaultPath = outcomeReportPath({ FORGE_WORKSPACE_ROOT: workspaceRoot });
    expect(dirname(defaultPath)).toBe(resolve(directory, 'state', 'outbox', 'tier0'));
    expect(basename(defaultPath)).toMatch(/^\d{8}T\d{6}Z\.json$/);
  });

  it('rejects files that are not Tier 0 outcomes, naming the problem', () => {
    expect(() => parseOutcomeRecords('nope')).toThrow(/not JSON/);
    expect(() => parseOutcomeRecords('{}')).toThrow(/expected a JSON array/);
    expect(() => parseOutcomeRecords('[1]')).toThrow(/outcome\[0\] is not an object/);
    expect(() => parseOutcomeRecords(JSON.stringify([{ action: 'merge' }]))).toThrow(
      /outcome\[0\]\.mode must be a string/,
    );
    expect(() =>
      parseOutcomeRecords(
        JSON.stringify([{ ...toOutcomeRecord(outcome(), 'execute', 'x'), action: 'launch' }]),
      ),
    ).toThrow(/'launch' is not a Tier 0 action/);
  });
});

describe('escalationFromOutcomeRecord', () => {
  const record = (overrides: Partial<Tier0OutcomeRecord> = {}): Tier0OutcomeRecord => ({
    ...toOutcomeRecord(merged(), 'execute', 'e8f7f47deadbeef'),
    ...overrides,
  });

  it('turns an executed merge into an info escalation keyed on repo, number and head', () => {
    const escalation = escalationFromOutcomeRecord(record());
    expect(escalation).toMatchObject({
      kind: 'tier0.merge',
      severity: 'info',
      paused: false,
      project: 'MisterWizzard/shopfront',
      task: 'PR #26: chore(deps): bump nanoid from 3.3.11 to 3.3.18',
      occurredAt: '2026-09-26T01:00:00.000Z',
      dedupeKey: 'tier0:merge:MisterWizzard/shopfront#26@abcdef1234567890abcdef1234567890abcdef12',
    });
    expect(escalation?.title).toBe(
      'Tier 0 merged MisterWizzard/shopfront#26: chore(deps): bump nanoid from 3.3.11 to 3.3.18',
    );
    expect(escalation?.evidence).toEqual([
      'MisterWizzard/shopfront#26 at abcdef1234567890abcdef1234567890abcdef12',
      `merged as ${MERGE_SHA}`,
      'checks: install exit 0, test exit 0',
      'attempts 1, 62 s, Tier 0 at e8f7f47d',
    ]);
    // A file from before the SHA was recorded: the line is simply absent.
    expect(escalationFromOutcomeRecord(withoutMergeSha(record()))?.evidence).toHaveLength(3);
  });

  it('turns an escalation into a warning that carries the hint and the failed checks', () => {
    const escalation = escalationFromOutcomeRecord(
      record({
        action: 'escalate',
        reason: '1 of 2 checks failed: test (exit 1)',
        hint: 'A rebase may resolve this',
        merged: false,
        checks: [
          { name: 'install', command: 'i', exitCode: 0 },
          { name: 'test', command: 't', exitCode: 1 },
        ],
      }),
      '2026-09-26T02:00:00.000Z',
    );
    expect(escalation).toMatchObject({ kind: 'tier0.escalate', severity: 'warn', paused: false });
    expect(escalation?.what).toBe(
      '1 of 2 checks failed: test (exit 1). Failed: test.\nA rebase may resolve this',
    );
    expect(escalation?.options[0]?.label).toContain('@dependabot rebase');
    expect(escalation?.recommendation).toContain('Try the rebase first');
    expect(escalation?.occurredAt).toBe('2026-09-26T02:00:00.000Z');
  });

  it('turns a deferral into an info escalation', () => {
    const escalation = escalationFromOutcomeRecord(
      record({
        action: 'deferred',
        reason: 'merge state is BEHIND',
        hint: 'asked to rebase',
        merged: false,
      }),
    );
    expect(escalation).toMatchObject({ kind: 'tier0.deferred', severity: 'info' });
    expect(escalation?.what).toContain('found merge state is BEHIND. Nothing was merged.');
  });

  it('says nothing for skips, verify-only, and a dry run that would have merged', () => {
    expect(escalationFromOutcomeRecord(record({ action: 'skip', merged: false }))).toBeNull();
    expect(
      escalationFromOutcomeRecord(record({ action: 'verify-only', merged: false })),
    ).toBeNull();
    expect(escalationFromOutcomeRecord(record({ mode: 'dry-run', merged: false }))).toBeNull();
  });
});
