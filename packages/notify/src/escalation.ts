/**
 * What an escalation is, and how it reads on a phone.
 *
 * Policy B9 says Dan is reached through Home Assistant push and email; policy
 * B11 says which events warrant it. Whatever the transport, the message has to
 * answer the same questions in the same order: what happened, what can be done
 * about it and what each choice costs, what the evidence is, what the system
 * recommends, and whether anything is waiting on the answer. The type below
 * makes every producer supply those parts; `renderEscalation` lays them out
 * once so a push notification and an email never disagree.
 *
 * Severity also decides where a message goes (`routing.ts`, ADR-023): `info`
 * is routine and never reaches the phone; `warn` and `critical` do.
 */

export type EscalationSeverity = 'info' | 'warn' | 'critical';

export type EscalationOption = {
  /** The action Dan could take, as an imperative: "Approve the push". */
  label: string;
  /** What happens if he takes it, including what stays undone. */
  consequence: string;
};

export type Escalation = {
  /** Dotted category, e.g. `security.finding`, `tier0.merge`; drives dedupe and coalescing. */
  kind: string;
  /** One line, readable in a lock-screen notification. */
  title: string;
  /** What happened, in plain words, a paragraph at most. */
  what: string;
  project?: string;
  task?: string;
  runId?: string;
  options: EscalationOption[];
  /** References a reader can follow: event ids, file paths, URLs, commit SHAs. */
  evidence: string[];
  recommendation: string;
  /** True when nothing proceeds until Dan acts. */
  paused: boolean;
  severity: EscalationSeverity;
  /** Two escalations with the same key inside the dedupe window are one message. */
  dedupeKey: string;
  /** ISO 8601 timestamp of the underlying event. */
  occurredAt: string;
};

export type RenderedEscalation = {
  subject: string;
  text: string;
};

export type RenderOptions = {
  /** IANA zone the timestamp is shown in. Dan reads these in Australia/Sydney. */
  timeZone?: string;
};

export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

const SEVERITY_ORDER: Record<EscalationSeverity, number> = { info: 0, warn: 1, critical: 2 };

export function maxSeverity(a: EscalationSeverity, b: EscalationSeverity): EscalationSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * DD/MM/YYYY HH:mm in the given zone, with a zone label so a message read a
 * week later is unambiguous. Falls back to the raw ISO text if the timestamp
 * does not parse, rather than rendering "Invalid Date".
 */
export function formatOccurredAt(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).formatToParts(new Date(time));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
  } catch {
    return iso;
  }
}

function subjectPrefix(severity: EscalationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'Forge CRITICAL:';
    case 'warn':
      return 'Forge warning:';
    default:
      return 'Forge:';
  }
}

/**
 * Subject and body shared by every channel. The body is plain text with short
 * labelled sections because it is read on a phone: no markdown tables, no wide
 * lines, the decision-relevant parts first and the evidence last.
 */
export function renderEscalation(
  escalation: Escalation,
  options: RenderOptions = {},
): RenderedEscalation {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const subject = `${subjectPrefix(escalation.severity)} ${escalation.title}${escalation.paused ? ' [paused]' : ''}`;

  const where = [
    escalation.severity.toUpperCase(),
    formatOccurredAt(escalation.occurredAt, timeZone),
    ...(escalation.runId ? [`run ${escalation.runId.slice(0, 8)}`] : []),
    ...(escalation.project || escalation.task
      ? [[escalation.project, escalation.task].filter(Boolean).join(' / ')]
      : []),
  ].join(' · ');

  const lines: string[] = [escalation.title, where];
  if (escalation.paused) lines.push('PAUSED: nothing proceeds until you act.');
  lines.push('', 'What happened', escalation.what);

  if (escalation.options.length > 0) {
    lines.push('', 'Options');
    escalation.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}`, `   -> ${option.consequence}`);
    });
  }

  lines.push('', 'Recommendation', escalation.recommendation);

  if (escalation.evidence.length > 0) {
    lines.push('', 'Evidence');
    for (const item of escalation.evidence) lines.push(`- ${item}`);
  }

  lines.push('', `kind ${escalation.kind} · key ${escalation.dedupeKey}`);
  return { subject, text: lines.join('\n') };
}
