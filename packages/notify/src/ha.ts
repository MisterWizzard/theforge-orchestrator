/**
 * Home Assistant push through the companion app (policy B9).
 *
 * One REST call: POST <base>/api/services/notify/<service> with a long-lived
 * access token. The base URL already includes the reverse-proxy prefix on
 * Dan's network (`http://192.168.1.10/ha`), which is why the path is
 * appended rather than assembled from a host.
 */
import type { Channel } from './channel.js';
import type { Escalation, RenderedEscalation } from './escalation.js';
import { errorMessage } from './redact.js';

export type HaPushOptions = {
  /** Base URL of Home Assistant, e.g. http://192.168.1.10/ha. */
  baseUrl: string;
  token: string;
  /** Notify service name without the `notify.` prefix, e.g. mobile_app_phone. */
  service: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * The companion app rejects oversized payloads outright, and a phone
 * notification past this point is not being read anyway; the outbox and the
 * email carry the full text.
 */
export const HA_MESSAGE_LIMIT = 3_500;

export function haServiceUrl(baseUrl: string, service: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/services/notify/${service}`;
}

/**
 * The exact JSON body sent, exposed so tests and the CLI can show it.
 *
 * Nothing here bypasses Do Not Disturb (ADR-023, Dan's decision of
 * 27/09/2026): no `importance`, `priority` or `ttl` for any severity, and
 * never `channel: alarm_stream`. A critical escalation reaches the phone
 * because severity routing sends it there, not by shouting over the phone's
 * own settings; if Dan has silenced the phone, the email and the outbox
 * still carry the full text. `tag` and `group` stay: the same tag replaces
 * rather than stacks when a coalesced follow-up lands, and the group keeps
 * TheForge's notifications together.
 */
export function haNotificationBody(
  rendered: RenderedEscalation,
  escalation: Escalation,
): { title: string; message: string; data: { tag: string; group: string } } {
  const message =
    rendered.text.length > HA_MESSAGE_LIMIT
      ? `${rendered.text.slice(0, HA_MESSAGE_LIMIT - 24)}\n…[see email or outbox]`
      : rendered.text;
  return {
    title: rendered.subject,
    message,
    data: { tag: escalation.dedupeKey, group: 'theforge' },
  };
}

/**
 * The notify services Home Assistant currently exposes, without the `notify.`
 * prefix, or `undefined` when they cannot be read.
 *
 * Used only to explain a failure. A mobile_app notify service is named after the
 * device that registered it, so it changes whenever the phone is renamed or
 * re-paired: on 27/09/2026 `mobile_app_phone` silently became
 * `mobile_app_phone_2`, and every push failed with nothing but
 * "HTTP 400: Bad Request" — which took four manual probes to pin down, on the
 * channel whose whole purpose is telling the operator something is wrong. Naming
 * the available services in the error turns that into one line.
 */
export async function haNotifyServices(
  baseUrl: string,
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<string[] | undefined> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/services`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const domains = (await response.json()) as Array<{
      domain?: unknown;
      services?: Record<string, unknown>;
    }>;
    if (!Array.isArray(domains)) return undefined;
    const notify = domains.find((entry) => entry.domain === 'notify');
    if (!notify?.services || typeof notify.services !== 'object') return undefined;
    return Object.keys(notify.services).sort();
  } catch {
    return undefined;
  }
}

export class HaPushChannel implements Channel {
  readonly name = 'ha';
  private readonly url: string;
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly service: string;

  constructor(options: HaPushOptions) {
    this.url = haServiceUrl(options.baseUrl, options.service);
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = options.baseUrl;
    this.service = options.service;
  }

  async send(rendered: RenderedEscalation, escalation: Escalation): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(haNotificationBody(rendered, escalation)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Home Assistant unreachable at ${this.url}: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      // The body is Home Assistant's own error text; it never echoes the token.
      const excerpt = (await response.text().catch(() => '')).slice(0, 200);
      let hint = '';
      // 400 on a service call is what Home Assistant answers for a service that
      // does not exist, so say which ones do. 401/403 is the token, not the name.
      if (response.status === 400) {
        const services = await haNotifyServices(this.baseUrl, this.token, this.fetch);
        if (services && !services.includes(this.service)) {
          hint =
            `; notify.${this.service} does not exist. Home Assistant reports: ` +
            `${services.map((name) => `notify.${name}`).join(', ')}. ` +
            'A mobile_app service is named after the device that registered it, so set ' +
            'FORGE_HA_NOTIFY_SERVICE to the current name';
        } else if (services) {
          hint = `; notify.${this.service} does exist, so the request body was rejected`;
        }
      }
      throw new Error(
        `Home Assistant answered HTTP ${response.status}: ${excerpt || 'no body'}${hint}`,
      );
    }
  }
}
