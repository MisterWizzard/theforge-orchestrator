import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderEscalation } from './escalation.js';
import { sample } from './fixture.js';
import {
  HA_MESSAGE_LIMIT,
  HaPushChannel,
  haNotificationBody,
  haNotifyServices,
  haServiceUrl,
} from './ha.js';

type Received = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

let server: Server;
let baseUrl: string;
const received: Received[] = [];
let respond: (request: Received) => { status: number; body: string } = () => ({
  status: 200,
  body: '[]',
});

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const record = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
      received.push(record);
      const answer = respond(record);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Mirrors Dan's reverse-proxy layout: the base already carries a path prefix.
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ha/`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('HaPushChannel', () => {
  it('posts the notify service call with the bearer token and the exact body', async () => {
    received.length = 0;
    const channel = new HaPushChannel({
      baseUrl,
      token: 'test-long-lived-token',
      service: 'mobile_app_phone',
    });
    const escalation = sample();
    const rendered = renderEscalation(escalation);
    await channel.send(rendered, escalation);

    expect(received).toHaveLength(1);
    const call = received[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/ha/api/services/notify/mobile_app_phone');
    expect(call.headers.authorization).toBe('Bearer test-long-lived-token');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual({
      title: 'Forge warning: Run 9d6cf990 wants to push forge/9d6cf990 [paused]',
      message: rendered.text,
      data: { tag: 'decision.approval:9d6cf990:approval-1', group: 'theforge' },
    });
  });

  it('sends the same tag and group for every severity and nothing that bypasses Do Not Disturb (ADR-023)', () => {
    for (const severity of ['info', 'warn', 'critical'] as const) {
      const escalation = sample({ severity });
      const body = haNotificationBody(renderEscalation(escalation), escalation);
      expect(body.data).toEqual({ tag: escalation.dedupeKey, group: 'theforge' });
      // The keys the companion app reads as "override the phone's own settings".
      for (const key of ['importance', 'priority', 'ttl', 'channel', 'alert_once', 'persistent'])
        expect(body.data).not.toHaveProperty(key);
      expect(JSON.stringify(body)).not.toContain('alarm_stream');
    }
  });

  it('truncates oversized text and points at the email and the outbox', () => {
    const long = { subject: 's', text: 'x'.repeat(HA_MESSAGE_LIMIT + 500) };
    const body = haNotificationBody(long, sample({ severity: 'critical' }));
    expect(body.message.length).toBeLessThanOrEqual(HA_MESSAGE_LIMIT);
    expect(body.message.endsWith('…[see email or outbox]')).toBe(true);
  });

  it('fails with the HTTP status and never echoes the token', async () => {
    respond = () => ({ status: 401, body: '{"message":"Unauthorized"}' });
    try {
      const channel = new HaPushChannel({ baseUrl, token: 'test-long-lived-token', service: 'x' });
      await expect(channel.send(renderEscalation(sample()), sample())).rejects.toThrow(
        'Home Assistant answered HTTP 401: {"message":"Unauthorized"}',
      );
    } finally {
      respond = () => ({ status: 200, body: '[]' });
    }
  });

  it('reports an unreachable host as a connection failure', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const channel = new HaPushChannel({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'test-long-lived-token',
      service: 'x',
      timeoutMs: 2_000,
    });
    await expect(channel.send(renderEscalation(sample()), sample())).rejects.toThrow(
      /Home Assistant unreachable at http:\/\/127\.0\.0\.1:\d+\/api\/services\/notify\/x: /,
    );
  });

  it('builds the service URL without doubling slashes', () => {
    expect(haServiceUrl('http://192.168.1.10/ha', 'mobile_app_phone')).toBe(
      'http://192.168.1.10/ha/api/services/notify/mobile_app_phone',
    );
    expect(haServiceUrl('http://192.168.1.10/ha///', 'svc')).toBe(
      'http://192.168.1.10/ha/api/services/notify/svc',
    );
  });
});

describe('a failed push explains itself (27/09/2026)', () => {
  const rendered = { subject: 'Forge warning: x', text: 'body' } as never;
  const escalation = { dedupeKey: 'k', severity: 'warn' } as never;

  const servicesResponse = (names: string[]) =>
    new Response(
      JSON.stringify([
        { domain: 'light', services: { turn_on: {} } },
        { domain: 'notify', services: Object.fromEntries(names.map((n) => [n, {}])) },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('names the services that do exist when the configured one does not', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/api/services')) {
        return servicesResponse(['mobile_app_phone_2', 'notify']);
      }
      return new Response('400: Bad Request', { status: 400 });
    }) as unknown as typeof globalThis.fetch;

    const channel = new HaPushChannel({
      baseUrl: 'http://ha.example/ha',
      token: 'secret-token',
      service: 'mobile_app_phone',
      fetch: fetchImpl,
    });

    await expect(channel.send(rendered, escalation)).rejects.toThrow(
      /notify\.mobile_app_phone does not exist/,
    );
    await expect(channel.send(rendered, escalation)).rejects.toThrow(/notify\.mobile_app_phone_2/);
    await expect(channel.send(rendered, escalation)).rejects.toThrow(/FORGE_HA_NOTIFY_SERVICE/);
    // It asked Home Assistant what exists, rather than guessing.
    expect(calls.some((href) => href.endsWith('/api/services'))).toBe(true);
    // The token is never echoed into the message.
    await expect(channel.send(rendered, escalation)).rejects.not.toThrow(/secret-token/);
  });

  it('says the body was rejected when the service does exist', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/api/services')) return servicesResponse(['mobile_app_phone']);
      return new Response('400: Bad Request', { status: 400 });
    }) as unknown as typeof globalThis.fetch;
    const channel = new HaPushChannel({
      baseUrl: 'http://ha.example/ha',
      token: 't',
      service: 'mobile_app_phone',
      fetch: fetchImpl,
    });
    await expect(channel.send(rendered, escalation)).rejects.toThrow(
      /does exist, so the request body was rejected/,
    );
  });

  it('does not chase the service list for an auth failure', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response('401: Unauthorized', { status: 401 });
    }) as unknown as typeof globalThis.fetch;
    const channel = new HaPushChannel({
      baseUrl: 'http://ha.example/ha',
      token: 't',
      service: 'mobile_app_phone',
      fetch: fetchImpl,
    });
    await expect(channel.send(rendered, escalation)).rejects.toThrow(/HTTP 401/);
    expect(calls.filter((href) => href.endsWith('/api/services'))).toHaveLength(0);
  });

  it('stays quiet when the service list itself cannot be read', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/api/services')) throw new Error('network down');
      return new Response('400: Bad Request', { status: 400 });
    }) as unknown as typeof globalThis.fetch;
    const channel = new HaPushChannel({
      baseUrl: 'http://ha.example/ha',
      token: 't',
      service: 'mobile_app_phone',
      fetch: fetchImpl,
    });
    await expect(channel.send(rendered, escalation)).rejects.toThrow(/HTTP 400/);
    await expect(channel.send(rendered, escalation)).rejects.not.toThrow(/does not exist/);
  });
});

describe('haNotifyServices', () => {
  it('returns the notify service names, sorted, without the prefix', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ domain: 'notify', services: { b: {}, a: {} } }]), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    await expect(haNotifyServices('http://ha.example/ha/', 't', fetchImpl)).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  it('returns undefined for a non-200, a non-array body, or no notify domain', async () => {
    const reply = (body: string, status = 200) =>
      (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
    await expect(haNotifyServices('http://x/ha', 't', reply('[]', 500))).resolves.toBeUndefined();
    await expect(haNotifyServices('http://x/ha', 't', reply('{}'))).resolves.toBeUndefined();
    await expect(
      haNotifyServices('http://x/ha', 't', reply('[{"domain":"light","services":{}}]')),
    ).resolves.toBeUndefined();
  });
});
