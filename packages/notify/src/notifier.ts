/**
 * The Notifier: one entry point, every channel, and the three behaviours that
 * keep an autonomous system from paging its operator into ignoring it.
 *
 *   Dedupe. The same dedupe key inside the window (6 h) is one message. The
 *   index lives in memory and in a file in the outbox, so a coordinator
 *   restart does not re-send everything it already sent.
 *
 *   Coalescing. Identical kind and run inside a short window (5 min) collapse:
 *   the first goes out at once, the rest are held, and one summary with a
 *   count follows when the window closes. A run that fails the same check
 *   six times produces two notifications, not six.
 *
 *   Routing. Severity decides which channels a message reaches (ADR-023,
 *   `routing.ts`): warn and critical go to the phone, email and the outbox,
 *   info to email and the outbox only. A channel routing leaves out is
 *   reported as skipped, never as failed, and never counts as a delivery.
 *
 *   Retry. Each channel gets three attempts with backoff, independently, so a
 *   flaky push does not delay or cancel the email. The report says exactly
 *   which channels succeeded; nothing here ever throws to the caller.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Channel } from './channel.js';
import {
  DEFAULT_TIME_ZONE,
  maxSeverity,
  renderEscalation,
  type Escalation,
  type EscalationSeverity,
  type RenderedEscalation,
} from './escalation.js';
import { writeFileAtomically } from './outbox.js';
import { redact, redactedError } from './redact.js';
import { channelsForSeverity, SKIPPED_BY_ROUTING, type Routed } from './routing.js';

export const DEFAULT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_COALESCE_WINDOW_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 2_000];
export const DEDUPE_INDEX_FILENAME = 'dedupe-index.json';

export type ChannelResult = {
  channel: string;
  /**
   * sent: the channel accepted the message.
   * failed: every attempt was refused; `error` says why.
   * skipped: severity routing left the channel out (ADR-023); no attempt was
   * made, nothing is wrong, and `reason` says so.
   */
  status: 'sent' | 'failed' | 'skipped';
  attempts: number;
  /** Redacted message of the last failure. */
  error?: string;
  reason?: typeof SKIPPED_BY_ROUTING;
};

export type NotifierReport = {
  dedupeKey: string;
  /**
   * sent: dispatched; `channels` holds one result per configured channel,
   *   sent, failed or skipped by severity routing.
   * duplicate: the same key went out inside the dedupe window; nothing sent.
   * coalesced: held for the summary that follows the coalescing window.
   * failed: an internal fault before any channel was tried; see `detail`.
   */
  outcome: 'sent' | 'duplicate' | 'coalesced' | 'failed';
  channels: ChannelResult[];
  detail?: string;
  rendered?: RenderedEscalation;
};

/** Which of the configured channels a severity reaches; see `channelsForSeverity`. */
export type RouteChannels = (
  severity: EscalationSeverity,
  channels: readonly Channel[],
) => Routed<Channel>;

export type NotifierOptions = {
  channels: readonly Channel[];
  /** Holds the persisted dedupe index. Normally the outbox directory. */
  outboxDir: string;
  /** Severity routing; the ADR-023 table unless a test says otherwise. */
  route?: RouteChannels;
  dedupeWindowMs?: number;
  coalesceWindowMs?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  /** Strings that must never appear in a message, an error or a file. */
  secrets?: readonly string[];
  timeZone?: string;
  /** The notifier's own error log; it never throws. */
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Timer used to close a coalescing window; injectable so tests need no clock. */
  schedule?: (callback: () => void, ms: number) => { cancel(): void };
};

type Held = {
  /** When the last message for this kind+run went out. */
  sentAt: number;
  held: Escalation[];
  timer: { cancel(): void } | undefined;
};

type DedupeIndex = { version: 1; sent: Record<string, string> };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const defaultSchedule = (callback: () => void, ms: number): { cancel(): void } => {
  const timer = setTimeout(callback, ms);
  // A pending summary must not keep a process alive past its own shutdown;
  // close() flushes what is held.
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

export function coalesceKey(escalation: Escalation): string {
  return `${escalation.kind}|${escalation.runId ?? ''}`;
}

export class Notifier {
  private readonly channels: readonly Channel[];
  private readonly route: RouteChannels;
  private readonly indexPath: string;
  private readonly outboxDir: string;
  private readonly dedupeWindowMs: number;
  private readonly coalesceWindowMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly secrets: readonly string[];
  private readonly timeZone: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: NonNullable<NotifierOptions['schedule']>;

  /** dedupeKey -> epoch ms of the last send. */
  private sent: Map<string, number> | undefined;
  private readonly recent = new Map<string, Held>();
  /** Serialises notify/flush so the index and the coalescing state stay consistent. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: NotifierOptions) {
    this.channels = options.channels;
    this.route = options.route ?? channelsForSeverity;
    this.outboxDir = options.outboxDir;
    this.indexPath = join(options.outboxDir, DEDUPE_INDEX_FILENAME);
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.secrets = options.secrets ?? [];
    this.timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  get channelNames(): string[] {
    return this.channels.map((channel) => channel.name);
  }

  /** The names of the configured channels `severity` would reach, and those it would skip. */
  routesFor(severity: EscalationSeverity): Routed<string> {
    const { routed, skipped } = this.route(severity, this.channels);
    return {
      routed: routed.map((channel) => channel.name),
      skipped: skipped.map((channel) => channel.name),
    };
  }

  /** Never rejects: a notification failure is reported, not thrown into the caller. */
  notify(escalation: Escalation): Promise<NotifierReport> {
    return this.enqueue(() => this.notifyNow(escalation));
  }

  /** Send the summaries for every coalescing window that has closed (or all of them, when forced). */
  flush(force = false): Promise<void> {
    return this.enqueue(() => this.flushNow(force));
  }

  /** Cancel timers and send every held summary. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.recent.values()) entry.timer?.cancel();
    await this.flush(true);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async notifyNow(escalation: Escalation): Promise<NotifierReport> {
    try {
      const sent = await this.loadIndex();
      const now = this.now();
      const previous = sent.get(escalation.dedupeKey);
      if (previous !== undefined && now - previous < this.dedupeWindowMs) {
        return {
          dedupeKey: escalation.dedupeKey,
          outcome: 'duplicate',
          channels: [],
          detail: `already sent at ${new Date(previous).toISOString()}; window ${this.dedupeWindowMs / 60_000} min`,
        };
      }

      const key = coalesceKey(escalation);
      const entry = this.recent.get(key);
      if (entry && now - entry.sentAt < this.coalesceWindowMs) {
        entry.held.push(escalation);
        // Held items count as sent for dedupe: the summary carries them.
        sent.set(escalation.dedupeKey, now);
        await this.saveIndex(sent);
        if (!entry.timer && !this.closed) {
          entry.timer = this.schedule(
            () => {
              void this.flush().catch((error: unknown) =>
                this.log(`notifier: flush failed: ${redactedError(error, this.secrets)}`),
              );
            },
            entry.sentAt + this.coalesceWindowMs - now,
          );
        }
        return {
          dedupeKey: escalation.dedupeKey,
          outcome: 'coalesced',
          channels: [],
          detail: `held with ${entry.held.length - 1} other(s) of kind ${escalation.kind}; a summary follows when the ${this.coalesceWindowMs / 60_000} min window closes`,
        };
      }

      const report = await this.dispatch(escalation);
      if (report.channels.some((result) => result.status === 'sent')) {
        sent.set(escalation.dedupeKey, now);
        await this.saveIndex(sent);
        this.recent.set(key, { sentAt: now, held: [], timer: undefined });
      }
      return report;
    } catch (error) {
      const message = redactedError(error, this.secrets);
      this.log(`notifier: ${escalation.kind} ${escalation.dedupeKey} not sent: ${message}`);
      return {
        dedupeKey: escalation.dedupeKey,
        outcome: 'failed',
        channels: this.channels.map((channel) => ({
          channel: channel.name,
          status: 'failed',
          attempts: 0,
          error: message,
        })),
        detail: message,
      };
    }
  }

  private async flushNow(force: boolean): Promise<void> {
    const now = this.now();
    for (const [key, entry] of [...this.recent]) {
      const due = now - entry.sentAt >= this.coalesceWindowMs;
      if (!due && !force) continue;
      entry.timer?.cancel();
      entry.timer = undefined;
      if (entry.held.length === 0) {
        if (due) this.recent.delete(key);
        continue;
      }
      const summary = summarise(entry.held, now);
      entry.held = [];
      try {
        const report = await this.dispatch(summary);
        if (report.channels.some((result) => result.status === 'sent')) {
          entry.sentAt = now;
        }
      } catch (error) {
        this.log(`notifier: summary for ${key} not sent: ${redactedError(error, this.secrets)}`);
      }
    }
  }

  private async dispatch(escalation: Escalation): Promise<NotifierReport> {
    const raw = renderEscalation(escalation, { timeZone: this.timeZone });
    const rendered: RenderedEscalation = {
      subject: redact(raw.subject, this.secrets),
      text: redact(raw.text, this.secrets),
    };
    // One result per configured channel, in configuration order, so a caller
    // that records rows per channel sees the skipped ones as skipped rather
    // than missing. Only the routed channels are attempted.
    const routed = new Set(this.route(escalation.severity, this.channels).routed);
    const channels = await Promise.all(
      this.channels.map((channel): Promise<ChannelResult> => {
        if (routed.has(channel)) return this.sendWithRetry(channel, rendered, escalation);
        return Promise.resolve({
          channel: channel.name,
          status: 'skipped',
          attempts: 0,
          reason: SKIPPED_BY_ROUTING,
        });
      }),
    );
    return { dedupeKey: escalation.dedupeKey, outcome: 'sent', channels, rendered };
  }

  private async sendWithRetry(
    channel: Channel,
    rendered: RenderedEscalation,
    escalation: Escalation,
  ): Promise<ChannelResult> {
    let lastError = 'no attempt made';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await channel.send(rendered, escalation);
        return { channel: channel.name, status: 'sent', attempts: attempt };
      } catch (error) {
        lastError = redactedError(error, this.secrets);
        this.log(
          `notifier: ${channel.name} attempt ${attempt}/${this.maxAttempts} failed for ${escalation.dedupeKey}: ${lastError}`,
        );
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs[Math.min(attempt - 1, this.backoffMs.length - 1)] ?? 0);
        }
      }
    }
    return {
      channel: channel.name,
      status: 'failed',
      attempts: this.maxAttempts,
      error: lastError,
    };
  }

  private async loadIndex(): Promise<Map<string, number>> {
    if (this.sent) return this.sent;
    const sent = new Map<string, number>();
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as Partial<DedupeIndex>;
      for (const [key, iso] of Object.entries(parsed.sent ?? {})) {
        const time = Date.parse(String(iso));
        if (!Number.isNaN(time)) sent.set(key, time);
      }
    } catch (error) {
      // A missing index is the normal first run; anything else is worth a line
      // but must not stop a notification going out.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(
          `notifier: dedupe index unreadable, starting empty: ${redactedError(error, this.secrets)}`,
        );
      }
    }
    this.sent = sent;
    return sent;
  }

  private async saveIndex(sent: Map<string, number>): Promise<void> {
    const now = this.now();
    const index: DedupeIndex = { version: 1, sent: {} };
    for (const [key, time] of sent) {
      if (now - time >= this.dedupeWindowMs) {
        sent.delete(key);
        continue;
      }
      index.sent[key] = new Date(time).toISOString();
    }
    try {
      await mkdir(this.outboxDir, { recursive: true });
      await writeFileAtomically(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
    } catch (error) {
      this.log(`notifier: dedupe index not saved: ${redactedError(error, this.secrets)}`);
    }
  }
}

/** One message standing in for everything held during a coalescing window. */
export function summarise(held: readonly Escalation[], now: number): Escalation {
  const latest = held[held.length - 1]!;
  const count = held.length;
  return {
    ...latest,
    title: `${count} more: ${latest.title}`,
    what: `${count} further ${latest.kind} escalation${count === 1 ? '' : 's'} arrived inside the coalescing window and were held. The latest:\n${latest.what}`,
    severity: held.reduce((worst, item) => maxSeverity(worst, item.severity), latest.severity),
    paused: held.some((item) => item.paused),
    evidence: [
      ...latest.evidence,
      ...held.slice(0, -1).map((item) => `held: ${item.dedupeKey} at ${item.occurredAt}`),
    ],
    dedupeKey: `${latest.dedupeKey}:summary:${count}`,
    occurredAt: new Date(now).toISOString(),
  };
}
