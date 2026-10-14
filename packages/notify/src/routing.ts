/**
 * Which channels a severity reaches (ADR-023, Dan's decision of 27/09/2026).
 *
 *   critical -> phone (Home Assistant push), email, file outbox
 *   warn     -> phone (Home Assistant push), email, file outbox
 *   info     -> email, file outbox
 *
 * `info` covers the routine traffic - Tier 0 merges and deferrals, digests,
 * notices that nothing is waiting on - and it never reaches the phone, so a
 * push notification always means something Dan may need to act on. The file
 * outbox receives everything: it is the evidence trail and the record the
 * digests read. The only thing severity ever withholds is the phone, so a
 * channel this table does not name (a test double, a channel added later)
 * receives every severity until the table says otherwise.
 *
 * The Notifier applies this on every dispatch; `pnpm forge notify-test`
 * prints it. Both go through `channelsForSeverity` so they cannot disagree.
 */
import type { EscalationSeverity } from './escalation.js';

export const SEVERITIES: readonly EscalationSeverity[] = ['info', 'warn', 'critical'];

/** Channel name -> the severities it receives. */
export const SEVERITY_ROUTING: Readonly<Record<string, readonly EscalationSeverity[]>> = {
  ha: ['warn', 'critical'],
  email: ['info', 'warn', 'critical'],
  file: ['info', 'warn', 'critical'],
};

/** The reason a channel result carries when routing, not a fault, left it out. */
export const SKIPPED_BY_ROUTING = 'severity_routing';

export function channelReceives(channelName: string, severity: EscalationSeverity): boolean {
  const severities = SEVERITY_ROUTING[channelName];
  return severities === undefined || severities.includes(severity);
}

export type Routed<C> = {
  /** In the order given; the channels that are sent to. */
  routed: C[];
  /** In the order given; the channels severity routing leaves out. */
  skipped: C[];
};

/**
 * Partition `channels` by whether `severity` reaches them. Pure: the same
 * inputs always give the same answer, and the order of `channels` is kept.
 */
export function channelsForSeverity<C extends { readonly name: string }>(
  severity: EscalationSeverity,
  channels: readonly C[],
): Routed<C> {
  const routed: C[] = [];
  const skipped: C[] = [];
  for (const channel of channels) {
    (channelReceives(channel.name, severity) ? routed : skipped).push(channel);
  }
  return { routed, skipped };
}
