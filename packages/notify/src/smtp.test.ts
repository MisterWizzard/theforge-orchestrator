import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { renderEscalation } from './escalation.js';
import { sample } from './fixture.js';
import {
  buildMimeMessage,
  dotStuff,
  encodeHeaderText,
  rfc5322Date,
  SmtpChannel,
  takeReply,
} from './smtp.js';

type FakeOptions = {
  /** Reply to AUTH; the default accepts. */
  auth?: (credentials: string) => string;
};

type Fake = {
  port: number;
  commands: string[];
  data: string;
  auth: string | undefined;
  close(): Promise<void>;
};

/**
 * Just enough SMTP to receive one message: multi-line EHLO so the reply
 * parser is exercised, AUTH PLAIN, and DATA terminated by a lone dot.
 */
function fakeSmtp(options: FakeOptions = {}): Promise<Fake> {
  const commands: string[] = [];
  const fake = { data: '', auth: undefined as string | undefined };
  const handle = (socket: Socket) => {
    let buffer = '';
    let inData = false;
    socket.setEncoding('utf8');
    socket.write('220 fake.local ESMTP ready\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          fake.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 queued as fake-id\r\n');
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO') {
          socket.write(
            '250-fake.local at your service\r\n250-SIZE 35882577\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n',
          );
        } else if (verb === 'AUTH') {
          fake.auth = line.split(' ')[2];
          socket.write(
            `${options.auth ? options.auth(fake.auth ?? '') : '235 2.7.0 Accepted'}\r\n`,
          );
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          socket.write('250 2.1.0 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 Go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 closing connection\r\n');
          socket.end();
        } else {
          socket.write('500 unrecognised\r\n');
        }
      }
    });
  };
  return new Promise((resolve) => {
    const server: Server = createServer(handle);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        commands,
        get data() {
          return fake.data;
        },
        get auth() {
          return fake.auth;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const fakes: Fake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

const channelFor = (
  fake: Fake,
  overrides: Partial<ConstructorParameters<typeof SmtpChannel>[0]> = {},
) =>
  new SmtpChannel({
    host: '127.0.0.1',
    port: fake.port,
    user: 'forge@example.com',
    password: 'app-password-1234',
    to: 'dan@example.com',
    fromName: 'TheForge',
    security: 'plaintext',
    clientName: 'nodee',
    now: () => Date.parse('2026-09-26T01:02:03Z'),
    ...overrides,
  });

describe('SmtpChannel', () => {
  it('speaks the whole dialogue and delivers a decodable message', async () => {
    const fake = await fakeSmtp();
    fakes.push(fake);
    const escalation = sample({ title: 'Approval needed — run 9d6cf990' });
    const rendered = renderEscalation(escalation);
    await channelFor(fake).send(rendered, escalation);

    expect(fake.commands.map((line) => line.split(' ')[0])).toEqual([
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
      'QUIT',
    ]);
    expect(fake.commands[0]).toBe('EHLO nodee');
    expect(fake.commands[1]).toMatch(/^AUTH PLAIN [A-Za-z0-9+/=]+$/);
    expect(Buffer.from(fake.auth!, 'base64').toString('utf8')).toBe(
      '\0forge@example.com\0app-password-1234',
    );
    expect(fake.commands[2]).toBe('MAIL FROM:<forge@example.com>');
    expect(fake.commands[3]).toBe('RCPT TO:<dan@example.com>');

    const [headers, body] = fake.data.split('\r\n\r\n');
    // Unfold continuation lines so a folded Subject reads as one header.
    const header = (name: string) =>
      headers!
        .replace(/\r\n(?=[ \t])/g, '')
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        ?.slice(name.length + 1)
        .trim();
    expect(header('From')).toBe('TheForge <forge@example.com>');
    expect(header('To')).toBe('dan@example.com');
    // Non-ASCII subject travels as RFC 2047 encoded-words.
    const subject = header('Subject')!;
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subject
      .split(/\s+/)
      .map((word) =>
        Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8'),
      )
      .join('');
    expect(decoded).toBe(rendered.subject);
    expect(header('Date')).toBe('Sat, 26 Sep 2026 01:02:03 +0000');
    expect(header('Message-ID')).toMatch(/^<[0-9a-f-]+@nodee>$/);
    expect(header('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(header('X-TheForge-Kind')).toBe('decision.approval');
    expect(header('Content-Transfer-Encoding')).toBe('base64');
    expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(rendered.text);
  });

  it('fails on a rejected login with the server text and without the password in any form', async () => {
    const fake = await fakeSmtp({ auth: () => '535 5.7.8 Username and Password not accepted' });
    fakes.push(fake);
    let caught: Error | undefined;
    try {
      await channelFor(fake).send(renderEscalation(sample()), sample());
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe(
      'SMTP AUTH rejected: 535 5.7.8 Username and Password not accepted',
    );
    expect(caught?.message).not.toContain('app-password-1234');
    expect(caught?.message).not.toContain(Buffer.from('app-password-1234').toString('base64'));
    expect(fake.commands.map((line) => line.split(' ')[0])).toEqual(['EHLO', 'AUTH']);
  });

  it('reports a refused connection and defaults to implicit TLS', async () => {
    const probe = await fakeSmtp();
    const { port } = probe;
    await probe.close();
    const channel = channelFor({ ...probe, port }, { timeoutMs: 2_000 });
    await expect(channel.send(renderEscalation(sample()), sample())).rejects.toThrow(
      `SMTP connect to 127.0.0.1:${port} failed:`,
    );
    expect(
      new SmtpChannel({
        host: 'smtp.gmail.com',
        port: 465,
        user: 'a@b.c',
        password: 'x'.repeat(16),
        to: 'd@e.f',
      }).security,
    ).toBe('implicit-tls');
  });

  it('refuses addresses that could inject commands', () => {
    expect(
      () =>
        new SmtpChannel({
          host: 'h',
          port: 1,
          user: 'a@b.c',
          password: 'p',
          to: 'x@y.z>\r\nRCPT TO:<evil@example.com',
        }),
    ).toThrow(/recipient address is not a plain mailbox address/);
  });
});

describe('SMTP building blocks', () => {
  it('parses multi-line replies and waits for incomplete ones', () => {
    expect(takeReply('250-a\r\n250-b\r\n250 c\r\nrest')).toEqual({
      reply: { code: 250, lines: ['250-a', '250-b', '250 c'] },
      rest: 'rest',
    });
    expect(takeReply('250-a\r\n250-b\r\n')).toBeUndefined();
    expect(takeReply('221\r\n')).toEqual({ reply: { code: 221, lines: ['221'] }, rest: '' });
    expect(() => takeReply('garbage\r\n')).toThrow(/malformed/);
  });

  it('leaves ASCII subjects alone and encodes the rest in bounded words', () => {
    expect(encodeHeaderText('Forge: plain subject')).toBe('Forge: plain subject');
    const encoded = encodeHeaderText('Forge warning: Run — “quotes” and more — '.repeat(3));
    for (const word of encoded.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
    const decoded = encoded
      .split('\r\n ')
      .map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('Forge warning: Run — “quotes” and more — '.repeat(3));
  });

  it('formats RFC 5322 dates and dot-stuffs leading dots', () => {
    expect(rfc5322Date(Date.parse('2026-01-10T03:00:00Z'))).toBe('Sat, 10 Jan 2026 03:00:00 +0000');
    expect(dotStuff('.start\r\nmiddle.\r\n.\r\n..two')).toBe('..start\r\nmiddle.\r\n..\r\n...two');
  });

  it('builds a message whose base64 body round-trips', () => {
    const message = buildMimeMessage({
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'Hi',
      text: 'line one\nline two with ünïcode',
      date: 0,
      messageId: 'id@host',
    });
    expect(message.startsWith('From: a@b.c\r\nTo: d@e.f\r\nSubject: Hi\r\n')).toBe(true);
    const body = message.split('\r\n\r\n')[1]!;
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'line one\nline two with ünïcode',
    );
  });
});
