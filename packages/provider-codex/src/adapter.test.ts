import type { ProviderEvent, ProviderRequest } from '@theforge/contracts';
import type { JsonLineProcessOptions } from '@theforge/providers';
import { describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  defaultCodexCommand,
  defaultCodexCommandArgs,
  EXTERNAL_SANDBOX_MARKER,
  isExternallySandboxed,
  mapCodexEvent,
  type CodexEnvironment,
  type CodexMappingState,
} from './index.js';

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

describe('Codex adapter contract', () => {
  it('uses Node with the package-owned entrypoint instead of a shell shim', () => {
    expect(defaultCodexCommand()).toBe(process.execPath);
    expect(defaultCodexCommandArgs()).toEqual([
      expect.stringMatching(/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/),
    ]);
  });

  it('maps a resume session and includes request context in stdin', async () => {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new CodexAdapter('codex-test', 'gpt-test', async function* (options) {
      invocation = options;
      yield { type: 'thread.started', thread_id: 'thread-resumed' };
      yield { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } };
      yield { type: 'turn.completed', usage: {} };
    });

    const events = await collect(
      adapter.run(
        request({
          sessionId: 'thread-original',
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
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
      'thread-original',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-test',
      '--output-schema',
      expect.stringContaining('output-schema.json'),
      '-',
    ]);
    expect(invocation?.stdin).toContain('<context label="README">\nRepository facts\n</context>');
    expect(events.at(-1)).toEqual({
      type: 'completed',
      sessionId: 'thread-resumed',
      output: { ok: true },
    });
  });

  it('prefers the model named on the request over the adapter default', async () => {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new CodexAdapter('codex-test', 'gpt-test', async function* (options) {
      invocation = options;
      yield { type: 'turn.completed', usage: {} };
    });
    await collect(adapter.run(request({ model: 'gpt-routed' }), { cwd: 'C:\\workspace' }));
    const index = invocation?.args.indexOf('--model') ?? -1;
    expect(invocation?.args[index + 1]).toBe('gpt-routed');
    expect(invocation?.args.filter((value) => value === '--model')).toHaveLength(1);
  });

  it('treats cached input as part of the total, not additional to it', () => {
    // The asymmetry worth pinning. Codex's `input_tokens` ALREADY includes the
    // cached portion - the opposite of Claude, whose figure excludes it. So the
    // total passes through untouched and only the breakdown is new. Getting
    // this backwards would double-count every cached token Codex reports.
    expect(
      mapCodexEvent(
        {
          type: 'turn.completed',
          usage: { input_tokens: 27_490, cached_input_tokens: 26_000, output_tokens: 1270 },
        },
        {},
      ).at(0),
    ).toMatchObject({ inputTokens: 27_490, cachedInputTokens: 26_000, outputTokens: 1270 });
  });

  it('publishes a new thread id and validates structured terminal JSON', () => {
    const state: CodexMappingState = {
      outputSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false,
      },
    };
    expect(mapCodexEvent({ type: 'thread.started', thread_id: 'thread-new' }, state)).toEqual([
      { type: 'session', sessionId: 'thread-new' },
    ]);
    mapCodexEvent(
      { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } },
      state,
    );

    expect(mapCodexEvent({ type: 'turn.completed', usage: {} }, state)).toEqual([
      { type: 'usage', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usd: 0 },
      { type: 'completed', sessionId: 'thread-new', output: { ok: true } },
    ]);
  });

  it('rejects non-JSON and schema-invalid structured output', () => {
    const schema = {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    };
    const nonJson: CodexMappingState = { outputSchema: schema, terminalText: 'not json' };
    const wrongShape: CodexMappingState = {
      outputSchema: schema,
      terminalText: '{"answer":42}',
    };

    expect(mapCodexEvent({ type: 'turn.completed' }, nonJson).at(-1)).toMatchObject({
      type: 'error',
      code: 'STRUCTURED_OUTPUT_INVALID',
    });
    expect(mapCodexEvent({ type: 'turn.completed' }, wrongShape).at(-1)).toMatchObject({
      type: 'error',
      code: 'STRUCTURED_OUTPUT_INVALID',
    });
  });

  it('combines the request timeout with process cancellation', async () => {
    let processSignal: AbortSignal | undefined;
    const adapter = new CodexAdapter('codex-test', undefined, async function* (options) {
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
    const adapter = new CodexAdapter('codex-test', undefined, async function* () {
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

/**
 * BLK-016 / ADR-030. Inside TheForge's provider container the Codex CLI cannot
 * build its own landlock/seccomp/user-namespace sandbox and loses its shell, so
 * the adapter hands it the bypass the CLI documents for externally sandboxed
 * environments - and only there. Everything about the decision is visible in the
 * assembled argument list, which is what these tests read.
 */
describe('Codex external sandbox marker', () => {
  async function assembledArgs(environment: CodexEnvironment): Promise<string[]> {
    let invocation: JsonLineProcessOptions | undefined;
    const adapter = new CodexAdapter(
      'codex-test',
      undefined,
      async function* (options) {
        invocation = options;
        yield { type: 'turn.completed', usage: {} };
      },
      [],
      environment,
    );
    await collect(adapter.run(request(), { cwd: 'C:\\workspace' }));
    return invocation?.args ?? [];
  }

  it('bypasses the nested Codex sandbox when the marker is set', async () => {
    const args = await assembledArgs({ [EXTERNAL_SANDBOX_MARKER]: '1' });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    // The bypass already implies danger-full-access, and 0.144.6 accepts both
    // flags together, so passing --sandbox as well would only be misleading
    // about which policy is in force: exactly one of them is ever passed.
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('workspace-write');
  });

  it('keeps the Codex sandbox when the marker is absent', async () => {
    const args = await assembledArgs({});
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'workspace-write',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('treats an unexpected marker value as not sandboxed', async () => {
    for (const value of ['0', '', 'true', 'yes', ' 1', '1 ', 'TRUE', 'docker']) {
      const args = await assembledArgs({ [EXTERNAL_SANDBOX_MARKER]: value });
      expect(args, `marker=${JSON.stringify(value)}`).not.toContain(
        '--dangerously-bypass-approvals-and-sandbox',
      );
      expect(args, `marker=${JSON.stringify(value)}`).toContain('workspace-write');
      expect(isExternallySandboxed({ [EXTERNAL_SANDBOX_MARKER]: value })).toBe(false);
    }
    expect(isExternallySandboxed({})).toBe(false);
    expect(isExternallySandboxed({ [EXTERNAL_SANDBOX_MARKER]: '1' })).toBe(true);
  });
});
