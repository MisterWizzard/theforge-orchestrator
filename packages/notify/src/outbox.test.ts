import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderEscalation } from './escalation.js';
import { sample } from './fixture.js';
import { compactTimestamp, FileOutboxChannel, fileToken, localDayFolder } from './outbox.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-outbox-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('FileOutboxChannel', () => {
  it('writes a Markdown and a JSON file under the local day folder', async () => {
    // 23:39 UTC on 25 September is already 26 September in Sydney.
    const now = () => Date.parse('2026-09-25T23:39:00.123Z');
    const channel = new FileOutboxChannel({ dir: directory, now });
    const escalation = sample();
    const rendered = renderEscalation(escalation);
    await channel.send(rendered, escalation);

    expect(await readdir(directory)).toEqual(['20260926']);
    const files = (await readdir(join(directory, '20260926'))).sort();
    expect(files).toEqual([
      '20260925T233900.123Z-decision.approval-decision.approval-9d6cf990-approval-1.json',
      '20260925T233900.123Z-decision.approval-decision.approval-9d6cf990-approval-1.md',
    ]);
    const markdown = await readFile(join(directory, '20260926', files[1]!), 'utf8');
    expect(markdown).toBe(`# ${rendered.subject}\n\n${rendered.text}\n`);
    const json = JSON.parse(await readFile(join(directory, '20260926', files[0]!), 'utf8')) as {
      writtenAt: string;
      escalation: unknown;
      rendered: unknown;
    };
    expect(json).toEqual({
      writtenAt: '2026-09-25T23:39:00.123Z',
      escalation,
      rendered,
    });
    // No temporary files left behind by the atomic write.
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('numbers a second file with the same stem instead of overwriting', async () => {
    const now = () => Date.parse('2026-09-26T00:00:00.000Z');
    const channel = new FileOutboxChannel({ dir: directory, now, timeZone: 'UTC' });
    await channel.send(renderEscalation(sample()), sample());
    await channel.send(renderEscalation(sample({ what: 'second' })), sample({ what: 'second' }));
    const files = (await readdir(join(directory, '20260926'))).sort();
    expect(files).toHaveLength(4);
    expect(files.filter((name) => name.endsWith('-2.json'))).toHaveLength(1);
  });

  it('sanitises kind and key into file-safe tokens', () => {
    expect(fileToken('ci.failed')).toBe('ci.failed');
    expect(fileToken('tier0:example-org/shopfront#26@abcdef')).toBe(
      'tier0-example-org-shopfront-26-abcdef',
    );
    expect(fileToken('///')).toBe('x');
    expect(fileToken('a'.repeat(100)).length).toBe(48);
  });

  it('folders follow the requested zone and timestamps are compact UTC', () => {
    const time = Date.parse('2026-09-25T23:39:00Z');
    expect(localDayFolder(time)).toBe('20260926');
    expect(localDayFolder(time, 'UTC')).toBe('20260925');
    expect(compactTimestamp(time)).toBe('20260925T233900.000Z');
  });
});
