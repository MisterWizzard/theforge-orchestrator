import type { ProviderEvent, ProviderRequest } from '@theforge/contracts';
import type { JsonLineProcessOptions } from '@theforge/providers';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, defaultClaudeCommand, mapClaudeEvent } from './index.js';

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  runId: 'run-1',
  taskId: 'task-1',
  role: 'builder',
  prompt: 'Implement the task.',
  context: [],
  timeoutMs: 1_000,
  ...overrides,
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Claude adapter contract', () => {
  it('uses the package-owned native executable without a shell shim', () => {
    expect(defaultClaudeCommand()).toMatch(
      /[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe$/,
    );
    expect(defaultClaudeCommand()).not.toMatch(/\.cmd$/i);
  });

  it('maps resume arguments and includes request context in the prompt', async () => {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new ClaudeAdapter('claude-test', 'sonnet-test', async function* (options) {
      invocation = options;
      yield {
        type: 'result',
        session_id: 'session-resumed',
        structured_output: { ok: true },
        usage: {},
      };
    });

    const events = await collect(
      adapter.run(
        request({
          sessionId: 'session-original',
          context: [{ label: 'README', content: 'Repository facts' }],
          outputSchema: {
            type: 'object',
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
          },
        }),
        { cwd: 'C:\\workspace' },
      ),
    );

    expect(invocation?.args).toEqual([
      '-p',
      expect.stringContaining('<context label="README">\nRepository facts\n</context>'),
      '--resume',
      'session-original',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      // builder: must be able to edit files (BLK-009)
      'acceptEdits',
      '--json-schema',
      '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}',
      '--model',
      'sonnet-test',
    ]);
    expect(events.at(-1)).toEqual({
      type: 'completed',
      sessionId: 'session-resumed',
      output: { ok: true },
    });
  });

  it('prefers the model named on the request over the adapter default', async () => {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new ClaudeAdapter('claude-test', 'sonnet-test', async function* (options) {
      invocation = options;
      yield { type: 'result', session_id: 's', result: 'done', usage: {} };
    });
    await collect(adapter.run(request({ model: 'opus-routed' }), { cwd: 'C:\\workspace' }));
    const index = invocation?.args.indexOf('--model') ?? -1;
    expect(invocation?.args[index + 1]).toBe('opus-routed');
    expect(invocation?.args.filter((value) => value === '--model')).toHaveLength(1);
  });

  it('parses and validates structured terminal JSON', () => {
    const schema = {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    };

    expect(
      mapClaudeEvent(
        {
          type: 'result',
          session_id: 'session-new',
          result: '{"items":["one"]}',
          usage: { input_tokens: 2, output_tokens: 3 },
        },
        schema,
      ),
    ).toEqual([
      { type: 'usage', inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, usd: 0 },
      { type: 'completed', sessionId: 'session-new', output: { items: ['one'] } },
    ]);
  });

  it('counts cache tokens as input, which is where almost all of them are', () => {
    // The bug this pins. Claude's `input_tokens` is the UNCACHED residual, so
    // reading it alone recorded 4 input tokens for calls that cost a dollar and
    // produced thousands of output tokens - which is exactly what the ledger
    // held on 04/10/2026 and why the cost review could not use it. 4 fresh plus
    // 31,000 cached is 31,004 in total, of which 31,000 cached.
    expect(
      mapClaudeEvent({
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 12_000,
          cache_read_input_tokens: 19_000,
          output_tokens: 2183,
        },
        total_cost_usd: 0.476506,
      }).at(0),
    ).toEqual({
      type: 'usage',
      inputTokens: 31_004,
      cachedInputTokens: 31_000,
      outputTokens: 2183,
      usd: 0.476506,
    });
  });

  /**
   * ADR-041. A subscription login reports a notional `total_cost_usd` that nothing is billed for. If
   * it were recorded, the daily ceiling and the monthly budget would spend credits the API never
   * charged, which is exactly how the first $11 of "spend" in the ledger arose.
   */
  it('records $0 for a subscription login, and the real cost for the API key', () => {
    const result = {
      type: 'result',
      result: 'done',
      usage: { input_tokens: 4, output_tokens: 10 },
      total_cost_usd: 0.476506,
    };
    expect(mapClaudeEvent(result).at(0)).toMatchObject({ usd: 0.476506 });
    expect(mapClaudeEvent(result, undefined, { metered: true }).at(0)).toMatchObject({
      usd: 0.476506,
    });
    expect(mapClaudeEvent(result, undefined, { metered: false }).at(0)).toMatchObject({
      usd: 0,
      outputTokens: 10,
    });
  });

  it('answers to the id it was given, and to claude by default', () => {
    expect(new ClaudeAdapter().id).toBe('claude');
    expect(new ClaudeAdapter('claude', undefined, undefined, { id: 'claude-sub' }).id).toBe(
      'claude-sub',
    );
  });

  it('applies the metering flag to the usage a run actually emits', async () => {
    const lines = (usd: number) => [
      {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: usd,
      },
    ];
    const run = async (options?: { id?: string; metered?: boolean }) => {
      const adapter = new ClaudeAdapter(
        'claude',
        undefined,
        async function* () {
          yield* lines(0.9);
        },
        options,
      );
      const events: ProviderEvent[] = [];
      for await (const event of adapter.run(request(), { cwd: process.cwd() })) events.push(event);
      return events.find((event) => event.type === 'usage');
    };
    expect(await run()).toMatchObject({ usd: 0.9 });
    expect(await run({ id: 'claude-sub', metered: false })).toMatchObject({ usd: 0 });
  });

  it('reports no cache when the result omits the cache fields', () => {
    // An older CLI, or caching off. The total must then equal `input_tokens`
    // exactly, so this change cannot inflate a figure it has no business
    // touching.
    expect(
      mapClaudeEvent({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 500, output_tokens: 20 },
      }).at(0),
    ).toMatchObject({ inputTokens: 500, cachedInputTokens: 0 });
  });

  it('publishes a session id as soon as initialization reports it', () => {
    expect(mapClaudeEvent({ type: 'system', subtype: 'init', session_id: 'session-new' })).toEqual([
      { type: 'session', sessionId: 'session-new' },
    ]);
  });

  it('rejects non-JSON and schema-invalid structured output', () => {
    const schema = {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    };

    expect(mapClaudeEvent({ type: 'result', result: 'not json' }, schema).at(-1)).toMatchObject({
      type: 'error',
      code: 'STRUCTURED_OUTPUT_INVALID',
    });
    expect(
      mapClaudeEvent({ type: 'result', result: '{"answer":42}' }, schema).at(-1),
    ).toMatchObject({ type: 'error', code: 'STRUCTURED_OUTPUT_INVALID' });
  });

  it('maps a failed terminal result as an error, never completion', () => {
    expect(
      mapClaudeEvent({
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result: 'Weekly limit reached',
      }),
    ).toEqual([
      { type: 'usage', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usd: 0 },
      {
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'Weekly limit reached',
        retryable: true,
      },
    ]);
  });

  it('combines the request timeout with process cancellation', async () => {
    let processSignal: AbortSignal | undefined;
    const adapter = new ClaudeAdapter('claude-test', undefined, async function* (options) {
      processSignal = options.signal;
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'cancelled' };
    });

    const events = await collect(adapter.run(request({ timeoutMs: 5 }), { cwd: 'C:\\workspace' }));

    expect(processSignal?.aborted).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'TIMEOUT', retryable: true }),
    ]);
  });

  it('propagates an already-aborted caller signal as cancellation', async () => {
    const caller = new AbortController();
    caller.abort('stop');
    let invoked = false;
    const adapter = new ClaudeAdapter('claude-test', undefined, async function* () {
      invoked = true;
      yield { type: 'cancelled' };
    });

    const events = await collect(
      adapter.run(request(), { cwd: 'C:\\workspace', signal: caller.signal }),
    );

    expect(invoked).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'CANCELLED', retryable: false }),
    ]);
  });
});

describe('permission mode by role', () => {
  async function permissionModeFor(role: ProviderRequest['role']): Promise<string> {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new ClaudeAdapter(defaultClaudeCommand(), undefined, (options) => {
      invocation = options;
      return (async function* () {
        yield { type: 'result', subtype: 'success', session_id: 's', result: 'done' };
      })();
    });
    await collect(adapter.run(request({ role }), { cwd: '/workspace' }));
    const index = invocation?.args.indexOf('--permission-mode') ?? -1;
    return index >= 0 ? (invocation?.args[index + 1] ?? '') : '';
  }

  it('lets the builder accept edits', async () => {
    // dontAsk denies every permission-requiring tool when no prompt can be shown,
    // so the builder generated output and changed nothing in run fbc717e6.
    expect(await permissionModeFor('builder')).toBe('acceptEdits');
  });

  it('keeps every read-only role unable to edit', async () => {
    for (const role of ['planner', 'critic', 'reviewer', 'verifier', 'integrator'] as const) {
      expect(await permissionModeFor(role)).toBe('dontAsk');
    }
  });
});
