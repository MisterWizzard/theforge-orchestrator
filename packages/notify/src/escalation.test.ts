import { describe, expect, it } from 'vitest';
import { formatOccurredAt, maxSeverity, renderEscalation, type Escalation } from './escalation.js';
import { sample } from './fixture.js';

describe('renderEscalation', () => {
  it('lays out title, context, what, options with consequences, recommendation and evidence in that order', () => {
    const { subject, text } = renderEscalation(sample());
    expect(subject).toBe('Forge warning: Run 9d6cf990 wants to push forge/9d6cf990 [paused]');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Run 9d6cf990 wants to push forge/9d6cf990');
    // 23:39 UTC on the 25th is 09:39 on the 26th in Sydney (AEST, UTC+10).
    expect(lines[1]).toBe(
      'WARN · 26/09/2026 09:39 AEST · run 9d6cf990 · acceptance-fixture / Integrate and report',
    );
    expect(lines[2]).toBe('PAUSED: nothing proceeds until you act.');
    const order = ['What happened', 'Options', 'Recommendation', 'Evidence'].map((heading) =>
      lines.indexOf(heading),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(
      '1. Approve the push\n   -> The branch is pushed and a draft PR is opened.',
    );
    expect(text).toContain('2. Reject it\n   -> The worktree is kept; nothing reaches GitHub.');
    expect(text).toContain('Recommendation\nRead the diff in the dashboard before approving.');
    expect(text).toContain('- event 1234\n- commit 48c669ca');
    expect(lines.at(-1)).toBe('kind decision.approval · key decision.approval:9d6cf990:approval-1');
  });

  it('marks severity in the subject and omits the paused line when nothing waits', () => {
    expect(renderEscalation(sample({ severity: 'info', paused: false })).subject).toBe(
      'Forge: Run 9d6cf990 wants to push forge/9d6cf990',
    );
    expect(renderEscalation(sample({ severity: 'critical', paused: false })).subject).toBe(
      'Forge CRITICAL: Run 9d6cf990 wants to push forge/9d6cf990',
    );
    expect(renderEscalation(sample({ paused: false })).text).not.toContain('PAUSED');
  });

  it('copes without project, task, run, options or evidence', () => {
    const full = sample({ options: [], evidence: [] });
    const bare: Escalation = {
      kind: full.kind,
      title: full.title,
      what: full.what,
      options: full.options,
      evidence: full.evidence,
      recommendation: full.recommendation,
      paused: full.paused,
      severity: full.severity,
      dedupeKey: full.dedupeKey,
      occurredAt: full.occurredAt,
    };
    const { text } = renderEscalation(bare);
    expect(text.split('\n')[1]).toBe('WARN · 26/09/2026 09:39 AEST');
    expect(text).not.toContain('Options');
    expect(text).not.toContain('Evidence');
    expect(text).toContain('Recommendation');
  });

  it('renders the timestamp in the requested zone and passes unparseable text through', () => {
    expect(formatOccurredAt('2026-01-10T03:00:00Z', 'UTC')).toBe('10/01/2026 03:00 UTC');
    expect(formatOccurredAt('2026-01-10T03:00:00Z')).toBe('10/01/2026 14:00 AEDT');
    expect(formatOccurredAt('not a date')).toBe('not a date');
  });

  it('orders severities info < warn < critical', () => {
    expect(maxSeverity('info', 'warn')).toBe('warn');
    expect(maxSeverity('critical', 'warn')).toBe('critical');
    expect(maxSeverity('info', 'info')).toBe('info');
  });
});
