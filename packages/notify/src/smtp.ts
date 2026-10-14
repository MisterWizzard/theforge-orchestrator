/**
 * Email through SMTP (policy B9), written against node:tls directly.
 *
 * The whole conversation Gmail needs is seven commands - EHLO, AUTH PLAIN,
 * MAIL FROM, RCPT TO, DATA, the message, QUIT - and a reply parser. That is
 * small enough to own outright, and owning it means no third-party package
 * ever sees the app password, no transitive dependency to audit, and a fake
 * server in the test suite can assert the exact dialogue.
 *
 * Port 465 is implicit TLS: the socket is TLS from the first byte and there is
 * no STARTTLS step. The plaintext variant exists so the test suite can run a
 * fake server on a loopback port without generating certificates; it is never
 * selected from the environment.
 */
import { randomUUID } from 'node:crypto';
import { connect as connectPlain, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { connect as connectTls } from 'node:tls';
import type { Channel } from './channel.js';
import type { Escalation, RenderedEscalation } from './escalation.js';
import { errorMessage, redact } from './redact.js';

export type SmtpSecurity = 'implicit-tls' | 'plaintext';

export type SmtpOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  to: string;
  /** Envelope and header sender; defaults to the user. */
  from?: string;
  fromName?: string;
  /** Defaults to implicit TLS. Plaintext is for the in-process fake in tests. */
  security?: SmtpSecurity;
  timeoutMs?: number;
  /** Name announced in EHLO; defaults to this machine's hostname. */
  clientName?: string;
  now?: () => number;
};

export type SmtpReply = { code: number; lines: string[] };

/**
 * Pull one complete reply off the front of a buffer: `NNN-text` continuation
 * lines followed by one `NNN text` (or bare `NNN`) final line. Undefined means
 * more bytes are needed.
 */
export function takeReply(buffer: string): { reply: SmtpReply; rest: string } | undefined {
  const lines: string[] = [];
  let index = 0;
  for (;;) {
    const end = buffer.indexOf('\r\n', index);
    if (end === -1) return undefined;
    const line = buffer.slice(index, end);
    index = end + 2;
    lines.push(line);
    if (/^\d{3}(?: |$)/.test(line)) {
      return { reply: { code: Number(line.slice(0, 3)), lines }, rest: buffer.slice(index) };
    }
    if (!/^\d{3}-/.test(line)) throw new Error(`malformed SMTP reply line: ${line.slice(0, 80)}`);
  }
}

/** RFC 2047 encoded-words for a non-ASCII subject; ASCII passes through untouched. */
export function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // Each encoded-word may be at most 75 characters: 45 input bytes give 60
  // base64 characters plus the 12-character wrapper. Split on characters, not
  // bytes, so a multi-byte sequence is never cut in half.
  const chunks: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (chunk && Buffer.byteLength(chunk + character, 'utf8') > 45) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** RFC 5322 date: "Fri, 26 Sep 2026 09:39:00 +0000". */
export function rfc5322Date(time: number): string {
  return new Date(time).toUTCString().replace(/ GMT$/, ' +0000');
}

/** A line that begins with a dot would end the DATA section early; double it. */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..');
}

export type MimeMessageInput = {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  date: number;
  messageId: string;
  /** Escalation kind, so a mail filter can sort on it. */
  kind?: string;
};

/**
 * A plain-text message, base64 transfer-encoded so any UTF-8 body and any
 * line length survives a server without 8BITMIME, terminated with CRLF.
 */
export function buildMimeMessage(input: MimeMessageInput): string {
  const body = Buffer.from(input.text, 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  const fromHeader = input.fromName
    ? `${encodeHeaderText(input.fromName)} <${input.from}>`
    : input.from;
  return [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderText(input.subject)}`,
    `Date: ${rfc5322Date(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `X-TheForge-Kind: ${(input.kind ?? 'escalation').replace(/[^A-Za-z0-9._-]/g, '')}`,
    '',
    body,
  ].join('\r\n');
}

/** Reject anything that could smuggle a second command or header into the dialogue. */
function assertAddress(value: string, label: string): void {
  if (!/^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+$/.test(value)) {
    throw new Error(`${label} is not a plain mailbox address`);
  }
}

/**
 * One SMTP connection: a byte buffer, one outstanding reply at a time (SMTP
 * without pipelining is strictly request/response), and a single terminal
 * error that every later read reports.
 */
class SmtpConnection {
  private buffer = '';
  private pending:
    { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;

  constructor(
    private readonly socket: Socket,
    timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.deliver();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
    socket.setTimeout(timeoutMs, () => this.fail(new Error('SMTP connection timed out')));
  }

  readReply(): Promise<SmtpReply> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      this.pending = { resolve, reject };
      this.deliver();
    });
  }

  write(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private deliver(): void {
    if (!this.pending) return;
    let taken: ReturnType<typeof takeReply>;
    try {
      taken = takeReply(this.buffer);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!taken) return;
    this.buffer = taken.rest;
    const { resolve } = this.pending;
    this.pending = undefined;
    resolve(taken.reply);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.failure);
  }
}

export class SmtpChannel implements Channel {
  readonly name = 'email';
  private readonly options: Required<
    Pick<SmtpOptions, 'host' | 'port' | 'user' | 'password' | 'to' | 'from' | 'security'>
  > &
    Pick<SmtpOptions, 'fromName'> & { timeoutMs: number; clientName: string; now: () => number };

  constructor(options: SmtpOptions) {
    this.options = {
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      to: options.to,
      from: options.from ?? options.user,
      ...(options.fromName !== undefined ? { fromName: options.fromName } : {}),
      security: options.security ?? 'implicit-tls',
      timeoutMs: options.timeoutMs ?? 20_000,
      clientName: options.clientName ?? hostname() ?? 'theforge',
      now: options.now ?? Date.now,
    };
    assertAddress(this.options.from, 'sender address');
    assertAddress(this.options.to, 'recipient address');
  }

  get security(): SmtpSecurity {
    return this.options.security;
  }

  async send(rendered: RenderedEscalation, escalation: Escalation): Promise<void> {
    try {
      await this.deliver(rendered, escalation.kind);
    } catch (error) {
      // Nothing here includes the password on purpose; this makes sure of it.
      throw new Error(redact(errorMessage(error), [this.options.password]));
    }
  }

  private async deliver(rendered: RenderedEscalation, kind: string): Promise<void> {
    const { user, password, to, from, timeoutMs, clientName } = this.options;
    const socket = await this.open();
    const connection = new SmtpConnection(socket, timeoutMs);
    const expect = (reply: SmtpReply, codes: number[], stage: string): SmtpReply => {
      if (!codes.includes(reply.code)) {
        throw new Error(`SMTP ${stage} rejected: ${reply.lines.join(' / ').slice(0, 300)}`);
      }
      return reply;
    };
    const command = async (line: string, codes: number[], stage: string): Promise<SmtpReply> => {
      connection.write(`${line}\r\n`);
      return expect(await connection.readReply(), codes, stage);
    };
    try {
      expect(await connection.readReply(), [220], 'greeting');
      const ehlo = await command(`EHLO ${clientName}`, [250], 'EHLO');
      if (!ehlo.lines.some((line) => /^250[- ]AUTH\b.*\bPLAIN\b/i.test(line))) {
        throw new Error('SMTP server does not offer AUTH PLAIN');
      }
      const credentials = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
      await command(`AUTH PLAIN ${credentials}`, [235], 'AUTH');
      await command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
      await command(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
      await command('DATA', [354], 'DATA');
      const message = buildMimeMessage({
        from,
        ...(this.options.fromName !== undefined ? { fromName: this.options.fromName } : {}),
        to,
        subject: rendered.subject,
        text: rendered.text,
        date: this.options.now(),
        messageId: `${randomUUID()}@${clientName}`,
        kind,
      });
      await command(`${dotStuff(message)}\r\n.`, [250], 'message');
      // The mail is queued at this point; a failed QUIT changes nothing.
      connection.write('QUIT\r\n');
      await connection.readReply().catch(() => undefined);
      connection.end();
    } finally {
      connection.destroy();
    }
  }

  private open(): Promise<Socket> {
    const { host, port, security, timeoutMs } = this.options;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`SMTP connect to ${host}:${port} timed out`));
      }, timeoutMs);
      const ready = () => {
        clearTimeout(timer);
        socket.off('error', failed);
        resolve(socket);
      };
      const failed = (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`SMTP connect to ${host}:${port} failed: ${error.message}`));
      };
      const socket: Socket =
        security === 'implicit-tls'
          ? connectTls({ host, port, servername: host }, ready)
          : connectPlain({ host, port }, ready);
      socket.once('error', failed);
    });
  }
}
