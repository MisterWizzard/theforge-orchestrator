import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notifier, renderEscalation, type Channel, type RouteChannels } from '@theforge/notify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classify,
  createEscalationHook,
  notificationRecorder,
  recordsFromReport,
  type EventLike,
  type NotificationRecord,
} from './escalation.js';

const RUN = '9d6cf990-1111-4222-8333-444444444444';

const event = (type: string, payload: Record<string, unknown> = {}): EventLike => ({
  id: `evt-${type}`,
  runId: RUN,
  type,
  payload,
  createdAt: '2026-09-25T23:39:00.000Z',
});

describe('classify: policy B11 triggers', () => {
  it('security: high or critical review findings, with the worst severity winning', () => {
    const high = classify(
      event('review.completed', {
        round: 2,
        approved: false,
        findings: [
          { severity: 'low', claim: 'nit', action: 'ignore' },
          { severity: 'high', claim: 'SQL built by string concatenation', action: 'parameterise' },
        ],
      }),
      { project: 'shopfront', task: 'Review and verify' },
    );
    expect(high).toMatchObject({
      kind: 'security.finding',
      severity: 'warn',
      paused: false,
      project: 'shopfront',
      task: 'Review and verify',
      dedupeKey: `security.finding:${RUN}:round-2`,
    });
    expect(high?.title).toBe('Reviewer found 1 high-severity issue in run 9d6cf990');
    expect(high?.what).toContain('- [high] SQL built by string concatenation');
    expect(high?.options.map((option) => option.label)).toEqual([
      'Let the repair loop run',
      `Cancel this run: POST /api/runs/${RUN}/control {"action":"cancel"}`,
      'Halt everything: pnpm forge halt --reason="..."',
    ]);
    expect(high?.evidence).toEqual(['event evt-review.completed (review.completed)']);

    const critical = classify(
      event('review.completed', {
        round: 1,
        findings: [
          { severity: 'high', claim: 'a', action: 'x' },
          { severity: 'critical', claim: 'secret committed', action: 'rotate' },
        ],
      }),
    );
    expect(critical?.severity).toBe('critical');
    expect(critical?.title).toContain('2 critical-severity issues');
    expect(critical?.recommendation).toContain('Read the finding now');
  });

  it('security: ignores reviews with only low or medium findings, or none', () => {
    expect(
      classify(event('review.completed', { findings: [{ severity: 'medium', claim: 'c' }] })),
    ).toBeNull();
    expect(classify(event('review.completed', { approved: true, findings: [] }))).toBeNull();
    expect(classify(event('review.completed', { findings: 'nope' }))).toBeNull();
  });

  it('security: integration blocked by a safety constraint is critical and paused', () => {
    const blocked = classify(
      event('integration.blocked', {
        classification: 'safety_constraint',
        smallestUnblockAction: 'Review and approve the changed commit explicitly.',
      }),
    );
    expect(blocked).toMatchObject({
      kind: 'security.integration_blocked',
      severity: 'critical',
      paused: true,
      dedupeKey: `security.integration_blocked:${RUN}`,
    });
    expect(blocked?.what).toContain('Suggested unblock: Review and approve the changed commit');
    expect(blocked?.options).toHaveLength(3);
  });

  it('decision: integration blocked on missing access names the variable', () => {
    const blocked = classify(
      event('integration.blocked', {
        classification: 'missing_access',
        smallestUnblockAction: 'Set GITHUB_TOKEN and retry the exact integration approval.',
      }),
    );
    expect(blocked).toMatchObject({
      kind: 'decision.missing_access',
      severity: 'warn',
      paused: true,
    });
    expect(blocked?.title).toContain('GITHUB_TOKEN is not set');
    expect(classify(event('integration.blocked', { classification: 'transient' }))).toBeNull();
  });

  it('ci: failed verification lists the failing checks and is keyed on them', () => {
    const failed = classify(
      event('verification.completed', {
        passed: false,
        checks: [
          { command: 'pnpm test', code: 1, stdout: '', stderr: '' },
          { command: 'pnpm lint', code: 0, stdout: '', stderr: '' },
        ],
      }),
    );
    expect(failed).toMatchObject({
      kind: 'ci.failed',
      severity: 'warn',
      paused: true,
      dedupeKey: `ci.failed:${RUN}:pnpm`,
    });
    expect(failed?.what).toContain('pnpm test (exit 1)');
    expect(failed?.what).not.toContain('pnpm lint');
    expect(classify(event('verification.completed', { passed: true, checks: [] }))).toBeNull();
  });

  it('ci: run.failed and integration.failed carry the message', () => {
    const run = classify(event('run.failed', { message: 'Worker job timed out' }));
    expect(run).toMatchObject({ kind: 'run.failed', severity: 'critical', paused: true });
    expect(run?.title).toBe('Run 9d6cf990 failed: Worker job timed out');
    const integration = classify(event('integration.failed', { message: 'push rejected (403)' }));
    expect(integration).toMatchObject({
      kind: 'ci.integration_failed',
      severity: 'warn',
      paused: true,
    });
    expect(integration?.what).toContain('push rejected (403)');
  });

  it('ci: a non-zero worker job in any phase, but not a clean one', () => {
    const job = classify(
      event('verification.worker_job_finished', { jobId: 'job-7', workerId: 'w1', code: 127 }),
    );
    expect(job).toMatchObject({
      kind: 'ci.worker_job_failed',
      severity: 'warn',
      paused: false,
      dedupeKey: 'ci.worker_job_failed:job-7',
    });
    expect(job?.title).toBe('verification job exited 127 in run 9d6cf990');
    expect(
      classify(event('provider.claude.worker_job_finished', { jobId: 'job-8', code: 2 }))?.title,
    ).toBe('provider.claude job exited 2 in run 9d6cf990');
    expect(
      classify(event('verification.worker_job_finished', { jobId: 'job-9', code: 0 })),
    ).toBeNull();
    expect(classify(event('verification.worker_job_finished', { jobId: 'job-9' }))).toBeNull();
  });

  it('decision: an approval request is paused and names the approval endpoint', () => {
    const approval = classify(
      event('approval.requested', { approvalId: 'appr-1', actionClass: 'amber' }),
    );
    expect(approval).toMatchObject({
      kind: 'decision.approval',
      severity: 'warn',
      paused: true,
      dedupeKey: 'decision.approval:appr-1',
    });
    expect(approval?.options[0]?.label).toBe(
      'Approve: POST /api/approvals/appr-1 {"decision":"approved"}',
    );
    expect(approval?.options[2]?.consequence).toContain('expires');
  });

  it('spend: warning and ceiling are keyed on the local day (slice B3 event names)', () => {
    const warn = classify(
      event('spend.warn', {
        dayUsd: 15.2,
        ceilingUsd: 20,
        fraction: 0.76,
        day: '2026-09-26',
        timezone: 'Australia/Sydney',
      }),
    );
    expect(warn).toMatchObject({ kind: 'spend.warn', severity: 'warn', paused: false });
    expect(warn?.title).toBe('Cloud spend at 76% of the daily ceiling');
    expect(warn?.what).toContain('$15.20 of the $20.00 ceiling');
    expect(warn?.dedupeKey).toBe('spend.warn:2026-09-26');

    const ceiling = classify(
      event('spend.ceiling', {
        dayUsd: 20.01,
        ceilingUsd: 20,
        day: '2026-09-26',
        timezone: 'Australia/Sydney',
        routing: 'local-only',
      }),
    );
    expect(ceiling).toMatchObject({ kind: 'spend.ceiling', severity: 'critical', paused: false });
    expect(ceiling?.title).toBe('Daily cloud ceiling reached ($20.01 of $20.00)');
    expect(ceiling?.what).toContain('Routing is now local-only');
    expect(ceiling?.dedupeKey).toBe('spend.ceiling:2026-09-26');
  });

  it('guards: task limit and pause-by-guard', () => {
    const limit = classify(
      event('guard.task_limit', {
        jobId: 'job-3',
        role: 'builder',
        reason: 'tool call limit exceeded (201 > 200)',
        usage: { toolCalls: 201 },
      }),
    );
    expect(limit).toMatchObject({ kind: 'guard.task_limit', severity: 'warn', paused: false });
    expect(limit?.title).toBe('A builder job hit its task limit in run 9d6cf990');
    expect(limit?.what).toContain('tool call limit exceeded (201 > 200)');

    const paused = classify(
      event('run.paused_by_guard', {
        guard: 'spend',
        reason: 'daily ceiling reached',
        resumeHint: 'pnpm forge resume-run 9d6cf990',
      }),
    );
    expect(paused).toMatchObject({
      kind: 'run.paused',
      paused: true,
      dedupeKey: `run.paused:${RUN}:spend`,
    });
    expect(paused?.options[0]?.label).toBe('pnpm forge resume-run 9d6cf990');
    expect(paused?.recommendation).toContain('next local day');
  });

  it('policy: a run finished on a safety_constraint blocker reaches Dan, other finishes do not', () => {
    const stopped = classify(
      event('run.finished', {
        state: 'partially_completed',
        blocker: 'builder must not run locally; stopping the run at the ceiling',
        classification: 'safety_constraint',
      }),
    );
    expect(stopped).toMatchObject({
      kind: 'run.policy_stop',
      severity: 'warn',
      paused: false,
      dedupeKey: `run.policy_stop:${RUN}`,
    });
    expect(stopped?.what).toContain('must not run locally');
    expect(classify(event('run.finished', { state: 'completed' }))).toBeNull();
    expect(
      classify(
        event('run.finished', {
          state: 'partially_completed',
          blocker: 'no token',
          classification: 'missing_access',
        }),
      ),
    ).toBeNull();
  });

  it('ignores everything else', () => {
    for (const type of [
      'run.started',
      'plan.completed',
      'build.completed',
      'integration.pull_request_created',
      'usage.recorded',
      'approval.decided',
      'run.finished',
      'worker_job.lease_reconciled',
    ]) {
      expect(classify(event(type, { anything: true })), type).toBeNull();
    }
  });
});

describe('escalation hook', () => {
  let outbox: string;
  beforeEach(async () => {
    outbox = await mkdtemp(join(tmpdir(), 'forge-escalation-'));
  });
  afterEach(async () => {
    await rm(outbox, { recursive: true, force: true });
  });

  type Logged = { level: string; message: string; runId?: string };

  function harness(channels: Channel[], recorder?: unknown, route?: RouteChannels) {
    const logged: Logged[] = [];
    const notifier = new Notifier({
      channels,
      outboxDir: outbox,
      sleep: async () => {},
      backoffMs: [0],
      ...(route ? { route } : {}),
    });
    let counter = 0;
    const hook = createEscalationHook({
      notifier,
      recorder,
      recordId: () => `rec-${(counter += 1)}`,
      log: (level, message, runId) => logged.push({ level, message, ...(runId ? { runId } : {}) }),
      context: () => ({ project: 'Fixture', task: 'Integrate and report' }),
    });
    return { hook, logged };
  }

  it('never throws into the event path, whatever the event or the channel does', async () => {
    const exploding: Channel = {
      name: 'ha',
      async send() {
        throw new Error('boom');
      },
    };
    const { hook, logged } = harness([exploding]);
    expect(() => hook.onEvent({ not: 'an event' })).not.toThrow();
    expect(() =>
      hook.onEvent({ type: 'run.failed', runId: RUN, payload: 'garbage' }),
    ).not.toThrow();
    expect(() => hook.onEvent({ type: 42, runId: RUN })).not.toThrow();
    expect(() =>
      hook.onEvent({ id: 'e1', type: 'run.failed', runId: RUN, payload: { message: 'x' } }),
    ).not.toThrow();
    await hook.close();
    const errors = logged.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(2);
    expect(errors.every((line) => line.message.includes('not delivered on ha: boom'))).toBe(true);
    expect(errors[0]?.runId).toBe(RUN);
  });

  it('delivers through the notifier and records one row per channel when the repository can', async () => {
    const sent: string[] = [];
    const ok: Channel = {
      name: 'file',
      async send(rendered) {
        sent.push(rendered.subject);
      },
    };
    const records: NotificationRecord[] = [];
    const repository = {
      async recordNotification(record: NotificationRecord) {
        records.push(record);
      },
      putRun: () => undefined,
    };
    const { hook, logged } = harness([ok], repository);
    hook.onEvent({
      id: 'e-approval',
      runId: RUN,
      type: 'approval.requested',
      payload: { approvalId: 'appr-9', actionClass: 'amber' },
      createdAt: '2026-09-25T23:39:00.000Z',
    });
    // The same approval again inside the window: deduplicated, and recorded as such.
    hook.onEvent({
      id: 'e-approval-2',
      runId: RUN,
      type: 'approval.requested',
      payload: { approvalId: 'appr-9', actionClass: 'amber' },
      createdAt: '2026-09-25T23:40:00.000Z',
    });
    await hook.close();
    expect(sent).toEqual([
      'Forge warning: Run 9d6cf990 is ready to push and needs your approval [paused]',
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: 'rec-1',
      runId: RUN,
      kind: 'decision.approval',
      dedupeKey: 'decision.approval:appr-9',
      channel: 'file',
      status: 'sent',
      attempts: 1,
    });
    expect(records[0]?.payload).toMatchObject({
      project: 'Fixture',
      task: 'Integrate and report',
    });
    expect(records[0]?.lastError).toBeUndefined();
    expect(records[1]).toMatchObject({
      id: 'rec-2',
      runId: RUN,
      kind: 'decision.approval',
      dedupeKey: 'decision.approval:appr-9',
      channel: 'notifier',
      status: 'duplicate',
      attempts: 0,
    });
    expect(records[1]?.payload).toMatchObject({ kind: 'decision.approval' });
    expect(records[1]?.lastError).toContain('already sent at');
    expect(logged.map((line) => line.level)).toEqual(['info', 'info']);
    expect(logged[0]?.message).toBe('Escalation decision.approval sent via file');
    expect(logged[1]?.message).toBe('Escalation decision.approval duplicate');
  });

  it('keeps going when the recorder itself fails, and copes without one', async () => {
    const ok: Channel = { name: 'file', async send() {} };
    const broken = {
      async recordNotification() {
        throw new Error('no table');
      },
    };
    const withBroken = harness([ok], broken);
    withBroken.hook.onEvent({ id: 'e', runId: RUN, type: 'run.failed', payload: { message: 'm' } });
    await withBroken.hook.close();
    expect(withBroken.logged.map((line) => line.level)).toEqual(['info', 'warn']);
    expect(withBroken.logged[1]?.message).toBe('Notification record not persisted: no table');

    const without = harness([ok], { somethingElse: true });
    without.hook.onEvent({ id: 'e', runId: RUN, type: 'run.failed', payload: { message: 'm' } });
    await without.hook.close();
    expect(without.logged.map((line) => line.level)).toEqual(['info']);
    expect(notificationRecorder(undefined)).toBeUndefined();
    expect(notificationRecorder({ recordNotification: 'not a function' })).toBeUndefined();
  });

  it('writes the outbox files for a real escalation through the default file channel', async () => {
    const { FileOutboxChannel } = await import('@theforge/notify');
    // FileOutboxChannel buckets by WRITE time, not by the escalation's own
    // timestamp, and takes `now` for exactly this reason. Without it this test
    // asserted a hardcoded folder against the real clock, so it passed only on
    // the day it was written and failed from 27/09/2026 onwards.
    const writtenAt = Date.parse('2026-09-26T00:00:00.000Z');
    const { hook } = harness([
      new FileOutboxChannel({ dir: outbox, timeZone: 'UTC', now: () => writtenAt }),
    ]);
    hook.onEvent({
      id: 'e-ci',
      runId: RUN,
      type: 'verification.completed',
      payload: { passed: false, checks: [{ command: 'pnpm test', code: 1 }] },
      createdAt: '2026-09-26T00:00:00.000Z',
    });
    await hook.close();
    const files = await readdir(join(outbox, '20260926'));
    expect(files.filter((name) => name.endsWith('.md'))).toHaveLength(1);
    expect(files[0]).toContain('-ci.failed-');
  });

  it('recordsFromReport maps a failed channel to a failed row with its error, and a skipped one to a skipped row', () => {
    const escalation = classify(event('run.failed', { message: 'x' }))!;
    const rows = recordsFromReport(
      {
        dedupeKey: escalation.dedupeKey,
        outcome: 'sent',
        channels: [
          { channel: 'file', status: 'sent', attempts: 1 },
          { channel: 'ha', status: 'failed', attempts: 3, error: 'HTTP 503' },
          { channel: 'email', status: 'skipped', attempts: 0, reason: 'severity_routing' },
        ],
        rendered: renderEscalation(escalation),
      },
      escalation,
      RUN,
      () => 'id',
    );
    expect(rows.map((row) => [row.channel, row.status, row.attempts, row.lastError])).toEqual([
      ['file', 'sent', 1, undefined],
      ['ha', 'failed', 3, 'HTTP 503'],
      ['email', 'skipped', 0, undefined],
    ]);
  });

  it('logs a channel left out by severity routing as skipped, not as a failure, and records it as skipped', async () => {
    const calls: string[] = [];
    const file: Channel = {
      name: 'file',
      async send() {
        calls.push('file');
      },
    };
    const ha: Channel = {
      name: 'ha',
      async send() {
        calls.push('ha');
      },
    };
    const records: NotificationRecord[] = [];
    const repository = {
      async recordNotification(record: NotificationRecord) {
        records.push(record);
      },
    };
    // Every coordinator trigger is warn or critical, so the ADR-023 table would
    // send all of them to the phone; a route that withholds it stands in for
    // the info case and exercises the hook's handling of a skipped result.
    const withoutPhone: RouteChannels = (_severity, channels) => ({
      routed: channels.filter((channel) => channel.name !== 'ha'),
      skipped: channels.filter((channel) => channel.name === 'ha'),
    });
    const { hook, logged } = harness([file, ha], repository, withoutPhone);
    hook.onEvent({
      id: 'e-guard',
      runId: RUN,
      type: 'guard.task_limit',
      payload: { jobId: 'job-7', role: 'builder', reason: 'tool calls' },
      createdAt: '2026-09-25T23:39:00.000Z',
    });
    await hook.close();
    expect(calls).toEqual(['file']);
    expect(logged.map((line) => line.level)).toEqual(['info']);
    expect(logged[0]?.message).toBe(
      'Escalation guard.task_limit sent via file (ha skipped: severity routing)',
    );
    expect(records.map((row) => [row.channel, row.status, row.attempts])).toEqual([
      ['file', 'sent', 1],
      ['ha', 'skipped', 0],
    ]);
    expect(records[1]?.lastError).toBeUndefined();
  });
});
