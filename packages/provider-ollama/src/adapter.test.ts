import type { ProviderEvent, ProviderRequest } from '@theforge/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOllamaMessages,
  DEFAULT_OLLAMA_URL,
  listLoadedModels,
  listModels,
  OllamaAdapter,
} from './index.js';
import { startFakeOllama, type FakeOllama, type FakeOllamaOptions } from './testing.js';

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  runId: 'run-1',
  taskId: 'task-1',
  role: 'planner',
  prompt: 'Plan the work.',
  context: [],
  timeoutMs: 5_000,
  model: 'qwen3:8b',
  ...overrides,
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(condition()).toBe(true);
}

const fakes: FakeOllama[] = [];
const start = async (options: FakeOllamaOptions = {}) => {
  const fake = await startFakeOllama(options);
  fakes.push(fake);
  return fake;
};
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

const schema = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
  additionalProperties: false,
};

describe('Ollama adapter contract', () => {
  it('streams text deltas, maps usage from the final chunk and completes with the text', async () => {
    const fake = await start({
      chat: { kind: 'stream', chunks: ['Hel', 'lo', ' world'], promptEvalCount: 12, evalCount: 3 },
    });
    const adapter = new OllamaAdapter({ baseUrl: fake.url, numCtx: 8192, keepAlive: '5m' });
    expect(adapter.capabilities).toMatchObject({ local: true, tools: false, resume: false });

    const events = await collect(
      adapter.run(request({ context: [{ label: 'README', content: 'Repository facts' }] }), {
        cwd: 'C:\\workspace',
      }),
    );

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'text_delta', text: ' world' },
      { type: 'usage', inputTokens: 12, outputTokens: 3, usd: 0 },
      { type: 'completed', output: 'Hello world' },
    ]);
    const body = fake.chats[0];
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      keep_alive: '5m',
      options: { temperature: 0, num_ctx: 8192 },
    });
    expect(body).not.toHaveProperty('format');
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain('planner');
    expect(messages[0]?.content).toContain('untrusted reference material');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('Plan the work.');
    expect(messages[1]?.content).toContain(
      '<context label="README">\nRepository facts\n</context>',
    );
  });

  it('passes the output schema through as format and validates the JSON at the boundary', async () => {
    const fake = await start({
      chat: (body) => ({
        kind: 'stream',
        chunks: body.format ? ['{"ok":', 'true}'] : ['{"ok":"no"}'],
        evalCount: 4,
      }),
    });
    const adapter = new OllamaAdapter({ baseUrl: fake.url });

    const valid = await collect(
      adapter.run(request({ outputSchema: schema }), { cwd: 'C:\\workspace' }),
    );
    expect(valid.at(-1)).toEqual({ type: 'completed', output: { ok: true } });
    expect(fake.chats[0]?.format).toEqual(schema);
    const user = (fake.chats[0]?.messages as Array<{ content: string }>)[1]?.content ?? '';
    expect(user).toContain('must be only valid JSON matching this JSON Schema');

    // The fake ignores the schema when the request carries none; here the
    // adapter is handed a schema the model's reply does not satisfy.
    const invalidFake = await start({ chat: { kind: 'stream', chunks: ['{"ok":"no"}'] } });
    const invalid = await collect(
      new OllamaAdapter({ baseUrl: invalidFake.url }).run(request({ outputSchema: schema }), {
        cwd: 'C:\\workspace',
      }),
    );
    expect(invalid.at(-1)).toMatchObject({
      type: 'error',
      code: 'STRUCTURED_OUTPUT_INVALID',
      retryable: false,
    });
    expect(invalid.some((event) => event.type === 'completed')).toBe(false);
  });

  it('sends think:false only to a model that reports the thinking capability', async () => {
    const fake = await start();
    const adapter = new OllamaAdapter({ baseUrl: fake.url });

    await collect(adapter.run(request({ model: 'qwen3:8b' }), { cwd: 'C:\\workspace' }));
    await collect(adapter.run(request({ model: 'qwen3:8b' }), { cwd: 'C:\\workspace' }));
    await collect(
      adapter.run(request({ model: 'devstral-small-2:latest' }), { cwd: 'C:\\workspace' }),
    );

    expect(fake.chats[0]).toMatchObject({ model: 'qwen3:8b', think: false });
    expect(fake.chats[1]).toMatchObject({ model: 'qwen3:8b', think: false });
    expect(fake.chats[2]).toMatchObject({ model: 'devstral-small-2:latest' });
    expect(fake.chats[2]).not.toHaveProperty('think');
    // One capability lookup per model, however many calls.
    const shows = fake.requests.filter((entry) => entry.path === '/api/show');
    expect(shows.map((entry) => (entry.body as { model: string }).model)).toEqual([
      'qwen3:8b',
      'devstral-small-2:latest',
    ]);
  });

  it('falls back to the adapter model and refuses to run with none at all', async () => {
    const fake = await start();
    const withDefault = new OllamaAdapter({ baseUrl: fake.url, model: 'devstral-small-2:latest' });
    await collect(withDefault.run(request({ model: undefined }), { cwd: 'C:\\workspace' }));
    expect(fake.chats[0]?.model).toBe('devstral-small-2:latest');

    const withoutModel = new OllamaAdapter({ baseUrl: fake.url });
    const events = await collect(
      withoutModel.run(request({ model: undefined }), { cwd: 'C:\\workspace' }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'MODEL_MISSING', retryable: false }),
    ]);
    expect(fake.chats).toHaveLength(1);
  });

  it('cancels a stream mid-way on the caller signal and drops the connection', async () => {
    const fake = await start({
      chat: { kind: 'stream', chunks: ['one', 'two', 'three'], delayMs: 300 },
    });
    const adapter = new OllamaAdapter({ baseUrl: fake.url });
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    for await (const event of adapter.run(request({ timeoutMs: 10_000 }), {
      cwd: 'C:\\workspace',
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === 'text_delta') controller.abort(new Error('stop'));
    }
    expect(events).toEqual([
      { type: 'text_delta', text: 'one' },
      expect.objectContaining({ type: 'error', code: 'CANCELLED', retryable: false }),
    ]);
    await waitFor(() => fake.abortedChats === 1);
  });

  it('times out a stalled stream with a retryable TIMEOUT and drops the connection', async () => {
    const fake = await start({ chat: { kind: 'hang' } });
    const adapter = new OllamaAdapter({ baseUrl: fake.url });
    const events = await collect(
      adapter.run(request({ timeoutMs: 200 }), { cwd: 'C:\\workspace' }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'TIMEOUT', retryable: true }),
    ]);
    await waitFor(() => fake.abortedChats === 1);
  });

  it('maps a refused connection to a retryable PROCESS_EXIT', async () => {
    const fake = await startFakeOllama();
    const url = fake.url;
    await fake.close();
    const adapter = new OllamaAdapter({ baseUrl: url });
    const events = await collect(adapter.run(request(), { cwd: 'C:\\workspace' }));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'PROCESS_EXIT', retryable: true }),
    ]);
    expect((events[0] as { message: string }).message).toMatch(/ECONNREFUSED|fetch failed/);
  });

  it('maps a 4xx to a non-retryable error and a 5xx to a retryable one', async () => {
    const fake = await start();
    const adapter = new OllamaAdapter({ baseUrl: fake.url });
    const missing = await collect(
      adapter.run(request({ model: 'missing:latest' }), { cwd: 'C:\\workspace' }),
    );
    expect(missing).toEqual([
      {
        type: 'error',
        code: 'PROCESS_EXIT',
        message: "Ollama /api/chat returned 404: model 'missing:latest' not found",
        retryable: false,
      },
    ]);

    const failing = await start({
      chat: { kind: 'status', status: 500, error: 'llama runner died' },
    });
    const crashed = await collect(
      new OllamaAdapter({ baseUrl: failing.url }).run(request(), { cwd: 'C:\\workspace' }),
    );
    expect(crashed).toEqual([
      expect.objectContaining({ type: 'error', code: 'PROCESS_EXIT', retryable: true }),
    ]);
    expect((crashed[0] as { message: string }).message).toContain('llama runner died');
  });

  it('fails an oversized response as soon as the limit is crossed', async () => {
    const fake = await start({ chat: { kind: 'flood', bytes: 3_000_000 } });
    const adapter = new OllamaAdapter({ baseUrl: fake.url, maxOutputBytes: 200_000 });
    const events = await collect(adapter.run(request(), { cwd: 'C:\\workspace' }));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'OUTPUT_LIMIT',
      message: 'Ollama output exceeded the 200000 byte limit',
      retryable: false,
    });
    expect(events.some((event) => event.type === 'completed')).toBe(false);
    // Well under the flood: the reader was cancelled, not drained.
    const delivered = events
      .filter((event) => event.type === 'text_delta')
      .reduce((total, event) => total + (event as { text: string }).text.length, 0);
    expect(delivered).toBeLessThan(1_000_000);
    await waitFor(() => fake.abortedChats === 1);
  });

  it('reports a stream that ends without a final chunk as a retryable protocol error', async () => {
    const fake = await start({ chat: { kind: 'truncated', chunks: ['partial'] } });
    const events = await collect(
      new OllamaAdapter({ baseUrl: fake.url }).run(request(), { cwd: 'C:\\workspace' }),
    );
    expect(events).toEqual([
      { type: 'text_delta', text: 'partial' },
      expect.objectContaining({ type: 'error', code: 'PROTOCOL_ERROR', retryable: true }),
    ]);
  });

  it('surfaces an error chunk from the server and a context-limit stop', async () => {
    const errored = await start({
      chat: { kind: 'error_chunk', error: 'out of memory', before: ['some'] },
    });
    expect(
      await collect(
        new OllamaAdapter({ baseUrl: errored.url }).run(request(), { cwd: 'C:\\workspace' }),
      ),
    ).toEqual([
      { type: 'text_delta', text: 'some' },
      { type: 'error', code: 'PROCESS_EXIT', message: 'out of memory', retryable: false },
    ]);

    const truncated = await start({
      chat: { kind: 'stream', chunks: ['{"ok":'], doneReason: 'length', evalCount: 9 },
    });
    const events = await collect(
      new OllamaAdapter({ baseUrl: truncated.url, numCtx: 4096 }).run(
        request({ outputSchema: schema }),
        { cwd: 'C:\\workspace' },
      ),
    );
    expect(events.slice(1)).toEqual([
      { type: 'usage', inputTokens: 0, outputTokens: 9, usd: 0 },
      expect.objectContaining({ type: 'error', code: 'OUTPUT_TRUNCATED', retryable: false }),
    ]);
    expect((events[2] as { message: string }).message).toContain('num_ctx 4096');
  });

  it('propagates an already-aborted caller signal without calling the server', async () => {
    const fake = await start();
    const caller = new AbortController();
    caller.abort('stop');
    const events = await collect(
      new OllamaAdapter({ baseUrl: fake.url }).run(request(), {
        cwd: 'C:\\workspace',
        signal: caller.signal,
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'CANCELLED', retryable: false }),
    ]);
    expect(fake.chats).toHaveLength(0);
  });

  it('diagnoses a reachable server, with and without the requested model', async () => {
    const fake = await start({ version: '0.34.4' });
    expect(await new OllamaAdapter({ baseUrl: fake.url }).diagnose()).toEqual({
      available: true,
      authenticated: true,
      version: '0.34.4',
      detail: `Ollama at ${fake.url}; models: qwen3:8b, devstral-small-2:latest`,
    });
    expect(
      (await new OllamaAdapter({ baseUrl: fake.url, model: 'qwen3:8b' }).diagnose()).detail,
    ).toContain('model qwen3:8b is present');
    const missing = await new OllamaAdapter({
      baseUrl: fake.url,
      model: 'missing:latest',
    }).diagnose();
    expect(missing.available).toBe(true);
    expect(missing.detail).toContain(
      'model missing:latest is not listed (ollama pull missing:latest)',
    );

    const url = fake.url;
    await fake.close();
    fakes.splice(fakes.indexOf(fake), 1);
    const down = await new OllamaAdapter({ baseUrl: url }).diagnose();
    expect(down).toMatchObject({ available: false, authenticated: false });
    expect(down.detail).toContain(`Ollama is not reachable at ${url}`);
  });

  it('lists models from /api/tags and resident models from /api/ps', async () => {
    const fake = await start({
      models: [{ name: 'qwen3:8b', size: 5_225_388_164, family: 'qwen3' }],
      loaded: [
        {
          name: 'devstral-small-2:latest',
          sizeVram: 19_646_560_337,
          contextLength: 32_768,
          expiresAt: '2026-09-26T11:44:06+10:00',
        },
      ],
    });
    expect(await listModels(fake.url)).toEqual([
      {
        name: 'qwen3:8b',
        size: 5_225_388_164,
        family: 'qwen3',
        parameterSize: '1B',
        quantization: 'Q4_K_M',
      },
    ]);
    expect(await listLoadedModels(fake.url)).toEqual([
      {
        name: 'devstral-small-2:latest',
        sizeVram: 19_646_560_337,
        contextLength: 32_768,
        expiresAt: '2026-09-26T11:44:06+10:00',
      },
    ]);
  });

  it('renders every pipeline role into a system preamble', () => {
    for (const role of [
      'planner',
      'critic',
      'builder',
      'reviewer',
      'verifier',
      'integrator',
    ] as const) {
      const [system, user] = buildOllamaMessages(request({ role }));
      expect(system?.role).toBe('system');
      expect(system?.content).toContain(role);
      expect(user).toEqual({ role: 'user', content: 'Plan the work.' });
    }
  });
});

/**
 * One real request against the local server, run on purpose with
 * FORGE_OLLAMA_SMOKE=1. It targets qwen3:8b, the tier-1 model, with a tiny
 * prompt and the measured tier-1 context (docs/evidence-local-model-benchmark-2-2026-09-26.txt).
 */
describe('Ollama smoke test', () => {
  it.runIf(process.env.FORGE_OLLAMA_SMOKE === '1')(
    'answers a ten-token prompt on qwen3:8b',
    async () => {
      const adapter = new OllamaAdapter({
        baseUrl: process.env.FORGE_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
        numCtx: 8192,
      });
      const diagnostic = await adapter.diagnose();
      expect(diagnostic.available, diagnostic.detail).toBe(true);
      const startedAt = Date.now();
      const events = await collect(
        adapter.run(
          request({
            model: 'qwen3:8b',
            prompt: 'Reply with exactly one word: ready',
            timeoutMs: 120_000,
          }),
          { cwd: process.cwd() },
        ),
      );
      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event as { text: string }).text)
        .join('');
      const usage = events.find((event) => event.type === 'usage');
      console.log(
        JSON.stringify(
          { diagnostic, elapsedMs: Date.now() - startedAt, text, usage, last: events.at(-1) },
          null,
          2,
        ),
      );
      expect(usage).toMatchObject({ type: 'usage', usd: 0 });
      expect((usage as { outputTokens: number }).outputTokens).toBeGreaterThan(0);
      expect(events.at(-1)).toMatchObject({ type: 'completed' });
      expect(text.toLowerCase()).toContain('ready');
    },
    180_000,
  );
});
