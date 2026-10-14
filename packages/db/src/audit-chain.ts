import { createHash } from 'node:crypto';

/**
 * The event hash-chain rule, shared with the PostgreSQL trigger in
 * migrations/006_audit_chain_and_notifications.sql.
 *
 * Every events row carries `prev_hash` (the `row_hash` of the previous row of
 * the same run in sequence order, or GENESIS_HASH for the first) and
 * `row_hash` = SHA-256 of a canonical string. The canonical string is the jsonb
 * text rendering of this nine-element array:
 *
 *   [sequence, id, run_id, task_id, attempt_id, type, payload, created_at, prev_hash]
 *
 * with task_id and attempt_id as JSON null when absent and created_at as UTC
 * ISO-8601 at millisecond precision with a `Z` suffix. The trigger builds it
 * with `jsonb_build_array(...)::text`; canonicalJsonb() below renders the same
 * text from a JavaScript value, so the verifier can recompute every hash from
 * the row it reads back and a test can check an in-memory event against what
 * PostgreSQL stored.
 *
 * jsonb text output is deterministic, which is why it was chosen over the raw
 * JSON the coordinator sent: object keys are sorted by UTF-8 byte length and
 * then bytewise, members are joined with ", " and keys with ": ", control
 * characters are escaped (`\n`, `\t`, `\u001f`), non-ASCII is emitted raw, and
 * numbers are printed by `numeric` without an exponent (1e21 becomes
 * 1000000000000000000000). A value only ever reaches PostgreSQL through
 * JSON.stringify (postgres.js `sql.json`), so canonicalJsonb() first
 * round-trips through JSON to shed what JSON.stringify sheds (undefined,
 * functions, NaN) and to see the same number text PostgreSQL parsed.
 */

export const GENESIS_HASH = sha256Hex('GENESIS');

export type ChainedEventFields = {
  sequence: number;
  id: string;
  runId: string;
  taskId?: string | null | undefined;
  attemptId?: string | null | undefined;
  type: string;
  payload: unknown;
  /** ISO-8601 string or Date; normalised to millisecond UTC either way. */
  createdAt: string | Date;
  prevHash: string;
};

export function canonicalEventString(fields: ChainedEventFields): string {
  return canonicalJsonb([
    fields.sequence,
    fields.id,
    fields.runId,
    fields.taskId ?? null,
    fields.attemptId ?? null,
    fields.type,
    fields.payload,
    new Date(fields.createdAt).toISOString(),
    fields.prevHash,
  ]);
}

export function eventRowHash(fields: ChainedEventFields): string {
  return sha256Hex(canonicalEventString(fields));
}

/** Render `value` exactly as PostgreSQL prints the jsonb it would store for it. */
export function canonicalJsonb(value: unknown): string {
  const serialised = JSON.stringify(value);
  if (serialised === undefined) {
    throw new Error('canonicalJsonb: value has no JSON representation');
  }
  return renderJsonb(JSON.parse(serialised));
}

function renderJsonb(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return renderNumber(value);
  if (typeof value === 'string') return renderString(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(renderJsonb).join(', ')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareJsonbKeys);
  if (keys.length === 0) return '{}';
  return `{${keys.map((key) => `${renderString(key)}: ${renderJsonb(record[key])}`).join(', ')}}`;
}

/** jsonb orders object keys by byte length first, then by bytewise comparison. */
function compareJsonbKeys(a: string, b: string): number {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return left.length - right.length;
  return Buffer.compare(left, right);
}

/**
 * PostgreSQL's escape_json: the five short escapes, quote and backslash, other
 * control characters as lower-case \u00xx, everything else (including all
 * non-ASCII) verbatim. JSON.stringify agrees on every one of these.
 */
function renderString(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      default: {
        const code = char.charCodeAt(0);
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
      }
    }
  }
  return `${out}"`;
}

/**
 * The number text PostgreSQL parsed is JSON.stringify's shortest round-trip
 * form; `numeric` keeps every digit of it but prints without an exponent.
 */
function renderNumber(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
