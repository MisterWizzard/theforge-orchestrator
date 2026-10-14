import { redactSecrets } from '@theforge/policy';

export type LogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  fields?: Record<string, unknown>;
};
export class ForgeLogger {
  constructor(
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly knownSecrets: string[] = [],
  ) {}
  log(record: Omit<LogRecord, 'timestamp'>) {
    const safe = JSON.parse(
      redactSecrets(
        JSON.stringify({ ...record, timestamp: new Date().toISOString() }),
        this.knownSecrets,
      ),
    ) as LogRecord;
    this.sink(JSON.stringify(safe));
  }
}
export class Metrics {
  private readonly counters = new Map<string, number>();
  increment(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  snapshot() {
    return Object.fromEntries(this.counters);
  }
  prometheus() {
    return (
      [...this.counters]
        .map(([key, value]) => `theforge_${key.replace(/[^a-zA-Z0-9_:]/g, '_')} ${value}`)
        .join('\n') + '\n'
    );
  }
}
