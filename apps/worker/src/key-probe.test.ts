import { describe, expect, it } from 'vitest';
import {
  KEY_PROBE_MODEL,
  keyProbeVerdict,
  probeAnthropicKey,
  type KeyProbeResult,
} from './key-probe.js';

const KEY = 'sk-ant-api03-SECRET-KEY-VALUE-1234567890';

type Sent = { url: string; init: RequestInit; body: string };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    sent.push({
      url: target,
      init: init ?? {},
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return respond();
  }) as typeof fetch;
  return { impl, sent };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('probeAnthropicKey', () => {
  it('sends one token to the messages endpoint on the cheap model with the key as a header', async () => {
    const { impl, sent } = fakeFetch(() => json(200, { id: 'msg_1', content: [] }));
    expect(await probeAnthropicKey(KEY, { fetch: impl })).toEqual({ status: 'ok' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(sent[0]?.body ?? '') as Record<string, unknown>;
    expect(body).toMatchObject({ model: KEY_PROBE_MODEL, max_tokens: 1 });
    // The key is a header, never part of the URL or the body.
    expect(sent[0]?.url).not.toContain(KEY);
    expect(sent[0]?.body).not.toContain(KEY);
  });

  it('sends the workspace id header only when one is given (ADR-039)', async () => {
    const without = fakeFetch(() => json(200, {}));
    await probeAnthropicKey(KEY, { fetch: without.impl });
    expect(without.sent[0]?.init.headers).not.toHaveProperty('anthropic-workspace-id');

    const withId = fakeFetch(() => json(200, {}));
    await probeAnthropicKey(KEY, { fetch: withId.impl, workspaceId: 'wrkspc_01Example' });
    expect(withId.sent[0]?.init.headers).toMatchObject({
      'anthropic-workspace-id': 'wrkspc_01Example',
      'x-api-key': KEY,
    });
  });

  it('honours an overridden base URL and model', async () => {
    const { impl, sent } = fakeFetch(() => json(200, {}));
    await probeAnthropicKey(KEY, { fetch: impl, baseUrl: 'http://localhost:9', model: 'm-1' });
    expect(sent[0]?.url).toBe('http://localhost:9/v1/messages');
    expect(JSON.parse(sent[0]?.body ?? '')).toMatchObject({ model: 'm-1' });
  });

  it('rejects the key with the API’s own words when it is not scoped to a workspace (BLK-031)', async () => {
    const message =
      'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
    const { impl } = fakeFetch(() =>
      json(400, { type: 'error', error: { type: 'invalid_request_error', message } }),
    );
    expect(await probeAnthropicKey(KEY, { fetch: impl })).toEqual({
      status: 'rejected',
      httpStatus: 400,
      message,
    });
  });

  it.each([
    [401, 'invalid x-api-key'],
    [402, 'Your credit balance is too low'],
    [403, 'permission denied'],
  ])('treats HTTP %i as a rejection of the key', async (status, message) => {
    const { impl } = fakeFetch(() => json(status, { error: { message } }));
    expect(await probeAnthropicKey(KEY, { fetch: impl })).toEqual({
      status: 'rejected',
      httpStatus: status,
      message,
    });
  });

  it.each([404, 408, 429, 500, 503, 529])(
    'treats HTTP %i as inconclusive: it says nothing about the key',
    async (status) => {
      const { impl } = fakeFetch(() => json(status, { error: { message: 'try later' } }));
      const result = await probeAnthropicKey(KEY, { fetch: impl });
      expect(result.status).toBe('inconclusive');
      expect((result as { message: string }).message).toContain(`HTTP ${status}`);
    },
  );

  it('is inconclusive when the API cannot be reached, and says why', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
    }) as unknown as typeof fetch;
    const result = await probeAnthropicKey(KEY, { fetch: impl });
    expect(result).toEqual({
      status: 'inconclusive',
      message: 'could not reach the Anthropic API: fetch failed: getaddrinfo ENOTFOUND',
    });
  });

  it('is inconclusive on a timeout', async () => {
    const impl = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted by the probe timeout')),
        );
      })) as typeof fetch;
    const result = await probeAnthropicKey(KEY, { fetch: impl, timeoutMs: 20 });
    expect(result.status).toBe('inconclusive');
  });

  it('never lets the key out, even when the API echoes it or an error contains it', async () => {
    const echoed = fakeFetch(() => json(401, { error: { message: `bad key ${KEY} given` } }));
    const rejected = await probeAnthropicKey(KEY, { fetch: echoed.impl });
    expect(JSON.stringify(rejected)).not.toContain(KEY);
    expect(JSON.stringify(rejected)).toContain('[redacted]');

    const thrown = (async () => {
      throw new Error(`connect failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const unreachable = await probeAnthropicKey(KEY, { fetch: thrown });
    expect(JSON.stringify(unreachable)).not.toContain(KEY);
  });

  it('reads a plain-text error body and truncates a long one', async () => {
    const plain = fakeFetch(() => new Response('upstream said no', { status: 403 }));
    expect(await probeAnthropicKey(KEY, { fetch: plain.impl })).toMatchObject({
      status: 'rejected',
      message: 'upstream said no',
    });
    const long = fakeFetch(() => new Response('x'.repeat(2_000), { status: 401 }));
    const result = (await probeAnthropicKey(KEY, { fetch: long.impl })) as { message: string };
    expect(result.message).toHaveLength(300);
    expect(result.message.endsWith('…')).toBe(true);
  });
});

describe('keyProbeVerdict', () => {
  it('advertises the provider when the key is verified', () => {
    const verdict = keyProbeVerdict({ status: 'ok' });
    expect(verdict.advertise).toBe(true);
    expect(verdict.fault).toBeUndefined();
    expect(verdict.log).toContain('verified');
  });

  it('keeps advertising when the probe could not decide, and logs that it did not verify', () => {
    const result: KeyProbeResult = { status: 'inconclusive', message: 'HTTP 529: overloaded' };
    const verdict = keyProbeVerdict(result);
    expect(verdict.advertise).toBe(true);
    expect(verdict.fault).toBeUndefined();
    expect(verdict.log).toContain('could not be verified');
    expect(verdict.log).toContain('HTTP 529: overloaded');
  });

  it('withholds the provider and carries the reason when the key is rejected', () => {
    const verdict = keyProbeVerdict({
      status: 'rejected',
      httpStatus: 400,
      message: 'This API key is not scoped to a workspace',
    });
    expect(verdict.advertise).toBe(false);
    expect(verdict.fault).toBe(
      'the API key was rejected (HTTP 400): This API key is not scoped to a workspace',
    );
    expect(verdict.log).toContain('not advertised');
  });
});
