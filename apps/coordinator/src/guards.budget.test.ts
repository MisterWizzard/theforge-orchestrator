import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@theforge/contracts';
import type { BudgetConfig } from '@theforge/guardrails';
import { Guards, type GuardsOptions } from './guards.js';

/**
 * The adaptive daily cap (ADR-037), proven with an injected clock and usage.
 * Sydney is AEDT (UTC+11) from 04/10/2026, so 2026-10-12T04:00Z is 15:00 local
 * on the 12th; a record at 2026-10-05T02:00Z is 13:00 local on the 5th.
 */
const BUDGET: BudgetConfig = { monthlyUsd: 200, resetDay: 1, maxDailyUsd: 50 };
const BASE = { dailyUsd: 6, warnAtFraction: 0.75 };

type Emitted = { runId: string; type: string; payload: Record<string, unknown> };

function usage(id: string, costUsd: number, createdAt: string): UsageRecord {
  return {
    id,
    runId: 'run-1',
    provider: 'claude',
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 10,
    costUsd,
    elapsedMs: 0,
    tools: [],
    createdAt,
  };
}

function harness(
  records: UsageRecord[],
  at = '2026-10-12T04:00:00Z',
  overrides: Partial<GuardsOptions> = {},
) {
  const emitted: Emitted[] = [];
  const clock = { now: new Date(at) };
  const guards = new Guards({
    ceiling: BASE,
    budget: BUDGET,
    maxAgents: 4,
    minFreeMemoryMb: 0,
    timeZone: 'Australia/Sydney',
    now: () => clock.now,
    usageSource: () => records,
    activeProviderJobs: () => 0,
    emit: (runId, type, payload) => void emitted.push({ runId, type, payload }),
    ...overrides,
  });
  return { guards, emitted, clock, records };
}

describe('Guards with a monthly budget', () => {
  it('raises today’s cap with what earlier days left unspent', () => {
    // $20 spent on the 5th; $180 over the 20 days left (12th to 31st) is $9 a day.
    const { guards } = harness([usage('a', 20, '2026-10-05T02:00:00Z')]);
    expect(guards.ceiling.dailyUsd).toBe(9);
    expect(guards.ceilingStatus()).toMatchObject({ remainingUsd: 9, state: 'ok' });
    expect(guards.budgetStatus()).toMatchObject({ limitedBy: 'pace', remainingUsd: 180 });
  });

  it('checks a cloud call against the adaptive cap, not the flat floor', () => {
    const { guards } = harness([
      usage('a', 20, '2026-10-05T02:00:00Z'),
      usage('today', 8.4, '2026-10-12T01:00:00Z'),
    ]);
    // $8.40 against a $9 cap: a reviewer ($0.40) fits, a planner ($0.70) does not.
    expect(guards.beforeCloudCall('run-1', 'reviewer', 'claude')).toMatchObject({ allowed: true });
    const refused = guards.beforeCloudCall('run-1', 'planner', 'claude');
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.verdict.ceilingUsd).toBe(9);
    expect(refused.verdict.reason).toContain('$9.00 ceiling');
  });

  it('does not move today’s cap as today’s spend arrives', () => {
    const { guards } = harness([usage('a', 20, '2026-10-05T02:00:00Z')]);
    expect(guards.ceiling.dailyUsd).toBe(9);
    guards.onUsageRecorded(usage('t1', 5, '2026-10-12T02:00:00Z'));
    guards.onUsageRecorded(usage('t2', 3, '2026-10-12T03:00:00Z'));
    expect(guards.ceiling.dailyUsd).toBe(9);
    expect(guards.ceilingStatus()).toMatchObject({ spentTodayUsd: 8, remainingUsd: 1 });
  });

  it('carries today’s spend into tomorrow’s cap', () => {
    const { guards, clock } = harness([usage('a', 20, '2026-10-05T02:00:00Z')]);
    guards.onUsageRecorded(usage('t1', 8, '2026-10-12T02:00:00Z'));
    clock.now = new Date('2026-10-13T04:00:00Z');
    // $28 spent, $172 over 19 days left is $9.0526 a day.
    expect(guards.ceiling.dailyUsd).toBe(9.05);
  });

  it('goes harder at the end of the period, held by the daily maximum', () => {
    const { guards, clock } = harness(
      [usage('a', 20, '2026-10-05T02:00:00Z')],
      '2026-10-30T04:00:00Z',
    );
    expect(guards.ceiling.dailyUsd).toBe(50); // $180 over two days is $90; the maximum holds it
    guards.onUsageRecorded(usage('t1', 50, '2026-10-30T02:00:00Z'));
    clock.now = new Date('2026-10-31T04:00:00Z');
    expect(guards.ceiling.dailyUsd).toBe(50); // $130 left, one day, still held to $50
    expect(guards.budgetStatus()?.limitedBy).toBe('max');
  });

  it('refuses new runs once the allowance is gone, even with the floor above zero', () => {
    const { guards, emitted } = harness([usage('a', 200, '2026-10-05T02:00:00Z')]);
    expect(guards.ceiling.dailyUsd).toBe(0);
    expect(guards.beforeRunStart('run-2')).toMatchObject({ allowed: false });
    expect(guards.beforeCloudCall('run-2', 'planner', 'claude')).toMatchObject({ allowed: false });
    expect(emitted.filter((event) => event.type === 'spend.ceiling')).toHaveLength(1);
  });

  it('starts the next period fresh and forgets the last one', () => {
    // 01/11/2026 15:00 Sydney. October's $190 is behind the reset.
    const { guards } = harness([usage('a', 190, '2026-10-05T02:00:00Z')], '2026-11-01T04:00:00Z');
    expect(guards.ceiling.dailyUsd).toBe(6.66); // 200 / 30 days
    expect(guards.budgetStatus()).toMatchObject({ spentInPeriodUsd: 0, remainingUsd: 200 });
  });

  it('honours a reset day other than the 1st', () => {
    const { guards } = harness([usage('a', 30, '2026-09-20T02:00:00Z')], '2026-10-12T04:00:00Z', {
      budget: { ...BUDGET, resetDay: 15 },
    });
    // Period 15/09 to 14/10: $170 over the three days left (12th to 14th) is $56; held to $50.
    expect(guards.budgetStatus()).toMatchObject({ remainingUsd: 170, limitedBy: 'max' });
    expect(guards.ceiling.dailyUsd).toBe(50);
  });

  it('does not count usage recorded before countFrom', () => {
    const records = [
      usage('unbilled', 100, '2026-10-05T02:00:00Z'),
      usage('billed', 20, '2026-10-11T02:00:00Z'),
    ];
    const { guards } = harness(records, '2026-10-12T04:00:00Z', {
      budget: { ...BUDGET, countFrom: '2026-10-10T00:00:00+11:00' },
    });
    // Only the $20 counts: $180 over 20 days left is $9.
    expect(guards.budgetStatus()).toMatchObject({ spentInPeriodUsd: 20 });
    expect(guards.ceiling.dailyUsd).toBe(9);
  });

  it('gives the same answer however the seed records are ordered', () => {
    const records = [
      usage('today', 2, '2026-10-12T02:00:00Z'),
      usage('c', 5, '2026-10-11T02:00:00Z'),
      usage('a', 20, '2026-10-05T02:00:00Z'),
    ];
    const forward = harness(records);
    const backward = harness([...records].reverse());
    expect(forward.guards.ceiling.dailyUsd).toBe(backward.guards.ceiling.dailyUsd);
    expect(forward.guards.ceilingStatus().spentTodayUsd).toBe(2);
    expect(backward.guards.ceilingStatus().spentTodayUsd).toBe(2);
  });

  it('counts a record once even when the live path and the seed both deliver it', () => {
    const record = usage('a', 20, '2026-10-05T02:00:00Z');
    const { guards } = harness([record]);
    guards.onUsageRecorded(record);
    guards.onUsageRecorded(record);
    expect(guards.budgetStatus()?.spentInPeriodUsd).toBe(20);
  });

  it('leaves the flat ceiling exactly as it was when no budget is set', () => {
    const { guards } = harness([usage('a', 20, '2026-10-05T02:00:00Z')], '2026-10-12T04:00:00Z', {
      budget: undefined,
    });
    expect(guards.ceiling).toEqual(BASE);
    expect(guards.budgetStatus()).toBeUndefined();
    expect(guards.ceilingStatus().remainingUsd).toBe(6);
  });

  it('reports the effective cap in spend.warn and spend.ceiling events', () => {
    const { guards, emitted } = harness([
      usage('a', 20, '2026-10-05T02:00:00Z'),
      usage('today', 7, '2026-10-12T01:00:00Z'),
    ]);
    guards.beforeCloudCall('run-1', 'critic', 'claude'); // $7 of $9 is past 75%
    const warn = emitted.find((event) => event.type === 'spend.warn');
    expect(warn?.payload).toMatchObject({ ceilingUsd: 9, dayUsd: 7 });
    guards.beforeCloudCall('run-1', 'builder', 'claude'); // 7 + 1.25 = 8.25, fits; nothing more to refuse
    guards.onUsageRecorded(usage('t2', 2, '2026-10-12T03:00:00Z'));
    const ceiling = emitted.find((event) => event.type === 'spend.ceiling');
    expect(ceiling?.payload).toMatchObject({ ceilingUsd: 9, routing: 'local-only' });
  });
});
