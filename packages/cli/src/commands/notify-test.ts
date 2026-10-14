import { hostname } from 'node:os';
import {
  channelReceives,
  channelsFromConfig,
  Notifier,
  notifyConfigFromEnv,
  SEVERITIES,
  type ChannelSelection,
  type Escalation,
  type EscalationSeverity,
} from '@theforge/notify';
import { parseArgs, type Command } from '../command.js';
import { formatReport } from './tier0-ingest.js';

const SELECTIONS = ['ha', 'email', 'file', 'all'] as const;
type Selection = (typeof SELECTIONS)[number];

/**
 * The default is warn, not info: warn is the lowest severity that reaches the
 * phone (ADR-023), so the plain command proves the push without sending a
 * critical, and `--severity=info` shows the phone being left out.
 */
export const DEFAULT_TEST_SEVERITY: EscalationSeverity = 'warn';

/** A message nobody could mistake for a real escalation. */
export function testEscalation(
  selection: Selection,
  severity: EscalationSeverity,
  now: Date,
): Escalation {
  return {
    kind: 'notify.test',
    title: `Test notification from TheForge (${selection}, ${severity})`,
    what: `This is a test sent by "pnpm forge notify-test --channel=${selection} --severity=${severity}" from ${hostname()}. Nothing happened and nothing is waiting on you.`,
    options: [
      {
        label: 'Ignore it',
        consequence: 'Nothing changes; receiving this confirms the channel works.',
      },
    ],
    evidence: [`sent at ${now.toISOString()}`],
    recommendation:
      'If this arrived where you expected, the secrets in .env for that channel are correct.',
    paused: false,
    severity,
    // Unique per invocation so dedupe never swallows a deliberate test.
    dedupeKey: `notify.test:${now.toISOString()}`,
    occurredAt: now.toISOString(),
  };
}

export const notifyTestCommand: Command = {
  name: 'notify-test',
  describe:
    'Send a clearly labelled test escalation, show where each severity is routed, and report which channels delivered it',
  usage: '[--channel=ha|email|file|all] [--severity=info|warn|critical]',
  async run(argv, ctx) {
    const { flags } = parseArgs(argv);
    const rawChannel = flags.get('channel') ?? 'all';
    if (rawChannel === true || !(SELECTIONS as readonly string[]).includes(rawChannel)) {
      ctx.stderr('forge notify-test: --channel must be one of ha, email, file or all');
      return 2;
    }
    const rawSeverity = flags.get('severity') ?? DEFAULT_TEST_SEVERITY;
    if (rawSeverity === true || !(SEVERITIES as readonly string[]).includes(rawSeverity)) {
      ctx.stderr('forge notify-test: --severity must be one of info, warn or critical');
      return 2;
    }
    const selection = rawChannel as Selection;
    const severity = rawSeverity as EscalationSeverity;

    // A named channel the severity never reaches would prove nothing: the
    // Notifier would skip it and the command would exit 0 having sent nothing.
    if (selection !== 'all' && !channelReceives(selection, severity)) {
      ctx.stderr(
        `forge notify-test: ${severity} never reaches ${selection} (severity routing, ADR-023); use --severity=warn or --severity=critical`,
      );
      return 2;
    }
    const config = notifyConfigFromEnv(ctx.env);

    // A named channel that cannot be built is a refusal, not a silent fall
    // back to the file outbox: the point of the command is to prove secrets.
    const missing: string[] = [];
    if (!config.ha.configured && (selection === 'ha' || selection === 'all'))
      missing.push(`ha: missing ${config.ha.missing.join(', ')}`);
    if (!config.smtp.configured && (selection === 'email' || selection === 'all'))
      missing.push(`email: missing ${config.smtp.missing.join(', ')}`);
    if (missing.length && selection !== 'all') {
      ctx.stderr(`forge notify-test: refusing to send; ${missing.join('; ')} (add them to .env)`);
      return 2;
    }
    for (const line of missing) ctx.stderr(`notify-test: skipping ${line}`);

    const only: ChannelSelection[] = selection === 'all' ? ['file', 'ha', 'email'] : [selection];
    const channels = channelsFromConfig(config, { only, fetch: ctx.fetch });
    const notifier = new Notifier({
      channels,
      outboxDir: config.outboxDir,
      secrets: config.secrets,
      log: (line) => ctx.stderr(line),
    });
    ctx.stdout(`outbox: ${config.outboxDir}`);
    ctx.stdout(`channels: ${notifier.channelNames.join(', ') || 'none'}`);
    // The routing table as it applies to the channels this run has, so the
    // answer to "would this reach my phone?" is on the screen before the send.
    for (const each of SEVERITIES) {
      const { routed, skipped } = notifier.routesFor(each);
      ctx.stdout(
        `routing: ${each} -> ${routed.join(', ') || 'none'}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`,
      );
    }
    ctx.stdout(`severity: ${severity}`);
    const report = await notifier.notify(testEscalation(selection, severity, new Date()));
    await notifier.close();
    ctx.stdout(`subject: ${report.rendered?.subject ?? '(not rendered)'}`);
    ctx.stdout(`result: ${formatReport(report)}`);
    const failed =
      report.outcome === 'failed' || report.channels.some((c) => c.status === 'failed');
    return failed ? 1 : 0;
  },
};
