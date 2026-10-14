import type { Escalation, RenderedEscalation } from './escalation.js';

/**
 * A delivery channel. `send` resolves once the message is accepted by the far
 * side (Home Assistant answered 2xx, the SMTP server queued the mail, the
 * outbox files are on disk) and rejects otherwise; the Notifier owns retries,
 * so a channel makes exactly one attempt per call.
 */
export type Channel = {
  readonly name: string;
  send(rendered: RenderedEscalation, escalation: Escalation): Promise<void>;
};
