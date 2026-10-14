import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Channel } from './channel.js';
import type { Escalation, RenderedEscalation } from './escalation.js';
import { sample } from './fixture.js';
import { DEDUPE_INDEX_FILENAME, Notifier, summarise, type NotifierOptions } from './notifier.js';

type Delivery = { rendered: RenderedEscalation; escalation: Escalation };

/** A channel that fails the first `failures` calls, then succeeds, and records everything. */
function fakeChannel(
  name: string,
  failures = 0,
): Channel & { deliveries: Delivery[]; calls: number } {
  return {
    name,
    deliveries: [],
    calls: 0,
    async send(rendered, escalation) {
      this.calls += 1;
      if (this.calls <= failures) throw new Error(`${name} down (call ${this.calls})`);
      this.deliveries.push({ rendered, escalation });
    },
  };
}

/** Manual clock and timers so windows close when the test says, not when the wall clock does. */
function clock(start = Date.parse('2026-09-26T00:00:00Z')) {
  let time = start;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= time) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
    schedule: (callback: () => void, ms: number) => {
      const timer = { at: time + ms, callback, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forge-notifier-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const sleeps: number[] = [];
const build = (overrides: Partial<NotifierOptions> = {}) =>
  new Notifier({
    channels: [],
    outboxDir: directory,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });

describe('Notifier dispatch and report', () => {
  it('sends to every channel and reports each one', async () => {
    const ha = fakeChannel('ha');
    const email = fakeChannel('email');
    const notifier = build({ channels: [ha, email] });
    const report = await notifier.notify(sample());
    expect(report.outcome).toBe('sent');
    expect(report.channels).toEqual([
      { channel: 'ha', status: 'sent', attempts: 1 },
      { channel: 'email', status: 'sent', attempts: 1 },
    ]);
    expect(report.rendered?.subject).toContain('Forge warning:');
    expect(ha.deliveries[0]?.escalation.dedupeKey).toBe(sample().dedupeKey);
  });

  it('retries a channel three times with backoff and reports the failure without throwing', async () => {
    sleeps.length = 0;
    const flaky = fakeChannel('ha', 2);
    const dead = fakeChannel('email', 99);
    const notifier = build({ channels: [flaky, dead] });
    const report = await notifier.notify(sample());
    expect(report.channels).toEqual([
      { channel: 'ha', status: 'sent', attempts: 3 },
      {
        channel: 'email',
        status: 'failed',
        attempts: 3,
        error: 'email down (call 3)',
      },
    ]);
    // Two waits before the second and third attempt, per channel; channels
    // retry concurrently, so only the multiset is stable.
    expect([...sleeps].sort((a, b) => a - b)).toEqual([500, 500, 2000, 2000]);
    expect(dead.calls).toBe(3);
  });

  it('redacts configured secrets from channel errors and from the rendered text', async () => {
    const leaky: Channel = {
      name: 'ha',
      async send() {
        throw new Error('HTTP 401 for token hunter2-secret-token');
      },
    };
    const notifier = build({
      channels: [leaky],
      secrets: ['hunter2-secret-token'],
      maxAttempts: 1,
    });
    const report = await notifier.notify(sample({ what: 'password hunter2-secret-token leaked' }));
    expect(report.channels[0]?.error).toBe('HTTP 401 for token [REDACTED]');
    expect(report.rendered?.text).toContain('password [REDACTED] leaked');
  });
});

describe('Notifier severity routing (ADR-023)', () => {
  it('sends info to email and file, reports the phone as skipped, and never calls it', async () => {
    const file = fakeChannel('file');
    const ha = fakeChannel('ha');
    const email = fakeChannel('email');
    const notifier = build({ channels: [file, ha, email] });
    const report = await notifier.notify(sample({ severity: 'info' }));
    expect(report.outcome).toBe('sent');
    expect(report.channels).toEqual([
      { channel: 'file', status: 'sent', attempts: 1 },
      { channel: 'ha', status: 'skipped', attempts: 0, reason: 'severity_routing' },
      { channel: 'email', status: 'sent', attempts: 1 },
    ]);
    expect(ha.calls).toBe(0);
    expect(file.deliveries).toHaveLength(1);
    expect(email.deliveries).toHaveLength(1);
  });

  it('sends warn and critical to every channel, the phone included', async () => {
    for (const severity of ['warn', 'critical'] as const) {
      const ha = fakeChannel('ha');
      const email = fakeChannel('email');
      const file = fakeChannel('file');
      const notifier = build({ channels: [file, ha, email] });
      const report = await notifier.notify(sample({ severity, dedupeKey: `k-${severity}` }));
      expect(report.channels.map((result) => [result.channel, result.status])).toEqual([
        ['file', 'sent'],
        ['ha', 'sent'],
        ['email', 'sent'],
      ]);
      expect(ha.deliveries[0]?.escalation.severity).toBe(severity);
    }
  });

  it('answers which configured channels a severity reaches', () => {
    const notifier = build({
      channels: [fakeChannel('file'), fakeChannel('ha'), fakeChannel('email')],
    });
    expect(notifier.routesFor('info')).toEqual({ routed: ['file', 'email'], skipped: ['ha'] });
    expect(notifier.routesFor('warn')).toEqual({ routed: ['file', 'ha', 'email'], skipped: [] });
    expect(notifier.routesFor('critical')).toEqual({
      routed: ['file', 'ha', 'email'],
      skipped: [],
    });
  });

  it('does not count a skipped channel as a delivery for dedupe', async () => {
    const ha = fakeChannel('ha');
    const notifier = build({ channels: [ha] });
    const info = await notifier.notify(sample({ severity: 'info' }));
    expect(info.channels).toEqual([
      { channel: 'ha', status: 'skipped', attempts: 0, reason: 'severity_routing' },
    ]);
    // Nothing went anywhere, so the same key at warn is not a duplicate.
    const warn = await notifier.notify(sample({ severity: 'warn' }));
    expect(warn.outcome).toBe('sent');
    expect(ha.calls).toBe(1);
  });

  it('routes a coalesced summary by its worst held severity, so a warn in a burst of info reaches the phone', async () => {
    const time = clock();
    const file = fakeChannel('file');
    const ha = fakeChannel('ha');
    const notifier = build({ channels: [file, ha], now: time.now, schedule: time.schedule });
    expect((await notifier.notify(sample({ dedupeKey: 'i1', severity: 'info' }))).outcome).toBe(
      'sent',
    );
    time.advance(30_000);
    expect((await notifier.notify(sample({ dedupeKey: 'w1', severity: 'warn' }))).outcome).toBe(
      'coalesced',
    );
    expect(ha.calls).toBe(0);
    time.advance(5 * 60_000);
    await notifier.flush();
    expect(file.calls).toBe(2);
    expect(ha.calls).toBe(1);
    expect(ha.deliveries[0]?.escalation.severity).toBe('warn');
    expect(ha.deliveries[0]?.escalation.dedupeKey).toBe('w1:summary:1');
  });

  it('honours an injected route function', async () => {
    const ha = fakeChannel('ha');
    const everywhere = build({
      channels: [ha],
      route: (_severity, channels) => ({ routed: [...channels], skipped: [] }),
    });
    expect((await everywhere.notify(sample({ severity: 'info' }))).channels[0]?.status).toBe(
      'sent',
    );
    const nowhere = build({
      channels: [fakeChannel('file')],
      route: (_severity, channels) => ({ routed: [], skipped: [...channels] }),
    });
    const report = await nowhere.notify(sample({ severity: 'critical', dedupeKey: 'nowhere' }));
    expect(report.outcome).toBe('sent');
    expect(report.channels[0]?.status).toBe('skipped');
  });
});

describe('Notifier dedupe', () => {
  it('suppresses the same key inside the window, in memory and across a restart', async () => {
    const time = clock();
    const first = fakeChannel('ha');
    const notifier = build({ channels: [first], now: time.now, schedule: time.schedule });
    expect((await notifier.notify(sample())).outcome).toBe('sent');
    const again = await notifier.notify(sample());
    expect(again.outcome).toBe('duplicate');
    expect(again.detail).toContain('already sent at 2026-09-26T00:00:00.000Z');
    expect(first.calls).toBe(1);

    const index = JSON.parse(await readFile(join(directory, DEDUPE_INDEX_FILENAME), 'utf8')) as {
      sent: Record<string, string>;
    };
    expect(index.sent[sample().dedupeKey]).toBe('2026-09-26T00:00:00.000Z');

    // A new process, same outbox: the index alone must stop the re-send.
    const restarted = fakeChannel('ha');
    const after = build({ channels: [restarted], now: time.now, schedule: time.schedule });
    expect((await after.notify(sample())).outcome).toBe('duplicate');
    expect(restarted.calls).toBe(0);

    time.advance(6 * 60 * 60 * 1_000);
    expect((await after.notify(sample())).outcome).toBe('sent');
    expect(restarted.calls).toBe(1);
  });

  it('does not mark a key as sent when every channel failed', async () => {
    const dead = fakeChannel('ha', 99);
    const notifier = build({ channels: [dead], maxAttempts: 1 });
    expect((await notifier.notify(sample())).channels[0]?.status).toBe('failed');
    const retry = await notifier.notify(sample());
    expect(retry.outcome).toBe('sent');
    expect(dead.calls).toBe(2);
  });

  it('treats a different key as a different message even for the same kind', async () => {
    const time = clock();
    const channel = fakeChannel('ha');
    const notifier = build({
      channels: [channel],
      now: time.now,
      schedule: time.schedule,
      coalesceWindowMs: 0,
    });
    await notifier.notify(sample({ dedupeKey: 'a' }));
    await notifier.notify(sample({ dedupeKey: 'b' }));
    expect(channel.calls).toBe(2);
  });
});

describe('Notifier coalescing', () => {
  it('sends the first at once, holds the rest of a burst, and sends one summary with a count', async () => {
    const time = clock();
    const channel = fakeChannel('ha');
    const notifier = build({ channels: [channel], now: time.now, schedule: time.schedule });

    expect((await notifier.notify(sample({ dedupeKey: 'k1' }))).outcome).toBe('sent');
    time.advance(30_000);
    const second = await notifier.notify(sample({ dedupeKey: 'k2', severity: 'critical' }));
    expect(second.outcome).toBe('coalesced');
    expect(second.detail).toContain('held with 0 other(s)');
    time.advance(30_000);
    const third = await notifier.notify(sample({ dedupeKey: 'k3', title: 'Third title' }));
    expect(third.detail).toContain('held with 1 other(s)');
    expect(channel.calls).toBe(1);
    expect(time.pending()).toBe(1);

    // The window closes 5 minutes after the first send; the timer fires the flush.
    time.advance(4 * 60_000);
    // The flush runs through the notifier's queue; wait for it.
    await notifier.flush();
    expect(channel.calls).toBe(2);
    const summary = channel.deliveries[1]!.escalation;
    expect(summary.title).toBe('2 more: Third title');
    expect(summary.what).toContain('2 further decision.approval escalations arrived');
    expect(summary.severity).toBe('critical');
    expect(summary.dedupeKey).toBe('k3:summary:2');
    expect(summary.evidence).toContain('held: k2 at 2026-09-25T23:39:00.000Z');
    expect(channel.deliveries[1]!.rendered.subject).toBe(
      'Forge CRITICAL: 2 more: Third title [paused]',
    );

    // A held item counts as sent for dedupe.
    expect((await notifier.notify(sample({ dedupeKey: 'k2' }))).outcome).toBe('duplicate');
  });

  it('keeps different runs and kinds apart', async () => {
    const time = clock();
    const channel = fakeChannel('ha');
    const notifier = build({ channels: [channel], now: time.now, schedule: time.schedule });
    await notifier.notify(sample({ dedupeKey: 'a', runId: 'run-1' }));
    await notifier.notify(sample({ dedupeKey: 'b', runId: 'run-2' }));
    await notifier.notify(sample({ dedupeKey: 'c', runId: 'run-1', kind: 'ci.failed' }));
    expect(channel.calls).toBe(3);
    expect((await notifier.notify(sample({ dedupeKey: 'd', runId: 'run-1' }))).outcome).toBe(
      'coalesced',
    );
  });

  it('flushes what it holds on close, so a shutdown loses nothing', async () => {
    const time = clock();
    const channel = fakeChannel('ha');
    const notifier = build({ channels: [channel], now: time.now, schedule: time.schedule });
    await notifier.notify(sample({ dedupeKey: 'a' }));
    await notifier.notify(sample({ dedupeKey: 'b' }));
    expect(time.pending()).toBe(1);
    await notifier.close();
    expect(time.pending()).toBe(0);
    expect(channel.calls).toBe(2);
    expect(channel.deliveries[1]!.escalation.title).toMatch(/^1 more: /);
    await notifier.close();
    expect(channel.calls).toBe(2);
  });

  it('summarises with the worst severity, any pause, and the latest text', () => {
    const summary = summarise(
      [
        sample({ dedupeKey: 'x', severity: 'info', paused: false }),
        sample({ dedupeKey: 'y', severity: 'warn', paused: true, what: 'latest what' }),
      ],
      Date.parse('2026-09-26T01:00:00Z'),
    );
    expect(summary.severity).toBe('warn');
    expect(summary.paused).toBe(true);
    expect(summary.what).toContain('latest what');
    expect(summary.occurredAt).toBe('2026-09-26T01:00:00.000Z');
    expect(summary.dedupeKey).toBe('y:summary:2');
  });
});
