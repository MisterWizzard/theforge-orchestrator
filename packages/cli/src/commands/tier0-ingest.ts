import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNotifierFromEnv, type NotifierReport } from '@theforge/notify';
import { escalationFromOutcomeRecord, parseOutcomeRecords } from '@theforge/tier0';
import type { Command } from '../command.js';

/** One line per channel, the same shape `notify-test` prints. */
export function formatReport(report: NotifierReport): string {
  if (report.outcome === 'duplicate' || report.outcome === 'coalesced') {
    return `${report.outcome}${report.detail ? `: ${report.detail}` : ''}`;
  }
  if (report.outcome === 'failed') return `failed: ${report.detail ?? 'unknown fault'}`;
  return report.channels
    .map((channel) => {
      switch (channel.status) {
        case 'sent':
          return `${channel.channel} sent (attempt ${channel.attempts})`;
        case 'skipped':
          // Severity routing (ADR-023), not a fault: info never reaches the phone.
          return `${channel.channel} skipped (${channel.reason?.replace(/_/g, ' ') ?? 'not routed'})`;
        default:
          return `${channel.channel} FAILED after ${channel.attempts} attempt(s): ${channel.error ?? '?'}`;
      }
    })
    .join(' · ');
}

export const tier0IngestCommand: Command = {
  name: 'tier0-ingest',
  describe: 'Notify about the merges, escalations and deferrals in a Tier 0 outcomes file',
  usage: '<outcomes.json>',
  async run(argv, ctx) {
    const path = argv.find((argument) => !argument.startsWith('--'));
    if (!path) {
      ctx.stderr(
        'forge tier0-ingest: give the outcomes file Tier 0 printed, e.g. .forge/outbox/tier0/<timestamp>.json',
      );
      return 2;
    }
    let records;
    try {
      records = parseOutcomeRecords(await readFile(resolve(path), 'utf8'));
    } catch (error) {
      ctx.stderr(
        `forge tier0-ingest: cannot read ${resolve(path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    const { notifier, config } = createNotifierFromEnv(ctx.env, {
      fetch: ctx.fetch,
      log: (line) => ctx.stderr(line),
    });
    ctx.stdout(`outbox: ${config.outboxDir}`);
    ctx.stdout(`channels: ${notifier.channelNames.join(', ')}`);
    let failures = 0;
    let notified = 0;
    for (const record of records) {
      const label = `#${record.number} ${record.action}${record.mode === 'dry-run' ? ' (dry run)' : ''}`;
      const escalation = escalationFromOutcomeRecord(record);
      if (!escalation) {
        ctx.stdout(`${label}: nothing to notify`);
        continue;
      }
      const report = await notifier.notify(escalation);
      if (report.outcome === 'failed' || report.channels.some((c) => c.status === 'failed'))
        failures += 1;
      if (report.outcome === 'sent') notified += 1;
      ctx.stdout(`${label}: ${escalation.kind} -> ${formatReport(report)}`);
    }
    await notifier.close();
    ctx.stdout(
      `${notified} notified, ${records.length - notified} not sent, ${failures} with a failed channel`,
    );
    return failures ? 1 : 0;
  },
};
