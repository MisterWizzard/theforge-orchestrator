/**
 * The file outbox: the channel that is always on.
 *
 * Every escalation lands here as a Markdown file for a human and a JSON file
 * for tooling, whether or not the push or the email went out. It is the
 * evidence trail when the phone is off, the record the digests read, and the
 * only channel that works before the Home Assistant token and the Gmail app
 * password exist.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Channel } from './channel.js';
import { DEFAULT_TIME_ZONE, type Escalation, type RenderedEscalation } from './escalation.js';

export type FileOutboxOptions = {
  dir: string;
  /** Day folders follow the local day, policy B12: Dan's day, not UTC's. */
  timeZone?: string;
  now?: () => number;
};

/** Filename-safe token: anything outside [A-Za-z0-9._-] becomes '-', bounded in length. */
export function fileToken(value: string, maxLength = 48): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (safe || 'x').slice(0, maxLength);
}

/** yyyymmdd in the given zone. */
export function localDayFolder(time: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** 20260926T083000.123Z: sortable, no characters Windows objects to. */
export function compactTimestamp(time: number): string {
  return new Date(time).toISOString().replace(/[-:]/g, '');
}

/**
 * Write-to-temp then rename, so a digest reading the folder never sees a half
 * file. The temporary name carries a different extension so a reader that
 * globs `*.json` or `*.md` skips it.
 */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class FileOutboxChannel implements Channel {
  readonly name = 'file';
  private readonly dir: string;
  private readonly timeZone: string;
  private readonly now: () => number;

  constructor(options: FileOutboxOptions) {
    this.dir = options.dir;
    this.timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    this.now = options.now ?? Date.now;
  }

  async send(rendered: RenderedEscalation, escalation: Escalation): Promise<void> {
    const time = this.now();
    const folder = join(this.dir, localDayFolder(time, this.timeZone));
    await mkdir(folder, { recursive: true });
    const stem = `${compactTimestamp(time)}-${fileToken(escalation.kind)}-${fileToken(escalation.dedupeKey)}`;
    // Two escalations in the same millisecond with the same key are possible in
    // a coalesced burst; number the second rather than overwrite the first.
    let base = join(folder, stem);
    for (let suffix = 2; await exists(`${base}.json`); suffix += 1) {
      base = join(folder, `${stem}-${suffix}`);
    }
    const writtenAt = new Date(time).toISOString();
    await writeFileAtomically(`${base}.md`, `# ${rendered.subject}\n\n${rendered.text}\n`);
    await writeFileAtomically(
      `${base}.json`,
      `${JSON.stringify({ writtenAt, escalation, rendered }, null, 2)}\n`,
    );
  }
}
