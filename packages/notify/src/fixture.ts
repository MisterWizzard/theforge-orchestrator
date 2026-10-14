/** A complete escalation for the test suites; every field is deliberately non-empty. */
import type { Escalation } from './escalation.js';

export const sample = (overrides: Partial<Escalation> = {}): Escalation => ({
  kind: 'decision.approval',
  title: 'Run 9d6cf990 wants to push forge/9d6cf990',
  what: 'The builder finished and the deterministic checks passed; the push needs an exact-action approval.',
  project: 'acceptance-fixture',
  task: 'Integrate and report',
  runId: '9d6cf990-0000-4000-8000-000000000000',
  options: [
    { label: 'Approve the push', consequence: 'The branch is pushed and a draft PR is opened.' },
    { label: 'Reject it', consequence: 'The worktree is kept; nothing reaches GitHub.' },
  ],
  evidence: ['event 1234', 'commit 48c669ca'],
  recommendation: 'Read the diff in the dashboard before approving.',
  paused: true,
  severity: 'warn',
  dedupeKey: 'decision.approval:9d6cf990:approval-1',
  occurredAt: '2026-09-25T23:39:00.000Z',
  ...overrides,
});
