import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@theforge/contracts';
import {
  DEFAULT_CEILING,
  ROLE_ESTIMATES_USD as SHARED_ROLE_ESTIMATES_USD,
  roleEstimateUsd,
} from '@theforge/guardrails';
import { Guards, ROLE_ESTIMATES_USD, type GuardsOptions } from './guards.js';

/**
 * Pure tests: clock, free memory, agent count and usage are all injected, so
 * these prove the decisions without a coordinator, a database or a real clock.
 * Sydney is AEST (UTC+10) in September, so 2026-09-25T04:00Z is 14:00 local on
 * the 25th and 2026-09-25T14:30Z is 00:30 local on the 26th.
 */
const GIB = 1_073_741_824;

type Emitted = { runId: string; type: string; payload: Record<string, unknown> };

function usage(
  id: string,
  costUsd: number,
  createdAt = '2026-09-25T04:00:00Z',
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
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
    ...overrides,
  };
}

function harness(overrides: Partial<GuardsOptions> = {}, records: UsageRecord[] = []) {
  const emitted: Emitted[] = [];
  const warnings: string[] = [];
  const clock = { now: new Date('2026-09-25T04:00:00Z') };
  const state = { activeAgents: 0, freeBytes: 16 * GIB };
  const guards = new Guards({
    ceiling: DEFAULT_CEILING,
    maxAgents: 4,
    minFreeMemoryMb: 3072,
    timeZone: 'Australia/Sydney',
    now: () => clock.now,
    freemem: () => state.freeBytes,
    usageSource: () => records,
    activeProviderJobs: () => state.activeAgents,
    emit: (runId, type, payload) => void emitted.push({ runId, type, payload }),
    warn: (message) => void warnings.push(message),
    ...overrides,
  });
  return { guards, emitted, warnings, clock, state, records };
}

describe('Guards.beforeLease', () => {
  it('allows a lease under both limits', () => {
    const { guards } = harness();
    expect(guards.beforeLease()).toEqual({ allowed: true });
  });

  it('refuses at the agent cap, counting leased provider jobs', () => {
    const { guards, state } = harness();
    state.activeAgents = 4;
    const decision = guards.beforeLease();
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.header).toBe('max-agents (4/4)');
    expect(decision.reason).toContain('limit is 4');
    state.activeAgents = 3;
    expect(guards.beforeLease().allowed).toBe(true);
  });

  it('refuses below the free-memory floor even with agent slots free', () => {
    const { guards, state } = harness();
    state.freeBytes = 2 * GIB;
    const decision = guards.beforeLease();
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.header).toBe('min-free-memory (2048 MB < 3072 MB)');
    expect(decision.reason).toContain('free memory');
  });

  it('honours a configured cap and floor rather than the package defaults', () => {
    const { guards, state } = harness({ maxAgents: 1, minFreeMemoryMb: 100 });
    state.freeBytes = 200 * 1_048_576;
    expect(guards.beforeLease().allowed).toBe(true);
    state.activeAgents = 1;
    expect(guards.beforeLease()).toMatchObject({ allowed: false, header: 'max-agents (1/1)' });
  });
});

describe('Guards.beforeCloudCall', () => {
  it('reads the per-role estimates from the shared guardrails table (ADR-028)', () => {
    // One table for the router's projection and this guard's check, so a
    // stage the router sends to the cloud is one the guard lets through.
    expect(ROLE_ESTIMATES_USD).toBe(SHARED_ROLE_ESTIMATES_USD);
    const { guards } = harness({}, [usage('a', 2)]);
    for (const role of ['planner', 'critic', 'builder', 'reviewer', 'verifier']) {
      expect(guards.beforeCloudCall('run-1', role, 'claude'), role).toMatchObject({
        allowed: true,
        estimatedUsd: roleEstimateUsd(role),
      });
    }
  });

  it('allows a call well under the ceiling with the per-role estimate', () => {
    const { guards, emitted } = harness({}, [usage('a', 2)]);
    expect(guards.beforeCloudCall('run-1', 'builder', 'claude')).toEqual({
      allowed: true,
      estimatedUsd: ROLE_ESTIMATES_USD.builder,
      metered: true,
    });
    expect(emitted).toEqual([]);
  });

  it('warns once per day on crossing the warning fraction, not once per call', () => {
    const { guards, emitted } = harness({}, [usage('a', 15)]); // 75% of $20
    expect(guards.beforeCloudCall('run-1', 'critic', 'claude').allowed).toBe(true);
    expect(guards.beforeCloudCall('run-1', 'critic', 'claude').allowed).toBe(true);
    expect(emitted.map((event) => event.type)).toEqual(['spend.warn']);
    expect(emitted[0]).toMatchObject({
      runId: 'run-1',
      payload: {
        dayUsd: 15,
        ceilingUsd: 20,
        fraction: 0.75,
        day: '2026-09-25',
        timeZone: 'Australia/Sydney',
      },
    });
  });

  it('refuses a call whose estimate would cross the ceiling and announces it once', () => {
    const { guards, emitted } = harness({}, [usage('a', 19.5)]);
    const first = guards.beforeCloudCall('run-1', 'builder', 'claude');
    expect(first.allowed).toBe(false);
    if (first.allowed) return;
    expect(first.verdict).toMatchObject({
      dayUsd: 19.5,
      ceilingUsd: 20,
      day: '2026-09-25',
      timeZone: 'Australia/Sydney',
      routing: 'local-only',
    });
    expect(first.verdict.reason).toContain('ceiling');
    // A cheaper role still fits, so the ceiling decision is per call.
    expect(guards.beforeCloudCall('run-1', 'critic', 'claude').allowed).toBe(true);
    expect(guards.beforeCloudCall('run-2', 'builder', 'claude').allowed).toBe(false);
    expect(emitted.map((event) => event.type)).toEqual(['spend.warn', 'spend.ceiling']);
    expect(emitted[1]).toMatchObject({
      runId: 'run-1',
      payload: { dayUsd: 19.5, ceilingUsd: 20, routing: 'local-only', day: '2026-09-25' },
    });
  });

  it('refuses every cloud call once the day is over the ceiling', () => {
    const { guards } = harness({}, [usage('a', 25)]);
    for (const role of ['planner', 'critic', 'builder', 'reviewer']) {
      const decision = guards.beforeCloudCall('run-1', role, 'claude');
      expect(decision.allowed, role).toBe(false);
      if (!decision.allowed) expect(decision.verdict.reason).toContain('local models only');
    }
  });

  it('counts Codex as $0 but flags it as unmetered, and still refuses it past the ceiling', () => {
    // The Codex adapter reports usd 0 for every call (F111), so the ceiling
    // cannot see that spend. Policy B3 still applies at the ceiling: local-only
    // means local, and Codex is not.
    const { guards, warnings } = harness({}, [usage('a', 19.9)]);
    expect(guards.beforeCloudCall('run-1', 'builder', 'codex')).toEqual({
      allowed: true,
      estimatedUsd: 0,
      metered: false,
    });
    expect(guards.beforeCloudCall('run-1', 'builder', 'codex').allowed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('codex usage is reported as $0');
    const over = harness({}, [usage('b', 20)]);
    expect(over.guards.beforeCloudCall('run-1', 'builder', 'codex').allowed).toBe(false);
  });

  it('lets a local provider through under an exceeded ceiling, silently and at $0', () => {
    // Ollama runs on the worker host (ADR-021): it is where the ceiling
    // routes to, so it can never be what the ceiling refuses, and it is not
    // a subscription either, so it earns no "$0" warning.
    const { guards, emitted, warnings } = harness({}, [usage('a', 25)]);
    expect(guards.beforeCloudCall('run-1', 'builder', 'claude').allowed).toBe(false);
    for (const role of ['planner', 'critic', 'builder', 'reviewer']) {
      expect(guards.beforeCloudCall('run-1', role, 'ollama'), role).toEqual({
        allowed: true,
        estimatedUsd: 0,
        metered: false,
      });
    }
    expect(warnings).toEqual([]);
    // Only the claude refusal announced anything.
    expect(emitted.map((event) => event.type)).toEqual(['spend.warn', 'spend.ceiling']);
    // A zero ceiling ("no cloud today") is the same story.
    const none = harness({ ceiling: { dailyUsd: 0, warnAtFraction: 0.75 } });
    expect(none.guards.beforeCloudCall('run-1', 'planner', 'ollama').allowed).toBe(true);
    expect(none.emitted).toEqual([]);
  });

  it('starts a fresh budget at local midnight in Sydney, not at the UTC boundary', () => {
    // 23:30 and 00:30 Sydney are both 25 September in UTC. Spend recorded late
    // on the 25th must not count against the 26th, and the once-per-day
    // latches must open again with the new day.
    const { guards, clock, emitted } = harness({}, [usage('a', 25, '2026-09-25T13:30:00Z')]);
    clock.now = new Date('2026-09-25T13:45:00Z'); // 23:45 Sydney, 25th
    expect(guards.beforeCloudCall('run-1', 'builder', 'claude').allowed).toBe(false);
    expect(emitted.map((event) => event.type)).toEqual(['spend.warn', 'spend.ceiling']);

    clock.now = new Date('2026-09-25T14:30:00Z'); // 00:30 Sydney, 26th
    const nextDay = guards.beforeCloudCall('run-1', 'builder', 'claude');
    expect(nextDay).toEqual({ allowed: true, estimatedUsd: 1.25, metered: true });
    expect(guards.ceilingStatus()).toMatchObject({
      state: 'ok',
      spentTodayUsd: 0,
      day: '2026-09-26',
    });

    guards.onUsageRecorded(usage('b', 25, '2026-09-25T14:31:00Z'));
    expect(guards.beforeCloudCall('run-1', 'builder', 'claude').allowed).toBe(false);
    expect(emitted.map((event) => event.type)).toEqual([
      'spend.warn',
      'spend.ceiling',
      'spend.warn',
      'spend.ceiling',
    ]);
    expect(emitted[3]?.payload.day).toBe('2026-09-26');
  });

  it('counts the same usage record once however many times it is delivered', () => {
    // The boot replay and the live path both feed records in; the seed from
    // usageSource may overlap with both.
    const { guards, records } = harness();
    const record = usage('dup', 12);
    records.push(record);
    guards.onUsageRecorded(record);
    guards.onUsageRecorded({ ...record });
    expect(guards.ceilingStatus().spentTodayUsd).toBe(12);
    guards.onUsageRecorded(usage('other', 1));
    expect(guards.ceilingStatus().spentTodayUsd).toBe(13);
  });

  it('ignores records from earlier days and malformed records', () => {
    const { guards } = harness();
    guards.onUsageRecorded(usage('yesterday', 50, '2026-09-24T04:00:00Z'));
    guards.onUsageRecorded(usage('bad-date', 50, 'not-a-date'));
    guards.onUsageRecorded(usage('nan', Number.NaN));
    expect(guards.ceilingStatus().spentTodayUsd).toBe(0);
  });
});

describe('Guards.beforeRunStart', () => {
  it('lets a run start while the day is under the ceiling, even in the warning band', () => {
    const { guards, emitted } = harness({}, [usage('a', 16)]);
    expect(guards.beforeRunStart('run-1')).toEqual({ allowed: true });
    expect(emitted.map((event) => event.type)).toEqual(['spend.warn']);
  });

  it('refuses a run start once the day is over the ceiling and announces it once', () => {
    const { guards, emitted } = harness({}, [usage('a', 20)]);
    const decision = guards.beforeRunStart('run-1');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.verdict).toMatchObject({ dayUsd: 20, ceilingUsd: 20, routing: 'local-only' });
    expect(guards.beforeRunStart('run-2').allowed).toBe(false);
    expect(emitted.filter((event) => event.type === 'spend.ceiling')).toHaveLength(1);
  });

  it('treats a zero ceiling as "no cloud today"', () => {
    const { guards } = harness({ ceiling: { dailyUsd: 0, warnAtFraction: 0.75 } });
    expect(guards.beforeRunStart('run-1').allowed).toBe(false);
    expect(guards.beforeCloudCall('run-1', 'planner', 'claude').allowed).toBe(false);
  });
});
