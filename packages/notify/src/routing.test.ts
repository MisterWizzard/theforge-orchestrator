import { describe, expect, it } from 'vitest';
import type { EscalationSeverity } from './escalation.js';
import {
  channelReceives,
  channelsForSeverity,
  SEVERITIES,
  SEVERITY_ROUTING,
  SKIPPED_BY_ROUTING,
} from './routing.js';

const names = (channels: readonly { name: string }[]) => channels.map((channel) => channel.name);
const configured = [{ name: 'file' }, { name: 'ha' }, { name: 'email' }];

describe('severity routing (ADR-023)', () => {
  it('sends warn and critical to phone, email and file, and info to email and file only', () => {
    const table: Record<EscalationSeverity, string[]> = { info: [], warn: [], critical: [] };
    for (const severity of SEVERITIES) {
      table[severity] = names(channelsForSeverity(severity, configured).routed);
    }
    expect(table).toEqual({
      info: ['file', 'email'],
      warn: ['file', 'ha', 'email'],
      critical: ['file', 'ha', 'email'],
    });
    expect(names(channelsForSeverity('info', configured).skipped)).toEqual(['ha']);
    expect(channelsForSeverity('warn', configured).skipped).toEqual([]);
    expect(channelsForSeverity('critical', configured).skipped).toEqual([]);
  });

  it('never withholds the file outbox, whatever the severity', () => {
    for (const severity of SEVERITIES) expect(channelReceives('file', severity)).toBe(true);
    expect(SEVERITY_ROUTING.file).toEqual(SEVERITIES);
    expect(SEVERITY_ROUTING.email).toEqual(SEVERITIES);
    expect(SEVERITY_ROUTING.ha).toEqual(['warn', 'critical']);
  });

  it('keeps the order the channels were given and returns the same objects', () => {
    const reversed = [...configured].reverse();
    const { routed, skipped } = channelsForSeverity('info', reversed);
    expect(routed).toEqual([reversed[0], reversed[2]]);
    expect(routed[0]).toBe(reversed[0]);
    expect(skipped[0]).toBe(reversed[1]);
  });

  it('routes a channel the table does not name for every severity', () => {
    const unknown = [{ name: 'pager' }];
    for (const severity of SEVERITIES) {
      expect(channelReceives('pager', severity)).toBe(true);
      expect(channelsForSeverity(severity, unknown)).toEqual({ routed: unknown, skipped: [] });
    }
  });

  it('copes with no channels at all', () => {
    expect(channelsForSeverity('critical', [])).toEqual({ routed: [], skipped: [] });
  });

  it('names the reason a skipped result carries', () => {
    expect(SKIPPED_BY_ROUTING).toBe('severity_routing');
  });
});
