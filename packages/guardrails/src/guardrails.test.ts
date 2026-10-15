import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkSpend,
  checkCeiling,
  canStartCloudCall,
  ceilingConfigFromValues,
  evaluateCeiling,
  evaluateCloudCall,
  isValidTimeZone,
  localDay,
  spentOn,
  toGuardUsage,
  DEFAULT_CEILING,
  DEFAULT_ROLE_ESTIMATE_USD,
  DEFAULT_TIME_ZONE,
  FORBIDDEN_SPEND_ACTIONS,
  ROLE_ESTIMATES_USD,
  roleEstimateUsd,
  BLOCKED_HOSTS,
  type UsageRecord,
} from './spend.js';
import {
  canLeaseWork,
  checkHalt,
  parseHaltRequest,
  readHaltFile,
  removeHaltFile,
  resolveHaltFilePath,
  writeHaltFile,
  checkTaskLimits,
  freshTokens,
  MAX_CONCURRENT_AGENTS,
  MIN_FREE_MEMORY_MB,
} from './limits.js';

describe('purchasing ban', () => {
  it('refuses every forbidden action', () => {
    for (const action of FORBIDDEN_SPEND_ACTIONS) {
      const verdict = checkSpend({ action, capabilities: [] });
      expect(verdict.allowed, `${action} must be refused`).toBe(false);
    }
  });

  it('refuses regardless of how the action is capitalised', () => {
    expect(checkSpend({ action: 'BUY_CREDITS', capabilities: [] }).allowed).toBe(false);
    expect(checkSpend({ action: 'Purchase', capabilities: [] }).allowed).toBe(false);
  });

  it('refuses payment hosts even when the action looks innocuous', () => {
    for (const host of BLOCKED_HOSTS) {
      const verdict = checkSpend({ action: 'http_request', host, capabilities: [] });
      expect(verdict.allowed, `${host} must be unreachable`).toBe(false);
    }
  });

  it('cannot be unlocked by granting capabilities', () => {
    // The point of the ban is that no configuration enables it. An agent handed
    // every capability imaginable still may not buy anything.
    const verdict = checkSpend({
      action: 'purchase',
      capabilities: ['admin', 'root', 'godmode', 'trusted', 'spend'],
    });
    expect(verdict.allowed).toBe(false);
  });

  it('treats the spend capability itself as a fault, not as permission', () => {
    // No agent card grants this. If it appears, something upstream is wrong and
    // honouring it would be the worst possible response.
    const verdict = checkSpend({ action: 'anything_at_all', capabilities: ['spend'] });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('configuration fault');
  });

  it('directs refused purchases to a human proposal', () => {
    const verdict = checkSpend({ action: 'buy_credits', capabilities: [] });
    expect(verdict.allowed === false && verdict.proposalRequired).toBe(true);
  });

  it('allows ordinary non-financial work', () => {
    expect(checkSpend({ action: 'run_tests', capabilities: ['read'] }).allowed).toBe(true);
    expect(
      checkSpend({ action: 'http_request', host: 'api.github.com', capabilities: [] }).allowed,
    ).toBe(true);
  });
});

/**
 * The adversarial pass: every spelling that defeated the original ban.
 *
 * Until 04/10/2026 both lists were compared with `Array.includes` on a lowercased string,
 * so matching was exact. Every case in the first two tables below was therefore
 * **allowed** - `purchase_gpu`, `buy credits`, `pay.stripe.com`,
 * `https://api.stripe.com/v1`. The ban read as absolute and was a spelling check.
 *
 * Shaped after `policy.test.ts`'s 'denies workspace escape and destructive commands': a
 * flat table of hostile inputs asserted against a pure verdict, with a per-row message so
 * a failure names the input that got through.
 */
describe('purchasing ban, adversarially', () => {
  it('refuses a forbidden term however it is separated or cased', () => {
    const spellings = [
      'Buy Credits',
      'buy-credits',
      'buy.credits',
      'BUY/CREDITS',
      '  buy_credits  ',
      'transfer-funds',
      'Transfer Funds',
      'UPGRADE SUBSCRIPTION',
      'register-domain',
      'provision paid resource',
    ];
    for (const action of spellings) {
      expect(checkSpend({ action, capabilities: [] }).allowed, `"${action}" must be refused`).toBe(
        false,
      );
    }
  });

  it('refuses a forbidden term wrapped in other words', () => {
    // The exact-match check saw these as unrelated action names and allowed them all.
    const wrapped = [
      'purchase_gpu',
      'purchase_gpu_hours',
      'please_transfer_funds',
      'marketplace_purchase_v2',
      'do_buy_credits_now',
      'step_3_upgrade_subscription',
      'register_domain_for_project',
    ];
    for (const action of wrapped) {
      expect(checkSpend({ action, capabilities: [] }).allowed, `"${action}" must be refused`).toBe(
        false,
      );
    }
  });

  it('refuses a payment host behind a port, a subdomain, a URL or a trailing dot', () => {
    const hosts = [
      'api.stripe.com:443',
      'www.api.stripe.com',
      'pay.stripe.com',
      'API.STRIPE.COM',
      'api.stripe.com.',
      'https://api.stripe.com/v1/charges',
      'https://api.stripe.com:443/v1/charges',
      'http://user:pw@api.stripe.com/v1',
      'checkout.stripe.com/pay/abc',
      'api.paypal.com:8443',
      'subdomain.paypal.com',
      'payments.google.com',
    ];
    for (const host of hosts) {
      expect(
        checkSpend({ action: 'http_request', host, capabilities: [] }).allowed,
        `${host} must be unreachable`,
      ).toBe(false);
    }
  });

  it('refuses the spend capability in any case or namespace', () => {
    for (const capability of ['spend', 'SPEND', 'Spend', 'spend:usd', 'spend:any', ' spend ']) {
      expect(
        checkSpend({ action: 'run_tests', capabilities: [capability] }).allowed,
        `capability "${capability}" must refuse`,
      ).toBe(false);
    }
  });

  it('still allows work that merely looks financial, so the ban stays usable', () => {
    // Token boundaries, not substrings: these share letters with forbidden terms and are
    // ordinary engineering work. A ban that refused them would be routed around.
    const allowed = [
      'buyer_report',
      'disbursement_summary',
      'purchases_table_migration',
      'read_subscription_status',
      'domain_model_refactor',
      'fund_allocation_chart',
    ];
    for (const action of allowed) {
      expect(
        checkSpend({ action, capabilities: [] }).allowed,
        `"${action}" should be allowed`,
      ).toBe(true);
    }
  });

  it('allows hosts that are not payment endpoints, including lookalikes', () => {
    const hosts = [
      'api.github.com',
      'registry.npmjs.org',
      'stripe.com.example.invalid',
      'notstripe.com',
      'docs.stripe.com.evil.invalid',
    ];
    for (const host of hosts) {
      expect(
        checkSpend({ action: 'http_request', host, capabilities: [] }).allowed,
        `${host} should be allowed`,
      ).toBe(true);
    }
  });

  it('over-matches rather than under-matches, and that is the deliberate choice', () => {
    // An innocently named action containing a forbidden token IS refused. Recorded as a
    // test so the trade-off is visible rather than discovered: a false refusal costs one
    // proposal and a rename, a false allowance costs money and cannot be undone.
    expect(checkSpend({ action: 'purchase_order_report', capabilities: [] }).allowed).toBe(false);
  });

  it('handles empty and malformed input without allowing it by accident', () => {
    expect(checkSpend({ action: '', capabilities: [] }).allowed, 'empty is not a purchase').toBe(
      true,
    );
    expect(checkSpend({ action: '___', capabilities: [] }).allowed).toBe(true);
    expect(
      checkSpend({ action: 'http_request', host: '', capabilities: [] }).allowed,
      'an empty host is not a payment endpoint',
    ).toBe(true);
    expect(
      checkSpend({ action: 'http_request', host: 'not a url at all', capabilities: [] }).allowed,
    ).toBe(true);
  });
});

describe('daily cloud ceiling', () => {
  // 22:00 in Sydney on the 25th (AEST, UTC+10; daylight saving starts in October).
  const today = new Date('2026-09-25T12:00:00Z');
  const usage = (usd: number, at = '2026-09-25T09:00:00Z'): UsageRecord => ({ at, usd, tokens: 0 });

  it('sums only the current local day, not the UTC day', () => {
    const records = [
      usage(5),
      usage(7, '2026-09-24T13:00:00Z'), // 23:00 Sydney on the 24th: yesterday
      usage(3, '2026-09-25T14:30:00Z'), // 00:30 Sydney on the 26th: tomorrow
    ];
    expect(spentOn(records, today)).toBe(5);
  });

  it('draws the day boundary at local midnight, either side of a UTC boundary', () => {
    // Policy days are Dan's days. 23:30 and 00:30 in Sydney are both 25 September
    // in UTC, so a UTC calendar would put them in one budget; the local calendar
    // must split them, and the local zone is the default.
    const lateNight = usage(4, '2026-09-25T13:30:00Z'); // 23:30 Sydney, 25th
    const earlyMorning = usage(6, '2026-09-25T14:30:00Z'); // 00:30 Sydney, 26th
    const justAfterMidnight = new Date('2026-09-25T14:45:00Z'); // 00:45 Sydney, 26th
    expect(localDay(new Date(lateNight.at))).toBe('2026-09-25');
    expect(localDay(new Date(earlyMorning.at))).toBe('2026-09-26');
    expect(spentOn([lateNight, earlyMorning], justAfterMidnight)).toBe(6);
    expect(spentOn([lateNight, earlyMorning], justAfterMidnight, 'UTC')).toBe(10);
    // The other direction: at 23:45 Sydney only the late-night record counts.
    expect(spentOn([lateNight, earlyMorning], new Date('2026-09-25T13:45:00Z'))).toBe(4);
  });

  it('follows daylight saving, since the day boundary moves with it', () => {
    // January is AEDT (UTC+11): 13:30Z is already 00:30 on the next local day.
    expect(localDay(new Date('2026-01-10T13:30:00Z'))).toBe('2026-01-11');
    expect(localDay(new Date('2026-01-10T12:30:00Z'))).toBe('2026-01-10');
  });

  it('rejects an unknown zone rather than quietly counting in UTC', () => {
    expect(isValidTimeZone('Australia/Sydney')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(() => localDay(today, 'Mars/Olympus_Mons')).toThrow(RangeError);
    expect(DEFAULT_TIME_ZONE).toBe('Australia/Sydney');
  });

  it('allows cloud work well under the ceiling', () => {
    const verdict = checkCeiling([usage(2)], today);
    expect(verdict.state).toBe('ok');
    expect(verdict.routing).toBe('cloud-allowed');
    expect(verdict.day).toBe('2026-09-25');
    expect(verdict.timeZone).toBe('Australia/Sydney');
  });

  it('warns before the ceiling rather than only at it', () => {
    const verdict = checkCeiling([usage(DEFAULT_CEILING.dailyUsd * 0.8)], today);
    expect(verdict.state).toBe('warn');
    expect(verdict.routing).toBe('cloud-allowed');
  });

  it('falls back to local models at the ceiling instead of halting', () => {
    // Policy B3: work continues at zero marginal cost rather than stopping.
    const verdict = checkCeiling([usage(DEFAULT_CEILING.dailyUsd)], today);
    expect(verdict.state).toBe('exceeded');
    expect(verdict.routing).toBe('local-only');
  });

  it('refuses a call whose estimate would breach the ceiling', () => {
    // Checked before the call, so one expensive task cannot carry the total far
    // past the limit and only be noticed afterwards.
    const decision = canStartCloudCall([usage(19)], 5, today);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('ceiling');
    expect(decision.ceiling.state).toBe('warn');
  });

  it('allows a call that fits within the remaining budget', () => {
    expect(canStartCloudCall([usage(10)], 2.5, today).allowed).toBe(true);
  });

  it('ignores malformed records rather than throwing', () => {
    const records = [
      { at: 'not-a-date', usd: 500, tokens: 0 },
      { at: '2026-09-25T09:00:00Z', usd: Number.NaN, tokens: 0 },
      usage(3),
    ];
    expect(spentOn(records, today)).toBe(3);
  });

  it('evaluates an already-summed total identically to the record scan', () => {
    // The coordinator keeps a running day total so dispatch checks are O(1);
    // the two entry points must never disagree.
    const records = [usage(12), usage(4)];
    expect(evaluateCeiling(16, DEFAULT_CEILING, '2026-09-25')).toEqual(
      checkCeiling(records, today),
    );
    expect(evaluateCloudCall(16, 5, DEFAULT_CEILING, '2026-09-25')).toEqual(
      canStartCloudCall(records, 5, today),
    );
  });

  it('adapts coordinator usage records to the ceiling shape', () => {
    expect(
      toGuardUsage([
        {
          createdAt: '2026-09-25T09:00:00Z',
          costUsd: 1.25,
          inputTokens: 100,
          outputTokens: 50,
          runId: 'run-1',
          provider: 'claude',
        },
        { createdAt: '2026-09-25T10:00:00Z', costUsd: 0, inputTokens: 1, outputTokens: 1 },
      ]),
    ).toEqual([
      { at: '2026-09-25T09:00:00Z', usd: 1.25, tokens: 150, runId: 'run-1', provider: 'claude' },
      { at: '2026-09-25T10:00:00Z', usd: 0, tokens: 2 },
    ]);
  });

  it('builds a ceiling from environment values, defaulting what is unset', () => {
    expect(ceilingConfigFromValues({})).toEqual(DEFAULT_CEILING);
    expect(ceilingConfigFromValues({ dailyUsd: '', warnAtFraction: undefined })).toEqual(
      DEFAULT_CEILING,
    );
    expect(ceilingConfigFromValues({ dailyUsd: '35.5', warnAtFraction: 0.5 })).toEqual({
      dailyUsd: 35.5,
      warnAtFraction: 0.5,
    });
    // Zero is a legitimate setting - "no cloud today" - and must survive.
    expect(ceilingConfigFromValues({ dailyUsd: '0' }).dailyUsd).toBe(0);
    expect(() => ceilingConfigFromValues({ dailyUsd: 'twenty' })).toThrow(RangeError);
    expect(() => ceilingConfigFromValues({ dailyUsd: -1 })).toThrow(RangeError);
    expect(() => ceilingConfigFromValues({ warnAtFraction: 1.5 })).toThrow(RangeError);
  });
});

describe('concurrency guard', () => {
  it('allows work when under both limits', () => {
    expect(canLeaseWork({ activeAgents: 2, freeMemoryMb: 8000 }).allowed).toBe(true);
  });

  it('refuses at the agent cap', () => {
    expect(canLeaseWork({ activeAgents: MAX_CONCURRENT_AGENTS, freeMemoryMb: 8000 }).allowed).toBe(
      false,
    );
  });

  it('refuses on low memory even when agent slots remain', () => {
    // This is what makes four agents safe rather than optimistic: the cap alone
    // does not account for builds and test runs also being in flight.
    const verdict = canLeaseWork({ activeAgents: 1, freeMemoryMb: MIN_FREE_MEMORY_MB - 1 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('free memory');
  });
});

describe('kill switch', () => {
  it('halts on the file', () => {
    const verdict = checkHalt({ fileExists: true, apiRequested: false });
    expect(verdict.halted).toBe(true);
    expect(verdict.source).toBe('file');
  });

  it('halts on an API request', () => {
    expect(checkHalt({ fileExists: false, apiRequested: true }).halted).toBe(true);
  });

  it('runs only when neither mechanism has fired', () => {
    expect(checkHalt({ fileExists: false, apiRequested: false }).halted).toBe(false);
  });

  it('tells the operator how to resume', () => {
    const verdict = checkHalt({ fileExists: true, apiRequested: false });
    expect(verdict.message).toContain('Delete it to resume');
  });

  it('halts on the file alone; the API flag is no longer needed', () => {
    expect(checkHalt({ fileExists: true }).source).toBe('file');
    expect(checkHalt({ fileExists: false }).halted).toBe(false);
  });

  it('resolves the halt file beside the workspace root, absolute first', () => {
    // The workspace root is made absolute before '..' is applied, so a relative
    // root gives the same answer as its absolute form and never escapes the
    // working directory by accident.
    const expected = resolve(resolve('.forge/workspaces'), '..', 'FORGE_HALT');
    expect(resolveHaltFilePath({})).toBe(expected);
    expect(resolveHaltFilePath({ workspaceRoot: '.forge/workspaces' })).toBe(expected);
    expect(resolveHaltFilePath({ workspaceRoot: resolve('.forge/workspaces') })).toBe(expected);
    expect(resolveHaltFilePath({ workspaceRoot: '' })).toBe(expected);
    expect(resolveHaltFilePath({ workspaceRoot: '/srv/forge/workspaces' })).toBe(
      resolve('/srv/forge/FORGE_HALT'),
    );
  });

  it('lets FORGE_HALT_FILE override the location, ignoring an empty value', () => {
    const explicit = join(tmpdir(), 'forge-halt-override');
    expect(resolveHaltFilePath({ workspaceRoot: '/elsewhere', haltFile: explicit })).toBe(explicit);
    expect(resolveHaltFilePath({ haltFile: '' })).toBe(
      resolve(resolve('.forge/workspaces'), '..', 'FORGE_HALT'),
    );
  });

  it('parses only the request shape it writes', () => {
    expect(parseHaltRequest('{"requestedAt":"t","requestedBy":"cli","reason":"r"}')).toEqual({
      requestedAt: 't',
      requestedBy: 'cli',
      reason: 'r',
    });
    expect(parseHaltRequest('{"requestedAt":"t","requestedBy":"api"}')).toEqual({
      requestedAt: 't',
      requestedBy: 'api',
    });
    expect(parseHaltRequest('')).toBeUndefined();
    expect(parseHaltRequest('not json')).toBeUndefined();
    expect(parseHaltRequest('{"requestedAt":1,"requestedBy":"api"}')).toBeUndefined();
    expect(parseHaltRequest('{"requestedAt":"t","requestedBy":"api","reason":5}')).toBeUndefined();
  });

  it('writes, reads and removes the halt file, and tolerates a bare touch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-halt-'));
    try {
      // The parent may not exist yet on a fresh checkout; halting must still work.
      const path = join(directory, 'nested', 'FORGE_HALT');
      expect(await readHaltFile(path)).toEqual({ path, exists: false });
      expect(await removeHaltFile(path)).toBe(false);

      await writeHaltFile(path, { requestedAt: 't', requestedBy: 'cli', reason: 'because' });
      expect(await readHaltFile(path)).toEqual({
        path,
        exists: true,
        request: { requestedAt: 't', requestedBy: 'cli', reason: 'because' },
      });
      // No temporary file may linger: the lease path only checks existence, so
      // anything left beside the real file is at best confusing.
      expect(await readdir(join(directory, 'nested'))).toEqual(['FORGE_HALT']);

      await writeFile(path, '', 'utf8');
      expect(await readHaltFile(path)).toEqual({ path, exists: true });

      expect(await removeHaltFile(path)).toBe(true);
      expect(await readHaltFile(path)).toEqual({ path, exists: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('per-task limits', () => {
  it('allows a task inside its bounds', () => {
    expect(checkTaskLimits({ toolCalls: 10, elapsedMinutes: 2, tokens: 5000 }).allowed).toBe(true);
  });

  it('stops a task that will not terminate', () => {
    // A task that cannot finish is worse than one that fails: it holds a lease
    // and consumes budget while producing nothing.
    expect(checkTaskLimits({ toolCalls: 5000, elapsedMinutes: 2, tokens: 100 }).allowed).toBe(
      false,
    );
    expect(checkTaskLimits({ toolCalls: 1, elapsedMinutes: 999, tokens: 100 }).allowed).toBe(false);
    expect(checkTaskLimits({ toolCalls: 1, elapsedMinutes: 1, tokens: 9_999_999 }).allowed).toBe(
      false,
    );
  });
});

describe('fresh tokens against the limits', () => {
  it('does not count the cached portion of the input', () => {
    expect(
      freshTokens({ inputTokens: 31_004, cachedInputTokens: 31_000, outputTokens: 2183 }),
    ).toBe(2187);
  });

  it('counts the whole input when nothing was cached', () => {
    expect(freshTokens({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 20 })).toBe(520);
    expect(freshTokens({ inputTokens: 500, outputTokens: 20 })).toBe(520);
  });

  it('leaves the limits calibrated exactly where they were', () => {
    // The regression this guards. Before migration 008 the Claude adapter
    // reported only its uncached input, so a call like the one below counted
    // 4 + 2183 = 2187 tokens against the run budget. The corrected adapter
    // reports 31,004 in - and if the thresholds read that total instead, a run
    // that had always finished inside `maxTokens` (100,000) would start
    // aborting with "Run budget exceeded" about a dozen stages earlier. Fixing
    // the ledger must not quietly shrink what a run is allowed to do.
    const corrected = { inputTokens: 31_004, cachedInputTokens: 31_000, outputTokens: 2183 };
    const asReportedBefore = { inputTokens: 4, outputTokens: 2183 };
    expect(freshTokens(corrected)).toBe(freshTokens(asReportedBefore));
    expect(
      checkTaskLimits({ toolCalls: 1, elapsedMinutes: 1, tokens: freshTokens(corrected) }).allowed,
    ).toBe(true);
  });

  it('never returns less than the output when a provider reports nonsense', () => {
    // More cached than total input is malformed. Clamped, because a negative
    // contribution would make a limit easier to pass, not harder.
    expect(freshTokens({ inputTokens: 10, cachedInputTokens: 999, outputTokens: 5 })).toBe(5);
  });

  it('is what the ceiling reads a usage record as', () => {
    const [record] = toGuardUsage([
      {
        createdAt: '2026-10-04T00:00:00.000Z',
        costUsd: 0.48,
        inputTokens: 31_004,
        cachedInputTokens: 31_000,
        outputTokens: 2183,
        provider: 'claude',
      },
    ]);
    expect(record!.tokens).toBe(2187);
    // The cost is untouched by any of this: it comes from the provider's own
    // billed total, which was always right.
    expect(record!.usd).toBe(0.48);
  });
});

describe('model routing', () => {
  it('sends dependency bumps to tier 0, with no model at all', async () => {
    const { route } = await import('./router.js');
    const decision = route({ workClass: 'dependency_bump' });
    expect(decision.tier).toBe(0);
    expect(decision.model).toBeNull();
  });

  it('keeps frequent cheap work local', async () => {
    const { route } = await import('./router.js');
    for (const workClass of ['triage', 'summarise', 'read_logs', 'commit_message'] as const) {
      expect(route({ workClass }).tier, workClass).toBe(1);
    }
  });

  it('sends open-ended work to the cloud', async () => {
    const { route } = await import('./router.js');
    for (const workClass of ['architecture', 'debugging', 'security_review'] as const) {
      expect(route({ workClass }).tier, workClass).toBe(3);
    }
  });

  it('escalates one tier per failure', async () => {
    const { route } = await import('./router.js');
    expect(route({ workClass: 'triage', priorFailures: 0 }).tier).toBe(1);
    expect(route({ workClass: 'triage', priorFailures: 1 }).tier).toBe(2);
    expect(route({ workClass: 'triage', priorFailures: 2 }).tier).toBe(3);
  });

  it('never escalates past the cloud', async () => {
    const { route } = await import('./router.js');
    expect(route({ workClass: 'architecture', priorFailures: 99 }).tier).toBe(3);
  });

  it('drops cloud work to local when the ceiling is reached', async () => {
    // Policy B3. The ceiling pushes work down, never up.
    const { route } = await import('./router.js');
    const spent = [{ at: '2026-09-26T09:00:00Z', usd: 25, tokens: 0 }];
    const decision = route({
      workClass: 'architecture',
      usage: spent,
      now: new Date('2026-09-26T12:00:00Z'),
    });
    expect(decision.tier).toBe(2);
    expect(decision.ceilingApplied).toBe(true);
  });

  it('drops cloud work to local when its estimate would carry the day past the ceiling', async () => {
    // ADR-028. A projected crossing is the same as a reached one; exactly the
    // ceiling is allowed, as the dispatch guard allows it.
    const { route } = await import('./router.js');
    const spent = [{ at: '2026-09-26T09:00:00Z', usd: 19.5, tokens: 0 }];
    const now = new Date('2026-09-26T12:00:00Z');
    const projected = route({ workClass: 'architecture', usage: spent, estimatedUsd: 0.7, now });
    expect(projected.tier).toBe(2);
    expect(projected.ceilingApplied).toBe(true);
    expect(projected.reason).toContain(
      'projected $20.20 ($19.50 spent on 2026-09-26 Australia/Sydney + $0.70 estimated) would pass the $20.00 ceiling; routing to local models only',
    );
    const exact = route({ workClass: 'architecture', usage: spent, estimatedUsd: 0.5, now });
    expect(exact.tier).toBe(3);
    expect(exact.ceilingApplied).toBe(false);
    // Without usage there is nothing to project from: the estimate alone never demotes.
    expect(route({ workClass: 'architecture', estimatedUsd: 999 }).tier).toBe(3);
  });

  it('leaves free work untouched by the ceiling', async () => {
    // Tier 0 costs nothing, so a spend limit has no bearing on it.
    const { route } = await import('./router.js');
    const spent = [{ at: '2026-09-26T09:00:00Z', usd: 500, tokens: 0 }];
    const decision = route({
      workClass: 'dependency_bump',
      usage: spent,
      now: new Date('2026-09-26T12:00:00Z'),
    });
    expect(decision.tier).toBe(0);
    expect(decision.ceilingApplied).toBe(false);
  });

  it('honours an explicit floor for a task marked harder than its class', async () => {
    const { route } = await import('./router.js');
    expect(route({ workClass: 'triage', minimumTier: 3 }).tier).toBe(3);
  });

  it('records a readable reason for every decision', async () => {
    const { route } = await import('./router.js');
    expect(route({ workClass: 'triage', priorFailures: 1 }).reason).toContain('escalated');
  });

  it('reports what routing actually saved', async () => {
    const { route, routingSavings } = await import('./router.js');
    const decisions = [
      route({ workClass: 'dependency_bump' }),
      route({ workClass: 'dependency_bump' }),
      route({ workClass: 'triage' }),
      route({ workClass: 'architecture' }),
    ];
    const savings = routingSavings(decisions);
    expect(savings.cloudTasks).toBe(1);
    expect(savings.freeTasks).toBe(3);
    expect(savings.estimatedSavingUsd).toBe(7.5);
  });
});

describe('residency annotation', () => {
  it('reports a cold load for a local model that is not resident', async () => {
    const { route } = await import('./router.js');
    const decision = route({ workClass: 'single_file_edit', residency: { loadedModels: [] } });
    expect(decision.model).toBe('devstral-small-2:latest');
    expect(decision.requiresLoad).toBe(true);
    // The measured upper bound, docs/evidence-local-model-benchmark-2-2026-09-26.txt leg 4.
    expect(decision.estimatedLoadSeconds).toBe(10.6);
  });

  it('reports no load when the model is already resident', async () => {
    const { route } = await import('./router.js');
    const decision = route({
      workClass: 'single_file_edit',
      residency: { loadedModels: ['devstral-small-2:latest'] },
    });
    expect(decision.requiresLoad).toBe(false);
    expect(decision.estimatedLoadSeconds).toBe(0);
  });

  it('treats a bare tag and :latest as the same model', async () => {
    const { route } = await import('./router.js');
    const decision = route({
      workClass: 'single_file_edit',
      residency: { loadedModels: ['devstral-small-2'] },
    });
    expect(decision.requiresLoad).toBe(false);
  });

  it('uses the fast tier figure for qwen3', async () => {
    const { route } = await import('./router.js');
    const decision = route({
      workClass: 'triage',
      residency: { loadedModels: ['devstral-small-2'] },
    });
    expect(decision.requiresLoad).toBe(true);
    expect(decision.estimatedLoadSeconds).toBe(6.7);
  });

  it('assumes a cold load when residency is unknown', async () => {
    const { route } = await import('./router.js');
    expect(route({ workClass: 'triage' }).requiresLoad).toBe(true);
  });

  it('never annotates a load for the cloud or for tier 0', async () => {
    const { route } = await import('./router.js');
    for (const workClass of ['architecture', 'dependency_bump'] as const) {
      const decision = route({ workClass, residency: { loadedModels: [] } });
      expect(decision.requiresLoad, workClass).toBe(false);
      expect(decision.estimatedLoadSeconds, workClass).toBe(0);
    }
  });

  it('never changes the tier', async () => {
    const { route } = await import('./router.js');
    const cold = route({ workClass: 'single_file_edit', residency: { loadedModels: [] } });
    const warm = route({
      workClass: 'single_file_edit',
      residency: { loadedModels: ['devstral-small-2:latest'] },
    });
    expect(cold.tier).toBe(warm.tier);
  });
});

describe('routeRole', () => {
  // Usage that puts the day over the default $20 ceiling, stamped now so the
  // ceiling's local-day arithmetic sees it whatever zone the test runs in.
  const overCeiling = [{ at: new Date().toISOString(), usd: 25, tokens: 0 }];
  const everyProvider = ['claude', 'codex', 'ollama'];

  it('maps every pipeline role to a cloud work class', async () => {
    const { ROLE_WORK_CLASS, WORK_CLASS_TIER, LOCAL_FALLBACK_ROLES } = await import('./router.js');
    for (const role of ['planner', 'critic', 'builder', 'reviewer'] as const) {
      expect(WORK_CLASS_TIER[ROLE_WORK_CLASS[role]], role).toBe(3);
    }
    expect(LOCAL_FALLBACK_ROLES).toEqual(['planner', 'critic']);
  });

  it('names claude as the default cloud provider and keeps it first among substitutes', async () => {
    const { CLOUD_PROVIDER_IDS, DEFAULT_CLOUD_PROVIDER_ID, isCloudProviderId, LOCAL_PROVIDER_ID } =
      await import('./router.js');
    // ADR-024: one provider by default; Codex is an explicit pin, never a default.
    expect(DEFAULT_CLOUD_PROVIDER_ID).toBe('claude');
    expect(isCloudProviderId(DEFAULT_CLOUD_PROVIDER_ID)).toBe(true);
    expect(CLOUD_PROVIDER_IDS[0]).toBe(DEFAULT_CLOUD_PROVIDER_ID);
    expect(DEFAULT_CLOUD_PROVIDER_ID).not.toBe(LOCAL_PROVIDER_ID);
  });

  it('routes every role to its configured cloud provider by default', async () => {
    const { routeRole } = await import('./router.js');
    for (const role of ['planner', 'critic', 'builder', 'reviewer'] as const) {
      const decision = routeRole({
        role,
        availableProviderIds: everyProvider,
        cloudProviderId: 'codex',
      });
      expect(decision.tier, role).toBe(3);
      expect(decision.providerId, role).toBe('codex');
      expect(decision.allowed, role).toBe(true);
      expect(decision.ceilingApplied, role).toBe(false);
      // The cloud adapter chooses its own model; nothing goes on the request.
      expect(decision.model, role).toBeNull();
      expect(decision.requiresLoad, role).toBe(false);
    }
  });

  it('never picks ollama as the default provider for a role', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({ role: 'planner', availableProviderIds: ['ollama', 'claude'] });
    expect(decision.providerId).toBe('claude');
  });

  it('substitutes the other cloud provider when the configured one is unavailable', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'builder',
      availableProviderIds: ['claude'],
      cloudProviderId: 'codex',
    });
    expect(decision.providerId).toBe('claude');
    expect(decision.reason).toContain('codex is not available');
  });

  it('escalates a failed cloud provider to the other one', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      priorFailures: 1,
      availableProviderIds: everyProvider,
      cloudProviderId: 'codex',
      excludeProviderIds: ['codex'],
    });
    expect(decision.tier).toBe(3);
    expect(decision.providerId).toBe('claude');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('codex failed this stage');
  });

  it('refuses when every cloud provider has failed', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      priorFailures: 2,
      availableProviderIds: everyProvider,
      cloudProviderId: 'codex',
      excludeProviderIds: ['codex', 'claude'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBeNull();
    expect(decision.reason).toContain('no cloud provider remains for planner');
  });

  it('drops the planner and the critic to devstral under the ceiling', async () => {
    const { routeRole, LOCAL_FALLBACK_ROLES } = await import('./router.js');
    for (const role of LOCAL_FALLBACK_ROLES) {
      const decision = routeRole({
        role,
        usage: overCeiling,
        availableProviderIds: everyProvider,
        cloudProviderId: 'claude',
      });
      expect(decision.tier, role).toBe(2);
      expect(decision.ceilingApplied, role).toBe(true);
      expect(decision.providerId, role).toBe('ollama');
      expect(decision.model, role).toBe('devstral-small-2:latest');
      expect(decision.allowed, role).toBe(true);
    }
  });

  it('stops the builder and the reviewer under the ceiling', async () => {
    const { routeRole } = await import('./router.js');
    for (const role of ['builder', 'reviewer'] as const) {
      const decision = routeRole({
        role,
        usage: overCeiling,
        availableProviderIds: everyProvider,
        cloudProviderId: 'claude',
      });
      expect(decision.allowed, role).toBe(false);
      expect(decision.providerId, role).toBeNull();
      expect(decision.ceilingApplied, role).toBe(true);
      expect(decision.reason, role).toContain(
        `${role} must not run locally; stopping the run at the ceiling`,
      );
    }
  });

  it('stops a local-capable role when no ollama adapter is available', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      usage: overCeiling,
      availableProviderIds: ['claude', 'codex'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(
      'planner may run locally but no ollama provider is available; stopping the run at the ceiling',
    );
  });

  // ADR-028: a projected crossing routes exactly as a reached ceiling does.
  // The figures are the per-role estimates the dispatch guard checks against
  // (planner $0.70, critic $0.25, builder $1.25, reviewer $0.40) on the
  // default $20 ceiling, and the usage is stamped now for the same reason as
  // `overCeiling` above.
  const spentToday = (usd: number) => [{ at: new Date().toISOString(), usd, tokens: 0 }];

  it('routes the planner local when its estimate would carry the day past the ceiling', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      usage: spentToday(19.5),
      availableProviderIds: everyProvider,
      cloudProviderId: 'claude',
    });
    expect(decision.tier).toBe(2);
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.providerId).toBe('ollama');
    expect(decision.model).toBe('devstral-small-2:latest');
    expect(decision.allowed).toBe(true);
    expect(decision.estimatedUsd).toBe(ROLE_ESTIMATES_USD.planner);
    expect(decision.reason).toContain(
      'would route to cloud, but projected $20.20 ($19.50 spent on',
    );
    expect(decision.reason).toContain('+ $0.70 estimated) would pass the $20.00 ceiling');
    expect(decision.reason).toContain('planner runs locally on devstral-small-2:latest');
  });

  it('keeps a role on the cloud while its own estimate still fits', async () => {
    // Per role, not per run: at $19.50 the critic ($0.25 -> $19.75) fits while
    // the planner ($0.70) does not. Exactly the ceiling is allowed, as the
    // dispatch guard allows it, so the two never disagree on a call.
    const { routeRole } = await import('./router.js');
    const critic = routeRole({
      role: 'critic',
      usage: spentToday(19.5),
      availableProviderIds: everyProvider,
      cloudProviderId: 'claude',
    });
    expect(critic).toMatchObject({
      tier: 3,
      providerId: 'claude',
      allowed: true,
      ceilingApplied: false,
      estimatedUsd: 0.25,
    });
    const planner = (estimatedUsd: number) =>
      routeRole({
        role: 'planner',
        usage: spentToday(19.5),
        estimatedUsd,
        availableProviderIds: everyProvider,
        cloudProviderId: 'claude',
      });
    expect(planner(0.5)).toMatchObject({ tier: 3, providerId: 'claude', ceilingApplied: false });
    expect(planner(0.51)).toMatchObject({ tier: 2, providerId: 'ollama', ceilingApplied: true });
  });

  it('routes the critic local once the day leaves no room for it either', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'critic',
      usage: spentToday(19.8),
      availableProviderIds: everyProvider,
      cloudProviderId: 'claude',
    });
    expect(decision).toMatchObject({ tier: 2, providerId: 'ollama', allowed: true });
    expect(decision.reason).toContain('projected $20.05');
  });

  it('stops the builder and the reviewer on a projected crossing', async () => {
    const { routeRole } = await import('./router.js');
    for (const role of ['builder', 'reviewer'] as const) {
      const decision = routeRole({
        role,
        usage: spentToday(19.8),
        availableProviderIds: everyProvider,
        cloudProviderId: 'claude',
      });
      expect(decision.allowed, role).toBe(false);
      expect(decision.providerId, role).toBeNull();
      expect(decision.ceilingApplied, role).toBe(true);
      expect(decision.reason, role).toContain(
        `${role} must not run locally; stopping the run at the ceiling (would route to cloud, but projected $`,
      );
    }
  });

  it('stops a local-capable role on a projected crossing when no ollama adapter is available', async () => {
    // Q26: the ceiling is never a reason to spend. Nothing local to run on
    // means the run stops, with the projection named.
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      usage: spentToday(19.5),
      availableProviderIds: ['claude', 'codex'],
      cloudProviderId: 'claude',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBeNull();
    expect(decision.ceilingApplied).toBe(true);
    expect(decision.reason).toContain(
      'planner may run locally but no ollama provider is available; stopping the run at the ceiling (would route to cloud, but projected $20.20',
    );
  });

  it('projects nothing without usage to project from', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'planner',
      estimatedUsd: 999,
      availableProviderIds: everyProvider,
      cloudProviderId: 'claude',
    });
    expect(decision).toMatchObject({ tier: 3, providerId: 'claude', ceilingApplied: false });
  });

  it('carries the estimate it decided with', async () => {
    const { routeRole } = await import('./router.js');
    for (const role of ['planner', 'critic', 'builder', 'reviewer'] as const) {
      const decision = routeRole({ role, availableProviderIds: everyProvider });
      expect(decision.estimatedUsd, role).toBe(ROLE_ESTIMATES_USD[role]);
      expect(decision.estimatedUsd, role).toBe(roleEstimateUsd(role));
    }
    expect(roleEstimateUsd('verifier')).toBe(DEFAULT_ROLE_ESTIMATE_USD);
    const overridden = routeRole({
      role: 'planner',
      estimatedUsd: 0.05,
      availableProviderIds: everyProvider,
    });
    expect(overridden.estimatedUsd).toBe(0.05);
    // A negative estimate is no estimate.
    expect(
      routeRole({ role: 'planner', estimatedUsd: -1, availableProviderIds: everyProvider })
        .estimatedUsd,
    ).toBe(0);
  });

  it('does not retry ollama on itself after it failed', async () => {
    const { routeRole } = await import('./router.js');
    const decision = routeRole({
      role: 'critic',
      priorFailures: 1,
      usage: overCeiling,
      availableProviderIds: everyProvider,
      excludeProviderIds: ['ollama'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('ollama failed this stage');
  });

  it('annotates residency for a local decision', async () => {
    const { routeRole } = await import('./router.js');
    const cold = routeRole({
      role: 'planner',
      usage: overCeiling,
      availableProviderIds: everyProvider,
      residency: { loadedModels: ['qwen3:8b'] },
    });
    expect(cold.requiresLoad).toBe(true);
    expect(cold.estimatedLoadSeconds).toBe(10.6);
    const warm = routeRole({
      role: 'planner',
      usage: overCeiling,
      availableProviderIds: everyProvider,
      residency: { loadedModels: ['devstral-small-2:latest'] },
    });
    expect(warm.requiresLoad).toBe(false);
    expect(warm.estimatedLoadSeconds).toBe(0);
    expect(warm.providerId).toBe(cold.providerId);
  });

  it('never places a pipeline role on tier 1', async () => {
    const { routeRole } = await import('./router.js');
    for (const role of ['planner', 'critic', 'builder', 'reviewer'] as const) {
      for (const usage of [undefined, overCeiling]) {
        for (const priorFailures of [0, 1, 2, 5]) {
          const decision = routeRole({
            role,
            priorFailures,
            ...(usage ? { usage } : {}),
            availableProviderIds: everyProvider,
          });
          expect(decision.tier, `${role} failures=${priorFailures}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});
