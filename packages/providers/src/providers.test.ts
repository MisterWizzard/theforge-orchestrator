import { describe, expect, it } from 'vitest';
import { FakeProvider, jsonLineProcess } from './index.js';

describe('provider contract', () => {
  it('streams deterministic normalized events', async () => {
    const provider = new FakeProvider();
    const events = [];
    for await (const event of provider.run(
      { runId: 'r', taskId: 't', role: 'builder', prompt: 'work', context: [], timeoutMs: 1000 },
      { cwd: process.cwd() },
    ))
      events.push(event);
    expect(events.at(-1)?.type).toBe('completed');
    expect((await provider.diagnose()).authenticated).toBe(true);
  });
  it('supports cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider();
    const events = [];
    for await (const event of provider.run(
      { runId: 'r', taskId: 't', role: 'builder', prompt: 'work', context: [], timeoutMs: 1000 },
      { cwd: process.cwd(), signal: controller.signal },
    ))
      events.push(event);
    expect(events[0]).toMatchObject({ type: 'error', code: 'CANCELLED' });
  });
  it('does not inherit orchestration secrets and does not spawn after cancellation', async () => {
    const previous = process.env.FORGE_WORKER_TOKEN;
    process.env.FORGE_WORKER_TOKEN = 'provider-must-not-inherit-this-token';
    try {
      const output = [];
      for await (const event of jsonLineProcess({
        command: process.execPath,
        args: [
          '-e',
          "console.log(JSON.stringify({token:process.env.FORGE_WORKER_TOKEN??'missing'}))",
        ],
        cwd: process.cwd(),
      }))
        output.push(event);
      expect(output).toEqual([{ token: 'missing' }]);

      const controller = new AbortController();
      controller.abort();
      const cancelled = [];
      for await (const event of jsonLineProcess({
        command: 'definitely-not-an-executable',
        args: [],
        cwd: process.cwd(),
        signal: controller.signal,
      }))
        cancelled.push(event);
      expect(cancelled).toEqual([{ type: 'cancelled' }]);
    } finally {
      if (previous === undefined) delete process.env.FORGE_WORKER_TOKEN;
      else process.env.FORGE_WORKER_TOKEN = previous;
    }
  });
  it('tees raw stdout lines and stderr chunks without changing what it yields', async () => {
    const rawLines: string[] = [];
    const stderrChunks: string[] = [];
    const script = [
      'process.stdout.write(\'{"type":"event","n":1}\\n\')',
      "process.stdout.write('not json at all\\n')",
      "process.stdout.write('\\n')",
      "process.stderr.write('warning: something\\n')",
      'process.stdout.write(\'{"type":"event","n":2}\\n\')',
      'process.exitCode = 3',
    ].join(';');
    const output: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of jsonLineProcess({
          command: process.execPath,
          args: ['-e', script],
          cwd: process.cwd(),
          onRawStdoutLine: (line) => rawLines.push(line),
          onStderr: (chunk) => stderrChunks.push(chunk),
        }))
          output.push(event);
      })(),
    ).rejects.toThrow('Provider exited 3: warning: something');
    // The yielded contract is exactly what it was: parsed JSON, a warning for
    // the non-JSON line, nothing for the blank one, the error for the exit.
    expect(output).toEqual([
      { type: 'event', n: 1 },
      { type: 'protocol_warning', raw: 'not json at all' },
      { type: 'event', n: 2 },
    ]);
    // The tee saw every line as written, blank and non-JSON ones included.
    expect(rawLines).toEqual([
      '{"type":"event","n":1}',
      'not json at all',
      '',
      '{"type":"event","n":2}',
    ]);
    expect(stderrChunks.join('')).toBe('warning: something\n');
  });
});
